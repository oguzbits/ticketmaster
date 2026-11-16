# Runbooks

Step-by-step procedures for the running stack. The alert table in
[observability.md](../observability.md#alerts) says what to look at first; these pages say what to
do next. Commands run against the local Compose stack (the emulator is published on
`localhost:45660`).

| Situation                                                                           | Runbook                                   |
| ----------------------------------------------------------------------------------- | ----------------------------------------- |
| `DeadLetterQueueNotEmpty`                                                           | [Dead-letter queue](dead-letter-queue.md) |
| `OutboxStuck`, `/health/ready` reports `outbox: stuck`                              | [Stuck outbox](outbox-stuck.md)           |
| `ApiReplicaMissing`, `ApiAllReplicasGone`, `ScrapeTargetDown`, `GaugeSourceMissing` | [A service is down](service-down.md)      |

There are no deploy, rollback or restore runbooks: the system runs locally only.
