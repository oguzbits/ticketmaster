# Stage look, slices 1 to 3: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dark, stage-style shell, start page, event list and event page in `apps/web`, with no
API or contract change.

**Architecture:** Semantic tokens in `styles.css` carry the whole look; three small primitives
(`.btn-secondary`, `.card`, `.badge`) join `.btn`. Pure helper functions (strategy label, event
art, event filter) hold the only new logic and get the unit tests. Pages change markup and
classes; their behavior and states stay.

**Tech Stack:** Angular 22 (standalone, signals), Tailwind v4, Vitest through `ng test`,
Playwright (`pnpm e2e`).

**Spec:** [Stage look redesign](../specs/2026-11-15-stage-look-redesign-design.md)

## Pre-flight

- **Scope:** slices 1 to 3 of the spec. **Out of scope:** slices 4 and 5 (own plan after this
  one), theme switch, real images, any API or `packages/shared` change.
- **Proof:** `pnpm check`, `pnpm test`, `pnpm e2e` green after each slice, plus the browser check
  listed in the last task of the slice. Run `df -h` before `pnpm e2e`.

## Global Constraints

- Own identity: no third-party logo, color scheme, font or image; footer keeps
  `Unofficial demo. Not affiliated with Ticketmaster.`
- Text contrast at least 4.5:1, borders, focus ring and seat edges at least 3:1; seat status never
  by color alone; visible focus; any animation behind `motion-safe:`.
- Every async view keeps loading (`role="status"`), error (`role="alert"` plus retry), empty and
  pending states.
- Components never use `HttpClient`; only semantic tokens, no ad-hoc colors.
- Unit specs and `apps/web/e2e` stay green. Visible text changes only where this plan names it.
- Docs change in the commit of the code they describe; commits are Conventional Commits, end with
  the `Co-Authored-By` line of the session, and go straight to `main`.

## Deviations from the spec (decided here)

- **No lowest price on the event card.** `EventSummary` carries no price and the spec forbids a
  contract change. The card shows date block, venue and strategy badge. Prices appear on the event
  page.
- **No category glyph, a decorative one.** Events have no category. The glyph is picked from a
  fixed list by the event id, so it is stable but carries no meaning (`aria-hidden`).
- **Search is in scope.** `EventsService.list()` returns every visible event (the API query has no
  limit), so the browser holds the complete list and filters it.
- **Accent is magenta, not amber.** Amber is the held-seat color; the accent must not compete
  with it.
- **Strategy label only on the list card and the event page header.** The admin switch, the
  organizer pages and the simulator keep the raw value until slices 4 and 5 (the e2e spec reads
  `Current strategy: <value>`).

## Review Focus

1. A search query with regex characters (`(`, `[`, `.*`) must filter, not throw. Test in Task 3.
2. A whitespace-only query shows the whole list. Test in Task 3.
3. An active query while the list is loading or failed must show the loading or error state, not
   "No events match". Test in Task 4.
4. An event with no seats shows no price categories and no empty heading. Test in Task 6.
5. A very long event or venue name wraps and never scrolls the page sideways at 390 px. Browser
   check in Task 5 and Task 7.

## File Structure

| File                                                         | Responsibility                                |
| ------------------------------------------------------------ | --------------------------------------------- |
| `apps/web/src/styles.css`                                    | tokens, primitives, base                      |
| `apps/web/src/styles.contrast.spec.ts` (new)                 | contrast of every token pair                  |
| `DESIGN.md`                                                  | token table and primitives, dark theme        |
| `apps/web/src/app/app.html`, `app.ts`, `app.spec.ts`         | shell: wordmark, header, search field, footer |
| `apps/web/src/app/events/strategy-label.ts` (+ spec) (new)   | strategy value to readable label, one place   |
| `apps/web/src/app/events/event-art.ts` (+ spec) (new)        | hue and glyph from an event id                |
| `apps/web/src/app/events/event-art-block.ts`, `.html` (new)  | `app-event-art`: gradient block with glyph    |
| `apps/web/src/app/events/event-filter.ts` (+ spec) (new)     | pure filter of the event list                 |
| `apps/web/src/app/events/event-search.store.ts` (new)        | the query signal shared by header and list    |
| `apps/web/src/app/events/event-list.html`, `.ts`, `.spec.ts` | card grid, no-match state                     |
| `apps/web/src/app/start/start-page.html`, `.spec.ts`         | hero and role cards                           |
| `apps/web/src/app/events/seat-map.html`, `.ts`, `.spec.ts`   | two-column layout, side panel                 |
| `docs/BACKLOG.md`                                            | state and deviations                          |

---

## Slice 1: Foundation

### Task 1: Dark tokens, primitives, contrast spec

**Files:** modify `apps/web/src/styles.css`, `DESIGN.md`; create
`apps/web/src/styles.contrast.spec.ts`; swap the three identical
`rounded border border-edge px-4 py-2` buttons (two in `seat-map.html`, one in
`strategy-switch.html`) for `.btn-secondary`.

**Interfaces:**

- Produces tokens (names unchanged, values dark): `surface`, `surface-raised`, `text`,
  `text-muted`, `edge`, `accent` (magenta), `accent-strong`, `on-accent`, `danger`, `focus`, all
  `seat-*`. New: `edge-subtle` (decorative dividers, exempt from contrast, say so in
  `DESIGN.md`) and `--container-page: 75rem` (class `max-w-page`).
- Produces primitives: `.btn`, `.btn-secondary`, `.card` (raised surface, `edge-subtle` border,
  radius), plus `color-scheme: dark` on `:root` so native `select`, scrollbars and inputs are
  dark.
- Seats keep three signals: available is an outlined empty square, held a dashed edge with
  stripes, sold a solid fill with struck-through number.

- [ ] **Step 1: Write the failing contrast spec.** `styles.contrast.spec.ts` reads `styles.css`,
      parses the `@theme` block into a token map and checks a table of pairs (foreground,
      background, minimum). Text pairs at 4.5: `text` and `text-muted` on `surface` and
      `surface-raised`; `danger` on both; `accent` on both (accent is used as link text);
      `on-accent` on `accent` and `accent-strong`; `seat-sold-text` on `seat-sold`; `text` on
      `seat-available` and on `seat-held`. Non-text pairs at 3: `edge`, `focus`,
      `seat-available-edge`, `seat-held-edge` on `surface` and `surface-raised`;
      `seat-sold` on `surface`. Include a test of the ratio helper with known values (black on
      white is 21, `#777777` on white is below 4.5). First confirm `node:fs` is usable inside
      `ng test`; if the builder blocks it, import the CSS with `?raw`.
- [ ] **Step 2:** Run `pnpm --filter web test`. Expected: FAIL (light tokens on a dark pair table,
      or missing tokens).
- [ ] **Step 3: Replace the token values** and add the primitives. Choose the hex values so the
      spec passes: near-black `surface` with a slight cool tint, `surface-raised` one step
      lighter, magenta `accent` with dark `on-accent` only if the ratio holds (otherwise white).
      Do not weaken a pair in the spec to make it pass.
- [ ] **Step 4:** Run `pnpm --filter web test`. Expected: PASS. Hand check: set `text-muted` to a
      value under 4.5 and see the spec go red, then revert.
- [ ] **Step 5: `DESIGN.md`:** update the token table (new tokens, dark values described by
      role), list `.btn-secondary` and `.card`, replace "Light theme only; a dark theme is not
      planned" with "Dark theme only; no theme switch".
- [ ] **Step 6: Commit** `feat(web): dark semantic tokens and contrast spec`.

### Task 2: App shell

**Files:** modify `apps/web/src/app/app.html`, `app.spec.ts`.

**Interfaces:**

- Consumes: tokens and `.card`, `.btn`, `max-w-page` from Task 1; `SessionStore`, `AuthService`
  as today.
- Produces: a shell with the wordmark link (`a[href="/"]`, accessible name
  `ticketmaster-klon`, inline SVG mark with `aria-hidden`, own geometry), `nav` named `Main`
  with the same links and order as today (the wordmark and the sign-in state sit outside the
  `nav`, so `nav a` names stay), `Signed in as <role>` text and the `Log out` button unchanged,
  `main` and the footer with the unchanged notice. Container `max-w-page`, padding that holds at
  390 px, no hamburger menu (the nav wraps).

- [ ] **Step 1:** Run the existing `app.spec.ts` first as the baseline: PASS.
- [ ] **Step 2: Rebuild the template** as above. Header links keep a visible focus ring from the
      base layer; the active route link gets `aria-current="page"` via `routerLinkActive`.
- [ ] **Step 3:** Test case to add in `app.spec.ts`: the wordmark link points to `/` and is not
      inside `nav` (red if someone moves it into the nav, which would break the link-list test of
      the same file).
- [ ] **Step 4:** Run `pnpm --filter web test`. Expected: PASS.
- [ ] **Step 5: Browser check (slice 1)** with the dev server and chrome-devtools MCP: `/`,
      `/events`, one event page, `/bookings`, `/organizer`, `/admin/simulator` at 1280 and 390
      px. Expected: readable text, visible focus ring on every header control by keyboard, seat
      map legend still shows three distinct seat shapes, no horizontal scroll.
- [ ] **Step 6:** `pnpm check`, `pnpm test`, `pnpm e2e`. Expected: all green.
- [ ] **Step 7: Commit** `feat(web): stage-look app shell`.

---

## Slice 2: Start and event list

### Task 3: Pure helpers and the search store

**Files:** create `strategy-label.ts`, `event-art.ts`, `event-filter.ts`,
`event-search.store.ts` and their specs, all in `apps/web/src/app/events/`.

**Interfaces (exact):**

- `strategyLabel(strategy: BookingStrategy): string`, backed by
  `const STRATEGY_LABEL: Record<BookingStrategy, string>` (a missing key fails the typecheck).
  Labels: `NAIVE` "Naive, no lock", `PESSIMISTIC` "Row lock", `OPTIMISTIC` "Optimistic version",
  `REDIS_LOCK` "Redis lock".
- `export const EVENT_GLYPH = { STAGE: 'STAGE', NOTE: 'NOTE', STAR: 'STAR', MASK: 'MASK' } as const`
  and `type EventGlyph` derived from it.
- `eventArt(id: string): { hue: number; glyph: EventGlyph }`, deterministic; `hue` an integer in
  0 to 359.
- `filterEvents(events: EventSummary[], query: string): EventSummary[]`: trims the query, matches
  case-insensitively as a plain substring on `name` and `venueName`, returns the input list for an
  empty query. No `RegExp`. Comment `shortcut: no diacritic folding, add when a name needs it`.
- `EventSearchStore` (`providedIn: 'root'`): `readonly query: WritableSignal<string>`.

- [ ] **Step 1: Write the failing specs.** `strategy-label.spec.ts`: every value of
      `BOOKING_STRATEGY` maps to the label above (exact strings), `REDIS_LOCK` gives `Redis lock`.
      `event-art.spec.ts`: same id gives same result; hue in range for ten sample ids and for the
      empty string; two fixed sample ids give different results; glyph is a member of
      `EVENT_GLYPH`. `event-filter.spec.ts`: empty and whitespace-only query return all events;
      matches name regardless of case; matches venue; trims; no match returns `[]`; queries `(`,
      `[` and `.*` do not throw and return `[]`.
- [ ] **Step 2:** Run `pnpm --filter web test`. Expected: FAIL, modules missing.
- [ ] **Step 3: Implement** the four files to the signatures above.
- [ ] **Step 4:** Run the tests. Expected: PASS. Hand check: replace the plain substring test with
      `new RegExp(query)` and see the regex-character case go red, then revert.
- [ ] **Step 5: Commit** `feat(web): strategy label, event art and event filter helpers`.

### Task 4: Event list as card grid with search

**Files:** create `event-art-block.ts` and `event-art-block.html` (component `EventArtBlock`,
selector `app-event-art`, input
`eventId`, renders the gradient from `eventArt(...).hue` as a CSS custom property plus the glyph
as inline SVG, `aria-hidden`); modify `event-list.html`, `event-list.ts`, `event-list.spec.ts`,
`app.html`, `app.ts`, `app.spec.ts`, `styles.css` (`.badge`, `.event-art` with fixed saturation
and lightness), `DESIGN.md`.

**Interfaces:**

- Consumes: Task 3 helpers, `EventSearchStore`.
- Produces: the list renders a grid (one column below `sm`, three from `lg`). Each card is one
  `<a>` to `/events/:id` whose DOM order is the event name (an `h2`), then venue, then
  `<time [attr.datetime]="startsAt">` as a date block (day and short month), then the badge with
  `strategyLabel`; the art block comes last in the DOM and is placed first visually. The link's
  accessible name therefore starts with the event name, which `e2e/fixtures.ts` relies on
  (`getByRole('link', { name })`, and `/^Your sandbox/` in `roles.e2e.ts`).
- The header search: a `form[role=search]` with an `sr-only` label `Search events` and
  `input[type=search]`, outside the `nav`, shown only while the router URL path is exactly
  `/events`. It writes `EventSearchStore.query`. `EventList` shows
  `filterEvents(list, query())`, clears the query when it is destroyed, and never issues a
  request for a query.
- States: loading and error with retry as today (the query never hides them); empty list says
  `No events yet.`; a non-empty list with no match says `No events match “<query>”.` with a
  `Clear search` button that resets the query.

- [ ] **Step 1: Write the failing tests** in `event-list.spec.ts`: renders one link per event whose
      text starts with the event name; the link has the strategy label and not the raw value; the
      `time` element carries the event's `startsAt` as `datetime` (timezone independent); setting
      the query filters the cards and sends no second request (the existing `verify()` covers
      it); no match shows the no-match text and `Clear search` restores the list; empty list shows
      `No events yet.`; an active query during loading shows `role=status`, and during an error
      shows `role=alert` with retry, never the no-match text. In `app.spec.ts`: the search field
      is present at `/events` and absent at `/` and at `/events/<id>`; typing into it sets
      `EventSearchStore.query`.
- [ ] **Step 2:** Run `pnpm --filter web test`. Expected: FAIL.
- [ ] **Step 3: Implement** the component, template, header search and styles to the interfaces
      above. Remove the old strategy line from the card.
- [ ] **Step 4:** Run `pnpm --filter web test`. Expected: PASS. Hand check: drop the URL condition
      of the header search (field shows on `/`) and the app spec goes red; remove the query reset
      on destroy and navigate away and back, the list spec for it goes red (add that case:
      destroying the list clears the query).
- [ ] **Step 5: `DESIGN.md`:** add `.badge`, `.event-art` and the search field. Commit
      `feat(web): event card grid with strategy badge and client-side search`.

### Task 5: Start page hero

**Files:** modify `start-page.html`, `start-page.spec.ts`, `DESIGN.md`.

**Interfaces:**

- Consumes: `.card`, `.btn`, existing `StartPage` logic (login, pending, error) unchanged.
- Produces: `h1` claim `No seat sold twice.`, a sentence `A live seat map, a short hold while you
pay, and four booking strategies to compare.` (no numbers, no invented evidence), then an `h2`
  `Try it as` and three role cards. Each card is a `<button>` whose accessible name is the role
  name followed by its hint. **No hint may contain another role's name**, because `loginAs` in
  `e2e/fixtures.ts` selects `getByRole('button', { name: role })` by substring. The link
  `Browse events without login` (`a[href="/events"]`), the pending status and the error with
  `Try again` stay.

- [ ] **Step 1: Write the failing test:** for each of the three roles exactly one button's text
      matches the role name case-insensitively (red if a hint names another role). Run it: it
      passes on the old markup, so confirm it by temporarily adding `admin` to the customer hint
      and seeing it go red, then revert. The hero claim has no behavior and gets no test.
- [ ] **Step 2: Rebuild the template**; the existing start-page specs must stay green unchanged.
- [ ] **Step 3: Browser check (slice 2)** at 1280 and 390 px: hero, role cards by keyboard (Tab,
      Enter logs in), disabled cards while pending (throttle the login request), the error with
      retry (block the request), event list with 1, many and zero events, search with and
      without match, a very long event name wraps without sideways scroll, focus ring on cards.
- [ ] **Step 4:** `pnpm check`, `pnpm test`, `pnpm e2e`. Expected: all green.
- [ ] **Step 5: Commit** `feat(web): start page hero with role cards`.

---

## Slice 3: Event page

### Task 6: Two-column layout and booking side panel

**Files:** modify `seat-map.html`, `seat-map.ts`, `seat-map.spec.ts`, `DESIGN.md`.

**Interfaces:**

- Consumes: `app-event-art`, `strategyLabel`, `.card`, `.badge`, `BookingsStore`,
  `WaitingRoomStore` as today. No store or service changes.
- Produces: a page header (`<header>` with the art strip, `h1` event name, date, venue, badge
  with `strategyLabel(strategy() ?? detail.strategy)`); below it a grid: the map in the left
  column, `<aside aria-label="Booking panel">` in the right column (about 22 rem). Live-status
  messages, `announcement` and the refresh error stay above the map. In the panel, top to bottom:
  `app-waiting-room-panel` (customer and gated), the role note for non-customers, the
  `bookings.notice()` paragraph, then either the existing
  `<section aria-label="Your booking">` (all four states untouched, without its old `sticky top-0`
  classes), the `Holding the seat…` status, or for a customer with no booking a one-line hint
  `Pick an available seat on the map.`; last the price categories: a `ul` labelled
  `Price categories` with one `Section <name> · <price>` item per section, omitted when there are
  no sections. The map's section headings keep `Section <name>` and drop the price.
- Layout rules: from `lg` the panel is `sticky` in its column; below `lg` it is a normal block
  after the map, except while `bookings.booking() !== null || bookings.pending() !== null`, when
  it is fixed to the bottom edge (`max-h` about 60 dvh, scrolls) and the page gets bottom padding
  of the same size so the last seat row stays reachable. The idle panel contains no `button`,
  so the existing button-count assertions hold.

- [ ] **Step 1: Write the failing tests** in `seat-map.spec.ts`: after a hold, the
      `Your booking` section is inside the `aside`; the price categories list shows each section
      once with its price, in order; an event with no seats shows no `Price categories` list; the
      `header` shows the strategy label and not the raw value (update the two existing
      assertions that currently expect `BOOKING_STRATEGY.PESSIMISTIC` and `REDIS_LOCK` in
      `header`, after the admin switch too); a customer without booking sees the hint, a
      non-customer sees the role note, in the panel.
- [ ] **Step 2:** Run `pnpm --filter web test`. Expected: FAIL only on the new and updated cases;
      all other existing seat-map specs stay green throughout.
- [ ] **Step 3: Implement** to the interfaces above.
- [ ] **Step 4:** Run `pnpm --filter web test`. Expected: PASS. Hand check: leave the booking
      section outside the `aside` and see the placement test go red; render the price list for an
      empty section array and see the no-seats case go red.
- [ ] **Step 5: `DESIGN.md`:** describe the event page layout and the pinned panel.
- [ ] **Step 6: Commit** `feat(web): event page with booking side panel`.

### Task 7: Verify slice 3 and close the plan

- [ ] **Step 1: Browser check (slice 3)** at 1280 and 390 px with a customer: loading and error
      states of the page (block the detail request), not-found, seat map by keyboard (Tab to a
      seat, Enter holds), hold countdown, `Pay now` and `Cancel hold` disabled while pending, the
      expired-hold alert, confirmation with the `My bookings` link, panel pinned to the bottom
      below `lg` without hiding the last row, waiting-room panel on a gated event, live-status
      messages (stop the stream), admin switch still working, a long event name and a long venue
      name wrap without sideways scroll, reduced motion on.
- [ ] **Step 2:** `df -h`, then `pnpm check`, `pnpm test`, `pnpm e2e`. Expected: all green; fix
      any red run before moving on.
- [ ] **Step 3: `docs/BACKLOG.md`:** add the entry `Stage look, slices 1 to 3 complete` with the
      deviations from this plan. Commit `docs: stage look slices 1 to 3 state`, push, then
      `gh run list --branch main --limit 1` and fix a red run.
- [ ] **Step 4:** Report the DoD receipt (AGENTS.md section 6): contract not needed, observability
      not needed, UI four states verified in the browser, docs updated. Open: slices 4 and 5 get
      their own plan.

## Execution notes

- **Jobs:** one `umsetzer` job per slice (tasks 1 and 2, tasks 3 to 5, tasks 6 and 7). No per-task
  review: nothing here touches security, auth or new state logic (Task 6 moves existing markup,
  existing specs guard it). One `pruefer` review of the whole branch at the end, medium model.
- **Ledger (fill while running):**

| Task | Duration | Subagent tokens |
| ---- | -------- | --------------- |
| 1-2  |          |                 |
| 3-5  |          |                 |
| 6-7  |          |                 |
| Sum  |          |                 |
