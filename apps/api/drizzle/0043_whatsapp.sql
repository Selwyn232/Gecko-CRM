CREATE TABLE "whatsapp_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"direction" text NOT NULL,
	"wa_id" text NOT NULL,
	"kind" text DEFAULT 'text' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"template_name" text,
	"media_id" text,
	"status" text NOT NULL,
	"provider_message_id" text,
	"error" text,
	"email_id" uuid,
	"sent_by" uuid,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_messages_provider_message_id_unique" UNIQUE("provider_message_id")
);
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "whatsapp_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "whatsapp_customer_idx" ON "whatsapp_messages" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "whatsapp_wa_idx" ON "whatsapp_messages" USING btree ("wa_id","created_at");