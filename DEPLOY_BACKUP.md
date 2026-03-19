# Postgres backup (Docker Compose)

## 1) Create backup directory
```bash
mkdir -p /opt/backups/postgres
```

## 2) Make backup
```bash
cd /opt/apps/travel-planner
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip > /opt/backups/postgres/backup_$(date +%F_%H-%M).sql.gz
```

## 3) Restore backup (danger: overwrites data)
```bash
gunzip -c /opt/backups/postgres/backup_YYYY-MM-DD_HH-MM.sql.gz | docker compose -f docker-compose.prod.yml exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

## 4) Minimal retention policy (keep 14 days)
```bash
find /opt/backups/postgres -type f -name "*.sql.gz" -mtime +14 -delete
```

## 5) Emergency hotfix: add missing `distance_km` safely

Use only if deploy failed due to `column trips.distance_km does not exist` and before rerun deploy.

```bash
cd /opt/apps/travel-planner
docker compose -f docker-compose.prod.yml exec -T db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "ALTER TABLE public.trips ADD COLUMN IF NOT EXISTS distance_km double precision DEFAULT 0 NOT NULL;"'
```

Validate:

```bash
cd /opt/apps/travel-planner
docker compose -f docker-compose.prod.yml exec -T db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = '\''public'\'' AND table_name = '\''trips'\'' AND column_name = '\''distance_km'\'';"'
```

## 6) Deploy diagnostics runbook (systematic)

If deploy fails, inspect in this exact order:

1. **Migration stage**: look for `[deploy][step] db:migrate started/finished` and check `already exists` / `42710`.
2. **Schema contract stage**: check `[deploy][step] schema contract verification`.
3. **Seed stage**: check `[deploy][step] db:seed` and missing columns.
4. **Runtime stage**: check `docker up --wait`, API health, nginx/api logs.

Manual verification commands:

```bash
cd /opt/apps/travel-planner
docker compose -f docker-compose.prod.yml exec -T db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "\\d+ public.trips"'
docker compose -f docker-compose.prod.yml exec -T db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "\\d+ public.route_points"'
docker compose -f docker-compose.prod.yml exec -T db sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT * FROM __drizzle_migrations ORDER BY id;"'
docker compose -f docker-compose.prod.yml logs --no-color --tail=200 api
docker compose -f docker-compose.prod.yml logs --no-color --tail=200 nginx
```

## 7) Migration ledger policy

Migration history in [`apps/api/src/db/migrations`](apps/api/src/db/migrations) is **append-only**:

- do not delete old `*.sql` files
- do not edit already committed old `*.sql` files
- do not rewrite old entries in [`apps/api/src/db/migrations/meta/_journal.json`](apps/api/src/db/migrations/meta/_journal.json)
- only append new migration files and new journal entries at the end

CI now validates this policy through [`scripts/ci/verify-migration-ledger.sh`](scripts/ci/verify-migration-ledger.sh).

## 8) Recovery philosophy

If production schema already contains objects from a migration, but drizzle history is missing the corresponding tag, [`scripts/ci/migrate-db.sh`](scripts/ci/migrate-db.sh) may perform **safe history repair** only for explicitly registered migrations.

Current registered repair contract:

- [`0010_pale_magma`](apps/api/src/db/migrations/0010_pale_magma.sql)

The repair is allowed only when all expected runtime objects already exist. Otherwise deploy must stop and be investigated manually.
