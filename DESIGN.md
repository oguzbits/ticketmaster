# Design

Visual rules of the web app. Product context and accessibility requirements:
[PRODUCT.md](PRODUCT.md). The tokens live in `apps/web/src/styles.css`; components use these names
and nothing else.

## Tokens

`styles.css` removes Tailwind's default palette (`--color-*: initial` in `@theme`), so a raw palette
class such as `bg-red-500` does not exist and cannot be used by mistake. The tokens are semantic:
they name a role, not a color.

| Token                                                          | Role                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------- |
| `surface`, `surface-raised`                                    | page background (light cool gray), cards (white)            |
| `text`, `text-muted`                                           | body text, secondary text                                   |
| `edge`                                                         | borders of interactive elements                             |
| `edge-subtle`                                                  | decorative dividers and card borders, exempt from contrast  |
| `accent`, `accent-strong`, `on-accent`                         | indigo: primary action and link text, its hover, text on it |
| `danger`                                                       | error text                                                  |
| `focus`                                                        | focus ring                                                  |
| `seat-available`, `seat-held`, `seat-held-stripe`, `seat-sold` | seat fills                                                  |
| `seat-available-edge`, `seat-held-edge`, `seat-sold-text`      | seat borders and text                                       |

The accent is indigo, not amber (held seat) and not green (available seat), so it competes with
neither. `--shadow-card` is the one soft elevation token. `--container-page` (class `max-w-page`, 75 rem) is the page width.

Contrast: text tokens against their surface reach at least 4.5:1, borders and the focus ring at
least 3:1 (WCAG AA). `apps/web/src/styles.contrast.spec.ts` checks every pair; add a new pair to
its table before using it.

## Components

- **`.card-link`**: a `.card` that is a link or a panel: `shadow-card`, and under
  `prefers-reduced-motion: no-preference` a 1 px lift on hover. A flat `.card` keeps the subtle border.
- **`.btn`**: the primary button (retry, pay, hold).
- **`.btn-secondary`**: the outlined button for the second action next to a `.btn` (cancel, close).
- **`.card`**: a raised surface with an `edge-subtle` border and a radius. A card that is itself a
  control (the event card, the start page role card) adds `border-edge` (3:1) and `hover:border-accent`;
  a card that only holds content (the booking panel) keeps `edge-subtle`.
- **`.badge`**: a small bordered label on the surface, used for the booking strategy
  (`strategyLabel`, never the raw value). Every page reads the strategy as the label, except
  the audit log, whose action names and ids are identifiers; option values and request bodies
  stay raw.
- **`.field`**: the border and background of an `input`, `select` or `textarea` (`edge` border, 3:1,
  on the raised surface). Disabled styling stays a utility on the element.
- **`.event-art`** (`app-event-art`): a decorative gradient block with a glyph, derived from the
  event id. The id sets only the hue (`--event-hue`, the one allowed dynamic color); saturation and
  lightness are fixed in `styles.css`. Hidden from assistive technology.
- **Event card**: one `.card-link` to the event (shadow, lift on hover under `motion-safe`); the
  name is first in the DOM (`h2`), then venue, date block and badge. The art block comes last in the DOM and is shown first (`order-first`), so the
  link name starts with the event name.
- **Organizer event card**: the event card with the counts line (sold, held, utilization) in place
  of the date block; the strategy is the label badge. The create form is a `.card`.
- **Stage bar**: a plain bar with the text `Stage` above the legend of the seat map; decorative,
  hidden from assistive technology (`aria-hidden`).
- **Search field**: in the header, only on `/events`; filters the list in the browser (the list
  is complete there). It is a plain `input[type=search]` with a screen-reader label.
- **Start page**: an indigo hero band (`accent` background, `on-accent` text) with the claim as
  `h1`, the supporting sentence and a search form (`Search events`, button `Search`) on a white
  bar. Submitting sets the shared `EventSearchStore.query` and opens `/events`, where the existing
  client-side filter applies; an empty query opens the full list. Below it `Try it as` with one
  `.card-link` button per demo role. The accessible name of a card is the role followed by its
  hint; a hint never names another role, because the e2e specs select a card by the role name.
- **Header and footer**: white surfaces; the header carries `shadow-card`. The header search field
  shows on `/events` only; the hero form is a second search form on `/`.
- **Event page**: a header card (art strip on top, below it a white block with `h1`, date, venue and
  strategy badge; no text sits on the generated gradient), then two columns from `lg`: the seat map
  on the left, on a white card that starts with the stage bar, the booking panel (`aside`, 22 rem,
  `sticky`, white card with `shadow-card`) on the right. The panel
  holds, top to bottom, the waiting room, the role note, the notice, the booking (`Your booking`
  with all its states) or the hint to pick a seat, and the price categories. Idle, it contains no
  button. Live-status messages and the refresh error stay above the map. Below `lg` the panel
  follows the map; while a booking is in progress it sticks to the bottom edge (`max-h` 40 dvh,
  scrolls) and hides the price categories, so the last seat row stays reachable at the end of the
  page. The seats then carry a `scroll-margin-bottom` of 40 dvh plus half a rem, so a seat focused
  by keyboard scrolls clear of the panel (WCAG 2.4.11); the margin applies only while pinned. While a waiting room still blocks holding, the panel does not tell the customer to pick a
  seat, and below `lg` it comes before the map (`order-first`) so the customer finds the way in.
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
- Light theme only; no theme switch. `color-scheme: light` is set on `:root` so native controls follow.
- The footer of every page carries the notice that the project is unofficial.
