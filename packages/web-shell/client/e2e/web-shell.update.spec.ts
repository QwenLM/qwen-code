import { expect, test } from '@playwright/test';
import type { DaemonUpdateStatus } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

test('downloads silently, shows an update action in More and restarts in place @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  scenario.capabilities.features.push('daemon_update');
  scenario.capabilities.qwenCodeVersion = '0.24.4';
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  let status: DaemonUpdateStatus = {
    state: 'available',
    currentVersion: '0.24.4',
    latestVersion: '0.24.6',
    canInstall: true,
  };
  let preparations = 0;
  let restarts = 0;
  await page.route('**/daemon/update**', async (route) => {
    if (route.request().method() === 'POST') {
      if (route.request().url().endsWith('/prepare')) {
        preparations++;
        status = { ...status, state: 'installing', canInstall: false };
      } else {
        restarts++;
        status = { ...status, state: 'restarting' };
      }
    }
    await route.fulfill({
      status: route.request().method() === 'POST' ? 202 : 200,
      json: status,
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem('qwen-code-web-shell-language', 'zh-CN');
  });
  const url = `/session/${scenario.sessionId}?language=zh-CN#turn-2`;
  await page.goto(url);
  const entry = page.locator('[data-web-shell-update]');
  await expect.poll(() => preparations).toBe(1);
  await expect(entry).toHaveCount(0);
  expect(restarts).toBe(0);
  status = { ...status, state: 'ready' };
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await expect(entry).toHaveAccessibleName('更新');
  for (const width of [220, 343, 360, 260]) {
    await page.evaluate((sidebarWidth) => {
      localStorage.setItem(
        'qwen-code-web-shell-sidebar-width',
        String(sidebarWidth),
      );
    }, width);
    await page.reload();
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await expect(entry).toBeVisible();
    const buttonBox = (await entry.boundingBox())!;
    const settingsBox = (await page
      .getByRole('button', { name: '设置', exact: true })
      .boundingBox())!;
    expect(buttonBox.width).toBeGreaterThan(100);
    expect(buttonBox.y + buttonBox.height).toBeLessThan(settingsBox.y);
  }
  await page.screenshot({ path: testInfo.outputPath('update-sidebar.png') });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '更多', exact: true }).click();
  await expect(entry).toBeVisible();
  expect(preparations).toBe(1);
  expect(restarts).toBe(0);
  const beforeRestartUrl = page.url();
  await entry.click();
  await expect(entry).toHaveAccessibleName('重启中…');
  await expect(entry).toBeDisabled();
  expect(restarts).toBe(1);
  await page.keyboard.press('Escape');
  await expect(entry).toHaveCount(0);
  status = { state: 'up-to-date', currentVersion: '0.24.6', canInstall: false };
  const reloaded = page.waitForEvent('load');
  await reloaded;
  await expect(page).toHaveURL(beforeRestartUrl);
  await expect(entry).toHaveCount(0);
  expect(preparations).toBe(1);
  expect(restarts).toBe(1);
});

test('older daemons do not expose update controls @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  let requests = 0;
  await page.route('**/daemon/update**', (route) => {
    requests++;
    return route.abort();
  });
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-web-shell-update]')).toHaveCount(0);
  expect(requests).toBe(0);
});

test('returns to the original task after a restart-time session 404 @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  scenario.capabilities.features.push('daemon_update');
  scenario.capabilities.qwenCodeVersion = '0.24.4';
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  // Install before the SDK captures fetch; the mock SSE transport otherwise
  // answers every connection with 200, including while the daemon restarts.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const request = new Request(input, init);
      if (
        sessionStorage.getItem('restart-session-unavailable') === 'true' &&
        /^\/session\/[^/]+\/events$/.test(new URL(request.url).pathname)
      ) {
        sessionStorage.setItem('restart-session-404-observed', 'true');
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Session not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return originalFetch(input, init);
    };
  });
  let status: DaemonUpdateStatus = {
    state: 'ready',
    currentVersion: '0.24.4',
    latestVersion: '0.24.6',
    canInstall: false,
  };
  let restarts = 0;
  await page.route('**/daemon/update**', async (route) => {
    if (route.request().method() === 'POST') {
      restarts++;
      status = { ...status, state: 'restarting' };
    }
    await route.fulfill({
      status: route.request().method() === 'POST' ? 202 : 200,
      json: status,
    });
  });
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  const originalUrl = page.url();
  const entry = page.locator('[data-web-shell-update]');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await expect(entry).toHaveAccessibleName('Update');
  await entry.click();
  await expect(entry).toHaveAccessibleName('Restarting…');
  expect(restarts).toBe(1);

  await page.evaluate(() => {
    sessionStorage.setItem('restart-session-unavailable', 'true');
  });
  await daemon.sse.error('Daemon restarting');
  await expect
    .poll(() =>
      page.evaluate(() =>
        sessionStorage.getItem('restart-session-404-observed'),
      ),
    )
    .toBe('true');
  await expect.poll(() => new URL(page.url()).pathname).toBe('/');
  await expect(entry).toBeDisabled();
  await page.evaluate(() =>
    sessionStorage.removeItem('restart-session-unavailable'),
  );
  status = { state: 'up-to-date', currentVersion: '0.24.6', canInstall: false };
  await page.waitForEvent('load');
  await expect(page).toHaveURL(originalUrl);
  await expect(entry).toHaveCount(0);
  expect(restarts).toBe(1);
});

test('nightly versions and update remain readable in More with a narrow sidebar', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const version = '0.24.6-nightly.20260926.a1b2c3d';
  scenario.capabilities.features.push('daemon_update');
  scenario.capabilities.qwenCodeVersion = version;
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.addInitScript(() =>
    localStorage.setItem('qwen-code-web-shell-sidebar-width', '220'),
  );
  await page.route('**/daemon/update**', (route) =>
    route.fulfill({
      json: {
        state: 'ready',
        currentVersion: version,
        latestVersion: '0.24.7',
        canInstall: false,
      },
    }),
  );
  await page.goto(`/session/${scenario.sessionId}?language=en`);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const button = page.getByRole('button', { name: 'Update', exact: true });
  await expect(button).toBeVisible();
  const buttonBox = (await button.boundingBox())!;
  expect(buttonBox.width).toBeGreaterThan(100);
  const badge = page.getByTitle(`Qwen Code v${version}`, { exact: true });
  await expect(badge).toHaveCSS('text-overflow', 'ellipsis');
  await expect(badge).toBeVisible();
  const menu = page.locator('[data-web-shell-sidebar-more]');
  expect(
    await menu.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
});
