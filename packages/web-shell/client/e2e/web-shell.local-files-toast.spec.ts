/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

// Real-browser regression for the re-authorization notice: when a persisted
// grant restores with permission=prompt, the bridge parks in needs-gesture and
// a one-time warning toast must reach the real toast host WITHOUT the user
// opening the popover. The grant store is intercepted at IndexedDB (a real
// FileSystemDirectoryHandle cannot be created without the native picker), but
// the whole requestToast -> ToastHost path is unmocked. This is the gap a
// stubbed-status unit test cannot see: the toast never reaching a real host.
test('local files needs-gesture grant raises a one-time toast on restore @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: '/tmp/qwen-local-files-toast-e2e',
    capabilities: {
      features: [
        'session_events',
        'session_source_metadata',
        'workspace_settings',
        'client_mcp_over_ws',
      ],
      workspaces: [
        {
          id: 'project',
          cwd: '/tmp/qwen-local-files-toast-e2e',
          primary: true,
          trusted: true,
        },
      ],
    },
  });
  await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });

  // Restore a "persisted" grant whose permission has fallen back to prompt.
  // Only the IDB get result is overridden; the transaction lifecycle is real.
  await page.addInitScript(() => {
    const fakeHandle = {
      kind: 'directory',
      name: 'persisted-dir',
      queryPermission: async () => 'prompt',
      requestPermission: async () => 'prompt',
    };
    const origGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (
      ...args: Parameters<typeof origGet>
    ) {
      const req = origGet.apply(this, args);
      try {
        if (
          this.name === 'handles' &&
          String(args[0]).indexOf('directory') === 0
        ) {
          Object.defineProperty(req, 'result', {
            get: () => fakeHandle,
            configurable: true,
          });
        }
      } catch {
        // Leave unrelated stores untouched.
      }
      return req;
    };
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?language=en');
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();

  // The toast must appear on its own (no popover interaction) and name the grant.
  const toast = page.locator('[data-web-shell-toast]', {
    hasText: 'persisted-dir',
  });
  await expect(toast).toBeVisible({ timeout: 20_000 });
  await expect(toast).toContainText('reconnected');
  await expect(toast).toHaveCount(1);

  // The trigger reflects needs-gesture with the amber dot, and the panel offers
  // Reconnect — the state the toast is announcing.
  const more = page.getByRole('button', { name: 'More', exact: true });
  if (await more.count()) {
    await more.click();
  }
  const trigger = page.getByRole('button', {
    name: 'Local files',
    exact: true,
  });
  await expect(trigger).toBeVisible({ timeout: 15_000 });
  await expect(trigger.locator('span.bg-amber-500')).toHaveCount(1);
  await trigger.click();
  const panel = page.locator('[data-web-shell-local-files-panel]');
  await expect(panel.getByRole('button', { name: 'Reconnect' })).toBeVisible({
    timeout: 15_000,
  });

  await page.screenshot({
    path: testInfo.outputPath('local-files-needs-gesture-toast.png'),
    fullPage: false,
  });
});
