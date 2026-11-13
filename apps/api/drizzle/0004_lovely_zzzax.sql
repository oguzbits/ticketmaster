CREATE TYPE "public"."simulation_status" AS ENUM('QUEUED', 'RUNNING', 'FINISHED', 'FAILED');--> statement-breakpoint
CREATE TABLE "simulation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"strategy" "booking_strategy" NOT NULL,
	"buyers" integer NOT NULL,
	"seats" integer NOT NULL,
	"status" "simulation_status" NOT NULL,
	"metrics" jsonb,
	"started_by" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "simulation_runs" ADD CONSTRAINT "simulation_runs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "simulation_runs_status_started_at_idx" ON "simulation_runs" USING btree ("status","started_at");