# Architecture

The system is a modular monolith plus a worker
([ADR 0001](adr/0001-modular-monolith-and-worker.md)). The runtime picture (browser, Caddy, the API
replicas, PostgreSQL, Redis, the queue) is the diagram in the [README](../README.md#architecture).
This page shows the code: who may depend on whom.

## Layers

- `packages/shared` holds the contracts (Zod schemas, inferred types, dictionaries) and nothing else.
  Every app depends on it; it depends on no app.
- Each API module has a `domain/` folder of pure logic that defines the ports; controllers, services
  and adapters sit around it. `infrastructure` holds the adapters shared by modules (database,
  cache, queue client, metrics, tracing), `core` the logic several modules share.
- A module imports another module only through its `index.ts`. The worker reuses the API's modules
  the same way; the API never imports the worker.

`pnpm depcruise` enforces this and fails on a forbidden edge or a cycle. The rules are in
[AGENTS.md](../AGENTS.md#1-layers-enforced-by-pnpm-depcruise-and-eslint).

## Module graph

An arrow means "imports". Specs, test support and the packages every module uses
(`packages/shared`, the config module) are left out. The graph is generated from the code by
`pnpm docs:generate`; `pnpm check` fails when it is stale. The full file-level graph for a
Mermaid viewer is `pnpm depcruise:graph`.

<!-- prettier-ignore-start -->
<!-- generated:modules -->
```mermaid
flowchart LR
  worker["worker"]
  subgraph api["apps/api"]
    subgraph modules["modules"]
      audit["audit"]
      auth["auth"]
      bookings["bookings"]
      demo["demo"]
      event_cache["event-cache"]
      events["events"]
      health["health"]
      organizer["organizer"]
      outbox["outbox"]
      simulations["simulations"]
      tickets["tickets"]
      waiting_room["waiting-room"]
    end
    core["core"]
    infrastructure["infrastructure"]
  end
  audit --> auth
  audit --> core
  audit --> infrastructure
  bookings --> audit
  bookings --> auth
  bookings --> core
  bookings --> infrastructure
  bookings --> outbox
  bookings --> waiting_room
  demo --> auth
  demo --> bookings
  demo --> core
  demo --> infrastructure
  event_cache --> infrastructure
  events --> audit
  events --> auth
  events --> bookings
  events --> event_cache
  events --> infrastructure
  health --> auth
  health --> infrastructure
  health --> outbox
  infrastructure --> auth
  infrastructure --> core
  organizer --> audit
  organizer --> auth
  organizer --> core
  organizer --> event_cache
  organizer --> infrastructure
  outbox --> core
  outbox --> infrastructure
  simulations --> audit
  simulations --> auth
  simulations --> bookings
  simulations --> core
  simulations --> infrastructure
  tickets --> auth
  tickets --> demo
  tickets --> infrastructure
  waiting_room --> audit
  waiting_room --> auth
  waiting_room --> core
  waiting_room --> event_cache
  waiting_room --> infrastructure
  worker --> bookings
  worker --> demo
  worker --> infrastructure
  worker --> outbox
  worker --> simulations
  worker --> tickets
  worker --> waiting_room
```
<!-- /generated -->
<!-- prettier-ignore-end -->
