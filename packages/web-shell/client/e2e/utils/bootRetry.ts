import type { Page, Request } from '@playwright/test';

/**
 * Delay before each successive reload of a failing boot.
 *
 * The aborts arrive in storms, not one at a time: every in-flight request dies
 * together, and the notifier can keep firing for several seconds. Retrying
 * immediately spends the whole budget inside the storm that caused the first
 * failure — run 42546153793 stranded a boot whose three attempts started at
 * 01:55:24.631, :25.536 and :27.599 while the aborts covered :24–:27. Spacing
 * the attempts is what lands one after the storm has passed.
 *
 * The ladder waits 5.5 s in total, which has to fit inside the 20 s `expect`
 * budget the rest of the suite asserts visibility with.
 */
export const BOOT_RELOAD_BACKOFF_MS = [500, 1_500, 3_500] as const;

/** Reloads allowed for one tab whose boot keeps failing. */
export const MAX_BOOT_RELOADS = BOOT_RELOAD_BACKOFF_MS.length;

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
  let pendingReload: ReturnType<typeof setTimeout> | null = null;

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
      // The backoff opens a window the immediate reload did not have: a
      // navigation the test drives while a reload is waiting supersedes it,
      // and the stale timer would otherwise reload the new destination.
      if (pendingReload !== null) {
        clearTimeout(pendingReload);
        pendingReload = null;
      }
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
    // caps that, and the next healthy load returns it.
    if (reloads >= MAX_BOOT_RELOADS) return;
    const delay = BOOT_RELOAD_BACKOFF_MS[reloads];
    reloads += 1;
    // Reload after the load the test awaited, so its navigation has settled,
    // then wait out the rest of the storm before spending the next attempt.
    pendingReload = setTimeout(() => {
      pendingReload = null;
      void page.reload().catch(() => {});
    }, delay);
  });
}
