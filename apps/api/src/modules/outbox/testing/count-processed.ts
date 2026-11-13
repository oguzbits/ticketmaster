import { count, eq } from 'drizzle-orm';

import type { Database } from '../../../infrastructure/database/database.module.js';
import { processedMessages } from '../../../infrastructure/database/schema.js';

/** How many consumers recorded the message, for specs outside the api package. */
export async function countProcessed(db: Database, messageId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(processedMessages)
    .where(eq(processedMessages.messageId, messageId));
  return row?.n ?? 0;
}
