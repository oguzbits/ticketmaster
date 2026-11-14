import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { WAITING_ROOM_STATE, type WaitingRoomStatus, WaitingRoomStatusSchema } from '@app/shared';
import { map, Observable, type Subscriber } from 'rxjs';

import { isRetryable, SeatStreamService, sleep, sseMessages } from './seat-stream.service';

export const WAITING_ROOM_STREAM = { STATUS: 'status', RECONNECTING: 'reconnecting' } as const;

export type WaitingRoomStreamMessage =
  | { type: typeof WAITING_ROOM_STREAM.STATUS; status: WaitingRoomStatus }
  /** The stream is down and a new connection is on its way. */
  | { type: typeof WAITING_ROOM_STREAM.RECONNECTING };

/** shortcut: a fixed wait, no backoff; the server caps open streams, upgrade if that cap is hit often. */
const RETRY_MS = 3000;

@Injectable({ providedIn: 'root' })
export class WaitingRoomService {
  private readonly http = inject(HttpClient);
  private readonly connection = inject(SeatStreamService);

  /** The user comes from the token. */
  join(eventId: string): Observable<WaitingRoomStatus> {
    return this.http
      .post(url(eventId), {})
      .pipe(map((body) => WaitingRoomStatusSchema.parse(body)));
  }

  status(eventId: string): Observable<WaitingRoomStatus> {
    return this.http.get(url(eventId)).pipe(map((body) => WaitingRoomStatusSchema.parse(body)));
  }

  leave(eventId: string): Observable<void> {
    return this.http.delete<void>(url(eventId));
  }

  /**
   * The place of the caller, live. Completes once the caller is admitted or not queued; connects
   * again when the server ends the stream while the caller still waits, and after a failure.
   */
  updates(eventId: string): Observable<WaitingRoomStreamMessage> {
    return new Observable((subscriber) => {
      const stop = new AbortController();
      void this.follow(eventId, subscriber, stop.signal);
      return () => stop.abort();
    });
  }

  private async follow(
    eventId: string,
    subscriber: Subscriber<WaitingRoomStreamMessage>,
    signal: AbortSignal
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        const last = await this.readOnce(eventId, subscriber, signal);
        if (last?.state === WAITING_ROOM_STATE.WAITING) continue; // a clean end: connect again
        if (last !== null) {
          subscriber.complete();
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof Error || error instanceof DOMException) || !isRetryable(error)) {
          subscriber.error(error);
          return;
        }
      }
      subscriber.next({ type: WAITING_ROOM_STREAM.RECONNECTING });
      await sleep(RETRY_MS, signal);
    }
  }

  /** One connection; the last status it delivered, which is not WAITING when the stream is done. */
  private async readOnce(
    eventId: string,
    subscriber: Subscriber<WaitingRoomStreamMessage>,
    signal: AbortSignal
  ): Promise<WaitingRoomStatus | null> {
    const connection = new AbortController();
    const abort = () => connection.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.connection.connect(`${url(eventId)}/stream`, connection.signal);
      if (response.body === null) return null;
      let last: WaitingRoomStatus | null = null;
      for await (const raw of sseMessages(response.body, () => undefined)) {
        last = WaitingRoomStatusSchema.parse(JSON.parse(raw.data));
        subscriber.next({ type: WAITING_ROOM_STREAM.STATUS, status: last });
        if (last.state !== WAITING_ROOM_STATE.WAITING) break;
      }
      return last;
    } finally {
      signal.removeEventListener('abort', abort);
      connection.abort();
    }
  }
}

function url(eventId: string): string {
  return `/api/events/${encodeURIComponent(eventId)}/waiting-room`;
}
