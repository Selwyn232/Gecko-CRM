-- Definitieve facturen zijn onveranderbaar: nummer, bedragen, regels en momentopnames liggen vast.
-- Alleen status, betaald bedrag, verzend-/betaaldatum en aanmaningsvelden mogen nog wijzigen.
CREATE OR REPLACE FUNCTION invoices_protect_finalized() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.number IS NOT NULL THEN RAISE EXCEPTION 'Definitieve factuur % kan niet worden verwijderd', OLD.number; END IF;
    RETURN OLD;
  END IF;
  IF OLD.number IS NOT NULL AND (
       NEW.number IS DISTINCT FROM OLD.number OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.customer_id IS DISTINCT FROM OLD.customer_id OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
    OR NEW.due_date IS DISTINCT FROM OLD.due_date OR NEW.subtotal_cents IS DISTINCT FROM OLD.subtotal_cents
    OR NEW.vat_cents IS DISTINCT FROM OLD.vat_cents OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
    OR NEW.vat_breakdown IS DISTINCT FROM OLD.vat_breakdown OR NEW.customer_snapshot IS DISTINCT FROM OLD.customer_snapshot
    OR NEW.company_snapshot IS DISTINCT FROM OLD.company_snapshot OR NEW.payment_reference IS DISTINCT FROM OLD.payment_reference
  ) THEN
    RAISE EXCEPTION 'Definitieve factuur % is onveranderbaar; gebruik een creditnota', OLD.number;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER invoices_protect_finalized BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION invoices_protect_finalized();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invoice_lines_protect_finalized() RETURNS trigger AS $$
DECLARE inv_number text;
BEGIN
  SELECT number INTO inv_number FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  IF inv_number IS NOT NULL THEN
    RAISE EXCEPTION 'Regels van definitieve factuur % zijn onveranderbaar', inv_number;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_protect_finalized BEFORE INSERT OR UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_protect_finalized();
--> statement-breakpoint
-- Standaard factuurmomenten in bestaande klantreizen.
UPDATE journey_statuses SET invoice_trigger = 'deposit' WHERE key = 'schouw_ingepland' AND invoice_trigger IS NULL;
--> statement-breakpoint
UPDATE journey_statuses SET invoice_trigger = 'final' WHERE key = 'eindfactuur_open' AND invoice_trigger IS NULL;
--> statement-breakpoint
INSERT INTO role_permissions (role_id, permission)
SELECT r.id, p.permission
FROM roles r
JOIN (VALUES
  ('finance', 'invoices.read'), ('finance', 'invoices.manage'),
  ('medewerker', 'invoices.read'), ('klantspecialist', 'invoices.read')
) AS p(role_key, permission) ON p.role_key = r.key
ON CONFLICT DO NOTHING;
