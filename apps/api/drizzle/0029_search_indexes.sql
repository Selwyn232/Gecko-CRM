-- Snel zoeken bij veel klanten: trigram-indexen op precies de expressies die de zoekfuncties gebruiken
-- (customers/service.ts listCustomers en timeline/service.ts search).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customers_name_trgm ON customers USING gin ((coalesce(first_name, '') || ' ' || last_name) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customers_email_trgm ON customers USING gin (email gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS customers_phone_digits_trgm ON customers USING gin ((regexp_replace(coalesce(phone, ''), '\D', '', 'g')) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS properties_postal_norm_trgm ON properties USING gin ((replace(upper(postal_code), ' ', '')) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS properties_street_trgm ON properties USING gin ((street || ' ' || house_number) gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS properties_city_trgm ON properties USING gin (city gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS properties_customer_idx ON properties (customer_id);
