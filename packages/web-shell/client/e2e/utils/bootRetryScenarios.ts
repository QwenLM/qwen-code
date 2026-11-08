import { expect, type Page, type TestInfo } from '@playwright/test';
import { createWebShellDaemonScenario, installMockDaemon } from './mockDaemon';

const SHELL = '[data-web-shell-root]:not([data-web-shell-gate])';
// Every mount assertion here allows for a second full boot of the graph: the
// suite's 20 s visibility budget measures one, and a cold dev server measured
// 26 s for the first here before the reload even started.
const BOOT_VISIBLE_TIMEOUT_MS = 40_000;
const ENTRY_URL = (sessionId: string, suffix = '') =>
  `/session/${sessionId}?theme=light&language=en${suffix}`;

export interface BootRetryScenario {
  title: string;
  run: (page: Page, testInfo: TestInfo) => Promise<void>;
}

/** Give the page a mocked daemon for the session these scenarios load. */
async function openShell(page: Page, testInfo: TestInfo) {
  const scenario = createWebShellDaemonScenario();
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  return scenario;
}

function trackDocuments(page: Page): string[] {
  const documents: string[] = [];
  page.on('request', (request) => {
    if (
      request.frame() === page.mainFrame() &&
      request.resourceType() === 'document'
    ) {
      documents.push(request.url());
    }
  });
  return documents;
}

/**
 * The boot-retry contract, shared by the desktop and mobile specs.
 *
 * A dev-server boot is a few hundred module requests, so a transient abort
 * (Chromium's net::ERR_NETWORK_CHANGED on a shared pool host) kills the whole
 * graph and the boot watchdog shows "failed to load" instead of the shell.
 * The harness reloads such a boot; without that, every assertion on the shell
 * times out and the shard fails on a run no diff of it caused.
 *
 * The specs call `test()` for each entry so the cases are attributed to the
 * spec file; the mobile projects collect only `*.mobile.spec.ts`, and the
 * engine independence the helper claims is only exercised if they run there.
 */
export const bootRetryScenarios: BootRetryScenario[] = [
  {
    title:
      'an aborted entry module reloads instead of stranding the boot @smoke',
    async run(page, testInfo) {
      const scenario = await openShell(page, testInfo);

      let entryRequests = 0;
      await page.route('**/main.tsx', async (route) => {
        entryRequests += 1;
        if (entryRequests === 1) {
          await route.abort('failed');
          return;
        }
        await route.fallback();
      });

      await page.goto(ENTRY_URL(scenario.sessionId));

      await expect(page.locator(SHELL)).toBeVisible({
        timeout: BOOT_VISIBLE_TIMEOUT_MS,
      });
      await expect(page.locator('[data-boot-fallback]')).toHaveCount(0);
      expect(entryRequests).toBe(2);
    },
  },
  {
    // The budget is what keeps a genuinely broken entry module from reloading
    // forever: three attempts, then the watchdog panel is the test's failure.
    title:
      'an entry module that never loads stops after the reload budget @smoke',
    async run(page, testInfo) {
      const scenario = await openShell(page, testInfo);

      let entryRequests = 0;
      await page.route('**/main.tsx', async (route) => {
        entryRequests += 1;
        await route.abort('failed');
      });

      await page.goto(ENTRY_URL(scenario.sessionId));

      // The watchdog paints its panel on the first failed fetch, before the
      // reload it triggers has even been issued, so the panel is not a signal
      // that the budget is spent. Poll the counter instead: engines differ by
      // tens to hundreds of milliseconds between the panel and the reload.
      await expect.poll(() => entryRequests, { timeout: 30_000 }).toBe(3);
      // Polling sees the third attempt the moment it happens, so the bound
      // needs a quiet window as well: one more reload would follow within a
      // cycle of the third attempt's load.
      await page.waitForTimeout(4_000);
      expect(entryRequests).toBe(3);
      await expect(page.locator('[data-boot-fallback]')).toHaveCount(1);
    },
  },
  {
    // The budget is per boot, not per page: a boot that completes must hand it
    // back, or the next aborted navigation in the same tab finds nothing left.
    title:
      'a completed boot keeps the reload budget for later navigations @smoke',
    async run(page, testInfo) {
      const scenario = await openShell(page, testInfo);

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
          ENTRY_URL(scenario.sessionId, `&navigation=${navigation}`),
        );
        await expect(page.locator(SHELL)).toBeVisible({
          timeout: BOOT_VISIBLE_TIMEOUT_MS,
        });
      }

      expect(entryRequests).toBe(6);
    },
  },
  {
    // A document being left can still have module requests in flight; the
    // navigation cancels them and the failure is reported after the
    // destination's own document request, so a frame-only predicate charges it
    // to the new boot and reloads a healthy page.
    title:
      'a module cancelled by navigation does not reload the destination @smoke',
    async run(page, testInfo) {
      const scenario = await openShell(page, testInfo);
      // Never settled: the import stays pending until navigation cancels it.
      await page.route('**/pending-import.js', () => {});

      await page.goto(ENTRY_URL(scenario.sessionId, '&navigation=1'));
      await expect(page.locator(SHELL)).toBeVisible({
        timeout: BOOT_VISIBLE_TIMEOUT_MS,
      });
      await page.evaluate(() => {
        void import('/pending-import.js').catch(() => {});
      });

      const documents = trackDocuments(page);
      await page.goto(ENTRY_URL(scenario.sessionId, '&navigation=2'));
      await expect(page.locator(SHELL)).toBeVisible({
        timeout: BOOT_VISIBLE_TIMEOUT_MS,
      });

      expect(documents).toHaveLength(1);
    },
  },
  {
    // The retry keys on main-frame script requests only. A queued fetch that
    // fails during the boot window proves nothing about the graph, and
    // reloading for it would interrupt every page in the suite.
    title: 'a fetch aborted during boot does not reload the page @smoke',
    async run(page, testInfo) {
      const scenario = await openShell(page, testInfo);
      await page.addInitScript(() => {
        void fetch('/boot-probe-fetch').catch(() => {});
      });
      await page.route('**/boot-probe-fetch', (route) => route.abort('failed'));

      const documents = trackDocuments(page);
      await page.goto(ENTRY_URL(scenario.sessionId));
      await expect(page.locator(SHELL)).toBeVisible({
        timeout: BOOT_VISIBLE_TIMEOUT_MS,
      });

      expect(documents).toHaveLength(1);
    },
  },
  {
    // Same predicate, other conjunct: a sub-frame script has its own graph, so
    // its failure cannot strand the shell's boot. The frame has to be in the
    // served HTML — a script-inserted iframe does not delay the parent's load,
    // so its failure would arrive after the decision point and prove nothing.
    title:
      'a sub-frame script aborted during boot does not reload the page @smoke',
    async run(page, testInfo) {
      const scenario = await openShell(page, testInfo);
      await page.route('**/boot-probe-frame.html', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: '<!doctype html><script src="/boot-probe-frame.js"></script>',
        }),
      );
      await page.route(
        (url) => url.pathname.startsWith('/session/'),
        async (route) => {
          const response = await route.fetch();
          const body = await response.text();
          await route.fulfill({
            response,
            body: body.replace(
              /<body([^>]*)>/i,
              '<body$1><iframe src="/boot-probe-frame.html" title="boot probe"></iframe>',
            ),
          });
        },
      );
      await page.route('**/boot-probe-frame.js', (route) =>
        route.abort('failed'),
      );

      const documents = trackDocuments(page);
      await page.goto(ENTRY_URL(scenario.sessionId));
      await expect(page.locator(SHELL)).toBeVisible({
        timeout: BOOT_VISIBLE_TIMEOUT_MS,
      });

      expect(documents).toHaveLength(1);
    },
  },
];
