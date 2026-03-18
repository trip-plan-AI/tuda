#!/usr/bin/env bash
# Надежный и безопасный скрипт миграции БД для продакшена
# Стратегия: preflight checks -> drizzle-kit migrate -> валидация схемы
set -Eeuo pipefail

LOG_FILE="${LOG_FILE:-/tmp/db_migrate.log}"
MAX_RETRIES="${MAX_RETRIES:-2}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"

log() {
  echo "[migrate] $(date -u +"%Y-%m-%dT%H:%M:%SZ") $*" | tee -a "$LOG_FILE"
}

log_error() {
  echo "[migrate][error] $(date -u +"%Y-%m-%dT%H:%M:%SZ") $*" | tee -a "$LOG_FILE" >&2
}

preflight_checks() {
  log "running preflight checks..."

  if [ ! -f "./apps/api/src/db/migrations/meta/_journal.json" ]; then
    log_error "required migrations journal not found: ./apps/api/src/db/migrations/meta/_journal.json"
    return 1
  fi

  if ! ls ./apps/api/src/db/migrations/*.sql >/dev/null 2>&1; then
    log_error "no SQL migration files found in ./apps/api/src/db/migrations"
    return 1
  fi

  docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT 1" >/dev/null
  ' 2>&1 | tee -a "$LOG_FILE"

  docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT postgis_full_version();" >/dev/null
  ' 2>&1 | tee -a "$LOG_FILE"

  log "preflight checks passed"
}

# Функция для применения миграций через drizzle-kit migrate
run_migrate() {
  local retry_count=0

  while [ $retry_count -lt $MAX_RETRIES ]; do
    retry_count=$((retry_count + 1))
    log "attempt $retry_count of $MAX_RETRIES..."

    if COREPACK_ENABLE_DOWNLOAD_PROMPT=0 docker compose -f "$COMPOSE_FILE" run --rm -T --no-deps api \
      pnpm --filter api db:migrate < /dev/null 2>&1 | tee -a "$LOG_FILE"; then
      log "migrate completed successfully"
      return 0
    fi

    log_error "migrate attempt $retry_count failed"
    sleep 2
  done

  log_error "all migrate attempts failed"
  return 1
}

# Если прод уже инициализирован (таблицы/ENUM существуют),
# но таблица истории миграций отсутствует, аккуратно создаем baseline.
bootstrap_drizzle_history_if_needed() {
  log "checking drizzle migrations baseline..."

  local need_baseline
  need_baseline=$(docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -t -A -c "
      SELECT CASE
        WHEN to_regclass('\''public.__drizzle_migrations'\'') IS NULL
         AND to_regclass('\''public.trips'\'') IS NOT NULL
         AND to_regclass('\''public.route_points'\'') IS NOT NULL
         AND to_regclass('\''public.trip_chat_messages'\'') IS NOT NULL
         AND to_regclass('\''public.ai_cities'\'') IS NOT NULL
         AND to_regclass('\''public.ai_clusters'\'') IS NOT NULL
         AND to_regclass('\''public.ai_pois'\'') IS NOT NULL
         AND EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = '\''public'\''
             AND table_name = '\''trips'\''
             AND column_name = '\''distance_km'\''
         )
         AND EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = '\''public'\''
             AND table_name = '\''route_points'\''
             AND column_name = '\''duration'\''
         )
         AND EXISTS (SELECT 1 FROM pg_type WHERE typname = '\''collaborator_role'\'')
        THEN '\''yes'\''
        ELSE '\''no'\''
      END;
    "
  ' 2>&1) || {
    log_error "failed to detect drizzle baseline state"
    return 1
  }

  need_baseline="$(echo "$need_baseline" | tr -d '[:space:]')"

  if [ "$need_baseline" != "yes" ]; then
    log "drizzle baseline is not required"
    return 0
  fi

  log "drizzle migrations table is missing on initialized schema, bootstrapping baseline..."

  docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "
      CREATE TABLE IF NOT EXISTS public.__drizzle_migrations (
        id serial PRIMARY KEY,
        hash text NOT NULL UNIQUE,
        created_at bigint NOT NULL
      );
    "
  ' 2>&1 | tee -a "$LOG_FILE"

  local file hash created_at
  for file in ./apps/api/src/db/migrations/*.sql; do
    hash=$(sha256sum "$file" | awk '{print $1}')
    created_at=$(date +%s%3N)

    docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc "
      psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -c \"
        INSERT INTO public.__drizzle_migrations (hash, created_at)
        VALUES ('$hash', $created_at)
        ON CONFLICT (hash) DO NOTHING;
      \"
    " 2>&1 | tee -a "$LOG_FILE"
  done

  log "drizzle baseline bootstrap finished"
}

# Пост-миграционная валидация критических колонок
validate_schema() {
  log "validating critical schema columns..."

  # Проверяем наличие критических колонок в ai_sessions
  local missing_columns
  missing_columns=$(docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -t -A -c "
      WITH required(table_name, column_name) AS (
        VALUES
          ('\''ai_sessions'\'', '\''id'\''),
          ('\''ai_sessions'\'', '\''trip_id'\''),
          ('\''ai_sessions'\'', '\''user_id'\''),
          ('\''ai_sessions'\'', '\''messages'\''),
          ('\''ai_sessions'\'', '\''title'\''),
          ('\''ai_sessions'\'', '\''created_at'\''),
          ('\''ai_sessions'\'', '\''updated_at'\'')
      )
      SELECT r.table_name || '\''.'\'' || r.column_name
      FROM required r
      LEFT JOIN information_schema.columns c
        ON c.table_schema = '\''public'\''
        AND c.table_name = r.table_name
        AND c.column_name = r.column_name
      WHERE c.column_name IS NULL
      ORDER BY r.table_name, r.column_name;
    "
  ' 2>&1) || {
    log_error "schema validation query failed"
    return 1
  }

  if [ -n "$missing_columns" ]; then
    log_error "schema validation failed — missing columns:"
    echo "$missing_columns" | tee -a "$LOG_FILE"
    return 1
  fi

  log "schema validation passed — all critical columns exist"

  # Дополнительная проверка ENUM типов
  log "validating ENUM types..."
  local enum_check
  enum_check=$(docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -t -A -c "
      SELECT typname
      FROM pg_type
      WHERE typnamespace = '\''public'\''::regnamespace
        AND typname IN ('\''collaborator_role'\'', '\''transport_mode'\'', '\''poi_category'\'')
      ORDER BY typname;
    "
  ' 2>&1) || {
    log_error "ENUM validation query failed"
    return 1
  }

  local enum_count
  enum_count=$(echo "$enum_check" | grep -c . || true)
  if [ "$enum_count" -lt 3 ]; then
    log_error "ENUM validation failed — expected 3 enums, found $enum_count"
    return 1
  fi

  log "ENUM validation passed — found $enum_count enums"
  return 0
}

# Основная функция
main() {
  log "started"

  # Шаг 0: Preflight проверки перед миграцией
  if ! preflight_checks; then
    log_error "preflight checks failed"
    exit 1
  fi

  # Шаг 1: Активируем PostGIS (идемпотентно)
  log "enabling PostGIS extension..."
  docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS postgis;"
  ' 2>&1 | tee -a "$LOG_FILE" || log "PostGIS extension may already exist"

  # Шаг 2: Проверяем/восстанавливаем историю drizzle миграций для существующей схемы
  if ! bootstrap_drizzle_history_if_needed; then
    log_error "failed to bootstrap drizzle migration baseline"
    exit 1
  fi

  # Шаг 3: Применяем миграции через drizzle-kit migrate
  if run_migrate; then
    log "success via migrate"
  else
    log_error "migrate failed, automatic fallback is disabled for production safety"
    exit 1
  fi

  # Шаг 4: Пост-миграционная валидация
  if ! validate_schema; then
    log_error "schema validation failed after migration"
    exit 1
  fi

  log "all migrations completed and validated successfully"
}

main "$@"
