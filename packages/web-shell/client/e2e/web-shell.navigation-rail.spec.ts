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
    .getByRole('button', { name: 'New session', exact: true })
    .focus();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(
    rail.getByRole('button', { name: 'Expand', exact: true }),
  ).toBeFocused();
  await expect(page.locator(homeColumn)).toBeHidden();
  await home.hover();
  const preview = page.locator('[data-web-shell-home-popover]');
  await expect(preview).toBeVisible();
  await expect(preview.getByText('Qwen Code', { exact: true })).toBeVisible();
  await expect(
    preview.getByRole('button', { name: 'New session', exact: true }),
  ).toBeVisible();
  await expect(
    rail.getByRole('button', { name: 'Expand', exact: true }),
  ).toBeFocused();
  const homeBounds = (await home.boundingBox())!;
  const previewBounds = (await preview.boundingBox())!;
  expect(previewBounds.x).toBeGreaterThan(homeBounds.x + homeBounds.width);
  await expect
    .poll(async () => {
      const bounds = (await preview.boundingBox())!;
      const railBounds = (await rail.boundingBox())!;
      return bounds.x - railBounds.x - railBounds.width;
    })
    .toBeCloseTo(8);
  await expect(preview).toHaveCSS('border-left-width', '0px');
  await preview.hover();
  await page.waitForTimeout(200);
  await expect(preview).toBeVisible();
  await expect(
    rail.getByRole('button', { name: 'Expand', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-web-shell-collapsed-session-switcher]'),
  ).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('collapsed-dark.png') });
  await home.click();
  await expect(page.locator(homeColumn)).toBeVisible();
  await expect(preview).toHaveCount(0);
  await page.mouse.move(1000, 500);
  await home.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Home');
  await expect(editor).toHaveText('Keep this unsent draft');
  await rail.getByRole('button', { name: 'Plugins', exact: true }).click();
  await expect(page.locator(homeColumn)).toBeHidden();
  await expect(page.getByTestId('inline-panel')).toHaveAttribute(
    'aria-label',
    'Plugins',
  );
  await expect(
    page.getByTestId('inline-panel').getByRole('button', {
      name: 'Back to conversation',
      exact: true,
    }),
  ).toHaveCount(0);
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

test('Home hover supports search and dismissal without persisting expansion', async ({
  page,
  baseURL,
}) => {
  const scenario = createWebShellDaemonScenario();
  await installMockDaemon(page, scenario, { baseURL });
  await page.goto('/?language=en-US');
  const rail = page.locator(railSelector);
  const home = rail.locator('[data-web-shell-home-trigger]');
  const preview = page.locator('[data-web-shell-home-popover]');
  await rail.getByRole('button', { name: 'Collapse', exact: true }).click();
  await home.hover();
  await expect(preview).toBeVisible();
  await page.mouse.move(1000, 500);
  await expect(preview).toHaveCount(0);
  await home.hover();
  await expect(preview).toBeVisible();
  await preview.getByText('Workspaces', { exact: true }).hover();
  await preview
    .getByRole('button', { name: 'Search sessions', exact: true })
    .click();
  const search = preview.getByRole('textbox', {
    name: 'Search sessions',
    exact: true,
  });
  await search.fill('e2e');
  await page.mouse.move(1000, 500);
  await page.waitForTimeout(200);
  await expect(preview).toBeVisible();
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(home).toBeFocused();
  await home.hover();
  await expect(preview).toBeVisible();
  await expect(
    preview.getByRole('textbox', { name: 'Search sessions', exact: true }),
  ).toHaveCount(0);
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await editor.click();
  await expect(preview).toHaveCount(0);
  await expect(editor).toBeFocused();
  await page.reload();
  await expect(page.locator(homeColumn)).toBeHidden();
  await expect(
    rail.getByRole('button', { name: 'Expand', exact: true }),
  ).toBeVisible();
});

for (const theme of ['dark', 'light']) {
  test(`collapsed Home shows custom content in ${theme} and leaves functional pages selected`, async ({
    page,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
    await page.goto(`/e2e/navigation-rail-harness.html?custom&${theme}`);
    const rail = page.locator(railSelector);
    const home = rail.locator('[data-web-shell-home-trigger]');
    await rail.getByRole('button', { name: 'Plugins', exact: true }).click();
    await home.hover();
    await expect(page.getByRole('tooltip')).toHaveText('Home');
    await expect(page.locator('[data-web-shell-home-popover]')).toHaveCount(0);
    await rail.getByRole('button', { name: 'Collapse', exact: true }).click();
    await home.hover();
    const preview = page.locator('[data-web-shell-home-popover]');
    await expect(
      preview.getByText('Host brand', { exact: true }),
    ).toBeVisible();
    await expect(
      preview.getByRole('button', { name: 'Host navigation' }),
    ).toBeVisible();
    await expect(
      preview.getByRole('button', { name: 'Host footer' }),
    ).toBeVisible();
    await expect(
      rail.getByRole('button', { name: 'Plugins', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect
      .poll(async () => (await preview.boundingBox())?.width)
      .toBe(300);
    await page.screenshot({ path: info.outputPath(`home-hover-${theme}.png`) });
  });
}

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
    page.getByRole('button', { name: 'New session', exact: true }),
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
    sidebar.getByRole('button', { name: 'New session', exact: true }),
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

test('narrow Plugins page keeps a visible back control to the conversation', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
  await page.goto('/e2e/navigation-rail-harness.html?narrow');
  await expect(page.locator(homeColumn)).toBeHidden();
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  await page
    .getByRole('dialog', { name: 'Workspace sidebar' })
    .getByRole('button', { name: 'Plugins', exact: true })
    .click();

  const panel = page.getByTestId('inline-panel');
  await expect(panel).toHaveAttribute('aria-label', 'Plugins');
  const back = panel.getByRole('button', {
    name: 'Back to conversation',
    exact: true,
  });
  await expect(back).toBeVisible();
  await back.click();
  await expect(panel).toHaveCount(0);
});

test('narrow Plugins header keeps the workspace picker clear of the tabs', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const scenario = createWebShellDaemonScenario();
  scenario.capabilities.workspaces = [
    {
      id: 'primary',
      cwd: scenario.workspaceCwd,
      displayName: 'Primary',
      primary: true,
      trusted: true,
    },
    {
      id: 'secondary',
      cwd: '/tmp/qwen-web-shell-e2e-secondary',
      displayName: 'Secondary',
      primary: false,
      trusted: true,
    },
  ];
  await installMockDaemon(page, scenario, { baseURL });
  await page.goto('/e2e/navigation-rail-harness.html?narrow');
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  await page
    .getByRole('dialog', { name: 'Workspace sidebar' })
    .getByRole('button', { name: 'Plugins', exact: true })
    .click();

  const panel = page.getByTestId('inline-panel');
  await panel.getByRole('tab', { name: 'MCP', exact: true }).click();
  const select = panel.getByRole('combobox', {
    name: 'Workspace',
    exact: true,
  });
  await expect(select).toBeVisible();
  const host = page.getByTestId('host-shell');
  const lastTab = panel.getByRole('tab').last();

  for (const width of [500, 390]) {
    await host.evaluate((element, next) => {
      element.style.width = `${next}px`;
    }, width);
    await page.waitForTimeout(50);
    const tabBox = (await lastTab.boundingBox())!;
    const selectBox = (await select.boundingBox())!;
    const hostBox = (await host.boundingBox())!;
    expect(selectBox.width).toBeGreaterThan(0);
    const overlaps =
      tabBox.x < selectBox.x + selectBox.width &&
      selectBox.x < tabBox.x + tabBox.width &&
      tabBox.y < selectBox.y + selectBox.height &&
      selectBox.y < tabBox.y + tabBox.height;
    expect(overlaps).toBe(false);
    // Wrapping the header must not push the picker out of the host: a build
    // that only shrinks the tab group keeps the tabs off the picker but leaves
    // it clipped at the host's right edge.
    expect(selectBox.x).toBeGreaterThanOrEqual(hostBox.x);
    expect(selectBox.x + selectBox.width).toBeLessThanOrEqual(
      hostBox.x + hostBox.width + 1,
    );
  }
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
