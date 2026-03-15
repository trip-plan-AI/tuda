import { config } from 'dotenv';
import path from 'path';
config({ path: path.join(__dirname, '../../.env') });
import { Pool } from 'pg';

async function run() {
  console.log('Connecting to database...');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  
  try {
    console.log('Checking for invitations table...');
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'invitations'
      );
    `);

    if (!tableCheck.rows[0].exists) {
      console.log('Creating invitations table...');
      await pool.query(`
        CREATE TABLE "invitations" (
          "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
          "trip_id" uuid NOT NULL,
          "invited_user_id" uuid NOT NULL,
          "inviter_id" uuid NOT NULL,
          "created_at" timestamp DEFAULT now() NOT NULL,
          CONSTRAINT "invitations_trip_id_invited_user_id_unique" UNIQUE("trip_id","invited_user_id")
        );
      `);
      
      await pool.query(`
        ALTER TABLE "invitations" ADD CONSTRAINT "invitations_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;
      `);
      await pool.query(`
        ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_user_id_users_id_fk" FOREIGN KEY ("invited_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
      `);
      await pool.query(`
        ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
      `);
      console.log('Invitations table created successfully.');
    } else {
      console.log('Invitations table already exists.');
    }

    console.log('Checking for title column in ai_sessions...');
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='ai_sessions' and column_name='title';
    `);

    if (columnCheck.rowCount === 0) {
      console.log('Adding title column to ai_sessions...');
      await pool.query(`ALTER TABLE "ai_sessions" ADD COLUMN "title" text;`);
      console.log('Title column added successfully.');
    } else {
      console.log('Title column already exists in ai_sessions.');
    }

  } catch (err) {
    console.error('Error executing SQL:', err.message);
  } finally {
    await pool.end();
    console.log('Database connection closed.');
  }
}

run();
