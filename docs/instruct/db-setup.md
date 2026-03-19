# Инструкция по настройке базы данных

Выполняй шаги **строго по порядку**.

---

## Шаг 1. Проверь предусловия

Убедись, что запущены:
- PostgreSQL (порт 5432)
- Redis (порт 6379)

Проверь `.env` в корне монорепо — должны быть переменные:
```
DATABASE_URL=postgresql://travel_user:travel_password@localhost:5432/travel_planner
REDIS_URL=redis://localhost:6379
```

---

## Шаг 2. Установи зависимости

```bash
pnpm install
```

---

## Шаг 3. Определи своё состояние

### Случай A — Свежая (пустая) база данных

Запускай с шага 4.

### Случай B — База уже существует, таблицы есть

Проверь, применены ли миграции:

```bash
PGPASSWORD=travel_password psql -U travel_user -h localhost -d travel_planner \
  -c "SELECT hash FROM drizzle.__drizzle_migrations;"
```

Если вывод содержит строку с хешем `a749ddd04a66bfcbafb34ca178a2827acbf11d91b541fea0447cdc7ee7cdc104` — переходи сразу к **шагу 6**.

Если вывод пустой или таблицы `drizzle.__drizzle_migrations` нет — переходи к **шагу 5**.

---

## Шаг 4. Создай базу (только для Случая A)

```bash
createdb -U postgres travel_planner
psql -U postgres -c "CREATE USER travel_user WITH PASSWORD 'travel_password';"
psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE travel_planner TO travel_user;"
```

Затем переходи к шагу 5.

---

## Шаг 5. Примени миграции

```bash
pnpm --filter api db:migrate
```

Ожидаемый вывод: `migrations applied successfully`

### Если `db:migrate` упал с ошибкой "No file ... found"

Это значит у тебя сломанный журнал миграций. Выполни одну команду для регистрации актуального baseline:

```bash
PGPASSWORD=travel_password psql -U travel_user -h localhost -d travel_planner -c "
DELETE FROM drizzle.__drizzle_migrations;
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
VALUES ('a749ddd04a66bfcbafb34ca178a2827acbf11d91b541fea0447cdc7ee7cdc104', 1773877890717);
"
```

Эта команда **не трогает твои данные** — только фиксирует состояние миграций.

После этого снова запусти `db:migrate`:

```bash
pnpm --filter api db:migrate
```

---

## Шаг 6. Засей начальные данные

```bash
pnpm --filter api db:seed
```

Seed сделает:
- Создаст системного пользователя (`system@travel-planner.local`)
- Вставит 4 предустановленных тура (Сочи, Алтай, Карелия, Кавказ) с 6 точками каждый
- Засеет popular destinations (~115k записей)
- Прогреет Redis-кэш маршрутов для всех туров (знак `+` = записано, `.` = уже есть, `x` = OSRM недоступен)

Ожидаемый вывод: `Seed completed!`

---

## Шаг 7. Запусти сервисы

В двух отдельных терминалах:

```bash
# Терминал 1 — API
pnpm --filter api dev

# Терминал 2 — Web
pnpm --filter web dev
```

---

## Проверка

```bash
# Должен вернуть 4 тура с точками
curl http://localhost:3001/api/trips/predefined | python3 -c \
  "import json,sys; data=json.load(sys.stdin); [print(t['title'], len(t.get('points',[])), 'точек') for t in data]"
```

---

## Частые проблемы

| Ошибка | Причина | Решение |
|--------|---------|---------|
| `No file 0000_pale_jack_power.sql found` | Журнал миграций ссылается на удалённый файл | Выполни SQL из шага 5 |
| `relation already exists` | Схема уже есть, но `__drizzle_migrations` пустая | Выполни SQL из шага 5 |
| `Failed to fetch` в браузере | API не запущен или упал | Перезапусти `pnpm --filter api dev` |
| Туры без точек на странице `/tours/:id` | Старая версия API без `with: { points }` | Убедись что API пересобран после `git pull` |
