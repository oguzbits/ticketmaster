import { TestBed } from '@angular/core/testing';
import { WAITING_ROOM_STATE, type WaitingRoomStatus } from '@app/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeWaitingRoom } from '../../testing/fake-waiting-room';
import { WAITING_ROOM_STREAM, WaitingRoomService } from './waiting-room.service';
import { WaitingRoomStore } from './waiting-room.store';
import { WaitingRoomPanel } from './waiting-room-panel';

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

function render(first: WaitingRoomStatus | null = NONE) {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(NOW);
  const fake = new FakeWaitingRoom();
  TestBed.configureTestingModule({
    providers: [WaitingRoomStore, { provide: WaitingRoomService, useValue: fake }],
  });
  const fixture = TestBed.createComponent(WaitingRoomPanel);
  fixture.componentRef.setInput('eventId', EVENT_ID);
  const element: HTMLElement = fixture.nativeElement;
  TestBed.tick();
  const show = () => TestBed.tick();
  const button = (name: RegExp) =>
    [...element.querySelectorAll('button')].find((candidate) =>
      name.test(candidate.textContent ?? '')
    );
  const press = (name: RegExp) => {
    const target = button(name);
    if (!target) throw new Error(`No button ${String(name)}`);
    target.click();
    show();
  };
  if (first) {
    fake.statusCalls[0]?.next(first);
    show();
  }
  return { element, fake, button, press, show };
}

describe('WaitingRoomPanel', () => {
  afterEach(() => vi.useRealTimers());

  it('shows a loading state until the status arrives', () => {
    const { element, fake, show } = render(null);
    expect(element.querySelector('[role=status]')?.textContent).toContain('Checking');
    expect(element.querySelector('button')).toBeNull();

    fake.statusCalls[0]?.next(NONE);
    show();

    expect(element.querySelector('[role=status]')).toBeNull();
  });

  it('offers to join, disables the button while joining and sends one request', () => {
    const { element, fake, button, press } = render();
    expect(element.textContent).toContain('Join it to pick a seat');

    press(/Join the waiting room/);
    expect(button(/Joining/)?.disabled).toBe(true);
    button(/Joining/)?.click();

    expect(fake.joinCalls).toHaveLength(1);
  });

  it('shows the position and the length of the queue and leaves on request', () => {
    const { element, fake, press, show } = render();
    press(/Join the waiting room/);
    fake.joinCalls[0]?.next(WAITING);
    show();
    expect(element.textContent).toContain('Position 3 of 5');

    fake.streams[0]?.next({
      type: WAITING_ROOM_STREAM.STATUS,
      status: { ...WAITING, position: 2 },
    });
    show();
    expect(element.textContent).toContain('Position 2 of 5');

    press(/Leave/);
    expect(fake.leaveCalls).toHaveLength(1);
    fake.leaveCalls[0]?.complete();
    show();
    expect(element.textContent).toContain('Join the waiting room');
  });

  it('shows until when the admission lasts with a countdown, and no join button', () => {
    const { element, button, show } = render(ADMITTED);
    expect(element.textContent).toContain('You are admitted');
    expect(element.querySelector('[role=timer]')?.textContent).toContain('1:30');
    expect(button(/Join/)).toBeUndefined();

    vi.advanceTimersByTime(30_000);
    show();

    expect(element.querySelector('[role=timer]')?.textContent).toContain('1:00');
  });

  it('returns to not joined when the admission runs out', () => {
    const { element, button, show } = render(ADMITTED);

    vi.advanceTimersByTime(90_000);
    show();

    expect(element.querySelector('[role=timer]')).toBeNull();
    expect(button(/Join the waiting room/)).toBeDefined();
  });

  it('tells that the live position is paused while the stream reconnects', () => {
    const { element, fake, show } = render(WAITING);

    fake.streams[0]?.next({ type: WAITING_ROOM_STREAM.RECONNECTING });
    show();

    expect(element.textContent).toContain('Reconnecting');
  });

  it('shows an error with a retry that reads the status again', () => {
    const { element, fake, press, show } = render(null);
    fake.statusCalls[0]?.error(new Error('down'));
    show();
    expect(element.querySelector('[role=alert]')).not.toBeNull();

    press(/Try again/);
    expect(fake.statusCalls).toHaveLength(2);
    fake.statusCalls[1]?.next(NONE);
    show();

    expect(element.querySelector('[role=alert]')).toBeNull();
    expect(element.textContent).toContain('Join the waiting room');
  });

  it('tells when joining failed and keeps the join button', () => {
    const { element, fake, button, press, show } = render();

    press(/Join the waiting room/);
    fake.joinCalls[0]?.error(new Error('down'));
    show();

    expect(element.querySelector('[role=alert]')?.textContent).toContain('could not join');
    expect(button(/Join the waiting room/)?.disabled).toBe(false);
  });
});
