ALTER TABLE "trip_collaborators" ADD COLUMN "is_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "trips" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;