# Stage look, slices 4 and 5: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** My bookings, the organizer pages, the strategy switch, the rush simulator and the audit
log get the dark stage look, and every strategy shown to a person is the readable label. No API or
contract change.

**Architecture:** The tokens and primitives of slices 1 to 3 carry the look. One new primitive,
`.field`, replaces the form-control class string that repeats ten times. `strategyLabel` (already
the single mapping) is applied to the pages that still print the raw value. Pages change markup and
classes; behavior and async states stay.

**Tech Stack:** Angular 22 (standalone, signals), Tailwind v4, Vitest through `ng test`,
Playwright (`pnpm e2e`).

**Spec:** [Stage look redesign](../specs/2026-11-15-stage-look-redesign-design.md), slices 4 and 5.
Follows [slices 1 to 3](2026-11-15-stage-look-slices-1-3.md).

## Pre-flight

- **Scope:** slice 4 (my bookings, organizer events, event form) and slice 5 (strategy switch,
  simulator, audit log). **Out of scope:** any API or `packages/shared` change, a theme switch,
  charts (the app has none; the spec's "charts restyled" has nothing to apply to), a shared table
  primitive (two tables, Rule of Three not reached), collapsing the transition history.
- **Proof:** `pnpm check`, `pnpm test` and `pnpm e2e` green after each slice, plus the browser
  check in the last task of the slice. Run `df -h` before `pnpm e2e`.

## Global Constraints

- Own identity, footer notice and contrast rules as in slices 1 to 3: text 4.5:1, borders and focus
  ring 3:1, status never by color alone, visible focus, animation behind `motion-safe:`.
- Every async view keeps loading (`role="status"`), error (`role="alert"` plus retry), empty and
  pending states. Components never use `HttpClient`; only semantic tokens, no ad-hoc colors.
- Visible text changes only where this plan names it. The e2e specs select by the strings listed
  under Deviations; they stay as they are.
- A value that is submitted or compared stays the raw enum value (`option[value]`, request bodies,
  `Status: FINISHED`, audit action names). Only text a person reads becomes the label.
- Docs change in the commit of the code they describe. Conventional Commits, `Co-Authored-By` line
  of the session, straight to `main`.

## Decisions

- **`.field` primitive** for `input`, `select` and `textarea`: the string
  `rounded border border-edge bg-surface-raised px-3 py-2` appears ten times (event form 5,
  simulator 3, audit log 1, strategy switch 1). The disabled opacity stays a utility on the
  element.
- **Strategy label everywhere it is read:** option text, "Current strategy", the confirm sentence,
  "The strategy is now ...", "Current run: ...", the comparison row header, the organizer card.
  The e2e specs derive the expected text from the page itself (`Current strategy: <x>`, option
  texts) or select by raw value, so they pass unchanged.
- **Audit log keeps raw action names and ids.** They are technical identifiers (`font-mono`), and
  the e2e spec reads the `rowheader` by the raw action.
- **Booking status becomes a `.badge`** whose text stays `Status: <word>`; the badge is never the
  only carrier of the status.
- **Organizer cards reuse `app-event-art` and the event-list card layout**; no utilization bar (the
  text already says it).

## Review Focus

1. A strategy option shows the label but submits the raw value (form, simulator, switch). Tests in
   Tasks 1 and 3.
2. A long event or venue name in the organizer card wraps and never scrolls the page sideways at
   390 px. Browser check in Task 2.
3. A finished run without metrics (failed or queued) still renders its table row. Existing spec
   `simulator-page.spec.ts` stays green; browser check in Task 5.
4. Long request IDs in the audit table scroll inside the table container, not the page. Browser
   check in Task 5.
5. A booking whose ticket is not ready shows `Ticket is being prepared` and no button. Existing
   `my-bookings.spec.ts` stays green; browser check in Task 2.

## File Structure

| File                                                             | Responsibility                      |
| ---------------------------------------------------------------- | ----------------------------------- |
| `apps/web/src/styles.css`, `DESIGN.md`                           | `.field` primitive, documented      |
| `apps/web/src/app/organizer/organizer-events.html`, `.spec.ts`   | card grid with art, label badge     |
| `apps/web/src/app/organizer/event-form.html`, `.ts`, `.spec.ts`  | `.field`, card, label options       |
| `apps/web/src/app/bookings/my-bookings.html`                     | booking cards, status badge         |
| `apps/web/src/app/admin/strategy-switch.html`, `.ts`, `.spec.ts` | card, label text                    |
| `apps/web/src/app/admin/simulator-page.html`, `.ts`, `.spec.ts`  | form card, metric tiles, label text |
| `apps/web/src/app/admin/audit-log-page.html`                     | filter field, table card            |
| `docs/BACKLOG.md`                                                | state and deviations                |

`events/strategy-label.ts` and `app-event-art` exist; import them, do not copy.

---

## Slice 4: My bookings and organizer

### Task 1: `.field` primitive, organizer events and event form

**Files:** modify `styles.css`, `DESIGN.md`, `organizer/organizer-events.html`,
`organizer/event-form.html`, `organizer/event-form.ts`, `organizer/organizer-events.spec.ts`,
`organizer/event-form.spec.ts`.

**Interfaces:**

- Consumes: `strategyLabel(strategy: BookingStrategy): string` from `events/strategy-label.ts`;
  `app-event-art` with input `eventId`; `.card`, `.badge`, `.btn` from slices 1 to 3.
- Produces: `.field` in `@layer components` (token border `edge`, background `surface-raised`,
  radius and padding as the string above; `.field:disabled` is not styled here). `EventForm` gains
  `protected label(strategy: BookingStrategy): string` returning `strategyLabel(strategy)` (same
  pattern as `EventList.label`). Tasks 3 and 4 reuse `.field`.

- [ ] **Step 1: Write the failing tests.**
  - `organizer-events.spec.ts`: `shows the strategy of an event as its label`: the card text
    contains `strategyLabel(GALA.strategy)` and not the raw value `GALA.strategy`.
  - `event-form.spec.ts`: `offers every strategy by label and submits the raw value`: every
    `#event-strategy option` has `textContent.trim() === strategyLabel(option.value)`; the
    existing submit test keeps asserting the raw `strategy` in the request body.
- [ ] **Step 2:** Run `pnpm --filter web test`. Expected: the two new tests FAIL (raw value shown).
- [ ] **Step 3: Implement.** Add `.field` to `styles.css` and swap it for the repeated string in
      `event-form.html` (five controls). Organizer list: a `.card` per event inside a link, same
      structure as the event-list card (name `h2`-level `span` stays a `span`, since the page has
      no heading per card today; keep the existing DOM order name, venue/date line, counts), art
      block `order-first h-24`, strategy as `.badge` with the label, counts text unchanged
      (`N of M seats sold`, held, utilization). The form sits in a `.card p-4`, the submit button
      keeps its states. Option text uses `label(item)`; `[value]` stays raw.
- [ ] **Step 4:** Run `pnpm --filter web test`. Expected: PASS. **Mutation check:** print the raw
      value in the card and in the option text; each new test must go red. Revert.
- [ ] **Step 5: `DESIGN.md`:** list `.field` next to `.card` and `.badge`; state that organizer
      cards follow the event card. **Commit** `feat(web): stage look for the organizer pages`
      (`Docs:` is in the same commit).

### Task 2: My bookings

**Files:** modify `bookings/my-bookings.html`.

**Interfaces:**

- Consumes: `.card`, `.badge`, `.btn`, `.btn-secondary` as above; the component's existing
  `status`, `reason`, `hasTicket`, `canCancel`, `download`, `cancel` members stay untouched.
- Produces: no new members. Visible text unchanged.

- [ ] **Step 1:** Run `pnpm --filter web test` for the baseline: PASS (the existing
      `my-bookings.spec.ts` is the guard; no behavior changes, so no new test).
- [ ] **Step 2: Rebuild the template.** Each booking is a `.card p-4` with the seat line as the
      heading-weight text, `Status: <word>` inside a `.badge`, the event link below, the transition
      history as muted small list (`border-edge-subtle` divider above it), and the ticket and
      cancel actions in one wrapping flex row (`Download ticket` as `.btn`, `Cancel booking` as
      `.btn-secondary`; both keep `disabled:` utilities and their pending labels). Loading, error
      with retry, cancel-failed alert and the empty state with the `Browse events` link stay.
- [ ] **Step 3:** Run `pnpm --filter web test`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(web): stage look for my bookings`.

### Task 3: Slice 4 verification and docs

- [ ] **Step 1:** `pnpm check`, `pnpm test`, then `df -h` and `pnpm e2e`. Expected: all green. Fix
      failures before going on.
- [ ] **Step 2: Browser check** with chrome-devtools MCP at 1280 and 390 px: as customer, the
      bookings page with a pending-ticket booking, a ready ticket and a cancellable booking; as
      organizer, `Your events` with a venue and event name of 120 characters without spaces
      (wraps, no sideways scroll) and the create form (keyboard path: Tab through all fields,
      submit with an empty name shows the alert). Check the loading, error and empty state of both
      pages by blocking the request in DevTools. No console errors.
- [ ] **Step 3: Docs.** `docs/BACKLOG.md`: add the "Stage look, slice 4 complete" entry (what
      changed, deviations).
- [ ] **Step 4: Commit** `docs: record stage look slice 4` and push; then
      `gh run list --branch main --limit 1` and fix a red run before slice 5.

---

## Slice 5: Admin

### Task 4: Strategy switch and simulator

**Files:** modify `admin/strategy-switch.html`, `.ts`, `.spec.ts`; `admin/simulator-page.html`,
`.ts`, `.spec.ts`.

**Interfaces:**

- Consumes: `strategyLabel`, `.field`, `.card`, `.badge`, `.btn`, `.btn-secondary`.
- Produces: `protected label(strategy: BookingStrategy): string` on `StrategySwitch` and
  `SimulatorPage` (one line each, delegating to `strategyLabel`). Templates only; no other member
  changes.

- [ ] **Step 1: Write the failing tests.**
  - `strategy-switch.spec.ts`: update `shows the current strategy ...` to expect
    `strategyLabel(BOOKING_STRATEGY.PESSIMISTIC)` in the text (it expects the raw value today and
    goes red by design); new `offers every strategy by label with the raw value`; the confirm
    sentence and `The strategy is now ...` contain the labels of the old and the new strategy.
  - `simulator-page.spec.ts`: the strategy option test as in Task 1; the comparison row header
    contains `strategyLabel(...)` (line with `toContain(BOOKING_STRATEGY.PESSIMISTIC)` changes);
    `Current run: <label>, N buyers, M seats`. The posted body keeps the raw `strategy`.
- [ ] **Step 2:** Run `pnpm --filter web test`. Expected: the changed and new assertions FAIL.
- [ ] **Step 3: Implement.** Switch: `.card p-4` around heading, current strategy as
      `Current strategy: <label>` text (keep the exact prefix, the e2e spec splits on `: `), select
      with `.field`, options by label. Simulator: form in a `.card p-4` with `.field` controls;
      the current run section a `.card`; the metric `dl` as tiles (`.card` per value, the term
      muted above the value); `Double bookings` keeps its text variants (`seats sold twice` stays
      `text-danger` and bold, so the status is not color alone); `<progress>` keeps `aria-label`;
      the comparison table sits in a `.card` with `overflow-x-auto` kept. `Status: <raw>` stays.
- [ ] **Step 4:** Run `pnpm --filter web test`. Expected: PASS. **Mutation check:** revert the
      label in the option text, the confirm sentence and the table row header one at a time; a test
      must go red each time.
- [ ] **Step 5: Commit** `feat(web): stage look for the strategy switch and simulator`.

### Task 5: Audit log

**Files:** modify `admin/audit-log-page.html`.

**Interfaces:** consumes `.field`, `.card`, `.btn`; no new members; visible text unchanged.

- [ ] **Step 1:** Baseline `pnpm --filter web test`: PASS (`audit-log-page.spec.ts` is the guard).
- [ ] **Step 2: Rebuild the template.** Filter select with `.field`; table inside a `.card` that
      keeps `overflow-x-auto`; header row muted, row dividers `border-edge-subtle`; ids stay
      `font-mono text-xs`. Failed state keeps alert plus `Retry`; `Load more` keeps its disabled
      state and label; loading and `No entries` stay.
- [ ] **Step 3:** Run `pnpm --filter web test`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(web): stage look for the audit log`.

### Task 6: Slice 5 verification and docs

- [ ] **Step 1:** `pnpm check`, `pnpm test`, `df -h`, `pnpm e2e`. Expected: all green, including
      `roles.e2e.ts` and `simulator.e2e.ts` unchanged.
- [ ] **Step 2: Browser check** at 1280 and 390 px: as admin, the event page switch (select, confirm
      sentence, error by blocking the PATCH, pending), the simulator (start a small run, live
      tiles, finished table with a double-booking row from the `NAIVE` strategy, error and
      reconnect), the audit log (filter, `Load more`, empty filter result, failed load). Tab through
      each page. The tables scroll inside their cards at 390 px, the page does not. No console
      errors.
- [ ] **Step 3: Docs.** `docs/BACKLOG.md`: "Stage look, slice 5 complete" with deviations (no
      charts exist, the audit log keeps raw action names) and the line that the stage look is
      complete; drop the sentence "keep the raw value until slices 4 and 5" from the slice 1 to 3
      entry. `DESIGN.md`: one line that the strategy is read as a label everywhere except in
      technical identifiers.
- [ ] **Step 4: Commit** `docs: record stage look slice 5`, push, check
      `gh run list --branch main --limit 1`.

## Execution

All six tasks are mechanical (templates, one primitive, label mapping) and add no security, auth,
state or data-loss surface, so no per-task review. Suggested split: one `umsetzer` job per slice
(Tasks 1 to 3, then 4 to 6), then one `pruefer` over the whole range at the end. Log duration and
subagent tokens per task in the ledger and report a sum line.

## Self-review

- **Spec coverage:** slice 4 (my bookings, organizer) Tasks 1 to 3; slice 5 (simulator, audit
  log, strategy switch) Tasks 4 to 6; the label decision of the spec is closed in Task 4;
  "charts" has no target and is recorded as a deviation.
- **Consistency:** `label(strategy)` has the same name and signature in `EventForm`,
  `StrategySwitch` and `SimulatorPage`, as in `EventList` today. `.field` is defined in Task 1 and
  only consumed later.
- **Protection tests:** the label tests go red if the raw value is printed (mutation checks in
  Tasks 1 and 4); the submitted-value tests go red if an option `[value]` is changed to the label.
