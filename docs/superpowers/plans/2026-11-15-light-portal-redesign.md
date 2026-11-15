# Light portal redesign: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the dark stage look into a light, classic ticket portal with an own indigo accent,
without an API or contract change.

**Architecture:** The semantic tokens in `styles.css` carry the whole look, so the theme flips in
one commit (Task 1) and the later tasks adjust layout and elevation. The only new behavior is the
hero search on the start page, which reuses the existing `EventSearchStore`.

**Tech Stack:** Angular 22 (standalone, signals), Tailwind v4, Vitest through `ng test`,
Playwright (`pnpm e2e`).

**Spec:** [Light portal redesign](../specs/2026-11-15-light-portal-redesign-design.md)

## Pre-flight

- **Scope:** the four slices of the spec. **Out of scope:** theme switch, filters, prices on
  cards, real images, copying any shop's logo, colors, fonts or pages, any API change.
- **Proof:** `pnpm check`, `pnpm test`, `pnpm e2e` green after each slice, plus the browser check
  in the last task of the slice. Run `df -h` before `pnpm e2e`. `pnpm e2e` needs ports 8080 and
  8081, which the local dev stack holds: ask the user before stopping it, restart it afterwards.

## Global Constraints

- Ticket-shop look; own wordmark and generated event art stay; footer keeps
  `Unofficial demo. Not affiliated with Ticketmaster.`
- Text contrast at least 4.5:1, borders, focus ring and seat edges at least 3:1, each against the
  page surface and the card surface; seat status never by color alone; visible focus; animation
  behind `motion-safe:`.
- Every async view keeps loading (`role="status"`), error (`role="alert"` plus retry), empty and
  pending states. Components never use `HttpClient`; only semantic tokens, no ad-hoc colors.
- Unit specs and `apps/web/e2e` stay green. Visible text changes only where this plan names it.
- A value that is submitted or compared stays the raw enum value; people read the strategy as its
  label (`strategyLabel`).
- Docs change in the commit of the code they describe. Conventional Commits, `Co-Authored-By`
  line of the session, straight to `main`.

## Review Focus

1. Every token pair reaches its ratio on both the page and the card surface, including the focus
   ring and the three seat edges. Test in Task 1.
2. An empty or whitespace-only hero query opens the full event list, a query with regex
   characters filters and does not throw. Tests in Task 2.
3. The hero search never submits twice and never navigates away from a typed query. Test in
   Task 2.
4. Held, available and sold seats stay distinguishable without color on the light theme. The
   existing seat map spec stays green; browser check in Task 4.
5. Dark leftovers: any element that still assumes a dark surface (white text, `stroke` of the
   wordmark, native controls) is found in the browser check of Task 1.

## File Structure

| File                                                              | Responsibility                            |
| ----------------------------------------------------------------- | ----------------------------------------- |
| `apps/web/src/styles.css`, `apps/web/src/styles.contrast.spec.ts` | light tokens, shadow token, contrast      |
| `DESIGN.md`                                                       | token table, primitives, light theme      |
| `apps/web/src/app/app.html`, `app.spec.ts`                        | header, footer                            |
| `apps/web/src/app/start/start-page.html`, `.ts`, `.spec.ts`       | hero band, hero search, role cards        |
| `apps/web/src/app/events/event-list.html`                         | card grid on the light theme              |
| `apps/web/src/app/events/seat-map.html`                           | event header, stage bar, booking panel    |
| `apps/web/src/app/{bookings,organizer,admin}/*.html`              | tables, forms and tiles on the light page |
| `docs/BACKLOG.md`                                                 | state and deviations                      |

---

## Slice 1: Foundation

### Task 1: Light tokens, shadow token, contrast spec

**Files:** modify `apps/web/src/styles.css`, `apps/web/src/styles.contrast.spec.ts`, `DESIGN.md`.

**Interfaces:**

- Produces tokens (names unchanged, values light): `surface` (page, light cool gray, start near
  `#f4f5f8`), `surface-raised` (card, white), `text` (near-black), `text-muted`, `edge`,
  `edge-subtle`, `accent` (indigo, start near `#4338ca`), `accent-strong` (darker on hover),
  `on-accent` (white), `danger` (dark red), `focus` (blue distinct from the accent), all `seat-*`:
  available is a white fill with a green edge, held a pale amber fill with darker amber stripes
  and edge, sold a solid mid gray with white text. Starting values are hints; the spec decides.
- Produces `--shadow-card` in `@theme` (soft, low-contrast) and the class `.card-link` in
  `@layer components`: a `.card` that is a link or panel, `shadow-card`, and under `motion-safe:`
  a 1 px lift on hover. Existing `.card` stays flat.
- `:root` gets `color-scheme: light`.

- [ ] **Step 1: Write the failing tests** in `styles.contrast.spec.ts`: `the theme is light`
      (the luminance of `surface-raised` is above 0.9, that of `surface` above 0.8, that of `text`
      below 0.1); `a divider is visible on the page` (`edge-subtle` on `surface` at least 1.1);
      `on-accent` on `accent` and on `accent-strong` at 4.5 stays in `PAIRS`. The existing text and
      non-text pairs stay for both `SURFACES`, and the ratio helper test stays.
- [ ] **Step 2:** Run `pnpm --filter web test`. Expected: `the theme is light` FAILS (dark
      tokens); the other new tests may pass.
- [ ] **Step 3: Replace the token values** and add the shadow token, `.card-link` and
      `color-scheme: light`. Choose hex values so the spec passes; never weaken a pair.
- [ ] **Step 4:** Run `pnpm --filter web test`. Expected: PASS. Hand check: set `text-muted` to a
      value under 4.5 and see the spec go red, then revert.
- [ ] **Step 5: Browser check of every page** (customer, organizer, admin, logged out) for dark
      leftovers: white text on white, a wordmark that vanishes, dark native controls, the green
      progress bar. Fix each by token, never by a raw color. Add a pair to the spec for any new
      token use.
- [ ] **Step 6: `DESIGN.md`:** token table (light values by role, indigo accent and why), the
      `.card-link` primitive, "Light theme only; no theme switch" with `color-scheme: light`.
- [ ] **Step 7: Commit** `feat(web): light semantic tokens and contrast spec`.

## Slice 2: Shell and start page

### Task 2: Header, footer, hero with search

**Files:** modify `apps/web/src/app/app.html`, `apps/web/src/app/start/start-page.html`,
`start-page.ts`, `start-page.spec.ts`.

**Interfaces:**

- Consumes: `EventSearchStore` (the `query` signal shared with the header search),
  `Router`, `.btn`, `.card-link`, `max-w-page`.
- Produces on `StartPage`: `protected search(event: Event, value: string): void` which prevents
  the default, sets `EventSearchStore.query` to `value` and navigates to `/events`. The form has
  an input labelled `Search events` and a submit button `Search`.
- Header: white bar with a bottom shadow, wordmark, `nav` named `Main`, sign-in state; footer light
  with the unchanged notice. Hero: an indigo band (token `accent` as background, `on-accent` text)
  with the claim as `h1`, the supporting sentence and the search form; the role cards below stay
  `.card-link` buttons whose accessible name is role plus hint (the e2e specs select by role).

- [ ] **Step 1: Write the failing tests** in `start-page.spec.ts`: - `searching opens the event list with the query`: type `jazz`, submit, the query signal is
      `jazz` and the router is at `/events`. - `an empty query opens the full list`: submit with nothing, the query is an empty string
      and the router is at `/events`. - `regex characters are stored as typed`: `(` and `.*` stay verbatim, nothing throws.
- [ ] **Step 2:** Run `pnpm --filter web test`. Expected: the three tests FAIL (no form).
- [ ] **Step 3: Implement** `search` and the hero template; restyle header and footer.
- [ ] **Step 4:** Run `pnpm --filter web test`. Expected: PASS. Mutation check: drop the
      `preventDefault` and drop the navigation, one at a time; a test must go red each time.
- [ ] **Step 5: Commit** `feat(web): light shell and start page with hero search`.

### Task 3: Slice 2 verification and docs

- [ ] **Step 1:** `pnpm check`, `pnpm test`, `df -h`, `pnpm e2e` (ask before stopping the dev
      stack). Expected: all green.
- [ ] **Step 2: Browser check** at 1280 and 390 px: the start page, a search that finds events, a
      search that finds none (the existing no-match state), keyboard path through the hero.
- [ ] **Step 3: Docs.** `DESIGN.md` hero and start page; `docs/BACKLOG.md` entry for slices 1 and 2. **Commit** `docs: record light portal slices 1 and 2`, push, check
      `gh run list --branch main --limit 1`.

## Slice 3: Event list and event page

### Task 4: Cards, event header, stage bar, booking panel

**Files:** modify `apps/web/src/app/events/event-list.html`, `seat-map.html`,
`apps/web/src/app/events/seat-map.spec.ts` only if a visible text changes.

**Interfaces:**

- Consumes `.card-link`, `shadow-card`, tokens from Task 1; `app-event-art`; `strategyLabel`.
- Produces: event cards as `.card-link` with the art block on top and the date block, name,
  venue and strategy badge unchanged in the DOM order (name first, art last and `order-first`).
  Event page: art strip, then a white title block (`h1`, date, venue, badge), a `Stage` bar above
  the seat map (a plain bar with the text `Stage`, `aria-hidden`), the seat map on a white card,
  and the booking `aside` as an elevated white card. All panel states and the sticky behavior
  below `lg` stay as in `DESIGN.md`.

- [ ] **Step 1:** Baseline `pnpm --filter web test`: PASS (the existing specs guard behavior; no
      new test, the change is visual).
- [ ] **Step 2: Rebuild the templates** as described; the seat map keeps the legend.
- [ ] **Step 3:** Run `pnpm --filter web test`. Expected: PASS.
- [ ] **Step 4: Browser check** at 1280 and 390 px: the list with a long event name, the event
      page idle, with a held seat, with a waiting room, after payment. The three seat statuses must
      be told apart without color. Keyboard: tab to a seat, the focus ring shows on white.
- [ ] **Step 5: `DESIGN.md`:** event card, event page, stage bar. **Commit**
      `feat(web): light event list and event page`.

## Slice 4: Account, organizer and admin

### Task 5: Pages behind the login

**Files:** modify `apps/web/src/app/bookings/my-bookings.html`,
`apps/web/src/app/organizer/organizer-events.html`, `event-form.html`,
`apps/web/src/app/admin/simulator-page.html`, `audit-log-page.html`, `strategy-switch.html`.

**Interfaces:** consumes `.card`, `.card-link`, `.field`, `.badge`, tokens; no new members.

- [ ] **Step 1:** Baseline `pnpm --filter web test`: PASS.
- [ ] **Step 2: Adjust** the pages for the light surface: table header band on `surface`, row
      dividers `edge-subtle`, `.card-link` for the organizer event cards, metric tiles flat
      (`.card`) inside a flat run card without a second border (the double border of slice 5
      goes away: the tiles drop their border and use `surface` as background), forms on a white
      card with `.field` inputs. No text changes.
- [ ] **Step 3:** Run `pnpm --filter web test`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(web): light account, organizer and admin pages`.

### Task 6: Final verification and docs

- [ ] **Step 1:** `pnpm check`, `pnpm test`, `df -h`, `pnpm e2e`. Expected: all green.
- [ ] **Step 2: Browser check** at 1280 and 390 px of each page of Task 5, including the
      simulator with a finished run, the audit log table and an empty form submit. Tab through
      each page.
- [ ] **Step 3: Docs.** `docs/BACKLOG.md`: "Light portal redesign complete" with deviations and
      the line that the dark stage look is replaced; mark the "dark theme" decision of the stage
      look spec as superseded in its first paragraph. **Commit** with the subject `docs: record light portal redesign`, push, check `gh run list --branch main --limit 1`.

## Execution

Mostly mechanical (tokens, templates). The one logic task (Task 2) is small and unit-tested. No
security, auth or state surface, so no per-task review: one `pruefer` over the whole range at the
end. Log duration and subagent tokens per task and report a sum line.

## Self-review

- **Spec coverage:** slice 1 Task 1, slice 2 Tasks 2 and 3, slice 3 Task 4, slice 4 Tasks 5 and
  6; the hero search is the one new behavior and has its tests; the "own identity" constraint is
  in the Global Constraints.
- **Consistency:** `EventSearchStore.query` is the signal the header search already uses (Task 2
  consumes it, does not redefine it); `.card-link` is defined in Task 1 and only consumed later.
- **Protection tests:** contrast pairs go red on a weak token (hand check in Task 1); the hero
  search tests go red when the navigation or the `preventDefault` is removed (Task 2).
