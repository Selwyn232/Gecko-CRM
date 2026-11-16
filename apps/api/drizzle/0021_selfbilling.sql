CREATE TYPE "public"."self_billing_kind" AS ENUM('sales_fee', 'installation');--> statement-breakpoint
CREATE TYPE "public"."self_billing_line_kind" AS ENUM('fee', 'installation', 'extra_work', 'penalty', 'correction');--> statement-breakpoint
CREATE TYPE "public"."self_billing_status" AS ENUM('draft', 'final', 'paid');--> statement-breakpoint
CREATE TABLE "self_billing_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_organization_id" uuid NOT NULL,
	"kind" "self_billing_kind" NOT NULL,
	"status" "self_billing_status" DEFAULT 'draft' NOT NULL,
	"number" text,
	"invoice_date" date,
	"vat_mode" text NOT NULL,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"vat_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"vat_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"partner_snapshot" jsonb,
	"company_snapshot" jsonb,
	"note" text,
	"finalized_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"paid_at" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "self_billing_invoices_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "self_billing_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"kind" "self_billing_line_kind" NOT NULL,
	"project_id" uuid,
	"quote_id" uuid,
	"penalty_id" uuid,
	"advisor_name" text,
	"description" text NOT NULL,
	"basis_cents" integer,
	"fee_basis_points" integer,
	"amount_cents" integer NOT NULL,
	"vat_rate_basis_points" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "self_billing_sequences" (
	"partner_organization_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "self_billing_sequences_partner_organization_id_year_pk" PRIMARY KEY("partner_organization_id","year")
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "self_billing_prefix" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "self_billing_vat_mode" text;--> statement-breakpoint
ALTER TABLE "self_billing_invoices" ADD CONSTRAINT "self_billing_invoices_partner_organization_id_organizations_id_fk" FOREIGN KEY ("partner_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_billing_invoices" ADD CONSTRAINT "self_billing_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_billing_lines" ADD CONSTRAINT "self_billing_lines_invoice_id_self_billing_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."self_billing_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_billing_lines" ADD CONSTRAINT "self_billing_lines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_billing_lines" ADD CONSTRAINT "self_billing_lines_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_billing_lines" ADD CONSTRAINT "self_billing_lines_penalty_id_partner_penalties_id_fk" FOREIGN KEY ("penalty_id") REFERENCES "public"."partner_penalties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_billing_sequences" ADD CONSTRAINT "self_billing_sequences_partner_organization_id_organizations_id_fk" FOREIGN KEY ("partner_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "self_billing_invoices_partner_idx" ON "self_billing_invoices" USING btree ("partner_organization_id","status");--> statement-breakpoint
CREATE INDEX "self_billing_lines_invoice_idx" ON "self_billing_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "self_billing_lines_fee_unique" ON "self_billing_lines" USING btree ("quote_id") WHERE kind = 'fee';--> statement-breakpoint
CREATE UNIQUE INDEX "self_billing_lines_extra_unique" ON "self_billing_lines" USING btree ("quote_id") WHERE kind = 'extra_work';--> statement-breakpoint
CREATE UNIQUE INDEX "self_billing_lines_installation_unique" ON "self_billing_lines" USING btree ("project_id") WHERE kind = 'installation';--> statement-breakpoint
CREATE UNIQUE INDEX "self_billing_lines_penalty_unique" ON "self_billing_lines" USING btree ("penalty_id") WHERE kind = 'penalty';--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_self_billing_prefix_unique" UNIQUE("self_billing_prefix");--> statement-breakpoint
-- Definitieve selfbillingfacturen zijn onveranderbaar; alleen betaald-status, betaaldatum en verzenddatum mogen nog wijzigen.
CREATE OR REPLACE FUNCTION self_billing_protect_finalized() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'Definitieve selfbillingfactuur % kan niet worden verwijderd', OLD.number; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' AND (
       NEW.number IS DISTINCT FROM OLD.number OR NEW.partner_organization_id IS DISTINCT FROM OLD.partner_organization_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
    OR NEW.vat_mode IS DISTINCT FROM OLD.vat_mode OR NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents
    OR NEW.vat_cents IS DISTINCT FROM OLD.vat_cents OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
    OR NEW.vat_breakdown IS DISTINCT FROM OLD.vat_breakdown OR NEW.partner_snapshot IS DISTINCT FROM OLD.partner_snapshot
    OR NEW.company_snapshot IS DISTINCT FROM OLD.company_snapshot OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
    OR (NEW.status = 'draft')
  ) THEN
    RAISE EXCEPTION 'Definitieve selfbillingfactuur % is onveranderbaar', OLD.number;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER self_billing_protect_finalized BEFORE UPDATE OR DELETE ON self_billing_invoices
  FOR EACH ROW EXECUTE FUNCTION self_billing_protect_finalized();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION self_billing_lines_protect_finalized() RETURNS trigger AS $$
DECLARE inv_status text;
BEGIN
  SELECT status INTO inv_status FROM self_billing_invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF inv_status IS NOT NULL AND inv_status <> 'draft' THEN
    RAISE EXCEPTION 'Regels van een definitieve selfbillingfactuur zijn onveranderbaar';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER self_billing_lines_protect_finalized BEFORE INSERT OR UPDATE OR DELETE ON self_billing_lines
  FOR EACH ROW EXECUTE FUNCTION self_billing_lines_protect_finalized();
