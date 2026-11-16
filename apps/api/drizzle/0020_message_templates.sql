CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text,
	"journey_status_id" uuid,
	"channel" text DEFAULT 'email' NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_one_target" CHECK (("message_templates"."key" IS NULL) <> ("message_templates"."journey_status_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_journey_status_id_journey_statuses_id_fk" FOREIGN KEY ("journey_status_id") REFERENCES "public"."journey_statuses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_key_unique" ON "message_templates" USING btree ("key","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "message_templates_status_unique" ON "message_templates" USING btree ("journey_status_id","channel");--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_dedupe_key_unique" UNIQUE("dedupe_key");