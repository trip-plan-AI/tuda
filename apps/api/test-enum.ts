import { config } from 'dotenv';
config();
import { Pool } from 'pg';

async function run() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const res = await pool.query(`SELECT enumlabel FROM pg_enum WHERE enumtypid = 'transport_mode'::regtype;`);
    console.log(res.rows);
  } catch(e) { console.error(e.message) }
  await pool.end();
}
run();
