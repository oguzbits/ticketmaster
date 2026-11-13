# Design

Visual rules of the web app. Product context and accessibility requirements:
[PRODUCT.md](PRODUCT.md). The tokens live in `apps/web/src/styles.css`; components use these names
and nothing else.

## Tokens

`styles.css` removes Tailwind's default palette (`--color-*: initial` in `@theme`), so a raw palette
class such as `bg-red-500` does not exist and cannot be used by mistake. The tokens are semantic:
they name a role, not a color.

| Token                                                          | Role                                |
| -------------------------------------------------------------- | ----------------------------------- |
| `surface`, `surface-raised`                                    | page background, cards              |
| `text`, `text-muted`                                           | body text, secondary text           |
| `edge`                                                         | borders of interactive elements     |
| `accent`, `accent-strong`, `on-accent`                         | primary action, its hover, its text |
| `danger`                                                       | error text                          |
| `focus`                                                        | focus ring                          |
| `seat-available`, `seat-held`, `seat-held-stripe`, `seat-sold` | seat fills                          |
| `seat-available-edge`, `seat-held-edge`, `seat-sold-text`      | seat borders and text               |

Contrast: text tokens against their surface reach at least 4.5:1, borders and the focus ring at
least 3:1 (WCAG AA). Check a new pair before adding it.

## Components

- **`.btn`**: the primary button (retry, later pay and hold).
- **`.seat`**: one seat. Status is never conveyed by color alone: `seat-available` is an empty
  square with a solid border, `seat-held` has a dashed border and a diagonal stripe fill,
  `seat-sold` is a solid dark fill with a struck-through number. The accessible name states the
  status in words (`Section A, row 3, seat 7, held`), and the page shows a legend.
- **Async views** show one of four states: loading (`role="status"`), empty (a sentence), error
  (`role="alert"` with a retry button) and, for a single resource, not found.

## Behavior

- Every interactive element is reachable by keyboard and shows the focus ring (`:focus-visible`,
  3 px, `focus` token).
- Reduced motion: the app has no animation. A new one must sit behind `motion-safe:`.
- Light theme only; a dark theme is not planned.
- The footer of every page carries the notice that the project is unofficial.
