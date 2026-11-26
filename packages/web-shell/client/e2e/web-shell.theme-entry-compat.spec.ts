import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';
import { submitLocalCommand } from './visuals/harness';

const rail = '[data-web-shell-navigation-rail]';

async function ready(page: Page) {
  await expect(
    page.locator('[data-web-shell-composer-editor] .cm-content'),
  ).toBeVisible();
}

test('Home-only hosts retain an explicit theme footer without custom settings @smoke', async ({
  page,
  baseURL,
}, info) => {
  await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
  await page.goto('/e2e/navigation-rail-harness.html?minimal');
  await ready(page);
  await expect(page.locator(rail)).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Switch to light theme', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Switch to dark theme', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath('home-only-native-theme.png'),
  });
});

test('full standalone keeps More and its theme action @smoke', async ({
  page,
  baseURL,
}, info) => {
  await installMockDaemon(page, createWebShellDaemonScenario(), { baseURL });
  await page.goto('/?language=en-US');
  await ready(page);
  await expect(page.locator(rail)).toBeVisible();
  await page
    .locator(rail)
    .getByRole('button', { name: 'More', exact: true })
    .click();
  const menu = page.locator('[data-web-shell-sidebar-more]');
  await expect(
    menu.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await menu
    .getByRole('button', { name: 'Switch to light theme', exact: true })
    .click();
  await page
    .locator(rail)
    .getByRole('button', { name: 'More', exact: true })
    .click();
  await expect(
    menu.getByRole('button', { name: 'Switch to dark theme', exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath('standalone-more-theme.png') });
});

test('no-workspace standalone keeps its theme action without custom settings', async ({
  page,
  baseURL,
}) => {
  const scenario = createWebShellDaemonScenario();
  scenario.capabilities.workspaces = [];
  delete scenario.capabilities.workspaceCwd;
  scenario.capabilities.features.push('standalone_sessions_v1');
  await installMockDaemon(page, scenario, { baseURL });
  await page.goto('/?language=en-US');
  await ready(page);
  await expect(page.locator(rail)).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Switch to light theme', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Switch to dark theme', exact: true }),
  ).toBeVisible();
});

test('omitting sidebar customization preserves the theme command picker @smoke', async ({
  page,
  baseURL,
}, info) => {
  const daemon = await installMockDaemon(page, createWebShellDaemonScenario(), {
    baseURL,
  });
  await page.goto('/e2e/navigation-rail-harness.html?default');
  await ready(page);
  await expect(page.locator(rail)).toHaveCount(0);
  await submitLocalCommand(page, '/theme');
  const picker = page.getByRole('listbox', { name: 'Theme', exact: true });
  await expect(picker).toBeVisible();
  await picker.locator('[data-theme-id="light"]').click();
  await submitLocalCommand(page, '/theme');
  await expect(picker.locator('[data-theme-id="light"]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(
    daemon.requests.filter(
      (request) => request.method === 'POST' && request.path === '/session',
    ),
  ).toHaveLength(0);
  await page.screenshot({
    path: info.outputPath('sdk-default-theme-picker.png'),
  });
});

test('built-in settings retain a theme field for hosts without custom settings', async ({
  page,
  baseURL,
}, info) => {
  const scenario = createWebShellDaemonScenario({
    settings: {
      settings: [
        {
          key: 'ui.theme',
          type: 'string',
          label: 'Theme',
          category: 'UI',
          requiresRestart: false,
          default: 'Qwen Dark',
          values: { effective: 'Qwen Dark' },
        },
      ],
    },
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL });
  await page.goto('/e2e/navigation-rail-harness.html?minimal');
  await ready(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByTestId('inline-panel');
  await settings.getByRole('tab', { name: 'User', exact: true }).click();
  await settings.getByRole('button', { name: /^UI\b/ }).click();
  await settings.getByRole('combobox', { name: 'Theme', exact: true }).click();
  await page.getByRole('option', { name: 'Light', exact: true }).click();
  await expect
    .poll(
      () =>
        daemon.requests.filter(
          (request) =>
            request.method === 'POST' && request.path === '/workspace/settings',
        ).length,
    )
    .toBeGreaterThan(0);
  await page.getByTestId('panel-back').click();
  await expect(
    page.getByRole('button', { name: 'Switch to dark theme', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath('built-in-settings-theme.png'),
  });
});
