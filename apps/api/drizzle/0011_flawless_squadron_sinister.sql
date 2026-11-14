CREATE TYPE "public"."audit_action" AS ENUM('BOOKING_HELD', 'BOOKING_PAID', 'BOOKING_CANCELLED', 'EVENT_CREATED', 'EVENT_STRATEGY_SWITCHED', 'WAITING_ROOM_SETTINGS_CHANGED', 'SIMULATION_STARTED');--> statement-breakpoint
CREATE TYPE "public"."audit_subject" AS ENUM('BOOKING', 'EVENT', 'SIMULATION_RUN');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" "audit_action" NOT NULL,
	"subject_type" "audit_subject" NOT NULL,
	"subject_id" uuid NOT NULL,
	"request_id" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_actor_id_id_idx" ON "audit_log" USING btree ("actor_id","id");--> statement-breakpoint
CREATE INDEX "audit_log_action_id_idx" ON "audit_log" USING btree ("action","id");