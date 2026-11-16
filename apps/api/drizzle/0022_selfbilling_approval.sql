ALTER TABLE "self_billing_invoices" ADD COLUMN "approval_status" text;--> statement-breakpoint
ALTER TABLE "self_billing_invoices" ADD COLUMN "approval_token_hash" text;--> statement-breakpoint
ALTER TABLE "self_billing_invoices" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "self_billing_invoices" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "self_billing_invoices" ADD COLUMN "approved_by_name" text;--> statement-breakpoint
ALTER TABLE "self_billing_invoices" ADD COLUMN "approval_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "self_billing_invoices" ADD COLUMN "disputed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "self_billing_invoices" ADD COLUMN "dispute_reason" text;--> statement-breakpoint
ALTER TABLE "self_billing_invoices" ADD CONSTRAINT "self_billing_invoices_approval_token_hash_unique" UNIQUE("approval_token_hash");--> statement-breakpoint
-- Bestaande definitieve, onbetaalde facturen: wachten op akkoord (opnieuw ter akkoord sturen vanuit het CRM).
UPDATE self_billing_invoices SET approval_status = 'pending' WHERE status = 'final';
--> statement-breakpoint
UPDATE self_billing_invoices SET approval_status = 'approved' WHERE status = 'paid';
--> statement-breakpoint
-- Een gegeven akkoord en de vingerafdruk van de factuur liggen vast.
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
    OR (OLD.content_hash IS NOT NULL AND NEW.content_hash IS DISTINCT FROM OLD.content_hash)
    OR (OLD.approved_at IS NOT NULL AND (
         NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by_name IS DISTINCT FROM OLD.approved_by_name
      OR NEW.approval_evidence IS DISTINCT FROM OLD.approval_evidence OR NEW.approval_status IS DISTINCT FROM OLD.approval_status))
    OR (NEW.status = 'paid' AND NEW.approval_status IS DISTINCT FROM 'approved')
  ) THEN
    RAISE EXCEPTION 'Definitieve selfbillingfactuur % is onveranderbaar (of nog niet geaccordeerd)', OLD.number;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
