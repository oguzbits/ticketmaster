CREATE TYPE "public"."user_role" AS ENUM('customer', 'organizer', 'admin');--> statement-breakpoint
CREATE TABLE "demo_users" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"role" "user_role" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "demo_users_expires_at_idx" ON "demo_users" USING btree ("expires_at");