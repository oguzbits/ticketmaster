# 0006: Infrastructure as code (OpenTofu and local bootstrap)

- Status: accepted (revised 2026-11-17)
- Date: 2026-11-14

## Context and problem statement

Initially only two SQS queues (`booking-events` and `booking-events-dlq`) and one S3 bucket
(`tickets`) existed on the local AWS emulator ([ADR 0004](0004-local-aws-emulator.md)). When aligning
the project with enterprise AWS production standards (VPC segmentation, KMS encryption, RDS
PostgreSQL 18 + RDS Proxy, Multi-AZ ElastiCache Redis, Cognito, ECS Fargate behind WAF/ALB, SQS,
S3, and SESv2), the declarative surface grew beyond what an application bootstrap script can model
or tear down. At the same time, local Compose/E2E runs start from an ephemeral emulator without a
volume and cannot afford a ~50 s delay on every test setup.

## Decision drivers

- Declarative production blueprint in OpenTofu (`infra/aws`, `infra/modules/messaging`) covering
  compute, data, auth, security, and messaging without locking into a vendor-proprietary license.
- Same shared `infra/modules/messaging` module verified live against the local Floci emulator
  (`infra/local`) with `tofu apply` / `tofu plan -detailed-exitcode` / `tofu destroy`.
- Sub-second local Compose and CI test startup (`aws-init` / `pnpm aws:init`): measured `tofu apply`
  against Floci takes ~25 s per `aws_sqs_queue` (plus ~25 s for `aws_sqs_queue_redrive_allow_policy`
  destroy) because of the AWS provider's built-in SQS attribute propagation wait.
- Zero configuration drift between `packages/shared/src/aws.ts` (`INFRASTRUCTURE`) and
  `infra/modules/messaging`.

## Considered options

1. SDK script only (`scripts/infrastructure.mjs` — original 2026-11-14 choice).
2. OpenTofu for everything including `docker compose up` `aws-init`.
3. Dual-layer IaC: OpenTofu (`infra/`) as the declarative specification for AWS production
   (`infra/aws`), local Floci parity (`infra/local`), and shared messaging (`infra/modules/messaging`),
   paired with `scripts/infrastructure.mjs` for sub-second ephemeral Compose/test initialization and a
   unit parity check (`scripts/infra-parity.test.mjs`).

## Decision outcome

Chosen: option 3.

- **Shared OpenTofu module (`infra/modules/messaging`):** declares the dead-letter queue
  (`booking-events-dlq`), main queue (`booking-events` with visibility timeout `120`, retention
  `345600`, and `maxReceiveCount = 5`), redrive-allow policy, S3 bucket (`tickets` with public
  access block, versioning, KMS encryption, lifecycle, and conditional TLS-only bucket policy), and
  SESv2 sender identity (`tickets@ticketmaster-klon.invalid`).
- **AWS production blueprint (`infra/aws`):** declares the full enterprise target architecture:
  2-AZ VPC (public, private-app, and isolated private-data subnets, VPC Flow Logs, Gateway/Interface
  VPC Endpoints), customer-managed KMS key with rotation, Secrets Manager secret containers,
  least-privilege Security Groups and ECS IAM roles, RDS PostgreSQL 18 Multi-AZ + RDS Proxy
  (matching [ADR 0005](0005-pgbouncer-transaction-mode.md)), encrypted Multi-AZ ElastiCache Redis,
  Cognito User Pool (`customer`, `organizer`, `admin` groups), ECS Fargate `api` (autoscaled,
  `readonlyRootFilesystem`, `AUTH_PROVIDER=cognito`, `OIDC_ISSUER`/`OIDC_CLIENT_ID`,
  `DEMO_LOGIN_ENABLED=false`, `UNSAFE_STRATEGIES_ENABLED=false`,
  `MAIL_PROVIDER=ses`) & `worker`, internal HTTPS ALB, Regional WAFv2 WebACL, and `module "messaging"`.
- **Local OpenTofu target (`infra/local`):** targets Floci via `endpoints { s3, sqs, sesv2, kms, sts }`
  with `skip_requesting_account_id = false` (required so Floci STS resolves `000000000000` and
  `aws_sesv2_email_identity` produces valid ARNs) and `enforce_tls_bucket_policy = false` (local
  emulator uses plain HTTP).
- **Fast local bootstrap (`scripts/infrastructure.mjs`):** retained for Compose `aws-init` and
  `pnpm aws:init` / `pnpm db:up` / `pnpm e2e` so local container startup stays under a second instead
  of waiting ~50 s per run on AWS provider SQS propagation timers.
- **Drift & security gates:** `scripts/infra-parity.test.mjs` asserts in `pnpm test` that
  `infra/modules/messaging` defaults match `INFRASTRUCTURE` (`packages/shared/src/aws.ts`);
  `pnpm infra:validate` (`tofu fmt -check`, `tofu validate`) and `pnpm infra:trivy` (Trivy config
  scan with zero HIGH/CRITICAL findings) run locally and in CI (`tofu` and `trivy` jobs).

### Consequences

- Good: declarative `plan` / `destroy`, full AWS production architecture, zero Trivy HIGH/CRITICAL
  misconfigurations, and shared module parity verified against Floci.
- Good: local `docker compose up`, `pnpm db:up`, and `pnpm e2e` stay fast without downloading
  provider plugins or paying the 25 s/queue provider delay on every ephemeral container boot.
- Bad: changing queue/bucket/SES defaults in `packages/shared/src/aws.ts` requires updating
  `infra/modules/messaging/variables.tf` as well — enforced automatically by
  `scripts/infra-parity.test.mjs`.

## Pros and cons of the options

### Option 1: SDK script only

- Good: minimal moving parts when only queues and a bucket existed.
- Bad: cannot express VPCs, KMS, IAM, RDS/RDS Proxy, ElastiCache, Cognito, ECS, ALB, or WAF; no
  `plan`/`destroy` or static security scanning.

### Option 2: OpenTofu in `aws-init`

- Good: single provisioning mechanism.
- Bad: adds ~50–75 s to every `pnpm db:up` / `pnpm e2e` cold start due to the AWS provider's
  hardcoded SQS attribute wait, plus provider plugin and state management inside ephemeral Compose
  runs.
