# 0001: Modular monolith plus worker

- Status: accepted
- Date: 2026-11-13

## Context and problem statement

The system sells seats under heavy contention. A booking touches the seat, the hold, the payment and
the booking history, and it must never sell a seat twice. The API has to scale horizontally, slow
work (ticket PDF, email, hold expiry, the load simulator) must not slow down requests, and the whole
system runs on one server with Docker Compose and without paid services.

## Decision drivers

- Correctness of a booking rests on one database transaction (row locks, version checks).
- Horizontal scaling of the request path.
- Slow and scheduled work is isolated from request latency.
- One small server; operations stay simple.
- Module boundaries stay visible and enforceable.

## Considered options

1. Modular monolith (one NestJS API, several instances) plus one worker process
2. Microservices (inventory, booking, payment, notification)
3. A single process that also runs jobs and consumers
4. Any of the above on Kubernetes

## Decision outcome

Chosen: option 1. The API is one deployable with a module per domain area. It keeps no state in
memory (locks, rate limits, sessions and pub/sub live in Redis), so Caddy balances any number of
instances. The worker is a second NestJS application without an HTTP server. It consumes the queue
and runs scheduled jobs and the simulator, and it reuses the API's modules through their public
interface (`index.ts`), so the domain logic and the database schema exist once.

### Consequences

- Good: a booking is one local transaction; no saga, no distributed lock across services.
- Good: API and worker scale and restart independently; a busy simulator cannot starve requests.
- Good: boundaries are checked by dependency-cruiser (modules import each other only through
  `index.ts`, domain code is free of I/O), so a module can be split off later if a real need shows.
- Bad: all modules deploy together, and one PostgreSQL primary is the write limit. The architecture
  docs describe where the system breaks first.
- Bad: module boundaries hold only as long as the tooling enforces them.

## Pros and cons of the options

### Microservices

- Good: independent deployment and scaling per service.
- Bad: reserving and paying would span services, so the local transaction becomes a saga with
  compensation, exactly where consistency matters most.
- Bad: several databases, service discovery and many more containers on one small server.

### A single process

- Good: the simplest deployment.
- Bad: PDF rendering, the simulator and expiry jobs compete with requests for the event loop, and
  every API instance would run the scheduled jobs unless they are locked.

### Kubernetes

- Good: self-healing, rolling updates and autoscaling.
- Bad: the control plane needs more memory than the application on a single server, and Docker
  Compose with health checks and Caddy covers what this deployment needs.
