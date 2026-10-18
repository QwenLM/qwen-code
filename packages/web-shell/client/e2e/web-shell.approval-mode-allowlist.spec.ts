import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  type MockDaemonController,
} from './utils/mockDaemon';
import { completeReplay, submitLocalCommand } from './visuals/harness';

const modeButton = '[data-web-shell-mode-button]';
const menuOptions = '[data-web-shell-toolbar-popover] button[title]';
const dialogOptions = '[data-web-shell-approval-mode-option]';

async function openShell(
  page: Page,
  info: TestInfo,
  options: {
    host?: string[];
    setting?: unknown;
    currentMode?: string;
    sideTask?: boolean;
  } = {},
) {
  const scenario = createWebShellDaemonScenario({
    currentMode: options.currentMode ?? 'default',
  });
  scenario.capabilities.features.push('workspace_qualified_rest_core');
  if (options.setting !== undefined) {
    scenario.settings.settings.push({
      key: 'ui.allowedApprovalModes',
      type: 'array',
      label: 'Allowed Approval Modes',
      category: 'UI',
      requiresRestart: false,
      default: undefined,
      values: { effective: options.setting },
    });
  }
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(info.project.use.baseURL),
  });
  if (options.sideTask) {
    scenario.capabilities.features.push('session_side_task');
    await page.route(`**/session/${scenario.sessionId}/side-task`, (route) =>
      route.fulfill({
        json: {
          sessionId: 'previous-session',
          workspaceCwd: scenario.workspaceCwd,
          attached: false,
          clientId: 'side-task-fixture-client',
          createdAt: '2026-07-03T00:00:00.000Z',
          hasActivePrompt: false,
          displayName: 'Side task',
          parentSessionId: scenario.sessionId,
          state: scenario.state,
        },
      }),
    );
  }
  const params = new URLSearchParams({
    sessionId: scenario.sessionId,
    workspaceCwd: scenario.workspaceCwd,
  });
  if (options.host !== undefined) params.set('allowed', options.host.join(','));
  if (options.currentMode === 'plan') params.set('plan', 'true');
  await page.goto(`/e2e/approval-mode-harness.html?${params}`);
  await page.getByRole('button', { name: /^E2E Harness Session/ }).click();
  await completeReplay(page, daemon, scenario.sessionId);
  await expect(page.locator(modeButton)).toBeVisible();
  return daemon;
}

async function expectChoices(page: Page, modes: string[]) {
  await page.locator(modeButton).click();
  await expect(page.locator(menuOptions)).toHaveCount(modes.length);
  for (const [index, mode] of modes.entries()) {
    await expect(page.locator(menuOptions).nth(index)).toContainText(
      `(${mode})`,
    );
  }
  await page.keyboard.press('Escape');
  await submitLocalCommand(page, '/approval-mode');
  await expect(page.locator(dialogOptions)).toHaveCount(modes.length);
  expect(
    await page
      .locator(dialogOptions)
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-mode-id')),
      ),
  ).toEqual(modes);
  await page.keyboard.press('Escape');
}

function modeRequests(daemon: MockDaemonController) {
  return daemon.requests.filter((request) =>
    request.path.endsWith('/approval-mode'),
  );
}

async function expectCycle(
  page: Page,
  daemon: MockDaemonController,
  modes: string[],
) {
  for (const mode of modes) {
    const previousCount = modeRequests(daemon).length;
    await page.locator('[data-web-shell-composer-editor] .cm-content').focus();
    await page.keyboard.press('Shift+Tab');
    await expect
      .poll(() => modeRequests(daemon).length)
      .toBe(previousCount + 1);
    expect(modeRequests(daemon).at(-1)?.body).toMatchObject({ mode });
    await expect(page.locator(modeButton)).toBeEnabled();
  }
}

test('default keeps all four choices and existing cycle @smoke', async ({
  page,
}, info) => {
  const daemon = await openShell(page, info);
  await expectChoices(page, ['default', 'auto-edit', 'auto', 'yolo']);
  await expectCycle(page, daemon, ['auto-edit', 'auto', 'yolo', 'default']);
});

test('workspace settings filter the dropdown, dialog, and cycle @smoke', async ({
  page,
}, info) => {
  const daemon = await openShell(page, info, { setting: ['auto', 'default'] });
  await expectChoices(page, ['default', 'auto']);
  await expectCycle(page, daemon, ['auto', 'default']);
});

test('host overrides settings and preserves an excluded current mode @smoke', async ({
  page,
}, info) => {
  const daemon = await openShell(page, info, {
    setting: ['auto'],
    host: ['yolo', 'default', 'yolo'],
    currentMode: 'auto-edit',
  });
  await expect(page.locator(modeButton)).toContainText('Auto Edit');
  await expectChoices(page, ['default', 'yolo']);
  expect(modeRequests(daemon)).toHaveLength(0);
  await expectCycle(page, daemon, ['default', 'yolo', 'default']);
});

test('empty host override disables selection and cycling @smoke', async ({
  page,
}, info) => {
  const daemon = await openShell(page, info, {
    setting: ['default', 'auto'],
    host: [],
  });
  await expect(page.locator(modeButton)).toBeDisabled();
  await page.locator('[data-web-shell-composer-editor] .cm-content').focus();
  await page.keyboard.press('Shift+Tab');
  await submitLocalCommand(page, '/approval-mode');
  await expect(
    page.locator('[data-web-shell-approval-mode-dialog]'),
  ).toBeVisible();
  await expect(page.locator(dialogOptions)).toHaveCount(0);
  expect(modeRequests(daemon)).toHaveLength(0);
});

test('singleton current mode does not submit a redundant request @smoke', async ({
  page,
}, info) => {
  const daemon = await openShell(page, info, { host: ['default'] });
  await expectChoices(page, ['default']);
  await page.locator('[data-web-shell-composer-editor] .cm-content').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator(modeButton)).toBeEnabled();
  expect(modeRequests(daemon)).toHaveLength(0);
});

test('empty allowlist keeps Plan independently dismissible @smoke', async ({
  page,
}, info) => {
  const daemon = await openShell(page, info, { host: [], currentMode: 'plan' });
  await expect(page.locator(modeButton)).toBeDisabled();
  await page.locator('[data-web-shell-plan-chip]').click();
  await expect.poll(() => modeRequests(daemon).length).toBe(1);
  expect(modeRequests(daemon)[0].body).toMatchObject({
    mode: 'default',
    planMode: false,
  });
  await expect(page.locator('[data-web-shell-plan-chip]')).toHaveCount(0);
});

test('dynamic host changes update an open picker @smoke', async ({
  page,
}, info) => {
  const daemon = await openShell(page, info);
  await page.locator(modeButton).click();
  await expect(page.locator(menuOptions)).toHaveCount(4);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('approval-modes-change', { detail: ['default', 'auto'] }),
    ),
  );
  await expect(page.locator(menuOptions)).toHaveCount(2);
  const directory = resolve('../../.qwen/e2e-tests/approval-mode-evidence');
  await mkdir(directory, { recursive: true });
  await page.screenshot({
    path: resolve(directory, 'allowed-default-auto-menu.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await submitLocalCommand(page, '/approval-mode');
  await expect(page.locator(dialogOptions)).toHaveCount(2);
  await page.screenshot({
    path: resolve(directory, 'allowed-default-auto-dialog.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.keyboard.press('ArrowDown');
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('approval-modes-change', { detail: ['yolo'] }),
    ),
  );
  await expect(page.locator(dialogOptions)).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect.poll(() => modeRequests(daemon).length).toBe(1);
  expect(modeRequests(daemon)[0].body).toMatchObject({ mode: 'yolo' });
});

test('emptying the allowlist under an open picker hands focus to the composer @smoke', async ({
  page,
}, info) => {
  await openShell(page, info);
  await page.locator(modeButton).click();
  await expect(page.locator(menuOptions)).toHaveCount(4);
  // The trigger becomes disabled and the open menu closes in the same commit;
  // the browser drops their focus to the body and the handoff must catch it.
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent('approval-modes-change', { detail: [] }),
    ),
  );
  await expect(page.locator(menuOptions)).toHaveCount(0);
  await expect(page.locator(modeButton)).toBeDisabled();
  await expect(
    page.locator('[data-web-shell-composer-editor] .cm-content'),
  ).toBeFocused();
});

test('host allowlist applies to both split pane dropdowns @smoke', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const scenario = createWebShellDaemonScenario();
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(info.project.use.baseURL),
  });
  const params = new URLSearchParams({
    sessionId: scenario.sessionId,
    workspaceCwd: scenario.workspaceCwd,
    allowed: 'default,auto',
    split: `${scenario.sessionId},previous-session`,
  });
  await page.goto(`/e2e/approval-mode-harness.html?${params}`);
  await completeReplay(page, daemon, scenario.sessionId);
  await completeReplay(page, daemon, 'previous-session');
  const panes = page.getByTestId('chat-pane');
  await expect(panes).toHaveCount(2);
  for (const pane of await panes.all()) {
    await pane.locator(modeButton).click();
    await expect(page.locator(menuOptions)).toHaveCount(2);
    await expect(page.locator(menuOptions).nth(0)).toContainText('(default)');
    await expect(page.locator(menuOptions).nth(1)).toContainText('(auto)');
    await page.keyboard.press('Escape');
  }
});

test('host allowlist applies to an actual side-task panel @smoke', async ({
  page,
}, info) => {
  const daemon = await openShell(page, info, {
    host: ['default', 'auto'],
    sideTask: true,
  });
  await submitLocalCommand(page, '/btw side Check fixture behavior');
  await completeReplay(page, daemon, 'previous-session');
  const sideTask = page.getByTestId('chat-pane');
  await expect(sideTask).toHaveCount(1);
  await sideTask.locator(modeButton).click();
  await expect(page.locator(menuOptions)).toHaveCount(2);
  await expect(page.locator(menuOptions).nth(0)).toContainText('(default)');
  await expect(page.locator(menuOptions).nth(1)).toContainText('(auto)');
});

for (const split of [false, true]) {
  test(`secondary workspace reads its scoped settings route in ${split ? 'split' : 'main'} view @smoke`, async ({
    page,
  }, info) => {
    const primary = '/tmp/approval-primary';
    const secondary = '/tmp/approval-secondary';
    const scenario = createWebShellDaemonScenario({
      workspaceCwd: secondary,
      capabilities: {
        workspaceCwd: primary,
        workspaces: [
          { id: 'primary', cwd: primary, primary: true, trusted: true },
          { id: 'secondary', cwd: secondary, primary: false, trusted: true },
        ],
      },
    });
    scenario.capabilities.features.push('workspace_qualified_rest_core');
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(info.project.use.baseURL),
    });
    const scopedPath = `/workspaces/${encodeURIComponent(secondary)}/settings`;
    let scopedReads = 0;
    await page.route('**/*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/workspace/settings' || path === scopedPath) {
        if (path === scopedPath) scopedReads++;
        // The routes answer differently on purpose: any code path applying
        // the wrong workspace's read renders (default)/(yolo) and fails.
        const effective = path === scopedPath ? ['auto'] : ['default', 'yolo'];
        await route.fulfill({
          json: {
            v: 1,
            settings: [
              {
                key: 'ui.allowedApprovalModes',
                type: 'array',
                label: 'Modes',
                category: 'UI',
                requiresRestart: false,
                values: { effective },
              },
            ],
          },
        });
      } else await route.fallback();
    });
    const params = new URLSearchParams({
      sessionId: scenario.sessionId,
      workspaceCwd: secondary,
    });
    if (split) params.set('split', `${scenario.sessionId},previous-session`);
    await page.goto(`/e2e/approval-mode-harness.html?${params}`);
    if (!split)
      await page.getByRole('button', { name: /^E2E Harness Session/ }).click();
    await completeReplay(page, daemon, scenario.sessionId);
    if (split) await completeReplay(page, daemon, 'previous-session');
    await expect.poll(() => scopedReads).toBeGreaterThan(0);
    if (split) {
      const pane = page.getByTestId('chat-pane').first();
      await pane.locator(modeButton).click();
      await expect(page.locator(menuOptions)).toHaveCount(1);
      await expect(page.locator(menuOptions)).toContainText('(auto)');
    } else {
      await expectChoices(page, ['auto']);
      await expectCycle(page, daemon, ['auto']);
    }
  });
}
