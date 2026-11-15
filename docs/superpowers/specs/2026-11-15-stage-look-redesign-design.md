# Stage look: web redesign

Visual and layout redesign of `apps/web`. No API, contract or domain change. Product context:
[PRODUCT.md](../../../PRODUCT.md). Current rules: [DESIGN.md](../../../DESIGN.md).

## Goal

Replace the plain single-column text layout with a dark, stage-style ticket portal that follows
common ticket-shop interaction patterns: hero, event card grid, seat map with a booking side panel.
Every page of the app gets the new look.

## Constraints

- **Own identity.** Own palette, own wordmark, own type choices, own generated imagery. No
  third-party logo, color scheme, font or image ([AGENTS.md](../../../AGENTS.md) rule 12). Layout
  and interaction patterns are generic and may be shared.
- Name stays `ticketmaster-klon`; the unofficial notice stays in the footer.
- Accessibility rules of [PRODUCT.md](../../../PRODUCT.md) hold in the dark theme: text contrast
  at least 4.5:1, borders and focus ring at least 3:1, seat status never by color alone, visible
  focus, reduced motion respected.
- Every async view keeps empty, loading, error with retry, and pending states.
- Unit specs and the Playwright specs in `apps/web/e2e` stay green. Selectors by role and text may
  change only where the visible text changes on purpose.
- Components never use `HttpClient`; only semantic tokens, no ad-hoc colors.

## Decisions

- **Dark theme** replaces the light tokens (no theme switch).
- **Event imagery:** a CSS gradient derived from the event id plus a category glyph. No image
  files.
- **Libraries:** no styled component library. Own primitives stay. `@angular/aria` or the CDK may
  be added in a slice that needs a menu, dialog or combobox; verify the current docs first.
  spartan/ui was considered and rejected for now: its copied `helm` code has to pass `pnpm check`
  (jscpd, knip, ESLint rules) and its variables compete with the semantic tokens. Revisit only
  with a spike of one component.
- **Strategy label:** the booking strategy is shown as a readable badge (for example "Redis
  lock"), mapped in one place from the shared dictionary, not as the raw value.

## Slices

Each slice is one topic per commit, verified in the browser, and leaves `pnpm check` and
`pnpm test` green.

1. **Foundation.** New dark tokens in `styles.css`, `DESIGN.md` updated in the same commit. Wider
   container (about 1200 px). App shell: wordmark, header with navigation and role state, footer.
   Contrast of every token pair checked.
2. **Start and event list.** Hero with claim and the three demo roles as cards. Event list as a
   card grid: generated gradient, date block, venue, lowest price, strategy badge. Search field in
   the header filters the list client-side only if the list is already complete in the browser;
   otherwise the search is out of scope (filtering belongs in PostgreSQL).
3. **Event page.** Seat map on the left. Right side panel: price categories, selected seat, hold
   countdown, pay and cancel, confirmation. The existing booking panel (`aria-label="Your
booking"`) moves into this panel and keeps all its states. On narrow screens the panel is
   sticky at the bottom. Waiting-room panel and live-status messages keep their behavior.
4. **My bookings and organizer.** Same tokens and card primitives.
5. **Admin (simulator, audit log, strategy switch).** Same tokens; tables and charts restyled,
   no behavior change.

Slices 4 and 5 are detailed in their own plan once slice 3 is done.

## Testing and verification

- Behavior tests stay at the lowest layer; add a test only where behavior changes (for example the
  strategy label mapping). Purely visual changes get no test, only a browser check.
- Per slice: `pnpm check`, `pnpm test`, and the affected Playwright specs through `pnpm e2e`.
- Browser check of each changed page at desktop and phone width, including the keyboard path and
  the four async states.

## Out of scope

- Theme switch, German version, real photos, renaming the product, new features or API changes.
- Search that would load whole tables into the browser.

## Open points

- Palette and wordmark are chosen in slice 1 (accent candidates: magenta or amber), checked for
  contrast before use.
- The product name contains a third-party trademark; renaming is a separate decision.
