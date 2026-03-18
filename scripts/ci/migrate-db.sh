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

  if ! validate_migration_set_integrity; then
    log_error "migration-set integrity validation failed"
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

validate_migration_set_integrity() {
  log "validating migration-set integrity..."

  local validation_output
  validation_output=$(python3 - <<'PY'
import json
from pathlib import Path

base = Path('./apps/api/src/db/migrations')
meta = base / 'meta'
journal_path = meta / '_journal.json'

with journal_path.open('r', encoding='utf-8') as fh:
    journal = json.load(fh)

entries = journal.get('entries', [])
entry_tags = [str(entry.get('tag', '')).strip() for entry in entries if str(entry.get('tag', '')).strip()]
sql_files = sorted(p.stem for p in base.glob('*.sql'))
snapshot_files = sorted(p.stem.replace('_snapshot', '') for p in meta.glob('*_snapshot.json'))

missing_sql = [tag for tag in entry_tags if tag not in sql_files]
orphan_sql = [name for name in sql_files if name not in entry_tags]
missing_snapshots = [tag for tag in entry_tags if tag != '0009_trip_chat_messages' and tag not in snapshot_files]

issues = []
for tag in missing_sql:
    issues.append(f'MISSING_SQL:{tag}')
for name in orphan_sql:
    issues.append(f'ORPHAN_SQL:{name}')
for tag in missing_snapshots:
    issues.append(f'MISSING_SNAPSHOT:{tag}')

if issues:
    print('\n'.join(issues))
    raise SystemExit(1)

print('OK')
PY
  ) || {
    log_error "broken migration-set detected"
    echo "$validation_output" | tee -a "$LOG_FILE"
    return 1
  }

  log "migration-set integrity is valid"
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

# Единый registry runtime-контракта БД.
# Формат строки: table|column|sql_to_apply
# Разрешаем только additive, идемпотентные reconciliation-операции.
runtime_contract_registry() {
  cat <<'EOF'
ai_sessions|updated_at|ALTER TABLE public.ai_sessions ADD COLUMN IF NOT EXISTS updated_at timestamp DEFAULT now() NOT NULL;
EOF
}

reconcile_runtime_contract() {
  log "reconciling runtime schema contract..."

  while IFS='|' read -r table_name column_name apply_sql; do
    [ -n "$table_name" ] || continue

    local column_exists
    column_exists=$(docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc "
      psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -t -A -c \"
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = '$table_name'
            AND column_name = '$column_name'
        )::int;
      \"
    " 2>&1 | tr -d '[:space:]')

    if [ "$column_exists" = "1" ]; then
      log "runtime contract ok: $table_name.$column_name already exists"
      continue
    fi

    log "runtime contract drift detected: applying additive reconciliation for $table_name.$column_name"
    docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc "
      psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -c \"$apply_sql\"
    " 2>&1 | tee -a "$LOG_FILE"
  done < <(runtime_contract_registry)

  log "runtime schema reconciliation finished"
}

# Если прод уже инициализирован (таблицы/ENUM существуют),
# а история drizzle отсутствует или пуста, аккуратно создаем baseline.
bootstrap_drizzle_history_if_needed() {
  log "checking drizzle migrations baseline..."

  local baseline_state
  baseline_state=$(docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -t -A -c "
      SELECT
        (to_regclass('\''public.__drizzle_migrations'\'') IS NOT NULL)::int || '\''|'\'' ||
        CASE
          WHEN to_regclass('\''public.__drizzle_migrations'\'') IS NULL THEN 0
          ELSE (SELECT COUNT(*)::int FROM public.__drizzle_migrations)
        END || '\''|'\'' ||
        (
          to_regclass('\''public.trips'\'') IS NOT NULL
          AND to_regclass('\''public.route_points'\'') IS NOT NULL
          AND to_regclass('\''public.ai_sessions'\'') IS NOT NULL
        )::int || '\''|'\'' ||
        (EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = '\''public'\''::regnamespace AND typname = '\''collaborator_role'\''))::int;
    "
  ' 2>&1) || {
    log_error "failed to detect drizzle baseline state"
    return 1
  }

  baseline_state="$(echo "$baseline_state" | tr -d '[:space:]')"

  local table_exists rows_count core_tables_ready enum_ready
  IFS='|' read -r table_exists rows_count core_tables_ready enum_ready <<< "$baseline_state"

  log "baseline state: table_exists=$table_exists rows_count=$rows_count core_tables_ready=$core_tables_ready enum_ready=$enum_ready"

  if [ "$rows_count" != "0" ]; then
    log "drizzle baseline is not required"
    return 0
  fi

  if [ "$core_tables_ready" != "1" ] && [ "$enum_ready" != "1" ]; then
    log "schema looks fresh (no core tables and no enums), baseline bootstrap is not required"
    return 0
  fi

  log "detected partially initialized schema with empty drizzle history, bootstrapping baseline from journal..."

  log "drizzle history is empty on initialized schema, bootstrapping baseline from journal..."

  if [ "$table_exists" != "1" ]; then
    docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc '
      psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "
        CREATE TABLE IF NOT EXISTS public.__drizzle_migrations (
          id serial PRIMARY KEY,
          hash text NOT NULL UNIQUE,
          created_at bigint NOT NULL,
          idx_serial integer,
          \"when\" bigint,
          tag text,
          breakpoints boolean
        );
      "
    ' 2>&1 | tee -a "$LOG_FILE"
  fi

  local journal_file="./apps/api/src/db/migrations/meta/_journal.json"
  if [ ! -f "$journal_file" ]; then
    log_error "journal not found: $journal_file"
    return 1
  fi

  local expected_count
  expected_count=$(python3 - <<'PY'
import json
with open('./apps/api/src/db/migrations/meta/_journal.json', 'r', encoding='utf-8') as f:
    data = json.load(f)
print(len(data.get('entries', [])))
PY
)

  local line idx when_ms tag breakpoints file hash
  while IFS=$'\t' read -r idx when_ms tag breakpoints; do
    file="./apps/api/src/db/migrations/${tag}.sql"
    if [ ! -f "$file" ]; then
      log_error "migration file from journal not found: $file"
      return 1
    fi

    hash=$(sha256sum "$file" | awk '{print $1}')

    docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc "
      psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -c \"
        INSERT INTO public.__drizzle_migrations (hash, created_at, idx_serial, \\\"when\\\", tag, breakpoints)
        SELECT '$hash', $when_ms, $idx, $when_ms, '$tag', $breakpoints
        WHERE NOT EXISTS (
          SELECT 1
          FROM public.__drizzle_migrations
          WHERE hash = '$hash'
             OR (tag = '$tag' AND idx_serial = $idx)
        );
      \"
    " 2>&1 | tee -a "$LOG_FILE"
  done < <(python3 - <<'PY'
import json
with open('./apps/api/src/db/migrations/meta/_journal.json', 'r', encoding='utf-8') as f:
    data = json.load(f)
for e in data.get('entries', []):
    idx = int(e.get('idx', 0))
    when_ms = int(e.get('when', 0))
    tag = str(e.get('tag', '')).strip()
    breakpoints = 'true' if bool(e.get('breakpoints', False)) else 'false'
    print(f"{idx}\t{when_ms}\t{tag}\t{breakpoints}")
PY
)

  local actual_count
  actual_count=$(docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -t -A -c "
      SELECT COUNT(*)::int FROM public.__drizzle_migrations
      WHERE tag IS NOT NULL;
    "
  ' 2>&1 | tr -d '[:space:]')

  if [ "$actual_count" -lt "$expected_count" ]; then
    log_error "baseline bootstrap is incomplete: expected_entries=$expected_count actual_tagged_rows=$actual_count"
    return 1
  fi

  log "drizzle baseline bootstrap finished"
}

# Пост-миграционная валидация критических колонок
validate_schema() {
  log "validating critical schema columns..."

  # Проверяем runtime-контракт после migrate + reconciliation.
  # Здесь должны существовать поля, которые реально читает/пишет backend-код.
  local missing_columns
  missing_columns=$(docker compose -f "$COMPOSE_FILE" exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -t -A -c "
      WITH required(table_name, column_name) AS (
        VALUES
          ('\''trips'\'', '\''id'\''),
          ('\''trips'\'', '\''title'\''),
          ('\''trips'\'', '\''owner_id'\''),
          ('\''trips'\'', '\''is_active'\''),
          ('\''trips'\'', '\''is_predefined'\''),
          ('\''route_points'\'', '\''id'\''),
          ('\''route_points'\'', '\''trip_id'\''),
          ('\''route_points'\'', '\''transport_mode'\''),
          ('\''route_points'\'', '\''duration'\''),
          ('\''ai_sessions'\'', '\''id'\''),
          ('\''ai_sessions'\'', '\''messages'\''),
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

  log "schema validation passed — runtime contract is satisfied"

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

  # Шаг 4: Runtime reconciliation для additive schema drift
  if ! reconcile_runtime_contract; then
    log_error "runtime schema reconciliation failed"
    exit 1
  fi

  # Шаг 5: Пост-миграционная валидация
  if ! validate_schema; then
    log_error "schema validation failed after migration"
    exit 1
  fi

  log "all migrations completed and validated successfully"
}

main "$@"
