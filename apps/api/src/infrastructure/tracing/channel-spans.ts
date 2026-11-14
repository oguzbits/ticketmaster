import { tracingChannel } from 'node:diagnostics_channel';

import {
  type Attributes,
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { z } from 'zod';

import { DB_SYSTEM, SPAN_ATTR, SPAN_NAME, TRACER_NAME } from './span.js';

/**
 * postgres.js (`tracing:postgres:query:*`) and node-redis (`tracing:node-redis:command:*`) publish
 * Node tracing channels; nothing is published while nobody subscribes. The payloads are parsed
 * with the few fields read: never `parameters` (the values) nor `args` (keys), see ADR 0007.
 */
const QueryPayload = z.object({ query: z.string() });
const CommandPayload = z.object({ command: z.string() });
const ErrorPayload = z.object({ error: z.instanceof(Error) });

interface ClientSpan {
  name: string;
  attributes: Attributes;
}

function subscribeChannel<T>(
  channelName: string,
  schema: z.ZodType<T>,
  toSpan: (payload: T) => ClientSpan
): () => void {
  const channel = tracingChannel(channelName);
  // The driver passes one context object through every event of a call.
  const open = new WeakMap<object, Span>();
  const close = (message: object): Span | undefined => {
    const span = open.get(message);
    open.delete(message);
    return span;
  };
  const handlers = {
    start(message: object) {
      // A background loop (queue polling, scheduled jobs) has no active span: no one-span traces.
      if (!trace.getActiveSpan()) return;
      const payload = schema.safeParse(message);
      if (!payload.success) return;
      const { name, attributes } = toSpan(payload.data);
      const span = trace
        .getTracer(TRACER_NAME)
        .startSpan(name, { kind: SpanKind.CLIENT, attributes }, context.active());
      open.set(message, span);
    },
    error(message: object) {
      const failure = ErrorPayload.safeParse(message);
      const span = close(message);
      if (!span) return;
      // The class name only: a driver message may hold a key, a value or a statement fragment.
      if (failure.success) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: failure.data.error.constructor.name,
        });
      }
      span.end();
    },
    asyncEnd(message: object) {
      close(message)?.end();
    },
  };
  channel.subscribe(handlers);
  return () => channel.unsubscribe(handlers);
}

/** Turns the driver channel events into spans below the active span; returns the unsubscribe. */
export function subscribeDriverSpans(): () => void {
  const unsubscribeQueries = subscribeChannel('postgres:query', QueryPayload, ({ query }) => ({
    name: SPAN_NAME.DB_QUERY,
    attributes: {
      [SPAN_ATTR.DB_SYSTEM]: DB_SYSTEM.POSTGRESQL,
      [SPAN_ATTR.DB_STATEMENT]: query,
    },
  }));
  const unsubscribeCommands = subscribeChannel(
    'node-redis:command',
    CommandPayload,
    ({ command }) => ({
      name: SPAN_NAME.REDIS_COMMAND,
      attributes: {
        [SPAN_ATTR.DB_SYSTEM]: DB_SYSTEM.REDIS,
        [SPAN_ATTR.DB_OPERATION]: command,
      },
    })
  );
  return () => {
    unsubscribeQueries();
    unsubscribeCommands();
  };
}
