CREATE TABLE "ai_cities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"lat" real NOT NULL,
	"lon" real NOT NULL,
	"bbox" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_cities_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "ai_city_dataset_meta" (
	"city_id" uuid PRIMARY KEY NOT NULL,
	"poi_count" real,
	"cluster_count" real,
	"generated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"center_lat" real NOT NULL,
	"center_lon" real NOT NULL,
	"radius" real,
	"poi_count" real,
	"total_score" real DEFAULT 0,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_explanation_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_hash" text NOT NULL,
	"explanation" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_explanation_cache_route_hash_unique" UNIQUE("route_hash")
);
--> statement-breakpoint
CREATE TABLE "ai_overpass_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city" text NOT NULL,
	"query_hash" text NOT NULL,
	"response_json" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_pois" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"osm_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"lat" real NOT NULL,
	"lon" real NOT NULL,
	"geom" "geography(Point, 4326)",
	"wikidata_id" text,
	"importance" real DEFAULT 0,
	"ai_weight" real DEFAULT 0 NOT NULL,
	"popularity" real DEFAULT 0,
	"cluster_id" uuid,
	"duration" real DEFAULT 60,
	"opening_hours" text,
	"tags" jsonb,
	"address" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_pois_city_id_osm_id_unique" UNIQUE("city_id","osm_id")
);
--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "distance_km" double precision;--> statement-breakpoint
ALTER TABLE "ai_city_dataset_meta" ADD CONSTRAINT "ai_city_dataset_meta_city_id_ai_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."ai_cities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_clusters" ADD CONSTRAINT "ai_clusters_city_id_ai_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."ai_cities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pois" ADD CONSTRAINT "ai_pois_city_id_ai_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."ai_cities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_cities_name_idx" ON "ai_cities" USING btree ("name");--> statement-breakpoint
CREATE INDEX "ai_overpass_query_idx" ON "ai_overpass_cache" USING btree ("city","query_hash");--> statement-breakpoint
CREATE INDEX "ai_pois_city_id_idx" ON "ai_pois" USING btree ("city_id");--> statement-breakpoint
CREATE INDEX "idx_pois_geom" ON "ai_pois" USING gist ("geom");