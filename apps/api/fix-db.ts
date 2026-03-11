import { config } from 'dotenv';
config();
import { Pool } from 'pg';

async function run() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(`ALTER TYPE transport_mode ADD VALUE IF NOT EXISTS 'driving'`);
    await pool.query(`ALTER TYPE transport_mode ADD VALUE IF NOT EXISTS 'foot'`);
    await pool.query(`ALTER TYPE transport_mode ADD VALUE IF NOT EXISTS 'bike'`);
    await pool.query(`ALTER TYPE transport_mode ADD VALUE IF NOT EXISTS 'direct'`);
    console.log('Enum updated');
  } catch(e) { console.error(e.message) }
  await pool.end();
}
run();
