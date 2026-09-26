import { expect, test } from '@playwright/test';
import type { DaemonUpdateStatus } from '@qwen-code/sdk/daemon';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

test('downloads silently, shows a version-adjacent button and restarts in place @smoke', async ({
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
  const url = `/session/${scenario.sessionId}?language=zh-CN`;
  await page.goto(url);
  const entry = page.locator('[data-web-shell-update]');
  await expect.poll(() => preparations).toBe(1);
  await expect(entry).toHaveCount(0);
  expect(restarts).toBe(0);
  status = { ...status, state: 'ready' };
  await expect(entry).toHaveAccessibleName('更新');
  const version = page.getByTitle('Qwen Code v0.24.4', { exact: true });
  for (const width of [220, 343, 360, 260]) {
    await page.evaluate((sidebarWidth) => {
      localStorage.setItem(
        'qwen-code-web-shell-sidebar-width',
        String(sidebarWidth),
      );
    }, width);
    await page.reload();
    await expect(entry).toBeVisible();
    const buttonBox = (await entry.boundingBox())!;
    const versionBox = (await version.boundingBox())!;
    const settingsBox = (await page
      .getByRole('button', { name: '设置', exact: true })
      .boundingBox())!;
    expect(buttonBox.x).toBeGreaterThan(versionBox.x + versionBox.width);
    expect(
      Math.abs(
        buttonBox.y +
          buttonBox.height / 2 -
          versionBox.y -
          versionBox.height / 2,
      ),
    ).toBeLessThan(2);
    expect(buttonBox.y + buttonBox.height).toBeLessThan(settingsBox.y);
  }
  await page.screenshot({ path: testInfo.outputPath('update-sidebar.png') });
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await expect(entry).toBeVisible();
  expect((await entry.boundingBox())!.width).toBeLessThanOrEqual(32);
  expect(preparations).toBe(1);
  expect(restarts).toBe(0);
  const beforeRestartUrl = page.url();
  await entry.click();
  await expect(entry).toHaveAccessibleName('重启中…');
  await expect(entry).toBeDisabled();
  expect(restarts).toBe(1);
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
  await expect(
    page.getByRole('button', { name: 'Settings', exact: true }),
  ).toBeVisible();
  await expect(page.locator('[data-web-shell-update]')).toHaveCount(0);
  expect(requests).toBe(0);
});

test('nightly versions leave the update button visible in a narrow sidebar', async ({
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
  const button = page.getByRole('button', { name: 'Update', exact: true });
  await expect(button).toBeVisible();
  const buttonBox = (await button.boundingBox())!;
  const sidebarBox = (await page
    .getByRole('complementary', { name: 'Workspace sidebar' })
    .boundingBox())!;
  expect(buttonBox.x + buttonBox.width).toBeLessThan(
    sidebarBox.x + sidebarBox.width,
  );
  const badge = page.getByTitle(`Qwen Code v${version}`, { exact: true });
  await expect(badge).toHaveCSS('text-overflow', 'ellipsis');
  expect(
    await badge.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    ),
  ).toBe(true);
  expect((await badge.boundingBox())!.x).toBeLessThan(buttonBox.x);
});
