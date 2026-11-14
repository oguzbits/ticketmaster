# Glossary

Domain terms as the code and the docs use them.

- **Venue**: a place with a seat template (sections, rows, seat numbers, a price per seat). An event
  copies the template when it is created.
- **Event**: a performance at a venue with a start time, a booking strategy and, optionally, a
  waiting room. It is public, or the sandbox event of one demo user.
- **Seat map**: the seats of an event with their live status: available, held or sold.
- **Hold**: a seat reserved for one customer for a short time (the hold TTL). It ends in a payment
  (paid, then confirmed), a cancel or the expiry job.
- **Booking**: the record of a seat for a customer, moved only by the state machine
  (held, paid, confirmed, expired, cancelled). Every transition is stored.
- **Booking strategy**: how a hold avoids a double booking: `naive` (does not), optimistic,
  pessimistic or Redis lock.
- **Waiting room**: a queue in front of an event that sets a capacity. A customer joins it, sees a
  position that updates live and may hold a seat only while admitted. An event without a capacity
  has no waiting room.
- **Capacity** (of a waiting room): how many customers may be admitted at the same time.
- **Admission**: the right to hold seats at an event with a waiting room. The worker's admission
  job gives it to the head of the queue while fewer than the capacity are admitted; it ends when
  the customer leaves or after five minutes.
