import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },

  // Параллельное выполнение
  fullyParallel: true,
  workers: process.env.CI ? 1 : undefined, // 1 worker в CI, остальное - auto

  // Повторы при сбое
  retries: process.env.CI ? 2 : 0,

  // Репортеры
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/e2e-results.json' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],

  // Общие настройки браузеров
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
  },

  // Запуск dev сервера
  webServer: {
    command: 'pnpm exec next dev -H 127.0.0.1 -p 3000',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: false,
    timeout: 300_000,
  },

  // Проекты (браузеры)
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        viewport: { width: 1280, height: 720 },
      },
    },
  ],
});
