# TRI-22 — Tailwind CSS и shadcn/ui

## Описание задачи
Настройка дизайн-токенов (brand colors, borderRadius) и установка базовых shadcn/ui компонентов.

## Подход к реализации
Проект использует Tailwind CSS v4 с `@theme` директивой в globals.css (не через tailwind.config.ts).
Brand-токены добавляются в блок `@theme inline` в globals.css.

## Текущее состояние
- globals.css: есть `@import "tailwindcss"`, shadcn-тема настроена, brand-токенов НЕТ
- tailwind.config.ts: НЕ существует (Tailwind v4 использует @theme в CSS)
- shadcn компоненты: установлен только `button.tsx`

## Чек-лист
- [x] Добавить brand-токены в globals.css (@theme): sky, indigo, amber, light, bg
- [x] Добавить borderRadius токены: 2xl, 3xl, 4xl
- [x] Установить shadcn компоненты: card, input, dialog, badge, sheet, dropdown-menu, avatar
- [x] Обновить shared/ui/index.ts — реэкспорт всех компонентов
- [x] Проверить: `pnpm check-types` — ✅ без ошибок

## Статус: DONE
