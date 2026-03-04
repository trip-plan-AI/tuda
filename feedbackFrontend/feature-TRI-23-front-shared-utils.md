# TRI-23 — Shared утилиты

## Описание задачи
Создание shared-утилит: HTTP-клиент, загрузчик Яндекс.Карт, расчёт расстояния haversine, форматирование бюджета, конфиг env.

## Файлы создать
- `apps/web/src/shared/api/http.ts`
- `apps/web/src/shared/lib/yandex-maps.ts`
- `apps/web/src/shared/lib/haversine.ts`
- `apps/web/src/shared/lib/format-budget.ts`
- `apps/web/src/shared/config/env.ts`

## Чек-лист
- [x] `shared/api/http.ts` — fetch-обёртка с авторизацией (Bearer token), 401 редирект
- [x] `shared/lib/yandex-maps.ts` — lazy загрузка Yandex Maps SDK через `<script>`
- [x] `shared/lib/haversine.ts` — расчёт расстояния между двумя координатами (км)
- [x] `shared/lib/format-budget.ts` — форматирование в рубли через Intl.NumberFormat
- [x] `shared/config/env.ts` — типизированный доступ к env-переменным
- [x] Проверить: `pnpm check-types` — ✅ без ошибок

## Статус: DONE
