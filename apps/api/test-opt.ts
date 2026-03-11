import { config } from 'dotenv';
config();
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './src/db/schema';
import { OptimizationService } from './src/optimization/optimization.service';
import { Pool } from 'pg';

async function run() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool, { schema });
  const optService = new OptimizationService(db as any);
  
  const trips = await db.query.trips.findMany({
    with: { points: true }
  });
  
  const trip = trips.find(t => t.points.length > 2);
  if (!trip) { console.log('No trips with > 2 points'); return pool.end(); }
  
  console.log('Optimizing trip', trip.id, 'with points:', trip.points.length);
  try {
    const res = await optService.optimizeTrip(trip.id, {}, trip.ownerId);
    console.log('Success:', res.metrics);
  } catch (err) {
    console.error('Error:', err);
  }
  await pool.end();
}
run();
