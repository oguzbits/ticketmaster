import { type EventSummary, ROLE, type WaitingRoomStatus } from '@app/shared';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';

import { CLOCK, type Clock } from '../../core/clock.js';
import { type Database, DB } from '../../infrastructure/database/database.module.js';
import { demoUsers, events, venues } from '../../infrastructure/database/schema.js';
import type { AuthUser } from '../auth/index.js';
import {
  ADMISSION_BATCH_SIZE,
  ADMISSION_TTL_SECONDS,
  planAdmissions,
} from './domain/admission-policy.js';
import { WAITING_ROOM_STORE, type WaitingRoomStore } from './domain/waiting-room-store.js';

const SECOND_MS = 1000;

@Injectable()
export class WaitingRoomService {
  private readonly logger = new Logger(WaitingRoomService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WAITING_ROOM_STORE) private readonly store: WaitingRoomStore
  ) {}

  /** NotFound for an event the caller cannot see, Conflict when the event has no waiting room. */
  async join(eventId: string, userId: string): Promise<WaitingRoomStatus> {
    const [event] = await this.db
      .select({ capacity: events.waitingRoomCapacity })
      .from(events)
      .where(
        and(
          eq(events.id, eventId),
          or(isNull(events.sandboxUserId), eq(events.sandboxUserId, userId))
        )
      );
    if (event === undefined) throw new NotFoundException('Event not found');
    if (event.capacity === null) throw new ConflictException('The event has no waiting room');
    const now = this.clock.now();
    await this.store.join(eventId, userId, now);
    return this.store.status(eventId, userId, now);
  }

  leave(eventId: string, userId: string): Promise<void> {
    return this.store.leave(eventId, userId);
  }

  status(eventId: string, userId: string): Promise<WaitingRoomStatus> {
    return this.store.status(eventId, userId, this.clock.now());
  }

  /** ForbiddenException unless the event has no waiting room or the user holds a live admission. */
  async assertAdmitted(eventId: string, userId: string): Promise<void> {
    const [event] = await this.db
      .select({ capacity: events.waitingRoomCapacity })
      .from(events)
      .where(eq(events.id, eventId));
    if (event === undefined || event.capacity === null) return;
    if (!(await this.store.isAdmitted(eventId, userId, this.clock.now()))) {
      throw new ForbiddenException('Join the waiting room first');
    }
  }

  /**
   * The organizer of the event, or an admin: a demo admin's login hands out admin tokens, so a demo
   * admin may only change their own sandbox events and a regular admin the public ones. Anything
   * else does not exist for the caller (NotFound).
   */
  async setCapacity(
    eventId: string,
    capacity: number | null,
    caller: AuthUser
  ): Promise<EventSummary> {
    const owner = eq(events.ownerId, caller.id);
    const scope = caller.roles.includes(ROLE.ADMIN)
      ? or(owner, await this.adminScope(caller.id))
      : owner;
    const [updated] = await this.db
      .update(events)
      .set({ waitingRoomCapacity: capacity })
      .where(and(eq(events.id, eventId), scope))
      .returning({ id: events.id });
    if (updated === undefined) throw new NotFoundException('Event not found');
    const [event] = await this.db
      .select({
        id: events.id,
        name: events.name,
        startsAt: events.startsAt,
        venueName: venues.name,
        strategy: events.strategy,
        waitingRoomCapacity: events.waitingRoomCapacity,
      })
      .from(events)
      .innerJoin(venues, eq(venues.id, events.venueId))
      .where(eq(events.id, eventId));
    if (event === undefined) throw new NotFoundException('Event not found');
    return { ...event, startsAt: event.startsAt.toISOString() };
  }

  /** One tick for every event with a waiting room; returns the number of users admitted. */
  async admitDue(): Promise<number> {
    const rooms = await this.db
      .select({ id: events.id, capacity: events.waitingRoomCapacity })
      .from(events)
      .where(isNotNull(events.waitingRoomCapacity));
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + ADMISSION_TTL_SECONDS * SECOND_MS);
    let total = 0;
    for (const { id, capacity } of rooms) {
      if (capacity === null) continue;
      const { admitted, head } = await this.store.snapshot(id, now, ADMISSION_BATCH_SIZE);
      const userIds = planAdmissions({ capacity, admitted, head, batchSize: ADMISSION_BATCH_SIZE });
      if (userIds.length === 0) continue;
      const moved = await this.store.admit({ eventId: id, userIds, capacity, now, expiresAt });
      this.logger.log(`admitted ${moved.length} users to event ${id}`);
      total += moved.length;
    }
    return total;
  }

  private async adminScope(adminId: string) {
    const [demoUser] = await this.db
      .select({ userId: demoUsers.userId })
      .from(demoUsers)
      .where(eq(demoUsers.userId, adminId));
    return demoUser === undefined
      ? isNull(events.sandboxUserId)
      : eq(events.sandboxUserId, adminId);
  }
}
