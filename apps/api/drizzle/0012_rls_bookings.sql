-- The runtime role (created by the migration job) works through grants only; it owns nothing.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;--> statement-breakpoint
-- Second layer of ownership (ADR 0009): restricts only while a transaction set app.scope = 'user'.
ALTER TABLE "bookings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bookings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "bookings_owner" ON "bookings"
  USING (current_setting('app.scope', true) IS DISTINCT FROM 'user'
    OR "user_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (current_setting('app.scope', true) IS DISTINCT FROM 'user'
    OR "user_id" = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "booking_transitions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_transitions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The subquery runs under the policy of bookings, so it sees only the user's own bookings.
CREATE POLICY "booking_transitions_owner" ON "booking_transitions"
  USING (current_setting('app.scope', true) IS DISTINCT FROM 'user'
    OR EXISTS (SELECT 1 FROM "bookings" b WHERE b."id" = "booking_transitions"."booking_id"))
  WITH CHECK (current_setting('app.scope', true) IS DISTINCT FROM 'user'
    OR EXISTS (SELECT 1 FROM "bookings" b WHERE b."id" = "booking_transitions"."booking_id"));
