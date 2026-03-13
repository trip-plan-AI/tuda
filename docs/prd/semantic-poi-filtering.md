# PRD: Semantic POI Filtering — Active Pipeline

## 0. Фактическое состояние 2026-03-13

Документ отражает текущее состояние после перехода на **active pipeline** без legacy/shadow-режима в продуктовой логике.

Что является always-on:
- `intent_router` c `route_mode` и low-confidence guard;
- `policy_snapshot` c capacity и food-policy;
- `logical_id_shadow` и `logical_selector` для детерминированного отбора;
- `vector_prefilter_shadow` с KNN prefilter через Redis/RediSearch и fallback;
- `mutation`-диагностика в `meta` для targeted mutations.

---

## 1. Цель semantic filtering

Semantic Filter остаётся этапом интеллектуального отбора POI после широкого provider-search.

Цель этапа:
- выбрать релевантные точки под пользовательский контекст;
- сохранить разнообразие и пригодность к расписанию;
- вернуть стабильный результат даже при деградации смежных стадий.

---

## 2. Pipeline-контекст этапа

1. `intent_router` определяет тип запроса: `NEW_ROUTE`, `REMOVE_POI`, `REPLACE_POI`, `ADD_DAYS`, `APPLY_GLOBAL_FILTER`.
2. `policy_snapshot` рассчитывает ограничения.
3. Provider Search формирует нормализованный пул.
4. `logical_id_shadow` диагностирует дубли по logical id.
5. `vector_prefilter_shadow` выполняет KNN prefilter и отдаёт shortlist.
6. `logical_selector` применяет целевой размер пула.
7. Semantic Filter выбирает финальные кандидаты для планировщика.

---

## 3. Требования к semantic filtering

### 3.1 Вход
- Нормализованный пул POI после provider, logical-id и vector prefilter.
- Контекст пользователя из `ParsedIntent`.
- Политика из `policy_snapshot` для food/tempo ограничений.

### 3.2 Выход
- Выбранные POI с описаниями для scheduler.
- Стабильное количество точек для заполнения маршрута по дням.
- Диагностическая прозрачность через `meta`.

### 3.3 Поведение при targeted mutations
- Для `REMOVE_POI` и `REPLACE_POI` semantic-этап не должен ломать локальность изменения.
- Для `ADD_DAYS` semantic-этап должен поддерживать донабор из неиспользованного пула.
- Для `NEW_ROUTE` допустим полный перерасчёт и новый отбор.

---

## 4. Meta-диагностика и контракт

Ожидаемые поля в `meta` для приёмки качества:
- `intent_router`
- `policy_snapshot`
- `logical_id_shadow`
- `logical_selector`
- `vector_prefilter_shadow`
- `mass_collection_shadow`
- `deterministic_planner_shadow`
- `mutation_applied`, `mutation_type`, `mutation_fallback_reason`

Always-on дополнительные поля контракта:
- `planner_version`
- `pipeline_status`
- `yandex_batch_refinement`

---

## 5. Правила деградации

- Low-confidence роутинг для мутаций приводит к `full_rebuild` с `fallback_reason=LOW_CONFIDENCE`.
- Ошибка Redis/RediSearch не прерывает запрос, фиксируется в `vector_prefilter_shadow`.
- Отсутствие подходящей замены для `REPLACE_POI` приводит к `mutation_fallback_reason=NO_ALTERNATIVES`.
- Отсутствие target для `REMOVE_POI` или `REPLACE_POI` приводит к `mutation_fallback_reason=TARGET_NOT_FOUND`.

---

## 6. Rollout/checklist окружения

### 6.1 Redis Stack / RediSearch
- Проверен `REDIS_URL`.
- RediSearch модуль доступен в runtime.
- Векторный индекс существует и отвечает на запросы KNN.
- При отключении индекса наблюдается корректный fallback в `vector_prefilter_shadow.reason`.

### 6.2 OpenAI / Yandex
- Заданы `OPENAI_API_KEY`, `YANDEX_GPT_API_KEY`, `YANDEX_FOLDER_ID`.
- Проверены лимиты и доступность API.
- Для batch refinement настроены `YANDEX_BATCH_SIZE`, `YANDEX_BATCH_TIMEOUT_MS`.

### 6.3 Контракт ответа
- В QA окружении подтверждено присутствие `meta` и `route_plan`.
- Расширенная диагностика контрактных полей работает в always-on режиме (без feature-flag gate).
