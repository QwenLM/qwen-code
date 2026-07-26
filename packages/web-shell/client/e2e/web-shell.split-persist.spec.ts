import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const WORKSPACE_CWD = '/tmp/qwen-web-shell-e2e';
const MAIN_SESSION = 'split-main-session';
const SESSION_A = 'split-session-a';
const SESSION_B = 'split-session-b';
const STORAGE_KEY = 'qwen-webshell-split-sessions';

function createSplitScenario(): WebShellDaemonScenario {
  const at = '2026-07-03T00:00:00.000Z';
  return createWebShellDaemonScenario({
    workspaceCwd: WORKSPACE_CWD,
    sessionId: MAIN_SESSION,
    sessions: [
      {
        sessionId: MAIN_SESSION,
        workspaceCwd: WORKSPACE_CWD,
        createdAt: at,
        updatedAt: at,
        displayName: 'Main Session',
        clientCount: 1,
        hasActivePrompt: false,
      },
      {
        sessionId: SESSION_A,
        workspaceCwd: WORKSPACE_CWD,
        createdAt: at,
        updatedAt: at,
        displayName: 'Session A',
        clientCount: 0,
        hasActivePrompt: false,
      },
      {
        sessionId: SESSION_B,
        workspaceCwd: WORKSPACE_CWD,
        createdAt: at,
        updatedAt: at,
        displayName: 'Session B',
        clientCount: 0,
        hasActivePrompt: false,
      },
    ],
  });
}

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
}

test('restores the split across a reload and isolates it per tab @smoke', async ({
  page,
  context,
}, testInfo) => {
  // Wide viewport so the split stays unfolded (it folds below the large-screen
  // breakpoint).
  await page.setViewportSize({ width: 1440, height: 900 });

  const scenario = createSplitScenario();
  await installScenario(page, scenario, testInfo);

  // Open the split via the deep link — the exact URL "open in new tab" produces
  // (path reset to `/`, sessions in `?split=`).
  await page.goto(`/?split=${SESSION_A},${SESSION_B}`);

  const split = page.locator('[data-testid="split-view"]');
  await expect(split).toBeVisible();
  await expect(page.locator('[data-testid="chat-pane"]')).toHaveCount(2);

  // The session set lands in per-tab storage…
  await expect
    .poll(async () =>
      page.evaluate((key) => window.sessionStorage.getItem(key), STORAGE_KEY),
    )
    .toBe(JSON.stringify([SESSION_A, SESSION_B]));

  // …and the one-shot deep-link param is consumed so a bookmark isn't sticky.
  await expect.poll(async () => new URL(page.url()).search).toBe('');

  // Reload (URL is now bare `/`): the split comes back from storage.
  await page.reload();
  await expect(page.locator('[data-testid="split-view"]')).toBeVisible();
  await expect(page.locator('[data-testid="chat-pane"]')).toHaveCount(2);

  // A brand-new tab has its own sessionStorage, so it must NOT inherit tab 1's
  // split. (If persistence used localStorage, this tab would wrongly reopen it.)
  const page2 = await context.newPage();
  await page2.setViewportSize({ width: 1440, height: 900 });
  await installScenario(page2, scenario, testInfo);
  await page2.goto(`/session/${MAIN_SESSION}`);
  await expect(page2.locator('[data-web-shell-root]')).toBeVisible();
  await expect(page2.locator('[data-testid="split-view"]')).toHaveCount(0);
});

test('leaving the split clears storage so a refresh does not restore it', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const scenario = createSplitScenario();
  await installScenario(page, scenario, testInfo);

  await page.goto(`/?split=${SESSION_A},${SESSION_B}`);
  await expect(page.locator('[data-testid="split-view"]')).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate((key) => window.sessionStorage.getItem(key), STORAGE_KEY),
    )
    .toBe(JSON.stringify([SESSION_A, SESSION_B]));

  // Leave via the split's back button.
  await page
    .locator('[data-testid="split-view"] header button')
    .first()
    .click();
  await expect(page.locator('[data-testid="split-view"]')).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate((key) => window.sessionStorage.getItem(key), STORAGE_KEY),
    )
    .toBeNull();

  // A refresh now lands on the normal view, not the split.
  await page.reload();
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await expect(page.locator('[data-testid="split-view"]')).toHaveCount(0);
});
