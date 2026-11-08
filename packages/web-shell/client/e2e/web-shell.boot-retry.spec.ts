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
//
// Every mount assertion here allows for a second full boot of the graph: the
// suite's 20 s visibility budget measures one, and a cold dev server measured
// 26 s for the first here before the reload even started.
const BOOT_VISIBLE_TIMEOUT_MS = 40_000;
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
  ).toBeVisible({ timeout: BOOT_VISIBLE_TIMEOUT_MS });
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

  // The watchdog paints its panel on the first failed fetch, before the
  // reload it triggers has even been issued, so the panel is not a signal
  // that the budget is spent. Poll the counter instead: engines differ by
  // tens to hundreds of milliseconds between the panel and the reload.
  await expect.poll(() => entryRequests, { timeout: 30_000 }).toBe(3);
  // Polling sees the third attempt the moment it happens, so the bound needs
  // a quiet window as well: one more reload would follow within a cycle of
  // the third attempt's load.
  await page.waitForTimeout(4_000);
  expect(entryRequests).toBe(3);
  await expect(page.locator('[data-boot-fallback]')).toHaveCount(1);
});

// The budget is per boot, not per page: a boot that completes must hand it
// back, or the next aborted navigation in the same tab finds nothing left.
test('a completed boot keeps the reload budget for later navigations @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });

  let entryRequests = 0;
  await page.route('**/main.tsx', async (route) => {
    entryRequests += 1;
    if (entryRequests % 2 === 1) {
      await route.abort('failed');
      return;
    }
    await route.fallback();
  });

  for (const navigation of [1, 2, 3]) {
    await page.goto(
      `/session/${scenario.sessionId}?theme=light&language=en&navigation=${navigation}`,
    );
    await expect(
      page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
    ).toBeVisible({ timeout: BOOT_VISIBLE_TIMEOUT_MS });
  }

  expect(entryRequests).toBe(6);
});

// A document being left can still have module requests in flight; the
// navigation cancels them and the failure is reported after the destination's
// own document request, so a frame-only predicate charges it to the new boot
// and reloads a healthy page.
test('a module cancelled by navigation does not reload the destination @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  // Never settled: the import stays pending until navigation cancels it.
  await page.route('**/pending-import.js', () => {});

  await page.goto(
    `/session/${scenario.sessionId}?theme=light&language=en&navigation=1`,
  );
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible({ timeout: BOOT_VISIBLE_TIMEOUT_MS });
  await page.evaluate(() => {
    void import('/pending-import.js').catch(() => {});
  });

  const documents: string[] = [];
  page.on('request', (request) => {
    if (
      request.frame() === page.mainFrame() &&
      request.resourceType() === 'document'
    ) {
      documents.push(request.url());
    }
  });

  await page.goto(
    `/session/${scenario.sessionId}?theme=light&language=en&navigation=2`,
  );
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible({ timeout: BOOT_VISIBLE_TIMEOUT_MS });

  expect(documents).toHaveLength(1);
});
