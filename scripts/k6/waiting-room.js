import { sleep } from 'k6';
import http from 'k6/http';

import {
  auth,
  BASE_OPTIONS,
  BASE_URL,
  findEvent,
  loginCustomers,
  NO_RATE_LIMIT,
  ok,
} from './lib.js';

const CUSTOMERS = 100;
const POLLS = 20;

// 100 customers join the queue of the event with a waiting room, poll their place once a second
// for 20 s and leave.
export const options = {
  ...BASE_OPTIONS,
  setupTimeout: '5m',
  scenarios: {
    queue: { executor: 'per-vu-iterations', vus: CUSTOMERS, iterations: 1, maxDuration: '2m' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{name:join}': ['p(95)<300'],
    'http_req_duration{name:poll}': ['p(95)<300'],
    ...NO_RATE_LIMIT,
  },
};

export function setup() {
  const event = findEvent((candidate) => candidate.waitingRoomCapacity !== null);
  return { tokens: loginCustomers(CUSTOMERS), eventId: event.id };
}

export default function ({ tokens, eventId }) {
  const token = tokens[__VU - 1];
  const url = `${BASE_URL}/api/events/${eventId}/waiting-room`;
  ok(http.post(url, null, auth(token, 'join')), 200);
  for (let poll = 0; poll < POLLS; poll++) {
    sleep(1);
    ok(http.get(url, auth(token, 'poll')), 200);
  }
  ok(http.del(url, null, auth(token, 'leave')), 204);
}
