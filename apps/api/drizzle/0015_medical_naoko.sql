CREATE TYPE "public"."payment_attempt_status" AS ENUM('CLAIMED', 'CHARGED', 'APPLIED', 'REFUND_PENDING', 'REFUNDED', 'RELEASED');--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"booking_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "payment_attempt_status" NOT NULL,
	"request_id" text NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_attempts_reconcile_idx" ON "payment_attempts" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "payment_attempts_booking_idx" ON "payment_attempts" USING btree ("booking_id");