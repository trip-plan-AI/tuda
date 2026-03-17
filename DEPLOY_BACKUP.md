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
