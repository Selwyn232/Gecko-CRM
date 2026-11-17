CREATE TABLE "account_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "partner_product_groups" (
	"partner_organization_id" uuid NOT NULL,
	"product_group_id" uuid NOT NULL,
	CONSTRAINT "partner_product_groups_partner_organization_id_product_group_id_pk" PRIMARY KEY("partner_organization_id","product_group_id")
);
--> statement-breakpoint
ALTER TABLE "account_invites" ADD CONSTRAINT "account_invites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_product_groups" ADD CONSTRAINT "partner_product_groups_partner_organization_id_organizations_id_fk" FOREIGN KEY ("partner_organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_product_groups" ADD CONSTRAINT "partner_product_groups_product_group_id_product_groups_id_fk" FOREIGN KEY ("product_group_id") REFERENCES "public"."product_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_invites_user_idx" ON "account_invites" USING btree ("user_id");