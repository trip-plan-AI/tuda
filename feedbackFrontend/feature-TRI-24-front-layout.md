# TRI-24 — UI Навигации

## Описание задачи
Верстка навигационных виджетов: Sidebar (desktop), Header, BottomNav (mobile) и основного layout для авторизованной зоны.

## Файлы создать
- `apps/web/src/widgets/header/ui/Header.tsx`
- `apps/web/src/widgets/sidebar/ui/Sidebar.tsx`
- `apps/web/src/widgets/bottom-nav/ui/BottomNav.tsx`
- `apps/web/src/app/(main)/layout.tsx`
- Обновить index.ts для каждого виджета

## Чек-лист
- [x] `widgets/sidebar/ui/Sidebar.tsx` — fixed left, bg-brand-indigo, active state по URL
- [x] `widgets/header/ui/Header.tsx` — top bar с заголовком страницы
- [x] `widgets/bottom-nav/ui/BottomNav.tsx` — mobile, fixed bottom-0, md:hidden
- [x] `app/(main)/layout.tsx` — Sidebar + Header + main content + BottomNav
- [x] Обновить index.ts виджетов (реэкспорт компонентов)
- [x] Проверить: `pnpm check-types` — ✅ без ошибок

## Статус: DONE
