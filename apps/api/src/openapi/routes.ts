/**
 * The route table of the OpenAPI document: what the shared schemas cannot say (method, path, roles,
 * status codes). `openapi.spec.ts` compares it with the Nest controllers, so a route that is added,
 * removed or re-protected without the table fails a test. `build.ts` turns it into
 * `docs/api/openapi.json` (`pnpm docs:generate`).
 * Node runs this file directly (type stripping, see `scripts/docs/generate.mjs`): it imports only
 * packages, no relative file, and no non-erasable syntax.
 */

import * as shared from '@app/shared';

const { ROLE, SEAT_STREAM_EVENT } = shared;

/** Marks a route that needs no token (a token that is sent is still verified). */
export const PUBLIC = 'public';

/** Every schema the document names, by its component name. */
export const SCHEMAS = {
  Booking: shared.BookingSchema,
  BookingList: shared.BookingListResponseSchema,
  CreateEventRequest: shared.CreateEventRequestSchema,
  DemoLoginRequest: shared.DemoLoginRequestSchema,
  EventDetail: shared.EventDetailSchema,
  EventList: shared.EventListResponseSchema,
  EventSummary: shared.EventSummarySchema,
  HealthResponse: shared.HealthResponseSchema,
  HoldRequest: shared.HoldRequestSchema,
  IdempotencyKey: shared.IdempotencyKeySchema,
  OrganizerEventList: shared.OrganizerEventListResponseSchema,
  RefreshRequest: shared.RefreshRequestSchema,
  SeatChange: shared.SeatChangeSchema,
  SeatSnapshot: shared.SeatSnapshotSchema,
  SetStrategyRequest: shared.SetStrategyRequestSchema,
  SetWaitingRoomRequest: shared.SetWaitingRoomRequestSchema,
  SimulationList: shared.SimulationListResponseSchema,
  SimulationProgress: shared.SimulationProgressSchema,
  SimulationRun: shared.SimulationRunSchema,
  StartSimulationRequest: shared.StartSimulationRequestSchema,
  TokenResponse: shared.TokenResponseSchema,
  VenueList: shared.VenueListResponseSchema,
  WaitingRoomStatus: shared.WaitingRoomStatusSchema,
} as const;

export type SchemaName = keyof typeof SCHEMAS;
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;
export type ErrorDoc = string | { description: string; schema: SchemaName };

export interface RouteDoc {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** The URL as a client sends it (global prefix included), parameters as `{name}`. */
  path: string;
  summary: string;
  access: typeof PUBLIC | readonly shared.Role[];
  /** A public route that also reads the token, to show the caller's own sandbox events. */
  optionalToken?: true;
  body?: SchemaName;
  idempotencyKey?: true;
  success: {
    status: 200 | 201 | 204;
    description: string;
    schema?: SchemaName;
    /** Server-sent events: event name (`message` when unnamed) and the schema of its data. */
    stream?: Record<string, SchemaName>;
  };
  /** Statuses beyond the derived ones; an entry replaces the derived text of the same status. */
  errors?: Partial<Record<ErrorStatus, ErrorDoc>>;
}

const SANDBOX_404 = 'Unknown event, or another user’s sandbox event.';
const FOREIGN_BOOKING = 'The booking belongs to another user.';

/** Keyed by `<controller class>.<handler>`, which is how the spec pairs it with the code. */
export const ROUTES: Record<string, RouteDoc> = {
  'HealthController.live': {
    method: 'get',
    path: '/health/live',
    summary: 'Liveness probe',
    access: PUBLIC,
    success: { status: 200, description: 'The process serves requests.', schema: 'HealthResponse' },
  },
  'HealthController.ready': {
    method: 'get',
    path: '/health/ready',
    summary: 'Readiness probe',
    access: PUBLIC,
    success: { status: 200, description: 'Postgres and Redis answer.', schema: 'HealthResponse' },
    errors: {
      503: { description: 'Postgres or Redis does not answer.', schema: 'HealthResponse' },
    },
  },
  'EventsController.list': {
    method: 'get',
    path: '/api/events',
    summary: 'List public events and the caller’s own sandbox events',
    access: PUBLIC,
    optionalToken: true,
    success: { status: 200, description: 'Ordered by `startsAt`.', schema: 'EventList' },
  },
  'EventsController.detail': {
    method: 'get',
    path: '/api/events/{id}',
    summary: 'Read an event with its seats and their derived status',
    access: PUBLIC,
    optionalToken: true,
    success: { status: 200, description: 'The event.', schema: 'EventDetail' },
    errors: { 404: SANDBOX_404 },
  },
  'SeatStreamController.stream': {
    method: 'get',
    path: '/api/events/{id}/seats/stream',
    summary: 'Stream the seat statuses of an event',
    access: PUBLIC,
    optionalToken: true,
    success: {
      status: 200,
      description:
        'Server-sent events: one `snapshot`, then one `change` per seat change; a `: heartbeat` comment every 15 s. The stream ends after 10 minutes, the client reconnects.',
      stream: {
        [SEAT_STREAM_EVENT.SNAPSHOT]: 'SeatSnapshot',
        [SEAT_STREAM_EVENT.CHANGE]: 'SeatChange',
      },
    },
    errors: {
      404: `${SANDBOX_404} Answered as JSON before the stream starts.`,
      429: 'Rate limit exceeded, or 10 streams are already open for the client address.',
      503: 'More than 500 streams are open in this process.',
    },
  },
  'EventsController.setStrategy': {
    method: 'patch',
    path: '/api/events/{id}/strategy',
    summary: 'Switch the booking strategy of an event',
    access: [ROLE.ADMIN],
    body: 'SetStrategyRequest',
    success: {
      status: 200,
      description: 'The event with its new strategy.',
      schema: 'EventSummary',
    },
    errors: {
      404: 'Unknown event. A demo admin may switch only their own sandbox events, a regular admin only public events; any other event is 404.',
    },
  },
  'BookingsController.hold': {
    method: 'post',
    path: '/api/bookings',
    summary: 'Hold a seat',
    access: [ROLE.CUSTOMER],
    body: 'HoldRequest',
    success: { status: 201, description: 'The new booking, HELD.', schema: 'Booking' },
    errors: {
      404: 'The seat is not in the event, or the event is another user’s sandbox event.',
      409: 'The seat is not available.',
    },
  },
  'BookingsController.pay': {
    method: 'post',
    path: '/api/bookings/{id}/payment',
    summary: 'Pay a held booking',
    access: [ROLE.CUSTOMER],
    idempotencyKey: true,
    success: {
      status: 200,
      description:
        'CONFIRMED, or CANCELLED when the payment fails. The same key on the same booking returns the first answer without a second charge.',
      schema: 'Booking',
    },
    errors: {
      403: FOREIGN_BOOKING,
      404: 'Unknown booking.',
      409: 'The hold expired, the booking cannot be paid, or the key was used for another booking.',
    },
  },
  'BookingsController.cancel': {
    method: 'post',
    path: '/api/bookings/{id}/cancel',
    summary: 'Cancel a held or confirmed booking',
    access: [ROLE.CUSTOMER],
    success: { status: 200, description: 'The booking, CANCELLED.', schema: 'Booking' },
    errors: {
      403: FOREIGN_BOOKING,
      404: 'Unknown booking.',
      409: 'The booking is neither HELD nor CONFIRMED.',
    },
  },
  'BookingsController.list': {
    method: 'get',
    path: '/api/bookings',
    summary: 'List the caller’s own bookings',
    access: [ROLE.CUSTOMER],
    success: {
      status: 200,
      description: 'Newest first, each with its stored transitions newest first.',
      schema: 'BookingList',
    },
  },
  'TicketsController.download': {
    method: 'get',
    path: '/api/bookings/{id}/ticket',
    summary: 'Download the ticket of a confirmed booking',
    access: [ROLE.CUSTOMER],
    success: {
      status: 200,
      description:
        'The ticket as `application/pdf`, an attachment named `ticket-<id>.pdf`. Not JSON: the response has no schema.',
    },
    errors: {
      403: FOREIGN_BOOKING,
      404: 'Unknown booking, a ticket the worker has not stored yet (`ticketReady` is false), or a booking that is no longer CONFIRMED.',
    },
  },
  'OrganizerController.venues': {
    method: 'get',
    path: '/api/venues',
    summary: 'List the venue templates',
    access: [ROLE.ORGANIZER],
    success: { status: 200, description: 'Ordered by name.', schema: 'VenueList' },
  },
  'OrganizerController.ownEvents': {
    method: 'get',
    path: '/api/organizer/events',
    summary: 'List the events the caller owns, with sales numbers',
    access: [ROLE.ORGANIZER],
    success: { status: 200, description: 'Ordered by `startsAt`.', schema: 'OrganizerEventList' },
  },
  'OrganizerController.create': {
    method: 'post',
    path: '/api/events',
    summary: 'Create an event on a venue',
    access: [ROLE.ORGANIZER],
    body: 'CreateEventRequest',
    success: { status: 201, description: 'The new event.', schema: 'EventSummary' },
    errors: {
      400: 'A malformed body, or a `startsAt` that is not in the future.',
      404: 'Unknown venue.',
      409: 'The owner already has 20 events.',
      429: 'Rate limit exceeded (`CREATE_EVENT`).',
    },
  },
  'SimulationsController.start': {
    method: 'post',
    path: '/api/simulations',
    summary: 'Start a rush simulation',
    access: [ROLE.ADMIN],
    body: 'StartSimulationRequest',
    success: { status: 201, description: 'The run, QUEUED.', schema: 'SimulationRun' },
    errors: {
      429: 'Rate limit exceeded (`SIMULATION`), or two runs are active (then without `Retry-After`).',
    },
  },
  'SimulationsController.list': {
    method: 'get',
    path: '/api/simulations',
    summary: 'List the latest finished runs',
    access: [ROLE.ADMIN],
    success: {
      status: 200,
      description: 'The 20 latest FINISHED runs of the last hour, newest first.',
      schema: 'SimulationList',
    },
  },
  'SimulationsController.get': {
    method: 'get',
    path: '/api/simulations/{id}',
    summary: 'Read a run',
    access: PUBLIC,
    success: { status: 200, description: 'The run.', schema: 'SimulationRun' },
    errors: { 404: 'Unknown run.' },
  },
  'SimulationsController.stream': {
    method: 'get',
    path: '/api/simulations/{id}/stream',
    summary: 'Stream the progress of a run',
    access: PUBLIC,
    success: {
      status: 200,
      description:
        'Server-sent events: the progress at the start and whenever it changes; the stream completes after FINISHED or FAILED, or after 10 minutes.',
      stream: { message: 'SimulationProgress' },
    },
    errors: {
      404: 'Unknown run. Answered as JSON before the stream starts.',
      503: 'More than 50 streams are open in this process.',
    },
  },
  'DemoController.login': {
    method: 'post',
    path: '/api/demo-login',
    summary: 'Create a temporary demo user and sign in',
    access: PUBLIC,
    body: 'DemoLoginRequest',
    success: { status: 200, description: 'The tokens of the new user.', schema: 'TokenResponse' },
    errors: {
      429: 'Rate limit exceeded (`DEMO_LOGIN`).',
      503: 'The demo is full (200 demo users, nothing is created), or Keycloak does not answer within 5 s.',
    },
  },
  'DemoController.refresh': {
    method: 'post',
    path: '/api/auth/refresh',
    summary: 'Exchange a refresh token for new tokens',
    access: PUBLIC,
    body: 'RefreshRequest',
    success: {
      status: 200,
      description: 'A new access and refresh token.',
      schema: 'TokenResponse',
    },
    errors: {
      401: 'Keycloak rejects the refresh token (`invalid_grant`).',
      429: 'Rate limit exceeded (`REFRESH`).',
      500: 'Keycloak answered in an unexpected way, for example a wrong client secret.',
      503: 'Keycloak fails (5xx) or does not answer within 5 s.',
    },
  },
};
