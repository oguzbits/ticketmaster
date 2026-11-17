CREATE TABLE "booking_seats" (
	"booking_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"strategy" "booking_strategy" NOT NULL,
	"status" "booking_status" NOT NULL,
	CONSTRAINT "booking_seats_booking_id_seat_id_pk" PRIMARY KEY("booking_id","seat_id")
);
--> statement-breakpoint
ALTER TABLE "booking_seats" ADD CONSTRAINT "booking_seats_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_seats" ADD CONSTRAINT "booking_seats_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_seats" ADD CONSTRAINT "booking_seats_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_seats_seat_idx" ON "booking_seats" USING btree ("seat_id");--> statement-breakpoint
CREATE INDEX "booking_seats_event_status_idx" ON "booking_seats" USING btree ("event_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_seats_active_seat_uidx" ON "booking_seats" USING btree ("seat_id") WHERE "booking_seats"."status" in ('HELD', 'PAID', 'CONFIRMED') and "booking_seats"."strategy" <> 'NAIVE';