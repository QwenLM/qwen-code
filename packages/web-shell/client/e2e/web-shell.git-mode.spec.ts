import { expect, test, type Page } from '@playwright/test';
import {
  installMockDaemon,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';
import { createGitWorkspaceScenario } from './utils/gitScenario';

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

test('selecting worktree defers automatic creation until the first message', async ({
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

  await expect(popover).not.toBeVisible();
  await expect(chip).toContainText('Worktree');
  expect(sessionCreateBody(daemon)).toBeUndefined();

  // Send a message and verify worktree is passed
  await fillComposer(page, 'worktree task');
  await page.locator('[data-web-shell-composer-submit]').click();

  await expect.poll(() => sessionCreateBody(daemon) !== undefined).toBe(true);
  expect(sessionCreateBody(daemon)?.['worktree']).toEqual({});
  expect(sessionCreateBody(daemon)?.['branch']).toBeUndefined();
  expect(
    daemon.requests.filter((r) => r.method === 'POST' && r.path === '/session'),
  ).toHaveLength(1);
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

for (const mode of ['branch', 'worktree'] as const) {
  test(`git mode chip clear button resets ${mode} to current branch`, async ({
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

    if (mode === 'branch') {
      await popover.getByRole('radio', { name: /New branch/ }).click();
      const branchInput = page.locator('[data-testid="git-mode-branch-input"]');
      await branchInput.fill('feat/temp');
      await page.locator('[data-testid="git-mode-confirm-branch"]').click();
    } else {
      await popover.getByRole('radio', { name: /Worktree/ }).click();
    }
    await expect(popover).not.toBeVisible();

    await expect(chip).toContainText(
      mode === 'branch' ? 'feat/temp' : 'Worktree',
    );
    expect(sessionCreateBody(daemon)).toBeUndefined();
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
}

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

for (const { status, expectedTone } of [
  { status: 'conflicted', expectedTone: 'error' },
  { status: 'rebase', expectedTone: 'warning' },
  { status: 'detached', expectedTone: 'warning' },
  { status: 'dirty', expectedTone: 'accent' },
] as const) {
  test(`keeps compact ${status} git badge visible in narrow desktop toolbar`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(
      `/e2e/git-status-bar-harness.html?width=360&status=${status}`,
    );

    const chip = page.locator('[data-testid="git-mode-chip"]');
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await expect(chip).toHaveAttribute('data-compact', 'true');

    const dot = chip.locator('[data-tone]');
    await expect(dot).toHaveAttribute('data-tone', expectedTone);
    await expect(dot).toBeVisible();

    const display = await dot.evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe('block');

    const box = await dot.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(7);
    expect(box!.height).toBeGreaterThanOrEqual(7);

    const labelDisplay = await chip
      .locator('[data-compact="true"]')
      .evaluateAll((els) => {
        const textEl = els.find((el) => el.textContent?.trim().length);
        return textEl ? getComputedStyle(textEl).display : null;
      });
    expect(labelDisplay).toBe('none');

    await chip.click();
    const popover = page.locator('[data-slot="popover-content"]');
    await expect(popover).toBeVisible({ timeout: 5_000 });
    await popover.getByRole('radio', { name: /Worktree/ }).click();
    await expect(popover).not.toBeVisible();
    await expect(chip).toHaveAttribute('data-git-mode', 'worktree');
  });
}

test('progressively adapts git status details by available toolbar width without overlap', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  // Wide tier: full branch label + inline status indicators, no overlap.
  await page.goto('/e2e/git-status-bar-harness.html?width=900&status=rich');
  const chip = page.locator('[data-testid="git-mode-chip"]');
  const label = chip.locator('[data-web-shell-git-branch-label]');
  const modeBtn = page.getByRole('button', { name: 'Approval mode' });
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await expect(label).toBeVisible();
  await expect(chip).toContainText('feat/compact-git-status');
  await expect(chip).toContainText('Rebasing');
  await expect
    .poll(() =>
      chip
        .locator('[data-tone]')
        .evaluate((el) => getComputedStyle(el).display),
    )
    .toBe('none');
  const wideChipBox = (await chip.boundingBox())!;
  const wideModeBox = (await modeBtn.boundingBox())!;
  expect(wideChipBox.x + wideChipBox.width).toBeLessThanOrEqual(wideModeBox.x);

  // Medium tier: branch label + severity dot, verbose indicators collapsed.
  await page.goto('/e2e/git-status-bar-harness.html?width=700&status=rich');
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await expect(chip).not.toHaveAttribute('data-compact', 'true');
  await expect(label).toBeVisible();
  expect(await label.evaluate((el) => getComputedStyle(el).display)).not.toBe(
    'none',
  );
  await expect(chip).toContainText('feat/compact-git-status');
  await expect(chip).not.toContainText('Rebasing');
  const mediumDot = chip.locator('[data-tone]');
  await expect(mediumDot).toBeVisible();
  expect(await mediumDot.evaluate((el) => getComputedStyle(el).display)).toBe(
    'block',
  );
  const mediumDotBox = (await mediumDot.boundingBox())!;
  expect(mediumDotBox.width).toBeGreaterThanOrEqual(7);
  expect(mediumDotBox.height).toBeGreaterThanOrEqual(7);
  const mediumChipBox = (await chip.boundingBox())!;
  const mediumModeBox = (await modeBtn.boundingBox())!;
  expect(mediumChipBox.x + mediumChipBox.width).toBeLessThanOrEqual(
    mediumModeBox.x,
  );

  // Narrow tier: 28px icon + severity dot, label hidden, no overlap.
  await page.goto('/e2e/git-status-bar-harness.html?width=360&status=rich');
  await expect(chip).toHaveAttribute('data-compact', 'true');
  expect(await label.evaluate((el) => getComputedStyle(el).display)).toBe(
    'none',
  );
  const narrowDot = chip.locator('[data-tone]');
  await expect(narrowDot).toBeVisible();
  const narrowChipBox = (await chip.boundingBox())!;
  const narrowNextBox = (await page
    .locator('[data-testid="harness-composer"] button')
    .nth(2)
    .boundingBox())!;
  expect(narrowChipBox.x + narrowChipBox.width).toBeLessThanOrEqual(
    narrowNextBox.x,
  );
});
