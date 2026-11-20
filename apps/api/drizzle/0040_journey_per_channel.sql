DROP INDEX "journey_statuses_key_unique";--> statement-breakpoint
DROP INDEX "journey_statuses_one_initial";--> statement-breakpoint
ALTER TABLE "journey_statuses" ADD COLUMN "sales_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "journey_statuses" ADD CONSTRAINT "journey_statuses_sales_channel_id_sales_channels_id_fk" FOREIGN KEY ("sales_channel_id") REFERENCES "public"."sales_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journey_statuses_key_unique" ON "journey_statuses" USING btree ("product_group_id",coalesce("sales_channel_id", '00000000-0000-0000-0000-000000000000'::uuid),"key");--> statement-breakpoint
CREATE UNIQUE INDEX "journey_statuses_one_initial" ON "journey_statuses" USING btree ("product_group_id",coalesce("sales_channel_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE is_initial;