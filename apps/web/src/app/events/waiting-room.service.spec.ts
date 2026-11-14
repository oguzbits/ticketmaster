import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ROLE, WAITING_ROOM_STATE, type WaitingRoomStatus } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeFetch } from '../../testing/fake-fetch';
import { tokensFor } from '../../testing/tokens';
import { SessionStore } from '../auth/session.store';
import { FETCH } from './seat-stream.service';
import {
  WAITING_ROOM_STREAM,
  WaitingRoomService,
  type WaitingRoomStreamMessage,
} from './waiting-room.service';

const EVENT_ID = '00000000-0000-4000-8000-0000000000a2';
const URL = `/api/events/${EVENT_ID}/waiting-room`;
const WAITING: WaitingRoomStatus = {
  state: WAITING_ROOM_STATE.WAITING,
  position: 2,
  waiting: 5,
  admittedUntil: null,
};
const ADMITTED: WaitingRoomStatus = {
  state: WAITING_ROOM_STATE.ADMITTED,
  position: null,
  waiting: 4,
  admittedUntil: '2027-01-01T00:05:00.000Z',
};
const NONE: WaitingRoomStatus = {
  state: WAITING_ROOM_STATE.NONE,
  position: null,
  waiting: 0,
  admittedUntil: null,
};
const frame = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
const status = (value: WaitingRoomStatus): WaitingRoomStreamMessage => ({
  type: WAITING_ROOM_STREAM.STATUS,
  status: value,
});
const RECONNECTING: WaitingRoomStreamMessage = { type: WAITING_ROOM_STREAM.RECONNECTING };

function setup() {
  const fake = fakeFetch();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: FETCH, useValue: fake.fetcher },
    ],
  });
  TestBed.inject(SessionStore).set(tokensFor(ROLE.CUSTOMER));
  const service = TestBed.inject(WaitingRoomService);
  const http = TestBed.inject(HttpTestingController);
  const messages: WaitingRoomStreamMessage[] = [];
  const errors: Error[] = [];
  let completed = false;
  const follow = () =>
    service.updates(EVENT_ID).subscribe({
      next: (message) => messages.push(message),
      error: (error: Error) => errors.push(error),
      complete: () => (completed = true),
    });
  const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
  return { ...fake, service, http, messages, errors, follow, settle, done: () => completed };
}

describe('WaitingRoomService', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(() => {
    vi.useRealTimers();
    TestBed.inject(HttpTestingController).verify();
  });

  it('joins, reads the status and leaves with the event in the path', () => {
    const { service, http } = setup();
    const results: WaitingRoomStatus[] = [];
    let left = false;

    service.join(EVENT_ID).subscribe((value) => results.push(value));
    http.expectOne({ method: 'POST', url: URL }).flush(WAITING);
    service.status(EVENT_ID).subscribe((value) => results.push(value));
    http.expectOne({ method: 'GET', url: URL }).flush(ADMITTED);
    service.leave(EVENT_ID).subscribe(() => (left = true));
    http.expectOne({ method: 'DELETE', url: URL }).flush(null, { status: 204, statusText: 'No' });

    expect(results).toEqual([WAITING, ADMITTED]);
    expect(left).toBe(true);
  });

  it('refuses an answer that breaks the contract', () => {
    const { service, http } = setup();
    const errors: Error[] = [];

    service.status(EVENT_ID).subscribe({ error: (error: Error) => errors.push(error) });
    http.expectOne(URL).flush({ state: 'LOST' });

    expect(errors).toHaveLength(1);
  });

  it('parses status events, also when a chunk ends inside one, with the bearer token', async () => {
    const { open, calls, messages, follow, settle } = setup();
    const stream = open();
    const subscription = follow();
    await settle();

    stream.push(': heartbeat\n\n' + frame(WAITING).slice(0, 15));
    await settle();
    expect(messages).toEqual([]);
    stream.push(frame(WAITING).slice(15) + frame({ ...WAITING, position: 1 }));
    await settle();

    expect(messages).toEqual([status(WAITING), status({ ...WAITING, position: 1 })]);
    expect(calls[0]?.url).toBe(`${URL}/stream`);
    expect(calls[0]?.headers.get('authorization')).toBe(
      `Bearer ${TestBed.inject(SessionStore).accessToken()}`
    );
    subscription.unsubscribe();
  });

  it('completes and closes the connection once the user is admitted', async () => {
    const { open, calls, messages, done, follow, settle } = setup();
    const stream = open();
    follow();
    await settle();

    stream.push(frame(WAITING) + frame(ADMITTED));
    await settle(10_000);

    expect(messages).toEqual([status(WAITING), status(ADMITTED)]);
    expect(done()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal.aborted).toBe(true);
  });

  it('completes without a second connection when the user is not queued', async () => {
    const { open, calls, done, follow, settle } = setup();
    const stream = open();
    follow();
    await settle();

    stream.push(frame(NONE));
    stream.end();
    await settle(10_000);

    expect(done()).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('connects again at once when the server ends the stream while the user waits', async () => {
    const { open, calls, messages, follow, settle } = setup();
    const first = open();
    const second = open();
    const subscription = follow();
    await settle();

    first.push(frame(WAITING));
    first.end();
    await settle();
    expect(calls).toHaveLength(2);
    second.push(frame({ ...WAITING, position: 1 }));
    await settle();

    expect(messages).toEqual([status(WAITING), status({ ...WAITING, position: 1 })]);
    subscription.unsubscribe();
  });

  it('says so after a failure and connects again a few seconds later', async () => {
    const { networkFailure, refuse, open, calls, messages, follow, settle } = setup();
    networkFailure();
    refuse(503);
    open();
    const subscription = follow();
    await settle();

    expect(messages).toEqual([RECONNECTING]);
    await settle(2999);
    expect(calls).toHaveLength(1);
    await settle(1);
    expect(calls).toHaveLength(2);
    await settle(3000);
    expect(calls).toHaveLength(3);
    expect(messages).toEqual([RECONNECTING, RECONNECTING]);
    subscription.unsubscribe();
  });

  it('gives up on an unknown event instead of retrying', async () => {
    const { refuse, calls, errors, follow, settle } = setup();
    refuse(404);
    follow();
    await settle(60_000);

    expect(errors).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('stops for good on unsubscribe: aborts the request and does not reconnect', async () => {
    const { open, calls, follow, settle } = setup();
    open();
    const subscription = follow();
    await settle();

    subscription.unsubscribe();
    await settle(60_000);

    expect(calls[0]?.signal.aborted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('fails on an event that breaks the contract instead of showing a wrong position', async () => {
    const { open, errors, follow, settle } = setup();
    const stream = open();
    follow();
    await settle();

    stream.push(frame({ state: 'LOST' }));
    await settle();

    expect(errors).toHaveLength(1);
  });
});
