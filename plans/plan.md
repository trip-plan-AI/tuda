# TRI-111 — Сквозная карта 50/50 + mobile bottom sheet

## 0. Git ветка

Из текущей среды я не могу напрямую выполнить git-команду, поэтому фиксирую шаг для ручного запуска:

```bash
git checkout -b feature/TRI-111-layout-map
```

## 1. Цель

Сделать карту сквозной для всей внутренней части сайта кроме главной страницы:
- desktop: слева контент, справа карта 50/50
- mobile: карта фоном + draggable bottom sheet с контентом
- сохранить функционал карты planner/profile
- обратная совместимость и поддержка legacy не требуются

## 2. Область изменений

### 2.1 Основные файлы
- `apps/web/src/app/(main)/layout.tsx`
- `apps/web/src/views/planner/ui/PlannerPage.tsx`
- `apps/web/src/views/profile/ui/ProfilePage.tsx`
- `apps/web/src/widgets/route-map/ui/RouteMap.tsx`  
  только если потребуются минимальные адаптации под новый shell

### 2.2 Новые файлы
- `apps/web/src/features/persistent-map/model/persistent-map.store.ts`
- `apps/web/src/features/persistent-map/index.ts`
- `apps/web/src/widgets/persistent-map-shell/ui/PersistentMapShell.tsx`
- `apps/web/src/widgets/persistent-map-shell/index.ts`
- `apps/web/src/widgets/mobile-content-sheet/ui/MobileContentSheet.tsx`
- `apps/web/src/widgets/mobile-content-sheet/index.ts`

## 3. Архитектурный подход

### 3.1 Единый map shell в main layout
1. В `main layout` определить `isLanding` по pathname.
2. Если `isLanding=true` — оставить текущий сценарий без сквозной карты.
3. Если `isLanding=false`:
   - desktop контейнер: 2 колонки `50% / 50%`
   - mobile контейнер: full-screen карта + overlay bottom sheet с drag-handle
4. Карта рендерится один раз внутри `PersistentMapShell`.

### 3.2 Общий map-state контракт
В Zustand-store хранить `PersistentMapConfig`:
- `points`
- `focusCoords`
- `draggable`
- `readonly`
- `routeProfile`
- `isDropdownOpen`
- `isAddPointMode`
- `onPointDragEnd`
- `onMapClick`
- `onAddPointModeChange`
- `onRouteInfoUpdate`
- `onRouteInfoLoading`
- `onAffectedSegmentsChange`
- `source` и `priority` для разрешения конкуренции провайдеров

### 3.3 Поставка данных в сквозную карту
- `PlannerPage` публикует полный интерактивный конфиг.
- `ProfilePage` публикует readonly-конфиг по активному маршруту.
- Другие внутренние страницы публикуют либо readonly-конфиг, либо fallback.
- При unmount страницы очищают свой конфиг.

## 4. Пошаговый план реализации

1. Создать `persistent-map.store` и API-хелперы `setConfig`, `clearConfig`, `setSheetState`.
2. Создать `PersistentMapShell`, который читает store и рендерит `RouteMap`.
3. Создать `MobileContentSheet` с snap-позициями: collapsed, medium, expanded.
4. Встроить shell в `app/(main)/layout.tsx` для всех страниц кроме `/`.
5. Удалить локальный блок карты из `PlannerPage`, подключить публикацию конфига.
6. Удалить локальные превью карты из `ProfilePage`, подключить публикацию конфига.
7. Добавить страницу-level адаптеры для других внутренних view, чтобы карта была сквозной везде.
8. Проверить визуальный split 50/50 на desktop и корректный drag sheet на mobile.
9. Проверить интерактив: add point, drag point, route info, фокус, readonly сценарии.
10. Выполнить smoke проверки и зафиксировать результаты.

## 5. Acceptance Criteria для AI-проверки после реализации

### 5.1 Маршрутизация и охват
- [ ] На `/` сквозной карты нет.
- [ ] На `/planner` карта отображается справа и занимает 50% ширины desktop.
- [ ] На `/profile` карта отображается справа и занимает 50% ширины desktop.
- [ ] На внутренних страницах `ai-assistant`, `tours/[id]` и других внутренних роутов карта отображается.

### 5.2 Desktop UX
- [ ] Контент всегда в левой половине, карта в правой половине.
- [ ] При скролле контента карта остается доступной и не пропадает.
- [ ] В `planner` работает добавление точки кликом по карте.
- [ ] В `planner` работает перетаскивание точек на карте.
- [ ] В `planner` сохраняются route info и индикаторы загрузки сегментов.
- [ ] В `profile` карта readonly, без случайного редактирования.

### 5.3 Mobile UX
- [ ] Карта отображается на весь экран как базовый слой.
- [ ] Контент отображается через draggable bottom sheet.
- [ ] Bottom sheet имеет минимум 3 snap состояния.
- [ ] В expanded состоянии контент читаем и прокручиваем.
- [ ] В collapsed состоянии карта остается видимой и интерактивной.

### 5.4 Технические критерии
- [ ] Нет двойного рендера карты на одной странице.
- [ ] Нет утечек обработчиков и ошибок destroy/create в консоли.
- [ ] Нет регрессии в `RouteMap` по drag/add/focus.
- [ ] TypeScript и ESLint проходят без новых ошибок.

## 6. Smoke UX тесты через curl

Ограничение: `curl` не проверяет визуальную геометрию 50/50 и drag-жесты. Через `curl` проверяем доступность маршрутов, корректную отдачу HTML и отсутствие критических HTTP-ошибок.

### 6.0 Чем дополнить `curl`, чтобы AI-агент проверил все UX-требования

Чтобы покрыть визуальные и интерактивные сценарии полностью, нужен набор инструментов, а не только `curl`:

1. Browser E2E: **Playwright**
   - Проверка реальной верстки split 50/50 на desktop через измерение ширины контейнеров.
   - Проверка mobile-режима через эмуляцию viewport и drag bottom sheet.
   - Проверка интерактива карты: клик, перетаскивание, переключение режимов.

2. Visual regression: **Playwright screenshot diff** или **Percy/Applitools**
   - Снимки эталонных экранов `/planner`, `/profile`, `/ai-assistant`, `/tours/[id]`.
   - Автосравнение пикселей для контроля деградаций UI.

3. Runtime проверки: **браузерные console/network assertions**
   - Отсутствие JS-ошибок.
   - Отсутствие критичных 4xx/5xx на ресурсах страницы.

4. API smoke: **curl**
   - Доступность маршрутов и базовая корректность SSR/HTML.
   - Быстрая проверка HTTP-статусов и регрессий роутинга.

Рекомендуемая матрица для AI-агента:
- `curl` = route and status smoke
- Playwright = UX and interaction smoke
- visual diff = layout and style stability

Итог: `curl` оставляем как слой L1, но для покрытия геометрии 50/50 и drag-жестов обязателен L2 на Playwright.

### 6.1 Предусловие
Запущен web-app локально на `http://localhost:3000`.

### 6.2 Команды

```bash
curl -s -o NUL -w "%{http_code}" http://localhost:3000/
curl -s -o NUL -w "%{http_code}" http://localhost:3000/planner
curl -s -o NUL -w "%{http_code}" http://localhost:3000/profile
curl -s -o NUL -w "%{http_code}" http://localhost:3000/ai-assistant
curl -s -o NUL -w "%{http_code}" http://localhost:3000/tours/1
```

Ожидается `200` на все существующие страницы.

```bash
curl -s http://localhost:3000/planner | findstr /I "<!DOCTYPE html"
curl -s http://localhost:3000/profile | findstr /I "<!DOCTYPE html"
```

Ожидается наличие валидного SSR/HTML smoke-маркера App Router (`<!DOCTYPE html` в ответе страницы).

```bash
curl -s -o NUL -w "%{http_code}" http://localhost:3000/non-existing-route
```

Ожидается `404`.

### 6.3 Дополнительный smoke API
Если backend поднят и проксируется через `/api`:

```bash
curl -s -o NUL -w "%{http_code}" "http://localhost:3001/api/geosearch/suggest?query=moscow"
```

Ожидается `200` для обязательного smoke-endpoint `/api/geosearch/suggest`.

Дополнительно можно проверить базовый публичный endpoint проекта:

```bash
curl -s -o NUL -w "%{http_code}" "http://localhost:3001/api/trips/predefined"
```

Ожидается `200`.

