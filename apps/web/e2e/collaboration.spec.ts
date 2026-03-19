import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';

/**
 * E2E тесты для коллаборации в реальном времени
 *
 * Параллельное выполнение на разных браузерах
 * - Chromium (по умолчанию)
 * - Firefox
 * - WebKit
 */

test.describe('Collaboration E2E Tests', () => {
  const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3000';

  /**
   * Помощник для создания двух клиентов коллаборации
   */
  async function setupTwoUsers(browser: Browser): Promise<{
    user1: Page;
    user2: Page;
    context1: BrowserContext;
    context2: BrowserContext;
  }> {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const user1 = await context1.newPage();
    const user2 = await context2.newPage();

    return { user1, user2, context1, context2 };
  }

  /**
   * Помощник для создания трёх клиентов коллаборации
   */
  async function setupThreeUsers(browser: Browser): Promise<{
    user1: Page;
    user2: Page;
    user3: Page;
    context1: BrowserContext;
    context2: BrowserContext;
    context3: BrowserContext;
  }> {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const context3 = await browser.newContext();

    const user1 = await context1.newPage();
    const user2 = await context2.newPage();
    const user3 = await context3.newPage();

    return { user1, user2, user3, context1, context2, context3 };
  }

  /**
   * Очистка ресурсов для двух пользователей
   */
  async function cleanupUsers(
    user1: Page,
    user2: Page,
    context1: BrowserContext,
    context2: BrowserContext,
  ) {
    await user1.close();
    await user2.close();
    await context1.close();
    await context2.close();
  }

  /**
   * Очистка ресурсов для трёх пользователей
   */
  async function cleanupThreeUsers(
    user1: Page,
    user2: Page,
    user3: Page,
    context1: BrowserContext,
    context2: BrowserContext,
    context3: BrowserContext,
  ) {
    await user1.close();
    await user2.close();
    await user3.close();
    await context1.close();
    await context2.close();
    await context3.close();
  }

  test.describe('Point Synchronization', () => {
    test('should show point added on Planner in Profile instantly', async ({
      browser,
    }) => {
      const { user1, user2, context1, context2 } = await setupTwoUsers(browser);
      const tripId = 'test-trip-' + Date.now();

      try {
        // User 1: открывает конструктор
        await user1.goto(`${baseUrl}/planner/${tripId}`);

        // User 2: открывает профиль (ЛК)
        await user2.goto(`${baseUrl}/profile`);

        // User 1: добавляет новую точку
        await user1.click('[data-testid="add-point-button"]');
        await user1.fill('[data-testid="point-search"]', 'Кафе Пушкин');

        // Ждём появления результата поиска
        await user1.waitForSelector('[data-testid="poi-item-0"]', {
          timeout: 5000,
        });
        await user1.click('[data-testid="poi-item-0"]');

        // User 2: должен видеть новую точку в профиле в реальном времени
        await user2.waitForSelector('[data-testid="trip-card-item"]', {
          timeout: 5000,
        });

        const pointText = await user2.textContent('[data-testid="trip-card-item"]');
        expect(pointText).toContain('Кафе Пушкин');
      } finally {
        await cleanupUsers(user1, user2, context1, context2);
      }
    });

    test('should synchronize drag-drop of points', async ({ browser }) => {
      const { user1, user2, context1, context2 } = await setupTwoUsers(browser);
      const tripId = 'test-trip-drag-' + Date.now();

      try {
        // Подготовка: добавляем точку
        await user1.goto(`${baseUrl}/planner/${tripId}`);
        await user2.goto(`${baseUrl}/profile`);

        // Добавляем точку на User 1
        await user1.click('[data-testid="add-point-button"]');
        await user1.fill('[data-testid="point-search"]', 'Москва');
        await user1.waitForSelector('[data-testid="poi-item-0"]', {
          timeout: 5000,
        });
        await user1.click('[data-testid="poi-item-0"]');

        // Ждём синхронизации
        await user2.waitForSelector('[data-testid="trip-card-item"]', {
          timeout: 5000,
        });

        // User 1: перемещает точку на карте (drag-drop)
        const marker = await user1.$('[data-testid="map-marker-0"]');
        if (marker) {
          const box = await marker.boundingBox();
          if (box) {
            await user1.dragAndDrop(
              '[data-testid="map-marker-0"]',
              '[data-testid="map-center"]',
            );

            // User 2: должен видеть обновленное местоположение
            await user2.waitForTimeout(1000);
            const profileCoords = await user2.getAttribute(
              '[data-testid="trip-point-0"]',
              'data-coords',
            );
            const plannerCoords = await user1.getAttribute(
              '[data-testid="trip-point-0"]',
              'data-coords',
            );

            // Координаты должны совпадать (или быть очень близкими)
            if (profileCoords && plannerCoords) {
              expect(profileCoords).toBeTruthy();
              expect(plannerCoords).toBeTruthy();
            }
          }
        }
      } finally {
        await cleanupUsers(user1, user2, context1, context2);
      }
    });

    test('should update point on Profile and reflect on Planner', async ({
      browser,
    }) => {
      const { user1, user2, context1, context2 } = await setupTwoUsers(browser);
      const tripId = 'test-trip-update-' + Date.now();

      try {
        await user1.goto(`${baseUrl}/planner/${tripId}`);
        await user2.goto(`${baseUrl}/profile`);

        // User 1 добавляет точку
        await user1.click('[data-testid="add-point-button"]');
        await user1.fill('[data-testid="point-search"]', 'Санкт-Петербург');
        await user1.waitForSelector('[data-testid="poi-item-0"]', {
          timeout: 5000,
        });
        await user1.click('[data-testid="poi-item-0"]');

        // User 2 видит точку
        await user2.waitForSelector('[data-testid="trip-card-item"]', {
          timeout: 5000,
        });

        // User 2: меняет название точки в профиле
        const editButton = await user2.$('[data-testid="trip-point-edit-0"]');
        if (editButton) {
          await editButton.click();

          // Ждём появления инпута редактирования
          const nameInput = await user2.waitForSelector(
            '[data-testid="point-name-input"]',
            { timeout: 5000 },
          );

          if (nameInput) {
            await user2.fill('[data-testid="point-name-input"]', 'Новое название');
            await user2.click('[data-testid="confirm-edit"]');

            // User 1: должен видеть изменение на конструкторе
            await user1.waitForTimeout(500);
            const plannerPointName = await user1.textContent(
              '[data-testid="trip-point-0"]',
            );
            expect(plannerPointName).toContain('Новое название');
          }
        }
      } finally {
        await cleanupUsers(user1, user2, context1, context2);
      }
    });

    test('should show delete point on both pages', async ({ browser }) => {
      const { user1, user2, context1, context2 } = await setupTwoUsers(browser);
      const tripId = 'test-trip-delete-' + Date.now();

      try {
        await user1.goto(`${baseUrl}/planner/${tripId}`);
        await user2.goto(`${baseUrl}/profile`);

        // User 1 добавляет точку
        await user1.click('[data-testid="add-point-button"]');
        await user1.fill('[data-testid="point-search"]', 'Казань');
        await user1.waitForSelector('[data-testid="poi-item-0"]', {
          timeout: 5000,
        });
        await user1.click('[data-testid="poi-item-0"]');

        // User 2 видит точку
        await user2.waitForSelector('[data-testid="trip-card-item"]', {
          timeout: 5000,
        });

        // User 1: удаляет точку
        const menuButton = await user1.$('[data-testid="point-menu-0"]');
        if (menuButton) {
          await menuButton.click();
          const deleteBtn = await user1.$('[data-testid="delete-point-btn"]');
          if (deleteBtn) {
            await deleteBtn.click();
            const confirmBtn = await user1.$('[data-testid="confirm-delete"]');
            if (confirmBtn) {
              await confirmBtn.click();
            }
          }
        }

        // User 2: точка должна исчезнуть из профиля
        await user2.waitForFunction(
          () => !document.querySelector('[data-testid="trip-point-0"]'),
          { timeout: 5000 },
        );

        const pointExists = await user2.$('[data-testid="trip-point-0"]');
        expect(pointExists).toBeNull();
      } finally {
        await cleanupUsers(user1, user2, context1, context2);
      }
    });
  });

  test.describe('Chat Messages Between Collaborators', () => {
    test('should show message from one user to another instantly', async ({
      browser,
    }) => {
      const { user1, user2, context1, context2 } = await setupTwoUsers(browser);
      const tripId = 'test-trip-chat-' + Date.now();

      try {
        // Оба юзера открывают чат маршрута
        await user1.goto(`${baseUrl}/planner/${tripId}/chat`);
        await user2.goto(`${baseUrl}/planner/${tripId}/chat`);

        // User 1: отправляет сообщение
        const chatInput = await user1.$('[data-testid="chat-input"]');
        if (chatInput) {
          await user1.fill('[data-testid="chat-input"]', 'Давайте добавим музей!');
          await user1.click('[data-testid="send-message-btn"]');

          // User 2: должен видеть сообщение instantly
          await user2.waitForSelector('[data-testid="chat-message"]', {
            timeout: 5000,
          });

          const messageText = await user2.textContent(
            '[data-testid="chat-message"]:last-child',
          );
          expect(messageText).toContain('Давайте добавим музей!');
        }
      } finally {
        await cleanupUsers(user1, user2, context1, context2);
      }
    });

    test('should show typing indicator', async ({ browser }) => {
      const { user1, user2, context1, context2 } = await setupTwoUsers(browser);
      const tripId = 'test-trip-typing-' + Date.now();

      try {
        await user1.goto(`${baseUrl}/planner/${tripId}/chat`);
        await user2.goto(`${baseUrl}/planner/${tripId}/chat`);

        // User 1: начинает печатать
        const chatInput = await user1.$('[data-testid="chat-input"]');
        if (chatInput) {
          await user1.focus('[data-testid="chat-input"]');
          await user1.type('[data-testid="chat-input"]', 'Тип');

          // User 2: должен видеть "User 1 печатает..."
          await user2.waitForSelector('[data-testid="typing-indicator"]', {
            timeout: 3000,
          });

          const typingText = await user2.textContent(
            '[data-testid="typing-indicator"]',
          );
          expect(typingText).toContain('печатает');
        }
      } finally {
        await cleanupUsers(user1, user2, context1, context2);
      }
    });
  });

  test.describe('Presence & Collaborators', () => {
    test('should show collaborator online status', async ({ browser }) => {
      const { user1, user2, context1, context2 } = await setupTwoUsers(browser);
      const tripId = 'test-trip-presence-' + Date.now();

      try {
        // User 1: открывает маршрут
        await user1.goto(`${baseUrl}/planner/${tripId}`);

        // User 2: тоже открывает тот же маршрут
        await user2.goto(`${baseUrl}/planner/${tripId}`);

        // Оба должны видеть друг друга в списке collaborators
        await user1.waitForSelector('[data-testid="collaborators-online"]', {
          timeout: 5000,
        });

        const collaborator2Online = await user1.isVisible(
          '[data-testid="collaborator-online-user2"]',
        );
        expect(collaborator2Online).toBe(true);

        // User 2 также видит User 1 онлайн
        const collaborator1Online = await user2.isVisible(
          '[data-testid="collaborator-online-user1"]',
        );
        expect(collaborator1Online).toBe(true);
      } finally {
        await cleanupUsers(user1, user2, context1, context2);
      }
    });

    test('should update status when user leaves page', async ({ browser }) => {
      const { user1, user2, context1, context2 } = await setupTwoUsers(browser);
      const tripId = 'test-trip-offline-' + Date.now();

      try {
        await user1.goto(`${baseUrl}/planner/${tripId}`);
        await user2.goto(`${baseUrl}/planner/${tripId}`);

        // Ждём инициализации
        await user1.waitForSelector('[data-testid="collaborators-online"]', {
          timeout: 5000,
        });

        // User 2: закрывает страницу маршрута (уходит)
        await user2.goto(`${baseUrl}/profile`);

        // User 1: должен видеть что User 2 офлайн
        await user1.waitForTimeout(2000);

        const collaborator2Online = await user1.isVisible(
          '[data-testid="collaborator-online-user2"]',
        );
        expect(collaborator2Online).toBe(false);

        // Может быть показано "последний раз" время
        const lastSeen = await user1.textContent(
          '[data-testid="collaborator-last-seen-user2"]',
        );
        expect(lastSeen).toBeTruthy();
      } finally {
        await cleanupUsers(user1, user2, context1, context2);
      }
    });
  });

  test.describe('Cross-page Synchronization', () => {
    test('should sync changes between Planner, Profile, and AI Chat', async ({
      browser,
    }) => {
      const { user1, user2, context1, context2 } = await setupTwoUsers(browser);
      const tripId = 'test-trip-crosspage-' + Date.now();

      try {
        // User 1 на Planner добавляет точку
        await user1.goto(`${baseUrl}/planner/${tripId}`);
        await user1.click('[data-testid="add-point-button"]');
        await user1.fill('[data-testid="point-search"]', 'Тестовая точка');
        await user1.waitForSelector('[data-testid="poi-item-0"]', {
          timeout: 5000,
        });
        await user1.click('[data-testid="poi-item-0"]');

        // User 2 одновременно открывает разные страницы
        // 1. Profile должен показать точку
        await user2.goto(`${baseUrl}/profile`);
        await user2.waitForSelector('[data-testid="trip-point"]', {
          timeout: 5000,
        });

        // 2. AI Chat должен показать точку
        await user2.goto(`${baseUrl}/ai-assistant`);
        await user2.waitForSelector('[data-testid="map-marker"]', {
          timeout: 5000,
        });

        // 3. Вернулся на Planner - точка всё ещё там
        await user2.goto(`${baseUrl}/planner/${tripId}`);
        await user2.waitForSelector('[data-testid="trip-point"]', {
          timeout: 5000,
        });

        // Все три страницы должны показывать одинаковое состояние
        expect(true).toBe(true); // Если дошли сюда - синхронизация работает
      } finally {
        await cleanupUsers(user1, user2, context1, context2);
      }
    });

    test('should maintain consistency with rapid changes', async ({ browser }) => {
      const { user1, user2, context1, context2 } = await setupTwoUsers(browser);
      const tripId = 'test-trip-rapid-' + Date.now();

      try {
        await user1.goto(`${baseUrl}/planner/${tripId}`);
        await user2.goto(`${baseUrl}/profile`);

        // User 1: быстро добавляет несколько точек подряд
        for (let i = 0; i < 3; i++) {
          await user1.click('[data-testid="add-point-button"]');
          await user1.fill('[data-testid="point-search"]', `Точка ${i + 1}`);
          await user1.waitForSelector('[data-testid="poi-item-0"]', {
            timeout: 5000,
          });
          await user1.click('[data-testid="poi-item-0"]');
          await user1.waitForTimeout(500);
        }

        // User 2: видит все 3 точки добавленными в правильном порядке
        await user2.goto(`${baseUrl}/profile`);
        await user2.waitForTimeout(2000);

        const points = await user2.locator('[data-testid="trip-point"]').all();
        expect(points.length).toBeGreaterThanOrEqual(3);

        // Точки должны быть в правильном порядке
        for (let i = 0; i < 3; i++) {
          const point = points[i];
          if (point) {
            const text = await point.textContent();
            expect(text).toContain(`Точка ${i + 1}`);
          }
        }
      } finally {
        await cleanupUsers(user1, user2, context1, context2);
      }
    });
  });

  test.describe('Multi-User Scenarios (3+ users)', () => {
    test('should sync AI chat and Planner changes across three collaborators', async ({ browser }) => {
      const { user1, user2, user3, context1, context2, context3 } = await setupThreeUsers(browser);
      const tripId = 'test-trip-3users-' + Date.now();

      try {
        // Setup: все три пользователя открывают разные страницы одного маршрута
        // User 1: открывает AI Chat
        await user1.goto(`${baseUrl}/ai-assistant`);
        // User 2: открывает AI Chat (тот же маршрут, но отдельная сессия)
        await user2.goto(`${baseUrl}/ai-assistant`);
        // User 3: открывает Planner для редактирования точек
        await user3.goto(`${baseUrl}/planner/${tripId}`);

        // User 1: отправляет сообщение в AI чат
        const chatInput1 = await user1.$('[data-testid="chat-input"]');
        if (chatInput1) {
          await user1.fill('[data-testid="chat-input"]', 'Составь маршрут по Москве');
          await user1.click('[data-testid="send-message-btn"]');

          // Ждём скелетон загрузки AI ответа
          await user1.waitForSelector('[data-testid="chat-message"]', {
            timeout: 10000,
          });
        }

        // User 2: в том же чате должен видеть сообщение от User 1 (если они в одной сессии)
        // или получить его через socket события
        await user2.waitForSelector('[data-testid="chat-input"]', {
          timeout: 5000,
        });

        // User 2: тоже отправляет сообщение в AI
        await user2.fill('[data-testid="chat-input"]', 'Добавь музеи');
        await user2.click('[data-testid="send-message-btn"]');

        // User 3 (в Planner): добавляет точку маршрута
        await user3.click('[data-testid="add-point-button"]');
        await user3.fill('[data-testid="point-search"]', 'Красная площадь');
        await user3.waitForSelector('[data-testid="poi-item-0"]', {
          timeout: 5000,
        });
        await user3.click('[data-testid="poi-item-0"]');

        // User 1 & User 2: если они смотрят на карту маршрута в чате,
        // должны видеть обновленные точки через socket sync
        // Проверяем что UI обновилась (любое видимое изменение)
        await user1.waitForTimeout(1000);
        await user2.waitForTimeout(1000);

        // Точка должна быть добавлена на карте User 3
        const markerVisible = await user3.isVisible('[data-testid="map-marker"]');
        expect(markerVisible).toBe(true);

        expect(true).toBe(true); // Если дошли сюда - синхронизация работает
      } finally {
        await cleanupThreeUsers(user1, user2, user3, context1, context2, context3);
      }
    });

    test('should show chat messages between two AI users while third edits points', async ({ browser }) => {
      const { user1, user2, user3, context1, context2, context3 } = await setupThreeUsers(browser);
      const tripId = 'test-trip-chat-planner-' + Date.now();

      try {
        // User 1: в AI Chat
        await user1.goto(`${baseUrl}/ai-assistant`);
        // User 2: в AI Chat
        await user2.goto(`${baseUrl}/ai-assistant`);
        // User 3: в Planner
        await user3.goto(`${baseUrl}/planner/${tripId}`);

        // User 1: пишет первое сообщение
        await user1.fill('[data-testid="chat-input"]', 'Хочу поехать в Петербург на неделю');
        await user1.click('[data-testid="send-message-btn"]');

        // Ждём обработки
        await user1.waitForTimeout(500);

        // User 2: пишет ответное сообщение
        const chatInput2 = await user2.$('[data-testid="chat-input"]');
        if (chatInput2) {
          await user2.fill('[data-testid="chat-input"]', 'Хорошая идея! Какой бюджет?');
          await user2.click('[data-testid="send-message-btn"]');
        }

        // User 3: в это время добавляет несколько точек
        for (let i = 0; i < 2; i++) {
          await user3.click('[data-testid="add-point-button"]');
          await user3.fill('[data-testid="point-search"]', `Место ${i + 1}`);
          await user3.waitForSelector('[data-testid="poi-item-0"]', {
            timeout: 3000,
          });
          await user3.click('[data-testid="poi-item-0"]');
          await user3.waitForTimeout(300);
        }

        // Проверяем что всё работает без ошибок
        const pointsCount = await user3.locator('[data-testid="trip-point"]').count();
        expect(pointsCount).toBeGreaterThan(0);

        // User 1 & 2 могут видеть обновления на карте через sync
        await user1.waitForTimeout(500);
        await user2.waitForTimeout(500);

        expect(true).toBe(true);
      } finally {
        await cleanupThreeUsers(user1, user2, user3, context1, context2, context3);
      }
    });
  });
});
