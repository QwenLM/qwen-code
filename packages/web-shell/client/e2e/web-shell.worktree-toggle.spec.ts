import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const WORKSPACE_CWD = '/tmp/qwen-web-shell-e2e';

function createGitWorkspaceScenario(
  overrides: Parameters<typeof createWebShellDaemonScenario>[0] = {},
): WebShellDaemonScenario {
  return createWebShellDaemonScenario({
    capabilities: {
      workspaces: [
        { id: 'primary', cwd: WORKSPACE_CWD, primary: true, trusted: true },
      ],
    },
    gitStatus: { v: 2, workspaceCwd: WORKSPACE_CWD, branch: 'main' },
    ...overrides,
  });
}

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  baseURL: string,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, { baseURL });
}

async function fillComposer(page: Page, text: string): Promise<void> {
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+A' : 'Control+A',
  );
  await page.keyboard.type(text);
}

function sessionCreateBody(
  daemon: MockDaemonController,
): Record<string, unknown> | undefined {
  const record = daemon.requests.find(
    (r) => r.method === 'POST' && r.path === '/session',
  );
  return record?.body as Record<string, unknown> | undefined;
}

test('enabling the worktree toggle sends worktree intent on session creation', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario();
  const daemon = await installScenario(
    page,
    scenario,
    String(testInfo.project.use.baseURL),
  );

  await page.goto('/');
  const toggle = page.locator('[data-testid="worktree-welcome-toggle"]');
  await expect(toggle).toBeVisible();
  await toggle.click();

  await expect(
    page.locator('[data-testid="worktree-welcome-cancel"]'),
  ).toBeVisible();
  await expect(toggle).toHaveCount(0);

  await fillComposer(page, 'ping from worktree toggle');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => sessionCreateBody(daemon) !== undefined).toBe(true);
  expect(sessionCreateBody(daemon)?.['worktree']).toEqual({});
});

test('cancelling the toggle omits worktree on session creation', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario();
  const daemon = await installScenario(
    page,
    scenario,
    String(testInfo.project.use.baseURL),
  );

  await page.goto('/');
  const toggle = page.locator('[data-testid="worktree-welcome-toggle"]');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await page.locator('[data-testid="worktree-welcome-cancel"]').click();
  await expect(toggle).toBeVisible();

  await fillComposer(page, 'ping after cancel');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => sessionCreateBody(daemon) !== undefined).toBe(true);
  expect(sessionCreateBody(daemon)?.['worktree']).toBeUndefined();
});

test('toggle is hidden when the workspace is not a git repository', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario({ gitStatus: undefined });
  const daemon = await installScenario(
    page,
    scenario,
    String(testInfo.project.use.baseURL),
  );

  await page.goto('/');
  // Wait until the git status round-trip settles before asserting absence.
  await expect
    .poll(() =>
      daemon.requests.some((r) => /^\/workspaces\/.+\/git/.test(r.path)),
    )
    .toBe(true);
  await expect(
    page.locator('[data-testid="worktree-welcome-toggle"]'),
  ).toHaveCount(0);
});
