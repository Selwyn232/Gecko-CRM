CREATE TABLE "sms_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sms_phone" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sms_enabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sms_codes" ADD CONSTRAINT "sms_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sms_codes_user_idx" ON "sms_codes" USING btree ("user_id","created_at");--> statement-breakpoint
-- Installatiepartners mogen standaard 2FA via sms gebruiken (per rol aan te passen bij Rollen & rechten).
INSERT INTO "role_permissions" ("role_id", "permission") SELECT "id", 'mfa.sms' FROM "roles" WHERE "key" = 'installatiepartner' ON CONFLICT DO NOTHING;
