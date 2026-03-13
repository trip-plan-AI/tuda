# Dual AI Engine — Handoff пакет для QA/Reviewer

## 1. Acceptance Criteria

1. `POST /api/ai/plan` возвращает HTTP 200 и содержит оба корневых поля: `route_plan` и `meta`.
2. В `meta` всегда присутствует `intent_router` c валидными полями: `action_type`, `confidence`, `route_mode`.
3. Для точечных команд (`REMOVE_POI`, `REPLACE_POI`, `ADD_DAYS`) при достаточной уверенности роутера устанавливается `route_mode=targeted_mutation`; при неуспехе точечной операции возвращается `mutation_fallback_reason` и выполняется корректный fallback.
4. В `meta` присутствуют диагностические блоки active pipeline: `policy_snapshot`, `logical_id_shadow`, `logical_selector`, `vector_prefilter_shadow`, `mass_collection_shadow`, `deterministic_planner_shadow`.
5. При недоступности RediSearch запрос не падает: `route_plan` возвращается, а `meta.vector_prefilter_shadow.status=fallback` с причиной `REDISEARCH_UNAVAILABLE` или `VECTOR_INDEX_MISSING`.
6. Для `REPLACE_POI` при наличии альтернатив целевая точка заменяется в соответствующем дне; если альтернатив нет, фиксируется `mutation_fallback_reason=NO_ALTERNATIVES` и ответ остаётся валидным.
7. Для `ADD_DAYS` итоговый `route_plan.days.length` увеличивается относительно текущего маршрута или возвращается прозрачный fallback в `meta` без 5xx.

---

## 2. Curl test-cases

> Универсальные переменные:

```bash
export BASE_URL=http://localhost:3001
export TOKEN=your_jwt_token
```

### TC-01 NEW_ROUTE

**Предусловия**
- Валидный JWT в `TOKEN`.
- Пользователь имеет доступ к API.

**Команда**

```bash
curl -sS -X POST "$BASE_URL/api/ai/plan" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "user_query": "Построй новый маршрут на 2 дня по Казани с музеями и прогулками",
    "trip_id": "11111111-1111-4111-8111-111111111111"
  }'
```

**Ожидаемые поля в ответе**
- `route_plan.city`
- `route_plan.days`
- `meta.intent_router.action_type=NEW_ROUTE`
- `meta.intent_router.route_mode=full_rebuild`
- `meta.policy_snapshot`
- `meta.vector_prefilter_shadow`

**Pass/Fail**
- **PASS:** HTTP 200, есть `route_plan` и `meta`, `action_type=NEW_ROUTE`.
- **FAIL:** нет `route_plan` или `meta`, либо `action_type` не соответствует сценарию.

---

### TC-02 REMOVE_POI

**Предусловия**
- Существует текущий маршрут в истории по `trip_id`.
- Из текущего маршрута известен `poi_id` для удаления, например `poi-123`.

**Команда**

```bash
curl -sS -X POST "$BASE_URL/api/ai/plan" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "user_query": "Удали точку poi_id: poi-123 из маршрута",
    "trip_id": "22222222-2222-4222-8222-222222222222"
  }'
```

**Ожидаемые поля в ответе**
- `route_plan.days[].points[]`
- `meta.intent_router.action_type=REMOVE_POI`
- `meta.intent_router.route_mode=targeted_mutation` или `full_rebuild` при fallback
- `meta.mutation_applied`
- `meta.mutation_type=REMOVE_POI`
- `meta.mutation_fallback_reason` при fallback

**Pass/Fail**
- **PASS:** HTTP 200 и корректный mutation-meta; при успешной мутации `mutation_applied=true`, либо прозрачный fallback с причиной.
- **FAIL:** 5xx, отсутствие mutation-meta, невалидный ответ без `route_plan`.

---

### TC-03 REPLACE_POI

**Предусловия**
- Существует текущий маршрут в истории по `trip_id`.
- Известен `poi_id` точки для замены, например `poi-456`.

**Команда**

```bash
curl -sS -X POST "$BASE_URL/api/ai/plan" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "user_query": "Замени точку poi_id: poi-456 на похожее место рядом",
    "trip_id": "33333333-3333-4333-8333-333333333333"
  }'
```

**Ожидаемые поля в ответе**
- `route_plan.days[].points[]`
- `meta.intent_router.action_type=REPLACE_POI`
- `meta.mutation_type=REPLACE_POI`
- `meta.mutation_applied` или `meta.mutation_fallback_reason`
- `meta.logical_selector`
- `meta.vector_prefilter_shadow`

**Pass/Fail**
- **PASS:** HTTP 200 и либо успешная замена, либо корректный fallback (`NO_ALTERNATIVES`/`TARGET_NOT_FOUND`) без падения запроса.
- **FAIL:** 5xx, отсутствует mutation-диагностика, отсутствует `route_plan`.

---

### TC-04 ADD_DAYS

**Предусловия**
- Уже есть маршрут по `trip_id` минимум на 1 день.
- Команда пользователя явно просит добавить дни.

**Команда**

```bash
curl -sS -X POST "$BASE_URL/api/ai/plan" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "user_query": "Добавь 2 дня к текущему маршруту",
    "trip_id": "44444444-4444-4444-8444-444444444444"
  }'
```

**Ожидаемые поля в ответе**
- `route_plan.days`
- `meta.intent_router.action_type=ADD_DAYS`
- `meta.mutation_type=ADD_DAYS`
- `meta.mutation_applied` или `meta.mutation_fallback_reason`
- `meta.policy_snapshot`
- `meta.mass_collection_shadow`

**Pass/Fail**
- **PASS:** HTTP 200, валидный `route_plan`, mutation-meta заполнен; длина `days` увеличена или возвращён прозрачный fallback.
- **FAIL:** 5xx или отсутствие обязательных полей `meta`/`route_plan`.

---

## 3. Rollout/checklist для окружения

### Redis Stack / RediSearch
- `REDIS_URL` задан и доступен из API.
- Redis Stack запущен с модулем RediSearch.
- Векторный индекс существует; KNN prefilter не падает.
- Проверен fallback: при недоступности Redis/индекса в `meta.vector_prefilter_shadow` выставляется `status=fallback`.

### OpenAI / Yandex env
- Заданы `OPENAI_API_KEY`, `YANDEX_GPT_API_KEY`, `YANDEX_FOLDER_ID`.
- Для batch refinement заданы `YANDEX_BATCH_SIZE`, `YANDEX_BATCH_TIMEOUT_MS`.
- Для расширенного контракта при QA включён `FF_PLANNER_V2_CONTRACT_FIELDS=true`.
