CREATE TYPE "public"."email_status" AS ENUM('queued', 'sent', 'failed', 'not_sent');--> statement-breakpoint
CREATE TABLE "quote_link_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_viewed_at" timestamp with time zone,
	CONSTRAINT "quote_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "outbound_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"template" text NOT NULL,
	"customer_id" uuid,
	"related_type" text,
	"related_id" text,
	"status" "email_status" DEFAULT 'queued' NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "street" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "house_number" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "postal_code" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "iban" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "acceptance_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "quote_link_codes" ADD CONSTRAINT "quote_link_codes_link_id_quote_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."quote_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_links" ADD CONSTRAINT "quote_links_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_links" ADD CONSTRAINT "quote_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_link_codes_link_idx" ON "quote_link_codes" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "quote_links_quote_idx" ON "quote_links" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "outbound_emails_customer_idx" ON "outbound_emails" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "outbound_emails_related_idx" ON "outbound_emails" USING btree ("related_type","related_id");