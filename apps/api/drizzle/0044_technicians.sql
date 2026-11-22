ALTER TYPE "public"."appointment_type" ADD VALUE 'service';--> statement-breakpoint
CREATE TABLE "technician_availability" (
	"technician_user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"slot" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "technician_availability_technician_user_id_date_slot_pk" PRIMARY KEY("technician_user_id","date","slot")
);
--> statement-breakpoint
CREATE TABLE "technician_locations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"technician_user_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"accuracy" real
);
--> statement-breakpoint
CREATE TABLE "travel_times" (
	"from_postal" text NOT NULL,
	"to_postal" text NOT NULL,
	"minutes" integer NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "travel_times_from_postal_to_postal_pk" PRIMARY KEY("from_postal","to_postal")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "is_technician" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "technician_user_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "start_minute" integer;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "duration_minutes" integer;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "travel_minutes" integer;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "en_route_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "eta_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "checked_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "checked_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "technician_availability" ADD CONSTRAINT "technician_availability_technician_user_id_users_id_fk" FOREIGN KEY ("technician_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_locations" ADD CONSTRAINT "technician_locations_technician_user_id_users_id_fk" FOREIGN KEY ("technician_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "technician_availability_date_idx" ON "technician_availability" USING btree ("date");--> statement-breakpoint
CREATE INDEX "technician_locations_user_idx" ON "technician_locations" USING btree ("technician_user_id","recorded_at");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_technician_user_id_users_id_fk" FOREIGN KEY ("technician_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_technician_date_idx" ON "appointments" USING btree ("technician_user_id","date");--> statement-breakpoint
-- B87: rol monteur (eigen inlog, alleen eigen klussen) en recht technician.portal.
INSERT INTO "roles" ("key", "name", "description")
VALUES ('monteur', 'Monteur', 'Monteur van een installatiepartner: eigen dagplanning, klus aanmelden en afmelden (opleveren), locatie tijdens de werkdag')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "id", p FROM "roles", unnest(ARRAY['technician.portal', 'mfa.sms']) AS p WHERE "key" = 'monteur'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Bestaande partnergebruikers zijn voortaan ook monteur (eenmanszaak); de partner kan dat per persoon uitzetten.
UPDATE "users" SET "is_technician" = true
WHERE "organization_id" IN (SELECT "id" FROM "organizations" WHERE "type" = 'installation_partner');--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "id", 'technician.portal' FROM "roles" WHERE "key" = 'installatiepartner'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Bestaande ochtend-/middagblokken omzetten naar 2-uursblokken voor de monteurs van die partner.
INSERT INTO "technician_availability" ("technician_user_id", "date", "slot")
SELECT u."id", b."date", s
FROM "availability_blocks" b
JOIN "users" u ON u."organization_id" = b."partner_organization_id" AND u."is_technician" AND u."is_active"
CROSS JOIN LATERAL unnest(CASE WHEN b."part" = 'morning' THEN ARRAY[0, 1] ELSE ARRAY[2, 3] END) AS s
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Bestaande afspraken: eerste monteur van de partner, starttijd uit het dagdeel.
UPDATE "appointments" a SET
  "technician_user_id" = (SELECT u."id" FROM "users" u WHERE u."organization_id" = a."partner_organization_id" AND u."is_technician" ORDER BY u."created_at" LIMIT 1),
  "start_minute" = CASE WHEN a."time_window" = 'afternoon' THEN 720 ELSE 480 END,
  "duration_minutes" = CASE WHEN a."type" = 'installation' THEN 360 ELSE 120 END
WHERE a."start_minute" IS NULL;
