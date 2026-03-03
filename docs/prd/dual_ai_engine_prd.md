# PRD: Dual-AI Engine (Orchestrator + Semantic Filter)
# Travel Planner — Intelligent Planning Module
# Version: 2.0 | Status: MVP | Date: 2026-03-03
# Owner: Engineering Team

---

## Changelog v2.0

| Изменение | Причина |
|-----------|---------|
| NestJS делает HTTP-запросы в Yandex API самостоятельно | YandexGPT не поддерживает надёжный Tool Calling; LLM не должны самостоятельно ходить в API |
| Переименование: DataProvider → SemanticFilter | Агент больше не занимается поиском, только семантической фильтрацией |
| Добавлен pre-filter на стороне NestJS (30 → 15 POI) | Входной контекст YandexGPT ≤ 4000 токенов; детерминированная логика вместо LLM |
| Pipeline строго последовательный — 4 шага | Упрощает дебаггинг, retry-логику и observability |
| Жёсткие таймауты на каждый этап | MVP: graceful degradation вместо бесконечного ожидания |
| Строгая валидация координат на STEP 2 | Предотвращение невалидных данных до LLM |
| Chat context ограничен 10 сообщениями в БД | Предотвращение переполнения контекста |

---

## 1. Executive Summary

Модуль «Dual-AI Engine» реализует четырёхэтапный конвейер планирования маршрутов.
**NestJS является главным оркестратором** — управляет пайплайном, сам взаимодействует
с внешними API, делегируя LLM строго ограниченные задачи.

**GPT-4o-mini** участвует дважды: парсинг intent пользователя (Orchestrator, STEP 1)
и расстановка точек по тайм-слотам (Scheduler, STEP 4).

**YandexGPT** — семантический фильтр: получает 15 предотобранных POI
(3000–4000 токенов) и выбирает 5–10 наиболее атмосферных с кратким описанием.
**YandexGPT не делает HTTP-запросов.**

**Цель:** пользователь получает готовый маршрут через natural language запрос
менее чем за 30 секунд с graceful degradation на каждом этапе.

---

## 2. Product Goals

### 2.1 Бизнес-цели

- Сократить time-to-plan до < 30 сек
- Обеспечить graceful degradation при недоступности любого внешнего API
- Удержать стоимость запроса < $0.05
- Обеспечить региональную релевантность для СНГ через Yandex Maps

### 2.2 Пользовательская ценность

- Пользователь вводит: «Хочу 2 дня в Казани, бюджет 10 000 руб, с ребёнком»
- Система возвращает маршрут по дням с конкретными точками, адресами,
  координатами, временем прибытия/отбытия и краткими описаниями
- Маршрут добавляется в планировщик и отображается на карте
- Пользователь редактирует вручную или уточняет через чат

---

## 3. Pipeline Architecture

### 3.1 Схема конвейера (4 шага)

```
User
 │
 ▼
[NestJS: AI Controller]   POST /api/ai/plan
 │   JWT guard, throttler, input sanitization
 │   Load last 10 messages from ai_sessions
 │
 ▼ ─────────────────────────────────────── STEP 1 ──
[GPT-4o-mini: Orchestrator]           timeout: 20s
 │   Вход: user_query + trip_context (max 10 сообщений)
 │   Выход: ParsedIntent (JSON) — city, days, budget, categories, radius...
 │   Только парсинг. Никаких HTTP-запросов.
 │
 ▼ ─────────────────────────────────────── STEP 2 ──
[NestJS: Yandex API Fetch]            timeout: 10s per-request
 │   Вход: ParsedIntent
 │   1. HTTP → Yandex Maps Search API (параллельно по категориям)
 │   2. Нормализация → PoiItem[]
 │   3. Валидация координат: lat ∈ [-90, 90], lon ∈ [-180, 180]
 │   4. Дедупликация (< 50 м — дубль, оставить max rating)
 │   5. Pre-filter: сортировка по rating DESC, обрезка до 15 POI
 │   Выход: PoiItem[max 15]
 │
 ▼ ─────────────────────────────────────── STEP 3 ──
[YandexGPT: Semantic Filter]          timeout: 15s
 │   Вход: PoiItem[15] + preferences_text + party_type
 │   Входной контекст: ~3000–4000 токенов (гарантируется STEP 2)
 │   Задача: выбрать 5–10 атмосферных POI + краткое описание (1–2 предложения)
 │   YandexGPT не делает HTTP-запросов. Только семантическая оценка.
 │   Выход: FilteredPoiResponse (id[] + description[])
 │
 ▼ ─────────────────────────────────────── STEP 4 ──
[GPT-4o-mini: Scheduler]             timeout: 20s
 │   Вход: FilteredPoi[] + ParsedIntent
 │   Задача: распределить по дням, рассчитать тайминги, стоимость
 │   Выход: RoutePlan (DayPlan[])
 │
 ▼
[NestJS: AI Controller]
 │   Сохранение в ai_sessions (max 10 сообщений)
 │   HTTP Response: AiPlanResponse
 ▼
User
```

### 3.2 Ответственности компонентов

| Компонент | Ответственность | Запрещено |
|-----------|----------------|-----------|
| **Orchestrator (GPT-4o-mini)** | Парсинг user_query → структурированный JSON | HTTP-запросы, построение маршрута |
| **NestJS: Yandex Fetch** | HTTP в Yandex, нормализация, валидация, pre-filter | Принимать продуктовые решения |
| **Semantic Filter (YandexGPT)** | Выбор 5–10 POI + описания | HTTP-запросы, ранжирование по таймингу |
| **Scheduler (GPT-4o-mini)** | Тайминги, дни, бюджет | Изменять состав POI |

---

## 4. Functional Requirements

### FR-01: Приём запроса и исторический контекст

- Принимает `user_query` (string, max 1000 символов после санитизации)
- Принимает `trip_id` (UUID, опционально — для загрузки истории)
- Из `ai_sessions` загружаются последние **10 сообщений** сессии
- Если сообщений > 10 — старые удаляются **перед записью**, не перед чтением
- Санитизация входа: обрезка до 1000 символов, удаление управляющих символов,
  экранирование `< > " ' \``, удаление prompt-injection паттернов:
  `'ignore previous'`, `'system:'`, `'[INST]'`, `'###'`, `'<|'`

### FR-02: STEP 1 — Парсинг intent (Orchestrator, GPT-4o-mini)

Orchestrator получает `system_prompt` + `user_query` + последние 10 сообщений.
Возвращает строго валидный JSON в формате `ParsedIntent`.

| Поле | Тип | Default | Описание |
|------|-----|---------|---------|
| `city` | string | — | Обязательное; если пусто — HTTP 422 |
| `days` | number | 1 | Количество дней маршрута |
| `budget_total` | number \| null | null | Общий бюджет в рублях |
| `budget_per_day` | number \| null | null | Автовычисляется если null |
| `party_type` | enum | 'solo' | solo / couple / family / group |
| `party_size` | number | 1 | Количество человек |
| `categories` | PoiCategory[] | ['attraction','restaurant'] | Категории POI |
| `excluded_categories` | PoiCategory[] | [] | Исключённые категории |
| `radius_km` | number | 5 | Радиус поиска от центра города |
| `start_time` | string | '10:00' | Начало активного дня (HH:MM) |
| `end_time` | string | '21:00' | Конец активного дня (HH:MM) |
| `preferences_text` | string | '' | Контекст для Semantic Filter |

### FR-03: STEP 2 — Yandex API Fetch (NestJS)

NestJS выполняет HTTP-запросы самостоятельно. LLM не участвует.

1. `Promise.all` — параллельные запросы по каждой категории из `categories[]`,
   timeout 10s на каждый запрос
2. Нормализация каждого объекта в `PoiItem`
3. **Валидация координат** — обязательна; при провале — POI отбрасывается:
   - `lat` ∈ `[-90, 90]` — число, не null/NaN/string
   - `lon` ∈ `[-180, 180]` — число, не null/NaN/string
4. **Дедупликация:** `Haversine(a, b) < 0.05 км` → дубль; остаётся `max(rating)`
5. **Pre-filter до 15 POI:**
   - Убрать POI из `excluded_categories`
   - Сортировать по `rating DESC`
   - Обрезать до 15 объектов
6. Если осталось < 3 POI — повторить с `radius_km * 1.3` (max 1 retry)

**Контроль токенов:** 15 объектов × ~200 токенов = ~3000 токенов.
Это гарантирует безопасный вход для YandexGPT.

### FR-04: STEP 3 — Semantic Filter (YandexGPT)

YandexGPT получает PoiItem[15] + `preferences_text` + `party_type`.
Не делает внешних запросов.

Задача:
1. Оценить каждый POI на соответствие контексту
2. Выбрать 5–10 наиболее атмосферных и уместных объектов
3. Для каждого написать описание (1–2 предложения, на русском)
4. Вернуть `FilteredPoiResponse` — только `id` + `description`

NestJS после получения ответа обогащает объекты данными из оригинального `PoiItem[]`.
YandexGPT **не перезаписывает** координаты, рейтинг и другие поля.

### FR-05: STEP 4 — Scheduler (GPT-4o-mini)

Вход: `FilteredPoi[]` + `ParsedIntent`.

1. Распределить POI по дням равномерно с учётом `budget_per_day`
2. Упорядочить POI внутри дня географически (nearest-neighbor, Haversine)
3. Рассчитать `arrival_time` и `departure_time` для каждой точки (FR-06)
4. Рассчитать `estimated_cost` для каждой точки
5. Вернуть `RoutePlan`

Если итоговый бюджет превышает `budget_total * 1.2` — Scheduler убирает самые
дорогие точки (`price_segment = 'premium'`) и пересчитывает.

### FR-06: Расчёт таймингов (в Scheduler)

- **Переезд:** `ceil(Haversine(a, b) / 25 * 60)` минут (25 км/ч в городе)
- **Время посещения:**

| Категория | Мин |
|-----------|-----|
| museum | 90 |
| park | 60 |
| restaurant | 60 |
| cafe | 30 |
| attraction | 60 |
| shopping | 45 |
| entertainment | 120 |
| default | 45 |

- Начало дня: `start_time` (default: '10:00')
- Конец дня: `end_time` (default: '21:00')
- Если точки не умещаются — лишние переносятся на следующий день или удаляются

---

## 5. Non-Functional Requirements

| Требование | Цель | Примечание |
|-----------|------|-----------|
| Total latency P50 | < 25 сек | Сумма 4 этапов |
| Total latency P95 | < 40 сек | С учётом retry |
| STEP 1 timeout (GPT-4o-mini) | **20 сек** | AbortController → HTTP 504 |
| STEP 2 timeout (Yandex API) | **10 сек** per-request | Fallback: Redis cache → HTTP 422 |
| STEP 3 timeout (YandexGPT) | **15 сек** | AbortController → fallback (STEP 3 пропускается) |
| STEP 4 timeout (GPT-4o-mini) | **20 сек** | AbortController → HTTP 504 |
| Входной контекст YandexGPT | ≤ 4000 токенов | Гарантируется pre-filter (15 POI) |
| Chat context в БД | **max 10 сообщений** | Старые удаляются при записи (~16K токенов лимит) |
| Координаты: lat | ∈ [-90, 90] | Невалидные POI отбрасываются на STEP 2 |
| Координаты: lon | ∈ [-180, 180] | Невалидные POI отбрасываются на STEP 2 |
| Rate limiting | 10 req/мин/user | NestJS Throttler (по JWT subject) |
| Стоимость запроса | < $0.05 | GPT-4o-mini ~10K tokens + YandexGPT |
| Availability | 99.5% | Деградация до partial/cached режима |
| API ключи | только env | Не в коде, не в логах |
| Prompt injection | Input sanitizer | Перед передачей в любой LLM |

---

## 6. Architecture Overview

### 6.1 Компонентная схема

```
┌──────────────────────────────────────────────────────────────────┐
│                         User (Browser)                           │
│             POST /api/ai/plan { user_query, trip_id? }          │
└───────────────────────────────┬──────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                     NestJS: AiController                         │
│   JwtAuthGuard · Throttler · InputSanitizerPipe                  │
│   Load history: ai_sessions.messages (last 10)                   │
└────────────┬─────────────────────────────────┬───────────────────┘
             │                                 │
             ▼                                 ▼
     [STEP 1]                          [STEP 4]
     GPT-4o-mini                       GPT-4o-mini
     Orchestrator                      Scheduler
     ParsedIntent ──────────────────→ RoutePlan
             │                                 ▲
             ▼                                 │
     [STEP 2]                          [STEP 3]
     NestJS                            YandexGPT
     Yandex Maps API Fetch             Semantic Filter
     normalize · validate · filter ──→ FilteredPoi[]
     PoiItem[max 15]
```

### 6.2 Файловая структура (apps/api/src/ai/)

```
apps/api/src/ai/
├── ai.module.ts
├── ai.controller.ts                    # POST /api/ai/plan
├── pipeline/
│   ├── orchestrator.service.ts         # STEP 1: GPT-4o-mini (parse intent)
│   ├── yandex-fetch.service.ts         # STEP 2: HTTP + normalize + validate + filter
│   ├── semantic-filter.service.ts      # STEP 3: YandexGPT (select POI)
│   └── scheduler.service.ts            # STEP 4: GPT-4o-mini (timings)
├── dto/
│   ├── ai-plan-request.dto.ts
│   ├── ai-plan-response.dto.ts
│   ├── parsed-intent.dto.ts
│   └── route-plan.dto.ts
└── types/
    ├── poi.types.ts
    └── pipeline.types.ts
```

### 6.3 Управление пайплайном в контроллере

```typescript
// ai.controller.ts — упрощённая логика
async createPlan(userId: string, dto: AiPlanRequestDto): Promise<AiPlanResponse> {
  const history = await this.loadHistory(dto.trip_id, 10); // max 10 messages

  const intent   = await this.orchestrator.parseIntent(dto.user_query, history);    // STEP 1
  const rawPoi   = await this.yandexFetch.fetchAndFilter(intent);                   // STEP 2
  const filtered = await this.semanticFilter.select(rawPoi, intent);                // STEP 3
  const plan     = await this.scheduler.buildPlan(filtered, intent);                // STEP 4

  await this.saveSession(dto.trip_id, userId, dto.user_query, plan);
  return plan;
}
```

---

## 7. Data Contracts

### 7.1 HTTP запрос: Client → API

```typescript
// POST /api/ai/plan
// Headers: Authorization: Bearer <jwt>

interface AiPlanRequestDto {
  user_query: string;     // обязательный, max 1000 символов (после санитизации)
  trip_id?: string;       // UUID, опциональный — для загрузки контекста
}
```

### 7.2 ParsedIntent: STEP 1 → NestJS

```typescript
interface ParsedIntent {
  city: string;
  days: number;
  budget_total?: number;
  budget_per_day?: number;
  party_type: 'solo' | 'couple' | 'family' | 'group';
  party_size: number;
  categories: PoiCategory[];
  excluded_categories: PoiCategory[];
  radius_km: number;
  start_time: string;        // 'HH:MM'
  end_time: string;          // 'HH:MM'
  preferences_text: string;
}

type PoiCategory =
  | 'museum' | 'park' | 'restaurant' | 'cafe'
  | 'attraction' | 'shopping' | 'entertainment';
```

### 7.3 PoiItem: после нормализации STEP 2 → STEP 3

```typescript
interface PoiItem {
  // Обязательные (без них POI отбрасывается)
  id: string;                    // UUID, генерируется NestJS
  name: string;
  address: string;
  coordinates: {
    lat: number;                 // СТРОГО: ∈ [-90, 90]
    lon: number;                 // СТРОГО: ∈ [-180, 180]
  };
  category: PoiCategory;

  // Опциональные (из Yandex API)
  rating?: number;               // 0.0–5.0
  working_hours?: string;        // '10:00-22:00' | 'Круглосуточно'
  price_segment?: 'free' | 'budget' | 'mid' | 'premium';
  phone?: string;
  website?: string;
  image_url?: string;
}
```

### 7.4 FilteredPoiResponse: YandexGPT → NestJS (STEP 3)

```typescript
// YandexGPT возвращает ТОЛЬКО это.
// NestJS сам обогащает финальный объект данными из оригинального PoiItem[].
interface FilteredPoiResponse {
  selected: Array<{
    id: string;             // id из PoiItem — NestJS по нему находит оригинал
    description: string;    // 1–2 предложения, на русском
  }>;
}

// Финальный объект (после обогащения в NestJS):
interface FilteredPoi extends PoiItem {
  description: string;      // добавлено из FilteredPoiResponse
}
```

### 7.5 AiPlanResponse: API → Client

```typescript
interface AiPlanResponse {
  session_id: string;       // UUID сохранённой сессии
  route_plan: RoutePlan;
  meta: {
    steps_duration_ms: {
      orchestrator: number;
      yandex_fetch: number;
      semantic_filter: number;
      scheduler: number;
      total: number;
    };
    poi_counts: {
      yandex_raw: number;        // до pre-filter
      after_prefilter: number;   // после STEP 2 (max 15)
      after_semantic: number;    // после STEP 3 (5–10)
    };
    fallbacks_triggered: string[];
  };
}

interface RoutePlan {
  city: string;
  days: DayPlan[];
  total_budget_estimated: number;
  notes?: string;
}

interface DayPlan {
  day_number: number;
  date: string;              // ISO 8601
  points: PlannedPoint[];
  day_budget_estimated: number;
  day_start_time: string;    // 'HH:MM'
  day_end_time: string;      // 'HH:MM'
}

interface PlannedPoint {
  poi: FilteredPoi;
  order: number;
  arrival_time: string;      // 'HH:MM'
  departure_time: string;    // 'HH:MM'
  visit_duration_min: number;
  travel_from_prev_min?: number;
  estimated_cost?: number;   // рублей
}
```

---

## 8. Failure Handling

### 8.1 Таймауты

| Этап | Timeout | Действие |
|------|---------|---------|
| STEP 1 GPT-4o-mini | **20 сек** | HTTP 504; retry не выполняется |
| STEP 2 Yandex API | **10 сек** per-request | Redis cache → HTTP 422 если нет кэша |
| STEP 3 YandexGPT | **15 сек** | STEP 3 пропускается; первые 8 POI без описаний |
| STEP 4 GPT-4o-mini | **20 сек** | HTTP 504; retry не выполняется |

### 8.2 Детальные сценарии

**[F-01] city не распознан (STEP 1)**
```
Условие: ParsedIntent.city === '' | null
Действие: HTTP 422 { error: 'CITY_NOT_RECOGNIZED',
          message: 'Не удалось определить город из запроса' }
```

**[F-02] Yandex API недоступен (STEP 2)**
```
Условие: Timeout > 10 сек или HTTP 5xx от Yandex
Действие:
  1. Проверить Redis по ключу: SHA256(city + categories.sort().join(',') + radius_km)
  2. Cache hit (TTL 24h) → вернуть cached PoiItem[], fallback: 'YANDEX_CACHED'
  3. Cache miss → poi_list = [], fallback: 'YANDEX_UNAVAILABLE' → HTTP 422
```

**[F-03] Невалидные координаты (STEP 2)**
```
Условие: lat ∉ [-90, 90] или lon ∉ [-180, 180] или null | NaN | string
Детекция: Валидатор в normalize(), до добавления в poi_list
Действие: POI немедленно отбрасывается, логируется:
  WARN: `POI discarded: invalid coords [${lat}, ${lon}] — "${name}"`
```

**[F-04] Мало POI (STEP 2)**
```
Условие: poi_list.length < 3 после pre-filter
Действие:
  1. Повторить запрос с radius_km * 1.3 (max 1 retry)
  2. Если < 3 после retry → HTTP 422 { error: 'INSUFFICIENT_POI' }
```

**[F-05] YandexGPT не отвечает (STEP 3)**
```
Условие: Timeout > 15 сек или невалидный JSON
Действие:
  1. Пропустить STEP 3 (не прерывать пайплайн)
  2. Использовать первые 8 POI из pre-filtered списка без description
  3. notes += 'Семантическая фильтрация недоступна. Показаны места с наивысшим рейтингом.'
  4. fallback: 'SEMANTIC_FILTER_SKIPPED'
```

**[F-06] Переполнение дня (STEP 4)**
```
Условие: Σ(visit + travel) > day_window_minutes
Действие:
  1. Перенести лишние точки на следующий день
  2. Если последний день → удалить с пометкой в notes
```

**[F-07] Превышение бюджета (STEP 4)**
```
Условие: day_budget_actual > budget_per_day * 1.2
Действие:
  1. Удалить POI с price_segment = 'premium', затем 'mid' (если нужно)
  2. notes += 'Некоторые места исключены из-за бюджетных ограничений.'
```

**[F-08] Конфликт ограничений — нет POI**
```
Условие: FilteredPoi[].length === 0
Действие: HTTP 422 {
  error: 'PLAN_IMPOSSIBLE',
  suggestions: ['Увеличьте бюджет', 'Расширьте категории', 'Уменьшите количество дней']
}
```

**[F-09] Невалидный JSON от LLM**
```
Условие: JSON.parse() выбрасывает исключение
Действие:
  1. Один retry с добавлением в промпт: 'Respond ONLY with valid JSON, no markdown'
  2. Если снова невалидно → HTTP 502 { error: 'LLM_INVALID_RESPONSE' }
```

**[F-10] Prompt injection**
```
Условие: user_query содержит инструкции-внедрения
Детекция: InputSanitizerPipe (до контроллера)
Действие: Экранирование, обрезка; передача ТОЛЬКО как user-content в кавычках
```

---

## 9. KPI и метрики успеха

### 9.1 Технические (MVP — с первого дня)

| Метрика | Цель | Метод измерения |
|---------|------|----------------|
| Total latency P50 | < 25 сек | `meta.steps_duration_ms.total` в каждом ответе |
| Total latency P95 | < 40 сек | Агрегация за 24h |
| Successful plan rate | > 85% | ratio(HTTP 200) / total requests |
| STEP 3 fallback rate | < 10% | ratio('SEMANTIC_FILTER_SKIPPED') / total |
| Invalid coord rate | < 5% | Discarded POI / total raw POI из Yandex |
| Yandex cache hit rate | > 25% | Redis INFO (после 7 дней) |
| Avg cost per request | < $0.05 | OpenAI billing / total requests |

### 9.2 Продуктовые (после запуска)

| Метрика | Цель | Метод |
|---------|------|-------|
| Relevance score | > 75% маршрутов ≥ 4/5 | Thumbs up/down на каждую точку |
| Route save rate | > 55% | % AI-маршрутов, сохранённых в поездку |
| AI-to-edit rate | < 50% | % пользователей, редактировавших результат |

---

## 10. Ограничения и зависимости

| Зависимость | Влияние | Митигация |
|------------|---------|-----------|
| OpenAI API (GPT-4o-mini) | Модуль недоступен | HTTP 503; VPN/proxy из РФ в prod |
| YandexGPT API | STEP 3 пропускается (graceful) | Маршрут без описаний |
| Yandex Maps Search API | poi_list пуст | Redis cache (TTL 24h); HTTP 422 при cache miss |
| Redis | Cache miss на каждый запрос | Повторные Yandex API-запросы; деградация по стоимости |
| PostgreSQL | Сессии не сохраняются | In-memory; потеря при рестарте |

**Региональные:** Яндекс.Карты оптимален для РФ/СНГ.
Для других регионов — замена STEP 2 на Google Places (архитектура допускает).

---

## 11. Возможности расширения

| Направление | Описание | Приоритет |
|------------|----------|-----------|
| Redis POI cache | SHA256(city+categories+radius) TTL 24h | P1 (MVP+1) |
| Streaming SSE | Показывать POI по мере прохождения STEP 2/3 | P2 |
| Замена STEP 2 | Интерфейс IPoiFetcher → подключить Google Places | P2 |
| Параллельный STEP 2 | Promise.all по категориям уже заложен | P1 |
| Персонализация | История user в system_prompt Orchestrator | P3 |

---

## Appendix A: Пример сквозного взаимодействия

**Запрос:** `"2 дня в Казани, бюджет 10000, с ребёнком, без ночных клубов"`

**STEP 1 — ParsedIntent:**
```json
{
  "city": "Казань", "days": 2, "budget_total": 10000, "budget_per_day": 5000,
  "party_type": "family", "party_size": 2,
  "categories": ["attraction", "park", "museum", "cafe"],
  "excluded_categories": ["entertainment"],
  "radius_km": 5, "start_time": "10:00", "end_time": "20:00",
  "preferences_text": "подходит для детей"
}
```

**STEP 2 — NestJS → Yandex API → 15 POI (пример 2 из 15):**
```json
[
  { "id": "poi-1", "name": "Казанский Кремль", "address": "ул. Кремлёвская, 2",
    "coordinates": { "lat": 55.7986, "lon": 49.1064 }, "category": "attraction",
    "rating": 4.8, "price_segment": "budget" },
  { "id": "poi-2", "name": "Парк Черное Озеро", "address": "ул. Дзержинского",
    "coordinates": { "lat": 55.7904, "lon": 49.1147 }, "category": "park",
    "rating": 4.3, "price_segment": "free" }
]
```

**STEP 3 — FilteredPoiResponse (5 из 15):**
```json
{
  "selected": [
    { "id": "poi-1", "description": "Белокаменный кремль с мечетью Кул-Шариф — сердце Казани, захватывающее дух детей и взрослых." },
    { "id": "poi-2", "description": "Уютный городской парк с фонтанами, идеален для прогулки с детьми после насыщенной экскурсии." }
  ]
}
```

**Финальный AiPlanResponse.meta:**
```json
{
  "steps_duration_ms": { "orchestrator": 3200, "yandex_fetch": 1800,
    "semantic_filter": 4100, "scheduler": 3500, "total": 12600 },
  "poi_counts": { "yandex_raw": 28, "after_prefilter": 15, "after_semantic": 5 },
  "fallbacks_triggered": []
}
```
