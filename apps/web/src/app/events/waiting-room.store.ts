import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { WAITING_ROOM_STATE, type WaitingRoomStatus } from '@app/shared';
import { map, type Subscription, timer } from 'rxjs';

import {
  WAITING_ROOM_STREAM,
  WaitingRoomService,
  type WaitingRoomStreamMessage,
} from './waiting-room.service';

export const WAITING_ROOM_PHASE = { LOADING: 'loading', READY: 'ready', ERROR: 'error' } as const;
type WaitingRoomPhase = (typeof WAITING_ROOM_PHASE)[keyof typeof WAITING_ROOM_PHASE];

export const WAITING_ROOM_PENDING = { JOIN: 'join', LEAVE: 'leave' } as const;
type WaitingRoomPending = (typeof WAITING_ROOM_PENDING)[keyof typeof WAITING_ROOM_PENDING];

const MESSAGE = {
  JOIN_FAILED: 'You could not join the waiting room. Try again.',
  LEAVE_FAILED: 'You could not leave the waiting room. Try again.',
} as const;

const NOT_JOINED: WaitingRoomStatus = {
  state: WAITING_ROOM_STATE.NONE,
  position: null,
  waiting: 0,
  admittedUntil: null,
};
const TICK_MS = 1000;

/**
 * The waiting room of one seat map: where the caller stands, live, and until when an admission
 * lasts. One instance per seat map (provided by the component).
 */
@Injectable()
export class WaitingRoomStore {
  private readonly service = inject(WaitingRoomService);

  readonly phase = signal<WaitingRoomPhase>(WAITING_ROOM_PHASE.LOADING);
  /** The action that is on its way; controls are disabled and a second submit is ignored. */
  readonly pending = signal<WaitingRoomPending | null>(null);
  readonly problem = signal<string | null>(null);
  /** The live position is paused: the stream is down and connects again. */
  readonly reconnecting = signal(false);

  private readonly status = signal<WaitingRoomStatus>(NOT_JOINED);
  private eventId = '';
  private updates: Subscription | null = null;

  private readonly now = toSignal(timer(0, TICK_MS).pipe(map(() => Date.now())), {
    initialValue: Date.now(),
  });
  /** Seconds of the admission that are left; null unless the status says admitted. */
  readonly secondsLeft = computed(() => {
    const { state, admittedUntil } = this.status();
    if (state !== WAITING_ROOM_STATE.ADMITTED || admittedUntil === null) return null;
    return Math.max(0, Math.ceil((Date.parse(admittedUntil) - this.now()) / TICK_MS));
  });
  /** An admission that ran out counts as not joined, without waiting for the server to say so. */
  readonly state = computed(() =>
    this.secondsLeft() === 0 ? WAITING_ROOM_STATE.NONE : this.status().state
  );
  readonly admitted = computed(() => this.state() === WAITING_ROOM_STATE.ADMITTED);
  readonly position = computed(() => this.status().position);
  readonly waiting = computed(() => this.status().waiting);
  readonly admittedUntil = computed(() => this.status().admittedUntil);
  /** The time left as `m:ss`. */
  readonly countdown = computed(() => {
    const seconds = this.secondsLeft() ?? 0;
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopUpdates());
  }

  /** Reads the status of the event; a waiting caller then follows the live stream. */
  open(eventId: string): void {
    this.eventId = eventId;
    this.stopUpdates();
    this.phase.set(WAITING_ROOM_PHASE.LOADING);
    this.read();
  }

  retry(): void {
    this.open(this.eventId);
  }

  /** Reads the status again without a loading state, for instance after a refused hold. */
  refresh(): void {
    this.read();
  }

  join(): void {
    if (this.pending() !== null) return;
    this.pending.set(WAITING_ROOM_PENDING.JOIN);
    this.problem.set(null);
    this.service.join(this.eventId).subscribe({
      next: (status) => {
        this.pending.set(null);
        this.apply(status);
      },
      error: () => {
        this.pending.set(null);
        this.problem.set(MESSAGE.JOIN_FAILED);
      },
    });
  }

  leave(): void {
    if (this.pending() !== null) return;
    this.pending.set(WAITING_ROOM_PENDING.LEAVE);
    this.problem.set(null);
    this.service.leave(this.eventId).subscribe({
      complete: () => {
        this.pending.set(null);
        this.apply(NOT_JOINED);
      },
      error: () => {
        this.pending.set(null);
        this.problem.set(MESSAGE.LEAVE_FAILED);
      },
    });
  }

  private read(): void {
    this.service.status(this.eventId).subscribe({
      next: (status) => {
        this.phase.set(WAITING_ROOM_PHASE.READY);
        this.apply(status);
      },
      error: () => this.phase.set(WAITING_ROOM_PHASE.ERROR),
    });
  }

  private apply(status: WaitingRoomStatus): void {
    this.status.set(status);
    if (status.state === WAITING_ROOM_STATE.WAITING) this.follow();
    else this.stopUpdates();
  }

  private follow(): void {
    if (this.updates !== null) return;
    this.updates = this.service.updates(this.eventId).subscribe({
      next: (message) => this.onMessage(message),
      error: () => {
        this.updates = null;
        this.phase.set(WAITING_ROOM_PHASE.ERROR);
      },
    });
  }

  private onMessage(message: WaitingRoomStreamMessage): void {
    if (message.type === WAITING_ROOM_STREAM.RECONNECTING) {
      this.reconnecting.set(true);
      return;
    }
    this.reconnecting.set(false);
    this.apply(message.status);
  }

  private stopUpdates(): void {
    this.updates?.unsubscribe();
    this.updates = null;
    this.reconnecting.set(false);
  }
}
