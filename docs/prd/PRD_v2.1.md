# PRD: Travel Planner — Project Migration & Feature Expansion
# Version: 2.1 | Status: MVP | Date: 2026-03-13
# Owner: Engineering Team

---

## Changelog v2.0 → v2.1

| Изменение | Причина |
|-----------|---------|
| Расширена таблица `trips`: добавлены поля `is_public`, `source`, `cover_image_url`, `tags`, `weather_temp`, `total_price_display` | Поддержка популярных маршрутов (seed + AI-генерация) |
| Новый endpoint `GET /trips/popular?filter=` | Публичный доступ к популярным маршрутам с фильтрацией по тегам |
| Добавлен seed-скрипт `popular-routes.seed.ts` | Захардкоженные 5 маршрутов из прототипа переносятся через seed |
| Admin CLI: `pnpm ai:generate-popular <city>` | Девелоперская операция — YandexGPT генерирует топ-места города |
| Редизайн PlannerPage: вертикальный layout, табы, поиск | Приведение production к дизайну прототипа `travel-planner-design` |
| Добавлен `features/popular-routes/` (FSD) | Хук `usePopularRoutes` заменяет хардкод на API |
| Добавлен `@dnd-kit/core` в зависимости | Drag & Drop для сортировки точек маршрута |
| Фикс desktop layout — sidebar/content alignment | Sidebar fixed w-20 обрезал контент на некоторых viewport'ах |
| Задачи TRI-41 — TRI-46 добавлены в decomposition | Редизайн Planner, популярные маршруты, layout fix |

---

## 1. Overview

### 1.1 Цель документа

Настоящий документ описывает план переноса функционала прототипа `travel-planner-design`
в production-готовый monorepo `travel-planner`, а также расширение продукта новыми
инженерными возможностями: real-time коллаборация, алгоритмическая оптимизация маршрута,
двухуровневый AI-движок планирования, популярные маршруты с seed-данными и AI-генерацией.

### 1.2 Tech Stack

| Уровень | Технология |
|---------|-----------|
| Monorepo | Turborepo 2.x + pnpm workspaces |
| Frontend | Next.js 16 (App Router), React 19, TypeScript 5.9 |
| UI | Tailwind CSS 4, shadcn/ui, Lucide React |
| State | Zustand |
| DnD | @dnd-kit/core, @dnd-kit/sortable |
| Maps | Yandex Maps API 2.1 (динамический `<script>` loader) |
| Backend | NestJS 11, TypeScript |
| ORM | Drizzle ORM 0.45+ |
| Database | PostgreSQL 16 |
| Real-time | Socket.io (NestJS WebSocketGateway) |
| Auth | JWT + Passport.js |
| AI | GPT-4o-mini (Orchestrator + Scheduler) + YandexGPT (Semantic Filter) |
| Cache | Redis (POI cache TTL 24h + AI сессии) |

### 1.3 Monorepo и соглашения

```
Monorepo:   travel-planner/
Backend:    apps/api/src/
Frontend:   apps/web/src/
Alias:      @/* → ./src/*  (tsconfig.json)
Port API:   3001
Port Web:   3000
```

**FSD слои** (импорт только сверху вниз):
`app → views → widgets → features → entities → shared`

**ВАЖНО:** слой `views/` — НЕ `pages/`, иначе Next.js запустит Pages Router.

**shadcn** компоненты: `pnpm dlx shadcn@latest add <component>` из `apps/web/` → ложатся в `@/shared/ui/`.

**Yandex Maps:** НЕ npm-пакет, динамический `<script>` loader.

**JWT хранение:** `localStorage` (для API calls) + `cookie` (для SSR `middleware.ts`).

**WebSocket правило:** события WS → только Zustand store, НИКОГДА не вызывать API-запросы.

---

## 2. Прототип — Инвентаризация функционала

Источник: `travel-planner-design` (vanilla React + CDN + Babel).
Все перечисленные фичи подлежат переносу в production-стек.

### 2.1 Страницы и компоненты

| Компонент | Функционал | Приоритет | Целевой путь (Next.js) |
|-----------|-----------|-----------|----------------------|
| `LandingPage.js` | Hero video, AI поиск, ручная форма поиска, карусель маршрутов, FAQ | **P0** | `/app/(main)/page.tsx` |
| `PlannerPage.js` | Конструктор маршрута, Yandex геокодирование, интерактивная карта, таблица точек, бюджет, **табы Конструктор/Популярные** | **P0** | `/app/(main)/planner/page.tsx` |
| `AIAssistantPage.js` | Чат-интерфейс, контекст маршрута, quick actions, tour cards в ответах | **P0** | `/app/(main)/ai-assistant/page.tsx` |
| `ProfilePage.js` | Аватар, имя, активный маршрут, сохранённые маршруты, редактирование | **P1** | `/app/(main)/profile/page.tsx` |
| `TourPage.js` | Детали предзаданного маршрута, карта, точки с изображениями, sidebar | **P1** | `/app/(main)/tours/[id]/page.tsx` |
| `RecommendationsPage.js` | Список рекомендаций, draggable bottom sheet (mobile), карта | **P1** | `/app/(main)/recommendations/page.tsx` |
| `ActiveRouteDisplay.js` | Переиспользуемый компонент карты + деталей маршрута | **P0** | `widgets/route-map/` |
| `App.js` (навигация) | Header, Sidebar, Bottom Nav, Login Modal, User Menu | **P0** | `widgets/header/`, `widgets/sidebar/`, `widgets/bottom-nav/` |

### 2.2 Глобальное состояние (перенос из App.js)

```typescript
// Прототип: единый React state в App.js
// Production: Zustand stores по сущностям (entities/)
{
  view, activeTab,           → router.push() + URL params
  user: { name, photo,       → entities/user/model/user.store.ts
    savedRoutes[] },
  editingRoute,              → entities/trip/model/trip.store.ts
  initialManualFormData,     → features/route-create/model/
  showLoginModal,            → features/auth/model/
  selectedPredefinedRoute    → entities/trip/model/
}
```

### 2.3 Данные из прототипа для переноса в БД

| Прототип | БД (Drizzle) |
|---------|-------------|
| Hardcoded predefined routes (5 маршрутов: Байкал, Алтай, Камчатка и т.д.) | `trips` table: `is_predefined = true`, `is_public = true`, `source = 'seed'` |
| Route points (coords, budget, date) | `route_points` table |
| User saved routes | `trips` table с `owner_id` |
| User profile | `users` table |
| Фильтр-чипсы (Все / Активный / Зима / Экстрим) | `trips.tags` (text[] array) |

---

## 3. FSD Architecture — Frontend

Принята Feature-Sliced Design (FSD) архитектура для `apps/web/src/`.
Импорты только сверху вниз по слоям: `app → views → widgets → features → entities → shared`.

```
apps/web/src/
│
├── app/                              # Next.js App Router (системный слой)
│   ├── layout.tsx                    # Root layout (fonts, providers)
│   ├── (auth)/
│   │   └── login/
│   │       └── page.tsx
│   └── (main)/
│       ├── layout.tsx                # Authenticated layout (sidebar, header, bottom-nav)
│       ├── page.tsx                  # Landing page
│       ├── planner/
│       │   └── page.tsx
│       ├── ai-assistant/
│       │   └── page.tsx
│       ├── tours/
│       │   └── [id]/
│       │       └── page.tsx
│       ├── recommendations/
│       │   └── page.tsx
│       └── profile/
│           └── page.tsx
│
├── views/                           # FSD Layer: Page-level composition
│   ├── landing/
│   │   ├── ui/LandingPage.tsx
│   │   └── index.ts
│   ├── planner/
│   │   ├── ui/PlannerPage.tsx       # Два таба: Конструктор / Популярные
│   │   └── index.ts
│   ├── ai-assistant/
│   │   ├── ui/AIAssistantPage.tsx
│   │   └── index.ts
│   ├── tour-detail/
│   │   ├── ui/TourDetailPage.tsx
│   │   └── index.ts
│   ├── recommendations/
│   │   ├── ui/RecommendationsPage.tsx
│   │   └── index.ts
│   └── profile/
│       ├── ui/ProfilePage.tsx
│       └── index.ts
│
├── widgets/                          # FSD Layer: Самодостаточные UI-блоки
│   ├── header/
│   │   ├── ui/Header.tsx
│   │   └── index.ts
│   ├── sidebar/
│   │   ├── ui/Sidebar.tsx            # md+ visible, mobile hidden (BottomNav)
│   │   └── index.ts
│   ├── bottom-nav/
│   │   ├── ui/BottomNav.tsx
│   │   └── index.ts
│   ├── route-map/                    # Yandex Maps интеграция
│   │   ├── ui/RouteMap.tsx
│   │   ├── lib/yandex-maps.ts        # Динамический script loader
│   │   └── index.ts
│   ├── route-builder/                # Таблица точек + управление бюджетом
│   │   ├── ui/RouteBuilder.tsx       # Секция «Бюджет маршрута»
│   │   ├── ui/PointRow.tsx           # Inline-edit, дата, бюджет ₽, удаление
│   │   └── index.ts
│   ├── ai-chat/                      # Чат-интерфейс
│   │   ├── ui/AiChat.tsx
│   │   ├── ui/MessageBubble.tsx
│   │   └── index.ts
│   ├── compare-save/                 # "Compare & Save" виджет (TSP до/после)
│   │   ├── ui/CompareSave.tsx
│   │   └── index.ts
│   └── popular-routes-grid/          # Grid карточек популярных маршрутов (v2.1)
│       ├── ui/PopularRoutesGrid.tsx  # Фильтр-чипсы + grid + skeleton
│       └── index.ts
│
├── features/                         # FSD Layer: Бизнес-действия
│   ├── auth/
│   │   ├── model/auth.store.ts       # Zustand: isAuthenticated, user, tokens
│   │   ├── ui/LoginModal.tsx
│   │   ├── ui/RegisterModal.tsx
│   │   └── index.ts
│   ├── route-create/
│   │   ├── model/route-create.store.ts
│   │   ├── ui/ManualSearchForm.tsx
│   │   ├── ui/AiSearchInput.tsx
│   │   └── index.ts
│   ├── route-optimize/               # TSP оптимизация
│   │   ├── model/optimize.store.ts
│   │   ├── ui/OptimizeButton.tsx
│   │   └── index.ts
│   ├── route-collaborate/            # Real-time WebSocket редактирование
│   │   ├── model/collaborate.store.ts
│   │   ├── hooks/useCollaboration.ts
│   │   ├── ui/CollaboratorsList.tsx
│   │   ├── ui/LiveCursor.tsx
│   │   └── index.ts
│   ├── ai-query/                     # Запрос к Dual-AI Engine
│   │   ├── model/ai-query.store.ts
│   │   └── index.ts
│   ├── poi-search/                   # Геокодирование через Yandex
│   │   ├── model/poi-search.store.ts
│   │   ├── ui/SearchDropdown.tsx     # Дропдаун + опция «Найти с AI»
│   │   └── index.ts
│   ├── route-save/
│   │   ├── model/route-save.store.ts
│   │   └── index.ts
│   └── popular-routes/               # Популярные маршруты (v2.1)
│       ├── api/usePopularRoutes.ts   # fetch GET /trips/popular?filter=
│       ├── model/popular-routes.store.ts
│       └── index.ts
│
├── entities/                         # FSD Layer: Бизнес-сущности
│   ├── user/
│   │   ├── model/user.store.ts       # Zustand: currentUser
│   │   ├── model/user.types.ts
│   │   ├── ui/Avatar.tsx
│   │   ├── ui/UserMenu.tsx
│   │   └── index.ts
│   ├── trip/
│   │   ├── model/trip.store.ts       # Zustand: currentTrip, savedTrips
│   │   ├── model/trip.types.ts
│   │   ├── ui/TripCard.tsx           # Фото, заголовок, цена (amber badge), описание
│   │   ├── ui/TripList.tsx
│   │   └── index.ts
│   ├── route-point/
│   │   ├── model/route-point.types.ts
│   │   ├── ui/PointBadge.tsx
│   │   └── index.ts
│   └── poi/
│       ├── model/poi.types.ts
│       ├── ui/PoiCard.tsx
│       └── index.ts
│
└── shared/                           # FSD Layer: Переиспользуемые примитивы
    ├── api/
    │   ├── http.ts                   # fetch wrapper (base URL, auth headers)
    │   └── index.ts
    ├── socket/
    │   ├── socket-client.ts          # Socket.io клиент + хук useSocket
    │   └── index.ts
    ├── config/
    │   ├── env.ts                    # process.env типизация
    │   └── index.ts
    ├── lib/
    │   ├── format-budget.ts
    │   ├── haversine.ts              # Расстояние между координатами
    │   └── index.ts
    └── ui/                           # Реэкспорт shadcn/ui компонентов
        ├── button.tsx
        ├── card.tsx
        ├── input.tsx
        ├── dialog.tsx
        ├── sheet.tsx                 # Для mobile bottom sheet
        ├── tabs.tsx                  # Для Конструктор / Популярные
        └── index.ts
```

---

## 4. Backend Architecture — NestJS

```
apps/api/src/
│
├── main.ts                           # Bootstrap, CORS, ValidationPipe, Socket.io
├── app.module.ts                     # Корневой модуль
│
├── db/
│   ├── db.module.ts                  # Global Drizzle module
│   ├── schema.ts                     # PostgreSQL схема (см. раздел 5)
│   └── seeds/
│       └── popular-routes.seed.ts    # 5 маршрутов из прототипа (v2.1)
│
├── auth/                             # JWT + Passport
│   ├── auth.module.ts
│   ├── auth.controller.ts            # POST /auth/login, POST /auth/register
│   ├── auth.service.ts               # bcrypt, JWT sign/verify
│   ├── guards/
│   │   └── jwt-auth.guard.ts
│   ├── decorators/
│   │   └── current-user.decorator.ts
│   └── strategies/
│       ├── jwt.strategy.ts
│       └── local.strategy.ts
│
├── users/
│   ├── users.module.ts
│   ├── users.controller.ts           # GET /users/me, PATCH /users/me
│   └── users.service.ts
│
├── trips/
│   ├── trips.module.ts
│   ├── trips.controller.ts           # CRUD /trips, GET /trips/:id, GET /trips/popular
│   └── trips.service.ts
│
├── route-points/
│   ├── route-points.module.ts
│   ├── route-points.controller.ts    # CRUD /trips/:id/points, PATCH reorder
│   └── route-points.service.ts
│
├── optimization/                     # TSP nearest-neighbor алгоритм
│   ├── optimization.module.ts
│   ├── optimization.controller.ts    # POST /trips/:id/optimize
│   └── optimization.service.ts
│       # Алгоритм: nearest-neighbor TSP
│       # transport_mode: 'walk' | 'transit' | 'auto'
│       # Формула W (только auto): (Distance * Consumption / 100 * FuelPrice) + TollFees
│       # Возвращает: optimized_order[], saved_km, saved_rub, saved_hours
│
├── collaboration/                    # WebSockets — совместное редактирование
│   ├── collaboration.module.ts
│   ├── collaboration.gateway.ts      # @WebSocketGateway('/collaboration')
│   │   # Events: point:add, point:move, point:delete
│   │   # Rooms: trip_{id}
│   │   # Presence: cursor:move, user:join, user:leave
│   └── collaboration.service.ts
│
└── ai/                               # Dual-AI Engine (см. раздел 6.4)
    ├── ai.module.ts
    ├── ai.controller.ts              # POST /ai/plan — оркестрирует пайплайн
    ├── pipeline/
    │   ├── orchestrator.service.ts   # STEP 1: GPT-4o-mini (parse intent)
    │   ├── yandex-fetch.service.ts   # STEP 2: NestJS HTTP → Yandex Maps API
    │   ├── semantic-filter.service.ts # STEP 3: YandexGPT (выбор 5–10 POI)
    │   └── scheduler.service.ts      # STEP 4: GPT-4o-mini (тайминги)
    ├── cli/
    │   └── generate-popular.ts       # Admin CLI: pnpm ai:generate-popular <city> (v2.1)
    ├── dto/
    │   ├── ai-plan-request.dto.ts
    │   ├── ai-plan-response.dto.ts
    │   ├── parsed-intent.dto.ts
    │   └── route-plan.dto.ts
    └── types/
        ├── poi.types.ts
        └── pipeline.types.ts
```

### 4.1 REST API Endpoints

| Method | Path | Auth | Описание |
|--------|------|------|---------|
| POST | `/auth/register` | — | Регистрация пользователя |
| POST | `/auth/login` | — | Авторизация, возврат JWT |
| GET | `/users/me` | JWT | Профиль текущего пользователя |
| PATCH | `/users/me` | JWT | Обновление профиля |
| GET | `/trips` | JWT | Список поездок пользователя |
| POST | `/trips` | JWT | Создание поездки |
| GET | `/trips/:id` | JWT | Детали поездки |
| PATCH | `/trips/:id` | JWT | Обновление поездки |
| DELETE | `/trips/:id` | JWT | Удаление поездки |
| GET | `/trips/predefined` | — | Предзаданные маршруты (публично) |
| GET | `/trips/popular` | — | **v2.1:** Популярные маршруты с фильтрацией (`?filter=winter`) |
| GET | `/trips/:id/points` | JWT | Точки маршрута |
| POST | `/trips/:id/points` | JWT | Добавление точки |
| PATCH | `/trips/:id/points/:pid` | JWT | Обновление точки |
| DELETE | `/trips/:id/points/:pid` | JWT | Удаление точки |
| PATCH | `/trips/:id/points/reorder` | JWT | **v2.1:** Изменение порядка точек (после DnD) |
| POST | `/trips/:id/optimize` | JWT | TSP оптимизация (body: `{ transport_mode, params }`) |
| POST | `/ai/plan` | JWT | Dual-AI планирование |

### 4.2 WebSocket Events

| Событие | Направление | Payload |
|---------|------------|---------|
| `join:trip` | client → server | `{ trip_id }` |
| `leave:trip` | client → server | `{ trip_id }` |
| `point:add` | client → server | `{ trip_id, point }` |
| `point:move` | client → server | `{ trip_id, point_id, coords }` |
| `point:delete` | client → server | `{ trip_id, point_id }` |
| `cursor:move` | client → server | `{ trip_id, x, y }` |
| `point:added` | server → clients | `{ point, user_id }` |
| `point:moved` | server → clients | `{ point_id, coords, user_id }` |
| `point:deleted` | server → clients | `{ point_id, user_id }` |
| `cursor:moved` | server → clients | `{ user_id, x, y, color }` |
| `presence:join` | server → clients | `{ user_id, name, color }` |
| `presence:leave` | server → clients | `{ user_id }` |

### 4.3 Admin CLI (v2.1)

```bash
# Девелоперская операция (не user-facing)
# Вызывает YandexGPT, получает топ-места города,
# сохраняет в trips({ source: 'ai', is_public: true })
pnpm ai:generate-popular <city>
```

### 4.4 Скрипты БД

```json
// apps/api/package.json
{
  "db:push": "drizzle-kit push:pg",
  "db:studio": "drizzle-kit studio",
  "db:seed": "ts-node src/db/seeds/popular-routes.seed.ts"
}
```

---

## 5. Database Schema (Drizzle ORM + PostgreSQL)

```typescript
// apps/api/src/db/schema.ts

import {
  pgTable, pgEnum, uuid, text, boolean, integer,
  jsonb, doublePrecision, timestamp, primaryKey,
} from 'drizzle-orm/pg-core'

// ── ENUMS ──────────────────────────────────────────────────────────────────

// ENUM: роли коллаборации
export const collaboratorRoleEnum = pgEnum('collaborator_role', ['owner', 'editor', 'viewer'])

// ENUM: категории POI
export const poiCategoryEnum = pgEnum('poi_category',
  ['museum', 'park', 'restaurant', 'cafe', 'attraction', 'shopping', 'entertainment'])

// ENUM: режим транспорта для TSP оптимизации
export const transportModeEnum = pgEnum('transport_mode', ['walk', 'transit', 'auto'])
// walk    — пешком: только дистанция, стоимость = 0
// transit — общественный транспорт: дистанция * тариф
// auto    — автомобиль: W = (Distance * Consumption / 100 * FuelPrice) + TollFees

// ENUM: источник маршрута (v2.1)
export const tripSourceEnum = pgEnum('trip_source', ['user', 'seed', 'ai'])
// user — создан пользователем
// seed — из seed-файла (прототип)
// ai   — сгенерирован admin CLI (pnpm ai:generate-popular)

// ── USERS ──────────────────────────────────────────────────────────────────
export const users = pgTable('users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  email:        text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name:         text('name').notNull(),
  photo:        text('photo'),                         // URL или base64
  createdAt:    timestamp('created_at').notNull().defaultNow(),
})

// ── TRIPS ──────────────────────────────────────────────────────────────────
export const trips = pgTable('trips', {
  id:                uuid('id').primaryKey().defaultRandom(),
  title:             text('title').notNull(),
  description:       text('description'),
  budget:            integer('budget'),                     // рублей
  ownerId:           uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  isActive:          boolean('is_active').notNull().default(true),
  isPredefined:      boolean('is_predefined').notNull().default(false), // системные маршруты
  isPublic:          boolean('is_public').notNull().default(false),     // v2.1: видимость в /popular
  source:            tripSourceEnum('source').notNull().default('user'),// v2.1: кто создал
  coverImageUrl:     text('cover_image_url'),              // v2.1: обложка для карточки
  tags:              text('tags').array(),                  // v2.1: ['winter', 'active', 'extreme']
  weatherTemp:       text('weather_temp'),                 // v2.1: «от -5 до +3 °C» (display)
  totalPriceDisplay: text('total_price_display'),          // v2.1: «от 45 000 ₽» (display)
  startDate:         text('start_date'),                   // text: свободный формат дат
  endDate:           text('end_date'),
  createdAt:         timestamp('created_at').notNull().defaultNow(),
  updatedAt:         timestamp('updated_at').notNull().defaultNow(),
})

// ── TRIP COLLABORATORS ─────────────────────────────────────────────────────
export const tripCollaborators = pgTable('trip_collaborators', {
  tripId:   uuid('trip_id').notNull().references(() => trips.id, { onDelete: 'cascade' }),
  userId:   uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role:     collaboratorRoleEnum('role').notNull().default('viewer'),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.tripId, t.userId] })])  // составной PK

// ── ROUTE POINTS ───────────────────────────────────────────────────────────
export const routePoints = pgTable('route_points', {
  id:        uuid('id').primaryKey().defaultRandom(),
  tripId:    uuid('trip_id').notNull().references(() => trips.id, { onDelete: 'cascade' }),
  title:     text('title').notNull(),
  lat:       doublePrecision('lat').notNull(),          // float8: точность ~15 знаков, нужна для TSP
  lon:       doublePrecision('lon').notNull(),
  budget:    integer('budget'),
  visitDate: text('visit_date'),                        // text: свободный формат дат
  imageUrl:  text('image_url'),
  order:     integer('order').notNull().default(0),     // порядок в маршруте; перезаписывается при TSP / DnD
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// ── OPTIMIZATION RESULTS ───────────────────────────────────────────────────
export const optimizationResults = pgTable('optimization_results', {
  id:             uuid('id').primaryKey().defaultRandom(),
  tripId:         uuid('trip_id').notNull().references(() => trips.id, { onDelete: 'cascade' }),
  originalOrder:  jsonb('original_order').notNull(),    // string[] (point UUIDs)
  optimizedOrder: jsonb('optimized_order').notNull(),   // string[] (point UUIDs)
  savedKm:        doublePrecision('saved_km').notNull().default(0),   // float: дробные км
  savedRub:       doublePrecision('saved_rub').notNull().default(0),
  savedHours:     doublePrecision('saved_hours').notNull().default(0), // float: дробные часы
  transportMode:  transportModeEnum('transport_mode').notNull().default('auto'),
  // Формула веса ребра (только для transportMode='auto'):
  //   W = (Distance_km * consumption / 100 * fuelPrice) + tollFees
  // Для 'walk': W = Distance_km (стоимость = 0)
  // Для 'transit': W = Distance_km * transitFarePerKm
  params:         jsonb('params'),
  // params schema:
  // { consumption?: number, fuelPrice?: number, tollFees?: number,
  //   transitFarePerKm?: number }
  // Поля consumption/fuelPrice/tollFees игнорируются при transportMode != 'auto'
  createdAt:      timestamp('created_at').notNull().defaultNow(),
})

// ── AI SESSIONS ────────────────────────────────────────────────────────────
export const aiSessions = pgTable('ai_sessions', {
  id:        uuid('id').primaryKey().defaultRandom(),
  tripId:    uuid('trip_id').references(() => trips.id, { onDelete: 'set null' }), // nullable
  userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  messages:  jsonb('messages').notNull().default('[]'), // Message[], max 10
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
```

---

## 6. New Features — Детальное описание

### 6.1 Real-time Collaboration

**Технологии:** NestJS `@WebSocketGateway` + `socket.io` + Zustand на клиенте.

**Архитектура:**
- Каждая поездка = отдельная Socket.io Room (`trip_{uuid}`)
- При открытии планировщика клиент join'ится в комнату
- Все изменения точек транслируются всем участникам комнаты
- Состояние авторитетно только на сервере (PostgreSQL)

**Live Cursors:**
- Клиент отправляет `cursor:move` с viewport-нормализованными координатами (0–1)
- Сервер ретранслирует всем участникам комнаты
- Каждый пользователь получает уникальный цвет (детерминированный от `user_id`)
- Индикатор «Имя пользователя редактирует...» при активных `cursor:move` событиях

**Presence:**
- При `join:trip` → broadcast `presence:join` с данными пользователя
- При disconnect → broadcast `presence:leave`
- Список онлайн-участников хранится в памяти NestJS (Map)

### 6.2 TSP Route Optimization

**Алгоритм:** Nearest-Neighbor Heuristic для задачи коммивояжера.

**Режим транспорта (`transport_mode`):**

| Режим | Формула веса ребра W(a, b) | Параметры |
|-------|---------------------------|-----------|
| `auto` | `(Distance_km * Consumption / 100 * FuelPrice) + TollFees` | consumption, fuel_price, toll_fees_per_km |
| `transit` | `Distance_km * transit_fare_per_km` | transit_fare_per_km (default: 3 руб/км) |
| `walk` | `Distance_km` (стоимость = 0, метрика — только расстояние) | — |

Формула топлива применяется **исключительно** при `transport_mode = 'auto'`.
При `walk` и `transit` поля `consumption`, `fuel_price`, `toll_fees_per_km` игнорируются.

**Параметры для `auto` (от пользователя):**
- `consumption` — расход топлива (л/100 км), default: 8
- `fuel_price` — цена топлива (руб/л), default: 55
- `toll_fees_per_km` — платные дороги (руб/км), default: 0

**Алгоритм nearest-neighbor:**
1. Начало с первой точки маршрута
2. На каждом шаге — выбрать ближайшую непосещённую точку по весу W
3. Повторять до обхода всех точек
4. Сравнить суммарный вес оптимизированного и исходного маршрута

**Метрики "Compare & Save":**
- `saved_km` = Σ(исходные дистанции) - Σ(оптимизированные дистанции)
- `saved_rub` = saved_km * consumption / 100 * fuel_price
- `saved_hours` = saved_km / средняя скорость (80 км/ч трасса)

**Виджет CompareSave:**
- Переключатель режима: Пешком / Общественный транспорт / Авто
- Форма параметров авто (расход, цена топлива) — отображается только при `auto`
- Кнопка «Оптимизировать маршрут»
- Сравнительная таблица До/После (км, руб, часы)
- Анимированное перестроение polyline на карте

### 6.3 Yandex Maps Integration

**Замена:** Прототип использует Yandex Maps API 2.1 (CDN). Production версия
интегрирует тот же API через динамический script loader (Next.js нет пакета).

**Реализация:**
```typescript
// widgets/route-map/lib/yandex-maps.ts
export async function loadYandexMaps(apiKey: string): Promise<void> {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${apiKey}&lang=ru_RU`;
    script.onload = () => ymaps.ready(resolve);
    document.head.appendChild(script);
  });
}
```

**Анимации Polyline:** При изменении порядка точек — fade out → обновить маркеры → fade in через `requestAnimationFrame`.

### 6.4 Dual-AI Engine (Orchestrator + Semantic Filter)

**Подробная спецификация:** см. `dual_ai_engine_prd.md` v2.0.

**Краткое описание:** Четырёхэтапный конвейер планирования.
NestJS — главный оркестратор, LLM получают строго ограниченные задачи.

```
User → [NestJS Controller]
  → STEP 1: GPT-4o-mini Orchestrator (parse intent)     timeout: 20s
  → STEP 2: NestJS → Yandex Maps API (fetch + filter)   timeout: 10s/req
  → STEP 3: YandexGPT Semantic Filter (select 5-10 POI) timeout: 15s
  → STEP 4: GPT-4o-mini Scheduler (timings + budget)    timeout: 20s
→ AiPlanResponse
```

**Graceful Degradation:**
- STEP 1 fail → HTTP 504
- STEP 2 fail → Redis cache → HTTP 422 при cache miss
- STEP 3 fail → пропускается; первые 8 POI без описаний
- STEP 4 fail → HTTP 504

**Chat context:** max 10 сообщений в `ai_sessions`. Старые удаляются перед записью.

**Стоимость запроса:** < $0.05 (GPT-4o-mini × 2 + YandexGPT × 1).

### 6.5 Популярные маршруты (v2.1)

**Источники данных:**
1. **Seed:** 5 маршрутов из прототипа (Байкал, Алтай, Камчатка и т.д.) — `source = 'seed'`
2. **AI-генерация:** Admin CLI `pnpm ai:generate-popular <city>` — `source = 'ai'`
3. **Пользовательские:** В будущем — возможность делать маршруты публичными — `source = 'user'`

**Backend:**
- `GET /trips/popular?filter=` — возвращает только `is_public = true`
- Фильтрация по `tags` array: `?filter=winter` → `WHERE 'winter' = ANY(tags)`
- Сортировка: по `createdAt DESC`

**Frontend:**
- Таб «Популярные» в PlannerPage
- Поиск по направлению (поле ввода)
- Фильтр-чипсы: Все / Активный / Зима / Экстрим
- Grid карточек: фото (`cover_image_url`), заголовок, цена (бейдж brand-amber `total_price_display`), описание
- Skeleton loading (3 карточки-заглушки) при загрузке
- Хук `features/popular-routes/api/usePopularRoutes.ts`

### 6.6 Редизайн PlannerPage (v2.1)

**Layout:**
- Снесён sidebar-layout внутри Planner, сделана вертикальная страница `max-w-5xl` по центру
- Заголовок «Маршруты», два таба (Конструктор / Популярные)
- Sidebar: на `md+` показывать (`fixed w-20`), на mobile скрывать (используется BottomNav)
- `(main)/layout.tsx` корректно задаёт content area после sidebar на всех breakpoints

**Таб «Конструктор»:**
- Поисковая строка с иконкой и кнопкой «ДОБАВИТЬ»
- Дропдаун с результатами Яндекс Карт + опция «Найти с AI»
- Карта на всю ширину (`aspect-[21/9]`)
- Секция «Бюджет маршрута» под картой:
  - Поле «Планируемый бюджет»
  - Список точек (номер, название с inline-edit, поле даты, поле бюджета ₽, кнопка удаления)
  - Итого с цветовой индикацией (красный / зелёный / amber)
  - Тогл «Сделать активным маршрутом»
  - Кнопки «РЕДАКТИРОВАТЬ С AI» и «СОХРАНИТЬ МАРШРУТ»

**Drag & Drop точек:**
- Библиотека: `@dnd-kit/core` + `@dnd-kit/sortable`
- При drop → `PATCH /trips/:id/points/reorder` с новым порядком
- Карта перерисовывается с новым порядком маркеров

---

## 7. Migration Phases

### Phase 0: Foundation (Sprint 1, неделя 1–2)

**Frontend:**
- [ ] Создать FSD директории и index.ts заглушки
- [ ] Настроить Zustand: установить, создать базовые stores
- [ ] Настроить shadcn/ui: добавить базовые компоненты (Button, Card, Input, Dialog, Tabs, Sheet)
- [ ] Настроить межсистемные провайдеры в `app/layout.tsx`
- [ ] Перенести дизайн-токены Tailwind (brand colors: sky, indigo, amber)

**Backend:**
- [ ] Расширить `schema.ts` до полной схемы (6 таблиц + 4 enum'а)
- [ ] Запустить `db:push` (Drizzle Push)
- [ ] Настроить переменные окружения (`.env`)

### Phase 1: Auth (Sprint 1, неделя 2)

- [ ] Backend: `auth` модуль (register, login, JWT)
- [ ] Backend: `users` модуль (GET /me, PATCH /me)
- [ ] Frontend: `features/auth/` (LoginModal, RegisterModal)
- [ ] Frontend: JWT хранение в `localStorage` + авто-refresh
- [ ] Frontend: Защищённые роуты (`middleware.ts`)

### Phase 2: Core Migration (Sprint 2–3)

**Порядок переноса компонентов:**

1. `widgets/header/` + `widgets/sidebar/` + `widgets/bottom-nav/` — навигация
2. `views/landing/` — LandingPage (hero, поиск, карусель, FAQ)
3. `widgets/route-map/` — Yandex Maps интеграция
4. `widgets/route-builder/` — таблица точек + управление
5. `views/planner/` — PlannerPage (конструктор + вкладка Popular)
6. `views/tour-detail/` — TourPage
7. `views/profile/` — ProfilePage
8. `views/recommendations/` — RecommendationsPage
9. `widgets/ai-chat/` — AIAssistantPage

**v2.1 — Дополнительные задачи в Phase 2:**
- [ ] Редизайн PlannerPage: layout + табы + поиск (TRI-41)
- [ ] Редизайн PlannerPage: список точек с бюджетом и датой (TRI-42)
- [ ] Редизайн PlannerPage: таб «Популярные» (TRI-43)
- [ ] Фикс desktop layout PlannerPage (TRI-46)
- [ ] Backend: Popular routes — seed + API (TRI-44)
- [ ] Frontend: `usePopularRoutes` хук (TRI-45)
- [ ] Drag & Drop сортировка точек (@dnd-kit)

### Phase 3: Real-time (Sprint 4)

- [ ] Backend: `collaboration` модуль + WebSocketGateway
- [ ] Backend: Room management, presence tracking
- [ ] Frontend: `shared/socket/` — Socket.io клиент
- [ ] Frontend: `features/route-collaborate/` — store + хуки
- [ ] Frontend: `widgets/` — LiveCursor компонент

### Phase 4: TSP Optimization (Sprint 4)

- [ ] Backend: `optimization` модуль (nearest-neighbor алгоритм)
- [ ] Backend: Сохранение результатов в `optimization_results`
- [ ] Frontend: `features/route-optimize/` — store + хук useOptimize
- [ ] Frontend: `widgets/compare-save/` — CompareSave виджет
- [ ] Frontend: Анимация перестроения polyline

### Phase 5: Dual-AI Engine (Sprint 5–6)

- [ ] Backend: `ai` модуль (Orchestrator + Semantic Filter + Scheduler)
- [ ] Backend: Интеграция OpenAI API (GPT-4o-mini)
- [ ] Backend: Интеграция YandexGPT API
- [ ] Backend: Интеграция Yandex Maps Search API для POI
- [ ] Backend: Fallback логика (см. `dual_ai_engine_prd.md`)
- [ ] Frontend: `features/ai-query/` — store + хуки
- [ ] Frontend: Обновление `widgets/ai-chat/` для работы с новым API
- [ ] Backend: Redis для кэширования AI сессий
- [ ] Backend: Admin CLI `pnpm ai:generate-popular` (v2.1)

### Phase 6: Maps Enhancement (Sprint 3–4, параллельно с P2)

- [ ] Yandex Maps loader (динамический script)
- [ ] Draggable placemarks с numbered badges
- [ ] Polyline с анимацией при изменении маршрута
- [ ] Geocoding service (shared/api/)
- [ ] Автоподбор bounds при изменении точек

---

## 8. Design System — Перенос

### 8.1 Tailwind Config

```typescript
// apps/web/tailwind.config.ts
theme: {
  extend: {
    colors: {
      brand: {
        sky:    '#0ea5e9',   // основной акцент
        indigo: '#1e1b4b',   // тёмный фон sidebar
        amber:  '#f59e0b',   // цены, теги
        light:  '#f0f9ff',   // светлый фон карточек
        bg:     '#f0f6ff',   // фон страниц
      }
    },
    borderRadius: {
      '2xl': '1rem',
      '3xl': '1.5rem',
      '4xl': '2rem',
    }
  }
}
```

### 8.2 Typography

- Font: Inter (Google Fonts или local)
- Headings: `font-black` (900)
- Body: `font-medium` (500)

---

## 9. Технические ограничения и зависимости

1. **Yandex Maps API** — требует ключ для геокодирования и карт
2. **OpenAI API** — для Orchestrator (GPT-4o-mini). В РФ требует VPN/proxy в prod
3. **YandexGPT API** — для Semantic Filter. Доступен напрямую из РФ
4. **Redis** — опционален для Phase 5 (AI кэш). Без него — повторные API вызовы
5. **Socket.io** — требует sticky sessions при горизонтальном масштабировании (Redis adapter)
6. **PostgreSQL** — минимальная версия 14 (для jsonb, uuid, enum, text[])

### 9.1 Переменные окружения

```env
# .env (корень monorepo travel-planner/)
DATABASE_URL=postgresql://user:pass@localhost:5432/tripdb
JWT_SECRET=supersecret
JWT_EXPIRES_IN=7d
FRONTEND_URL=http://localhost:3000
OPENAI_API_KEY=sk-...
YANDEX_GPT_API_KEY=...
YANDEX_MAPS_API_KEY=...
YANDEX_FOLDER_ID=...
REDIS_URL=redis://localhost:6379
NEXT_PUBLIC_API_URL=http://localhost:3001/api
NEXT_PUBLIC_YANDEX_MAPS_KEY=...
```

---

## 10. Верификация (Definition of Done по фазам)

| Phase | Критерий завершения |
|-------|-------------------|
| P0 | FSD структура создана, dev сервер запускается без ошибок |
| P1 | Register → Login → GET /users/me работает. JWT в заголовках |
| P2 | Все 6 страниц отображаются, навигация работает, данные из API. **v2.1:** PlannerPage с двумя табами, популярные маршруты загружаются из API, DnD работает |
| P3 | 2 вкладки браузера видят изменения друг друга в реальном времени |
| P4 | TSP оптимизация изменяет порядок точек + виджет показывает экономию |
| P5 | AI запрос возвращает RoutePlan с точками на карте. Admin CLI генерирует популярные маршруты |
| P6 | Polyline анимируется при изменении порядка точек |

---

## 11. Task Decomposition (TRI-01 — TRI-46)

### 11.1 Backend (TRI-01 — TRI-20, TRI-44)

| TRI | Название | Приоритет | Branch |
|-----|---------|-----------|--------|
| 01 | Подключение Drizzle ORM | P0 | `feature/TRI-01-backend-drizzle-setup` |
| 02 | Создание схем базы данных | P0 | `feature/TRI-02-backend-db-schemas` |
| 03 | transport_mode и глобальные настройки | P0 | `feature/TRI-03-backend-global-config` |
| 04 | Настройка JWT и Passport.js | P1 | `feature/TRI-04-backend-auth-jwt` |
| 05 | Эндпоинты авторизации | P1 | `feature/TRI-05-backend-auth-endpoints` |
| 06 | Хэширование пароля (bcrypt) | P1 | `feature/TRI-06-backend-auth-bcrypt` |
| 07 | CRUD /trips | P1 | `feature/TRI-07-backend-trips-crud` |
| 08 | CRUD /trips/:id/points | P1 | `feature/TRI-08-backend-points-crud` |
| 09 | Алгоритм Nearest-Neighbor | P2 | `feature/TRI-09-backend-tsp-algo` |
| 10 | Расчёт веса W | P2 | `feature/TRI-10-backend-tsp-weights` |
| 11 | Расчёт сэкономленных ресурсов | P2 | `feature/TRI-11-backend-tsp-savings` |
| 12 | Настройка Socket.io Gateway | P3 | `feature/TRI-12-backend-ws-setup` |
| 13 | Логика комнат trip_{id} | P3 | `feature/TRI-13-backend-ws-rooms` |
| 14 | Рассылка событий маршрута | P3 | `feature/TRI-14-backend-ws-events` |
| 15 | STEP 1: Orchestrator | P4 | `feature/TRI-15-backend-ai-orchestrator` |
| 16 | STEP 2: YandexFetch + Admin CLI | P4 | `feature/TRI-16-backend-ai-yandex` |
| 17 | STEP 3: SemanticFilter | P4 | `feature/TRI-17-backend-ai-filter` |
| 18 | STEP 4: Scheduler | P4 | `feature/TRI-18-backend-ai-scheduler` |
| 19 | Redis кэширование | P5 | `feature/TRI-19-backend-redis-cache` |
| 20 | Presence tracking | P5 | `feature/TRI-20-backend-presence` |
| 44 | Popular routes: seed + API | P1 | `feature/TRI-44-backend-popular-routes-seed` |

### 11.2 Frontend (TRI-21 — TRI-43, TRI-45, TRI-46)

| TRI | Название | Приоритет | Branch |
|-----|---------|-----------|--------|
| 21 | shadcn/ui + Tailwind config | P0 | `feature/TRI-21-front-shadcn` |
| 22 | shared/ layer (api, config, lib) | P0 | `feature/TRI-22-front-shared` |
| 23 | Providers (Zustand, QueryClient) | P0 | `feature/TRI-23-front-providers` |
| 24 | Layout: Header, Sidebar, BottomNav | P0 | `feature/TRI-24-front-layout` |
| 25 | Zustand stores (user, trip) | P0 | `feature/TRI-25-front-zustand` |
| 26 | LandingPage | P1 | `feature/TRI-26-front-landing` |
| 27 | Auth Модалки | P1 | `feature/TRI-27-front-auth-modals` |
| 28 | UI Списка точек | P2 | `feature/TRI-28-front-route-list` |
| 29 | Интеграция Яндекс Карт | P2 | `feature/TRI-29-front-route-map` |
| 30 | CRUD точек в UI | P2 | `feature/TRI-30-front-route-crud` |
| 31 | Drag & Drop (@dnd-kit) | P2 | `feature/TRI-31-front-route-dnd` |
| 32 | Chat интерфейс | P3 | `feature/TRI-32-front-ai-chat-ui` |
| 33 | Интеграция AI API | P3 | `feature/TRI-33-front-ai-integration` |
| 34 | UI Виджета оптимизации | P3 | `feature/TRI-34-front-opt-widget` |
| 35 | Интеграция Оптимизации | P3 | `feature/TRI-35-front-opt-integration` |
| 36 | Подключение Socket.io | P4 | `feature/TRI-36-front-ws-client` |
| 37 | Синхронизация Zustand (WS) | P4 | `feature/TRI-37-front-ws-sync` |
| 38 | Live presence UI | P5 | `feature/TRI-38-front-presence-ui` |
| 39 | Анимации (Polyline) | P5 | `feature/TRI-39-front-map-animations` |
| 40 | Мобильный интерфейс (Bottom Sheet) | P5 | `feature/TRI-40-front-mobile-sheet` |
| 41 | Редизайн PlannerPage: layout + табы | P2 | `feature/TRI-41-front-planner-redesign-layout` |
| 42 | Редизайн PlannerPage: список точек | P2 | `feature/TRI-42-front-planner-points-list` |
| 43 | Редизайн PlannerPage: таб «Популярные» | P2 | `feature/TRI-43-front-planner-popular-tab` |
| 45 | usePopularRoutes: API хук | P2 | `feature/TRI-45-front-popular-routes-api` |
| 46 | Фикс desktop layout PlannerPage | P2 | `feature/TRI-46-front-planner-layout-fix` |

### 11.3 Зависимости между задачами

```
TRI-01 → TRI-02 → TRI-03 → TRI-04 → TRI-05 → TRI-06 (auth готов)
TRI-06 → TRI-07 → TRI-08 (trips и points API готовы)
TRI-08 → TRI-09 → TRI-10 → TRI-11 (TSP готов)
TRI-03 → TRI-12 → TRI-13 → TRI-14 (WebSockets готовы)
TRI-06 → TRI-15 → TRI-16 → TRI-17 → TRI-18 (AI pipeline готов)
TRI-16 → TRI-19 (Redis cache в YandexFetch)
TRI-13 → TRI-20 (Presence достроена)

TRI-21 [DONE] → TRI-22 → TRI-23 (shared layer готов)
TRI-23 → TRI-24 → TRI-25 (layout + stores готовы)
TRI-25 → TRI-26 → TRI-27 (auth flow готов)
TRI-27 → TRI-28 → TRI-29 → TRI-30 → TRI-31 (planner готов)
TRI-06 + TRI-25 → TRI-27 (логин требует backend auth)
TRI-08 + TRI-30 → TRI-31 (dnd reorder требует backend reorder)
TRI-18 + TRI-23 → TRI-32 → TRI-33 (AI чат требует backend AI)
TRI-11 + TRI-25 → TRI-34 → TRI-35 (оптимизация требует backend TSP)
TRI-14 + TRI-36 → TRI-37 (WS sync требует backend WS events)
TRI-37 → TRI-38 (presence UI требует WS sync)

# v2.1 — новые зависимости
TRI-30 → TRI-41 → TRI-42 (редизайн после базового CRUD)
TRI-41 → TRI-43 (таб Popular после layout)
TRI-44 → TRI-45 (frontend hook после backend API)
TRI-24 → TRI-46 (layout fix после базового layout)
```

---

## 12. Справочные документы

| Документ | Описание |
|---------|---------|
| `dual_ai_engine_prd.md` v2.0 | Детальная спецификация AI-пайплайна: промпты, типы данных, failure handling, KPI |
| `decomposition.json` | Полная декомпозиция задач (YouGile board) |
| `dev-guide.md` v2.0 | Внутренний технический гайд с кодом для каждой TRI-задачи |
