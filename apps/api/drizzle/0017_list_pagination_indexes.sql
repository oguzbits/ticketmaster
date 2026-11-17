CREATE INDEX "events_starts_at_id_idx" ON "events" USING btree ("starts_at","id");--> statement-breakpoint
CREATE INDEX "seats_event_price_idx" ON "seats" USING btree ("event_id","price_cents");--> statement-breakpoint
CREATE INDEX "venues_name_id_idx" ON "venues" USING btree ("name","id");