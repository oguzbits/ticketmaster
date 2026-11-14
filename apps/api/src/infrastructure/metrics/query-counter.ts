import { tracingChannel } from 'node:diagnostics_channel';

import type { Meter } from '@opentelemetry/api';

import { METRIC } from './names.js';

/**
 * Counts the postgres.js queries that are in flight: +1 when one starts, -1 when it ends or fails
 * (one of both events ends it, the set keeps a query from being taken off twice). It reads no
 * payload field, so a statement or parameter never gets near a metric. Returns the unsubscribe.
 */
export function subscribeQueryCounter(meter: Meter): () => void {
  const active = meter.createUpDownCounter(METRIC.DB_QUERIES_ACTIVE, {
    description: 'Database queries in flight',
  });
  const open = new WeakSet<object>();
  const end = (message: object) => {
    if (open.delete(message)) active.add(-1);
  };
  const handlers = {
    start(message: object) {
      open.add(message);
      active.add(1);
    },
    error: end,
    asyncEnd: end,
  };
  const channel = tracingChannel('postgres:query');
  channel.subscribe(handlers);
  return () => channel.unsubscribe(handlers);
}
