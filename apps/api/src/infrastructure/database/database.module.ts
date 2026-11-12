import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';

import { APP_CONFIG } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';

// Schema arrives with the booking tables; until then the database has no typed tables.
const schema = {};

export type Database = PostgresJsDatabase<typeof schema>;

export const DB = Symbol('DB');
const DB_CLIENT = Symbol('DB_CLIENT');

/** Connections the API keeps open. The concurrency tests open their own pool. */
const API_POOL_SIZE = 20;

@Global()
@Module({
  providers: [
    {
      provide: DB_CLIENT,
      useFactory: (env: Env): Sql => postgres(env.DATABASE_URL, { max: API_POOL_SIZE }),
      inject: [APP_CONFIG],
    },
    {
      provide: DB,
      useFactory: (client: Sql): Database => drizzle(client, { schema }),
      inject: [DB_CLIENT],
    },
  ],
  exports: [DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB_CLIENT) private readonly client: Sql) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.end();
  }
}
