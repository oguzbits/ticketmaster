# Phase 2, slice A: outbox, SQS, dead-letter queue, idempotent consumers. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Confirming a booking writes an outbox row in the same transaction; a relay in the worker
sends it to SQS; a consumer in the worker handles it once per message ID; a message that keeps
failing ends in the dead-letter queue. The payment call no longer runs inside a database
transaction.

**Architecture:** The payment flow becomes claim (transaction 1), charge (no transaction), apply
(transaction 2 with the outbox row). A new `outbox` module owns the tables, the enqueue helper, the
relay and the dedupe helper; the SQS client is an adapter behind a `MessageQueue` port. The worker
runs the relay as a scheduled job and a long-polling consumer loop. Queues and bucket are created
by a Compose one-shot (slice E replaces it with declared infrastructure).

**Tech Stack:** NestJS 12, Drizzle, `@aws-sdk/client-sqs`, `@aws-sdk/client-s3` (bucket creation
only here), Floci (fallback ElasticMQ plus MinIO, decided in Task 1). Versions and APIs are read from
the registry and the installed packages before use.

**Spec:** [phase 2 design](../specs/2026-11-13-phase-2-async-and-scaling-design.md), section "Slice
A". Rules: [AGENTS.md](../../../AGENTS.md).

## Global Constraints

- Every rule of AGENTS.md applies (`.js` suffixes, no `any`/`unknown` parameters, `// SAFETY:` on
  assertions, dictionaries for steering values, no `vi.mock`, no `console`, `process.env` only in
  `src/config`, domain code pure with injected `Clock`).
- Queue messages carry IDs only: no email, name or other personal data. Logs carry IDs and error
  names only.
- Delivery is at least once; the outbox row ID is the message ID and the idempotency key of every
  consumer. Name it in the contract.
- A message is deleted from the queue only after its handler succeeded.
- A change in `packages/shared/src/` needs a change under `docs/api/`; a schema change needs
  `docs/data-model.md`; migrations come from `pnpm db:generate` and carry `[braucht Live-Migration]`
  in the commit subject. A change to `docker-compose*.yml` needs `CONTRIBUTING.md`.
- Every new env variable is in `.env.example` with a local default outside production (same pattern
  as the connection URLs). The AWS clients get explicit credentials and endpoint from the config
  module; nothing reads the SDK's own environment variables.
- Tests: `*.spec.ts` offline, `*.db.spec.ts` with Postgres, Redis and the local AWS emulator
  (`pnpm db:up` starts all three; extend the script and `pnpm test:db`'s CI job accordingly). Every
  guard has a test that turns red when the guard is removed; mutate by hand, write it in the commit
  body.
- One topic per commit, Conventional Commits, `pnpm check` green, hooks never skipped, push to
  `main`, then `gh run list --branch main --limit 1`. `df -h` before Compose runs.

## Decisions taken in this plan

- **Readiness stays 200 when the outbox is stuck.** `GET /health/ready` gains a `signals.outbox`
  field (`ok` or `stuck`, stuck when the oldest unpublished row is older than
  `OUTBOX_STUCK_SECONDS`, 300). A worker outage must not make Caddy drop the API instances.
- **The fake payment provider decides by its key.** The result is a pure function of the
  idempotency key and the failure rate (hash of the key against the rate), so a retry with the same
  key gets the same answer. The injected random source goes away.
- **A late charge is not refunded.** If transaction 2 finds the booking no longer HELD (the hold
  expired after the grace period), nothing is stored, the conflict is returned and logged with the
  booking ID; the refund path is a backlog item.
- **Only `BOOKING_CONFIRMED` is a message type in this slice.** A failed payment or a cancel emits
  nothing.
- **The consumer handler of this slice only logs the booking ID** (slice B adds mail and PDF); it
  exists to prove dedupe, delete-after-success and the DLQ.
- **Resource names and the redrive policy live in `packages/shared`** (`QUEUE_NAME`,
  `QUEUE_POLICY`), the creation script reads them from there.

## Review Focus

1. Two parallel pay requests with the same key: one charge, one outbox row, one answer for both
   (Task 3).
2. Crash after the claim, and after the charge: the retry with the same key finishes the booking
   without a second charge (Task 3).
3. Hold expiry while a payment is claimed: not expired inside the grace period, expired after it;
   a late successful charge changes nothing and is logged (Task 3).
4. The queue is down: payment still succeeds, the row stays unpublished, `attempts` grows, the
   relay recovers by itself (Task 2).
5. A handler that throws, a message that does not parse, a duplicate: never deleted early, never
   handled twice, DLQ after the max receive count (Task 4).

---

### Task 1: Local AWS emulator, smoke test, ADR, resource bootstrap

**Files:**

- Create: `scripts/aws-smoke.mjs`, `scripts/aws-init.mjs`, `docs/adr/0004-local-aws-emulator.md`
- Modify: `docker-compose.yml`, `docker-compose.e2e.yml`, `package.json` (`db:up`, `aws:smoke`),
  `.github/workflows/ci.yml` (db job services), `CONTRIBUTING.md`, `.env.example`,
  `apps/api/src/config/env.ts` (+ spec), `packages/shared/src/` (`aws.ts`, `index.ts`),
  `docs/api/`

**Interfaces (Produces):**

- Shared: `QUEUE_NAME = { BOOKING_EVENTS: 'booking-events', BOOKING_EVENTS_DLQ:
'booking-events-dlq' } as const`; `QUEUE_POLICY = { MAX_RECEIVE_COUNT: 5,
VISIBILITY_TIMEOUT_SECONDS: 30, LONG_POLL_SECONDS: 20 } as const`; `BUCKET_NAME = { TICKETS:
'tickets' } as const`.
- Env: `AWS_ENDPOINT_URL` (url, optional in production: unset means real AWS), `AWS_REGION` (default
  `us-east-1`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (local default `test`, required in
  production). Compose service `aws` (Floci, tag read from the registry and checked with
  `docker manifest inspect`; set its hostname variable so queue URLs resolve inside the Compose
  network), one-shot `aws-init` (creates DLQ, queue with redrive policy, bucket; safe to run
  again) that `api` and `worker` wait for.

**Steps:**

- [ ] Smoke script against the running emulator: standard queue; redrive to the DLQ after
      `MAX_RECEIVE_COUNT` receives (shorten the visibility timeout for the check); long polling
      returns early on a message; message attributes round trip; bucket create, put and get.
      Run it; record results and the exact image tag in the ADR.
- [ ] If any feature fails, evaluate ElasticMQ plus MinIO with the same script and take the
      fallback; the ADR names both, the evidence and the rejected option.
- [ ] `aws-init.mjs` (idempotent; running twice changes nothing), Compose services, `db:up` and the
      CI db job get the emulator; healthcheck uses a command proven in the smoke run.
- [ ] Env additions with spec cases: local defaults outside production; production without the
      credentials fails and names the variable, not the value.
- [ ] Commits: `docs(adr): local AWS emulator`, `feat(infra): AWS emulator and resource bootstrap`.

---

### Task 2: Outbox, queue port, relay

**Files:**

- Create under `apps/api/src/modules/outbox/`: `domain/message-queue.ts`,
  `adapters/sqs-message-queue.ts`, `outbox.service.ts`, `outbox.module.ts`, `index.ts`,
  `testing/` (fake queue, queue purge helper), specs; `packages/shared/src/outbox.ts`;
  `apps/worker/src/outbox-relay.job.ts` (+ spec)
- Modify: `apps/api/src/infrastructure/database/schema.ts` (+ generated migration),
  `docs/data-model.md`, `docs/api/`, `apps/worker/src/worker.module.ts`,
  `apps/api/src/modules/health/health.controller.ts` (+ spec),
  `packages/shared/src/health.ts`

**Interfaces (Produces):**

- Shared: `OUTBOX_MESSAGE_TYPE = { BOOKING_CONFIRMED: 'BOOKING_CONFIRMED' } as const`;
  `BookingConfirmedMessageSchema { messageId: uuid, type, bookingId: uuid, eventId: uuid, userId:
uuid, occurredAt: ISO }`; `QueueMessageSchema` (discriminated union on `type`, one member now);
  `HealthResponse` gains optional `signals: { outbox: 'ok' | 'stuck' }` (ready route only).
- Tables: `outbox_messages` (id uuid pk = message ID, type enum, payload jsonb, created_at,
  published_at null, attempts int default 0, last_error text null) with a partial index on
  `created_at` where `published_at is null`; `processed_messages` (consumer text, message_id uuid,
  processed_at; primary key (consumer, message_id)).
- Port: `interface MessageQueue { send(input: { body: string; messageId: string }):
Promise<void>; receive(max: number): Promise<ReceivedMessage[]>; delete(receiptHandle: string):
Promise<void> }` with `ReceivedMessage { body: string; receiptHandle: string; receiveCount:
number; messageId: string }`; token `MESSAGE_QUEUE`. The SQS adapter long-polls with
  `LONG_POLL_SECONDS`, resolves the queue URL by name at start and fails fast if it is missing.
- `OutboxService.enqueue(tx: Tx, message: QueueMessage): Promise<void>` (row ID = `messageId`);
  `relay(batchSize: number): Promise<{ sent: number; failed: number }>`: select unpublished rows
  oldest first `FOR UPDATE SKIP LOCKED` in one transaction, send each, mark the sent ones published
  with the time of the injected `Clock`, bump `attempts` and store `last_error` (error name only)
  for the failed; a failed send does not stop the batch.
  `oldestUnpublishedAgeSeconds(): Promise<number | null>`.
- Worker job `OutboxRelayJob` every second, tick guarded like `HoldExpiryJob`.

**Test cases:**

- Enqueue inside a transaction that rolls back leaves no row; relay sends each unpublished row once
  and marks it; a send failure keeps the row, raises `attempts`, stores the error name, and the next
  relay delivers it; one failing row does not block the others.
- Two relays running in parallel on the same rows send each row once (no crash involved).
- A crash between send and mark (fake queue that records the send, then the mark is skipped) leads
  to a second send of the same message ID after restart: pinned as the documented at-least-once
  behavior.
- Readiness: `signals.outbox` is `ok` with no or young unpublished rows, `stuck` past the limit, the
  status code stays 200; Redis or Postgres down still answers 503.
- Adapter against the real emulator: a sent message is received with its message ID, deleted
  messages do not return, `receiveCount` grows on re-receive.
- Mutations: remove `SKIP LOCKED` (parallel test), mark published before the send (failure test),
  swallow the send error (attempts test), make `stuck` return 503 (readiness test).

**Steps:** specs first, then implementation, `pnpm db:generate`, docs, `pnpm test:db`. Commits:
`feat(shared): outbox contracts`, `feat(db): outbox and processed messages [braucht
Live-Migration]`, `feat(outbox): enqueue and relay`, `feat(health): outbox signal`.

---

### Task 3: Payment outside the transaction, outbox row on confirm

**Files:**

- Modify: `apps/api/src/modules/bookings/bookings.service.ts` (`pay`, `expireHolds`),
  `apps/api/src/modules/bookings/adapters/fake-payment.provider.ts`,
  `apps/api/src/modules/bookings/adapters/booking-transitions.ts`,
  `apps/api/src/modules/bookings/bookings.module.ts`, their specs, `docs/api/rest.md`,
  `docs/BACKLOG.md`

**Interfaces:**

- Consumes: `OutboxService.enqueue` through the outbox `index.ts`.
- Produces: `PAYMENT_GRACE_SECONDS = 120` (bookings domain constant); `BookingsService.pay`
  keeps its signature and its HTTP contract.

**Behavior rules:**

- Transaction 1 locks the booking row, checks ownership, refuses a hold that has run out, claims
  the key (a key of another booking stays a conflict). Same key as already claimed: continue
  with the stored state. Another key while a different key is claimed on a HELD booking: 409.
- The charge runs with no transaction open, with `{ bookingId, amountCents, idempotencyKey }`; the
  fake provider's answer is a pure function of key and rate.
- Transaction 2 locks the booking again and applies PAID then CONFIRMED (success) or CANCELLED
  (failure) through the state machine; on success it also calls `enqueue` with a
  `BOOKING_CONFIRMED` message (new UUID as message ID) in the same transaction. A booking no longer
  HELD answers 409, stores nothing and logs the booking ID.
- A retry with a claimed key on a booking that is still HELD repeats the charge (same key, same
  answer) and applies the result; on a settled booking it returns the stored state without a
  charge and without a second outbox row.
- `expireHolds` skips HELD bookings with a claimed key until `hold_expires_at` is
  `PAYMENT_GRACE_SECONDS` in the past.

**Test cases:**

- Success: booking CONFIRMED, exactly one outbox row with the right IDs and no personal data;
  failure: CANCELLED, no row; a rollback in transaction 2 leaves no row.
- Parallel pay requests with one key (10 at once): one charge (counting provider), one row, equal
  answers; with different keys on one booking: one wins, the others 409.
- Crash points: a provider call that throws after the claim, then retry with the same key: one
  charge result applied; a crash between charge and apply (apply step throws once), then retry:
  confirmed once, one row.
- The charge runs outside a transaction (a provider fake asserts that no transaction is open on
  the connection, for example by checking that the booking row is not locked from another
  connection during the call).
- Expiry: claimed-key booking inside the grace period stays HELD; past it, it expires; unclaimed
  HELD bookings expire as before. A late success after expiry: 409, status EXPIRED, no row, logged.
- Existing booking specs stay green; the concurrency suite stays green.
- Mutations: apply the result without relocking, drop the grace filter, enqueue outside the
  transaction, charge before the claim commits, remove the claimed-key check on a second key. Each
  must turn a test red.

**Steps:** specs, implement, `pnpm test:db`, docs. Commits: `refactor(bookings): charge outside the
transaction`, `feat(bookings): outbox row on confirm`, `fix(bookings): skip claimed holds in the
expiry grace`.

---

### Task 4: Consumer framework, DLQ, wiring

**Files:**

- Create: `apps/worker/src/queue-consumer.ts` (+ `queue-consumer.db.spec.ts`),
  `apps/worker/src/handlers/booking-confirmed.handler.ts` (+ spec)
- Modify: `apps/worker/src/worker.module.ts`, `apps/api/src/modules/outbox/outbox.service.ts`
  (`processOnce`), specs, `docs/BACKLOG.md`

**Interfaces:**

- `OutboxService.processOnce(consumer: string, messageId: string, effect: (tx: Tx) =>
Promise<void>): Promise<boolean>`: inserts `(consumer, messageId)` with `ON CONFLICT DO
NOTHING`; when inserted it runs the effect in the same transaction and commits both, otherwise
  returns `false` without running the effect. An effect that throws rolls the dedupe row back.
- `QueueConsumer` (long-polling loop, one message at a time per loop, stops on shutdown without a
  dangling read): parse the body with `QueueMessageSchema`; unknown or invalid body: log the
  message ID and throw so the message is not deleted and ends in the DLQ; call the handler for the
  type inside `processOnce(consumerName, messageId, …)`; delete the message after success or after
  a duplicate. A failing iteration is logged and retried after a pause, never ends the loop.
- `BookingConfirmedHandler`: logs the booking ID (slice B replaces the body).

**Test cases (real emulator, Postgres):**

- A sent message reaches the handler once; the same message ID sent twice runs the effect once and
  both messages are deleted.
- A throwing handler leaves the message undeleted; after `MAX_RECEIVE_COUNT` receives it is in the
  DLQ and gone from the main queue; the dedupe row is absent.
- An unparsable body ends in the DLQ and the loop keeps running; the next valid message is handled.
- A handler failure on the first receive and success on the second ends with one effect.
- Shutdown while a long poll is open returns promptly.
- Full path: confirm a booking through `BookingsService.pay`, run the relay, the consumer records
  the message in `processed_messages` (one row).
- Mutations: delete before the handler, run the effect outside the dedupe transaction, remove the
  throw on an invalid body, ignore the dedupe result.

**Steps:** specs, implement, wire into `WorkerModule`, `pnpm test:db`. Commits: `feat(outbox):
dedupe helper`, `feat(worker): queue consumer with dead-letter handling`.

---

### Task 5: End to end, docs, receipt

**Files:**

- Modify: `README.md`, `docs/BACKLOG.md`, `docs/data-model.md` (verify), `docs/api/rest.md`
  (verify), `CONTRIBUTING.md`, this plan's ledger, `docs/adr/0004-local-aws-emulator.md` (verify)

**Steps:**

- [ ] `pnpm e2e` green with the emulator in the stack (booking flow still passes; payment now takes
      the new path); `df -h` first.
- [ ] README: architecture diagram gets outbox, queue, DLQ and the consumer; requirements mention
      the asynchronous chain. BACKLOG: slice A state; deviations (readiness signal instead of a
      status change, key-based fake payment, consumer handler only logs); open points (no refund
      after a late charge, mail may repeat after a crash is slice B's, queue ordering is not
      guaranteed, the DLQ has no replay tool yet).
- [ ] Slice A Definition-of-Done check against the spec: outbox row exists if and only if the
      booking is CONFIRMED (db spec), DLQ end to end, dedupe, payment retry at each crash point.
- [ ] Final whole-branch review with the strongest model (payment, relay, consumer), fix wave,
      `pnpm check`, `pnpm test`, `pnpm test:db`, `pnpm e2e` green, push, check CI.
- [ ] DoD receipt per feature, ledger filled, one summary line.

---

## Execution

Dispatch with `umsetzer` (medium model from `CLAUDE_CODE_SUBAGENT_MODEL`, no `model` set). Bundles:
**1**, **2**, **3**, **4**, **5**. Own review (`pruefer`) after **2+3** together (data loss,
payment, concurrency) and after **4** (delete-after-success, DLQ); the final whole-branch review on
the strongest model. Task 1 runs first (the others need the emulator); 2 and 3 run one after the
other because both touch the bookings transaction code and the schema.

## Ledger

| Task | Duration | Subagent tokens | Notes |
| ---- | -------- | --------------- | ----- |
