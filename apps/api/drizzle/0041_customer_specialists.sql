ALTER TABLE "users" ADD COLUMN "max_customers" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "accepts_new_customers" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "photo_data_url" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "specialist_user_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "specialist_assigned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "service_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_specialist_user_id_users_id_fk" FOREIGN KEY ("specialist_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_specialist_idx" ON "customers" USING btree ("specialist_user_id");--> statement-breakpoint
-- B81: wie nu klanten mag zien, blijft alle klanten zien (behalve de klantspecialist: alleen eigen klanten).
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT DISTINCT rp."role_id", 'customers.all' FROM "role_permissions" rp JOIN "roles" r ON r."id" = rp."role_id"
WHERE rp."permission" = 'customers.read' AND r."key" <> 'klantspecialist'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Klantspecialist: volledige klantkaart (facturen) en zelf plannen.
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "id", p FROM "roles", unnest(ARRAY['invoices.read', 'planning.manage']) AS p WHERE "key" = 'klantspecialist'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Nieuwe rol: manager klantenservice.
INSERT INTO "roles" ("key", "name", "description")
VALUES ('manager_klantenservice', 'Manager klantenservice', 'Overzicht over alle klantspecialisten: bezetting, maximum aantal klanten, klanten overzetten')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT "id", p FROM "roles", unnest(ARRAY['catalog.read', 'organizations.read', 'users.read', 'customers.read', 'customers.all', 'customers.manage', 'projects.read', 'projects.manage', 'quotes.read', 'quotes.manage', 'invoices.read', 'planning.read', 'planning.manage', 'specialists.manage']) AS p
WHERE "key" = 'manager_klantenservice'
ON CONFLICT DO NOTHING;
