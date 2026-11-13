import type { SeatChange } from '@app/shared';
import type { Logger } from '@nestjs/common';

import type { SeatChangePublisher } from '../domain/seat-change.js';

/**
 * Publishes after a commit. The change is stored already, so a failed publish must not fail the
 * request: it is logged with the ID of what changed (never anything personal) and viewers catch up
 * on their next snapshot.
 */
export async function publishSeatChange(
  publisher: SeatChangePublisher,
  change: SeatChange,
  logger: Logger,
  subject: string
): Promise<void> {
  try {
    await publisher.publish(change);
  } catch (error) {
    logger.error(
      `seat change of ${subject} not published: ${error instanceof Error ? error.name : 'unknown error'}`
    );
  }
}
