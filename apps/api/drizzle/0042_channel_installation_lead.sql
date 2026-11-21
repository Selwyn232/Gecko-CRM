ALTER TABLE "sales_channels" ADD COLUMN "installation_lead_days" integer;--> statement-breakpoint
-- B82: Greenteam-klanten worden direct ingepland, op zijn vroegst 30 dagen na binnenkomst.
UPDATE "sales_channels" SET "installation_lead_days" = 30 WHERE "key" = 'greenteam';
