import type { Page } from '@playwright/test';

const RELOAD_BUDGET_KEY = 'web-shell-e2e-boot-reloads';
const MAX_BOOT_RELOADS = 2;
const installedPages = new WeakSet<Page>();

/**
 * Reload a boot that a transient request abort killed.
 *
 * A dev-server boot is a few hundred module requests. Chromium aborts every
 * in-flight request with net::ERR_NETWORK_CHANGED when its network-change
 * notifier fires — every minute or two on a busy pool host — so a boot that
 * spans one of those events never finishes and index.html's boot watchdog
 * shows "failed to load" instead. Reloading is what that panel tells the user
 * to do, and it is cheap here: the dev server keeps its transform results.
 */
export async function installBootRetry(page: Page): Promise<void> {
  // A spec that installs a second (peer) daemon on the same page calls this
  // again; two listeners would spend the budget twice for one failed boot.
  if (installedPages.has(page)) return;
  installedPages.add(page);
  await page.addInitScript(bootRetry, {
    budgetKey: RELOAD_BUDGET_KEY,
    maxReloads: MAX_BOOT_RELOADS,
  });
}

function bootRetry({
  budgetKey,
  maxReloads,
}: {
  budgetKey: string;
  maxReloads: number;
}) {
  const readBudget = (): number => {
    try {
      const stored = Number(sessionStorage.getItem(budgetKey) ?? '0');
      // An unreadable meter must not grant reloads; the reload would never
      // stop.
      return Number.isFinite(stored) ? stored : maxReloads;
    } catch {
      return maxReloads;
    }
  };
  let failed = false;
  window.addEventListener(
    'error',
    (event) => {
      const target = event.target as HTMLScriptElement | null;
      // A failed fetch of a module script is the only proof the boot cannot
      // finish. An inline script that throws also targets a SCRIPT element,
      // but carries no src.
      if (!target || target.tagName !== 'SCRIPT' || !target.src) return;
      failed = true;
    },
    true,
  );
  window.addEventListener('load', () => {
    // Both decisions live on `load`: module failures are known by then, so an
    // undisturbed load proves the boot finished, and a failed one is complete.
    if (!failed) {
      try {
        sessionStorage.removeItem(budgetKey);
      } catch {
        // Storage is unreachable in a sandboxed document; nothing to reset.
      }
      return;
    }
    const used = readBudget();
    if (used >= maxReloads) return;
    try {
      sessionStorage.setItem(budgetKey, String(used + 1));
    } catch {
      return;
    }
    // Reload after the current task, so the page's own load handlers settle
    // before the document goes away.
    setTimeout(() => location.reload(), 0);
  });
}
