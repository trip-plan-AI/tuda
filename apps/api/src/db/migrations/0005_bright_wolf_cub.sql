CREATE TABLE IF NOT EXISTS "ai_city_dataset_meta" (
	"city_id" uuid PRIMARY KEY NOT NULL,
	"poi_count" real,
	"cluster_count" real,
	"generated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_explanation_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_hash" text NOT NULL,
	"explanation" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_explanation_cache_route_hash_unique" UNIQUE("route_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_overpass_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city" text NOT NULL,
	"query_hash" text NOT NULL,
	"response_json" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_cities" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "ai_cities" ADD COLUMN "bbox" jsonb;--> statement-breakpoint
ALTER TABLE "ai_cities" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_clusters" ADD COLUMN "radius" real;--> statement-breakpoint
ALTER TABLE "ai_clusters" ADD COLUMN "poi_count" real;--> statement-breakpoint
ALTER TABLE "ai_clusters" ADD COLUMN "total_score" real DEFAULT 0;--> statement-breakpoint
ALTER TABLE "ai_pois" ADD COLUMN "geom" "geography(Point, 4326)";--> statement-breakpoint
ALTER TABLE "ai_pois" ADD COLUMN "wikidata_id" text;--> statement-breakpoint
ALTER TABLE "ai_pois" ADD COLUMN "importance" real DEFAULT 0;--> statement-breakpoint
ALTER TABLE "ai_pois" ADD COLUMN "popularity" real DEFAULT 0;--> statement-breakpoint
ALTER TABLE "ai_pois" ADD COLUMN "cluster_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_pois" ADD COLUMN "duration" real DEFAULT 60;--> statement-breakpoint
ALTER TABLE "ai_pois" ADD COLUMN "opening_hours" text;--> statement-breakpoint
ALTER TABLE "ai_pois" ADD COLUMN "tags" jsonb;--> statement-breakpoint
ALTER TABLE "ai_pois" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "ai_city_dataset_meta" ADD CONSTRAINT "ai_city_dataset_meta_city_id_ai_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."ai_cities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_overpass_query_idx" ON "ai_overpass_cache" USING btree ("city","query_hash");--> statement-breakpoint
CREATE INDEX "idx_pois_geom" ON "ai_pois" USING gist ("geom");