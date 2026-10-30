import { expect, test, devices } from '@playwright/test';
import type { DaemonUpdateStatus } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

test.use({ ...devices['Pixel 7'] });

test('manual update panel survives drawer Escape and touch scrolling @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  scenario.capabilities.features.push('daemon_update');
  scenario.capabilities.qwenCodeVersion = '0.24.4';
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  let preparations = 0;
  let restarts = 0;
  await page.route('**/daemon/update**', async (route) => {
    if (route.request().method() === 'POST') {
      if (route.request().url().endsWith('/prepare')) preparations++;
      else restarts++;
    }
    await route.fulfill({
      json: {
        state: 'available',
        currentVersion: '0.24.4',
        latestVersion: '0.24.6',
        canInstall: false,
        instructions: [
          'Run the following to update:',
          '  npm install -g @qwen-code/qwen-code@0.24.6',
        ],
      } satisfies DaemonUpdateStatus,
    });
  });
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  await page.getByRole('button', { name: 'Toggle menu' }).tap();
  const drawer = page.getByRole('dialog', { name: 'Workspace sidebar' });
  await expect(drawer).toBeVisible();

  let entry = page.locator('[data-web-shell-update]');
  if (!(await entry.isVisible().catch(() => false))) {
    // Rail layout keeps the update button inside the More popover.
    await drawer.getByRole('button', { name: 'More', exact: true }).tap();
    entry = page.locator('[data-web-shell-update]');
  }
  await expect(entry).toBeVisible();
  await entry.tap();
  const panel = page.locator('[data-web-shell-update-manual]');
  await expect(panel).toBeVisible();
  // The panel portals outside the drawer subtree, so the drawer's touchmove
  // scroll lock must exempt it or the guidance cannot be scrolled by touch.
  const panelPrevented = await panel.evaluate((element) => {
    const event = new Event('touchmove', { bubbles: true, cancelable: true });
    (element.querySelector('pre') ?? element).dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(panelPrevented).toBe(false);
  // The page behind the drawer must stay locked.
  const bodyPrevented = await page.evaluate(() => {
    const event = new Event('touchmove', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(bodyPrevented).toBe(true);

  // Escape may close the popover itself, but never the whole drawer.
  await page.keyboard.press('Escape');
  await expect(drawer).toBeVisible();
  expect(preparations).toBe(0);
  expect(restarts).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath('update-manual-drawer.png'),
  });
});
