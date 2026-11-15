# Stuck outbox

Alert `OutboxStuck`, or `GET /health/ready` answers `"signals":{"outbox":"stuck"}` (status stays
200 on purpose). The oldest unpublished `outbox_messages` row is older than `OUTBOX_STUCK_SECONDS`
(300 s). Payments still succeed; the ticket PDF and the mail wait.

## Check

1. Is the worker running? `docker compose ps worker`. If it is not, see
   [A service is down](service-down.md) and restart it; the relay catches up by itself.
2. Is the relay failing? `docker compose logs --since 10m worker | grep -i relay`. A send that
   times out counts as failed and ends the batch (30 s deadline), so a slow or unreachable
   emulator shows as repeated relay errors.
3. Is the queue reachable?

   ```bash
   curl -s localhost:45660/ -d 'Action=ListQueues'
   ```

   No answer: restart the emulator (`docker compose restart aws`), then run
   `docker compose run --rm aws-init` to recreate the queues (safe to run again).

4. Do the rows leave? `Queue and outbox` dashboard: the age must fall after the fix. A row that is
   sent but not marked is sent again; consumers dedupe by message ID.

## Do not

Do not delete or mark outbox rows by hand: a row without its message loses the ticket mail for that
booking for good.
