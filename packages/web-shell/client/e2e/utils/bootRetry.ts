import type { Page, Request } from '@playwright/test';

/** Reloads allowed for one tab whose boot keeps failing. */
const MAX_BOOT_RELOADS = 2;
const installedPages = new WeakSet<Page>();

/**
 * Reload a boot that a transient request abort killed.
 *
 * A dev-server boot is a few hundred module requests. Chromium aborts every
 * in-flight request with net::ERR_NETWORK_CHANGED when its network-change
 * notifier fires — every minute or two on a busy pool host — so a boot that
 * spans one of those events never finishes and index.html's boot watchdog
 * shows "failed to load" instead.
 *
 * The failure is read from Playwright's request events rather than from the
 * page: a module that cannot load is a failed `script` request on every
 * engine, while whether the browser also dispatches an `error` the page can
 * observe is engine-specific — WebKit does not deliver one to a listener an
 * init script installed.
 */
export async function installBootRetry(page: Page): Promise<void> {
  // A spec that installs a second (peer) daemon on the same page calls this
  // again; two sets of listeners would spend the budget twice.
  if (installedPages.has(page)) return;
  installedPages.add(page);

  const onMainFrame = (request: Request): boolean =>
    request.frame() === page.mainFrame();
  let failedDuringBoot = false;
  let reloads = 0;

  page.on('request', (request) => {
    // A new document starts a new boot; only failures after it count.
    if (onMainFrame(request) && request.resourceType() === 'document') {
      failedDuringBoot = false;
    }
  });
  page.on('requestfailed', (request) => {
    if (onMainFrame(request) && request.resourceType() === 'script') {
      failedDuringBoot = true;
    }
  });
  page.on('load', () => {
    if (!failedDuringBoot) {
      // An undisturbed boot hands the budget back to the next navigation.
      reloads = 0;
      return;
    }
    // An abort of a non-essential script still costs one reload; the budget
    // caps that at two, and the healthy second load returns it.
    if (reloads >= MAX_BOOT_RELOADS) return;
    reloads += 1;
    // Reload after the load the test awaited, so its navigation has settled.
    setTimeout(() => {
      void page.reload().catch(() => {});
    }, 0);
  });
}
