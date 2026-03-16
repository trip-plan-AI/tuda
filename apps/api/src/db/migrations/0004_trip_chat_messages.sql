-- TRI-120: Add trip_chat_messages table for real-time collaboration chat
CREATE TABLE IF NOT EXISTS "trip_chat_messages" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "trip_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "content" text NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "trip_chat_messages" ADD CONSTRAINT "trip_chat_messages_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;

--> statement-breakpoint
ALTER TABLE "trip_chat_messages" ADD CONSTRAINT "trip_chat_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_trip_chat_messages_trip_id_created_at" ON "trip_chat_messages" USING btree ("trip_id", "created_at");
