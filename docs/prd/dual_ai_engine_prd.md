# PRD: Dual-AI Engine — Active Pipeline
# Travel Planner — Intelligent Planning Module
# Version: 3.0 | Status: Active Production Pipeline | Date: 2026-03-13
# Owner: Engineering Team

---

## 1. Executive Summary

Модуль Dual-AI Engine переведён в **active pipeline** режим для `POST /api/ai/plan`.

Ключевое состояние:
- always-on `intent_router` для определения типа действия пользователя;
- always-on `policy_snapshot` для расчёта capacity и food-policy;
- поддержка **targeted mutations** без полного перестроения маршрута;
- always-on `logical_id_shadow` + `logical_selector` для детерминированного отбора кандидатов;
- always-on `vector_prefilter_shadow` с KNN prefilter и graceful fallback;
- расширенная `meta`-диагностика мутаций и статуса пайплайна.

---

## 2. Product Goals

### 2.1 Бизнес-цели
- Стабильный маршрутный ответ с деградацией без падения запроса.
- Повышение качества редактирования маршрута через точечные мутации.
- Прозрачность качества через диагностический контракт `meta`.

### 2.2 Пользовательская ценность
- Пользователь может как создавать новый маршрут, так и редактировать существующий.
- Простые правки в чате приводят к точечной модификации, а не к полному пересбору.
- Ответ API возвращает и готовый `route_plan`, и причины fallback при сложных кейсах.

---

## 3. Active Pipeline Architecture

### 3.1 Сквозной поток

1. Приём запроса, загрузка истории и текущего маршрута.
2. `intent_router` определяет `action_type`, `confidence`, `route_mode`.
3. `orchestrator` строит `ParsedIntent`.
4. `policy_snapshot` вычисляет ограничения и persona.
5. Provider Search (KudaGo + Overpass), нормализация, дедуп, prefilter.
6. `logical_id_shadow` формирует диагностику дублей.
7. `vector_prefilter_shadow` делает KNN prefilter через Redis/RediSearch или fallback.
8. `logical_selector` выбирает целевой пул кандидатов.
9. Semantic Filter и always-on batch refinement (с fallback при ошибке refinement).
10. Scheduler строит план:
    - `targeted_mutation` при точечных командах;
    - `full_rebuild` при NEW_ROUTE или fallback-условиях.
11. Возврат `route_plan` + `meta` с диагностикой.

### 3.2 Intent Router: always-on

Поддерживаемые `action_type`:
- `NEW_ROUTE`
- `REMOVE_POI`
- `REPLACE_POI`
- `ADD_DAYS`
- `APPLY_GLOBAL_FILTER`

Правила:
- при `NEW_ROUTE` -> `route_mode=full_rebuild`;
- при confidence `< 0.7` для мутаций -> fallback в `full_rebuild` с `fallback_reason=LOW_CONFIDENCE`;
- при валидной уверенной точечной команде -> `route_mode=targeted_mutation`.
- если в сессии нет текущего маршрута (`currentRoutePois` пуст), мутационные action_type нормализуются в `NEW_ROUTE`.

### 3.3 Policy Snapshot: always-on

`policy_snapshot` всегда возвращается в `meta` и включает:
- `required_capacity`
- `food_policy` (`food_mode`, `food_interval_hours`)
- `user_persona_summary`
- `policy_version`

### 3.4 Logical ID + Selector

- `logical_id_shadow` фиксирует статистику дублей кандидатов.
- `logical_selector` возвращает целевой размер пула и факт fallback селектора.

### 3.5 Vector KNN Prefilter

`vector_prefilter_shadow` всегда публикуется в `meta`:
- `status: ok | fallback`
- `reason` при fallback: `REDISEARCH_UNAVAILABLE | VECTOR_INDEX_MISSING`
- `top_k`, `selected_count`, `total_candidates`

Поведение:
- при недоступности Redis/RediSearch запрос не прерывается;
- используется fallback-путь с сохранением стабильного ответа.

---

## 4. Functional Requirements

### FR-01: Request + Context
- Вход: `user_query`, `trip_id?`
- История: последние 10 сообщений
- Санитизация пользовательского ввода перед LLM

### FR-02: Intent Router + Parsed Intent
- Router всегда выполняется до планирования.
- Orchestrator возвращает валидный `ParsedIntent`.

### FR-03: Provider Search + Candidate Pipeline
- KudaGo и Overpass объединяются в общий пул.
- Координаты валидируются строго.
- Выполняется дедупликация и prefilter.
- Публикуются `mass_collection_shadow`, `logical_id_shadow`, `vector_prefilter_shadow`, `logical_selector`.

### FR-04: Semantic Filter
- Семантический отбор релевантных POI и описаний.
- При неудаче semantic — graceful fallback без падения всего запроса.

### FR-05: Scheduler + Targeted Mutations
- `REMOVE_POI`: удаление целевой точки и пересборка затронутого дня.
- `REPLACE_POI`: подбор и замена целевой точки по категории/близости/ограничениям.
- `ADD_DAYS`: добавление дней из неиспользованного пула.
- При невозможности локальной мутации выполняется `full_rebuild` с `mutation_fallback_reason`.

### FR-06: Mutation Diagnostics in Meta

В `meta` фиксируются:
- `intent_router`
- `mutation_applied`
- `mutation_type`
- `mutation_fallback_reason` (если применимо)
- `policy_snapshot`
- `logical_id_shadow`
- `logical_selector`
- `vector_prefilter_shadow`
- `deterministic_planner_shadow`
- `mass_collection_shadow`

Always-on поля контрактной диагностики:
- `planner_version`
- `pipeline_status`
- `yandex_batch_refinement`

---

## 5. Data Contract Highlights

### 5.1 Response

`AiPlanResponse` содержит:
- `session_id`
- `route_plan`
- `meta`

### 5.2 Обязательные диагностические поля meta

- `parsed_intent`
- `steps_duration_ms`
- `poi_counts`
- `fallbacks_triggered`
- `intent_router`
- `policy_snapshot`
- `logical_id_shadow`
- `logical_selector`
- `vector_prefilter_shadow`
- `deterministic_planner_shadow`
- `mass_collection_shadow`
- `mutation_applied`

---

## 6. Failure Handling

### 6.1 Общие принципы
- Ошибка отдельного подэтапа не должна ронять весь запрос, если возможна деградация.
- Fallback-причины обязательно попадают в `meta.fallbacks_triggered`.

### 6.2 Критичные сценарии
- LOW_CONFIDENCE роутера -> `full_rebuild`.
- TARGET_NOT_FOUND при REMOVE/REPLACE -> `full_rebuild`.
- NO_ALTERNATIVES при REPLACE -> `full_rebuild`.
- Недоступный Redis/RediSearch -> `vector_prefilter_shadow.status=fallback`.
- Ошибка batch refinement -> возврат исходного пула + диагностика fallback.

---

## 7. Environment Rollout Checklist

### 7.1 Redis Stack / RediSearch
- Доступен `REDIS_URL`.
- Поднят Redis Stack с модулем RediSearch.
- Создан и доступен vector index для KNN prefilter.
- Проверено, что при отсутствии индекса API возвращает корректный fallback в `vector_prefilter_shadow`.

### 7.2 OpenAI / Yandex
- Настроены `OPENAI_API_KEY`, `YANDEX_GPT_API_KEY`, `YANDEX_FOLDER_ID`.
- Проверен доступ API без rate-limit блокировки.
- Для batch refinement корректно заданы `YANDEX_BATCH_SIZE`, `YANDEX_BATCH_TIMEOUT_MS`.

### 7.3 Planner Contract
- Расширенный контракт работает в always-on режиме (без feature-flag gate).
- Проверено наличие `planner_version`, `pipeline_status` и `yandex_batch_refinement` в `meta`.

---

## 8. KPI и контроль качества

- Успешные ответы `POST /api/ai/plan` без 5xx в целевом сценарии.
- Низкая доля fallback по `vector_prefilter_shadow` после стабилизации Redis.
- Низкая доля `mutation_fallback_reason` в повторяемых edit-сценариях.
- Отсутствие потери `route_plan` при деградации отдельных стадий.
