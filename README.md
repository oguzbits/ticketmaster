# ticketmaster-klon

> Unofficial demo. Not affiliated with Ticketmaster.

A ticket booking system for events with seats. Many buyers compete for the same seats at the same
time, no seat is sold twice, and the seat map updates live for everyone watching.

The target system, its requirements and the phases are described in [docs/PLAN.md](docs/PLAN.md);
the current state is in [docs/BACKLOG.md](docs/BACKLOG.md).

## Quickstart

Requirements: Node 26, pnpm 12 and Docker.

```sh
pnpm install
docker compose up --build   # the whole stack; open http://localhost:8080
```

For development with reload: `pnpm dev` (API on port 3000, web on port 4200).

## Requirements

- Browse public events and see the seat map of an event with the live status of every seat
  (available, held, sold).
- Hold a seat for a short time, pay for it with a simulated payment, cancel it. A seat is never
  sold twice, whichever of the four booking strategies the event uses.
- Keyboard operation, visible focus and a seat status that does not rely on color alone.

## Entities

Venues, events, seats, bookings and their transitions. The tables and relations are in
[docs/data-model.md](docs/data-model.md).

## API

REST routes under `/api`, for example `GET /api/events` and `GET /api/events/:id`. Contracts are Zod
schemas in `packages/shared`; the routes are listed in [docs/api/rest.md](docs/api/rest.md).

## Checks

- `pnpm check`: typecheck, lint, architecture rules, dead code, duplication, audits, formatting.
- `pnpm test`: unit tests, offline.
- `pnpm test:db`: tests that need Postgres and Redis (`pnpm db:up` and `pnpm db:migrate` first).

## Documentation

- [docs/PLAN.md](docs/PLAN.md): goal, requirements, stack, architecture overview, phases.
- [docs/adr/](docs/adr/): architecture decisions.
- [CONTRIBUTING.md](CONTRIBUTING.md): local setup, commands, tests, commits.
- [AGENTS.md](AGENTS.md): layers, invariants and workflow rules, enforced by tools.
- [SECURITY.md](SECURITY.md): how to report a vulnerability.

## License

[MIT](LICENSE)
