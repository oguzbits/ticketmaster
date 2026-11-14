/** OpenTelemetry instrument names; the Prometheus exporter turns the dots into underscores. */
export const METRIC = {
  HTTP_SERVER_DURATION: 'http.server.request.duration',
  HOLDS: 'tm.holds',
  BOOKINGS_SETTLED: 'tm.bookings.settled',
  QUEUE_EFFECTS: 'tm.queue.effects',
  DB_QUERIES_ACTIVE: 'tm.db.queries.active',
  OUTBOX_OLDEST_AGE: 'tm.outbox.oldest_age',
  QUEUE_DEPTH: 'tm.queue.depth',
  WAITING_ROOM_WAITING: 'tm.waiting_room.waiting',
} as const;

/** Label keys of the `tm.*` instruments; their values come from the domain dictionaries. */
export const METRIC_ATTR = {
  STRATEGY: 'strategy',
  OUTCOME: 'outcome',
  STATUS: 'status',
  QUEUE: 'queue',
  EFFECT: 'effect',
} as const;

/** Label keys the HTTP instrumentation writes on the request histogram (stable semconv names). */
export const HTTP_ATTR = {
  METHOD: 'http.request.method',
  ROUTE: 'http.route',
  STATUS: 'http.response.status_code',
} as const;

/** The route label of a request no route matched: one series instead of one per URL. */
export const ROUTE_UNMATCHED = 'UNMATCHED';
