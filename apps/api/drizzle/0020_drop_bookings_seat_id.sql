ALTER TABLE "bookings" DROP CONSTRAINT "bookings_seat_id_seats_id_fk";
--> statement-breakpoint
DROP INDEX "bookings_seat_idx";--> statement-breakpoint
DROP INDEX "bookings_active_seat_uidx";--> statement-breakpoint
ALTER TABLE "bookings" DROP COLUMN "seat_id";