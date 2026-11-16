ALTER TABLE "regions" ADD COLUMN "map_code" text;--> statement-breakpoint
ALTER TABLE "regions" ADD CONSTRAINT "regions_map_code_unique" UNIQUE("map_code");