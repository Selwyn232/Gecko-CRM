ALTER TABLE "users" ADD COLUMN "advisor_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_advisor_id_advisors_id_fk" FOREIGN KEY ("advisor_id") REFERENCES "public"."advisors"("id") ON DELETE no action ON UPDATE no action;