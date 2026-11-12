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

## Checks

- `pnpm check`: typecheck, lint, architecture rules, dead code, duplication, audits, formatting.
- `pnpm test`: unit tests, offline.

## Documentation

- [docs/PLAN.md](docs/PLAN.md): goal, requirements, stack, architecture overview, phases.
- [docs/adr/](docs/adr/): architecture decisions.
- [CONTRIBUTING.md](CONTRIBUTING.md): local setup, commands, tests, commits.
- [AGENTS.md](AGENTS.md): layers, invariants and workflow rules, enforced by tools.
- [SECURITY.md](SECURITY.md): how to report a vulnerability.

## License

[MIT](LICENSE)
