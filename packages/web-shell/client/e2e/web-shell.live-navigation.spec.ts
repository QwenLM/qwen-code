import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';
import { completeReplay, submitLocalCommand } from './visuals/harness';

async function installLive(page: Page, baseURL: string) {
  const cwd = '/tmp/qwen-live-e2e';
  const scenario = createWebShellDaemonScenario({
    settings: {
      settings: [
        {
          key: 'experimental.liveVoice.enabled',
          type: 'boolean',
          label: 'Qwen Live',
          category: 'Experimental',
          default: false,
          requiresRestart: false,
          values: { effective: true },
        },
      ],
    },
    sessions: [
      {
        sessionId: 'live-history',
        workspaceCwd: cwd,
        displayName: 'Live conversation history',
        sourceType: 'qwen-live',
      },
      {
        sessionId: 'live-pinned',
        workspaceCwd: cwd,
        displayName: 'Pinned Live conversation',
        sourceType: 'qwen-live',
        isPinned: true,
      },
    ],
  });
  scenario.capabilities.features.push('realtime_voice');
  scenario.capabilities.workspaces = [
    { id: 'primary', cwd: scenario.workspaceCwd, primary: true, trusted: true },
    { id: 'live', cwd, primary: false, trusted: true, kind: 'live' },
  ];
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  const mutations: string[] = [];
  const status = {
    v: 1,
    available: true,
    state: 'idle',
    shortcut: '',
    requirements: { host: 'ready', provider: 'ready' },
  };
  await page.route('**/live/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') mutations.push(path);
    if (path === '/live/setup') {
      await route.fulfill({
        json: {
          v: 1,
          enabled: true,
          keyConfigured: true,
          model: 'qwen3.5-omni-plus-realtime',
          shortcut: '',
          nativeHost: false,
          install: { state: 'not-installed' },
          live: status,
        },
      });
    } else if (path === '/live/status') await route.fulfill({ json: status });
    else await route.fallback();
  });
  return { daemon, mutations };
}

test('Live combines existing settings, voice entry and history without starting a call @smoke', async ({
  page,
  baseURL,
}) => {
  const { daemon, mutations } = await installLive(page, baseURL!);
  await page.goto('/?language=en-US');
  const rail = page.locator('[data-web-shell-navigation-rail]');
  await expect(page.getByText('Live conversation history')).toHaveCount(0);
  await rail.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(page).toHaveURL(/\/live$/);
  await expect(
    rail.getByRole('button', { name: 'Channels', exact: true }).locator('svg'),
  ).toHaveClass(/lucide-messages-square/);
  await expect(
    rail.getByRole('button', { name: 'Live', exact: true }).locator('svg'),
  ).toHaveClass(/lucide-audio-lines/);
  const panel = page.getByTestId('inline-panel');
  await expect(panel.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(
    panel.getByRole('switch', { name: 'Enable Qwen Live' }),
  ).toBeVisible();
  await expect(panel.getByRole('button', { name: /^back$/i })).toHaveCount(0);
  const save = panel.locator('[data-live-settings-save]');
  const toggle = panel.getByRole('switch', { name: 'Enable Qwen Live' });
  await expect(save).toBeDisabled();
  await expect(save).toHaveCSS('transition-property', 'none');
  const saveY = (await save.boundingBox())!.y;
  await toggle.click();
  await expect(save).toBeEnabled();
  expect((await save.boundingBox())!.y).toBe(saveY);
  await toggle.click();
  await expect(save).toBeDisabled();
  expect((await save.boundingBox())!.y).toBe(saveY);
  const column = page.locator('[data-web-shell-sidebar-section="live"]');
  await expect(column).toHaveCSS('width', '300px');
  await expect(
    column.getByRole('button', { name: 'Open Live Voice' }),
  ).toBeVisible();
  await expect(
    column.getByRole('button', { name: 'Project', exact: true }),
  ).toBeHidden();
  await expect(
    column.getByRole('button', { name: 'Add workspace' }),
  ).toBeHidden();
  await expect(column.getByText('Live conversation history')).toBeVisible();
  await expect(column.getByText('Pinned Live conversation')).toBeVisible();
  await expect(
    column.getByRole('button', { name: 'Conversations' }),
  ).toHaveCount(0);
  expect(mutations).toEqual([]);
  await column.getByText('Live conversation history').click();
  await completeReplay(page, daemon, 'live-history');
  await expect(panel).toHaveCount(0);
  await expect(
    rail.getByRole('button', { name: 'Live', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await rail.getByRole('button', { name: 'Live', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Settings' })).toBeVisible();
  const keyDraft = panel.locator('#live-realtime-key');
  await keyDraft.fill('unsaved-fixture-key');
  await rail.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(column).toBeHidden();
  // The sidebar's voice slot hides with the column; the trigger must stay
  // reachable from the Live page header.
  await expect(
    panel.getByRole('button', { name: 'Open Live Voice' }),
  ).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page).toHaveURL(/\/live$/);
  await expect(keyDraft).toHaveValue('unsaved-fixture-key');
  await rail.getByRole('button', { name: 'Expand', exact: true }).click();
  await expect(column).toBeVisible();
  await expect(keyDraft).toHaveValue('unsaved-fixture-key');
  await page.getByRole('heading', { name: 'Settings', exact: true }).click();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(column).toBeHidden();
  await expect(panel.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(keyDraft).toHaveValue('unsaved-fixture-key');
  await page.keyboard.press('ControlOrMeta+b');
  await expect(column).toBeVisible();
  await keyDraft.fill('');
  await column.getByText('Live conversation history').click();
  await expect(page).toHaveURL(/\/session\/live-history\?context=live$/);
  await page.reload();
  await completeReplay(page, daemon, 'live-history');
  await expect(column).toBeVisible();
  await expect(column.getByText('Live conversation history')).toBeVisible();
  await expect(
    rail.getByRole('button', { name: 'Live', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await rail.locator('[data-web-shell-home-trigger]').click();
  await expect(
    page.locator('[data-web-shell-sidebar-section="home"]'),
  ).toBeVisible();
  await rail.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(panel.getByRole('button', { name: /Experimental/ })).toHaveCount(
    0,
  );
  await expect(
    panel.getByRole('switch', { name: 'Enable Qwen Live' }),
  ).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test('Live keeps legacy settings in hosts without its rail entry and Back in narrow hosts', async ({
  page,
  baseURL,
}) => {
  const { mutations } = await installLive(page, baseURL!);
  for (const query of ['single&live', '', 'custom&live']) {
    await page.goto(`/e2e/navigation-rail-harness.html?${query}`);
    await expect(
      page
        .locator('[data-web-shell-navigation-rail]')
        .getByRole('button', { name: 'Live', exact: true }),
    ).toHaveCount(0);
    if (query.includes('single')) {
      await submitLocalCommand(page, '/settings');
    } else {
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
    }
    await page.getByRole('button', { name: /Experimental/ }).click();
    await expect(
      page.getByRole('switch', { name: 'Enable Qwen Live' }),
    ).toBeVisible();
  }
  await page.goto('/e2e/navigation-rail-harness.html?live&narrow');
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  await page
    .locator('[data-web-shell-navigation-rail]')
    .getByRole('button', { name: 'Live', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: /^back$/i }).click();
  await expect(page.getByRole('button', { name: 'Toggle menu' })).toBeVisible();
  expect(mutations).toEqual([]);
});

test('disabled Live without a registered workspace has an empty state', async ({
  page,
  baseURL,
}) => {
  const scenario = createWebShellDaemonScenario();
  await installMockDaemon(page, scenario, { baseURL });
  await page.goto('/?language=en-US');
  await page
    .locator('[data-web-shell-navigation-rail]')
    .getByRole('button', { name: 'Live', exact: true })
    .click();
  const column = page.locator('[data-web-shell-sidebar-section="live"]');
  await expect(column.locator('[data-slot="empty"]')).toBeVisible();
  await expect(column).toContainText('No sessions');
});
