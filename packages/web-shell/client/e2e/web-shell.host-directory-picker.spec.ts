import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

const REMOTE_ORIGIN = 'http://127.0.0.1:5199';
const PICKED_PATH = '/srv/host-selected';

async function openHarness(
  page: Page,
  testInfo: TestInfo,
  options: {
    remote?: boolean;
    native?: boolean;
    host?: boolean;
    interactiveHost?: boolean;
    gitClone?: boolean;
  } = {},
) {
  const origin = options.remote
    ? REMOTE_ORIGIN
    : String(testInfo.project.use.baseURL);
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: '/srv/primary',
    capabilities: {
      features: [
        'session_events',
        'dynamic_workspace_registration',
        'persistent_workspace_registration',
        ...(options.native ? ['native_directory_picker'] : []),
        ...(options.gitClone ? ['git_workspace_clone'] : []),
      ],
      workspaces: [
        { id: 'primary', cwd: '/srv/primary', primary: true, trusted: true },
      ],
    },
  });
  const daemon = await installMockDaemon(page, scenario, { baseURL: origin });
  await page.route(`${origin}/workspace/models`, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ models: [] }),
    }),
  );
  let nativeRequests = 0;
  await page.route(`${origin}/workspace-directory-picker`, async (route) => {
    nativeRequests += 1;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        kind: 'workspace-directory-picker',
        selected: true,
        path: '/srv/native-selected',
      }),
    });
  });
  const params = new URLSearchParams({
    daemon: origin,
    hostPicker: options.host === false ? 'false' : 'true',
    interactiveHost: String(options.interactiveHost === true),
  });
  await page.goto(`/e2e/host-directory-picker-harness.html?${params}`);
  await expect(page).toHaveTitle('Host directory picker harness');
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  return { daemon, scenario, nativeRequests: () => nativeRequests };
}

function dialog(page: Page) {
  return page.getByRole('dialog', { name: 'Add workspace', exact: true });
}

async function openDialog(page: Page) {
  const add = page.getByRole('button', { name: 'Add workspace', exact: true });
  await add.locator('../..').hover();
  await add.click();
  await expect(dialog(page)).toBeVisible();
}

async function completePicker(
  page: Page,
  result: { id: number; path?: string; error?: string },
) {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('host-picker-result', { detail }));
  }, result);
}

test('allows real interaction with a host-owned directory browser outside WebShell @smoke', async ({
  page,
}, testInfo) => {
  await openHarness(page, testInfo, { remote: true, interactiveHost: true });
  await openDialog(page);
  const browse = dialog(page).getByRole('button', { name: 'Browse…' });
  await page.keyboard.press('Tab');
  await expect(browse).toBeFocused();
  await page.keyboard.press('Enter');
  const host = page.getByRole('dialog', { name: 'Host directory browser' });
  await expect(host).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('host-browser-open.png') });
  const input = host.getByLabel('Directory on connected daemon');
  await expect(input).toBeFocused();
  await input.click();
  await expect(input).toBeFocused();
  await input.fill(PICKED_PATH);
  await page.screenshot({
    path: testInfo.outputPath('host-browser-focused.png'),
  });
  await page.keyboard.press('Tab');
  await expect(
    host.getByRole('button', { name: 'Select host directory' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(host).toHaveCount(0);
  await expect(page.locator('#add-workspace-path')).toHaveValue(PICKED_PATH);
  await expect(browse).toBeFocused();
  await dialog(page).getByRole('button', { name: 'Browse…' }).click();
  await host.getByRole('button', { name: 'Cancel host selection' }).click();
  await expect(host).toHaveCount(0);
  await expect(page.locator('#add-workspace-path')).toHaveValue(PICKED_PATH);
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  await expect(browse).toBeFocused();
  const workspacePath = page.locator('#add-workspace-path');
  await workspacePath.click();
  await expect(workspacePath).toBeFocused();
  await workspacePath.fill('/srv/manual-after-cancel');
  await expect(workspacePath).toHaveValue('/srv/manual-after-cancel');
  for (let index = 0; index < 10; index += 1) {
    await page.keyboard.press('Tab');
    await expect
      .poll(() =>
        dialog(page).evaluate((node) => node.contains(document.activeElement)),
      )
      .toBe(true);
  }
  await page.screenshot({
    path: testInfo.outputPath('dialog-restored-after-cancel.png'),
  });
});

test('parks focus for a pending host without browser UI and returns to Browse', async ({
  page,
}, testInfo) => {
  await openHarness(page, testInfo, { remote: true });
  await openDialog(page);
  const browse = dialog(page).getByRole('button', { name: 'Browse…' });
  await page.keyboard.press('Tab');
  await expect(browse).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('host-picker-calls')).toHaveText('1');
  await expect.soft(dialog(page)).toBeFocused();
  await expect.soft(dialog(page)).toHaveAttribute('aria-busy', 'true');
  await completePicker(page, { id: 1, path: PICKED_PATH });
  await expect(page.locator('#add-workspace-path')).toHaveValue(PICKED_PATH);
  await expect.soft(browse).toBeFocused();
  await expect(dialog(page)).not.toHaveAttribute('aria-busy', 'true');
  await page.keyboard.type('stray-typing');
  await expect(page.locator('#add-workspace-path')).toHaveValue(PICKED_PATH);
});

test('preserves the scrolled Add Workspace body across host selection', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await openHarness(page, testInfo, { remote: true });
  await openDialog(page);
  await page.keyboard.press('Tab');
  await expect(
    dialog(page).getByRole('button', { name: 'Browse…' }),
  ).toBeFocused();
  const body = dialog(page).locator('.overflow-y-auto');
  await body.hover();
  await page.mouse.wheel(0, 90);
  await expect
    .poll(() => body.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  const scrollTop = await body.evaluate((node) => node.scrollTop);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('host-picker-calls')).toHaveText('1');
  await expect
    .poll(() => body.evaluate((node) => node.scrollTop))
    .toBe(scrollTop);
  await completePicker(page, { id: 1, path: PICKED_PATH });
  await expect(page.locator('#add-workspace-path')).toHaveValue(PICKED_PATH);
  await expect
    .poll(() => body.evaluate((node) => node.scrollTop))
    .toBe(scrollTop);
});

test('fills a headless cross-origin host path and registers only on Add', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  const consoleLogs: { level: string; text: string }[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      consoleLogs.push({ level: message.type(), text: message.text() });
    }
  });
  const { daemon, nativeRequests } = await openHarness(page, testInfo, {
    remote: true,
  });
  await openDialog(page);
  await page.screenshot({ path: testInfo.outputPath('before-browse.png') });
  const browse = dialog(page).getByRole('button', { name: 'Browse…' });
  await expect(browse).toBeVisible();
  await browse.click();
  await expect(page.getByTestId('host-picker-calls')).toHaveText('1');
  await completePicker(page, { id: 1, path: PICKED_PATH });
  await expect(page.locator('#add-workspace-path')).toHaveValue(PICKED_PATH);
  const registrations = () =>
    daemon.requests.filter(
      (r) => r.method === 'POST' && r.path === '/workspaces',
    );
  expect(registrations()).toHaveLength(0);
  expect(nativeRequests()).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath('selected-host-path.png'),
  });
  await dialog(page).locator('button[type="submit"]').click();
  await expect.poll(() => registrations().length).toBe(1);
  expect(registrations()[0]?.body).toMatchObject({
    cwd: PICKED_PATH,
    persist: true,
  });
  await expect(dialog(page)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /host-selected/ }).first(),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
  await testInfo.attach('console-health', {
    body: JSON.stringify(consoleLogs, null, 2),
    contentType: 'application/json',
  });
  expect(consoleLogs).toEqual([]);
});

test('prefers the host and ignores its late result after dialog close', async ({
  page,
}, testInfo) => {
  const { nativeRequests } = await openHarness(page, testInfo, {
    native: true,
  });
  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Browse…' }).click();
  await expect(page.getByTestId('host-picker-calls')).toHaveText('1');
  await dialog(page)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(page.getByTestId('host-picker-aborted')).toHaveText('[1]');
  await openDialog(page);
  await completePicker(page, { id: 1, path: '/srv/stale' });
  await expect(page.locator('#add-workspace-path')).toHaveValue('');
  await dialog(page).getByRole('button', { name: 'Browse…' }).click();
  await expect(page.getByTestId('host-picker-calls')).toHaveText('2');
  await completePicker(page, { id: 2 });
  await expect(
    dialog(page).getByRole('button', { name: 'Browse…' }),
  ).toBeEnabled();
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  expect(nativeRequests()).toBe(0);
});

test('reports host failures without falling back and permits another choice', async ({
  page,
}, testInfo) => {
  const { nativeRequests } = await openHarness(page, testInfo, {
    native: true,
  });
  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Browse…' }).click();
  await completePicker(page, { id: 1, error: 'Host unavailable' });
  await expect(dialog(page).getByRole('alert')).toContainText('Unable to open');
  await dialog(page).getByRole('button', { name: 'Browse…' }).click();
  await completePicker(page, { id: 2, path: PICKED_PATH });
  await expect(page.locator('#add-workspace-path')).toHaveValue(PICKED_PATH);
  await expect(dialog(page).getByRole('alert')).toHaveCount(0);
  expect(nativeRequests()).toBe(0);
});

test('retains native selection when no host callback is provided', async ({
  page,
}, testInfo) => {
  const { daemon, nativeRequests } = await openHarness(page, testInfo, {
    native: true,
    host: false,
  });
  await openDialog(page);
  await dialog(page).getByRole('button', { name: 'Browse…' }).click();
  await expect(page.locator('#add-workspace-path')).toHaveValue(
    '/srv/native-selected',
  );
  expect(nativeRequests()).toBe(1);
  expect(
    daemon.requests.filter(
      (r) => r.method === 'POST' && r.path === '/workspaces',
    ),
  ).toHaveLength(0);
});

test('hands Git clone parent selection to the host without starting a clone', async ({
  page,
}, testInfo) => {
  const { daemon, nativeRequests } = await openHarness(page, testInfo, {
    native: true,
    interactiveHost: true,
    gitClone: true,
  });
  await openDialog(page);
  await page.locator('#add-workspace-source').click();
  await page
    .getByRole('option', { name: 'Git repository', exact: true })
    .click();
  await page
    .getByLabel('Repository URL', { exact: true })
    .fill('https://github.com/example/repo.git');
  await dialog(page).getByRole('button', { name: 'Browse…' }).click();
  const host = page.getByRole('dialog', { name: 'Host directory browser' });
  const input = host.getByLabel('Directory on connected daemon');
  await expect(input).toBeFocused();
  await input.click();
  await input.fill('/srv/parent');
  await expect(
    dialog(page).getByRole('button', { name: 'Clone and add' }),
  ).toBeDisabled();
  await host.getByRole('button', { name: 'Select host directory' }).click();
  await expect(page.locator('#add-workspace-git-target')).toHaveValue(
    '/srv/parent/repo',
  );
  const browse = dialog(page).getByRole('button', { name: 'Browse…' });
  await expect(browse).toBeFocused();
  await browse.click();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId('host-picker-aborted')).toHaveText('[2]');
  await completePicker(page, { id: 2, path: '/srv/stale' });
  expect(nativeRequests()).toBe(0);
  expect(
    daemon.requests.filter(
      (r) => r.method === 'POST' && r.path === '/workspaces',
    ),
  ).toEqual([]);
});
