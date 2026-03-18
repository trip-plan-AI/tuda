#!/usr/bin/env bash
# Надежный и безопасный скрипт миграции БД для продакшена
# Стратегия: preflight checks -> apply enums -> drizzle-kit migrate -> валидация схемы
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

  if [ ! -f "./apps/api/src/db/00-enums.sql" ]; then
    log_error "required file not found: ./apps/api/src/db/00-enums.sql"
    return 1
  fi

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

# Применение идемпотентных ENUM типов
apply_enums() {
  log "applying idempotent ENUM types..."

  if docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1
  ' < ./apps/api/src/db/00-enums.sql 2>&1 | tee -a "$LOG_FILE"; then
    log "ENUM types applied successfully"
    return 0
  else
    log_error "failed to apply ENUM types"
    return 1
  fi
}

# Основная функция
main() {
  log "started"

  # Шаг 0: Preflight проверки перед миграцией
  if ! preflight_checks; then
    log_error "preflight checks failed"
    exit 1
  fi

  # Шаг 1: Применяем ENUM типы (идемпотентно)
  if ! apply_enums; then
    log_error "ENUM application failed, continuing anyway..."
  fi

  # Шаг 2: Активируем PostGIS (идемпотентно)
  log "enabling PostGIS extension..."
  docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS postgis;"
  ' 2>&1 | tee -a "$LOG_FILE" || log "PostGIS extension may already exist"

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
