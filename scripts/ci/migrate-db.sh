#!/usr/bin/env bash
# Надежный скрипт миграции БД для продакшена
# Стратегия: migrate -> (если failed) push --force -> (если failed) error
set -Eeuo pipefail

LOG_FILE="${LOG_FILE:-/tmp/db_migrate.log}"
MAX_RETRIES="${MAX_RETRIES:-2}"

echo "[migrate] started at $(date -u +"%Y-%m-%dT%H:%M:%SZ")" | tee -a "$LOG_FILE"

# Функция для проверки наличия таблицы миграций
ensure_migrations_table() {
  echo "[migrate] ensuring __drizzle_migrations table exists..." | tee -a "$LOG_FILE"
  
  # Создаем таблицу миграций если не существует
  # Drizzle ожидает именно такую структуру
  # Примечание: "when" - зарезервированное слово, используем кавычки
  docker compose -f docker-compose.prod.yml exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 <<EOF
CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint NOT NULL,
  idx_serial integer NOT NULL,
  "when" bigint NOT NULL,
  tag text NOT NULL,
  breakpoints boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS "__drizzle_migrations_hash_idx" ON "__drizzle_migrations" (hash);
EOF
  ' || {
    echo "[migrate][warn] failed to create migrations table, will retry..." | tee -a "$LOG_FILE"
    return 1
  }
  
  echo "[migrate] migrations table ready" | tee -a "$LOG_FILE"
  return 0
}

# Функция для применения миграций через drizzle-kit migrate
run_migrate() {
  local retry_count=0
  
  while [ $retry_count -lt $MAX_RETRIES ]; do
    retry_count=$((retry_count + 1))
    echo "[migrate] attempt $retry_count of $MAX_RETRIES..." | tee -a "$LOG_FILE"
    
    # Пробуем создать таблицу миграций
    ensure_migrations_table || sleep 2
    
    # Пробуем применить миграции
    if COREPACK_ENABLE_DOWNLOAD_PROMPT=0 docker compose -f docker-compose.prod.yml run --rm -T --no-deps api \
      pnpm --filter api db:migrate < /dev/null 2>&1 | tee -a "$LOG_FILE"; then
      echo "[migrate] migrate completed successfully" | tee -a "$LOG_FILE"
      return 0
    fi
    
    echo "[migrate][warn] migrate attempt $retry_count failed" | tee -a "$LOG_FILE"
    sleep 2
  done
  
  echo "[migrate][error] all migrate attempts failed" | tee -a "$LOG_FILE"
  return 1
}

# Функция для fallback на db:push
run_push_fallback() {
  echo "[migrate][fallback] starting db:push --force..." | tee -a "$LOG_FILE"
  
  if COREPACK_ENABLE_DOWNLOAD_PROMPT=0 docker compose -f docker-compose.prod.yml run --rm -T --no-deps api \
    pnpm --filter api db:push --force < /dev/null 2>&1 | tee -a "$LOG_FILE"; then
    echo "[migrate][fallback] push completed successfully" | tee -a "$LOG_FILE"
    return 0
  else
    echo "[migrate][error][fallback] push failed" | tee -a "$LOG_FILE"
    return 1
  fi
}

# Основной процесс
main() {
  # Шаг 0: Активируем PostGIS (идемпотентно, безопасно)
  echo "[migrate] enabling PostGIS extension..." | tee -a "$LOG_FILE"
  docker compose -f docker-compose.prod.yml exec --interactive=false -T db sh -lc '
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS postgis;" 2>&1 || echo "[postgis] extension may already exist or not available"
  ' | tee -a "$LOG_FILE"
  
  # Шаг 1: Пробуем основные миграции
  if run_migrate; then
    echo "[migrate] success via migrate" | tee -a "$LOG_FILE"
    return 0
  fi
  
  # Шаг 2: Fallback на push
  echo "[migrate] falling back to db:push --force..." | tee -a "$LOG_FILE"
  
  if run_push_fallback; then
    echo "[migrate] success via push fallback" | tee -a "$LOG_FILE"
    return 0
  fi
  
  echo "[migrate][error] all methods failed" | tee -a "$LOG_FILE"
  return 1
}

main
exit $?
