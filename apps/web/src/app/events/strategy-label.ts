import { BOOKING_STRATEGY, type BookingStrategy } from '@app/shared';

const STRATEGY_LABEL: Record<BookingStrategy, string> = {
  [BOOKING_STRATEGY.NAIVE]: 'Naive, no lock',
  [BOOKING_STRATEGY.PESSIMISTIC]: 'Row lock',
  [BOOKING_STRATEGY.OPTIMISTIC]: 'Optimistic version',
  [BOOKING_STRATEGY.REDIS_LOCK]: 'Redis lock',
};

export function strategyLabel(strategy: BookingStrategy): string {
  return STRATEGY_LABEL[strategy];
}
