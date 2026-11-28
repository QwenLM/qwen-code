import { expect, test, type Page } from '@playwright/test';
import type { DaemonUpdateStatus } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

async function expectUpdateAboveSettings(page: Page) {
  // Read both rectangles in one frame while the menu animates.
  const { buttonWidth, updateBottom, settingsTop } = await page
    .locator('[data-web-shell-sidebar-more]')
    .evaluate((menu) => {
      const update = menu
        .querySelector('[data-web-shell-update]')!
        .getBoundingClientRect();
      const settings = menu
        .querySelector('button[aria-label="设置"]')!
        .getBoundingClientRect();
      return {
        buttonWidth: update.width,
        updateBottom: update.bottom,
        settingsTop: settings.top,
      };
    });
  expect(buttonWidth).toBeGreaterThan(100);
  expect(updateBottom).toBeLessThan(settingsTop);
}

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
  await expect(entry).toBeVisible();
  await expectUpdateAboveSettings(page);
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
  await expect.poll(() => restarts).toBe(1);
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

test('keeps the update action above Settings across sidebar widths @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  scenario.capabilities.features.push('daemon_update');
  scenario.capabilities.qwenCodeVersion = '0.24.4';
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  let updatePosts = 0;
  await page.route('**/daemon/update**', async (route) => {
    if (route.request().method() === 'POST') {
      updatePosts++;
    }
    await route.fulfill({
      status: 200,
      json: {
        state: 'ready',
        currentVersion: '0.24.4',
        latestVersion: '0.24.6',
        canInstall: false,
      } satisfies DaemonUpdateStatus,
    });
  });
  await page.addInitScript(() => {
    localStorage.setItem('qwen-code-web-shell-language', 'zh-CN');
    if (!localStorage.getItem('qwen-code-web-shell-sidebar-width')) {
      localStorage.setItem('qwen-code-web-shell-sidebar-width', '220');
    }
  });
  await page.goto(`/session/${scenario.sessionId}?language=zh-CN#turn-2`);
  const sidebar = page.getByRole('complementary', { name: '工作区侧边栏' });
  const entry = page.locator('[data-web-shell-update]');
  const widths = [
    { stored: 220, expected: 276 },
    { stored: 343, expected: 343 },
    { stored: 360, expected: 360 },
  ];
  for (const [index, { stored, expected }] of widths.entries()) {
    if (index > 0) {
      await page.evaluate((sidebarWidth) => {
        localStorage.setItem(
          'qwen-code-web-shell-sidebar-width',
          String(sidebarWidth),
        );
      }, stored);
      await page.reload();
    }
    await expect(sidebar).toHaveCSS('width', `${expected}px`);
    await page.getByRole('button', { name: '更多', exact: true }).click();
    await expect(entry).toBeVisible();
    await expectUpdateAboveSettings(page);
  }
  expect(updatePosts).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('update-sidebar.png') });
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

test('shows manual update instructions when one-click is unavailable @smoke', async ({
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
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const entry = page.locator('[data-web-shell-update]');
  await expect(entry).toHaveAccessibleName('Update');
  await expect(entry).toHaveAttribute('title', 'Update to v0.24.6 (manual)');
  await entry.click();
  const panel = page.locator('[data-web-shell-update-manual]');
  const more = page.locator('[data-web-shell-sidebar-more]');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(
    'npm install -g @qwen-code/qwen-code@0.24.6',
  );
  await expect(panel).toContainText('cannot be updated from the Web Shell');
  // The panel takes focus when it opens; an immediate visibility assertion
  // can observe the exit animation while the rail More menu dismisses both
  // layers. Wait past that window and require both to stay open.
  await page.waitForTimeout(500);
  await expect(panel).toBeVisible();
  await expect(more).toBeVisible();
  // Selecting the command text is an outside interaction for More too.
  await panel.locator('pre').selectText();
  await page.waitForTimeout(200);
  await expect(panel).toBeVisible();
  await expect(more).toBeVisible();
  expect(preparations).toBe(0);
  expect(restarts).toBe(0);
  await page.screenshot({ path: testInfo.outputPath('update-manual.png') });
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
