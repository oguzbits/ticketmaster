CREATE TYPE "public"."outbox_message_type" AS ENUM('BOOKING_CONFIRMED');--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" "outbox_message_type" NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "processed_messages" (
	"consumer" text NOT NULL,
	"message_id" uuid NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_messages_consumer_message_id_pk" PRIMARY KEY("consumer","message_id")
);
--> statement-breakpoint
CREATE INDEX "outbox_messages_unpublished_idx" ON "outbox_messages" USING btree ("created_at") WHERE "outbox_messages"."published_at" is null;