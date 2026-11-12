import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

const railSelector = '[data-web-shell-navigation-rail]';

for (const theme of ['dark', 'light']) {
  test(`Home-only embedding keeps utilities and collapse without a rail in ${theme} @smoke`, async ({
    page,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
    await page.goto(`/e2e/navigation-rail-harness.html?minimal&${theme}`);
    const sidebar = page.getByRole('complementary', {
      name: 'Workspace sidebar',
    });
    const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
    await expect(editor).toBeVisible();
    await expect(sidebar).toBeVisible();
    await page.screenshot({ path: info.outputPath('minimal-expanded.png') });
    await expect(page.locator(railSelector)).toHaveCount(0);
    await expect(
      sidebar.getByRole('button', { name: 'More', exact: true }),
    ).toHaveCount(0);
    const collapse = sidebar.getByRole('button', {
      name: 'Collapse',
      exact: true,
    });
    await expect(collapse).toBeVisible();
    const sidebarBounds = (await sidebar.boundingBox())!;
    const collapseBounds = (await collapse.boundingBox())!;
    expect(collapseBounds.x).toBeGreaterThan(
      sidebarBounds.x + sidebarBounds.width / 2,
    );
    expect(collapseBounds.y).toBeGreaterThan(
      sidebarBounds.y + sidebarBounds.height - 60,
    );
    await editor.fill('Keep the minimal host draft');
    await collapse.click();
    await expect(sidebar).toHaveCSS('width', '56px');
    await expect(page.locator(railSelector)).toHaveCount(0);
    await sidebar.getByRole('button', { name: 'Expand', exact: true }).click();
    await expect(sidebar).toHaveCSS('width', '300px');
    await expect(editor).toHaveText('Keep the minimal host draft');
    await sidebar
      .getByRole('button', { name: 'Settings', exact: true })
      .click();
    await expect(page.getByTestId('inline-panel')).toHaveAttribute(
      'aria-label',
      'Settings',
    );
    await page.getByTestId('panel-back').click();
    await expect(editor).toHaveText('Keep the minimal host draft');
    await sidebar
      .getByRole('button', {
        name:
          theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        exact: true,
      })
      .click();
    await expect(
      sidebar.getByRole('button', {
        name:
          theme === 'dark' ? 'Switch to dark theme' : 'Switch to light theme',
        exact: true,
      }),
    ).toBeVisible();
    await collapse.click();
    await page.reload();
    await expect(sidebar).toHaveCSS('width', '56px');
    await expect(
      sidebar.getByRole('button', { name: 'Expand', exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath('minimal-collapsed.png') });
  });
}

test('another primary page retains the navigation rail', async ({
  page,
  baseURL,
}) => {
  await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
  await page.goto('/e2e/navigation-rail-harness.html?plugin-only');
  const rail = page.locator(railSelector);
  await expect(rail).toBeVisible();
  await rail.getByRole('button', { name: 'Plugins', exact: true }).click();
  await expect(page.getByTestId('inline-panel')).toHaveAttribute(
    'aria-label',
    'Plugins',
  );
});

test('hosts can hide workspace chrome when no workspaces are registered', async ({
  page,
  baseURL,
}, info) => {
  const scenario = createWebShellDaemonScenario();
  scenario.capabilities.workspaces = [];
  scenario.capabilities.features.push('standalone_sessions_v1');
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await page.goto('/e2e/navigation-rail-harness.html?minimal');
  const sidebar = page.getByRole('complementary', {
    name: 'Workspace sidebar',
  });
  await expect(page.getByText('Workspaces', { exact: true })).toBeVisible();
  await expect(
    page
      .getByTestId('chat-pane-container')
      .getByRole('button', { name: 'Workspace', exact: true }),
  ).toBeVisible();
  await expect(sidebar.locator('[data-sidebar-workspace]')).toHaveCount(0);
  await expect(
    sidebar.getByRole('button', { name: 'Workspace', exact: true }),
  ).toHaveCount(0);
  await page.goto(
    '/e2e/navigation-rail-harness.html?minimal&hide-workspace-ui&hide-source-switch',
  );
  await expect(
    page.locator('[data-web-shell-composer-editor] .cm-content'),
  ).toBeVisible();
  await expect(page.getByText('Workspaces', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('tablist', { name: 'Session source', exact: true }),
  ).toHaveCount(0);
  await expect(sidebar.locator('[data-sidebar-workspace]')).toHaveCount(0);
  await expect(
    page
      .getByTestId('chat-pane-container')
      .getByRole('button', { name: 'Workspace', exact: true }),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole('button', { name: 'New session', exact: true }).first(),
  ).toBeVisible();
  expect(
    daemon.requests.filter((request) => request.method === 'POST'),
  ).toHaveLength(0);
  await page.screenshot({ path: info.outputPath('no-workspace-ui.png') });
});

test('minimal navigation keeps the narrow drawer usable @smoke', async ({
  page,
  baseURL,
}) => {
  await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
  await page.goto('/e2e/navigation-rail-harness.html?minimal&narrow');
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace sidebar' });
  await expect(drawer).toBeVisible();
  await expect(page.locator(railSelector)).toHaveCount(0);
  await expect(
    drawer.getByRole('button', { name: 'New session', exact: true }),
  ).toBeVisible();
  await expect(
    drawer.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await drawer.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await expect(
    page.locator('[data-web-shell-composer-editor] .cm-content'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Toggle menu' }).click();
  await expect(drawer).toBeVisible();
});
