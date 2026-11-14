# 0006: Infrastructure as code for queues and bucket

- Status: accepted
- Date: 2026-11-14

## Context and problem statement

The queue `booking-events`, its dead-letter queue, the redrive policy and the bucket `tickets` were
created by an imperative script ([ADR 0004](0004-local-aws-emulator.md)) that mixed what must exist
with how to create it, and it set the queue attributes on every run. The resources must be declared
in one place and applied idempotently by a one-shot that the apps wait for, locally against the
emulator and later against a real account. Which tool applies the declaration?

## Decision drivers

- Smallest set of moving parts: no new binary, image, provider download or state file.
- Runs against the emulator and against AWS with only an endpoint setting.
- The declaration lives next to the names the application code already imports.
- Applying twice changes nothing; a missing resource comes back; the behavior is testable offline.

## Considered options

1. An SDK script: the declaration is a constant in `packages/shared`, `scripts/infrastructure.mjs`
   converges it with the AWS SDK that the project already depends on.
2. OpenTofu with the AWS provider, endpoint overrides for the emulator, run by a one-shot.

## Decision outcome

Chosen: option 1.

- `INFRASTRUCTURE` (`packages/shared/src/aws.ts`) lists the queues (a dead-letter queue before the
  queue that points to it), their visibility timeout and redrive policy, and the buckets. The names
  and numbers are the constants the application code imports, so code and declaration cannot drift.
- `applyInfrastructure` looks each resource up first. A missing queue or bucket is created, a queue
  whose visibility timeout or redrive policy differs is set back, a matching one is left alone.
  Any other error, such as a denied lookup, stops the run. It returns what it changed, and the
  one-shot prints it (`nothing to change` on a second run).
- The one-shot `aws-init` (Compose) and `pnpm aws:init` run it. `api` and `worker` start after it
  has completed (`service_completed_successfully`).
- Tests (`scripts/infrastructure.test.mjs`, offline, an in-memory SQS and S3): first run creates
  everything with the redrive target, a second run sends no mutating call, a deleted queue is
  recreated, a drifted attribute is set back, an unexpected error is not swallowed. The same was
  run by hand against the emulator: delete `booking-events`, apply, apply again.

### Consequences

- Good: no new dependency or binary; the one-shot image is the existing `tools` stage.
- Good: a change of a limit (receive count, visibility timeout) is one edit that both the code and
  the infrastructure read.
- Bad: the script knows only queues, redrive, visibility timeout and buckets. A new kind of
  resource (a topic, a bucket policy) needs code in the script, where OpenTofu would need a block.
  Revisit when the declaration needs more than a handful of resource kinds or a real account with
  several environments.
- Bad: nothing is removed. A resource that leaves the declaration stays until it is deleted by hand;
  there is no state file to diff against.

## Pros and cons of the options

### Option 1: SDK script

- Good: reuses the SDK, the shared constants and the Node image; unit-testable with a fake client.
- Bad: convergence logic is ours, limited to what it handles; no plan or destroy.

### Option 2: OpenTofu

- Good: declarative language, plan and destroy, a large resource catalogue.
- Bad: another binary and image, a provider download at start, a state file to keep or discard on
  each emulator restart, endpoint overrides per service. Its behavior against the emulator was not
  evaluated, because option 1 already covers everything the system declares.
