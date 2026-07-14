/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  permissionRequestEvent,
  turnCompleteEvent,
  userTextEvent,
} from '../utils/mockDaemon';
import {
  captureScreenshot,
  fillComposer,
  gotoSession,
  installScenario,
  resolveBaseURL,
  submitLocalCommand,
  VISUAL_VIEWPORT,
  type VisualTheme,
} from './harness';

const THEMES: readonly VisualTheme[] = ['dark', 'light'];

test.use({ viewport: { ...VISUAL_VIEWPORT } });

for (const theme of THEMES) {
  test.describe(`web-shell screenshots (${theme})`, () => {
    test(`session transcript`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario({
        events: [
          userTextEvent('Render the web-shell so I can review the layout.', {
            id: 1,
          }),
          assistantTextEvent(
            'Here is a **streamed** reply with a code block:\n\n```ts\nexport const greeting = "hello from web-shell";\n```',
            { id: 2 },
          ),
          turnCompleteEvent('prompt-visual', { id: 3 }),
        ],
      });
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      await expect(page.locator('[data-web-shell-message-list]')).toContainText(
        'Here is a',
      );
      // Shiki swaps in `<pre class="shiki">` asynchronously; wait for it so the
      // code block is captured highlighted (not the plain fallback) every run.
      await expect(
        page.locator('[data-web-shell-message-list] pre.shiki').first(),
      ).toBeVisible();
      await captureScreenshot(page, `session-transcript-${theme}`);
    });

    test(`slash menu`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario();
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      await fillComposer(page, '/');
      await expect(page.locator('[data-web-shell-slash-menu]')).toBeVisible();
      await captureScreenshot(page, `slash-menu-${theme}`);
    });

    test(`model dialog`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario();
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      await submitLocalCommand(page, '/model');
      await expect(page.locator('[data-web-shell-model-dialog]')).toBeVisible();
      await captureScreenshot(page, `model-dialog-${theme}`);
    });

    test(`theme dialog`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario();
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      await submitLocalCommand(page, '/theme');
      await expect(page.locator('[data-web-shell-theme-dialog]')).toBeVisible();
      await captureScreenshot(page, `theme-dialog-${theme}`);
    });

    test(`permission panel`, async ({ page }, testInfo) => {
      const scenario = createWebShellDaemonScenario({
        events: [permissionRequestEvent('perm-visual', { id: 1 })],
      });
      const daemon = await installScenario(
        page,
        scenario,
        resolveBaseURL(testInfo),
      );
      await gotoSession(page, scenario, daemon, theme);

      await expect(
        page.locator('[data-web-shell-permission-panel]'),
      ).toBeVisible();
      await captureScreenshot(page, `permission-panel-${theme}`);
    });
  });
}
