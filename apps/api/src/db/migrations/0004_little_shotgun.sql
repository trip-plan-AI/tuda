CREATE TABLE IF NOT EXISTS "ai_cities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"lat" real NOT NULL,
	"lon" real NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_cities_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"center_lat" real NOT NULL,
	"center_lon" real NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_pois" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city_id" uuid NOT NULL,
	"osm_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"lat" real NOT NULL,
	"lon" real NOT NULL,
	"ai_weight" real DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_pois_city_id_osm_id_unique" UNIQUE("city_id","osm_id")
);
--> statement-breakpoint
ALTER TABLE "route_points" ADD COLUMN "duration" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_clusters" ADD CONSTRAINT "ai_clusters_city_id_ai_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."ai_cities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_pois" ADD CONSTRAINT "ai_pois_city_id_ai_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."ai_cities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_cities_name_idx" ON "ai_cities" USING btree ("name");--> statement-breakpoint
CREATE INDEX "ai_pois_city_id_idx" ON "ai_pois" USING btree ("city_id");