# TRI-120 — Полный контекст сессии разработки

**Ветка:** `feature/TRI-120--Chat_soketIO`
**Дата:** 2026-03-16
**Статус:** Реализовано + фиксы

---

## Краткое описание задачи

До TRI-120 AI-чат работал изолированно: каждый пользователь видел только свои сообщения. При совместном редактировании маршрута коллаборатор не видел, что пишут другие участники.

**Цели:**
1. Транслировать сообщения чата всем участникам комнаты через WebSocket.
2. AI отвечает **только** при наличии тега `/help` в начале сообщения.
3. Синхронизация карты на `/ai-assistant` уже работала через `useCollaborationSocket` — подтверждено.
4. После `/help` AI-ответ транслируется другим участникам через `agent:response` → `agent:receive`.

---

## Все изменённые файлы

### 1. `apps/api/src/collaboration/collaboration.gateway.ts`

**Изменение 1:** Добавлен обработчик `message:send` → ретранслирует `message:receive` всем участникам кроме отправителя.

```typescript
@SubscribeMessage('message:send')
handleChatMessage(
  @ConnectedSocket() client: TypedSocket,
  @MessageBody()
  data: { trip_id: string; id: string; content: string; timestamp: string },
) {
  client.to(`trip_${data.trip_id}`).emit('message:receive', {
    trip_id: data.trip_id,
    id: data.id,
    content: data.content,
    timestamp: data.timestamp,
    user_id: client.data.userId,
    user_name: client.data.email,
  });
}
```

**Изменение 2:** Добавлен обработчик `agent:response` → ретранслирует `agent:receive` (AI-ответ другим участникам).

```typescript
@SubscribeMessage('agent:response')
handleAgentResponse(
  @ConnectedSocket() client: TypedSocket,
  @MessageBody()
  data: {
    trip_id: string;
    id: string;
    content: string;
    timestamp: string;
    route_plan: unknown | null;
  },
) {
  client.to(`trip_${data.trip_id}`).emit('agent:receive', {
    trip_id: data.trip_id,
    id: data.id,
    content: data.content,
    timestamp: data.timestamp,
    route_plan: data.route_plan,
  });
}
```

**Исправление бага:** В `handlePointMove` заменено `this.server.to(...)` на `_client.to(...)` — отправитель больше не получает обратно своё собственное событие `point:moved`, что устраняло конфликты при перетаскивании точек.

```typescript
// ДО (баг: sender получает свой же event обратно):
this.server.to(`trip_${data.trip_id}`).emit('point:moved', { ... });

// ПОСЛЕ (исправлено):
_client.to(`trip_${data.trip_id}`).emit('point:moved', { ... });
```

**Ключевое правило:**
- `client.to(room).emit(...)` — исключает отправителя из broadcast ✅
- `this.server.to(room).emit(...)` — включает всех, в том числе отправителя ⚠️

---

### 2. `apps/web/src/features/route-collaborate/hooks/useChatSync.ts` *(новый файл)*

Транспортный слой WebSocket для чата. Хук отвечает только за сокет, без бизнес-логики AI.

```typescript
'use client';

import { useEffect, useCallback } from 'react';
import { getSocket } from '@/shared/socket/socket-client';
import { useAiQueryStore } from '@/features/ai-query';
import type { ChatMessage } from '@/shared/types/ai-chat';

interface RemoteChatPayload {
  trip_id: string;
  id: string;
  content: string;
  timestamp: string;
  user_id: string;
  user_name: string;
}

interface AgentResponsePayload {
  trip_id: string;
  id: string;
  content: string;
  timestamp: string;
  route_plan: unknown | null;
}

export function useChatSync(tripId: string) {
  useEffect(() => {
    if (!tripId || tripId.startsWith('guest-')) return;

    const socket = getSocket();

    const handleMessage = (data: RemoteChatPayload) => {
      const incomingMessage: ChatMessage = {
        id: data.id,
        role: 'user',
        content: `${data.user_name}: ${data.content}`,
        timestamp: data.timestamp,
      };
      useAiQueryStore.getState().addLocalMessage(incomingMessage);
    };

    const handleAgentResponse = (data: AgentResponsePayload) => {
      const agentMessage: ChatMessage = {
        id: data.id,
        role: 'assistant',
        content: data.content,
        timestamp: data.timestamp,
        routePlan: data.route_plan as ChatMessage['routePlan'] ?? undefined,
      };
      useAiQueryStore.getState().addLocalMessage(agentMessage);
    };

    socket.on('message:receive', handleMessage);
    socket.on('agent:receive', handleAgentResponse);

    return () => {
      socket.off('message:receive', handleMessage);
      socket.off('agent:receive', handleAgentResponse);
    };
  }, [tripId]);

  const sendChatMessage = useCallback(
    (text: string) => {
      if (!tripId || tripId.startsWith('guest-')) return;
      const socket = getSocket();
      socket.emit('message:send', {
        trip_id: tripId,
        id: crypto.randomUUID(),
        content: text,
        timestamp: new Date().toISOString(),
      });
    },
    [tripId],
  );

  return { sendChatMessage };
}
```

---

### 3. `apps/web/src/features/ai-query/model/ai-query.store.ts`

**Изменение 1:** Добавлен метод `addLocalMessage` в интерфейс `AiQueryStore`:

```typescript
// TRI-120: добавляет сообщение в активную сессию без вызова AI (для ретрансляции из сокетов).
addLocalMessage: (message: ChatMessage) => void;
```

**Изменение 2 (фикс дубликатов):** Реализация метода с проверкой уникальности ID:

```typescript
addLocalMessage: (message) => {
  set((state) => {
    const { sessions, activeSessionId } = ensureActiveSession(state);
    const session = sessions[activeSessionId];

    // ЗАЩИТА ОТ ДУБЛИКАТОВ: если сообщение с таким ID уже есть, игнорируем его
    if (session.messages.some((m) => m.id === message.id)) {
      return state;
    }

    const updatedSessions = {
      ...sessions,
      [activeSessionId]: {
        ...session,
        messages: [...session.messages, message],
        updatedAt: new Date().toISOString(),
      },
    };
    return {
      sessions: updatedSessions,
      activeSessionId,
      ...syncLegacyFields(updatedSessions, activeSessionId),
    };
  });
},
```

**Почему нужен фикс дубликатов:** React выбрасывает ошибку `Encountered two children with the same key`, если в списке сообщений есть объекты с одинаковым `id`. Это могло происходить при race-condition между локальным добавлением сообщения и входящим socket-событием с тем же ID.

---

### 4. `apps/web/src/features/route-collaborate/index.ts`

Добавлен реэкспорт нового хука:
```typescript
export { useChatSync } from './hooks/useChatSync';
```

---

### 5. `apps/web/src/views/ai-assistant/ui/AIAssistantPage.tsx`

**5.1 Импорты:**
```typescript
import { getSocket } from '@/shared/socket/socket-client';
import {
  useCollaborationSocket,
  CollaboratorsAvatarGroup,
  useChatSync,  // ← добавлено
} from '@/features/route-collaborate';
```

**5.2 Подключение хука:**
```typescript
const socketTripId = activeSession?.tripId || '';
useCollaborationSocket(socketTripId);  // карта + точки (было ранее)
const { sendChatMessage } = useChatSync(socketTripId);  // чат (новое)
```

**5.3 Добавлен `addLocalMessage` в деструктуринг стора:**
```typescript
const { sendQuery, addLocalMessage, /* ... */ } = useAiQueryStore(
  useShallow((s) => ({
    sendQuery: s.sendQuery,
    addLocalMessage: s.addLocalMessage,
    // ...
  }))
);
```

**5.4 Новая логика `handleSend` с `/help` и `agent:response`:**

```typescript
const handleSend = async (query: string) => {
  // Всегда транслируем другим участникам комнаты
  sendChatMessage(query);

  const isHelpRequest = query.startsWith('/help');

  if (isHelpRequest) {
    // Убираем тег, отправляем очищенный запрос в Orchestrator
    const cleanQuery = query.replace(/^\/help\s*/, '').trim() || query;
    await sendQuery(cleanQuery, activeSession?.tripId ?? undefined);

    // Транслируем AI-ответ другим участникам комнаты
    const updatedMessages = useAiQueryStore.getState().messages;
    const lastAssistant = [...updatedMessages].reverse().find(m => m.role === 'assistant');
    if (lastAssistant && socketTripId) {
      const socket = getSocket();
      socket.emit('agent:response', {
        trip_id: socketTripId,
        id: lastAssistant.id,
        content: lastAssistant.content,
        timestamp: lastAssistant.timestamp,
        route_plan: lastAssistant.routePlan ?? null,
      });
    }
  } else {
    // Показываем собственное сообщение локально без AI-ответа
    addLocalMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: query,
      timestamp: new Date().toISOString(),
    });
  }
};
```

---

### 6. `docs/prd/PRD_v2.1.md`

**Секция 4.2 — WebSocket Events:** добавлены строки:

| Событие | Направление | Payload |
|---------|------------|---------|
| `message:send` | client → server | `{ trip_id, id, content, timestamp }` |
| `message:receive` | server → clients | `{ trip_id, id, content, timestamp, user_id, user_name }` |

**Секция 6.1 — Real-time Collaboration:** добавлен подраздел **Chat Sync (TRI-120)**:
- Клиент отправляет `message:send` — сервер ретранслирует через `message:receive` всем участникам комнаты (кроме отправителя)
- AI-агент реагирует **только** на сообщения с тегом `/help` в начале строки
- Сообщения без `/help` транслируются участникам, но не вызывают AI-pipeline
- При получении `/help` тег удаляется перед передачей в Orchestrator
- Входящие `message:receive` добавляются в активную AI-сессию получателя локально

---

## WebSocket события (namespace `/collaboration`)

| Событие | Направление | Payload | Описание |
|---------|------------|---------|----------|
| `message:send` | client → server | `{ trip_id, id, content, timestamp }` | Отправка сообщения в комнату |
| `message:receive` | server → clients | `{ trip_id, id, content, timestamp, user_id, user_name }` | Ретрансляция (без отправителя) |
| `agent:response` | client → server | `{ trip_id, id, content, timestamp, route_plan }` | Клиент-инициатор отправляет AI-ответ |
| `agent:receive` | server → clients | `{ trip_id, id, content, timestamp, route_plan }` | Ретрансляция AI-ответа (без отправителя) |

---

## Схема потока данных

```
Пользователь A пишет: "Привет"
  ↓ handleSend()
  ├─ sendChatMessage() ──► socket.emit('message:send')
  └─ addLocalMessage() (локально)
           │ WebSocket
           ▼
  NestJS: client.to(room).emit('message:receive')
           │
           ▼
  Пользователь B: useChatSync → addLocalMessage({ "email@a.ru: Привет" })

---

Пользователь A пишет: "/help 2 дня в Казани"
  ↓ handleSend()
  ├─ sendChatMessage() ──► socket.emit('message:send') → B видит сообщение
  └─ cleanQuery = "2 дня в Казани"
     sendQuery(cleanQuery) ──► Orchestrator ──► AI
     ← assistantMessage (routePlan)
     socket.emit('agent:response', { ..., route_plan })
           │ WebSocket
           ▼
  NestJS: client.to(room).emit('agent:receive')
           │
           ▼
  Пользователь B: useChatSync → addLocalMessage({ role: 'assistant', routePlan })
```

---

## Диагностика map sync (итог)

При анализе синхронизации карты было выявлено:

**Frontend (`useCollaborationSocket.ts`):** все 5 слушателей корректны:
- `point:added` → `addPoint()`
- `point:moved` → `updatePoint()`
- `point:deleted` → `removePoint()`
- `point:updated` → `updatePoint()`
- `point:reorder` → `reorderPoints()`

**Backend (`collaboration.gateway.ts`):** в `handlePointMove` использовался `this.server.to(...)` вместо `_client.to(...)`, что приводило к тому, что отправитель получал свой же `point:moved` event обратно — потенциальный конфликт при drag-and-drop.

**Фикс применён:** заменено на `_client.to(...)`.

---

## Ограничения текущей реализации

| Ограничение | Причина | Возможное решение |
|-------------|---------|------------------|
| Сообщения не сохраняются в БД | Нет таблицы `chat_messages`; scope TRI-120 | TRI-121: добавить персистентность чата |
| AI-ответ на `/help` — только `content` и `route_plan` для других | Нет полной ChatMessage структуры | TRI-122: shared AI session per trip |
| Имя отправителя = email | `client.data.email` — единственные данные в сокете | TRI-123: передавать display name |
| Guest-режим не поддерживается | `tripId.startsWith('guest-')` → хук отключается | Ожидаемое поведение |

---

## Тест-план

1. **Базовая ретрансляция:** A пишет "Привет" → B видит "email@a.ru: Привет"
2. **Изоляция AI:** A пишет "Что посмотреть?" → AI не отвечает; сообщение у A и B
3. **`/help` flow:** A пишет "/help Что посмотреть в Казани?" → AI отвечает у A; у B виден текст сообщения + AI-ответ
4. **Guest-режим:** без авторизации — чат работает локально, ошибок нет
5. **Регрессия карты:** A перетаскивает точку → B видит изменение; A не получает дублирующий event
6. **Дубликаты ключей React:** `addLocalMessage` с уже существующим ID → сообщение игнорируется, ошибки нет
