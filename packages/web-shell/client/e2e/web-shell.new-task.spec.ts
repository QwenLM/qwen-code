import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

// Simulated daemon: this covers browser state, not real filesystem or Git operations.
test('keeps workspace tools available before and after the first prompt @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    sessions: [],
    capabilities: {
      workspaces: [
        {
          id: 'project',
          cwd: '/tmp/qwen-web-shell-e2e',
          primary: true,
          trusted: true,
        },
      ],
    },
  });
  scenario.capabilities.features.push('web_terminal');
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (/^(?:\/workspaces\/[^/]+)?\/list$/.test(url.pathname)) {
      await route.fulfill({
        json: {
          kind: 'list',
          path: url.searchParams.get('path') ?? '.',
          entries: [{ name: 'README.md', kind: 'file', ignored: false }],
          truncated: false,
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/?language=en');
  const header = page.getByTestId('chat-context-header');
  await expect(header).toBeVisible();
  await expect(header.getByTestId('chat-header-workspace')).toBeVisible();
  await expect(
    header.getByRole('button', { name: 'Toggle environment information' }),
  ).toHaveCount(0);
  await expect(
    header.getByRole('button', { name: 'Session token usage' }),
  ).toHaveCount(0);
  await header
    .getByRole('button', { name: 'Toggle right panel', exact: true })
    .click();
  const panel = page.getByRole('complementary', { name: 'Right panel' });
  const actions = panel.getByTestId('right-panel-empty-actions');
  await expect(actions.getByRole('button')).toHaveCount(3);
  await expect(actions.getByRole('button', { name: /Files/ })).toBeVisible();
  await expect(actions.getByRole('button', { name: /Terminal/ })).toBeVisible();
  await expect(
    actions.getByTestId('right-panel-open-web-preview'),
  ).toBeVisible();
  if (process.env['PR_SCREENSHOT_DIR']) {
    await page.screenshot({
      path: `${process.env['PR_SCREENSHOT_DIR']}/new-task-tools.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
  await actions.getByRole('button', { name: /Files/ }).click();
  await expect(
    panel.getByRole('button', { name: 'Close Files', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    panel.getByRole('button', { name: 'Close Files', exact: true }),
  ).toBeVisible();
  await page.locator('[data-web-shell-composer-editor] .cm-content').click();
  await page.keyboard.type('Keep my workspace panel');
  await page.locator('[data-web-shell-composer-submit]').click();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  await expect(page).toHaveURL(/\/session\//);
  await expect(
    panel.getByRole('button', { name: 'Close Files', exact: true }),
  ).toBeVisible();
  if (process.env['PR_SCREENSHOT_DIR']) {
    await page.screenshot({
      path: `${process.env['PR_SCREENSHOT_DIR']}/first-prompt-files.png`,
      fullPage: true,
      animations: 'disabled',
    });
  }
});
