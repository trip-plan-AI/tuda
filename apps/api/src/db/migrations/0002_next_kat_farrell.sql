CREATE TABLE "cities" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "cities_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"name_ru" text NOT NULL,
	"name_transliterated" text NOT NULL,
	"country_code" text NOT NULL,
	"country_name_ru" text,
	"admin_name_ru" text,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"population" integer,
	"place_id" text
);
--> statement-breakpoint
ALTER TABLE "trip_collaborators" ADD COLUMN "is_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "cities_name_transliterated_idx" ON "cities" USING btree ("name_transliterated");--> statement-breakpoint
CREATE INDEX "cities_name_ru_idx" ON "cities" USING btree ("name_ru");--> statement-breakpoint
CREATE INDEX "cities_country_code_idx" ON "cities" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "cities_population_idx" ON "cities" USING btree ("population");