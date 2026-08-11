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

test('git mode chip shows popover with four modes and captures screenshots', async ({
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

  // Screenshot 2: popover open showing four modes
  await page.screenshot({
    path: 'client/e2e/test-results/git-mode-2-popover.png',
    animations: 'disabled',
  });

  // Click "New branch" option (match by role: the option's text is split
  // across a name + description span, so getByText('New branch') is ambiguous)
  await popover.getByRole('radio', { name: /New branch/ }).click();

  // Wait for the branch input to appear
  const branchInput = page.locator('[data-testid="git-mode-branch-input"]');
  await expect(branchInput).toBeVisible({ timeout: 5_000 });
  // Regression guard: clicking an option used to steal focus to the composer
  // (via the surface onClick bubbling through the portal), dismissing the
  // popover ~100ms after the input flashed visible. Assert it stays open.
  await expect(branchInput).toBeVisible();
  await page.waitForTimeout(300);
  await expect(popover).toBeVisible();
  await expect(branchInput).toBeVisible();

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

test('git mode chip checks out an existing branch', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario({
    gitBranches: {
      v: 1,
      workspaceCwd: WORKSPACE_CWD,
      available: true,
      local: [
        { name: 'main', isHead: true },
        { name: 'topic', isHead: false },
      ],
      remote: [{ name: 'origin/develop', isHead: false }],
      tags: [],
      recent: [],
      head: 'main',
      detached: false,
    },
  });
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
  await popover.getByRole('radio', { name: /Existing branch/ }).click();

  const list = popover.getByRole('listbox', { name: 'Existing branch' });
  await expect(list.getByRole('option')).toHaveCount(2);
  await expect(list.getByRole('option', { name: 'main' })).toHaveCount(0);

  await popover
    .getByRole('textbox', { name: 'Search branches…' })
    .fill('origin');
  await expect(list.getByRole('option')).toHaveCount(1);
  // Match the workspace-scoped route exactly: the legacy process-scoped
  // checkout would mutate the bound workspace instead of the session's
  // resolved runtime, and the mock daemon answers both identically.
  const gitStatusRequests = () =>
    daemon.requests.filter(
      (request) =>
        request.method === 'GET' &&
        /^\/workspaces\/[^/]+\/git\/?$/.test(request.path),
    ).length;
  // Capture the baseline BEFORE the checkout click: the success path fires
  // the git-status refetch within milliseconds (the same commit that closes
  // the popover), while waiting for the popover to close resolves late — a
  // baseline taken after that wait already includes the follow-up requests
  // and the increase poll below can never fire.
  const statusCallsAtCheckout = gitStatusRequests();
  await list.getByRole('option', { name: 'origin/develop' }).click();

  await expect(popover).not.toBeVisible();
  await expect
    .poll(() =>
      daemon.requests.find(
        (request) =>
          request.method === 'POST' &&
          /^\/workspaces\/[^/]+\/git\/checkout\/?$/.test(request.path),
      ),
    )
    .toMatchObject({ body: { ref: 'origin/develop' } });
  // Quiescence: the checkout success path bumps the git-status revision,
  // which fires follow-up status fetches; wait for them to land before
  // asserting no session was created, so a late session-create riding the
  // same effect chain cannot slip past the negative assertion.
  await expect
    .poll(() => gitStatusRequests())
    .toBeGreaterThan(statusCallsAtCheckout);
  expect(sessionCreateBody(daemon)).toBeUndefined();
});

test('existing branch groups collapse and stay pinned while scrolling', async ({
  page,
}, testInfo) => {
  const scenario = createGitWorkspaceScenario({
    gitBranches: {
      v: 1,
      workspaceCwd: WORKSPACE_CWD,
      available: true,
      local: [
        { name: 'main', isHead: true },
        ...Array.from({ length: 12 }, (_, index) => ({
          name: `topic-${index + 1}`,
          isHead: false,
        })),
      ],
      remote: [{ name: 'origin/develop', isHead: false }],
      tags: [],
      recent: [],
      head: 'main',
      detached: false,
    },
  });
  await installScenario(page, scenario, String(testInfo.project.use.baseURL));

  await page.goto('/');
  await page.locator('[data-testid="git-mode-chip"]').click();

  const popover = page.locator('[data-slot="popover-content"]');
  await popover.getByRole('radio', { name: /Existing branch/ }).click();

  const list = popover.getByRole('listbox', { name: 'Existing branch' });
  const localGroup = list.getByRole('button', { name: 'Local', exact: true });
  await expect(localGroup).toHaveAttribute('aria-expanded', 'true');

  await localGroup.click();
  await expect(localGroup).toHaveAttribute('aria-expanded', 'false');
  await expect(list.getByRole('option')).toHaveCount(1);

  const search = popover.getByRole('textbox', { name: 'Search branches…' });
  await search.fill('topic-1');
  await expect(localGroup).toHaveAttribute('aria-expanded', 'true');
  await expect(list.getByRole('option')).toHaveCount(4);
  await search.fill('');
  await expect(localGroup).toHaveAttribute('aria-expanded', 'false');

  await localGroup.click();
  await list.evaluate((element) => {
    element.scrollTop = 60;
  });
  // If the list ever stops being scrollable the assignment silently clamps
  // to 0 and the pinned-header assertion below would pass vacuously.
  expect(await list.evaluate((element) => element.scrollTop)).toBe(60);
  const listBounds = await list.boundingBox();
  const groupBounds = await localGroup.boundingBox();
  const listPaddingTop = await list.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).paddingTop),
  );
  expect(listBounds).not.toBeNull();
  expect(groupBounds).not.toBeNull();
  expect(
    Math.abs((groupBounds?.y ?? 0) - ((listBounds?.y ?? 0) + listPaddingTop)),
  ).toBeLessThanOrEqual(1);
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

  // Click "Worktree" option (match by role; see the branch test above)
  await popover.getByRole('radio', { name: /Worktree/ }).click();

  // Confirm worktree selection
  const confirmBtn = page.locator('[data-testid="git-mode-confirm-worktree"]');
  await expect(confirmBtn).toBeVisible();
  // Regression guard: same focus-steal dismissal as the branch test — the
  // confirm button flashed visible, then the popover closed before it could
  // be clicked. Assert the popover survives the click.
  await page.waitForTimeout(300);
  await expect(popover).toBeVisible();
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

test('git mode chip default current-branch mode sends neither branch nor worktree', async ({
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
  // Leave the git mode intent at its default (current branch): do not open
  // the popover or select branch/worktree before submitting.

  await fillComposer(page, 'plain task on current branch');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => sessionCreateBody(daemon) !== undefined).toBe(true);
  expect(sessionCreateBody(daemon)?.['branch']).toBeUndefined();
  expect(sessionCreateBody(daemon)?.['worktree']).toBeUndefined();
});

test('git mode chip clear button resets to current branch', async ({
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

  // Select branch mode (match by role; see the first branch test)
  await popover.getByRole('radio', { name: /New branch/ }).click();
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

  // Submit a message and verify neither branch nor worktree is sent
  await fillComposer(page, 'task after clear');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => sessionCreateBody(daemon) !== undefined).toBe(true);
  expect(sessionCreateBody(daemon)?.['branch']).toBeUndefined();
  expect(sessionCreateBody(daemon)?.['worktree']).toBeUndefined();
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
