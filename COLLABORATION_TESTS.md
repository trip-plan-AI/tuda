# Тесты коллаборации в реальном времени

Комплексные тесты для проверки синхронизации между несколькими клиентами, чатов, ИИ-запросов и presence.

## 📁 Структура тестов

```
apps/web/src/features/route-collaborate/__tests__/
  └── collaboration.socket.test.ts      # Integration тесты (Socket.io события)

apps/web/e2e/
  └── collaboration.spec.ts              # E2E тесты (два браузера одновременно)
```

## 🧪 Integration тесты (Vitest)

Тестируют логику сокет-событий и state synchronization.

### Запуск
```bash
# Все integration тесты
pnpm test

# Только collaboration тесты
pnpm test collaboration.socket.test.ts

# С покрытием
pnpm test -- --coverage

# В watch режиме
pnpm test -- --watch
```

### Что тестируется

#### 1. **Point Synchronization** (синхронизация точек)
- ✅ Broadcast `point:added` всем коллаборантам
- ✅ Real-time координаты при `point:moved` (drag-drop)
- ✅ Синхронизация `point:updated` на всех страницах
- ✅ Broadcast `point:deleted`
- ✅ Broadcast `point:reorder`

#### 2. **Chat Messages** (чат между коллаборантами)
- ✅ Broadcast сообщение всем пользователям
- ✅ Включение info юзера (name, avatar)
- ✅ Typing indicator (`user is typing...`)

#### 3. **AI Requests** (ИИ-запросы видны всем)
- ✅ Broadcast AI запроса в trip
- ✅ Broadcast точек от ИИ всем клиентам
- ✅ Видимость на Planner, Profile, AI Chat одновременно

#### 4. **Presence & Activity** (онлайн/офлайн статус)
- ✅ `presence:update` при входе/выходе
- ✅ Статус в collaborators section
- ✅ `join:trip` и `leave:trip` события
- ✅ Last seen timestamp

#### 5. **Multi-page Synchronization** (синхронизация между страницами)
- ✅ Point added на Planner → видно на Profile
- ✅ Drag-drop на Profile → видно на Planner
- ✅ AI Chat updates → видно везде

#### 6. **Error Handling** (обработка ошибок)
- ✅ Connection errors
- ✅ Retry с exponential backoff
- ✅ Server-sent errors

## 🎭 E2E тесты (Playwright)

Полная симуляция двух реальных браузеров, взаимодействующих друг с другом.

### Запуск

```bash
# Все E2E тесты
pnpm test:e2e

# Только collaboration E2E
pnpm test:e2e collaboration.spec.ts

# Headed mode (видно браузер)
pnpm test:e2e --headed

# Debug режим (пошаговое выполнение)
pnpm test:e2e --debug

# Одновременно на разных браузерах
pnpm test:e2e --project=chromium --project=firefox --project=webkit
```

### Что тестируется

#### 1. **Point Synchronization** (синхронизация точек)
- ✅ Point added на Planner → instantly на Profile
- ✅ Drag-drop маркера синхронизируется между браузерами
- ✅ Edit на Profile → видно на Planner
- ✅ Delete на обеих странах

#### 2. **Chat Messages** (чат между коллаборантами)
- ✅ User 1 пишет → User 2 видит instantly
- ✅ User name и avatar в сообщении
- ✅ Typing indicator

#### 3. **AI Requests** (ИИ запросы от одного видны другому)
- ✅ User 1 в AI Chat отправляет запрос
- ✅ User 2 на Planner видит новые точки instantly
- ✅ User 2 на Profile видит новый trip instantly
- ✅ AI Chat history синхронизирована

#### 4. **Presence & Collaborators** (статус онлайн/офлайн)
- ✅ Оба юзера видят друг друга онлайн
- ✅ Когда уходит → статус offline
- ✅ Last seen время обновляется

#### 5. **Cross-page Synchronization** (синхронизация между 3+ страницами)
- ✅ Changes на Planner → видно на Profile и AI Chat
- ✅ Rapid changes (добавить несколько точек подряд) — консистентны везде

#### 6. **Error Scenarios** (обработка ошибок)
- ✅ Connection loss handling
- ✅ Concurrent edits — последнее редактирование выигрывает
- ✅ Optimistic updates

## 🔧 Как настроить окружение

### 1. Убедиться что запущены сервисы

```bash
# Backend (NestJS) должен быть запущен
pnpm dev:api

# Frontend (Next.js) должен быть запущен
pnpm dev:web
```

### 2. Environment variables для E2E

Создать `.env.e2e` или использовать существующий `.env.test`:

```env
E2E_BASE_URL=http://localhost:3000
E2E_API_URL=http://localhost:3333
```

### 3. Настроить мок-данные

E2E тесты используют реальный WebSocket, поэтому нужны реальные данные:
- Создать test users (user1, user2, user3)
- Создать test trip с collaborators
- Убедиться что Socket.io connected

## 📊 Структура теста

### Integration тест (Vitest)

```typescript
describe('Feature', () => {
  it('should do something', () => {
    const onEvent = vi.fn();

    // Trigger event
    // ...

    // Verify
    expect(onEvent).toHaveBeenCalledWith({...});
  });
});
```

### E2E тест (Playwright)

```typescript
test('should do something', async () => {
  const user1Page = await browser.newPage();
  const user2Page = await browser.newPage();

  // User 1 действие
  await user1Page.goto('...');
  await user1Page.click('...');

  // User 2 ждёт синхронизации
  await user2Page.waitForSelector('...');

  // Verify
  expect(await user2Page.textContent('...')).toContain('...');
});
```

## ⚙️ Конфигурация

### Playwright config
📍 `playwright.config.ts`

```typescript
{
  webServer: {
    command: 'pnpm dev:web',
    port: 3000,
    reuseExistingServer: true,
  },
  use: {
    baseURL: 'http://localhost:3000',
  },
}
```

### Vitest config
📍 `vitest.config.ts`

```typescript
{
  environment: 'jsdom',
  setupFiles: ['./src/test/setup.ts'],
  globals: true,
}
```

## 🐛 Debugging

### Playwright Inspector
```bash
pnpm test:e2e --debug
```

### Headed браузер
```bash
pnpm test:e2e --headed
```

### Консоль бэкенда
Смотреть Socket.io события:
```bash
# Backend логирует все emit/on события
tail -f logs/socket.io.log
```

### Browser DevTools
```bash
# Оставить браузер открытым после теста
pnpm test:e2e --headed --no-exit
```

## 📝 Примеры кейсов

### Тест 1: Синхронизация точек

```typescript
test('should sync point from Planner to Profile', async () => {
  // User 1: открывает конструктор
  await user1Page.goto('/planner/trip-123');

  // User 2: открывает профиль
  await user2Page.goto('/profile');

  // User 1: добавляет точку
  await user1Page.click('[data-testid="add-point"]');
  await user1Page.fill('[search]', 'Кафе');

  // User 2: видит новую точку instantly
  await user2Page.waitForSelector('[data-testid="trip-point"]');
});
```

### Тест 2: Chat между пользователями

```typescript
test('should sync chat message', async () => {
  // Оба открывают одну trip
  await user1Page.goto('/planner/trip-123');
  await user2Page.goto('/planner/trip-123');

  // User 1: пишет сообщение
  await user1Page.fill('[chat-input]', 'Привет!');
  await user1Page.click('[send]');

  // User 2: видит сообщение
  await user2Page.waitForSelector('[message]');
  expect(await user2Page.textContent('[message]')).toContain('Привет!');
});
```

### Тест 3: AI запросы видны всем

```typescript
test('should sync AI response to all pages', async () => {
  // User 1: в AI Chat отправляет запрос
  await user1Page.goto('/ai-assistant');
  await user1Page.fill('[ai-input]', 'Добавь музеи');
  await user1Page.click('[send-ai]');

  // User 2: на Planner видит новые точки
  await user2Page.goto('/planner/trip-123');
  await user2Page.waitForSelector('[map-marker]');
});
```

## ✅ Checklist перед запуском

- [ ] Backend запущен (`pnpm dev:api`)
- [ ] Frontend запущен (`pnpm dev:web`)
- [ ] Database миграции выполнены
- [ ] Test users созданы
- [ ] Socket.io connected
- [ ] Нет других процессов на портах 3000, 3333
- [ ] `.env.test` или `.env.e2e` настроены

## 🚀 Continuous Integration

В GitHub Actions:

```yaml
- name: Run integration tests
  run: pnpm test

- name: Run E2E tests
  run: pnpm test:e2e
  env:
    E2E_BASE_URL: http://localhost:3000
```

## 📚 Дополнительные ресурсы

- [Vitest docs](https://vitest.dev)
- [Playwright docs](https://playwright.dev)
- [Socket.io testing](https://socket.io/docs/v4/testing/)
- [Testing Library](https://testing-library.com)
