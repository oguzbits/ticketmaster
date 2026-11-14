import { check, fail } from 'k6';
import http from 'k6/http';
import { Counter } from 'k6/metrics';

export const BASE_URL = __ENV.BASE_URL;

// Copies of dictionaries of packages/shared (k6 runs plain JS in its own runtime and cannot import them).
// BOOKING_STRATEGY
export const STRATEGY = {
  NAIVE: 'NAIVE',
  PESSIMISTIC: 'PESSIMISTIC',
  OPTIMISTIC: 'OPTIMISTIC',
  REDIS_LOCK: 'REDIS_LOCK',
};
// SEAT_STATUS.AVAILABLE
export const SEAT_AVAILABLE = 'AVAILABLE';
// IDEMPOTENCY_KEY_HEADER
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

const LOGIN_BATCH = 10;
// ROLE.CUSTOMER in packages/shared: every scenario acts as customers.
const LOGIN_BODY = JSON.stringify({ role: 'customer' });

/** Counts every 429: a run that gets one measured the rate limiter, not the system. */
const rateLimited = new Counter('rate_limited');
export const NO_RATE_LIMIT = { rate_limited: ['count==0'] };

export const BASE_OPTIONS = { summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'] };

/** Request parameters with the `name` tag, so the URLs of one route count as one metric. */
export function tagged(name, headers = {}) {
  return { headers: { 'content-type': 'application/json', ...headers }, tags: { name } };
}

/** Request parameters with the bearer token. */
export function auth(token, name) {
  return tagged(name, { authorization: `Bearer ${token}` });
}

/** Passes when the status is one of `statuses`; a 429 additionally counts as rate limited. */
export function ok(res, ...statuses) {
  if (res.status === 429) rateLimited.add(1);
  return check(res, { [`status ${statuses.join(' or ')}`]: (r) => statuses.includes(r.status) });
}

/** The access tokens of `count` new customers (`POST /api/demo-login`), logged in in parallel batches. */
export function loginCustomers(count) {
  const tokens = [];
  while (tokens.length < count) {
    const size = Math.min(LOGIN_BATCH, count - tokens.length);
    const request = ['POST', `${BASE_URL}/api/demo-login`, LOGIN_BODY, tagged('login')];
    for (const res of http.batch(Array.from({ length: size }, () => request))) {
      if (!ok(res, 200)) fail(`demo login answered ${res.status}: ${res.body}`);
      tokens.push(res.json('accessToken'));
    }
  }
  return tokens;
}

/** The first public event the predicate accepts; no event ID is hard-coded. */
export function findEvent(predicate) {
  const res = http.get(`${BASE_URL}/api/events`, tagged('events'));
  if (!ok(res, 200)) fail(`event list answered ${res.status}`);
  const event = res.json().find(predicate);
  if (event === undefined) fail('no event matches the predicate');
  return event;
}

/** The event detail: its seats with their status. */
export function eventDetail(id) {
  const res = http.get(`${BASE_URL}/api/events/${id}`, tagged('event'));
  if (!ok(res, 200)) fail(`event detail answered ${res.status}`);
  return res.json();
}

/** A public event of the strategy without a waiting room. */
export function findOpenEvent(strategy) {
  return findEvent((event) => event.strategy === strategy && event.waitingRoomCapacity === null);
}
