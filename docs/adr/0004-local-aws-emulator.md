# 0004: Local AWS emulator

- Status: accepted
- Date: 2026-11-13

## Context and problem statement

Phase 2 moves work off the request path: an outbox relay sends messages to SQS, consumers in the
worker read them, a message that keeps failing ends in a dead-letter queue, and later slices store
files in S3. The database tests and the end-to-end run need these services locally and in CI,
without an AWS account and without network access to AWS. Which emulator do we run, and how do we
know it behaves like SQS where the design depends on it?

## Decision drivers

- The behavior the design relies on must be proven, not assumed: redrive to a dead-letter queue
  after the max receive count, visibility timeout, long polling, message attributes, a bucket round
  trip.
- One container, fast start, a health signal Compose and CI can wait for.
- The application code uses the standard AWS SDK with an endpoint override and nothing emulator
  specific, so the same code runs against real AWS (slice E).
- A small dependency set.

## Considered options

1. Floci (`floci/floci`): one emulator for SQS, S3 and more.
2. ElasticMQ (SQS) plus MinIO (S3): two containers, each specialised.
3. A fake queue in the process, no emulator.

## Decision outcome

Chosen: option 1, image `floci/floci:2.4.0` (MIT licence, multi-arch manifest with amd64 and
arm64, released 2026-10-31). The tag is pinned; `docker manifest inspect floci/floci:2.4.0` lists
it and the image was pulled and run for the check below.

Evidence, from `pnpm aws:smoke` (`scripts/aws-smoke.mjs`, AWS SDK for JavaScript v3 with the
endpoint override and path-style S3), run against the Compose service:

| Feature                                        | Result                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Create queue twice with equal attributes       | passes, same queue URL                                                                           |
| Message attributes                             | a String attribute sent with the message comes back with `MessageAttributeNames: ['All']`        |
| Long polling, message arrives after one second | the receive returns after about one second, not after the 10 second wait                         |
| Long polling, empty queue                      | the receive waits the full 2 seconds and returns nothing                                         |
| Visibility timeout                             | a received message is hidden, then delivered again after the timeout                             |
| Redrive, `maxReceiveCount` 5, never deleted    | the handler sees the message exactly five times; it then leaves the queue and arrives in the DLQ |
| Bucket create, put, get                        | the body and the content type round trip                                                         |

The redrive check is a protection: with `maxReceiveCount` changed to 3 in a copy of the script, it
fails with "3 !== 5". The script uses its own throw-away queues and bucket and removes them, so it
can run again at any time.

The fallback (option 2) was not needed and was not evaluated: every feature passed on the first
run.

Findings that shape the setup:

- **Health check.** The image ships a `HEALTHCHECK` that asks the emulator's readiness route
  `/_floci/init` (bash only, the image has no curl). Compose and the GitHub Actions service
  container use it as it is; `docker compose up --wait` and `depends_on: service_healthy` work with
  it. `/_localstack/health` also answers, but the image's own check is the one we rely on.
- **Queue URLs.** The emulator returns URLs with its own host name (`localhost:4566` by default).
  `FLOCI_HOSTNAME=aws` makes them resolvable inside the Compose network. The AWS SDK sends every
  request to the configured endpoint and ignores the host of a queue URL, so the host machine can
  use the same URLs through the published port.
- **Credentials and region.** Any credentials work; the project uses `test` / `test` and
  `us-east-1`, set through the config module (nothing reads the SDK's own environment variables).
- **State.** The service has no volume: a restart starts empty, and the one-shot `aws-init`
  (`scripts/aws-init.mjs`, run by Compose, by `pnpm db:up` and by CI) creates the queues, the
  redrive policy and the bucket again. It is safe to run twice. Slice E replaces it with declared
  infrastructure.
- **Re-running.** `docker compose up --wait` treats an already exited one-shot container as a
  failure, so `pnpm db:up` starts the long-running services with `up` and runs `aws-init` with
  `docker compose run --rm`.

### Consequences

- Good: one container for SQS and S3, ready within seconds; the proof of the behavior we depend
  on is a re-runnable script that also runs in CI.
- Good: the application code is plain AWS SDK code with an endpoint setting.
- Bad: a young project. The smoke script is the guard against a regression in a later release; a
  tag bump must pass it.
- Bad: the emulator is not AWS. Behavior that is not in the smoke script (FIFO queues, exact
  retention and throttling) is not proven here and is not used.

## Pros and cons of the options

### Option 1: Floci

- Good: one image, SQS and S3 verified against the features above, built-in health check.
- Bad: young project.

### Option 2: ElasticMQ plus MinIO

- Good: both are long-established and specialised.
- Bad: two containers, two health checks and two configurations; not evaluated because option 1
  passed.

### Option 3: Fake queue in the process

- Good: no container.
- Bad: proves nothing about redrive, visibility timeout or the SDK wiring, which is the point of the
  slice.
