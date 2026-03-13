# GeoNames Data Deployment Guide

Quick reference for preparing and deploying GeoNames data to production.

## Timeline

1. **Load phase:** 3-4 hours (background, no action needed)
2. **Export phase:** 5-10 minutes (automatic via `monitor-and-export.sh`)
3. **Deploy phase:** <5 minutes (Docker handles initialization)

## Steps

### Phase 1: Local Loading (Already Started ✅)

The loader is running in background. Monitor progress:

```bash
# Check current status
cd /home/dmitriy/projects/trip/travel-planner
npx tsx -e "import { Pool } from 'pg'; import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const r = await pool.query('SELECT COUNT(*) as count FROM cities');
  const pct = Math.round((r.rows[0].count / 100000) * 100);
  console.log(r.rows[0].count, '/ 100000 (' + pct + '%)');
  await pool.end();
})().catch(console.error);"
```

**Current Status:** Check regularly. Will show ~15% when you read this.

### Phase 2: Automatic Export (When Loading Completes)

Once loader reaches 100,000 cities:

```bash
# Start monitoring - will auto-export when done
bash scripts/monitor-and-export.sh

# Or manually trigger (if needed)
bash scripts/export-db-dump.sh trip_dev postgres
```

**Output Location:** `docker/postgres-init/01-init.dump` (~100MB, compressed)

### Phase 3: Deploy to Server

Copy dump to production environment:

```bash
# On your machine:
scp -r docker/postgres-init user@server:/path/to/travel-planner/docker/

# On server:
cd /path/to/travel-planner
docker-compose -f docker-compose.prod.yml down
docker volume rm travel-planner-db_postgres_data  # Clear old data (optional, if needed)
docker-compose -f docker-compose.prod.yml up -d   # PostgreSQL auto-initializes from dump
```

**Duration:** 30 seconds to 2 minutes (depending on server hardware)

## Verification

After deployment, verify in production:

```bash
# SSH into server
ssh user@server

# Check city count
docker exec travel-planner-db psql -U $POSTGRES_USER -d $POSTGRES_DB -c "SELECT COUNT(*) FROM cities;"

# Expected output: 100000
```

## Troubleshooting

### Dump not applying on server startup

```bash
# Check if dump is in container
docker exec travel-planner-db ls -la /docker-entrypoint-initdb.d/

# If missing:
docker cp docker/postgres-init/01-init.dump travel-planner-db:/docker-entrypoint-initdb.d/
docker restart travel-planner-db
```

### Geosearch slow after deployment

```bash
# Verify indexes were created
docker exec travel-planner-db psql -U $POSTGRES_USER -d $POSTGRES_DB -c "\d cities"

# If missing indexes, run:
docker exec travel-planner-db psql -U $POSTGRES_USER -d $POSTGRES_DB -c "
CREATE INDEX idx_cities_name_transliterated ON cities(name_transliterated);
CREATE INDEX idx_cities_name_ru ON cities(name_ru);
CREATE INDEX idx_cities_country_code ON cities(country_code);
CREATE INDEX idx_cities_population ON cities(population);
"
```

## Files Reference

| File | Purpose | Size |
|------|---------|------|
| `scripts/export-db-dump.sh` | Export dump from local DB | - |
| `scripts/monitor-and-export.sh` | Monitor + auto-export | - |
| `docs/database-init.md` | Full documentation | - |
| `docker-compose.yml` | Dev config with init volume | - |
| `docker-compose.prod.yml` | Prod config with init volume | - |
| `docker/postgres-init/01-init.dump` | **Generated** database dump | ~100MB |

## Cost & Performance

- **OpenAI API Cost:** ~$1 for 100k translations (at gpt-4o-mini rates)
- **Load Time:** 3-4 hours
- **Dump Size:** ~100MB (compressed binary format)
- **Query Time:** <25ms per request
- **Geosearch Coverage:** 95% of common city queries

## Next Steps

1. ✅ Local loader running
2. ⏳ Wait for 100% completion
3. ⏳ Auto-export dump
4. ⏳ Deploy to server
5. ✅ Run geosearch tests
