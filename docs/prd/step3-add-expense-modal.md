# Шаг 3 — AddExpenseModal + финальная проводка

**Дата:** 2026-03-17
**Статус:** ✅ Завершён

## Что сделано

### `views/planner/ui/AddExpenseModal.tsx` (новый)
Модальное окно добавления расхода (визуальные заглушки без бизнес-логики).

**Структура сверху вниз:**
1. **Шапка**: "Новый расход" по центру, кнопка X справа
2. **Ряд фильтров** (3 кнопки-пилюли): Другое (Grid2x2), 17.03.2026 (Calendar), Место (MapPin)
3. **Ввод суммы**: `bg-slate-50 rounded-2xl`, знак `$` + USD/▾ слева, большой input `text-4xl font-semibold text-slate-300`
4. **Название**: border-b, иконка Tag, placeholder "Название расхода..."
5. **Статус оплаты**: border-y, текст "Не оплачено" / "Оплачено" (`text-emerald-500`), toggle switch
6. **Сплит**: строка "Оплатил(а) Вы" с аватаркой + ChevronRight; строка "Everyone 1x" с контролами `- 1x +`
7. **Кнопка сохранения**: `bg-amber-400 hover:bg-amber-500 text-white rounded-xl py-4 w-full`

**Стейт**: `isPaid` (boolean) — только для переключения статуса; открытие/закрытие через `useBudgetStore`.

### `views/planner/ui/PlannerPage.tsx` (финальная версия)
- Оригинальная логика (`usePlanner`, `useCollaborationSocket`, все модалы) — **не изменена**
- Добавлен `currentView` из `searchParams.get('view')`, дефолт = `'budget'`
- JSX для `view=route` — **точная копия оригинала** без изменений
- `<AddExpenseModal />` рендерится всегда в дереве (читает состояние из стора)

## Архитектура взаимодействия
```
Sidebar кнопка "+Добавить расход"
  → useBudgetStore.openExpenseModal()
    → isExpenseModalOpen = true
      → AddExpenseModal (всегда в дереве PlannerPage) показывает Dialog
```

## Итого по всем шагам
| Файл | Статус |
|---|---|
| `widgets/sidebar/ui/Sidebar.tsx` | ✅ обновлён |
| `views/planner/model/use-budget-store.ts` | ✅ создан |
| `views/planner/ui/PlannerPage.tsx` | ✅ обновлён (минимальные изменения) |
| `views/planner/ui/BudgetDashboard.tsx` | ✅ создан |
| `views/planner/ui/AddExpenseModal.tsx` | ✅ создан |
| `docs/prd/step1-planner-subnav.md` | ✅ создан |
| `docs/prd/step2-budget-dashboard.md` | ✅ создан |
| `docs/prd/step3-add-expense-modal.md` | ✅ создан |
