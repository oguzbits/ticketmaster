# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Customer:** looks at events, reserves seats on the seat map, pays, sees and cancels their own
  bookings. Often arrives together with thousands of others the moment a sale opens.
- **Organizer:** creates events from venue templates and watches sales status and utilization.
- **Admin (operator):** switches the booking strategy, starts the rush simulator, reads the audit
  log and the system status.

## Product Purpose

ticketmaster-klon sells seats for live events. A seat is held for a short time while the customer
pays, and it is never sold twice, however many people want it at the same moment. Success means: a
customer gets from the event page to a confirmed ticket in a few clicks, always sees the true state
of the seat map, and understands at once when a seat was taken by someone else.

## Positioning

The core is correctness under contention, made visible: the same reservation flow runs with four
locking strategies, and a simulator shows live what each one does when hundreds of buyers want the
same seats (bookings, conflicts, double bookings, latency).

## Operating Context

- A public demo with a one-click demo login per role; every demo user gets events of their own.
- One server, Docker Compose, no paid services. The simulator is limited globally so one visitor
  cannot stall the demo for others.
- Stack, layers and invariants: [AGENTS.md](AGENTS.md), [docs/PLAN.md](docs/PLAN.md).

## Capabilities and Constraints

- Scope and phases: [docs/PLAN.md](docs/PLAN.md). Current state: [docs/BACKLOG.md](docs/BACKLOG.md).
- Payment is simulated (fake payment with an adjustable failure rate). No real money, no real
  tickets.
- UI language is English; a German version is optional.

## Brand Commitments

The name is `ticketmaster-klon`. The footer of every page and the README say that the project is
unofficial and not affiliated with Ticketmaster. No third-party logo, color scheme or other brand
asset is used.

## Evidence on Hand

No customers, testimonials or usage numbers exist. Do not invent any. Numbers shown in the product
come from the simulator and the load tests.

## Product Principles

1. The seat map tells the truth: a seat shown as free can be reserved, or the customer learns
   immediately that it was taken.
2. Trying it costs nothing: one click to a working role, no registration needed.
3. Show the mechanism: conflicts, retries and expired holds are visible, not hidden.
4. Every async view has empty, loading, error and pending states.
5. Authorization lives on the server; the UI only reflects it.

## Accessibility & Inclusion

Keyboard operation and visible focus are required, including on the seat map. Seat status is never
conveyed by color alone. Text contrast meets WCAG AA. Reduced motion is respected. Live changes of
the seat map are announced without stealing focus.
