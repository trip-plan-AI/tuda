# Backend-Only External API Policy (для AI-агентов)

## Цель

Этот документ фиксирует обязательные архитектурные правила, чтобы изменения AI-агентов не откатывали принятый подход «все внешние API только через backend».

## Обязательное правило №1

**Внешние API вызываются только на backend.**

Нельзя делать прямые вызовы внешних сервисов из frontend-кода (`apps/web/src/**`), включая:
- geocode/suggest сервисы;
- LLM/AI provider API;
- любые внешние HTTP API, влияющие на бизнес-логику.

## Обязательное правило №2

**Единый публичный API-контур — только Nest backend под `/api/*`.**

Источник: `apps/api/src/main.ts` (глобальный префикс `api`).

## Что разрешено на frontend

Разрешены только:
1. Вызовы в backend API через `env.apiUrl` / общий HTTP-клиент.
2. Технические запросы картового JS SDK (рендер карты), не относящиеся к бизнес-эндпоинтам geocode/suggest.

## Что запрещено на frontend

Запрещено:
- возвращать/добавлять route handlers в `apps/web/src/app/api/**` для бизнес-endpoints geocode/suggest;
- добавлять `fetch('https://...')` к внешним geocode/suggest/LLM API в `apps/web/src/**`;
- использовать `/api/suggest` как клиентский endpoint.

## Актуальные endpoint'ы

- Геопоиск/подсказки: `GET /api/geosearch/suggest?q=...`
- Реализация: `apps/api/src/geosearch/geosearch.controller.ts`
- Бизнес-логика и fallback: `apps/api/src/geosearch/geosearch.service.ts`

## Инварианты для code review (обязательно)

Перед merge AI-агент обязан проверить:
1. В `apps/web/src/**` нет строк `fetch('/api/suggest`.
2. В `apps/web/src/**` нет прямых внешних `fetch('https://...')` для geocode/suggest/LLM.
3. В `apps/web/src/app/api/` нет business route для suggest/geocode.
4. Все клиентские suggest-вызовы идут на `${env.apiUrl}/geosearch/suggest`.

## Быстрый чек-лист для AI-агента

- [ ] Я не добавил/не вернул `apps/web/src/app/api/suggest/route.ts`.
- [ ] Я не добавил прямые внешние API-запросы во frontend.
- [ ] Я использую backend endpoint `/api/geosearch/suggest`.
- [ ] Я не сломал существующие потоки `/` и `/planner`.

## Если требуется новый внешний провайдер

Порядок действий только такой:
1. Добавить интеграцию в backend-модуль (`apps/api/src/**`).
2. Нормализовать контракт ответа на backend.
3. Вызывать новый backend endpoint с frontend.
4. Обновить документацию: `docs/tasks/dev-guide.md`, `docs/prd/project_prd.md`, этот файл.

## Статус

Принято и обязательно для всех дальнейших изменений, включая изменения через AI-агентов.
