import { config } from 'dotenv';
import path from 'path';
config({ path: path.join(__dirname, '../../.env') });
import { Pool } from 'pg';

async function run() {
  console.log('Connecting to database...');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'trip_chat_messages'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      console.log('Creating trip_chat_messages table...');
      await pool.query(`
        CREATE TABLE "trip_chat_messages" (
          "id"         uuid        PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "trip_id"    uuid        NOT NULL,
          "user_id"    uuid        NOT NULL,
          "user_email" text        NOT NULL,
          "content"    text        NOT NULL,
          "created_at" timestamp   NOT NULL DEFAULT now()
        );
      `);

      await pool.query(`
        ALTER TABLE "trip_chat_messages"
          ADD CONSTRAINT "trip_chat_messages_trip_id_fk"
          FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;
      `);

      await pool.query(`
        ALTER TABLE "trip_chat_messages"
          ADD CONSTRAINT "trip_chat_messages_user_id_fk"
          FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE;
      `);

      // Index for fast history lookup by trip
      await pool.query(`
        CREATE INDEX "idx_trip_chat_messages_trip_id_created_at"
          ON "trip_chat_messages" ("trip_id", "created_at" DESC);
      `);

      console.log('trip_chat_messages table created successfully.');
    } else {
      console.log('trip_chat_messages table already exists.');
    }
  } catch (err) {
    console.error('Error executing SQL:', (err as Error).message);
  } finally {
    await pool.end();
    console.log('Database connection closed.');
  }
}

run();
