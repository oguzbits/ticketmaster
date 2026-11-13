import { randomBytes } from 'node:crypto';

import { BOOKING_STRATEGY, type Role, SEAT_STATUS, type TokenResponse } from '@app/shared';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { and, count, eq, inArray, isNull, lte } from 'drizzle-orm';

import type { Clock } from '../../core/clock.js';
import type { Database } from '../../infrastructure/database/database.module.js';
import { bookings, demoUsers, events, seats } from '../../infrastructure/database/schema.js';
import { HALL, layoutSeats, SEED, STARTS_AT } from '../../infrastructure/database/seed.js';
import {
  ACTIVE_BOOKING_STATUSES,
  publishSeatChange,
  type SeatChangePublisher,
} from '../bookings/index.js';
import { demoIdentity, type KeycloakAdmin } from './domain/demo-user.js';

/** Every demo login makes a Keycloak user and four events, so the number of live ones is capped. */
export const MAX_DEMO_USERS = 200;
/**
 * The guard is stateless: an access token stays valid for its whole lifetime after its user is
 * deleted (`accessTokenLifespan` of the realm file). Cleanup waits that long past `expires_at`, so a
 * deleted user cannot create bookings that no `demo_users` row would clean up.
 */
export const ACCESS_TOKEN_GRACE_SECONDS = 300;
/** Demo users one cleanup run handles, so a long backlog cannot make one run last minutes. */
export const DEMO_CLEANUP_BATCH = 100;
const SUFFIX_BYTES = 6;
const PASSWORD_BYTES = 24;

/** Settings of the demo login and the notice the cleanup sends when it frees seats. */
export interface DemoOptions {
  userTtlSeconds: number;
  maxUsers: number;
  seatChanges: SeatChangePublisher;
}
export const DEMO_OPTIONS = Symbol('DEMO_OPTIONS');

@Injectable()
export class DemoService {
  private readonly logger = new Logger(DemoService.name);

  constructor(
    private readonly db: Database,
    private readonly keycloak: KeycloakAdmin,
    private readonly clock: Clock,
    private readonly options: DemoOptions
  ) {}

  async login(role: Role): Promise<TokenResponse> {
    const [live] = await this.db.select({ total: count() }).from(demoUsers);
    if ((live?.total ?? 0) >= this.options.maxUsers) {
      throw new ServiceUnavailableException('The demo is full, try again later');
    }
    const password = randomBytes(PASSWORD_BYTES).toString('base64url');
    const identity = demoIdentity(randomBytes(SUFFIX_BYTES).toString('hex'));
    const userId = await this.keycloak.createUser({ ...identity, password, role });
    try {
      // The grant comes first: a refused grant leaves nothing in the database to clean up.
      const tokens = await this.keycloak.passwordGrant(identity.username, password);
      await this.storeUser(userId, role);
      return tokens;
    } catch (error) {
      try {
        await this.keycloak.deleteUser(userId);
      } catch (cleanupError) {
        // The login error is the one the caller needs (it may carry an HTTP status); the failed
        // cleanup travels with it as `cause` when that is free, and is always logged.
        this.logger.error(`could not remove demo user ${userId} after a failed login`);
        if (error instanceof Error) error.cause ??= cleanupError;
      }
      throw error;
    }
  }

  refresh(refreshToken: string): Promise<TokenResponse> {
    return this.keycloak.refresh(refreshToken);
  }

  /**
   * Cleans up every demo user whose time, plus the grace of its access token, has passed and
   * returns how many it cleaned, at most one batch (`DEMO_CLEANUP_BATCH`, oldest first) per call. A user whose
   * Keycloak call fails keeps its row, so the next run tries again; the others are cleaned anyway.
   */
  async deleteExpired(now: Date): Promise<number> {
    const due = await this.db
      .select({ userId: demoUsers.userId })
      .from(demoUsers)
      .where(lte(demoUsers.expiresAt, new Date(now.getTime() - ACCESS_TOKEN_GRACE_SECONDS * 1000)))
      .orderBy(demoUsers.expiresAt)
      .limit(DEMO_CLEANUP_BATCH);
    const failures: Error[] = [];
    for (const { userId } of due) {
      try {
        await this.deleteUser(userId, now);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.logger.error(`could not clean up demo user ${userId}: ${failure.name}`);
        failures.push(failure);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} demo users could not be cleaned up`);
    }
    return due.length;
  }

  /** The user's row, and one private event per strategy on the hall's layout. */
  private storeUser(userId: string, role: Role): Promise<void> {
    const expiresAt = new Date(this.clock.now().getTime() + this.options.userTtlSeconds * 1000);
    return this.db.transaction(async (tx) => {
      await tx.insert(demoUsers).values({ userId, role, expiresAt });
      const created = await tx
        .insert(events)
        .values(
          Object.values(BOOKING_STRATEGY).map((strategy) => ({
            venueId: SEED.VENUE_IDS.HALL,
            name: `Your sandbox (${strategy.toLowerCase().replaceAll('_', ' ')})`,
            startsAt: STARTS_AT,
            strategy,
            ownerId: userId,
            sandboxUserId: userId,
          }))
        )
        .returning({ id: events.id });
      await tx
        .insert(seats)
        .values(
          created.flatMap(({ id }) => layoutSeats(HALL).map((seat) => ({ ...seat, eventId: id })))
        );
    });
  }

  /** Keycloak first: if the database part fails afterwards, the row stays and the next run retries. */
  private async deleteUser(userId: string, now: Date): Promise<void> {
    await this.keycloak.deleteUser(userId);
    const freed = await this.db.transaction(async (tx) => {
      // A demo customer may have booked seats of public events too; those go with the user. Seats
      // of the user's own sandbox events need no notice: only the user ever looked at them.
      const occupied = await tx
        .select({ eventId: bookings.eventId, seatId: bookings.seatId })
        .from(bookings)
        .innerJoin(events, eq(events.id, bookings.eventId))
        .where(
          and(
            eq(bookings.userId, userId),
            isNull(events.sandboxUserId),
            inArray(bookings.status, [...ACTIVE_BOOKING_STATUSES])
          )
        );
      await tx.delete(bookings).where(eq(bookings.userId, userId));
      await tx.delete(events).where(eq(events.sandboxUserId, userId));
      await tx.delete(demoUsers).where(eq(demoUsers.userId, userId));
      return occupied;
    });
    // After the commit, so a viewer who reacts to the message by reading sees the freed seat.
    for (const seat of freed) {
      await publishSeatChange(
        this.options.seatChanges,
        { ...seat, status: SEAT_STATUS.AVAILABLE, at: now.toISOString() },
        this.logger,
        `demo user ${userId}`
      );
    }
  }
}
