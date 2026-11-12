CREATE TYPE "public"."booking_status" AS ENUM('HELD', 'PAID', 'CONFIRMED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."booking_strategy" AS ENUM('NAIVE', 'PESSIMISTIC', 'OPTIMISTIC', 'REDIS_LOCK');--> statement-breakpoint
CREATE TYPE "public"."transition_reason" AS ENUM('HOLD', 'PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'CONFIRMED', 'HOLD_EXPIRED', 'CANCELLED_BY_USER');--> statement-breakpoint
CREATE TABLE "booking_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"from_status" "booking_status",
	"to_status" "booking_status" NOT NULL,
	"reason" "transition_reason" NOT NULL,
	"actor_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"strategy" "booking_strategy" NOT NULL,
	"status" "booking_status" NOT NULL,
	"hold_expires_at" timestamp with time zone NOT NULL,
	"payment_idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_payment_idempotency_key_unique" UNIQUE("payment_idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"strategy" "booking_strategy" NOT NULL,
	"owner_id" uuid NOT NULL,
	"sandbox_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"section" text NOT NULL,
	"row" integer NOT NULL,
	"number" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "seats_event_position_uq" UNIQUE("event_id","section","row","number")
);
--> statement-breakpoint
CREATE TABLE "venue_seats" (
	"venue_id" uuid NOT NULL,
	"section" text NOT NULL,
	"row" integer NOT NULL,
	"number" integer NOT NULL,
	CONSTRAINT "venue_seats_venue_id_section_row_number_pk" PRIMARY KEY("venue_id","section","row","number")
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_transitions" ADD CONSTRAINT "booking_transitions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_seats" ADD CONSTRAINT "venue_seats_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_seat_idx" ON "bookings" USING btree ("seat_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_active_seat_uidx" ON "bookings" USING btree ("seat_id") WHERE "bookings"."status" in ('HELD', 'PAID', 'CONFIRMED') and "bookings"."strategy" <> 'NAIVE';--> statement-breakpoint
CREATE INDEX "bookings_status_hold_expires_idx" ON "bookings" USING btree ("status","hold_expires_at");