import exec from 'k6/execution';
import http from 'k6/http';

import { BASE_OPTIONS, BASE_URL, findEvent, NO_RATE_LIMIT, ok, tagged } from './lib.js';

// 200 requests per second for a minute, alternating list and detail, anonymous like a visitor.
export const options = {
  ...BASE_OPTIONS,
  scenarios: {
    browse: {
      executor: 'constant-arrival-rate',
      rate: 200,
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 50,
      maxVUs: 400,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
    ...NO_RATE_LIMIT,
  },
};

export function setup() {
  return { eventId: findEvent(() => true).id };
}

export default function ({ eventId }) {
  const list = exec.scenario.iterationInTest % 2 === 0;
  const res = list
    ? http.get(`${BASE_URL}/api/events`, tagged('events'))
    : http.get(`${BASE_URL}/api/events/${eventId}`, tagged('event'));
  ok(res, 200);
}
