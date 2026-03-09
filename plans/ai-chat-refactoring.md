# План рефакторинга AI-ассистента (Travel Planner 2026)

## 1. Архитектура состояния (Zustand: `useAiQueryStore`)

**Файл:** `apps/web/src/features/ai-query/model/ai-query.store.ts`

**Изменения:**
- Добавить поддержку множественных сессий чата: `sessions: Record<string, ChatSession>`, `activeSessionId: string | null`.
- `ChatSession` содержит `id`, `tripId` (nullable), `messages[]`, `lastAppliedPlanMessageId`, `title` (генерируется из первого запроса или берется из `trip.title`).
- Обновить методы: `sendQuery` работает в контексте `activeSessionId`. `applyPlanToCurrentTrip` привязывает план к `currentTrip`.
- Добавить методы: `createNewSession()`, `switchSession(sessionId)`, `deleteSession(sessionId)`.
- Текущие `messages`, `sessionId`, `lastAppliedPlanMessageId` в стейте заменить на геттеры/селекторы из активной сессии (или оставить для обратной совместимости, но перевести логику под капот на сессии).

## 2. Разделение интерфейса (Layout & UI)

**Файл:** `apps/web/src/views/ai-assistant/ui/AIAssistantPage.tsx`

**Изменения:**
- Сделать Layout из 2 колонок:
  - **Сайдбар слева (SessionsList):** Кнопка "Новый чат", список прошлых сессий (названия + даты). На мобильных — выезжающая шторка или dropdown.
  - **Основная зона (Chat):** Интеграция `AiChat` для `activeSessionId`.

**Файл:** `apps/web/src/widgets/ai-chat/ui/AiChat.tsx`

**Изменения:**
- Зафиксировать высоту контейнера сообщений (`flex-1`, `overflow-y-auto`), чтобы чат имел внутренний скролл, а не скроллил всю страницу. (Уже частично есть, нужно убедиться, что работает корректно на всех экранах).
- При смене `activeSessionId` сбрасывать внутренний стейт (input).

## 3. Улучшение UX/UI сообщений (CTA)

**Файл:** `apps/web/src/widgets/ai-chat/ui/MessageBubble.tsx`

**Изменения:**
- После того как план применен (`wasApplied === true`), кнопка "Применить план" меняет стейт на `[x] План применен` и **рядом появляется новая кнопка**: `Открыть Planner 🗺️` (ссылка на `/planner`).
- Это позволяет пользователю продолжить чат, не переходя, но четко дает путь в конструктор.

## 4. Поддержка контекста в API (Backend)

**Файл:** `apps/api/src/ai/ai.controller.ts` и пайплайн

**Текущее состояние:** Бэкенд уже принимает `session_id` и `trip_id` в `/ai/plan`. Нужно убедиться, что фронтенд корректно передает `session_id` активного чата, чтобы GPT понимал контекст только ЭТОГО чата, а не всех исторических запросов пользователя. (Это уже заложено в `useAiQueryStore`, нужно просто прокинуть `activeSessionId` вместо глобального).

## 5. Тестирование

**Файлы:**
- `apps/web/src/features/ai-query/model/ai-query.store.test.ts`
- Обновить тесты стора для проверки логики множественных сессий.
