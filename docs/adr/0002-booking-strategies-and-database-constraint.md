# 0002: Booking strategies and the database constraint

- Status: accepted
- Date: 2026-11-13

## Context and problem statement

Two customers must never hold the same seat. The product also compares ways of achieving that, so an
event carries a booking strategy and the comparison needs a way to count double bookings. Which
strategies exist, and what stops a bug in one of them from selling a seat twice?

## Decision drivers

- No double booking, except in the explicit comparison strategy `NAIVE` (product invariant 1).
- The strategies stay comparable: same input, same outcomes, same tests.
- A wrong strategy must be loud (an error), not a silent second booking.

## Considered options

1. Four strategies behind one port, plus a partial unique index as a safety net for all but `NAIVE`.
2. A status column on `seats`, updated by every strategy.
3. A database-wide exclusion or unique constraint without the `NAIVE` exception.

## Decision outcome

Chosen: option 1, because the seat status stays derived from the bookings (no second source of
truth) and the database refuses what a strategy let through.

- `NAIVE`: reads the active bookings, then inserts. No protection; it is the baseline that shows
  double bookings.
- `PESSIMISTIC`: locks the seat row (`FOR UPDATE`) in the transaction; competing holds queue.
- `OPTIMISTIC`: reads `seats.version` and claims the seat with `UPDATE … WHERE version = $read`
  before inserting, up to three attempts. Claiming first turns a lost race into zero updated rows
  (retry) instead of a unique violation after the insert.
- `REDIS_LOCK`: `SET lock:seat:<id> <token> NX PX 5000`, check and insert, release with a
  compare-and-delete script. A lock that is not acquired reports the seat as taken.
- `bookings_active_seat_uidx` is a partial unique index on `seat_id` for active bookings (HELD,
  PAID, CONFIRMED) whose strategy is not `NAIVE`. The strategy is copied onto the booking row so the
  index can exclude the comparison mode. A violation is reported as `CONSTRAINT_VIOLATION`, which
  the concurrency test requires to be zero for every correct strategy.
- `countDoubleBookings` sums (active bookings per seat − 1) in SQL.

### Consequences

- Good: a strategy bug surfaces as `CONSTRAINT_VIOLATION`, never as two paid tickets.
- Good: seat status needs no write path of its own.
- Bad: `NAIVE` rows are not protected by the database by design; they exist only for comparison.
- Bad: the strategy is duplicated on the booking row (copied at hold time, never changed).

## Pros and cons of the options

### Option 1: four strategies plus partial unique index

- Good: defense in depth; the index also protects the paths added later (payment, cancellation).
- Bad: one more index to write on every hold.

### Option 2: a status column on seats

- Good: a hold is a single-row update.
- Bad: a second source of truth that can disagree with the bookings; every transition must keep both
  in step, and the expiry job needs a second write.

### Option 3: constraint without the NAIVE exception

- Good: simplest rule, nothing is exempt.
- Bad: `NAIVE` could never double-book, so the comparison would show nothing.
