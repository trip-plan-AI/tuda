# Инструкции по применению изменений для PostGIS и миграций БД

## Что было изменено

### 1. Обновлен образ PostgreSQL с PostGIS

**Файл:** `docker-compose.prod.yml`

Изменено:

```yaml
# Было:
db:
  image: postgres:17-alpine

# Стало:
db:
  image: postgis/postgis:17-3.5-alpine
```

**Зачем:** Образ `postgis/postgis` включает расширение PostGIS "из коробки", что позволяет использовать гео-типы данных (`geography(Point, 4326)`) для хранения координат POI.

### 2. Добавлен надежный скрипт миграции БД

**Файл:** `scripts/ci/migrate-db.sh`

Скрипт реализует стратегию:

1. Создание таблицы `__drizzle_migrations` (если отсутствует)
2. Применение миграций через `drizzle-kit migrate`
3. Fallback на `drizzle-kit push --force` при ошибке

### 3. Обновлен GitHub Actions workflow

**Файл:** `.github/workflows/deploy-prod.yml`

Изменения:

- Убрана сложная логика миграции из workflow
- Добавлен вызов скрипта `migrate-db.sh`
- Обновлена проверка схемы (добавлены таблицы `ai_sessions`, `ai_cities`, `ai_pois`, `ai_clusters`)
- Добавлена проверка типа `geography` для PostGIS

---

## Применение изменений на продакшене

### Шаг 1: Закоммитьте и запушьте изменения

```bash
cd c:\Users\sveta\Desktop\elbrus-part-time\phase-3\travel-planner
git add .
git commit -m "feat: add PostGIS support and reliable DB migrations"
git push origin main
```

GitHub Actions автоматически применит миграции при деплое.

---

## ⚠️ Важно: Обновление БД происходит автоматически

**Вам НЕ нужно вручную обновлять БД на сервере!**

При деплое:

1. GitHub Actions пересоберет все сервисы (включая БД)
2. Docker автоматически скачает новый образ `postgis/postgis:17-3.5-alpine`
3. Существующий volume `postgres_data` сохранит все данные
4. Скрипт `migrate-db.sh` применит миграции
5. PostGIS станет доступен автоматически

**Единственное, что нужно сделать — запушить изменения.**

---

## Как это работает теперь

### При каждом деплое:

1. **Сборка образов** → API, Web, Nginx
2. **Backup БД** → Сохраняется в `/opt/apps/travel-planner/backups/`
3. **Миграции БД** → Скрипт `migrate-db.sh`:
   - Создает таблицу `__drizzle_migrations` (если нет)
   - Применяет миграции через `drizzle-kit migrate`
   - При ошибке → fallback на `drizzle-kit push --force`
4. **Проверка схемы** → Сверка колонок в БД
5. **Seed данных** → `db:seed` (преdefined туры, популярные направления)
6. **Перезапуск сервисов** → `docker compose up -d --wait`
7. **Smoke тесты** → Проверка API и Web через nginx

### Идемпотентность

Все шаги можно запускать многократно:

- `CREATE TABLE IF NOT EXISTS` — безопасно
- `CREATE EXTENSION IF NOT EXISTS` — безопасно
- Миграции Drizzle отслеживаются в `__drizzle_migrations`

---

## Troubleshooting

### Ошибка: "type 'geography' does not exist"

**Причина:** PostGIS не установлен в БД

**Решение:**

```bash
docker compose -f docker-compose.prod.yml exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE EXTENSION IF NOT EXISTS postgis;"
```

### Ошибка: "\_\_drizzle_migrations table does not exist"

**Причина:** Таблица миграций не создана

**Решение:**

```bash
docker compose -f docker-compose.prod.yml exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<EOF
CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint NOT NULL,
  idx_serial integer NOT NULL,
  when bigint NOT NULL,
  tag text NOT NULL,
  breakpoints boolean NOT NULL DEFAULT true
);
EOF
```

### Ошибка: "column 'updated_at' of relation 'ai_sessions' does not exist"

**Причина:** Миграция не применилась

**Решение:**

```bash
# Проверьте логи миграций
docker compose -f docker-compose.prod.yml logs api | grep -i migrate

# Примените миграции вручную
docker compose -f docker-compose.prod.yml run --rm api pnpm --filter api db:migrate
```

---

## Архитектурные принципы

1. **Миграции идемпотентны** — можно запускать многократно
2. **Fallback автоматический** — `migrate` → `push --force`
3. **Backup перед миграцией** — всегда сохраняется дамп
4. **PostGIS встроен в образ** — не требует скриптов инициализации
5. **Проверка схемы** — верификация после миграции
