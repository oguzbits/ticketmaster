INSERT INTO "booking_seats" ("booking_id", "event_id", "seat_id", "strategy", "status")
SELECT "id", "event_id", "seat_id", "strategy", "status"
FROM "bookings"
ON CONFLICT DO NOTHING;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "booking_seats" TO app_runtime;--> statement-breakpoint
ALTER TABLE "booking_seats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "booking_seats" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "booking_seats_owner" ON "booking_seats"
  USING (current_setting('app.scope', true) IS DISTINCT FROM 'user'
    OR EXISTS (SELECT 1 FROM "bookings" b WHERE b."id" = "booking_seats"."booking_id"))
  WITH CHECK (current_setting('app.scope', true) IS DISTINCT FROM 'user'
    OR EXISTS (SELECT 1 FROM "bookings" b WHERE b."id" = "booking_seats"."booking_id"));