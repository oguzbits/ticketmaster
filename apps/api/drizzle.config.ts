import { defineConfig } from 'drizzle-kit';

// `generate` reads only the schema; it needs no database connection.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/infrastructure/database/schema.ts',
  out: './drizzle',
});
