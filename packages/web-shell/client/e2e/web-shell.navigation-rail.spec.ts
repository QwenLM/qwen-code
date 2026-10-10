import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

import { submitLocalCommand } from './visuals/harness';

const homeColumn = '[data-web-shell-home-column]';
const railSelector = '[data-web-shell-navigation-rail]';

test('click opens Home and functional pages while collapse retains the draft @smoke', async ({
  page,
  baseURL,
}, info) => {
  const daemon = await installMockDaemon(page, createWebShellDaemonScenario(), {
    baseURL,
  });
  await page.goto('/?language=en-US');
  const rail = page.locator(railSelector);
  const home = rail.locator('[data-web-shell-home-trigger]');
  await expect(home.locator('svg')).toHaveCSS('width', '17px');
  await expect(page.locator(homeColumn)).toBeVisible();
  expect((await page.locator(homeColumn).boundingBox())!.width).toBe(300);
  expect((await rail.boundingBox())!.width).toBe(56);
  await expect(
    page.locator(homeColumn).getByText('v0.0.0-e2e', { exact: true }),
  ).toHaveCount(0);
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.fill('Keep this unsent draft');
  await page.screenshot({ path: info.outputPath('expanded-dark.png') });
  await page
    .locator(homeColumn)
    .getByRole('button', { name: 'New task', exact: true })
    .focus();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(
    rail.getByRole('button', { name: 'Expand', exact: true }),
  ).toBeFocused();
  await expect(page.locator(homeColumn)).toBeHidden();
  await home.hover();
  await page.waitForTimeout(350);
  await expect(page.locator(homeColumn)).toBeHidden();
  await expect(
    page.locator('[data-web-shell-collapsed-session-switcher]'),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('collapsed-dark.png') });
  await home.click();
  await expect(page.locator(homeColumn)).toBeVisible();
  await expect(editor).toHaveText('Keep this unsent draft');
  await rail.getByRole('button', { name: 'Plugins', exact: true }).click();
  await expect(page.locator(homeColumn)).toBeHidden();
  await expect(page.getByTestId('inline-panel')).toHaveAttribute(
    'aria-label',
    'Plugins',
  );
  await expect(
    rail.getByRole('button', { name: 'Plugins', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: info.outputPath('plugins-dark.png') });
  await rail.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(page.getByTestId('inline-panel')).toBeVisible();
  await expect(
    rail.getByRole('button', { name: 'Expand', exact: true }),
  ).toBeVisible();
  await expect(page.locator(homeColumn)).toBeHidden();
  await expect(editor).toHaveText('Keep this unsent draft');
  await home.click();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.locator(homeColumn)).toBeHidden();
  await rail.getByRole('button', { name: 'More', exact: true }).click();
  await page
    .locator('[data-web-shell-sidebar-more]')
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await expect(page.getByTestId('inline-panel')).toHaveAttribute(
    'aria-label',
    'Settings',
  );
  // Opening Settings must not have rewritten the persisted collapse, so this
  // toggles it off; the column stays hidden because a page is open.
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.getByTestId('inline-panel')).toBeVisible();
  await expect(
    rail.getByRole('button', { name: 'Collapse', exact: true }),
  ).toBeVisible();
  await expect(page.locator(homeColumn)).toBeHidden();
  await home.click();
  await page.reload();
  await expect(page.locator(homeColumn)).toBeVisible();
  expect(
    daemon.requests.filter((r) => r.method === 'POST' && r.path === '/session'),
  ).toHaveLength(0);
});

test('narrow embedded container uses a contained drawer on a wide viewport @smoke', async ({
  page,
  baseURL,
}, info) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
  await page.goto('/e2e/navigation-rail-harness.html?narrow');
  await expect(page.locator(homeColumn)).toBeHidden();
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace sidebar' });
  await expect(drawer).toBeVisible();
  await expect(page.locator(homeColumn)).toBeVisible();
  const brand = page
    .locator(homeColumn)
    .getByText('Qwen Code', { exact: true });
  await expect(brand).toBeVisible();
  await expect(brand.locator('..').locator('svg')).toBeVisible();
  const host = await page.getByTestId('host-shell').boundingBox();
  const bounds = await drawer.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(host!.x);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(host!.x + host!.width);
  await page.screenshot({
    path: info.outputPath('embedded-narrow-drawer.png'),
  });
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+b');
  await expect(page.locator(homeColumn)).toBeVisible();
  await page
    .locator(railSelector)
    .getByRole('button', { name: 'Collapse', exact: true })
    .click();
  await expect(page.locator(homeColumn)).toBeHidden();
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Workspace sidebar' }),
  ).toBeVisible();
  await page.getByTestId('host-shell').evaluate((element) => {
    element.style.width = '100%';
  });
  await expect(
    page.getByRole('dialog', { name: 'Workspace sidebar' }),
  ).toHaveCount(0);
  await expect(page.locator(homeColumn)).toBeVisible();
  await page
    .locator(railSelector)
    .getByRole('button', { name: 'Collapse', exact: true })
    .click();
  await page.getByTestId('host-shell').evaluate((element) => {
    element.style.width = '560px';
  });
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  await expect(brand).toBeVisible();
  for (const option of ['hide-branding', 'hide-compact-branding']) {
    await page.goto(`/e2e/navigation-rail-harness.html?narrow&${option}`);
    await page.getByRole('button', { name: 'Toggle menu' }).click();
    await expect(brand).toHaveCount(0);
  }
});

test('Home-only hosts retain secondary collapse and hosts with another item show the rail @smoke', async ({
  page,
  baseURL,
}, info) => {
  await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
  await page.goto(
    '/e2e/navigation-rail-harness.html?single&custom&locked&light',
  );
  const sidebar = page.getByRole('complementary', {
    name: 'Workspace sidebar',
  });
  await expect(sidebar).toBeVisible();
  await expect(page.locator(railSelector)).toHaveCount(0);
  await expect(page.getByText('Host brand', { exact: true })).toBeVisible();
  await expect(
    sidebar.getByRole('button', { name: 'Plugins', exact: true }),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole('button', { name: 'Host navigation' }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole('button', { name: 'Host footer' }),
  ).toBeVisible();
  expect((await sidebar.boundingBox())!.width).toBe(300);
  await page.screenshot({
    path: info.outputPath('embedded-single-custom-light.png'),
  });
  await sidebar.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(56);
  await sidebar.locator('[data-web-shell-collapsed-session-trigger]').hover();
  await expect(
    page.locator('[data-web-shell-collapsed-session-switcher]'),
  ).toBeVisible();
  await sidebar.getByRole('button', { name: 'Expand', exact: true }).click();
  await page.goto('/e2e/navigation-rail-harness.html?default');
  await expect(page.locator(railSelector)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'New task', exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(300);
  await page.goto('/e2e/navigation-rail-harness.html?plugin-only');
  const rail = page.locator(railSelector);
  await expect(
    rail.getByRole('button', { name: 'Home', exact: true }),
  ).toBeVisible();
  await expect(
    rail.getByRole('button', { name: 'Plugins', exact: true }),
  ).toBeVisible();
  await expect(
    rail.getByRole('button', { name: 'Channels', exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(homeColumn)).toHaveCSS('width', '300px');
  await expect(
    page
      .locator('[data-web-shell-rail-footer]')
      .getByRole('button', { name: 'Collapse', exact: true }),
  ).toHaveCount(1);
  await expect(
    page.locator(homeColumn).locator('[data-web-shell-sidebar-collapse]'),
  ).toHaveCount(0);
  await rail.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(page.locator(homeColumn)).toBeHidden();
  await expect(sidebar).toHaveCSS('width', '56px');
  await expect(rail).toBeVisible();
  await expect(
    page.locator('[data-web-shell-collapsed-session-trigger]'),
  ).toHaveCount(0);
  await rail.getByRole('button', { name: 'Expand', exact: true }).click();
  await expect(page.locator(homeColumn)).toHaveCSS('width', '300px');
  await page.goto('/e2e/navigation-rail-harness.html?disabled');
  await expect(
    page.locator('[data-web-shell-composer-editor] .cm-content'),
  ).toBeVisible();
  await expect(sidebar).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Toggle menu' })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/e2e/navigation-rail-harness.html?split-only');
  await expect(
    sidebar.getByRole('button', { name: 'New task', exact: true }),
  ).toBeVisible();
  await expect(page.locator(railSelector)).toHaveCount(0);
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(page.locator(railSelector)).toHaveCount(0);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.getByTestId('host-shell').evaluate((element) => {
    element.style.width = '1100px';
  });
  await expect(rail).toBeVisible();
  await rail.getByRole('button', { name: 'More', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Split View', exact: true }),
  ).toBeVisible();
});

test('split view keeps the home column and a working collapse control', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
  await page.goto('/?language=en-US');
  const rail = page.locator(railSelector);
  await expect(page.locator(homeColumn)).toBeVisible();
  await rail.getByRole('button', { name: 'More', exact: true }).click();
  await page
    .locator('[data-web-shell-sidebar-more]')
    .getByRole('button', { name: 'Split View', exact: true })
    .click();
  await expect(page.getByTestId('split-view-page')).toBeVisible();
  // A wide split keeps the full sidebar: the home column stays visible and
  // the rail collapse control keeps working.
  await expect(page.locator(homeColumn)).toBeVisible();
  await rail.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(page.locator(homeColumn)).toBeHidden();
  await rail.getByRole('button', { name: 'Expand', exact: true }).click();
  await expect(page.locator(homeColumn)).toBeVisible();
});

test('a very narrow host still contains the compact drawer', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
  await page.goto('/e2e/navigation-rail-harness.html?narrow');
  await page.getByTestId('host-shell').evaluate((element) => {
    element.style.width = '250px';
  });
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace sidebar' });
  await expect(drawer).toBeVisible();
  const host = await page.getByTestId('host-shell').boundingBox();
  const bounds = await drawer.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(host!.x);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(host!.x + host!.width);
});

test('local management commands keep Home visible and selected', async ({
  page,
  baseURL,
}) => {
  const scenario = createWebShellDaemonScenario();
  await installMockDaemon(page, scenario, { baseURL });
  await page.route('**/workspaces/*/runtime/mcp', (route) =>
    route.fulfill({ json: scenario.mcp }),
  );
  for (const command of ['mcp', 'skills', 'agents', 'extensions']) {
    await page.goto('/?language=en-US');
    await submitLocalCommand(page, `/${command}`);
    await expect(page.getByTestId('inline-panel')).toBeVisible();
    await expect(page.locator(homeColumn)).toBeVisible();
    await expect(
      page
        .locator(railSelector)
        .getByRole('button', { name: 'Home', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
  }
});
