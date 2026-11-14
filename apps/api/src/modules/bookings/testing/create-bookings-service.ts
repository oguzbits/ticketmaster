import { loadEnv } from '../../../config/config.module.js';
import type { Clock } from '../../../core/clock.js';
import type { Database } from '../../../infrastructure/database/database.module.js';
import type { Redis } from '../../../infrastructure/redis/redis.module.js';
import { OutboxService } from '../../outbox/index.js';
import { FakeMessageQueue } from '../../outbox/testing/index.js';
import { RedisWaitingRoomStore, WaitingRoomService } from '../../waiting-room/index.js';
import { FakePaymentProvider } from '../adapters/fake-payment.provider.js';
import { RedisSeatChangePublisher } from '../adapters/redis-seat-changes.js';
import { SeatReservations } from '../adapters/seat-reservations.js';
import { BookingsService } from '../bookings.service.js';
import type { PaymentProvider } from '../domain/payment-provider.js';
import type { SeatChangePublisher } from '../domain/seat-change.js';

/** Specs that never pay get a provider that always succeeds. */
const ALWAYS_SUCCEEDS = new FakePaymentProvider(0);

export function createBookingsService(
  db: Database,
  redis: Redis,
  clock: Clock,
  payments: PaymentProvider = ALWAYS_SUCCEEDS,
  publisher: SeatChangePublisher = new RedisSeatChangePublisher(redis),
  outbox: OutboxService = new OutboxService(db, clock, new FakeMessageQueue())
): BookingsService {
  const reservations = new SeatReservations(db, redis, clock, loadEnv().HOLD_TTL_SECONDS);
  const waitingRoom = new WaitingRoomService(db, clock, new RedisWaitingRoomStore(redis));
  return new BookingsService(db, reservations, clock, {
    payments,
    seatChanges: publisher,
    outbox,
    waitingRoom,
  });
}
