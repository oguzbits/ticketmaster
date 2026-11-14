import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ROLE, type Seat, SEAT_STATUS, SEAT_STREAM_EVENT } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeFetch } from '../../testing/fake-fetch';
import { tokensFor } from '../../testing/tokens';
import { SessionStore } from '../auth/session.store';
import {
  FETCH,
  SEAT_STREAM_STATE,
  type SeatStreamMessage,
  SeatStreamService,
} from './seat-stream.service';

const EVENT_ID = '00000000-0000-4000-8000-0000000000a2';
const STREAM_URL = `/api/events/${EVENT_ID}/seats/stream`;
const SEAT: Seat = {
  id: '00000000-0000-4000-8000-000000000101',
  section: 'A',
  row: 3,
  number: 7,
  priceCents: 9000,
  status: SEAT_STATUS.AVAILABLE,
};
const CHANGE = {
  eventId: EVENT_ID,
  seatId: SEAT.id,
  status: SEAT_STATUS.HELD,
  at: '2027-01-01T00:00:00.000Z',
};
const frame = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const SNAPSHOT = frame(SEAT_STREAM_EVENT.SNAPSHOT, { seats: [SEAT] });
const CHANGED = frame(SEAT_STREAM_EVENT.CHANGE, CHANGE);

function setup(role: (typeof ROLE)[keyof typeof ROLE] | null = null) {
  const fake = fakeFetch();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([{ path: '', children: [] }]),
      { provide: FETCH, useValue: fake.fetcher },
    ],
  });
  if (role) TestBed.inject(SessionStore).set(tokensFor(role));
  const messages: SeatStreamMessage[] = [];
  const errors: Error[] = [];
  const subscription = TestBed.inject(SeatStreamService)
    .changes(EVENT_ID)
    .subscribe({ next: (m) => messages.push(m), error: (e: Error) => errors.push(e) });
  /** Lets pending promises and timers run for `ms` of fake time. */
  const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  return { ...fake, messages, errors, subscription, settle };
}

const types = (messages: SeatStreamMessage[]) => messages.map((m) => m.type);

describe('SeatStreamService', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // No jitter: a wait is exactly the backoff.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    TestBed.inject(HttpTestingController).verify();
  });

  it('parses snapshot and change events, also when a chunk ends inside an event', async () => {
    const { open, messages, settle, subscription } = setup();
    const stream = open();
    await settle();

    stream.push(': heartbeat\n\n' + SNAPSHOT + CHANGED.slice(0, 20));
    await settle();
    expect(types(messages)).toEqual([SEAT_STREAM_EVENT.SNAPSHOT]);
    stream.push(CHANGED.slice(20));
    await settle();

    expect(messages).toEqual([
      { type: SEAT_STREAM_EVENT.SNAPSHOT, snapshot: { seats: [SEAT] } },
      { type: SEAT_STREAM_EVENT.CHANGE, change: CHANGE },
    ]);
    subscription.unsubscribe();
  });

  it('sends the bearer token of the session and none without a session', async () => {
    const signedIn = setup(ROLE.CUSTOMER);
    signedIn.open();
    await signedIn.settle();
    expect(signedIn.calls[0]?.url).toBe(STREAM_URL);
    expect(signedIn.calls[0]?.headers.get('authorization')).toBe(
      `Bearer ${TestBed.inject(SessionStore).accessToken()}`
    );
    signedIn.subscription.unsubscribe();
  });

  it('sends no Authorization header without a session', async () => {
    const anonymous = setup();
    anonymous.open();
    await anonymous.settle();
    expect(anonymous.calls[0]?.headers.has('authorization')).toBe(false);
    anonymous.subscription.unsubscribe();
  });

  it('reconnects at once after a clean end and lets the new snapshot replace the state', async () => {
    const { open, calls, messages, settle, subscription } = setup();
    const first = open();
    await settle();
    first.push(SNAPSHOT);
    const second = open();
    first.end();
    await settle();

    expect(calls).toHaveLength(2);
    second.push(
      frame(SEAT_STREAM_EVENT.SNAPSHOT, { seats: [{ ...SEAT, status: SEAT_STATUS.SOLD }] })
    );
    await settle();
    expect(types(messages)).toEqual([SEAT_STREAM_EVENT.SNAPSHOT, SEAT_STREAM_EVENT.SNAPSHOT]);
    subscription.unsubscribe();
  });

  it('backs off after a network failure, says so, and connects again', async () => {
    const { networkFailure, open, calls, messages, settle, subscription } = setup();
    networkFailure();
    open();
    await settle();

    expect(messages).toEqual([{ type: SEAT_STREAM_STATE.RECONNECTING, busy: false }]);
    expect(calls).toHaveLength(1);
    await settle(1000);
    expect(calls).toHaveLength(2);
    subscription.unsubscribe();
  });

  it('waits longer after each failure and starts over after a snapshot', async () => {
    const { networkFailure, open, calls, settle, subscription } = setup();
    networkFailure();
    networkFailure();
    const third = open();
    await settle(); // failure 1
    await settle(1000); // waits at most 1 s, failure 2
    expect(calls).toHaveLength(2);
    await settle(1999);
    expect(calls).toHaveLength(2); // the second wait is at least 1 s (half of 2 s)
    await settle(1);
    expect(calls).toHaveLength(3);

    third.push(SNAPSHOT);
    networkFailure();
    open();
    third.end();
    await settle();
    expect(calls).toHaveLength(4); // clean end: immediate
    await settle(1000); // after the snapshot a failure waits 1 s again
    expect(calls).toHaveLength(5);
    subscription.unsubscribe();
  });

  it('caps the wait between attempts at 30 seconds', async () => {
    const { networkFailure, open, calls, settle, subscription } = setup();
    for (let i = 0; i < 6; i++) networkFailure();
    open();

    // Waits of 1, 2, 4, 8, 16 and 30 seconds; uncapped the sixth would be 32.
    await settle(61_000);

    expect(calls).toHaveLength(7);
    subscription.unsubscribe();
  });

  it.each([429, 503])('treats %i as busy and honours Retry-After', async (status) => {
    const { refuse, open, calls, messages, settle, subscription } = setup();
    refuse(status, { 'retry-after': '5' });
    open();
    await settle();

    expect(messages).toEqual([{ type: SEAT_STREAM_STATE.RECONNECTING, busy: true }]);
    await settle(4999);
    expect(calls).toHaveLength(1);
    await settle(1);
    expect(calls).toHaveLength(2);
    subscription.unsubscribe();
  });

  it('gives up on an unknown event instead of retrying', async () => {
    const { refuse, calls, errors, settle } = setup();
    refuse(404);
    await settle(60_000);

    expect(errors).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('refreshes the token once after a 401 and connects again with the new one', async () => {
    const { refuse, open, calls, settle, subscription } = setup(ROLE.CUSTOMER);
    refuse(401);
    open();
    await settle();
    const renewed = tokensFor(ROLE.CUSTOMER, 'renewed');
    TestBed.inject(HttpTestingController).expectOne('/api/auth/refresh').flush(renewed);
    await settle();

    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.get('authorization')).toBe(`Bearer ${renewed.accessToken}`);
    subscription.unsubscribe();
  });

  it('ends the stream and the session when the refresh fails', async () => {
    const { refuse, errors, settle } = setup(ROLE.CUSTOMER);
    refuse(401);
    await settle();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/auth/refresh')
      .flush(null, { status: 401, statusText: 'Unauthorized' });
    await settle();

    expect(errors).toHaveLength(1);
    expect(TestBed.inject(SessionStore).isLoggedIn()).toBe(false);
  });

  it('does not loop on a second 401', async () => {
    const { refuse, calls, errors, settle } = setup(ROLE.CUSTOMER);
    refuse(401);
    refuse(401);
    await settle();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/auth/refresh')
      .flush(tokensFor(ROLE.CUSTOMER, 'n'));
    await settle(60_000);

    expect(calls).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });

  it('reconnects when nothing arrives for longer than the heartbeat interval', async () => {
    const { open, calls, messages, settle, subscription } = setup();
    open();
    open();
    await settle();

    await settle(45_000);

    expect(calls[0]?.signal.aborted).toBe(true);
    expect(types(messages)).toEqual([SEAT_STREAM_STATE.RECONNECTING]);
    await settle(1000);
    expect(calls).toHaveLength(2);
    subscription.unsubscribe();
  });

  it('keeps the connection while heartbeats arrive', async () => {
    const { open, calls, settle, subscription } = setup();
    const stream = open();
    await settle();

    for (let i = 0; i < 4; i++) {
      await settle(30_000);
      stream.push(': heartbeat\n\n');
    }

    expect(calls).toHaveLength(1);
    subscription.unsubscribe();
  });

  it('stops for good on unsubscribe: aborts the request and does not reconnect', async () => {
    const { open, calls, settle, subscription } = setup();
    open();
    await settle();

    subscription.unsubscribe();
    await settle(60_000);

    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('fails on an event that breaks the contract instead of showing wrong seats', async () => {
    const { open, calls, errors, settle } = setup();
    const stream = open();
    await settle();

    stream.push(frame(SEAT_STREAM_EVENT.CHANGE, { seatId: 'nope' }));
    await settle(60_000);

    expect(errors).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});
