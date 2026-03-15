import { config } from 'dotenv';
import path from 'path';
config({ path: path.join(__dirname, '../../.env') });
import { Pool } from 'pg';
import * as fs from 'fs';
import * as zlib from 'zlib';

async function run() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  
  try {
    console.log('Fetching popular destinations from DB...');
    const result = await pool.query('SELECT name_ru as "nameRu", aliases, type, country_code as "countryCode", display_name as "displayName", lon, lat, popularity FROM popular_destinations');
    
    console.log(`Fetched ${result.rowCount} rows.`);
    
    const jsonData = JSON.stringify(result.rows);
    const outputPath = path.join(__dirname, 'src/db/popular_destinations.json.gz');
    
    console.log(`Compressing to ${outputPath}...`);
    const compressed = zlib.gzipSync(jsonData);
    fs.writeFileSync(outputPath, compressed);
    
    console.log('Export completed successfully.');
  } catch (err) {
    console.error('Export failed:', err.message);
  } finally {
    await pool.end();
  }
}

run();
