# Database Initialization with GeoNames Data

This document describes the database setup and GeoNames data loading process.

## Architecture

- **Data Source:** GeoNames (100,000 popular cities)
- **Translations:** OpenAI (Russian names & transliteration)
- **Storage:** PostgreSQL (cities table with indexes)
- **Deployment:** Docker-based, with database dumps for quick initialization

## Local Development Setup

### Step 1: Load GeoNames Data

```bash
cd travel-planner

# Run the loader
npx tsx apps/api/src/db/load-geonames.ts
```

**What it does:**
1. Downloads GeoNames cities500.txt (38MB)
2. Parses 100,000 cities
3. Translates city names to Russian via OpenAI API
4. Pre-computes transliteration (Russian → English)
5. Inserts into PostgreSQL with batching

**Duration:** ~3-4 hours (includes OpenAI API calls)

**Progress:** Check in another terminal:
```bash
# Monitor current count
npx tsx -e "import { Pool } from 'pg'; import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = await pool.query('SELECT COUNT(*) as count FROM cities');
  console.log(r.rows[0].count, '/ 100000');
  await pool.end();
})().catch(console.error);"
```

### Step 2: Export Database Dump

Once loading completes (100,000 cities):

```bash
# Automatic monitoring and export
bash scripts/monitor-and-export.sh

# Or manual export
bash scripts/export-db-dump.sh trip_dev postgres
```

**Output:**
- `docker/postgres-init/01-init.dump` (Custom format, ~100MB, compressed)
- `docker/postgres-init/01-init.sql` (SQL format, ~500MB, for reference)

## Docker Deployment

### Development (Local)

```bash
docker-compose up -d
```

PostgreSQL will automatically initialize from dumps in `docker/postgres-init/` on first run.

### Production (Server)

Same process - Docker will handle initialization:

```bash
docker-compose -f docker-compose.prod.yml up -d
```

**Key Points:**
- Dumps are mounted to `/docker-entrypoint-initdb.d/`
- PostgreSQL auto-executes `.dump` and `.sql` files on first container startup
- Database persists in named volume `postgres_data`
- Subsequent restarts use existing volume data

## Database Schema

**cities table:**
```
- id (serial PK)
- name (varchar) - English name
- name_ru (varchar) - Russian translation
- name_transliterated (varchar) - Latin transliteration (Russian → English)
- country_code (varchar, indexed)
- country_name_ru (varchar) - Russian country name
- admin_name_ru (varchar) - Russian state/province
- latitude (float)
- longitude (float)
- population (integer, indexed)
- place_id (varchar, unique) - GeoNames identifier
```

**Indexes:**
- `idx_cities_name_transliterated` - For translit search
- `idx_cities_name_ru` - For Russian search
- `idx_cities_country_code` - For country filtering
- `idx_cities_population` - For relevance sorting

## Geosearch Integration

The loader populates data used by Tier 0.5 (Local Cities) in the multi-tier geosearch:

1. **Tier 0:** Popular Destinations (hardcoded/cached)
2. **Tier 0.5:** Local Cities (from this cities table) ← **This loader**
3. **Tier 2:** DaData/Nominatim RU (external APIs)
4. **Tier 3:** Photon/Nominatim EN/Yandex (international fallback)

**Key Features:**
- **Language Detection:** Russian queries search `name_ru` + `name_transliterated`
- **Translit Search:** "Moskva" finds "Москва" and vice versa
- **Relevance Scoring:** Prefix matches + population weight
- **Fast:** ~25ms response via PostgreSQL indexes

## Troubleshooting

### Loader Crashes

If `load-geonames.ts` crashes:
- Check `OPENAI_API_KEY` is set in `.env`
- Verify `DATABASE_URL` is accessible
- Check available disk space (need ~2GB for files)
- Restart: `npx tsx apps/api/src/db/load-geonames.ts`
- Uses `onConflictDoNothing()` - won't duplicate existing data

### Docker PostgreSQL Not Initializing

```bash
# Check if init scripts are in container
docker exec travel-planner-db ls -la /docker-entrypoint-initdb.d/

# If dumps missing, copy them
docker cp docker/postgres-init/01-init.dump travel-planner-db:/docker-entrypoint-initdb.d/
docker restart travel-planner-db
```

### Slow Geosearch

- Verify indexes exist: `\d cities` in psql
- Check query plan: `EXPLAIN SELECT ... FROM cities WHERE name_ru ILIKE '%...'`
- May need `ANALYZE cities` after large inserts

## Configuration

**Environment Variables:**
```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trip_dev
OPENAI_API_KEY=sk-or-...  # From OpenRouter
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=trip_dev
```

**Loader Parameters** (in `load-geonames.ts`):
```typescript
const BATCH_SIZE = 100;           // Cities per batch
const MAX_CITIES = 100000;        // Total to load
const RATE_LIMIT = 1000;          // Delay between batches (ms)
```

Adjust if needed for performance/cost tuning.

## Performance Notes

- Loading 100,000 cities takes 3-4 hours due to OpenAI API rate limiting
- Each batch of 100 cities gets 1 OpenAI API call (cost: ~$0.01 per 1000 cities)
- Database dump (~100MB) loads in <10 seconds on modern hardware
- Geosearch queries: <25ms per request (via PostgreSQL index)

## Future Enhancements

- [ ] Incremental updates (add new cities without full reload)
- [ ] Secondary translations (French, Spanish, German)
- [ ] Alternative API providers (Google Translate, custom ML model)
- [ ] Offline transliteration (no API dependency)
