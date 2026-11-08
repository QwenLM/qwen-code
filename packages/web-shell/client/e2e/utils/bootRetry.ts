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

  const mainFrame = (request: Request): boolean =>
    request.frame() === page.mainFrame();
  // The main frame survives navigation, so requests from the document being
  // left keep arriving after the next boot started — a pending import is
  // cancelled by the navigation and reports as a failed script then. Stamp
  // each request with the boot it was issued in and ignore later boots' views
  // of it.
  let boot = 0;
  let failedBoot = -1;
  const bootOf = new WeakMap<Request, number>();
  let reloads = 0;

  page.on('request', (request) => {
    bootOf.set(request, boot);
  });
  // Advance on the document's response rather than its request: the outgoing
  // document keeps running while the next response is pending, and a request
  // it starts in that window belongs to the page being left, not the one that
  // is about to commit.
  page.on('response', (response) => {
    const request = response.request();
    if (mainFrame(request) && request.resourceType() === 'document') {
      boot += 1;
    }
  });
  page.on('requestfailed', (request) => {
    if (!mainFrame(request) || request.resourceType() !== 'script') return;
    if (bootOf.get(request) !== boot) return;
    failedBoot = boot;
  });
  page.on('load', () => {
    if (failedBoot !== boot) {
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
