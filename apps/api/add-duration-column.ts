import { config } from 'dotenv';
config();
import { Pool } from 'pg';

async function run() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not defined');
    process.exit(1);
  }
  
  const pool = new Pool({ connectionString });
  try {
    console.log('Adding duration column to route_points...');
    await pool.query(`ALTER TABLE route_points ADD COLUMN IF NOT EXISTS duration INTEGER NOT NULL DEFAULT 0`);
    console.log('Column added successfully');
  } catch(e) { 
    console.error('Failed to add column:', e.message);
  } finally {
    await pool.end();
  }
}

run();
