import { check } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

import {
  auth,
  BASE_OPTIONS,
  BASE_URL,
  eventDetail,
  findOpenEvent,
  loginCustomers,
  NO_RATE_LIMIT,
  ok,
  SEAT_AVAILABLE,
  STRATEGY,
} from './lib.js';

const CUSTOMERS = 50;
const SEATS = 10;
const STRATEGIES = Object.values(STRATEGY);
const SCENARIO_GAP_SECONDS = 20;

// A hold request of the same seat that comes back 201 although another one did too is a double booking.
const doubleBookings = new Counter('double_bookings');

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 409));

// One scenario per strategy, one after the other. In each, one iteration fires the holds of all 50
// customers on the same seat in one batch (so they arrive together) and counts the extra 201s;
// ten iterations, ten seats. NAIVE has no threshold: it is the comparison.
export const options = {
  ...BASE_OPTIONS,
  setupTimeout: '5m',
  batch: CUSTOMERS,
  batchPerHost: CUSTOMERS,
  scenarios: Object.fromEntries(
    STRATEGIES.map((strategy, index) => [
      strategy,
      {
        executor: 'per-vu-iterations',
        vus: 1,
        iterations: SEATS,
        startTime: `${index * SCENARIO_GAP_SECONDS}s`,
        maxDuration: `${SCENARIO_GAP_SECONDS}s`,
        env: { STRATEGY: strategy },
      },
    ])
  ),
  thresholds: {
    http_req_failed: ['rate<0.01'],
    ...Object.fromEntries(
      STRATEGIES.filter((strategy) => strategy !== STRATEGY.NAIVE).map((strategy) => [
        `double_bookings{strategy:${strategy}}`,
        ['count==0'],
      ])
    ),
    ...NO_RATE_LIMIT,
  },
};

export function setup() {
  const events = Object.fromEntries(
    STRATEGIES.map((strategy) => {
      const { id } = findOpenEvent(strategy);
      const free = eventDetail(id).seats.filter((seat) => seat.status === SEAT_AVAILABLE);
      if (free.length < SEATS)
        throw new Error(`${strategy} has too few free seats, start from a fresh database`);
      return [strategy, { id, seatIds: free.slice(0, SEATS).map((seat) => seat.id) }];
    })
  );
  return { tokens: loginCustomers(CUSTOMERS), events };
}

export default function ({ tokens, events }) {
  const strategy = __ENV.STRATEGY;
  const { id: eventId, seatIds } = events[strategy];
  const body = JSON.stringify({ eventId, seatIds: [seatIds[exec.scenario.iterationInTest]] });
  const responses = http.batch(
    tokens.map((token) => ['POST', `${BASE_URL}/api/bookings`, body, auth(token, 'hold')])
  );
  responses.forEach((res) => ok(res, 201, 409));
  const placed = responses.filter((res) => res.status === 201).length;
  // No hold at all means the seat was taken before the run, not that the strategy held.
  check(placed, { 'the seat was free before the rush': (count) => count > 0 });
  doubleBookings.add(Math.max(placed - 1, 0), { strategy });
}
