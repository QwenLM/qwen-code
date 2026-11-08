import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

// A dev-server boot is a few hundred module requests, so a transient abort
// (Chromium's net::ERR_NETWORK_CHANGED on a shared pool host) kills the whole
// graph and the boot watchdog shows "failed to load" instead of the shell.
// The harness reloads such a boot; without that, every assertion on the shell
// times out and the shard fails on a run no diff of it caused.
test('an aborted entry module reloads instead of stranding the boot @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });

  let entryRequests = 0;
  await page.route('**/main.tsx', async (route) => {
    entryRequests += 1;
    if (entryRequests === 1) {
      await route.abort('failed');
      return;
    }
    await route.fallback();
  });

  await page.goto(`/session/${scenario.sessionId}?theme=light&language=en`);

  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  await expect(page.locator('[data-boot-fallback]')).toHaveCount(0);
  expect(entryRequests).toBe(2);
});

// The budget is what keeps a genuinely broken entry module from reloading
// forever: three attempts, then the watchdog panel is the test's failure.
test('an entry module that never loads stops after the reload budget @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });

  let entryRequests = 0;
  await page.route('**/main.tsx', async (route) => {
    entryRequests += 1;
    await route.abort('failed');
  });

  await page.goto(`/session/${scenario.sessionId}?theme=light&language=en`);

  await expect(page.locator('[data-boot-fallback]')).toHaveCount(1, {
    timeout: 30_000,
  });
  expect(entryRequests).toBe(3);
});
