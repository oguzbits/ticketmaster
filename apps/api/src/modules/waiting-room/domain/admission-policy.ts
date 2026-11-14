/** Users admitted per tick: a steady trickle keeps the booking path from a stampede. */
export const ADMISSION_BATCH_SIZE = 10;

/**
 * Who is admitted next: the front of the queue, as many as the free places and the batch size
 * allow. Pure; the store applies the answer atomically and re-checks the capacity.
 */
export function planAdmissions(input: {
  capacity: number;
  /** Live admissions now. */
  admitted: number;
  /** User IDs, front of the queue first. */
  head: readonly string[];
  batchSize: number;
}): string[] {
  const free = Math.max(0, input.capacity - input.admitted);
  return [...new Set(input.head)].slice(0, Math.min(free, input.batchSize));
}
