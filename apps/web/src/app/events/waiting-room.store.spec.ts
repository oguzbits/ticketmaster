import { TestBed } from '@angular/core/testing';
import { WAITING_ROOM_STATE, type WaitingRoomStatus } from '@app/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeWaitingRoom } from '../../testing/fake-waiting-room';
import {
  WAITING_ROOM_STREAM,
  WaitingRoomService,
  type WaitingRoomStreamMessage,
} from './waiting-room.service';
import { WAITING_ROOM_PENDING, WAITING_ROOM_PHASE, WaitingRoomStore } from './waiting-room.store';

const EVENT_ID = '00000000-0000-4000-8000-0000000000a2';
const NOW = Date.parse('2027-01-01T00:00:00.000Z');
const NONE: WaitingRoomStatus = {
  state: WAITING_ROOM_STATE.NONE,
  position: null,
  waiting: 0,
  admittedUntil: null,
};
const WAITING: WaitingRoomStatus = {
  state: WAITING_ROOM_STATE.WAITING,
  position: 3,
  waiting: 5,
  admittedUntil: null,
};
const ADMITTED: WaitingRoomStatus = {
  state: WAITING_ROOM_STATE.ADMITTED,
  position: null,
  waiting: 4,
  admittedUntil: new Date(NOW + 90_000).toISOString(),
};
const status = (value: WaitingRoomStatus): WaitingRoomStreamMessage => ({
  type: WAITING_ROOM_STREAM.STATUS,
  status: value,
});

function setup() {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  const fake = new FakeWaitingRoom();
  TestBed.configureTestingModule({
    providers: [WaitingRoomStore, { provide: WaitingRoomService, useValue: fake }],
  });
  const store = TestBed.inject(WaitingRoomStore);
  /** Opens the event and answers the first status read. */
  const opened = (first: WaitingRoomStatus = NONE) => {
    store.open(EVENT_ID);
    fake.statusCalls.at(-1)?.next(first);
  };
  return { store, fake, opened };
}

describe('WaitingRoomStore', () => {
  afterEach(() => vi.useRealTimers());

  it('is loading until the status arrives, then shows not joined', () => {
    const { store, fake } = setup();

    store.open(EVENT_ID);
    expect(store.phase()).toBe(WAITING_ROOM_PHASE.LOADING);
    fake.statusCalls[0]?.next(NONE);

    expect(store.phase()).toBe(WAITING_ROOM_PHASE.READY);
    expect(store.state()).toBe(WAITING_ROOM_STATE.NONE);
    expect(fake.streams).toHaveLength(0);
  });

  it('shows an error when the status fails and loads again on retry', () => {
    const { store, fake } = setup();
    store.open(EVENT_ID);
    fake.statusCalls[0]?.error(new Error('down'));
    expect(store.phase()).toBe(WAITING_ROOM_PHASE.ERROR);

    store.retry();
    expect(store.phase()).toBe(WAITING_ROOM_PHASE.LOADING);
    fake.statusCalls[1]?.next(NONE);

    expect(fake.statusCalls).toHaveLength(2);
    expect(store.phase()).toBe(WAITING_ROOM_PHASE.READY);
  });

  it('follows the stream when the caller already waits and skips it when admitted', () => {
    const waiting = setup();
    waiting.opened(WAITING);
    expect(waiting.store.position()).toBe(3);
    expect(waiting.fake.streams).toHaveLength(1);
    TestBed.resetTestingModule();

    const admitted = setup();
    admitted.opened(ADMITTED);
    expect(admitted.store.state()).toBe(WAITING_ROOM_STATE.ADMITTED);
    expect(admitted.fake.streams).toHaveLength(0);
  });

  it('joins once, shows the position live and says when the stream reconnects', () => {
    const { store, fake, opened } = setup();
    opened();

    store.join();
    store.join(); // a double click
    expect(store.pending()).toBe(WAITING_ROOM_PENDING.JOIN);
    expect(fake.joinCalls).toHaveLength(1);
    fake.joinCalls[0]?.next(WAITING);
    expect(store.pending()).toBeNull();
    expect(store.state()).toBe(WAITING_ROOM_STATE.WAITING);

    fake.streams[0]?.next(status({ ...WAITING, position: 2 }));
    expect(store.position()).toBe(2);
    fake.streams[0]?.next({ type: WAITING_ROOM_STREAM.RECONNECTING });
    expect(store.reconnecting()).toBe(true);
    fake.streams[0]?.next(status({ ...WAITING, position: 1 }));
    expect(store.reconnecting()).toBe(false);
    expect(store.position()).toBe(1);
  });

  it('is admitted when the stream says so, counts down and falls back to not joined at the end', () => {
    const { store, fake, opened } = setup();
    opened(WAITING);

    fake.streams[0]?.next(status(ADMITTED));
    expect(store.state()).toBe(WAITING_ROOM_STATE.ADMITTED);
    expect(store.countdown()).toBe('1:30');

    vi.advanceTimersByTime(65_000);
    expect(store.countdown()).toBe('0:25');
    expect(store.state()).toBe(WAITING_ROOM_STATE.ADMITTED);

    vi.advanceTimersByTime(25_000);
    expect(store.state()).toBe(WAITING_ROOM_STATE.NONE);
  });

  it('leaves once, stops following the stream and is not joined', () => {
    const { store, fake, opened } = setup();
    opened(WAITING);

    store.leave();
    store.leave();
    expect(store.pending()).toBe(WAITING_ROOM_PENDING.LEAVE);
    expect(fake.leaveCalls).toHaveLength(1);
    fake.leaveCalls[0]?.next();
    fake.leaveCalls[0]?.complete();

    expect(store.state()).toBe(WAITING_ROOM_STATE.NONE);
    expect(store.pending()).toBeNull();
    expect(fake.streams[0]?.observed).toBe(false);
  });

  it('leaves while admitted: the admission is gone and the countdown stops', () => {
    const { store, fake, opened } = setup();
    opened(ADMITTED);

    store.leave();
    fake.leaveCalls[0]?.complete();

    expect(store.state()).toBe(WAITING_ROOM_STATE.NONE);
    expect(store.admittedUntil()).toBeNull();
  });

  it('reports a failed join and lets the caller try again', () => {
    const { store, fake, opened } = setup();
    opened();

    store.join();
    fake.joinCalls[0]?.error(new Error('down'));
    expect(store.problem()).toContain('could not join');
    expect(store.pending()).toBeNull();
    expect(store.state()).toBe(WAITING_ROOM_STATE.NONE);

    store.join();
    expect(store.problem()).toBeNull();
    expect(fake.joinCalls).toHaveLength(2);
  });

  it('reports a failed leave and stays in the queue', () => {
    const { store, fake, opened } = setup();
    opened(WAITING);

    store.leave();
    fake.leaveCalls[0]?.error(new Error('down'));

    expect(store.problem()).toContain('could not leave');
    expect(store.state()).toBe(WAITING_ROOM_STATE.WAITING);
    expect(store.pending()).toBeNull();
  });

  it('shows an error with retry when the stream breaks the contract', () => {
    const { store, fake, opened } = setup();
    opened(WAITING);

    fake.streams[0]?.error(new Error('bad event'));
    expect(store.phase()).toBe(WAITING_ROOM_PHASE.ERROR);

    store.retry();
    fake.statusCalls[1]?.next(WAITING);
    expect(store.phase()).toBe(WAITING_ROOM_PHASE.READY);
    expect(fake.streams).toHaveLength(2);
  });

  it('reads the status again on refresh, for instance after the server refused a hold', () => {
    const { store, fake, opened } = setup();
    opened(ADMITTED);

    store.refresh();
    expect(store.phase()).toBe(WAITING_ROOM_PHASE.READY); // no flicker back to loading
    fake.statusCalls[1]?.next(NONE);

    expect(store.state()).toBe(WAITING_ROOM_STATE.NONE);
  });

  it('stops following the stream of the old event when another event is opened', () => {
    const { store, fake, opened } = setup();
    opened(WAITING);

    store.open('00000000-0000-4000-8000-0000000000b3');

    // At once, not when the new status arrives: the old stream must not deliver meanwhile.
    expect(fake.streams[0]?.observed).toBe(false);
    fake.statusCalls[1]?.next(NONE);
    expect(store.state()).toBe(WAITING_ROOM_STATE.NONE);
  });

  it('stops following the stream when it is destroyed', () => {
    const { fake, opened } = setup();
    opened(WAITING);

    TestBed.resetTestingModule();

    expect(fake.streams[0]?.observed).toBe(false);
  });
});
