CREATE TYPE "public"."collaborator_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."poi_category" AS ENUM('museum', 'park', 'restaurant', 'cafe', 'attraction', 'shopping', 'entertainment');--> statement-breakpoint
CREATE TYPE "public"."transport_mode" AS ENUM('driving', 'foot', 'bike', 'direct');--> statement-breakpoint
CREATE TABLE "ai_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid,
	"user_id" uuid NOT NULL,
	"messages" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "optimization_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"original_order" jsonb NOT NULL,
	"optimized_order" jsonb NOT NULL,
	"saved_km" double precision DEFAULT 0 NOT NULL,
	"saved_rub" double precision DEFAULT 0 NOT NULL,
	"saved_hours" double precision DEFAULT 0 NOT NULL,
	"transport_mode" "transport_mode" DEFAULT 'driving' NOT NULL,
	"params" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "popular_destinations" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "popular_destinations_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name_ru" text NOT NULL,
	"aliases" text,
	"type" text DEFAULT 'city' NOT NULL,
	"country_code" text NOT NULL,
	"display_name" text NOT NULL,
	"lon" real NOT NULL,
	"lat" real NOT NULL,
	"popularity" real DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trip_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"budget" integer,
	"visit_date" text,
	"image_url" text,
	"order" integer DEFAULT 0 NOT NULL,
	"address" text,
	"transport_mode" text DEFAULT 'driving' NOT NULL,
	"is_title_locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_collaborators" (
	"trip_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "collaborator_role" DEFAULT 'viewer' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "trip_collaborators_trip_id_user_id_pk" PRIMARY KEY("trip_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"photo" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "title" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "start_date" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trips" ALTER COLUMN "end_date" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "owner_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "is_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "is_predefined" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "img" text;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "tags" jsonb;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "temp" text;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "optimization_results" ADD CONSTRAINT "optimization_results_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_points" ADD CONSTRAINT "route_points_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_collaborators" ADD CONSTRAINT "trip_collaborators_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_collaborators" ADD CONSTRAINT "trip_collaborators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "popular_destinations_name_ru_idx" ON "popular_destinations" USING btree ("name_ru");--> statement-breakpoint
CREATE INDEX "popular_destinations_country_idx" ON "popular_destinations" USING btree ("country_code");--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;