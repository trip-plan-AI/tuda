#!/usr/bin/env bash
set -Eeuo pipefail

LOG_DIR="${LOG_DIR:-./artifacts/predeploy}"
LOG_FILE="$LOG_DIR/guard.log"
mkdir -p "$LOG_DIR"

# Пишем все логи сразу в файл и в консоль
exec > >(tee -a "$LOG_FILE") 2>&1

echo "[guard] start: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "[guard] repo: $(pwd)"

echo "::group::[guard] Git context"
git --version
git rev-parse --short HEAD
git status --short || true
echo "::endgroup::"

fail() {
  local msg="$1"
  echo "::error::$msg"
  echo "[guard][error] $msg"
  exit 1
}

require_clean_architecture() {
  echo "::group::[guard] Backend-only architecture checks"

  if git grep -n "/api/suggest" -- apps/web/src; then
    fail "Найден запрещённый /api/suggest во frontend (должен быть только /api/geosearch/suggest)"
  else
    echo "[guard] OK: /api/suggest не найден во frontend"
  fi

  if git grep -n -E "https://suggestions\.dadata\.ru|https://photon\.komoot\.io|https://nominatim\.openstreetmap\.org|https://suggest-maps\.yandex\.ru" -- apps/web/src; then
    fail "Найдены прямые внешние geocode/suggest API во frontend, это нарушение backend-only"
  else
    echo "[guard] OK: прямых внешних geocode/suggest API во frontend нет"
  fi

  if [ -f "apps/web/src/app/api/suggest/route.ts" ]; then
    fail "Найден запрещённый route apps/web/src/app/api/suggest/route.ts"
  else
    echo "[guard] OK: legacy route apps/web/src/app/api/suggest/route.ts отсутствует"
  fi

  if git grep -n "env\.apiUrl}/geosearch/suggest" -- apps/web/src; then
    echo "[guard] OK: найдены корректные вызовы backend endpoint /geosearch/suggest"
  else
    fail "Не найдены вызовы env.apiUrl}/geosearch/suggest во frontend"
  fi

  echo "::endgroup::"
}

report_deleted_files() {
  echo "::group::[guard] Deletion report (push range)"

  local base_sha="${BASE_SHA:-}"
  local head_sha="${HEAD_SHA:-}"

  if [ -z "$base_sha" ] || [ -z "$head_sha" ] || [ "$base_sha" = "0000000000000000000000000000000000000000" ]; then
    echo "[guard][warn] BASE_SHA/HEAD_SHA не заданы или BASE_SHA пустой, отчёт удалений пропущен"
    echo "::endgroup::"
    return 0
  fi

  echo "[guard] range: $base_sha..$head_sha"
  local deletions
  deletions="$(git diff --name-status "$base_sha" "$head_sha" | awk '$1=="D" {print $2}')"

  if [ -n "$deletions" ]; then
    echo "[guard][warn] В диапазоне push есть удалённые файлы:"
    echo "$deletions"
    echo "[guard][warn] Проверьте, что удаления осознанные и покрыты ревью"
  else
    echo "[guard] OK: удалённых файлов в диапазоне push нет"
  fi

  echo "::endgroup::"
}

run_builds() {
  echo "::group::[guard] Build checks"

  echo "[guard] build api"
  pnpm --dir apps/api build

  echo "[guard] build web"
  pnpm --dir apps/web build

  echo "::endgroup::"
}

require_clean_architecture
report_deleted_files
run_builds

echo "[guard] completed successfully"
