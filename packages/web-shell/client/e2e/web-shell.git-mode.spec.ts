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

test('git mode chip shows popover with three modes and captures screenshots', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario();
  const daemon = await installScenario(
    page,
    scenario,
    String(testInfo.project.use.baseURL),
  );

  await page.goto('/');

  // Wait for the git mode chip to appear in the composer toolbar
  const chip = page.locator('[data-testid="git-mode-chip"]');
  await expect(chip).toBeVisible({ timeout: 10_000 });

  // Screenshot 1: default state with git chip
  await page.screenshot({
    path: 'client/e2e/test-results/git-mode-1-default.png',
    animations: 'disabled',
  });

  // Click the chip to open the popover
  await chip.click();

  // Wait for the popover to appear
  const popover = page.locator('[data-slot="popover-content"]');
  await expect(popover).toBeVisible({ timeout: 5_000 });

  // Screenshot 2: popover open showing three modes
  await page.screenshot({
    path: 'client/e2e/test-results/git-mode-2-popover.png',
    animations: 'disabled',
  });

  // Click "New branch" option
  const branchOption = popover.getByText('New branch', { exact: false });
  await branchOption.click();

  // Wait for the branch input to appear
  const branchInput = page.locator('[data-testid="git-mode-branch-input"]');
  await expect(branchInput).toBeVisible({ timeout: 5_000 });

  // Type a branch name
  await branchInput.fill('feat/git-mode-selector');

  // Screenshot 3: branch input with valid name
  await page.screenshot({
    path: 'client/e2e/test-results/git-mode-3-branch-input.png',
    animations: 'disabled',
  });

  // Confirm the branch selection
  const confirmBtn = page.locator('[data-testid="git-mode-confirm-branch"]');
  await expect(confirmBtn).toBeEnabled();
  await confirmBtn.click();

  // Popover should close, chip should show the branch name
  await expect(popover).not.toBeVisible();
  await expect(chip).toContainText('feat/git-mode-selector');

  // Screenshot 4: chip showing selected branch
  await page.screenshot({
    path: 'client/e2e/test-results/git-mode-4-branch-selected.png',
    animations: 'disabled',
  });

  // Send a message and verify the branch is passed to the daemon
  await fillComposer(page, 'implement the feature');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => sessionCreateBody(daemon) !== undefined).toBe(true);
  expect(sessionCreateBody(daemon)?.['branch']).toEqual({
    name: 'feat/git-mode-selector',
  });
  expect(sessionCreateBody(daemon)?.['worktree']).toBeUndefined();
});

test('git mode chip worktree mode sends worktree intent', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario();
  const daemon = await installScenario(
    page,
    scenario,
    String(testInfo.project.use.baseURL),
  );

  await page.goto('/');

  const chip = page.locator('[data-testid="git-mode-chip"]');
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await chip.click();

  const popover = page.locator('[data-slot="popover-content"]');
  await expect(popover).toBeVisible({ timeout: 5_000 });

  // Click "Worktree" option
  const worktreeOption = popover.getByText('Worktree', { exact: false });
  await worktreeOption.click();

  // Confirm worktree selection
  const confirmBtn = page.locator('[data-testid="git-mode-confirm-worktree"]');
  await expect(confirmBtn).toBeVisible();
  await confirmBtn.click();

  await expect(popover).not.toBeVisible();

  // Send a message and verify worktree is passed
  await fillComposer(page, 'worktree task');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => sessionCreateBody(daemon) !== undefined).toBe(true);
  expect(sessionCreateBody(daemon)?.['worktree']).toEqual({});
  expect(sessionCreateBody(daemon)?.['branch']).toBeUndefined();
});

test('git mode chip clear button resets to current branch', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario();
  await installScenario(page, scenario, String(testInfo.project.use.baseURL));

  await page.goto('/');

  const chip = page.locator('[data-testid="git-mode-chip"]');
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await chip.click();

  const popover = page.locator('[data-slot="popover-content"]');
  await expect(popover).toBeVisible({ timeout: 5_000 });

  // Select branch mode
  await popover.getByText('New branch', { exact: false }).click();
  const branchInput = page.locator('[data-testid="git-mode-branch-input"]');
  await branchInput.fill('feat/temp');
  await page.locator('[data-testid="git-mode-confirm-branch"]').click();
  await expect(popover).not.toBeVisible();

  // Chip should show the branch and have a clear button
  await expect(chip).toContainText('feat/temp');
  const clearBtn = page.locator('[data-testid="git-mode-clear"]');
  await expect(clearBtn).toBeVisible();

  // Click clear to reset
  await clearBtn.click();
  await expect(chip).toContainText('main');
  await expect(clearBtn).not.toBeVisible();
});

test('git mode chip is hidden when workspace is not a git repo', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario({ gitStatus: undefined });
  const daemon = await installScenario(
    page,
    scenario,
    String(testInfo.project.use.baseURL),
  );

  await page.goto('/');

  // Wait for git status request to complete
  await expect
    .poll(() =>
      daemon.requests.some((r) => /^\/workspaces\/.+\/git/.test(r.path)),
    )
    .toBe(true);

  // Git mode chip should not be visible (falls back to regular branch indicator)
  await expect(page.locator('[data-testid="git-mode-chip"]')).toHaveCount(0);
});
