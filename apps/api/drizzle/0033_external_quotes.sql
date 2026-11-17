CREATE TABLE "external_quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"product_group_id" uuid,
	"advisor_id" uuid,
	"quote_date" date,
	"valid_until" date,
	"signed_date" date,
	"installer_name" text,
	"deposit_method" text,
	"lines" jsonb NOT NULL,
	"subtotal_cents" integer,
	"vat_cents" integer,
	"total_cents" integer,
	"raw" jsonb NOT NULL,
	"file_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_quotes_source_number_unique" UNIQUE("source","external_number")
);
--> statement-breakpoint
ALTER TABLE "external_quotes" ADD CONSTRAINT "external_quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_quotes" ADD CONSTRAINT "external_quotes_product_group_id_product_groups_id_fk" FOREIGN KEY ("product_group_id") REFERENCES "public"."product_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_quotes" ADD CONSTRAINT "external_quotes_advisor_id_advisors_id_fk" FOREIGN KEY ("advisor_id") REFERENCES "public"."advisors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_quotes" ADD CONSTRAINT "external_quotes_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_quotes" ADD CONSTRAINT "external_quotes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_quotes_customer_idx" ON "external_quotes" USING btree ("customer_id");