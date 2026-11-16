CREATE TYPE "public"."penalty_status" AS ENUM('open', 'settled', 'waived');--> statement-breakpoint
CREATE TABLE "partner_penalties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_organization_id" uuid NOT NULL,
	"appointment_id" uuid,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "penalty_status" DEFAULT 'open' NOT NULL,
	"waived_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "partner_penalties" ADD CONSTRAINT "partner_penalties_partner_organization_id_organizations_id_fk" FOREIGN KEY ("partner_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_penalties" ADD CONSTRAINT "partner_penalties_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_penalties" ADD CONSTRAINT "partner_penalties_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "partner_penalties_partner_idx" ON "partner_penalties" USING btree ("partner_organization_id","status");