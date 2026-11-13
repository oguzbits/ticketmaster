/** The database of the db specs. The global setup drops and recreates it on every run. */
export const TEST_DATABASE_NAME = 'app_test';

/** The URL of the configured server with the test database instead of the configured one. */
export function testDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.pathname = `/${TEST_DATABASE_NAME}`;
  return url.toString();
}
