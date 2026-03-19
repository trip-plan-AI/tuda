import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';

/**
 * E2E тесты для Last-Write-Wins (LWW) разрешения конфликтов
 *
 * Проверяют что последнее обновление точки побеждает благодаря сравнению timestamp
 */

test.describe('Last-Write-Wins Conflict Resolution', () => {
  const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3000';

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

  test('LWW: User with newer timestamp wins', async ({ browser }) => {
    const { user1, user2, context1, context2 } = await setupTwoUsers(browser);
    const tripId = 'test-lww-' + Date.now();

    try {
      // Setup: both users open same planner
      await user1.goto(`${baseUrl}/planner/${tripId}`);
      await user2.goto(`${baseUrl}/planner/${tripId}`);

      // Add initial point
      await user1.click('[data-testid="add-point-button"]');
      await user1.fill('[data-testid="point-search"]', 'Москва');
      await user1.waitForSelector('[data-testid="poi-item-0"]', { timeout: 5000 });
      await user1.click('[data-testid="poi-item-0"]');

      // Wait for sync
      await user2.waitForTimeout(1000);

      // ⏱️ SCENARIO: Concurrent edits with timestamp comparison
      // User 1: Changes name to "Kremlin" (time T1)
      const editBtn1 = await user1.$('[data-testid="trip-point-edit-0"]');
      if (editBtn1) {
        await editBtn1.click();
        const nameInput1 = await user1.waitForSelector(
          '[data-testid="point-name-input"]',
          { timeout: 3000 }
        );
        if (nameInput1) {
          await user1.fill('[data-testid="point-name-input"]', 'Kremlin');
          // Don't click confirm yet - let user2 send update first
        }
      }

      // User 2: Changes name to "Red Square" (time T2, T2 < T1)
      const editBtn2 = await user2.$('[data-testid="trip-point-edit-0"]');
      if (editBtn2) {
        await editBtn2.click();
        const nameInput2 = await user2.waitForSelector(
          '[data-testid="point-name-input"]',
          { timeout: 3000 }
        );
        if (nameInput2) {
          await user2.fill('[data-testid="point-name-input"]', 'Red Square');
          await user2.click('[data-testid="confirm-edit"]');
        }
      }

      // Now User1 confirms (T1 > T2, should win)
      if (editBtn1) {
        await user1.click('[data-testid="confirm-edit"]');
      }

      // Wait for sync
      await user1.waitForTimeout(1500);
      await user2.waitForTimeout(1500);

      // ✅ VERIFICATION: User 1's edit should win because it has newer timestamp
      const finalName1 = await user1.textContent('[data-testid="trip-point-0"]');
      const finalName2 = await user2.textContent('[data-testid="trip-point-0"]');

      console.log('LWW Test Results:');
      console.log(`  User 1 sees: "${finalName1}"`);
      console.log(`  User 2 sees: "${finalName2}"`);
      console.log(`  Consistent? ${finalName1 === finalName2}`);

      // Both should see the same final value (User 1's change)
      expect(finalName1).toContain('Kremlin');
      expect(finalName2).toContain('Kremlin');
    } finally {
      await cleanupUsers(user1, user2, context1, context2);
    }
  });

  test('LWW: Multiple concurrent updates converge', async ({ browser }) => {
    const { user1, user2, context1, context2 } = await setupTwoUsers(browser);
    const tripId = 'test-lww-multi-' + Date.now();

    try {
      await user1.goto(`${baseUrl}/planner/${tripId}`);
      await user2.goto(`${baseUrl}/planner/${tripId}`);

      // Add point
      await user1.click('[data-testid="add-point-button"]');
      await user1.fill('[data-testid="point-search"]', 'Санкт-Петербург');
      await user1.waitForSelector('[data-testid="poi-item-0"]', { timeout: 5000 });
      await user1.click('[data-testid="poi-item-0"]');

      await user2.waitForTimeout(1000);

      // Rapid concurrent edits
      const editBtn1 = await user1.$('[data-testid="trip-point-edit-0"]');
      const editBtn2 = await user2.$('[data-testid="trip-point-edit-0"]');

      if (editBtn1) {
        await editBtn1.click();
        await user1.fill('[data-testid="point-name-input"]', 'Final Name from User1');
      }

      if (editBtn2) {
        await editBtn2.click();
        await user2.fill('[data-testid="point-name-input"]', 'Name from User2');
        await user2.click('[data-testid="confirm-edit"]');
      }

      // User1 confirms after User2
      if (editBtn1) {
        await user1.click('[data-testid="confirm-edit"]');
      }

      await user1.waitForTimeout(1500);
      await user2.waitForTimeout(1500);

      // Final state should be consistent on both clients
      const name1 = await user1.textContent('[data-testid="trip-point-0"]');
      const name2 = await user2.textContent('[data-testid="trip-point-0"]');

      console.log('Convergence Test:');
      console.log(`  User 1: "${name1}"`);
      console.log(`  User 2: "${name2}"`);
      console.log(`  Converged? ${name1 === name2}`);

      // Must converge to same value
      expect(name1).toBe(name2);
    } finally {
      await cleanupUsers(user1, user2, context1, context2);
    }
  });

  test('LWW: Stale updates are ignored', async ({ browser }) => {
    const { user1, user2, context1, context2 } = await setupTwoUsers(browser);
    const tripId = 'test-lww-stale-' + Date.now();

    try {
      await user1.goto(`${baseUrl}/planner/${tripId}`);
      await user2.goto(`${baseUrl}/planner/${tripId}`);

      // Add point
      await user1.click('[data-testid="add-point-button"]');
      await user1.fill('[data-testid="point-search"]', 'Казань');
      await user1.waitForSelector('[data-testid="poi-item-0"]', { timeout: 5000 });
      await user1.click('[data-testid="poi-item-0"]');

      await user2.waitForTimeout(1000);

      // User 1: Edit first
      const editBtn1 = await user1.$('[data-testid="trip-point-edit-0"]');
      if (editBtn1) {
        await editBtn1.click();
        await user1.fill('[data-testid="point-name-input"]', 'Recent Change');
        await user1.click('[data-testid="confirm-edit"]');
      }

      // Wait for User1's change to propagate
      await user2.waitForTimeout(800);

      // User 2: Edit with older timestamp (network delay simulation)
      // This update should be ignored by LWW because User1's timestamp is newer
      const editBtn2 = await user2.$('[data-testid="trip-point-edit-0"]');
      if (editBtn2) {
        await editBtn2.click();
        await user2.fill('[data-testid="point-name-input"]', 'Stale Update');
        await user2.click('[data-testid="confirm-edit"]');
      }

      await user1.waitForTimeout(1500);

      // User1's recent change should still be there (stale update ignored)
      const finalName = await user1.textContent('[data-testid="trip-point-0"]');

      console.log('Stale Update Test:');
      console.log(`  Final name: "${finalName}"`);
      console.log(`  Stale update ignored? ${finalName?.includes('Recent')}`);

      expect(finalName).toContain('Recent Change');
    } finally {
      await cleanupUsers(user1, user2, context1, context2);
    }
  });
});
