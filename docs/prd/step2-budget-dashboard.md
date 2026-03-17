# Шаг 2 — BudgetDashboard: UI компонент бюджета

**Дата:** 2026-03-17
**Статус:** ✅ Завершён

## Что сделано

### `views/planner/ui/BudgetDashboard.tsx` (новый)
Двухколоночный layout, полностью на mock-данных.

#### Левая колонка (flex-1, p-8)
- **Шапка**: заголовок "Бюджет" + "Париж, Франция", toggle-пилюли (Все / Ожидают / Оплачено)
- **Summary cards** (grid-cols-3, bg-white rounded-2xl shadow-sm):
  - ВСЕГО — `text-slate-900`
  - ОПЛАЧЕНО — `text-emerald-500`
  - ОЖИДАЕТ — `text-amber-500`
- **AI Рекомендации**: `bg-amber-50/50 border border-amber-100 rounded-2xl`, иконка ✨, 3 mock-совета
- **Empty state**: серый кружок с `MoreHorizontal`, текст "Нет расходов"

#### Правая колонка (w-80, bg-white, border-l)
- Заголовок "ОБЩИЙ БЮДЖЕТ" (xs uppercase tracking-wider)
- **Donut chart** (recharts `PieChart + Pie`): один серый сегмент `fill="#f1f5f9"`, в центре "$0,00 / всего"
- **Легенда**: две колонки — Оплачено (зелёная точка) и Ожидает (жёлтая точка)
- **По категориям** (5 пунктов):
  | Категория | Иконка | bg / color |
  |---|---|---|
  | Жильё | `Bed` | `bg-emerald-50 text-emerald-500` |
  | Транспорт | `Car` | `bg-rose-50 text-rose-500` |
  | Развлечения | `Eye` | `bg-amber-50 text-amber-500` |
  | Еда и напитки | `Utensils` | `bg-purple-50 text-purple-500` |
  | Другое | `MoreHorizontal` | `bg-slate-100 text-slate-500` |

### `views/planner/ui/PlannerPage.tsx` (обновлён)
Заглушка `view=budget` заменена на `<BudgetDashboard />`.

## Зависимости
- `recharts` — установлен на шаге 1

## Следующий шаг
→ Шаг 3: `AddExpenseModal.tsx` + подключение к кнопке "Добавить расход" из сайдбара.
