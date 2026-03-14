import { test, expect, type Page, type ConsoleMessage, type Request, type Response } from '@playwright/test';

type RuntimeIssue = {
  kind: 'console' | 'network';
  message: string;
};

const VISUAL_PAGES = [
  { route: '/planner', screenshot: 'planner.png' },
  { route: '/profile', screenshot: 'profile.png' },
  { route: '/ai-assistant', screenshot: 'ai-assistant.png' },
  { route: '/tours/1', screenshot: 'tours-1.png' },
] as const;

const CRITICAL_RESOURCE_TYPES = new Set(['document', 'script', 'stylesheet', 'fetch', 'xhr']);
const VISUAL_STABILIZATION_STYLE = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
  }

  [data-nextjs-dev-tools-button],
  [data-nextjs-toast],
  [data-nextjs-toast-errors-parent],
  [data-nextjs-dialog],
  [data-next-badge-root],
  #nextjs-devtools,
  #next-devtools-container {
    display: none !important;
    opacity: 0 !important;
    visibility: hidden !important;
    pointer-events: none !important;
  }
`;

function isCriticalConsoleError(msg: ConsoleMessage) {
  if (msg.type() !== 'error') return false;

  const text = msg.text().toLowerCase();
  // Игнорируем шум, не влияющий на TRI-111 runtime-валидацию.
  const ignoredFragments = [
    'favicon.ico',
    'chrome-extension://',
    'sourcemap',
    'hydration',
    'hydrated but some attributes of the server rendered html didn\'t match',
  ];
  return !ignoredFragments.some((fragment) => text.includes(fragment));
}

function installRuntimeWatchers(page: Page) {
  const issues: RuntimeIssue[] = [];

  page.on('console', (msg) => {
    if (!isCriticalConsoleError(msg)) return;
    issues.push({ kind: 'console', message: msg.text() });
  });

  page.on('requestfailed', (request: Request) => {
    if (!CRITICAL_RESOURCE_TYPES.has(request.resourceType())) return;

    const url = request.url().toLowerCase();
    if (url.includes('api-maps.yandex.ru')) return;

    issues.push({
      kind: 'network',
      message: `requestfailed ${request.resourceType()} ${request.url()} :: ${request.failure()?.errorText ?? 'unknown error'}`,
    });
  });

  page.on('response', (response: Response) => {
    const request = response.request();
    const type = request.resourceType();
    const status = response.status();

    if (!CRITICAL_RESOURCE_TYPES.has(type)) return;
    if (status < 400) return;

    const url = response.url();
    const currentOrigin = new URL(page.url()).origin;
    const responseOrigin = new URL(url).origin;
    const isSameOrigin = responseOrigin === currentOrigin;

    // Для L3 считаем критичными обязательные ресурсы текущего приложения.
    if (!isSameOrigin) return;

    issues.push({
      kind: 'network',
      message: `response ${status} ${type} ${url}`,
    });
  });

  return issues;
}

async function gotoWithReadyState(page: Page, route: string) {
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(new RegExp(route.replace('/', '\\/')));
  await expect(page.getByTestId('desktop-content-pane')).toBeVisible({ timeout: 20_000 });
}

async function stabilizeVisualState(page: Page) {
  await page.addStyleTag({ content: VISUAL_STABILIZATION_STYLE });
  await page.evaluate(() => {
    const selectors = [
      '[data-nextjs-dev-tools-button]',
      '[data-nextjs-toast]',
      '[data-nextjs-toast-errors-parent]',
      '[data-nextjs-dialog]',
      '[data-next-badge-root]',
      '#nextjs-devtools',
      '#next-devtools-container',
    ];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((el) => el.remove());
    }
  });
  await page.waitForTimeout(200);
}

test.describe('TRI-111 L3 visual regression + runtime checks', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('accessToken', 'e2e-token');
    });

    await page.context().addCookies([
      {
        name: 'token',
        value: 'e2e-token',
        domain: '127.0.0.1',
        path: '/',
      },
    ]);

    await page.setViewportSize({ width: 1440, height: 900 });
  });

  for (const target of VISUAL_PAGES) {
    test(`L3 ${target.route}: visual baseline/compare + runtime`, async ({ page }) => {
      const issues = installRuntimeWatchers(page);

      await gotoWithReadyState(page, target.route);
      await stabilizeVisualState(page);

      const maskLocators = [
        page.getByTestId('desktop-map-pane'),
        page.getByTestId('mobile-map-layer'),
        page.getByRole('button', { name: /open next\.js dev tools/i }),
        page.getByRole('button', { name: /open issues overlay/i }),
      ];

      await expect(page).toHaveScreenshot(target.screenshot, {
        fullPage: true,
        animations: 'disabled',
        mask: maskLocators,
        maxDiffPixelRatio: 0.02,
      });

      const criticalIssues = issues.map((issue) => `${issue.kind}: ${issue.message}`);
      expect(criticalIssues, `Критичные runtime-проблемы на маршруте ${target.route}`).toEqual([]);
    });
  }
});
