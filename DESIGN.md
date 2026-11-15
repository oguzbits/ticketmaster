# Design

Visual rules of the web app. Product context and accessibility requirements:
[PRODUCT.md](PRODUCT.md). The tokens live in `apps/web/src/styles.css`; components use these names
and nothing else.

## Tokens

`styles.css` removes Tailwind's default palette (`--color-*: initial` in `@theme`), so a raw palette
class such as `bg-red-500` does not exist and cannot be used by mistake. The tokens are semantic:
they name a role, not a color.

| Token                                                          | Role                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| `surface`, `surface-raised`                                    | page background (near-black, cool tint), cards one step lighter |
| `text`, `text-muted`                                           | body text, secondary text                                       |
| `edge`                                                         | borders of interactive elements                                 |
| `edge-subtle`                                                  | decorative dividers and card borders, exempt from contrast      |
| `accent`, `accent-strong`, `on-accent`                         | magenta: primary action and link text, its hover, text on it    |
| `danger`                                                       | error text                                                      |
| `focus`                                                        | focus ring                                                      |
| `seat-available`, `seat-held`, `seat-held-stripe`, `seat-sold` | seat fills                                                      |
| `seat-available-edge`, `seat-held-edge`, `seat-sold-text`      | seat borders and text                                           |

The accent is magenta, not amber: amber is the color of a held seat and the accent must not
compete with it. `--container-page` (class `max-w-page`, 75 rem) is the page width.

Contrast: text tokens against their surface reach at least 4.5:1, borders and the focus ring at
least 3:1 (WCAG AA). `apps/web/src/styles.contrast.spec.ts` checks every pair; add a new pair to
its table before using it.

## Components

- **`.btn`**: the primary button (retry, pay, hold).
- **`.btn-secondary`**: the outlined button for the second action next to a `.btn` (cancel, close).
- **`.card`**: a raised surface with an `edge-subtle` border and a radius.
- **`.badge`**: a small bordered label on the surface, used for the booking strategy
  (`strategyLabel`, never the raw value).
- **`.event-art`** (`app-event-art`): a decorative gradient block with a glyph, derived from the
  event id. The id sets only the hue (`--event-hue`, the one allowed dynamic color); saturation and
  lightness are fixed in `styles.css`. Hidden from assistive technology.
- **Event card**: one link to the event; the name is first in the DOM (`h2`), then venue, date
  block and badge. The art block comes last in the DOM and is shown first (`order-first`), so the
  link name starts with the event name.
- **Search field**: in the header, only on `/events`; filters the list in the browser (the list
  is complete there). It is a plain `input[type=search]` with a screen-reader label.
- **Start page**: the claim as `h1`, then `Try it as` with one `.card` button per demo role. The
  accessible name of a card is the role followed by its hint; a hint never names another role,
  because the e2e specs select a card by the role name.
- **Event page**: a header (art strip, `h1`, date, venue, strategy badge), then two columns from `lg`:
  the seat map on the left, the booking panel (`aside`, 22 rem, `sticky`) on the right. The panel
  holds, top to bottom, the waiting room, the role note, the notice, the booking (`Your booking`
  with all its states) or the hint to pick a seat, and the price categories. Idle, it contains no
  button. Live-status messages and the refresh error stay above the map. Below `lg` the panel
  follows the map; while a booking is in progress it sticks to the bottom edge (`max-h` 60 dvh,
  scrolls) and hides the price categories, so the last seat row stays reachable at the end of the
  page. While a waiting room still blocks holding, the panel does not tell the customer to pick a
  seat.
- **`.seat`**: one seat. Status is never conveyed by color alone: `seat-available` is an empty
  square with a solid border, `seat-held` has a dashed border and a diagonal stripe fill,
  `seat-sold` is a solid filled square with a struck-through number. The accessible name states the
  status in words (`Section A, row 3, seat 7, held`), and the page shows a legend.
- **Async views** show one of four states: loading (`role="status"`), empty (a sentence), error
  (`role="alert"` with a retry button) and, for a single resource, not found.

## Behavior

- Every interactive element is reachable by keyboard and shows the focus ring (`:focus-visible`,
  3 px, `focus` token).
- Reduced motion: the app has no animation. A new one must sit behind `motion-safe:`.
- Dark theme only; no theme switch. `color-scheme: dark` is set on `:root` so native controls follow.
- The footer of every page carries the notice that the project is unofficial.
