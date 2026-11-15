import http from 'k6/http';

import {
  auth,
  BASE_OPTIONS,
  BASE_URL,
  eventDetail,
  findOpenEvent,
  IDEMPOTENCY_KEY_HEADER,
  loginCustomers,
  NO_RATE_LIMIT,
  ok,
  SEAT_AVAILABLE,
  STRATEGY,
} from './lib.js';

const CUSTOMERS = 40;
const ITERATIONS = 4;
const HOLD_ATTEMPTS = 5;

// A 409 on a seat another customer took first is expected, not a failure. 429 stays a failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 409));

// Each of 40 customers books four seats of the PESSIMISTIC event: a fresh seat list, a hold on a
// random free seat (another seat after a 409) and the payment. Paid seats stay sold, so a fresh
// database (docs/load-tests.md) gives the same run again.
export const options = {
  ...BASE_OPTIONS,
  setupTimeout: '5m',
  scenarios: {
    flow: {
      executor: 'per-vu-iterations',
      vus: CUSTOMERS,
      iterations: ITERATIONS,
      maxDuration: '3m',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:hold}': ['p(95)<500'],
    'http_req_duration{name:pay}': ['p(95)<1000'],
    ...NO_RATE_LIMIT,
  },
};

export function setup() {
  return { tokens: loginCustomers(CUSTOMERS), eventId: findOpenEvent(STRATEGY.PESSIMISTIC).id };
}

function hold(token, eventId) {
  for (let attempt = 0; attempt < HOLD_ATTEMPTS; attempt++) {
    const free = eventDetail(eventId).seats.filter((seat) => seat.status === SEAT_AVAILABLE);
    if (free.length === 0)
      throw new Error('the event has no free seat left, start from a fresh database');
    const seatId = free[Math.floor(Math.random() * free.length)].id;
    const res = http.post(
      `${BASE_URL}/api/bookings`,
      JSON.stringify({ eventId, seatId }),
      auth(token, 'hold')
    );
    if (ok(res, 201, 409) && res.status === 201) return res.json('id');
  }
  return null;
}

export default function ({ tokens, eventId }) {
  const token = tokens[__VU - 1];
  const bookingId = hold(token, eventId);
  if (bookingId === null) return;
  const params = auth(token, 'pay');
  params.headers[IDEMPOTENCY_KEY_HEADER] = crypto.randomUUID();
  ok(http.post(`${BASE_URL}/api/bookings/${bookingId}/payment`, null, params), 200);
}
