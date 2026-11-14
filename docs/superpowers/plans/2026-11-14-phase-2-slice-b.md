# Phase 2, slice B: confirmation email and ticket PDF. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A confirmed booking leads, through the existing outbox and queue, to a ticket PDF in S3
and a confirmation mail with the PDF attached; the customer downloads the ticket in the web app.

**Architecture:** A new `tickets` module (`apps/api/src/modules/tickets`) owns the ports
(`TicketStore`, `MailSender`, `UserDirectory`), their adapters (S3, SMTP, Keycloak Admin API), the
PDF renderer and the download route. The worker's queue consumer runs two effects per
`BOOKING_CONFIRMED` message, each under its own dedupe name: first the PDF, then the mail (which
reads the stored PDF). The slice-A log handler is replaced.

**Tech Stack:** `nodemailer`, `pdfkit`, `qrcode`, `@aws-sdk/client-s3` (already installed), Mailpit
(SMTP 1025, UI and REST API 8025). Versions, image tag and APIs are read from the registry and the
installed packages before use (AGENTS.md rule 9).

**Spec:** [phase 2 design](../specs/2026-11-13-phase-2-async-and-scaling-design.md), section "Slice
B". Rules: [AGENTS.md](../../../AGENTS.md). Slice A:
[plan](./2026-11-13-phase-2-slice-a.md).

## Global Constraints

- Every rule of AGENTS.md applies (`.js` suffixes, no `any`/`unknown` parameters, `// SAFETY:` on
  assertions, dictionaries for steering values, no `vi.mock`, no `console`, `process.env` only in
  `src/config`, domain code pure).
- Queue messages stay IDs only. The address is fetched by `userId` at send time; logs carry booking
  IDs and error names, never an address, name or event text.
- Idempotency keys: the message ID per consumer name (`processed_messages`); the PDF key is the
  fixed object key `tickets/<bookingId>.pdf`. A mail that repeats after a crash between send and
  dedupe commit is accepted and documented (it is not money).
- Queue order is not guaranteed; no consumer may rely on it. The mail effect reads the PDF from the
  store, so it runs after the PDF effect inside one dispatch, never in parallel.
- Every external call has a timeout (S3 10 s, SMTP 10 s, Keycloak 5 s, existing). Instead of a
  visibility heartbeat the queue's visibility timeout rises to 120 s (`QUEUE_POLICY`), above the
  sum of all timeouts in one dispatch. Record that in the backlog.
- New env variables (`SMTP_URL`, `MAIL_FROM`) go through `apps/api/src/config`, are listed in
  `.env.example` and get local defaults outside production (same pattern as `AWS_*`).
- Doc coupling (docs-map): `packages/shared/src/` needs `docs/api/` (`pnpm docs:generate`);
  schema change needs `docs/data-model.md`; `docker-compose*.yml` and `env.ts` need
  `CONTRIBUTING.md`. Migration comes from `pnpm db:generate`, never by hand, with
  `[braucht Live-Migration]` in the commit subject.
- UI: four states plus "being prepared" on the download; browser-verified; semantic tokens only.

## Review Focus

1. A message whose booking is no longer `CONFIRMED` (cancelled before the consumer ran): no PDF, no
   mail, message deleted. Pinned in Task 4.
2. A duplicate delivery: exactly one mail and one PDF. Pinned in Task 4.
3. Keycloak unreachable or the user has no address: the handler fails, the message stays in the
   queue, no mail goes to a blank address. Pinned in Task 4.
4. Mail server down: the message is not deleted and the PDF effect is not redone. Pinned in Task 4.
5. Non-ASCII event titles (Turkish `ş ğ İ`, umlauts) render without error and the text is in the
   PDF. Pinned in Task 3.

---

## File Structure

| Path                                                                                                        | Responsibility                                                                                |
| ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/api/src/modules/tickets/domain/ticket.ts`                                                             | `TicketData`, ports `TicketStore`, `MailSender`, `UserDirectory`, tokens, `TICKET_OBJECT_KEY` |
| `apps/api/src/modules/tickets/adapters/load-ticket-data.ts`                                                 | one query: booking + event + venue + seat for a booking ID                                    |
| `apps/api/src/modules/tickets/adapters/render-ticket-pdf.ts`                                                | pdfkit + qrcode, pure function of `TicketData`                                                |
| `apps/api/src/modules/tickets/adapters/s3-ticket-store.ts`                                                  | `TicketStore` over S3                                                                         |
| `apps/api/src/modules/tickets/adapters/smtp-mail-sender.ts`                                                 | `MailSender` over nodemailer                                                                  |
| `apps/api/src/modules/tickets/adapters/keycloak-user-directory.ts`                                          | `UserDirectory` over the Keycloak Admin API                                                   |
| `apps/api/src/modules/tickets/tickets.controller.ts`, `tickets.service.ts`, `tickets.module.ts`, `index.ts` | download route and wiring                                                                     |
| `apps/api/src/modules/tickets/testing/`                                                                     | fakes (`FakeTicketStore`, `FakeMailSender`, `FakeUserDirectory`), Mailpit REST helper         |
| `apps/worker/src/handlers/ticket-pdf.handler.ts`, `confirmation-mail.handler.ts`                            | the two effects (replace `booking-confirmed.handler.ts`)                                      |
| `apps/worker/src/queue-consumer.ts`                                                                         | dispatch runs both effects in order                                                           |

---

### Task 1: Dependencies, Mailpit, config, visibility timeout

**Files:** Modify `package.json`/`apps/api/package.json` (lockfile via `pnpm add`, not by hand),
`docker-compose.yml`, `docker-compose.e2e.yml`, `package.json` (`db:up`), `apps/api/src/config/env.ts`,
`.env.example`, `packages/shared/src/aws.ts`, `CONTRIBUTING.md`.

**Interfaces:**

- Produces: `Env.SMTP_URL: string` (URL, local default `smtp://localhost:1025`), `Env.MAIL_FROM:
string` (default `tickets@ticketmaster-klon.invalid`); `QUEUE_POLICY.VISIBILITY_TIMEOUT_SECONDS =
120`; a `mailpit` Compose service, started by `pnpm db:up`.

- [ ] **Step 1: Failing test** in `apps/api/src/config/env.spec.ts`: outside production `parseEnv`
      without `SMTP_URL` yields the local default; in production a missing `SMTP_URL` is rejected.
- [ ] **Step 2:** run `pnpm vitest run apps/api/src/config` and see it fail.
- [ ] **Step 3:** add the two variables to `EnvSchema`, `LOCAL_DEFAULTS` and `.env.example`; set
      the visibility constant to 120; check `scripts/aws-init.mjs` applies it to an existing queue
      (it re-sets attributes) and that no spec hard-codes 30.
- [ ] **Step 4:** `pnpm add` the three libraries plus `@types/nodemailer`, `@types/pdfkit`,
      `@types/qrcode` where the API package needs them (verify each package's current ESM/types state;
      check the registry for the Mailpit tag with `docker manifest inspect`). Add the `mailpit`
      service (healthcheck, ports 1025/8025; 8025 also in the e2e file) and `SMTP_URL:
smtp://mailpit:1025` plus `depends_on` for `worker`. Add `mailpit` to `db:up`. Describe it in
      `CONTRIBUTING.md`.
- [ ] **Step 5:** `pnpm db:up`, `pnpm vitest run apps/api/src/config` green, `pnpm check` green.
- [ ] **Step 6:** commit `chore(infra): mailpit, smtp config and a longer visibility timeout` with
      the reason for 120 s in the body.

### Task 2: `ticketReady` (schema, contract, list)

**Files:** Modify `apps/api/src/infrastructure/database/schema.ts` (nullable
`bookings.ticket_ready_at timestamptz`), generated migration, `packages/shared/src/bookings-api.ts`,
`apps/api/src/modules/bookings/adapters/load-own-bookings.ts`, `docs/data-model.md`, `docs/api/`.

**Interfaces:**

- Produces: `BookingSchema.ticketReady: z.boolean()`; column `bookings.ticket_ready_at`
  (expand-only, nullable, no backfill: older bookings simply have no ticket).

- [ ] **Step 1: Failing test** in the existing bookings list db spec: a `CONFIRMED` booking with
      `ticket_ready_at` set lists `ticketReady: true`; without it `false`.
- [ ] **Step 2:** run it, see it fail.
- [ ] **Step 3:** schema column, `pnpm db:generate`, schema field, mapping in `loadOwnBookings`
      (`ticketReady = ticketReadyAt !== null`).
- [ ] **Step 4:** `pnpm test:db` for the spec green; `pnpm docs:generate`; fix web fixtures that
      build a `Booking` (typecheck shows them).
- [ ] **Step 5:** `pnpm check` green; commit `feat(bookings): ticketReady flag [braucht
Live-Migration]`.

### Task 3: Tickets module: ports, PDF, S3, SMTP, address lookup

**Files:** Create the `tickets/domain`, `tickets/adapters` and `tickets/testing` files from the
table above, each with a `*.spec.ts` next to it; modify
`apps/api/src/modules/demo/adapters/keycloak-admin.client.ts` only if the address lookup shares
its admin-token code (extract on the second use, not before); font files under
`apps/api/src/modules/tickets/assets/fonts/` (Noto Sans, OFL) and the Dockerfile worker and api
targets so the files ship.

**Interfaces:**

```ts
export const TICKET_OBJECT_KEY = (bookingId: string): string => `tickets/${bookingId}.pdf`;
export interface TicketData {
  bookingId: string;
  status: BookingStatus;
  eventTitle: string;
  venueName: string;
  startsAt: Date;
  seat: { section: string; row: string; number: number };
}
export interface TicketStore {
  put(bookingId: string, pdf: Uint8Array): Promise<void>;
  get(bookingId: string): Promise<Uint8Array | null>; // null when the object is absent
}
export interface MailSender {
  send(mail: {
    to: string;
    subject: string;
    text: string;
    attachment: { filename: string; content: Uint8Array };
  }): Promise<void>;
}
export interface UserDirectory {
  emailOf(userId: string): Promise<string>;
} // throws when none
export function renderTicketPdf(data: TicketData): Promise<Uint8Array>;
export function loadTicketData(db: Database, bookingId: string): Promise<TicketData | null>;
```

(Check the real column names and the seat/venue shape in `schema.ts` before fixing the field types.)

- [ ] **Step 1: Failing tests**, each at its lowest layer:
  - `render-ticket-pdf.spec.ts`: output starts with `%PDF`; the booking ID is in the document
    as extractable text (printed under the QR code; the QR payload is the same ID); title `Şarkı Ğ İstanbul Müller` renders without throwing and its text
    is extractable (proves the embedded font). Breaks red when the font registration is removed.
  - `s3-ticket-store.db.spec.ts` (Floci, scratch key): `put` then `get` returns the same bytes;
    `get` of an absent key returns `null`, a different error (access denied) rethrows. Red when
    the `NoSuchKey` check is widened to every error.
  - `smtp-mail-sender.db.spec.ts` (Mailpit REST): the mail arrives with subject and one PDF
    attachment of the given bytes; a refused connection rejects (no swallowed error).
  - `keycloak-user-directory.spec.ts` (MSW): returns the address of the `sub`; 404 and an empty
    `email` throw; a 5xx throws. Red when the empty-address check is removed.
  - `load-ticket-data.db.spec.ts`: returns the joined data; `null` for an unknown ID.
- [ ] **Step 2:** run each, see it fail for the right reason.
- [ ] **Step 3:** implement the adapters. Approach: pdfkit writes into a buffer (collect `data`
      events), `qrcode.toBuffer` for the code, fonts registered from the assets folder via
      `import.meta.dirname`; S3 client from the config module with `forcePathStyle` and a 10 s request
      timeout; nodemailer transport from `SMTP_URL` with connection, greeting and socket timeouts 10
      s; the directory reuses the Keycloak admin token with the 5 s timeout. Add the fakes and the
      Mailpit REST helper (`listMessages`, `clear`) to `testing/` (specs of the worker import them).
- [ ] **Step 4:** specs green (`pnpm test:db`, `pnpm test`); mutation probe per spec as listed
      above (note it in the commit body).
- [ ] **Step 5:** `pnpm check` green; commit `feat(tickets): pdf renderer, s3 store, smtp sender,
address lookup`.

### Task 4: Worker effects and dispatch

**Files:** Create `apps/worker/src/handlers/ticket-pdf.handler.ts`,
`confirmation-mail.handler.ts` (+ specs); delete `booking-confirmed.handler.ts` and its spec;
modify `queue-consumer.ts`, `worker.module.ts`, `queue-consumer.db.spec.ts`,
`worker.module.db.spec.ts`, `apps/api/src/modules/tickets/tickets.module.ts` (providers bound to
the adapters, exported through `index.ts`).

**Interfaces:**

- Consumes: Task 3 ports. `CONSUMER_NAME = { TICKET_PDF: 'ticket-pdf', CONFIRMATION_MAIL:
'confirmation-mail' } as const`.
- Produces: `TicketPdfHandler.handle(message: BookingConfirmedMessage, tx: Tx): Promise<void>` and
  `ConfirmationMailHandler.handle(message): Promise<void>`, each with a public `consumer` name.
  PDF effect: load data, return when absent or status not `CONFIRMED` (log booking ID), render,
  `store.put`, set `ticket_ready_at = clock.now()` in the dedupe transaction. Mail effect: same
  status check, `directory.emailOf(message.userId)`, `store.get` (throw when `null`), `send`.
  Dispatch: `processOnce(PDF…)` then `processOnce(MAIL…)`, then delete the message.

- [ ] **Step 1: Failing tests** (handler specs with the fakes; dispatch specs in the db project
      with Floci and Mailpit):
  - duplicate message (same ID twice): one Mailpit mail, one stored object, one `ticket_ready_at`
    write. Red when `processOnce` is removed from the mail dispatch.
  - booking cancelled before the message is handled: no object, no mail, message deleted. Red when
    the status check is removed.
  - `FakeUserDirectory` throws: the message is not deleted, the PDF effect is recorded as done and
    not redone on the next delivery, no mail. Red when the mail effect swallows the error.
  - `FakeMailSender` rejects: same assertions (Review Focus 4).
  - mail effect with an absent stored PDF throws instead of sending without attachment.
  - log lines contain the booking ID and no address (spy on the logger).
- [ ] **Step 2:** run, see them fail.
- [ ] **Step 3:** implement. The PDF effect runs inside the `processOnce` callback so the
      `ticket_ready_at` update commits with the dedupe record; check `processOnce`'s callback
      signature before fixing the `tx` parameter.
- [ ] **Step 4:** green: `pnpm test`, `pnpm test:db`.
- [ ] **Step 5:** `pnpm check`; commit `feat(worker): ticket pdf and confirmation mail consumers`.

### Task 5: Download route

**Files:** Create `tickets.controller.ts`, `tickets.service.ts` and `tickets.controller.db.spec.ts`
in the tickets module; register the module in `AppModule`.

**Interfaces:**

- Produces: `GET /api/bookings/:id/ticket` (role `CUSTOMER`) returns `application/pdf` bytes
  (`Content-Disposition: attachment; filename="ticket-<bookingId>.pdf"`);
  `TicketsService.download(userId: string, bookingId: string): Promise<Uint8Array>` throws
  `ForbiddenException` for a foreign booking, `NotFoundException` for an unknown booking, a
  booking not `CONFIRMED`, or `ticket_ready_at` null.

- [ ] **Step 1: Failing tests** in the controller spec: owner gets the PDF bytes; foreign booking
      and wrong role (organizer) answer 403; unknown ID 404; before the file exists 404; cancelled
      booking 404 even though the object exists; no token 401. Red when the ownership comparison is
      removed (foreign user gets bytes) and when the status check is removed.
- [ ] **Step 2:** run, see them fail.
- [ ] **Step 3:** implement; ownership comes from `@CurrentUser()` only. **Note:** the existing
      booking routes answer 404 for a foreign booking; this spec and AGENTS.md section 4 say 403, so
      this route answers 403 and the difference goes into the backlog.
- [ ] **Step 4:** green; `pnpm docs:generate` (OpenAPI); `pnpm check`; commit
      `feat(tickets): owner-only ticket download`.

### Task 6: Web download

**Files:** Modify `apps/web/src/app/bookings/bookings.service.ts`, `bookings.store.ts`,
`my-bookings.ts`, `my-bookings.html` and their specs.

**Interfaces:**

- Produces: `BookingsService.downloadTicket(id: string): Observable<Blob>` (the only `HttpClient`
  use; the bearer token goes through the existing interceptor); the store exposes a per-booking
  download state (`idle | pending | error`); the list shows, for `CONFIRMED` bookings, "Ticket
  is being prepared" while `ticketReady` is false and a download button when true.

- [ ] **Step 1: Failing tests:** service spec (`HttpTestingController`, `verify()`): GET goes to
      the ticket URL with `responseType: 'blob'`; component specs: button hidden for a non-confirmed
      booking, "being prepared" text while `ticketReady` is false, click disables the button (no double
      submit) and a failed download shows an error with retry. Each red when its branch is removed.
- [ ] **Step 2:** run, see them fail.
- [ ] **Step 3:** implement; the component turns the blob into an object URL and clicks a
      temporary anchor (revoke the URL afterwards). Primitives and tokens as in the existing list.
- [ ] **Step 4:** `pnpm test`; open the page in the browser (chrome-devtools) with a confirmed
      booking: prepared state, download, error state (stop the API route). Record what was seen.
- [ ] **Step 5:** `pnpm check`; commit `feat(web): download the ticket from my bookings`.

### Task 7: End to end, docs, backlog

**Files:** Create `apps/web/e2e/ticket.e2e.ts`; modify `docs/BACKLOG.md`, `docs/PLAN.md` (context
only, no status), architecture or README sections that mention the async chain,
`CONTRIBUTING.md` if not complete.

- [ ] **Step 1:** e2e spec: demo customer holds and pays a seat; Mailpit's REST API lists one mail
      with a PDF attachment; the my-bookings button downloads a file starting with `%PDF`. Run
      `pnpm e2e`; check `df -h` before the build.
- [ ] **Step 2:** backlog: close "consumer handler only logs", "visibility timeout" and the mail
      repeat note (now documented as accepted); add open points (403 vs 404 convention across booking
      routes; replay tool for the DLQ still missing; the PDF stays after a cancel and is never
      deleted; address lookup per message costs one Keycloak call; Noto Sans font ships in images).
- [ ] **Step 3:** `pnpm check`, `pnpm test`, `pnpm test:db`, `pnpm e2e` all green; after the push
      `gh run list --branch main --limit 1` green.
- [ ] **Step 4:** commit `docs: slice B state and open points`; write the DoD receipt and the
      ledger below; stop and report (phase rule).

## Ledger (fill while executing)

| Task | Duration | Subagent tokens | Notes               |
| ---- | -------- | --------------- | ------------------- |
| 1-7  |          |                 | Sum line at the end |
