# PRD: Travel Planner — Project Migration & Feature Expansion
# Version: 2.0 | Status: MVP | Date: 2026-03-03
# Owner: Engineering Team

---

## 1. Overview

### 1.1 Цель документа

Настоящий документ описывает план переноса функционала прототипа `travel-planner-design`
в production-готовый monorepo `travel-planner`, а также расширение продукта новыми
инженерными возможностями: real-time коллаборация, алгоритмическая оптимизация маршрута,
двухуровневый AI-движок планирования.

### 1.2 Tech Stack

| Уровень | Технология |
|---------|-----------|
| Monorepo | Turborepo 2.x + pnpm workspaces |
| Frontend | Next.js 16 (App Router), React 19, TypeScript 5.9 |
| UI | Tailwind CSS 4, shadcn/ui, Lucide React |
| State | Zustand |
| Maps | Yandex Maps API 2.1 |
| Backend | NestJS 11, TypeScript |
| ORM | Drizzle ORM 0.45+ |
| Database | PostgreSQL 16 |
| Real-time | Socket.io (NestJS WebSocketGateway) |
| Auth | JWT + Passport.js |
| AI | GPT-4o-mini (Orchestrator + Scheduler) + YandexGPT (Semantic Filter) |
| Cache | Redis (POI cache TTL 24h + AI сессии) |

---

## 2. Прототип — Инвентаризация функционала

Источник: `travel-planner-design` (vanilla React + CDN + Babel).
Все перечисленные фичи подлежат переносу в production-стек.

### 2.1 Страницы и компоненты

| Компонент | Функционал | Приоритет | Целевой путь (Next.js) |
|-----------|-----------|-----------|----------------------|
| `LandingPage.js` | Hero video, AI поиск, ручная форма поиска, карусель маршрутов, FAQ | **P0** | `/app/(main)/page.tsx` |
| `PlannerPage.js` | Конструктор маршрута, Yandex геокодирование, интерактивная карта, таблица точек, бюджет | **P0** | `/app/(main)/planner/page.tsx` |
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
| Hardcoded predefined routes (5 маршрутов) | `trips` table с флагом `is_predefined` |
| Route points (coords, budget, date) | `route_points` table |
| User saved routes | `trips` table с `owner_id` |
| User profile | `users` table |

---

## 3. FSD Architecture — Frontend

Принята Feature-Sliced Design (FSD) архитектура для `apps/web/src/`.
Импорты только сверху вниз по слоям: `app → views → widgets → features → entities → shared`.
(Слой назван `views/` вместо `views/` чтобы Next.js не запустил Pages Router)

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
│   │   ├── ui/PlannerPage.tsx
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
│   │   ├── ui/Sidebar.tsx
│   │   └── index.ts
│   ├── bottom-nav/
│   │   ├── ui/BottomNav.tsx
│   │   └── index.ts
│   ├── route-map/                    # Yandex Maps интеграция
│   │   ├── ui/RouteMap.tsx
│   │   ├── lib/yandex-maps.ts        # Инициализация API
│   │   └── index.ts
│   ├── route-builder/                # Таблица точек + управление бюджетом
│   │   ├── ui/RouteBuilder.tsx
│   │   ├── ui/PointRow.tsx
│   │   └── index.ts
│   ├── ai-chat/                      # Чат-интерфейс
│   │   ├── ui/AiChat.tsx
│   │   ├── ui/MessageBubble.tsx
│   │   └── index.ts
│   └── compare-save/                 # "Compare & Save" виджет (TSP до/после)
│       ├── ui/CompareSave.tsx
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
│   │   ├── ui/CollaboratorsList.tsx
│   │   ├── ui/LiveCursor.tsx
│   │   └── index.ts
│   ├── ai-query/                     # Запрос к Dual-AI Engine
│   │   ├── model/ai-query.store.ts
│   │   └── index.ts
│   ├── poi-search/                   # Геокодирование через Yandex
│   │   ├── model/poi-search.store.ts
│   │   ├── ui/SearchDropdown.tsx
│   │   └── index.ts
│   └── route-save/
│       ├── model/route-save.store.ts
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
│   │   ├── ui/TripCard.tsx
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
│   └── schema.ts                     # PostgreSQL схема (см. раздел 5)
│
├── auth/                             # JWT + Passport
│   ├── auth.module.ts
│   ├── auth.controller.ts            # POST /auth/login, POST /auth/register
│   ├── auth.service.ts               # bcrypt, JWT sign/verify
│   ├── guards/
│   │   └── jwt-auth.guard.ts
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
│   ├── trips.controller.ts           # CRUD /trips, GET /trips/:id
│   └── trips.service.ts
│
├── route-points/
│   ├── route-points.module.ts
│   ├── route-points.controller.ts    # CRUD /trips/:id/points
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
└── ai/                               # Dual-AI Engine (см. dual_ai_engine_prd.md v2.0)
    ├── ai.module.ts
    ├── ai.controller.ts              # POST /ai/plan — оркестрирует пайплайн
    ├── pipeline/
    │   ├── orchestrator.service.ts   # STEP 1: GPT-4o-mini (parse intent)
    │   ├── yandex-fetch.service.ts   # STEP 2: NestJS HTTP → Yandex Maps API
    │   ├── semantic-filter.service.ts # STEP 3: YandexGPT (выбор 5–10 POI)
    │   └── scheduler.service.ts      # STEP 4: GPT-4o-mini (тайминги)
    ├── dto/
    └── types/
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
| GET | `/trips/:id/points` | JWT | Точки маршрута |
| POST | `/trips/:id/points` | JWT | Добавление точки |
| PATCH | `/trips/:id/points/:pid` | JWT | Обновление точки |
| DELETE | `/trips/:id/points/:pid` | JWT | Удаление точки |
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

---

## 5. Database Schema (Drizzle ORM + PostgreSQL)

```typescript
// apps/api/src/db/schema.ts

import { pgTable, uuid, varchar, text, integer, boolean,
         timestamp, jsonb, pgEnum } from 'drizzle-orm/pg-core';

// ENUM: роли коллаборации
export const collaboratorRoleEnum = pgEnum('collaborator_role',
  ['owner', 'editor', 'viewer']);

// ENUM: категории POI
export const poiCategoryEnum = pgEnum('poi_category',
  ['museum', 'park', 'restaurant', 'cafe', 'attraction', 'shopping', 'entertainment']);

// ENUM: режим транспорта для TSP оптимизации
export const transportModeEnum = pgEnum('transport_mode',
  ['walk', 'transit', 'auto']);
// walk    — пешком: только дистанция, стоимость = 0
// transit — общественный транспорт: дистанция * тариф
// auto    — автомобиль: W = (Distance * Consumption / 100 * FuelPrice) + TollFees

// ── USERS ──────────────────────────────────────────────────────────────────
export const users = pgTable('users', {
  id:           uuid('id').primaryKey().defaultRandom(),
  email:        varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name:         varchar('name', { length: 100 }).notNull(),
  photo:        text('photo'),                         // URL или base64
  createdAt:    timestamp('created_at').defaultNow().notNull(),
});

// ── TRIPS ──────────────────────────────────────────────────────────────────
export const trips = pgTable('trips', {
  id:           uuid('id').primaryKey().defaultRandom(),
  title:        varchar('title', { length: 255 }).notNull(),
  description:  text('description'),
  budget:       integer('budget'),                     // рублей
  ownerId:      uuid('owner_id').references(() => users.id).notNull(),
  isActive:     boolean('is_active').default(false),
  isPredefined: boolean('is_predefined').default(false), // системные маршруты
  startDate:    timestamp('start_date'),
  endDate:      timestamp('end_date'),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at').defaultNow().notNull(),
});

// ── TRIP COLLABORATORS ─────────────────────────────────────────────────────
export const tripCollaborators = pgTable('trip_collaborators', {
  tripId:   uuid('trip_id').references(() => trips.id).notNull(),
  userId:   uuid('user_id').references(() => users.id).notNull(),
  role:     collaboratorRoleEnum('role').default('viewer').notNull(),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
});

// ── ROUTE POINTS ───────────────────────────────────────────────────────────
export const routePoints = pgTable('route_points', {
  id:        uuid('id').primaryKey().defaultRandom(),
  tripId:    uuid('trip_id').references(() => trips.id).notNull(),
  title:     varchar('title', { length: 255 }).notNull(),
  lat:       text('lat').notNull(),                    // хранить как text для точности
  lon:       text('lon').notNull(),
  budget:    integer('budget'),
  visitDate: timestamp('visit_date'),
  imageUrl:  text('image_url'),
  order:     integer('order').notNull().default(0),    // порядок в маршруте
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── OPTIMIZATION RESULTS ───────────────────────────────────────────────────
export const optimizationResults = pgTable('optimization_results', {
  id:             uuid('id').primaryKey().defaultRandom(),
  tripId:         uuid('trip_id').references(() => trips.id).notNull(),
  originalOrder:  jsonb('original_order').notNull(),   // string[] (point UUIDs)
  optimizedOrder: jsonb('optimized_order').notNull(),  // string[] (point UUIDs)
  savedKm:        integer('saved_km'),
  savedRub:       integer('saved_rub'),
  savedHours:     integer('saved_hours'),              // минуты
  transportMode:  transportModeEnum('transport_mode').notNull().default('auto'),
  // Формула веса ребра (только для transportMode='auto'):
  //   W = (Distance * Consumption / 100 * FuelPrice) + TollFees
  // Для 'walk': W = Distance (стоимость = 0)
  // Для 'transit': W = Distance * transitFarePerKm
  params:         jsonb('params'),
  // params schema:
  // { consumption?: number, fuelPrice?: number, tollFees?: number,
  //   transitFarePerKm?: number }
  // Поля consumption/fuelPrice/tollFees игнорируются при transportMode != 'auto'
  createdAt:      timestamp('created_at').defaultNow().notNull(),
});

// ── AI SESSIONS ────────────────────────────────────────────────────────────
export const aiSessions = pgTable('ai_sessions', {
  id:        uuid('id').primaryKey().defaultRandom(),
  tripId:    uuid('trip_id').references(() => trips.id),
  userId:    uuid('user_id').references(() => users.id).notNull(),
  messages:  jsonb('messages').notNull().default('[]'), // Message[]
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
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
- Клиент отправляет `cursor:move` с viewport-нормализованными координатами (0-1)
- Сервер ретранслирует всем участникам комнаты
- Каждый пользователь получает уникальный цвет (детерминированный от user_id)
- Индикатор «Имя пользователя редактирует...» при активных cursor:move событиях

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

**Анимации Polyline:** При изменении порядка точек polyline перерисовывается
с CSS transition через `requestAnimationFrame`.

---

## 7. Migration Phases

### Phase 0: Foundation (Sprint 1, неделя 1-2)

**Frontend:**
- [ ] Создать FSD директории и index.ts заглушки
- [ ] Настроить Zustand: установить, создать базовые stores
- [ ] Настроить shadcn/ui: добавить базовые компоненты (Button, Card, Input, Dialog)
- [ ] Настроить межсистемные провайдеры в `app/layout.tsx`
- [ ] Перенести дизайн-токены Tailwind (brand colors: sky, indigo, amber)

**Backend:**
- [ ] Расширить `schema.ts` до полной схемы (все 6 таблиц)
- [ ] Запустить `db:push` (Drizzle Push)
- [ ] Настроить переменные окружения (`.env`)

### Phase 1: Auth (Sprint 1, неделя 2)

- [ ] Backend: `auth` модуль (register, login, JWT)
- [ ] Backend: `users` модуль (GET /me, PATCH /me)
- [ ] Frontend: `features/auth/` (LoginModal, RegisterModal)
- [ ] Frontend: JWT хранение в `localStorage` + авто-refresh
- [ ] Frontend: Защищённые роуты (middleware.ts)

### Phase 2: Core Migration (Sprint 2-3)

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

### Phase 5: Dual-AI Engine (Sprint 5-6)

- [ ] Backend: `ai` модуль (Orchestrator + Data Provider)
- [ ] Backend: Интеграция OpenAI API (GPT-4o-mini)
- [ ] Backend: Интеграция YandexGPT API
- [ ] Backend: Интеграция Yandex Search API для POI
- [ ] Backend: Fallback логика (см. dual_ai_engine_prd.md)
- [ ] Frontend: `features/ai-query/` — store + хуки
- [ ] Frontend: Обновление `widgets/ai-chat/` для работы с новым API
- [ ] Backend: Redis для кэширования AI сессий

### Phase 6: Maps Enhancement (Sprint 3-4, параллельно с P2)

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
3. **YandexGPT API** — для Data Provider. Доступен напрямую из РФ
4. **Redis** — опционален для Phase 5 (AI кэш). Без него — повторные API вызовы
5. **Socket.io** — требует sticky sessions при горизонтальном масштабировании (Redis adapter)
6. **PostgreSQL** — минимальная версия 14 (для jsonb, uuid, enum)

---

## 10. Верификация (Definition of Done по фазам)

| Phase | Критерий завершения |
|-------|-------------------|
| P0 | FSD структура создана, dev сервер запускается без ошибок |
| P1 | Register → Login → GET /users/me работает. JWT в заголовках |
| P2 | Все 6 страниц отображаются, навигация работает, данные из API |
| P3 | 2 вкладки браузера видят изменения друг друга в реальном времени |
| P4 | TSP оптимизация изменяет порядок точек + виджет показывает экономию |
| P5 | AI запрос возвращает RoutePlan с точками на карте |
| P6 | Polyline анимируется при изменении порядка точек |
