CREATE TYPE "public"."payment_method" AS ENUM('direct', 'warmtefonds');--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "journey_statuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_group_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"phase" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_initial" boolean DEFAULT false NOT NULL,
	"is_final" boolean DEFAULT false NOT NULL,
	"color" text DEFAULT 'gray' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journey_transitions" (
	"from_status_id" uuid NOT NULL,
	"to_status_id" uuid NOT NULL,
	CONSTRAINT "journey_transitions_from_status_id_to_status_id_pk" PRIMARY KEY("from_status_id","to_status_id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "customers_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"first_name" text,
	"last_name" text NOT NULL,
	"email" text,
	"phone" text,
	"sales_channel_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"street" text NOT NULL,
	"house_number" text NOT NULL,
	"house_number_addition" text,
	"postal_code" text NOT NULL,
	"city" text NOT NULL,
	"country" text DEFAULT 'NL' NOT NULL,
	"bag_id" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"from_status_id" uuid,
	"to_status_id" uuid NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "projects_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"product_group_id" uuid NOT NULL,
	"sales_channel_id" uuid NOT NULL,
	"status_id" uuid NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"installation_partner_id" uuid,
	"payment_method" "payment_method" DEFAULT 'direct' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "journey_statuses" ADD CONSTRAINT "journey_statuses_product_group_id_product_groups_id_fk" FOREIGN KEY ("product_group_id") REFERENCES "public"."product_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_transitions" ADD CONSTRAINT "journey_transitions_from_status_id_journey_statuses_id_fk" FOREIGN KEY ("from_status_id") REFERENCES "public"."journey_statuses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_transitions" ADD CONSTRAINT "journey_transitions_to_status_id_journey_statuses_id_fk" FOREIGN KEY ("to_status_id") REFERENCES "public"."journey_statuses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_sales_channel_id_sales_channels_id_fk" FOREIGN KEY ("sales_channel_id") REFERENCES "public"."sales_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_status_history" ADD CONSTRAINT "project_status_history_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_status_history" ADD CONSTRAINT "project_status_history_from_status_id_journey_statuses_id_fk" FOREIGN KEY ("from_status_id") REFERENCES "public"."journey_statuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_status_history" ADD CONSTRAINT "project_status_history_to_status_id_journey_statuses_id_fk" FOREIGN KEY ("to_status_id") REFERENCES "public"."journey_statuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_status_history" ADD CONSTRAINT "project_status_history_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_product_group_id_product_groups_id_fk" FOREIGN KEY ("product_group_id") REFERENCES "public"."product_groups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_sales_channel_id_sales_channels_id_fk" FOREIGN KEY ("sales_channel_id") REFERENCES "public"."sales_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_status_id_journey_statuses_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."journey_statuses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_installation_partner_id_organizations_id_fk" FOREIGN KEY ("installation_partner_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_unprocessed_idx" ON "outbox_events" USING btree ("id") WHERE processed_at IS NULL;--> statement-breakpoint
CREATE INDEX "outbox_aggregate_idx" ON "outbox_events" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "journey_statuses_key_unique" ON "journey_statuses" USING btree ("product_group_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "journey_statuses_one_initial" ON "journey_statuses" USING btree ("product_group_id") WHERE is_initial;--> statement-breakpoint
CREATE INDEX "journey_statuses_group_idx" ON "journey_statuses" USING btree ("product_group_id");--> statement-breakpoint
CREATE INDEX "customers_email_idx" ON "customers" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "customers_phone_idx" ON "customers" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "customers_last_name_idx" ON "customers" USING btree (lower("last_name"));--> statement-breakpoint
CREATE INDEX "properties_customer_idx" ON "properties" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "properties_postal_idx" ON "properties" USING btree ("postal_code","house_number");--> statement-breakpoint
CREATE INDEX "project_status_history_project_idx" ON "project_status_history" USING btree ("project_id","changed_at");--> statement-breakpoint
CREATE INDEX "projects_customer_idx" ON "projects" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status_id");--> statement-breakpoint
CREATE INDEX "projects_group_idx" ON "projects" USING btree ("product_group_id");--> statement-breakpoint
CREATE INDEX "projects_partner_idx" ON "projects" USING btree ("installation_partner_id");