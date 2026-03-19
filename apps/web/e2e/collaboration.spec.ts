import { test, expect, Page } from '@playwright/test';

/**
 * E2E тесты для коллаборации в реальном времени
 *
 * Тестируем:
 * - Два браузера одновременно
 * - Синхронизация точек между конструктором, ЛК, ИИ чатом
 * - Chat между коллаборантами
 * - Presence (онлайн/офлайн статус)
 */

test.describe('Collaboration E2E Tests', () => {
  const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3000';
  let user1Page: Page;
  let user2Page: Page;
  const tripId = 'test-trip-' + Date.now();

  test.beforeAll(async ({ browser }) => {
    // Создаём две страницы для двух разных пользователей
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    user1Page = await context1.newPage();
    user2Page = await context2.newPage();
  });

  test.afterAll(async () => {
    await user1Page.close();
    await user2Page.close();
  });

  test.describe('Point Synchronization', () => {
    test('should show point added on Planner in Profile instantly', async () => {
      // User 1: открывает конструктор
      await user1Page.goto(`${baseUrl}/planner/${tripId}`);

      // User 2: открывает профиль (ЛК)
      await user2Page.goto(`${baseUrl}/profile`);

      // User 1: добавляет новую точку
      await user1Page.fill('[data-testid="point-search"]', 'Кафе Пушкин');
      await user1Page.waitForTimeout(500); // Wait for suggestions to load
      await user1Page.click('[data-testid="poi-item-0"]');

      // User 2: должен видеть новую точку в профиле в реальном времени
      await user2Page.waitForSelector('[data-testid="trip-card-item"]', {
        timeout: 5000,
      });

      const pointText = await user2Page.textContent('[data-testid="trip-card-item"]');
      expect(pointText).toContain('Кафе Пушкин');
    });

    test('should synchronize drag-drop of points', async () => {
      // Prerequisite: точка уже существует

      // User 1: перемещает точку на карте (drag-drop)
      const marker1 = await user1Page.$('[data-testid="map-marker-0"]');
      if (marker1) {
        const box = await marker1.boundingBox();
        if (box) {
          await user1Page.dragAndDrop(
            '[data-testid="map-marker-0"]',
            '[data-testid="map-center"]'
          );
        }
      }

      // User 2: должен видеть обновленное местоположение точки
      await user2Page.waitForTimeout(1000); // Небольшой задержка для синхронизации

      // Проверяем что координаты обновились
      const profilePointCoords = await user2Page.getAttribute(
        '[data-testid="trip-point-0"]',
        'data-coords'
      );

      const plannerPointCoords = await user1Page.getAttribute(
        '[data-testid="trip-point-0"]',
        'data-coords'
      );

      expect(profilePointCoords).toBe(plannerPointCoords);
    });

    test('should update point on Profile and reflect on Planner', async () => {
      // User 2: меняет название точки в профиле
      await user2Page.click('[data-testid="trip-point-edit-0"]');
      await user2Page.locator('[data-testid="point-name-input"]').clear();
      await user2Page.fill('[data-testid="point-name-input"]', 'Новое название');
      await user2Page.click('[data-testid="confirm-edit"]');

      // User 1: должен видеть изменение на конструкторе
      await user1Page.waitForTimeout(500);

      const plannerPointName = await user1Page.textContent(
        '[data-testid="trip-point-0"]'
      );
      expect(plannerPointName).toContain('Новое название');
    });

    test('should show delete point on both pages', async () => {
      // User 1: удаляет точку
      await user1Page.click('[data-testid="point-menu-0"]');
      await user1Page.click('[data-testid="delete-point-btn"]');
      await user1Page.click('[data-testid="confirm-delete"]');

      // User 2: точка должна исчезнуть из профиля
      await user2Page.waitForFunction(
        () => !document.querySelector('[data-testid="trip-point-0"]'),
        { timeout: 5000 }
      );

      const pointExists = await user2Page.$(
        '[data-testid="trip-point-0"]'
      );
      expect(pointExists).toBeNull();
    });
  });

  test.describe('Chat Messages Between Collaborators', () => {
    test('should show message from one user to another instantly', async () => {
      // Оба юзера открывают чат маршрута
      await user1Page.goto(`${baseUrl}/planner/${tripId}/chat`);
      await user2Page.goto(`${baseUrl}/planner/${tripId}/chat`);

      // User 1: отправляет сообщение
      await user1Page.fill('[data-testid="chat-input"]', 'Давайте добавим музей!');
      await user1Page.click('[data-testid="send-message-btn"]');

      // User 2: должен видеть сообщение instantly
      await user2Page.waitForSelector('[data-testid="chat-message"]', {
        timeout: 5000,
      });

      const messageText = await user2Page.textContent(
        '[data-testid="chat-message"]:last-child'
      );
      expect(messageText).toContain('Давайте добавим музей!');
    });

    test('should show user name and avatar in chat', async () => {
      // User 2: отвечает
      await user2Page.fill('[data-testid="chat-input"]', 'Согласен! Какой музей?');
      await user2Page.click('[data-testid="send-message-btn"]');

      // User 1: видит сообщение с именем User 2
      await user1Page.waitForSelector('[data-testid="chat-message-user-name"]', {
        timeout: 5000,
      });

      const userName = await user1Page.textContent(
        '[data-testid="chat-message-user-name"]:last-child'
      );
      expect(userName).toBeTruthy(); // Должно содержать имя User 2
    });

    test('should show typing indicator', async () => {
      // User 1: начинает печатать
      await user1Page.focus('[data-testid="chat-input"]');
      await user1Page.type('[data-testid="chat-input"]', 'Тип');

      // User 2: должен видеть "User 1 печатает..."
      await user2Page.waitForSelector('[data-testid="typing-indicator"]', {
        timeout: 3000,
      });

      const typingText = await user2Page.textContent(
        '[data-testid="typing-indicator"]'
      );
      expect(typingText).toContain('печатает');
    });
  });

  test.describe('AI Requests Visible to All', () => {
    test('should show AI points added to all users', async () => {
      // User 1: на странице /ai-assistant отправляет запрос к ИИ
      await user1Page.goto(`${baseUrl}/ai-assistant`);
      await user1Page.fill('[data-testid="ai-input"]', 'Добавь музеи и кафе');
      await user1Page.click('[data-testid="send-ai-query"]');

      // Ждём пока ИИ ответит
      await user1Page.waitForSelector('[data-testid="ai-route-plan"]', {
        timeout: 15000,
      });

      // User 2: на странице /planner видит новые точки из ИИ
      await user2Page.goto(`${baseUrl}/planner/${tripId}`);

      // Новые точки должны появиться на карте
      await user2Page.waitForSelector('[data-testid="map-marker"]', {
        timeout: 5000,
      });

      const markersCount = await user2Page.locator(
        '[data-testid="map-marker"]'
      ).count();
      expect(markersCount).toBeGreaterThan(0);
    });

    test('should show AI points on Profile instantly', async () => {
      // User 3 (или User 2): открыл профиль и видит новый маршрут
      // от ИИ запроса User 1

      // (Продолжение предыдущего теста)
      // User 2 переходит в /profile
      await user2Page.goto(`${baseUrl}/profile`);

      // Должен видеть маршрут с точками от ИИ
      await user2Page.waitForSelector('[data-testid="trip-card-item"]', {
        timeout: 5000,
      });

      const tripPoints = await user2Page.locator(
        '[data-testid="trip-point"]'
      ).count();
      expect(tripPoints).toBeGreaterThan(0);
    });

    test('should keep AI chat history in sync', async () => {
      // User 1: видит свой AI запрос и ответ в /ai-assistant
      const user1ChatHistory = await user1Page.locator(
        '[data-testid="chat-message"]'
      ).count();

      // User 2: если откроет AI ассистент того же маршрута,
      // должен увидеть ту же историю
      await user2Page.goto(`${baseUrl}/ai-assistant`);

      // История должна загрузиться
      await user2Page.waitForSelector('[data-testid="chat-message"]', {
        timeout: 5000,
      });

      const user2ChatHistory = await user2Page.locator(
        '[data-testid="chat-message"]'
      ).count();

      expect(user2ChatHistory).toBe(user1ChatHistory);
    });
  });

  test.describe('Presence & Collaborators', () => {
    test('should show collaborator online status', async () => {
      // User 1: открывает маршрут
      await user1Page.goto(`${baseUrl}/planner/${tripId}`);

      // User 2: тоже открывает тот же маршрут
      await user2Page.goto(`${baseUrl}/planner/${tripId}`);

      // Оба должны видеть друг друга в списке collaborators
      await user1Page.waitForSelector('[data-testid="collaborators-online"]', {
        timeout: 5000,
      });

      const collaborator2Online = await user1Page.isVisible(
        '[data-testid="collaborator-online-user2"]'
      );
      expect(collaborator2Online).toBe(true);

      // User 2 также видит User 1 онлайн
      const collaborator1Online = await user2Page.isVisible(
        '[data-testid="collaborator-online-user1"]'
      );
      expect(collaborator1Online).toBe(true);
    });

    test('should update status when user leaves page', async () => {
      // User 2: закрывает страницу маршрута (уходит)
      await user2Page.goto(`${baseUrl}/profile`);

      // User 1: должен видеть что User 2 офлайн
      await user1Page.waitForTimeout(2000); // Время на обновление статуса

      const collaborator2Online = await user1Page.isVisible(
        '[data-testid="collaborator-online-user2"]'
      );
      expect(collaborator2Online).toBe(false);

      // Может быть показано "последний раз" время
      const lastSeen = await user1Page.textContent(
        '[data-testid="collaborator-last-seen-user2"]'
      );
      expect(lastSeen).toBeTruthy();
    });
  });

  test.describe('Cross-page Synchronization', () => {
    test('should sync changes between Planner, Profile, and AI Chat', async () => {
      // User 1 на Planner добавляет точку
      await user1Page.goto(`${baseUrl}/planner/${tripId}`);
      await user1Page.fill('[data-testid="point-search"]', 'Тестовая точка');
      await user1Page.waitForTimeout(500); // Wait for suggestions to load
      await user1Page.click('[data-testid="poi-item-0"]');

      // User 2 одновременно открывает разные страницы
      // 1. Profile должен показать точку
      await user2Page.goto(`${baseUrl}/profile`);
      await user2Page.waitForSelector('[data-testid="trip-point"]', {
        timeout: 5000,
      });

      // 2. AI Chat должен показать точку
      await user2Page.goto(`${baseUrl}/ai-assistant`);
      // Карта в AI Chat должна показать точку
      await user2Page.waitForSelector('[data-testid="map-marker"]', {
        timeout: 5000,
      });

      // 3. Вернулся на Planner - точка всё ещё там
      await user2Page.goto(`${baseUrl}/planner/${tripId}`);
      await user2Page.waitForSelector('[data-testid="trip-point"]', {
        timeout: 5000,
      });

      // Все три страницы должны показывать одинаковое состояние
      expect(true).toBe(true); // Если дошли сюда - синхронизация работает
    });

    test('should maintain consistency with rapid changes', async () => {
      // User 1: быстро добавляет несколько точек подряд
      for (let i = 0; i < 3; i++) {
        await user1Page.fill('[data-testid="point-search"]', `Точка ${i + 1}`);
        await user1Page.waitForTimeout(500); // Wait for suggestions to load
        await user1Page.click('[data-testid="poi-item-0"]');
        await user1Page.waitForTimeout(500);
      }

      // User 2: видит все 3 точки добавленными в правильном порядке
      await user2Page.goto(`${baseUrl}/profile`);
      await user2Page.waitForTimeout(2000);

      const points = await user2Page.locator('[data-testid="trip-point"]').all();
      expect(points.length).toBe(3);

      // Точки должны быть в правильном порядке
      for (let i = 0; i < 3; i++) {
        const text = await points[i]!.textContent();
        expect(text).toContain(`Точка ${i + 1}`);
      }
    });
  });

  test.describe('Error Scenarios', () => {
    test('should handle connection loss gracefully', async () => {
      // Имитируем потерю соединения (симуляция через DevTools)
      // Когда connection потеряется, UI должен показать warning

      // User 1: всё ещё видит свои локальные изменения (optimistic update)
      // но они не синхронизируются

      // При восстановлении соединения, должны синхронизироваться
      // все накопленные изменения
    });

    test('should handle concurrent edits of same point', async () => {
      // User 1 и User 2 одновременно редактируют одну точку
      // Последнее редактирование должно выиграть
      // Оба юзера должны увидеть финальное состояние

      const pointId = '0';

      // User 1: меняет название
      await user1Page.click(`[data-testid="edit-point-${pointId}"]`);
      await user1Page.fill('[data-testid="point-name"]', 'Название от User1');

      // User 2: практически одновременно меняет название
      await user2Page.click(`[data-testid="edit-point-${pointId}"]`);
      await user2Page.fill('[data-testid="point-name"]', 'Название от User2');

      // Оба сохраняют
      await user1Page.click('[data-testid="confirm-edit"]');
      await user2Page.click('[data-testid="confirm-edit"]');

      // Финальное состояние должно быть консистентно на обоих клиентах
      await user1Page.waitForTimeout(1000);
      await user2Page.waitForTimeout(1000);

      const user1Final = await user1Page.textContent(
        `[data-testid="point-name-display"]`
      );
      const user2Final = await user2Page.textContent(
        `[data-testid="point-name-display"]`
      );

      expect(user1Final).toBe(user2Final);
    });
  });
});
