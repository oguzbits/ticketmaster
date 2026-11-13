# Phase 2: Async and scaling, design

Scope and Definition of Done come from [PLAN.md](../../PLAN.md#phase-2-async-and-scaling); this
document fixes the design decisions. Rules: [AGENTS.md](../../../AGENTS.md). Phase 1 design:
[phase 1 spec](2026-11-13-phase-1-core-design.md).

## Outcome

A confirmed booking reliably leads to a confirmation email and a ticket PDF, even when the worker,
the queue or the mail server is down for a while. Payment no longer runs inside a database
transaction. Two API instances run behind Caddy and share all state through Redis and PostgreSQL
(behind PgBouncer). Events in high demand put visitors into a waiting room with a live position.

Out of scope for phase 2: refunds and real payment or mail providers, SNS fan-out, OpenTelemetry
and dashboards (phase 3), threat model and container hardening (phase 4), anything that needs a
public server (phase 5).

## Decisions

| Topic           | Decision                                                                                                                                           | Rejected                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Work split      | One spec, one plan per slice (A to E), stop and report after each slice                                                                            | One plan for the phase                                               |
| Order           | Reliability first (A, B), then scaling (C), waiting room (D), infrastructure as code (E)                                                           | Scaling first: it builds on the async chain and the Redis-held state |
| Outbox          | Table `outbox_messages` written in the transaction of the state change; a relay in the worker sends to SQS and marks the row published             | Publishing from the request (dual write), Postgres `LISTEN/NOTIFY`   |
| Delivery        | At least once. The outbox row ID is the message ID and the idempotency key of every consumer                                                       | Exactly-once claims                                                  |
| Consumer dedupe | Table `processed_messages (consumer, message_id)` primary key; a database effect and its row share one transaction                                 | In-memory sets, Redis keys without expiry rules                      |
| Email and PDF   | External effects are idempotent by construction: the PDF has the fixed key `tickets/<bookingId>.pdf`; a mail may repeat after a crash (documented) | Two-phase protocols with the mail server                             |
| Ticket download | `GET /api/bookings/:id/ticket` streams the object from S3 after the ownership check                                                                | Presigned URLs (a second public port and an ownership gap)           |
| Payment         | Claim the key in transaction 1, charge outside any transaction, apply the result in transaction 2; the retry with the same key finishes the flow   | Charge inside the transaction (phase 1 shortcut)                     |
| Local AWS       | Floci for SQS and S3 after a smoke test; fallback ElasticMQ plus MinIO, recorded in an ADR                                                         | LocalStack (account and licence changes), mocks                      |
| Mail sink       | Mailpit (SMTP 1025, UI and API 8025); specs assert through its REST API                                                                            | A fake SMTP in process                                               |
| Libraries       | `@aws-sdk/client-sqs`, `@aws-sdk/client-s3`, `nodemailer`, `pdfkit`, `qrcode`; exact versions are read from the registry when the plan runs        | `pdf-lib` (unmaintained since 2022)                                  |
| Waiting room    | Redis sorted set per event, admission job in the worker, position over SSE                                                                         | A database queue, polling                                            |
| Infrastructure  | Queues, DLQ and bucket as code, applied idempotently by a Compose one-shot; the tool (OpenTofu or an SDK script) is chosen in slice E by an ADR    | Click-ops, resources created by the apps at start                    |

## Slice A: outbox, SQS, dead-letter queue, idempotent consumers

**Resources:** queue `booking-events` with redrive policy to `booking-events-dlq` (max receive
count 5), bucket `tickets`. First step of the slice is a smoke test against Floci: standard queue,
redrive to the DLQ, visibility timeout, long polling, message attributes, bucket put and get. The
image tag is read from the registry and checked with `docker manifest inspect`. If a feature is
missing, the ADR switches to the fallback.

**Tables:** `outbox_messages` (id, type, payload jsonb, created_at, published_at null, attempts,
last_error null) with a partial index on unpublished rows; `processed_messages` (consumer,
message_id, processed_at).

**Contract** in `packages/shared`: `OUTBOX_MESSAGE_TYPE` (`BOOKING_CONFIRMED`), a Zod schema per
message `{ messageId, type, bookingId, eventId, userId, occurredAt }`, no email or name in a
message (personal data stays out of queues and logs).

**Relay** (worker, scheduled): select unpublished rows `FOR UPDATE SKIP LOCKED` in batches, send
with the row ID as message attribute, mark published after the send succeeds. A crash between send
and mark sends the message again; consumers dedupe. Failed sends increment `attempts` and record
`last_error` (error name only); the readiness check reports an unpublished row older than a limit.

**Payment without a transaction around the charge:** transaction 1 locks the booking and stores the
idempotency key (status stays HELD). The provider is called with that key (the fake provider
returns the same result for the same key). Transaction 2 locks the booking again and applies PAID
then CONFIRMED or CANCELLED through the state machine and, on success, inserts the
`BOOKING_CONFIRMED` outbox row. A retry with a claimed key repeats the charge and finishes the
flow. Hold expiry skips a HELD booking whose key is claimed until the hold is
`PAYMENT_GRACE_SECONDS` past its expiry; after that it expires like any hold (no refund flow in
this phase, noted in the backlog). Concurrency test: parallel payments of one booking, two
instances of the relay, a crash between the steps.

**Consumer framework** (worker): a long-polling loop per queue, a handler per message type, parse
with the shared schema, run the handler with the dedupe row, delete the message only after
success. A message that fails five times lands in the DLQ through the redrive policy; a message
that does not parse is logged with its message ID and the handler throws, so it also ends in the
DLQ and the evidence is kept.

**Tests:** relay sends each row once per success and again after a simulated crash; consumer
handles a duplicate once; a failing handler ends in the DLQ after the max receive count (real
Floci); payment retry after each crash point; outbox row exists if and only if the booking is
CONFIRMED.

## Slice B: confirmation email and ticket PDF

Two consumers of `booking-events`, each with its own dedupe name. **Mail:** loads the booking and
the user's address (Keycloak Admin API by `sub`; demo users get an address in a reserved domain),
sends through nodemailer to Mailpit. **Ticket:** renders a PDF (event, seat, booking ID, QR code of
the booking ID) with pdfkit and qrcode and puts it at `tickets/<bookingId>.pdf`.
`GET /api/bookings/:id/ticket` (customer, owner only, 404 until the file exists) streams it; the
booking list gets a `ticketReady` flag; the web app shows a download link with the four UI states
and a "being prepared" state. Cancelling a CONFIRMED booking does not delete the PDF (the ticket
route answers 404 for a cancelled booking).

**Tests:** mail arrives in Mailpit once for a duplicate message; PDF is created once and is a valid
PDF with the booking ID; the ticket route answers 403 for a foreign booking, 404 before the file
exists and for a cancelled booking; end to end: pay, mail in Mailpit, download works.

## Slice C: several API instances, PgBouncer

Compose runs two `api` replicas behind Caddy (round robin, health-checked). PgBouncer in
transaction mode sits between API, worker and PostgreSQL; the driver runs without prepared
statements, `pg_advisory_xact_lock` and `FOR UPDATE` stay inside transactions (checked by the
existing concurrency specs run through PgBouncer). State held in a process moves to Redis: the
seat-stream and simulation-stream caps (counters with expiry). Rate limits and seat fan-out
already use Redis. **Tests:** the concurrency suite and the double-booking test run through
PgBouncer; a hold through instance A reaches a viewer connected to instance B (end to end, two
instances addressed directly); the per-address stream cap holds across two instances; killing one
instance keeps the app answering.

## Slice D: virtual waiting room

`events.waiting_room_enabled` and `events.admission_capacity` (organizer or admin sets them). For
such an event, `POST /api/events/:id/waiting-room` (customer) puts the caller in the Redis sorted
set (score: join time from the `Clock`) and returns the position; `GET .../waiting-room/stream`
(SSE) pushes position changes. A worker job admits the next batch when fewer than the capacity are
admitted; an admission is a Redis key with a TTL. The hold route for such an event requires the
caller's admission (403 otherwise). The admission policy (who is next, how many) is pure domain
code with an injected clock. **Tests:** order is first come first served; a batch never exceeds the
capacity; an expired admission frees a slot; a hold without admission answers 403; a user cannot
join twice; two API instances show the same positions.

## Slice E: infrastructure as code

The queue, the DLQ, the redrive policy and the bucket are declared in one place and applied
idempotently by a one-shot Compose service that the apps wait for (replacing any resource creation
done by hand in slice A). The ADR compares OpenTofu against an SDK script run by the one-shot and
picks the smaller one that Floci supports. **Tests:** applying twice changes nothing; a missing
queue is recreated.

## Execution

Each slice gets its own plan under `docs/superpowers/plans/`, executed with `umsetzer` subagents;
review only for state, concurrency, auth and data-loss tasks (A, C, D), one final review per slice
with the strongest model. Docs change with the code (README, `docs/data-model.md`, `docs/api/`,
runbook stubs where an operation appears). After each slice: stop, report, update
[BACKLOG.md](../../BACKLOG.md).

## Risks

- **Floci is young and only partly verified.** Mitigation: the smoke test is the first step of
  slice A and the fallback is decided there, before any code depends on it.
- **PgBouncer and session state.** Prepared statements and session-level locks break in
  transaction mode. Mitigation: slice C runs the whole concurrency suite through it before it
  counts as done.
- **Payment and hold expiry race.** A charge can succeed while the hold runs out. Mitigation: the
  claimed-key grace period; the refund path stays out of scope and is listed in the backlog.
- **At-least-once mail.** A crash after sending repeats the mail. Accepted and documented; it is
  not money.
