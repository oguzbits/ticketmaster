import { inject, Injectable, InjectionToken } from '@angular/core';
import {
  SEAT_STREAM_EVENT,
  type SeatChange,
  SeatChangeSchema,
  type SeatSnapshot,
  SeatSnapshotSchema,
} from '@app/shared';
import { firstValueFrom, Observable, type Subscriber } from 'rxjs';

import { AuthService } from '../auth/auth.service';
import { SessionStore } from '../auth/session.store';

/** The browser's `fetch`; a token so tests can hand in a fake. */
export const FETCH = new InjectionToken<typeof fetch>('fetch', {
  providedIn: 'root',
  factory: () => globalThis.fetch.bind(globalThis),
});

/** Tells the view that the stream is down and a new connection is on its way. */
export const SEAT_STREAM_STATE = { RECONNECTING: 'reconnecting' } as const;

export type SeatStreamMessage =
  | { type: typeof SEAT_STREAM_EVENT.SNAPSHOT; snapshot: SeatSnapshot }
  | { type: typeof SEAT_STREAM_EVENT.CHANGE; change: SeatChange }
  /** `busy`: the server refused the connection (429 or 503), not the network. */
  | { type: typeof SEAT_STREAM_STATE.RECONNECTING; busy: boolean };

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const RETRY_AFTER_MAX_MS = 60_000;
/** The server sends a heartbeat every 15 s; three missed ones mean the connection is dead. */
const IDLE_MS = 45_000;
const BUSY_STATUSES: readonly number[] = [429, 503];
const FATAL_STATUSES: readonly number[] = [400, 404];

export class StreamRefused extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number
  ) {
    super(`The seat stream answered ${status}`);
  }
}

export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Reads the seat stream of an event with `fetch`, because an `EventSource` cannot send the bearer
 * token that unlocks a demo user's sandbox events. Emits the snapshot, then one change per seat.
 * When the connection ends or fails it connects again: at once after a clean end (the server ends
 * streams after 10 minutes and when its Redis subscriber reconnects), with exponential backoff after
 * a failure. Every connection starts with a snapshot, which replaces the state of the view.
 */
@Injectable({ providedIn: 'root' })
export class SeatStreamService {
  private readonly fetcher = inject(FETCH);
  private readonly store = inject(SessionStore);
  private readonly auth = inject(AuthService);

  changes(eventId: string): Observable<SeatStreamMessage> {
    return new Observable((subscriber) => {
      const stop = new AbortController();
      void this.follow(eventId, subscriber, stop.signal);
      return () => stop.abort();
    });
  }

  private async follow(
    eventId: string,
    subscriber: Subscriber<SeatStreamMessage>,
    signal: AbortSignal
  ): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      let busy = false;
      let retryAfterMs = 0;
      try {
        const gotSnapshot = await this.readOnce(eventId, subscriber, signal, () => (failures = 0));
        if (gotSnapshot) continue; // a clean end: connect again right away
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof Error || error instanceof DOMException) || !isRetryable(error)) {
          subscriber.error(error);
          return;
        }
        if (error instanceof StreamRefused) {
          busy = BUSY_STATUSES.includes(error.status);
          retryAfterMs = error.retryAfterMs;
        }
      }
      failures += 1;
      const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
      // Jitter, so viewers that lost the connection together do not come back together.
      const wait = Math.max(backoff * (1 - Math.random() / 2), retryAfterMs);
      subscriber.next({ type: SEAT_STREAM_STATE.RECONNECTING, busy });
      await sleep(wait, signal);
    }
  }

  /** One connection; true when it delivered a snapshot before it ended. */
  private async readOnce(
    eventId: string,
    subscriber: Subscriber<SeatStreamMessage>,
    signal: AbortSignal,
    onSnapshot: () => void
  ): Promise<boolean> {
    const connection = new AbortController();
    const abort = () => connection.abort();
    signal.addEventListener('abort', abort, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const alive = () => {
      clearTimeout(idle);
      idle = setTimeout(abort, IDLE_MS);
    };
    try {
      alive();
      const response = await this.connect(seatStreamUrl(eventId), connection.signal);
      if (response.body === null) throw new StreamRefused(response.status, 0);
      let gotSnapshot = false;
      for await (const raw of sseMessages(response.body, alive)) {
        const message = parse(raw);
        if (message === null) continue;
        if (message.type === SEAT_STREAM_EVENT.SNAPSHOT) {
          gotSnapshot = true;
          onSnapshot();
        }
        subscriber.next(message);
      }
      return gotSnapshot;
    } finally {
      clearTimeout(idle);
      signal.removeEventListener('abort', abort);
      connection.abort();
    }
  }

  /**
   * Opens an event stream; after a 401 the token is renewed once and the request repeated. Public
   * because the waiting room stream connects the same way.
   */
  async connect(url: string, signal: AbortSignal): Promise<Response> {
    const request = (token: string | null) =>
      this.fetcher(url, {
        headers: token
          ? { Accept: 'text/event-stream', Authorization: `Bearer ${token}` }
          : { Accept: 'text/event-stream' },
        signal,
      });
    const sentWith = this.store.accessToken();
    let response = await request(sentWith);
    if (response.status === 401 && sentWith !== null) {
      response = await request(await firstValueFrom(this.auth.renewAfterUnauthorized(sentWith)));
    }
    if (!response.ok) {
      const seconds = Number(response.headers.get('retry-after'));
      const retryAfterMs = Number.isFinite(seconds)
        ? Math.min(seconds * 1000, RETRY_AFTER_MAX_MS)
        : 0;
      throw new StreamRefused(response.status, retryAfterMs);
    }
    return response;
  }
}

function seatStreamUrl(eventId: string): string {
  return `/api/events/${encodeURIComponent(eventId)}/seats/stream`;
}

/** A refusal other than 400/404/401, a network failure or a silent connection is worth a retry. */
export function isRetryable(error: Error | DOMException): boolean {
  if (error instanceof StreamRefused) {
    return error.status !== 401 && !FATAL_STATUSES.includes(error.status);
  }
  // `TypeError`: fetch failed or the body broke off; `AbortError`: the idle timer gave up.
  return (
    error instanceof TypeError || (error instanceof DOMException && error.name === 'AbortError')
  );
}

function parse(message: SseMessage): SeatStreamMessage | null {
  switch (message.event) {
    case SEAT_STREAM_EVENT.SNAPSHOT:
      return {
        type: SEAT_STREAM_EVENT.SNAPSHOT,
        snapshot: SeatSnapshotSchema.parse(JSON.parse(message.data)),
      };
    case SEAT_STREAM_EVENT.CHANGE:
      return {
        type: SEAT_STREAM_EVENT.CHANGE,
        change: SeatChangeSchema.parse(JSON.parse(message.data)),
      };
    default:
      return null; // an event this client does not know is ignored
  }
}

/**
 * Server-sent events framing: lines of `field: value`, comments start with `:`, an empty line ends
 * an event. shortcut: lines end with `\n` or `\r\n` (what the API sends); a lone `\r` is not a
 * line end, upgrade if another server sits in front.
 */
export async function* sseMessages(
  body: ReadableStream<Uint8Array>,
  onChunk: () => void
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const feed = lineReader();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      yield* lines.map(feed).filter((message): message is SseMessage => message !== null);
    }
  } finally {
    await reader.cancel();
  }
}

/** Collects the fields of one event line by line; returns the event when its empty line arrives. */
function lineReader(): (line: string) => SseMessage | null {
  let event = '';
  let data: string[] = [];
  return (line) => {
    if (line === '') {
      const message = data.length > 0 ? { event, data: data.join('\n') } : null;
      event = '';
      data = [];
      return message;
    }
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const text = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = text;
    else if (field === 'data') data.push(text);
    return null;
  };
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
