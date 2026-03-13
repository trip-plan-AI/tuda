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

---

## 7. Полный алгоритм подбора маршрута в текущем коде

Ниже — фактический end-to-end поток: от сообщения пользователя до отображения маршрута в AI-чате.

### ФАЗА 0. Intent Router + режим мутации

1. Контроллер [`AiController.plan()`](../../../apps/api/src/ai/ai.controller.ts:426) получает запрос, находит/создаёт сессию и берёт историю.
2. Из истории извлекаются текущие точки маршрута через [`extractCurrentRoutePois()`](../../../apps/api/src/ai/ai.controller.ts:179) и передаются в [`IntentRouterService.route()`](../../../apps/api/src/ai/pipeline/intent-router.service.ts:44).
3. Router отправляет в `gpt-4o-mini`:
   - текущее сообщение,
   - `history.slice(-10)`,
   - `currentRoutePois`.
4. Ожидаемый ответ модели — JSON с `action_type`, `confidence`, `target_poi_id`.
5. После `openai/gpt-4o-mini` применяется детерминированная нормализация:
   - если в сессии нет текущего маршрута, мутационные действия переводятся в `NEW_ROUTE` в [`normalizeActionTypeForSessionState()`](../../../apps/api/src/ai/pipeline/intent-router.service.ts:150);
   - если `confidence < 0.7` и это не `NEW_ROUTE`, ставится `full_rebuild` + `LOW_CONFIDENCE` в [`applyDeterministicPostProcessing()`](../../../apps/api/src/ai/pipeline/intent-router.service.ts:131);
   - для `REMOVE/REPLACE` `target_poi_id` добирается по regex `poi_id:...` или матчем названия.

### ШАГ 1. Оркестратор и Policy Snapshot

1. Парсинг параметров поездки выполняет [`OrchestratorService.parseIntent()`](../../../apps/api/src/ai/pipeline/orchestrator.service.ts:65).
2. Guard на недоописанный первый запрос (`NEED_CITY`) срабатывает до `AI_MODEL` (по умолчанию `openai/gpt-4o-mini`) при необходимости.
3. Политики рассчитывает [`PolicyService.calculatePolicySnapshot()`](../../../apps/api/src/ai/pipeline/policy.service.ts:11):
   - `required_capacity = ceil(days * 5 * 1.2)`,
   - `food_mode`: `none | gastrotour | default` по regex в тексте и истории,
   - `food_interval_hours`: `2.0` для гастро, иначе `4.0`,
   - `user_persona_summary`.

### ШАГ 2. Provider Search и массовый сбор

Реализован в [`ProviderSearchService.fetchAndFilter()`](../../../apps/api/src/ai/pipeline/provider-search.service.ts:35):

1. Сначала KudaGo.
2. Если KudaGo дал `< 15` точек — подключается Overpass.
3. Если после объединения `< 3` — повторный Overpass с `radius_km * 1.3`.
4. Если точек меньше `days * 2` — генерация недостающих POI через `AI_MODEL` (по умолчанию `openai/gpt-4o-mini` через OpenRouter).
   - Источник: `process.env.AI_MODEL`; если переменная не задана, используется `openai/gpt-4o-mini`.
5. Дедупликация по расстоянию 50 м в [`deduplicate()`](../../../apps/api/src/ai/pipeline/provider-search.service.ts:239).
6. Квотированный pre-filter:
   - до 50 non-food,
   - до 50 food,
   - итоговый пул = `topNonFood + topFood`.

### ШАГ 3. Vector Prefilter через Redis/RediSearch

Реализован в [`VectorPrefilterService.runShadowPrefilter()`](../../../apps/api/src/ai/pipeline/vector-prefilter.service.ts:22):

1. Проверка доступности Redis; при недоступности — fallback-мета.
2. `FT.INFO`/`FT.CREATE` индекса (`idx:ai:poi` по умолчанию) в [`ensureVectorIndex()`](../../../apps/api/src/ai/pipeline/vector-prefilter.service.ts:83).
3. Для POI без embedding:
   - `embeddings.create(model=text-embedding-3-small)`,
   - `HSET` в `ai:poi:vec:{id}`,
   - `EXPIRE` 30 дней.
4. Эмбеддинг persona и `FT.SEARCH ... KNN topK`.
5. В текущем коде это **shadow-этап**: он заполняет диагностику, но не режет пул напрямую.

### ШАГ 4. Logical Selector

Реализован в [`LogicalIdSelectorService.selectIds()`](../../../apps/api/src/ai/pipeline/logical-id-selector.service.ts:34):

1. `gpt-4o-mini` получает компактный список `id/name/category` + `required_capacity` + `food_policy`.
2. Должен вернуть **ровно** `target` ID.
3. При невалидном ответе — fallback на первые `target` ID в [`buildFallback()`](../../../apps/api/src/ai/pipeline/logical-id-selector.service.ts:137).
4. Этот шаг уже влияет на downstream: semantic получает `logicalSelectedPool`.

### ШАГ 5. Semantic Filter

Реализован в [`SemanticFilterService.select()`](../../../apps/api/src/ai/pipeline/semantic-filter.service.ts:17):

1. Основной провайдер — YandexGPT (`yandexgpt-lite`), timeout 15s.
2. Парсинг `selected[]`, маппинг ID обратно к исходным POI.
3. Жёсткая проверка минимума: `minRequired = min(days * 2, pois.length)`.
4. Выход: `selected.slice(0, max(minRequired, 15))`.
5. Fallback-цепочка:
   - Yandex ошибка -> OpenRouter,
   - OpenRouter ошибка -> пропуск semantic и Top-8 по рейтингу с автоописаниями.

### ШАГ 6. Yandex Batch Refinement

Always-on этап в [`YandexBatchRefinementService.refineSelectedInBatches()`](../../../apps/api/src/ai/pipeline/yandex-batch-refinement.service.ts:76):

1. Разбивка на батчи (`YANDEX_BATCH_SIZE`, default 24).
2. Для каждого батча — генерация/улучшение описаний через YandexGPT.
3. При сбое батча сохраняются исходные точки батча, а причина уходит в `fallback_reasons`.
4. В `meta` всегда формируется диагностика `yandex_batch_refinement`.

### ШАГ 7. Scheduler + targeted mutations

Логика в [`AiController.plan()`](../../../apps/api/src/ai/ai.controller.ts:582) и [`SchedulerService.buildPlan()`](../../../apps/api/src/ai/pipeline/scheduler.service.ts:62):

1. Если `route_mode != targeted_mutation` -> полный rebuild.
2. Если `targeted_mutation`, но текущего плана нет -> fallback `NO_CURRENT_ROUTE_PLAN`.
3. `REMOVE_POI`:
   - проверка target,
   - удаление точки,
   - пересборка дня через [`rebuildSingleDayPlan()`](../../../apps/api/src/ai/pipeline/scheduler.service.ts:29).
4. `ADD_DAYS`:
   - заморозка `usedPoiIds`,
   - добор кандидатов только из неиспользованных,
   - достройка только новых дней.
5. `REPLACE_POI`:
   - выбор ближайших альтернатив той же категории,
   - фильтр по `working_hours` и времени слота,
   - выбор финальной альтернативы через [`chooseReplacementAlternative()`](../../../apps/api/src/ai/pipeline/yandex-batch-refinement.service.ts:16),
   - иначе fallback `NO_ALTERNATIVES`/`TARGET_NOT_FOUND`/`REPLACEMENT_SELECTION_FAILED`.
6. Планировщик считает транзит/тайминги детерминированно, включая Haversine.

### ШАГ 8. Контракт ответа и отображение в чате

1. Контроллер сохраняет сообщение пользователя и JSON маршрута ассистента в сессию.
2. Возвращает `route_plan` + rich `meta`:
   - `intent_router`, `policy_snapshot`, `logical_selector`, `vector_prefilter_shadow`,
   - `mass_collection_shadow`, `deterministic_planner_shadow`,
   - `planner_version`, `pipeline_status`, `yandex_batch_refinement`,
   - `fallbacks_triggered`, mutation-мета.
3. UI AI-чата отображает карточку маршрута по `route_plan`, а причины деградации можно видеть по `meta.fallbacks_triggered`.

### ШАГ 9. SSE поток

В [`planStream()`](../../../apps/api/src/ai/ai.controller.ts:898) реализован always-on SSE endpoint:

1. Сразу отправляет `plan_started`.
2. Отправляет heartbeat каждые 3 секунды.
3. Используется для стабильности long-running сценариев и устойчивости к таймаутам клиента/прокси.

---

## 8. Краткая версия алгоритма

1. **Intent Router (`openai/gpt-4o-mini`)**: классифицирует запрос в `NEW_ROUTE/REMOVE/REPLACE/ADD_DAYS/APPLY_GLOBAL_FILTER`; при пустой сессии мутации нормализуются в `NEW_ROUTE`.
2. **Orchestrator (`AI_MODEL`, по умолчанию `openai/gpt-4o-mini`)**: извлекает город/дни/категории/бюджет и валидирует `NEED_CITY`.
3. **Policy Snapshot (код, без LLM)**: считает `required_capacity`, `food_policy`, `user_persona_summary`.
4. **Provider Search (KudaGo + Overpass + LLM fill)**: KudaGo -> Overpass при нехватке -> добор через `AI_MODEL` (`process.env.AI_MODEL`, fallback: `openai/gpt-4o-mini`); затем дедуп и квота до 50 non-food + до 50 food.
5. **Vector Prefilter (Redis/RediSearch + `text-embedding-3-small`)**: строит/переиспользует эмбеддинги POI и persona, делает KNN (`FT.SEARCH`), пишет shadow-диагностику.
6. **Logical Selector (`openai/gpt-4o-mini`)**: выбирает целевые ID под `required_capacity` и `food_policy`; при ошибке fallback на первые N.
7. **Semantic Filter (`yandexgpt-lite`)**: отбирает релевантные точки и описания; fallback -> OpenRouter `AI_MODEL`; при двойном сбое — Top-8 по рейтингу.
8. **Yandex Batch Refinement (`yandexgpt-lite`)**: батчами улучшает описания, фиксирует диагностику и fallback по батчам.
9. **Scheduler + Targeted Mutations (код NestJS)**: full rebuild или `REMOVE/ADD_DAYS/REPLACE` с детерминированными проверками (`TARGET_NOT_FOUND`, `NO_ALTERNATIVES` и др.).
10. **Response + Chat + SSE**: сохраняет `route_plan` в сессию, возвращает rich `meta`, UI рендерит маршрут; SSE (`plan_started` + heartbeat) поддерживает long-running сценарии.
