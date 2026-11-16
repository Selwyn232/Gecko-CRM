CREATE TYPE "public"."day_part" AS ENUM('morning', 'afternoon');--> statement-breakpoint
CREATE TABLE "availability_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_organization_id" uuid NOT NULL,
	"date" date NOT NULL,
	"part" "day_part" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_blocks_unique" UNIQUE("partner_organization_id","date","part")
);
--> statement-breakpoint
CREATE TABLE "partner_regions" (
	"partner_organization_id" uuid NOT NULL,
	"region_id" uuid NOT NULL,
	CONSTRAINT "partner_regions_partner_organization_id_region_id_pk" PRIMARY KEY("partner_organization_id","region_id")
);
--> statement-breakpoint
ALTER TABLE "availability_blocks" ADD CONSTRAINT "availability_blocks_partner_organization_id_organizations_id_fk" FOREIGN KEY ("partner_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_regions" ADD CONSTRAINT "partner_regions_partner_organization_id_organizations_id_fk" FOREIGN KEY ("partner_organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_regions" ADD CONSTRAINT "partner_regions_region_id_regions_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."regions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_blocks_date_idx" ON "availability_blocks" USING btree ("date");--> statement-breakpoint
-- Bestaande beschikbaarheid omzetten: werkgebied uit de opgegeven regio's, en een dag met capaciteit wordt ochtend + middag.
INSERT INTO "partner_regions" ("partner_organization_id", "region_id")
SELECT DISTINCT partner_organization_id, region_id FROM "availability"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "availability_blocks" ("partner_organization_id", "date", "part")
SELECT DISTINCT a.partner_organization_id, a.date, p.part::day_part
FROM "availability" a CROSS JOIN (VALUES ('morning'), ('afternoon')) AS p(part)
WHERE a.survey_slots > 0 OR a.installation_slots > 0
ON CONFLICT DO NOTHING;
