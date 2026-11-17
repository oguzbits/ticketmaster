# Dead-letter queue

Alert `DeadLetterQueueNotEmpty`: a message of `booking-events` was received five times without a
successful handler (`MAX_RECEIVE_COUNT`) and moved to `booking-events-dlq`.

## Find the cause

1. Which effect failed: `tm_queue_effects_total{outcome="FAILED"}` on the `Queue and outbox`
   dashboard, or the worker log: `docker compose logs worker | grep QueueConsumer`.
2. Read the message without taking it (visibility timeout 0 leaves it visible):

   ```bash
   curl -s localhost:45660/000000000000/booking-events-dlq \
     -d 'Action=ReceiveMessage&MaxNumberOfMessages=10&AttributeName.1=All&VisibilityTimeout=0'
   ```

   The body carries IDs only (the booking ID). The `MessageId` is the one in the worker log lines
   and in the span attribute of the failing trace in Tempo.

3. Typical causes: SMTP down (Mailpit), the emulator or bucket unreachable, Keycloak not answering
   within 5 s, or a message that does not parse (`is not a known queue message` in the log, which
   is a bug in the sender: do not replay it, it fails again).

## Fix the cause, then replay

Replay only after the dependency works again, otherwise the message returns here after five more
receives.

Run the DLQ replay script:

```bash
pnpm dlq:replay
```

To check the status of existing or past move tasks:

```bash
pnpm dlq:status
```

Alternatively via curl against the local emulator:

```bash
curl -s localhost:45660/ -d 'Action=StartMessageMoveTask&SourceArn=arn:aws:sqs:us-east-1:000000000000:booking-events-dlq&DestinationArn=arn:aws:sqs:us-east-1:000000000000:booking-events'
curl -s localhost:45660/ -d 'Action=ListMessageMoveTasks&SourceArn=arn:aws:sqs:us-east-1:000000000000:booking-events-dlq'
```

`ListMessageMoveTasks` shows `Status` `COMPLETED` and the number moved. The consumer takes the
messages like new ones. A handler that failed stored no dedupe record, so it runs again; an effect
that already finished is skipped under its own dedupe name. Delivery is at least once: a repeated
confirmation mail is accepted (see the open points in [BACKLOG.md](../BACKLOG.md)).

## Discard instead

A message that cannot succeed (a booking that is gone, an unparsable body) is removed with
`Action=PurgeQueue` on the dead-letter queue URL. That deletes every message in it: read them all
first. The alert resolves up to 5 minutes after the queue is empty.
