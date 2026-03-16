# TRI-120 — Chat Socket.IO: Real-time синхронизация чата

**Ветка:** `feature/TRI-120--Chat_soketIO`
**Дата:** 2026-03-16
**Статус:** Реализовано

---

## Контекст и мотивация

До этой задачи AI-чат на странице `/ai-assistant` работал в изолированном режиме:
каждый пользователь видел только свои сообщения и ответы AI. При совместном редактировании
маршрута коллаборатор не видел, что пишут другие участники в чате.

**Цели задачи:**
1. Транслировать сообщения пользователей всем участникам одной комнаты через WebSocket.
2. Ограничить вызов Dual-AI Engine: AI генерирует ответ **только** при наличии тега `/help`.
3. Синхронизация карты на `/ai-assistant` уже работала через `useCollaborationSocket` —
   подтверждено и задокументировано.

---

## Архитектура решения

### Схема потока данных

```
┌──────────────────────────────────────────────────────┐
│  Пользователь A                                      │
│  Пишет: "Где поесть?"                                │
│  ↓                                                   │
│  handleSend()                                        │
│  ├─ sendChatMessage()  ──► socket.emit('message:send')│
│  └─ addLocalMessage()  (локально, без AI)            │
└──────────────────────────────────────────────────────┘
           │ WebSocket
           ▼
┌──────────────────────────────────────────────────────┐
│  NestJS CollaborationGateway                         │
│  handleChatMessage()                                 │
│  client.to(`trip_${id}`).emit('message:receive')     │
└──────────────────────────────────────────────────────┘
           │ WebSocket
           ▼
┌──────────────────────────────────────────────────────┐
│  Пользователь B                                      │
│  useChatSync → socket.on('message:receive')          │
│  → addLocalMessage({ "user@mail.ru: Где поесть?" })  │
│  → сообщение появляется в чате                       │
└──────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────┐
│  Пользователь A                                      │
│  Пишет: "/help 2 дня в Казани с бюджетом 5000"       │
│  ↓                                                   │
│  handleSend()                                        │
│  ├─ sendChatMessage()  ──► socket.emit('message:send')│
│  └─ cleanQuery = "2 дня в Казани с бюджетом 5000"    │
│     sendQuery(cleanQuery) ──► Orchestrator ──► AI    │
│     ← assistantMessage (routePlan)                   │
└──────────────────────────────────────────────────────┘
```

### WebSocket события (namespace `/collaboration`)

| Событие | Направление | Payload | Описание |
|---------|------------|---------|----------|
| `message:send` | client → server | `{ trip_id, id, content, timestamp }` | Отправка сообщения в комнату |
| `message:receive` | server → clients | `{ trip_id, id, content, timestamp, user_id, user_name }` | Ретрансляция сообщения участникам (кроме отправителя) |

---

## Изменённые файлы

### 1. Backend — `collaboration.gateway.ts`

**Путь:** `apps/api/src/collaboration/collaboration.gateway.ts`

**Что добавлено:** новый обработчик `@SubscribeMessage('message:send')`.

```typescript
@SubscribeMessage('message:send')
handleChatMessage(
  @ConnectedSocket() client: TypedSocket,
  @MessageBody()
  data: { trip_id: string; id: string; content: string; timestamp: string },
) {
  // Ретрансляция сообщения всем участникам комнаты, кроме отправителя
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

**Ключевые детали:**
- `client.to(room)` — исключает отправителя из broadcast (он уже добавил своё сообщение локально).
- Авторизация происходит на уровне `handleConnection` через JWT; к моменту вызова `handleChatMessage` пользователь уже аутентифицирован.
- Сообщения **не сохраняются в БД** — транспортный уровень real-time, без персистентности чата.

---

### 2. Frontend — `useChatSync.ts` (новый файл)

**Путь:** `apps/web/src/features/route-collaborate/hooks/useChatSync.ts`

**Назначение:** транспортный слой WebSocket для чата. Хук отвечает только за сокет — без бизнес-логики AI.

```typescript
export function useChatSync(tripId: string) {
  // Слушаем входящие сообщения от других участников
  useEffect(() => {
    if (!tripId || tripId.startsWith('guest-')) return;
    const socket = getSocket();

    const handleMessage = (data: RemoteChatPayload) => {
      // Добавляем в активную AI-сессию с именем отправителя в тексте
      useAiQueryStore.getState().addLocalMessage({
        id: data.id,
        role: 'user',
        content: `${data.user_name}: ${data.content}`,
        timestamp: data.timestamp,
      });
    };

    socket.on('message:receive', handleMessage);
    return () => { socket.off('message:receive', handleMessage); };
  }, [tripId]);

  // Отправка собственного сообщения в комнату
  const sendChatMessage = useCallback((text: string) => {
    if (!tripId || tripId.startsWith('guest-')) return;
    getSocket().emit('message:send', {
      trip_id: tripId,
      id: crypto.randomUUID(),
      content: text,
      timestamp: new Date().toISOString(),
    });
  }, [tripId]);

  return { sendChatMessage };
}
```

**Защита от guest-режима:** хук не подписывается на события, если `tripId` пустой или начинается с `guest-` — поведение аналогично `useCollaborationSocket`.

---

### 3. Frontend — `ai-query.store.ts`

**Путь:** `apps/web/src/features/ai-query/model/ai-query.store.ts`

**Что добавлено:** действие `addLocalMessage(message: ChatMessage)`.

```typescript
addLocalMessage: (message) => {
  set((state) => {
    const { sessions, activeSessionId } = ensureActiveSession(state);
    const session = sessions[activeSessionId];
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

**Зачем нужно:** `sendQuery` всегда добавляет сообщение + вызывает AI-pipeline. Для
не-`/help` сообщений нужен способ показать текст в чате без запроса к AI. `addLocalMessage`
решает это — чисто локальная мутация стора.

**Важно:** `ensureActiveSession` гарантирует наличие сессии; если активной нет — создаётся
пустой локальный черновик, чтобы сообщение всегда было куда добавить.

---

### 4. Frontend — `AIAssistantPage.tsx`

**Путь:** `apps/web/src/views/ai-assistant/ui/AIAssistantPage.tsx`

**Изменения:**

#### 4.1 Импорт `useChatSync`
```typescript
import {
  useCollaborationSocket,
  CollaboratorsAvatarGroup,
  useChatSync,          // ← добавлено
} from '@/features/route-collaborate';
```

#### 4.2 Подключение хука рядом с картой
```typescript
const socketTripId = activeSession?.tripId || '';
useCollaborationSocket(socketTripId);  // карта + точки (работало ранее)
const { sendChatMessage } = useChatSync(socketTripId);  // ← чат (новое)
```

#### 4.3 Новая логика `handleSend`

**До (все сообщения идут в AI):**
```typescript
const handleSend = async (query: string) => {
  await sendQuery(query, activeSession?.tripId ?? undefined);
};
```

**После (разделение по `/help`):**
```typescript
const handleSend = async (query: string) => {
  // Всегда транслируем другим участникам комнаты
  sendChatMessage(query);

  const isHelpRequest = query.startsWith('/help');

  if (isHelpRequest) {
    // Убираем тег, отправляем очищенный запрос в Orchestrator
    const cleanQuery = query.replace(/^\/help\s*/, '').trim() || query;
    await sendQuery(cleanQuery, activeSession?.tripId ?? undefined);
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

### 5. Frontend — `route-collaborate/index.ts`

**Путь:** `apps/web/src/features/route-collaborate/index.ts`

Добавлен реэкспорт нового хука:
```typescript
export { useChatSync } from './hooks/useChatSync';
```

---

## Документация — PRD_v2.1.md

**Путь:** `docs/prd/PRD_v2.1.md`

### Изменение 1: Таблица WebSocket Events (секция 4.2)

Добавлены два события:

| Событие | Направление | Payload |
|---------|------------|---------|
| `message:send` | client → server | `{ trip_id, id, content, timestamp }` |
| `message:receive` | server → clients | `{ trip_id, id, content, timestamp, user_id, user_name }` |

### Изменение 2: Раздел Real-time Collaboration (секция 6.1)

Добавлен подраздел **Chat Sync (TRI-120)**:

> - Клиент отправляет `message:send` — сервер ретранслирует через `message:receive` всем участникам комнаты (кроме отправителя)
> - AI-агент реагирует **только** на сообщения с тегом `/help` в начале строки
> - Сообщения без `/help` транслируются участникам, но не вызывают AI-pipeline
> - При получении `/help` тег удаляется перед передачей в Orchestrator
> - Входящие `message:receive` добавляются в активную AI-сессию получателя локально

---

## Ограничения текущей реализации

| Ограничение | Причина | Возможное решение |
|-------------|---------|------------------|
| Сообщения не сохраняются в БД | Нет таблицы `chat_messages`; scope TRI-120 | TRI-121: добавить персистентность чата |
| AI-ответ на `/help` виден только у отправителя | AI-сессии персональные | TRI-122: shared AI session per trip |
| Имя отправителя показывается как `email` | `client.data.email` — единственные данные в сокете | TRI-123: передавать display name |
| Guest-режим не поддерживается | `tripId.startsWith('guest-')` → хук отключается | Ожидаемое поведение |

---

## Тест-план

### Ручное тестирование

1. **Базовая ретрансляция:**
   - Открыть `/ai-assistant` в двух браузерах под разными аккаунтами
   - Оба должны быть в сессии, привязанной к одному `tripId`
   - Пользователь A пишет "Привет" → Пользователь B должен увидеть "email@a.ru: Привет"

2. **Изоляция AI:**
   - Пользователь A пишет "Что посмотреть?" → AI НЕ должен ответить; сообщение появляется у A и B
   - Пользователь A пишет "/help Что посмотреть в Казани?" → AI отвечает только у A; у B виден только текст сообщения

3. **Guest-режим:**
   - Открыть `/ai-assistant` без авторизации или в сессии без `tripId`
   - Чат работает в обычном режиме (нет socket-broadcast), ошибок нет

4. **Синхронизация карты (регрессия):**
   - Пользователь A перетаскивает точку на карте → Пользователь B должен увидеть изменение (работало до TRI-120, не должно сломаться)

### Проверка WebSocket (DevTools)

```
Network → WS → /collaboration

Отправка: {"event":"message:send","data":{"trip_id":"uuid","id":"uuid","content":"текст","timestamp":"..."}}
Приём:    {"event":"message:receive","data":{"trip_id":"uuid","id":"uuid","content":"текст","timestamp":"...","user_id":"uuid","user_name":"email"}}
```
