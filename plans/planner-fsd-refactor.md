# Plan: FSD Refactoring of /planner Page

## Context
`views/planner/ui/PlannerPage.tsx` — 3143 строки. Вся логика, утилиты и рендер в одном файле.
Цель: расформировать по FSD без изменения логики.

---

## Target File Structure

```
shared/lib/
  route-utils.ts              [NEW] — GeoSuggestion, filterUniqueSuggestions, hasTime,
                                       formatDuration, formatDistance

widgets/
  planner-point-row/
    index.ts                  [NEW] — barrel
    ui/PlannerPointRow.tsx    [NEW] — SortablePointRow (переименован), PointRowProps

  popular-routes/
    index.ts                  [NEW] — barrel
    ui/PopularRoutes.tsx      [NEW] — самодостаточная вкладка «Популярные»
                                       (predefinedTrips, popularSearch, selectedFilter, FILTERS)

views/planner/
  index.ts                    [unchanged]
  lib/
    utils.ts                  [NEW] — isSameDay, computeDateCascade, UUID_RE
  model/
    use-planner.ts            [NEW] — весь state + handlers → хук usePlanner()
  ui/
    PlannerPage.tsx           [MODIFIED] — тонкая обёртка (~80 строк)
    ConstructorTab.tsx        [NEW] — JSX вкладки «Конструктор»
```

---

## Что куда переносится

### 1. `shared/lib/route-utils.ts`
Чистые функции без React/store, нужны и в виджете и во вью:
- `interface GeoSuggestion { displayName: string; uri?: string }`
- `filterUniqueSuggestions(results: any[]): GeoSuggestion[]` (строки 83-125)
- `hasTime(d?: string | null): boolean` (строки 165-168)
- `formatDuration(seconds: number): string` (строки 142-153)
- `formatDistance(meters: number): string` (строки 155-158)

### 2. `views/planner/lib/utils.ts`
Утилиты, нужные только внутри views/planner:
- `isSameDay(d1, d2): boolean` (строки 127-136)
- `computeDateCascade(points, legs, fromIndex, updatedPatch?)` (строки 170-216)
- `const UUID_RE = /^[0-9a-f]{8}-...$/i` (строка 140)

### 3. `widgets/planner-point-row/ui/PlannerPointRow.tsx`
Компонент `SortablePointRow` (строки 218-878), переименованный в `PlannerPointRow`.
- Интерфейс `PointRowProps` переезжает сюда
- Импорты: `@/shared/lib/route-utils`, `@/entities/route-point`, `@/shared/ui`, `@dnd-kit/*`
- Пропсы без изменений (`onUpdate`, `onRemove`, `onFocusPoint`, `leg`, etc.)

### 4. `widgets/popular-routes/ui/PopularRoutes.tsx`
Самодостаточная вкладка «Популярные» (строки 2977-3060).
Локальный state (остаётся внутри компонента):
- `predefinedTrips` — загружается один раз через `tripsApi.getPredefined()`
- `popularSearch`, `selectedFilter`
- `FILTERS`/`Filter` — определить прямо здесь (не переносить в shared)
Пропсы: **нет** (полностью автономный виджет)
Импорты: `@/entities/trip`, `@/shared/ui/chip`, `next/link`, `lucide-react`

### 5. `views/planner/model/use-planner.ts`
Хук `usePlanner()` — весь state и handlers из PlannerPage.

**State (useState):** `activeTab`, `searchInput`, `isSearching`, `showDropdown`, `suggestions`,
`isActiveRoute`, `focusCoords`, `showBudgetWarning`, `editingPointId`, `editingTitle`,
`showClearConfirm`, `modal`, `isAddPointMode`, `isOptimizationExpanded`, `isDailyBudgetsExpanded`,
`showPlannerConflictModal`, `pendingApplyTripId`, `pendingDraftMessageId`, `conflictType`,
`visibleCount`, `routeInfo`, `isRouteLoading`, `affectedSegments`, `activeId`,
`isOptimizing`, `optimisticProfile`, `selectedDays`

**Refs:** `searchContainerRef`, `searchDebounceRef`, `justMigratedRef`, `handledApplyTripIdRef`,
`userLocationRef`, `prevLegsCountRef`, `prevLegsDurationsRef`, `addPointStartCountRef`,
`mapClickDebounceRef`, `loadedTripIdsRef`, `pointRefs`, `pointsContainerRef`

**Memos:** `isAlreadyOptimal`, `isMixedRoute/mixedModes`, `routeProfile`, `totalBudget`,
`dailyBudgets`, `plannedBudget`, `budgetOverrun`, `isBudgetExceeded`

**Handlers:** `handleProfileChange`, `toggleDayFilter`, `handleAddPointModeChange`,
`resolveCoords`, `resolveMapCoords`, `handlePointClick`, `handlePointUpdate`,
`handleDragStart`, `handleDragCancel`, `handleDragEnd`, `handlePointDragEnd`,
`ensureTripId`, `geocode`, `handleSearchChange`, `handleAddByQuery`, `addPoint_`,
`handleConfirmClear`, `handleEditWithAi`, `handleSelectSuggestion`, `handleMapClick`,
`handleUpdatePlannedBudget`, `clearApplyTripParams`, `finalizeApplyFlow`,
`applyIncomingTrip`, `handleConfirmPlannerReplace`

**ВАЖНО:** Инлайновые onClick кнопок ОПТИМИЗИРОВАТЬ и СОХРАНИТЬ вынести в именованные функции
`handleOptimize()` и `handleSave()` внутри этого хука.

Возвращает: всё перечисленное выше (state, setters, handlers, refs, computed values)

### 6. `views/planner/ui/ConstructorTab.tsx`
JSX вкладки «Конструктор» (строки 2012-2975).
Props: принимает весь return value `usePlanner()` через typed `ConstructorTabProps`.
Секции (порядок не меняется):
1. Budget warning toast
2. Строка поиска с выпадающим списком
3. Переключатель транспортного профиля (mixed route или 4 кнопки)
4. Route info card (duration + distance)
5. 4 кнопки действий (НОВЫЙ / РЕДАКТИРОВАТЬ С AI / ОПТИМИЗИРОВАТЬ / СОХРАНИТЬ)
6. Панель результатов оптимизации
7. Секция бюджета + DnD-список точек с дневными заголовками (использует `PlannerPointRow`)

Импорты: `PlannerPointRow` from `@/widgets/planner-point-row`,
`formatDuration`/`formatDistance` from `@/shared/lib/route-utils`

### 7. `views/planner/ui/PlannerPage.tsx` (MODIFIED → ~80 строк)
Остаётся только:
- Вызов `usePlanner()`
- `useCollaborationSocket` (или перенести в usePlanner — лучше сюда)
- Заголовок + `CollaboratorsAvatarGroup`
- `SegmentedControl` (переключатель вкладок)
- `{activeTab === 'my' ? <ConstructorTab {...plannerProps} /> : <PopularRoutes />}`
- 3 модалки: `<Dialog>` (showClearConfirm), `<LoginModal>`, `<RegisterModal>`, `<PlannerConflictModal>`

---

## Layer Compliance
```
views/planner/ui/PlannerPage.tsx
  → views/planner/model/use-planner.ts    ✓ (same slice)
  → views/planner/ui/ConstructorTab.tsx   ✓ (same slice)
  → widgets/popular-routes               ✓ (views → widgets)
  → widgets/planner-conflict-modal       ✓ (views → widgets)
  → features/auth                        ✓ (views → features)
  → features/route-collaborate           ✓ (views → features)

views/planner/model/use-planner.ts
  → entities/trip, entities/route-point  ✓
  → features/route-create, ai-query, auth, route-collaborate, persistent-map ✓
  → widgets/planner-conflict-modal (type only) ✓
  → shared/lib/route-utils, shared/lib/utils.ts ✓

widgets/planner-point-row
  → entities/route-point                 ✓ (widgets → entities)
  → shared/lib/route-utils               ✓ (widgets → shared)
  → shared/ui, shared/config/env         ✓

widgets/popular-routes
  → entities/trip                        ✓ (widgets → entities)
  → shared/ui/chip                       ✓
```

---

## Implementation Sequence

1. `shared/lib/route-utils.ts` — базис, от него зависят все остальные
2. `views/planner/lib/utils.ts` — planner-specific утилиты
3. `widgets/planner-point-row/ui/PlannerPointRow.tsx` + `index.ts`
4. `widgets/popular-routes/ui/PopularRoutes.tsx` + `index.ts`
5. `views/planner/model/use-planner.ts` (вынести из PlannerPage всё кроме рендера)
6. `views/planner/ui/ConstructorTab.tsx` (вынести JSX вкладки my)
7. `views/planner/ui/PlannerPage.tsx` (перезаписать как тонкую обёртку)

После каждого шага: `pnpm tsc --noEmit` для проверки

## Verification
- `pnpm tsc --noEmit` в apps/web — 0 ошибок
- Dev server: вкладка «Конструктор» (добавление точек, DnD, оптимизация, сохранение)
- Dev server: вкладка «Популярные» (фильтры, поиск, карточки туров)
- Конфликтный flow (apply trip через ?applyTripId=...) — модалка показывается
- Кнопка «Редактировать с AI» — переход на /ai-assistant
