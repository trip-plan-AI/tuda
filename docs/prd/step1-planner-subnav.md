# Шаг 1 — Планнер: суб-навигация в сайдбаре

**Дата:** 2026-03-17
**Статус:** ✅ Завершён

## Что сделано

### 1. `views/planner/model/use-budget-store.ts` (новый)
Zustand-стор для управления состоянием модалки добавления расхода:
- `isExpenseModalOpen: boolean`
- `openExpenseModal()` / `closeExpenseModal()`

### 2. `widgets/sidebar/ui/Sidebar.tsx` (обновлён)
- При попадании на `/planner` сайдбар расширяется с `w-20` до `w-52` (плавная анимация)
- Иконки получают текстовые подписи в expanded-режиме
- Под кнопкой "Маршруты" появляется sub-nav из 3 пунктов:
  - **Маршрут** (иконка `Map`)
  - **Бюджет** (иконка `Wallet`) — активен по умолчанию
  - **Todo** (иконка `CheckSquare`)
- Переключение через URL-параметр `?view=route|budget|todo`
- Активный пункт: `bg-slate-900 text-white`; неактивные: `text-slate-500`
- Sub-nav ограничен сверху и снизу `<hr className="border-slate-100 my-2" />`
- Пункты сдвинуты вправо на `pl-4` для визуальной иерархии
- **Bottom section** (видим только при `view=budget`):
  - Кнопка "+ Добавить расход" (`bg-amber-400/90`, открывает `useBudgetStore.openExpenseModal`)
  - Блок-подсказка "Планируй вместе" (`bg-slate-50`)

### 3. `views/planner/ui/PlannerPage.tsx` (обновлён)
- Читает `searchParams.get('view')`, дефолт = `'budget'`
- `renderContent()` возвращает:
  - `route` → существующий конструктор маршрута (SegmentedControl + ConstructorTab / PopularRoutes)
  - `budget` → заглушка `<div>Бюджет загружается...</div>`
  - `todo` → заглушка `<div>Todo загружается...</div>`

## URL-схема
```
/planner              → view=budget (default)
/planner?view=route   → конструктор маршрута
/planner?view=budget  → бюджет
/planner?view=todo    → todo
```

## Следующий шаг
→ Шаг 2: создание `BudgetDashboard.tsx` — полноценный компонент бюджета с donut chart (recharts).
