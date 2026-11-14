import { METRIC, METRIC_ATTR } from '@app/api/metrics';
import { dataPoints, startTestMetrics } from '@app/api/metrics/testing';
import { QUEUE_NAME, type QueueName } from '@app/shared';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { OperationalGauges } from './operational-gauges.js';

const SECRET = 'redis://user:secret@host';
const SHORT_TIMEOUT_MS = 20;

class RedisDown extends Error {
  override name = 'RedisDown';
}

/** Each port answers with what the spec set; a function runs per call, so it can fail on demand. */
interface Answers {
  age: () => Promise<number | null>;
  depth: (queue: QueueName) => Promise<number>;
  waiting: () => Promise<number>;
}

describe('OperationalGauges', () => {
  let started: ReturnType<typeof startTestMetrics>;
  let answers: Answers;
  let warned: MockInstance<Logger['warn']>;

  beforeEach(() => {
    started = startTestMetrics();
    warned = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    answers = {
      age: () => Promise.resolve(42.5),
      depth: (queue) => Promise.resolve(queue === QUEUE_NAME.BOOKING_EVENTS ? 3 : 7),
      waiting: () => Promise.resolve(11),
    };
    const gauges = new OperationalGauges(
      { oldestUnpublishedAgeSeconds: () => answers.age() },
      { depth: (queue) => answers.depth(queue) },
      { waitingTotal: () => answers.waiting() }
    );
    gauges.timeoutMs = SHORT_TIMEOUT_MS;
    gauges.onModuleInit();
  });
  afterEach(async () => {
    await started.shutdown();
    vi.restoreAllMocks();
  });

  const observed = async (name: string) =>
    dataPoints(await started.collect(), name).map((point) => ({
      queue: point.attributes[METRIC_ATTR.QUEUE],
      value: point.value,
    }));

  it('reports what the ports report', async () => {
    expect(await observed(METRIC.OUTBOX_OLDEST_AGE)).toEqual([{ queue: undefined, value: 42.5 }]);
    expect(await observed(METRIC.WAITING_ROOM_WAITING)).toEqual([{ queue: undefined, value: 11 }]);
    expect(await observed(METRIC.QUEUE_DEPTH)).toEqual(
      expect.arrayContaining([
        { queue: QUEUE_NAME.BOOKING_EVENTS, value: 3 },
        { queue: QUEUE_NAME.BOOKING_EVENTS_DLQ, value: 7 },
      ])
    );
  });

  it('reports 0 when no outbox row waits', async () => {
    answers.age = () => Promise.resolve(null);

    expect(await observed(METRIC.OUTBOX_OLDEST_AGE)).toEqual([{ queue: undefined, value: 0 }]);
  });

  it.each([
    ['the outbox age', METRIC.OUTBOX_OLDEST_AGE, 'age'],
    ['the waiting room', METRIC.WAITING_ROOM_WAITING, 'waiting'],
  ] as const)(
    'omits %s when its port fails, logs the error name only, and the other gauges still report',
    async (_label, failing, port) => {
      expect(await observed(failing)).toHaveLength(1);
      answers[port] = () => Promise.reject(new RedisDown(SECRET));

      expect(await observed(failing)).toEqual([]);
      // Not the stale value of the scrape before, and the others are not affected.
      expect(await observed(METRIC.QUEUE_DEPTH)).toHaveLength(2);
      const lines = warned.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes('RedisDown'))).toBe(true);
      expect(lines.filter((line) => line.includes(SECRET))).toEqual([]);
    }
  );

  it('omits only the queue that fails', async () => {
    answers.depth = (queue) =>
      queue === QUEUE_NAME.BOOKING_EVENTS_DLQ
        ? Promise.reject(new RedisDown(SECRET))
        : Promise.resolve(3);

    expect(await observed(METRIC.QUEUE_DEPTH)).toEqual([
      { queue: QUEUE_NAME.BOOKING_EVENTS, value: 3 },
    ]);
  });

  it('does not wait for a port that never answers: no observation, the timeout is logged', async () => {
    answers.waiting = () => new Promise<number>(() => undefined);

    expect(await observed(METRIC.WAITING_ROOM_WAITING)).toEqual([]);
    expect(warned.mock.calls.map((call) => String(call[0])).join()).toContain('GaugeTimeoutError');
    expect(await observed(METRIC.OUTBOX_OLDEST_AGE)).toHaveLength(1);
  });
});
