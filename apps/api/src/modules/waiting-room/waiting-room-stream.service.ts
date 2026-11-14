import { randomUUID } from 'node:crypto';

import { WAITING_ROOM_STATE, type WaitingRoomStatus } from '@app/shared';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  catchError,
  distinctUntilChanged,
  exhaustMap,
  finalize,
  from,
  type Observable,
  takeUntil,
  takeWhile,
  throwError,
  timer,
} from 'rxjs';

import { SLOT_SLACK_MS, SlotLimiter } from '../../infrastructure/rate-limit/slot-limiter.js';
import { WaitingRoomService } from './waiting-room.service.js';

/** How often a stream looks at the place of its user. */
export const WAITING_ROOM_POLL_MS = 1000;
/** After this long the server ends a stream; the client reconnects and reads the current state. */
export const WAITING_ROOM_STREAM_MAX_LIFETIME_MS = 600_000;
/** Open waiting-room streams all API instances serve together; every stream polls Redis. */
export const MAX_WAITING_ROOM_STREAMS = 200;

/** Serves the place of one user: polls the store, no subscription, so it works across instances. */
@Injectable()
export class WaitingRoomStreamService {
  // Public so a spec can shorten them.
  pollMs = WAITING_ROOM_POLL_MS;
  maxLifetimeMs = WAITING_ROOM_STREAM_MAX_LIFETIME_MS;
  maxStreams = MAX_WAITING_ROOM_STREAMS;
  /** Redis key of the slot counter; a spec uses a key of its own. */
  slotKey = 'streams:waiting-room:total';
  private readonly logger = new Logger(WaitingRoomStreamService.name);

  constructor(
    @Inject(WaitingRoomService) private readonly waitingRoom: Pick<WaitingRoomService, 'status'>,
    @Inject(SlotLimiter) private readonly slots: SlotLimiter
  ) {}

  /**
   * Emits the status when it changed and completes once the user is ADMITTED or not queued. The cap
   * is checked here, before an Observable exists: once Nest subscribes it has sent the 200 headers.
   * The slot is taken now and given back when the stream ends, so the caller must subscribe (a
   * slot that is never given back runs out by itself after the stream lifetime).
   */
  async stream(eventId: string, userId: string): Promise<Observable<WaitingRoomStatus>> {
    const slotId = randomUUID();
    const lifetimeMs = this.maxLifetimeMs + SLOT_SLACK_MS;
    if (!(await this.slots.acquire(this.slotKey, slotId, this.maxStreams, lifetimeMs))) {
      throw new ServiceUnavailableException('Too many open streams, try again later');
    }
    return timer(0, this.pollMs).pipe(
      // One read at a time: a slow read must not stack up behind the next tick.
      exhaustMap(() => from(this.waitingRoom.status(eventId, userId))),
      distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      takeWhile(({ state }) => state === WAITING_ROOM_STATE.WAITING, true),
      takeUntil(timer(this.maxLifetimeMs)),
      catchError((error: Error) => {
        this.logger.error(`waiting room stream of event ${eventId} failed: ${error.name}`);
        return throwError(() => error);
      }),
      finalize(() => {
        // A slot that stays after a failed release runs out by itself.
        this.slots.release(this.slotKey, slotId).catch((error: Error) => {
          this.logger.error(`releasing a stream slot failed: ${error.name}`);
        });
      })
    );
  }
}
