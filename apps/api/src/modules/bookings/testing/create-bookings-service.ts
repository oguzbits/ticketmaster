import { loadEnv } from '../../../config/config.module.js';
import type { Clock } from '../../../core/clock.js';
import type { Database } from '../../../infrastructure/database/database.module.js';
import type { Redis } from '../../../infrastructure/redis/redis.module.js';
import { FakePaymentProvider } from '../adapters/fake-payment.provider.js';
import { RedisSeatChangePublisher } from '../adapters/redis-seat-changes.js';
import { SeatReservations } from '../adapters/seat-reservations.js';
import { BookingsService } from '../bookings.service.js';
import type { PaymentProvider } from '../domain/payment-provider.js';
import type { SeatChangePublisher } from '../domain/seat-change.js';

/** Specs that never pay get a provider that always succeeds. */
const ALWAYS_SUCCEEDS = new FakePaymentProvider(0, () => 1);

export function createBookingsService(
  db: Database,
  redis: Redis,
  clock: Clock,
  payments: PaymentProvider = ALWAYS_SUCCEEDS,
  publisher: SeatChangePublisher = new RedisSeatChangePublisher(redis)
): BookingsService {
  const reservations = new SeatReservations(db, redis, clock, loadEnv().HOLD_TTL_SECONDS);
  return new BookingsService(db, reservations, clock, { payments, seatChanges: publisher });
}
