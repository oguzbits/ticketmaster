# Light portal redesign

Visual redesign of `apps/web` from the dark stage look to a light, classic ticket portal. No API,
contract or domain change. It supersedes the decision "dark theme, no theme switch" of the
[stage look spec](2026-11-15-stage-look-redesign-design.md); everything else in that spec
(constraints, async states, accessibility rules) still holds. Product context:
[PRODUCT.md](../../../PRODUCT.md). Current rules: [DESIGN.md](../../../DESIGN.md).

## Goal

The app should read like a familiar ticket shop: a light page, white cards with a soft shadow, a
bold hero with search, event cards with imagery, a seat map with a clear booking panel, and plain
tables and forms for the admin pages.

## Constraints

- **Own identity, no copied brand.** The project is public on GitHub, and
  [AGENTS.md](../../../AGENTS.md) rule 12 forbids third-party logo and brand assets. So: no logo,
  no brand colors, no typeface, no imagery and no page-for-page copy of any ticket shop. Layout
  and interaction patterns common to ticket shops (hero with search, card grid, seat map with a
  side panel) are generic and are what this redesign follows. The own wordmark, the generated
  event art and an own accent color stay.
- Accessibility rules of [PRODUCT.md](../../../PRODUCT.md) hold on the light theme: text contrast
  at least 4.5:1, borders, focus ring and seat edges at least 3:1 against both the page and the
  card surface, seat status never by color alone, visible focus, reduced motion respected.
- Every async view keeps empty, loading, error with retry and pending states.
- Unit specs and the Playwright specs in `apps/web/e2e` stay green. Visible text changes only
  where the plan names it.
- Components never use `HttpClient`; only semantic tokens, no ad-hoc colors.

## Decisions

- **Light theme only**, no theme switch. The page is a light cool gray, cards are white.
- **Accent: indigo.** It is not amber (held seat) and not green (available seat), and it is not
  the blue family of the shop this pattern is common to.
- **Elevation:** one soft shadow token for cards that are links or panels; flat cards keep the
  subtle border. Hover lifts only behind `motion-safe:`.
- **Hero search on the start page** is the one new behavior: it sets the shared search query and
  opens the event list, where the existing client-side filter applies. No API change.
- **Event page header** keeps the art strip above and the title block below it (no text on the
  generated gradient, so contrast does not depend on the hue).
- **No filters, no prices on cards, no new data.** `EventSummary` carries no price and the
  contract stays.

## Slices

Each slice is one topic per commit, verified in the browser, and leaves `pnpm check` and
`pnpm test` green.

1. **Foundation.** Light tokens, contrast spec, shadow token, base styles.
2. **Shell and start page.** Header, footer, hero band with search, role cards.
3. **Event list and event page.** Cards, event header, stage bar, seat map, booking panel.
4. **Account, organizer and admin pages.** Tables, forms, metric tiles on the light theme.

## Out of scope

- Theme switch, German version, real photos, renaming the product, filters, prices, any API
  change.

## Open points

- The exact hex values are chosen in slice 1 and checked by the contrast spec.
