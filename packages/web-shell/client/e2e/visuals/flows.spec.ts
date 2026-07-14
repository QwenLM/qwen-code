/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  turnCompleteEvent,
} from '../utils/mockDaemon';
import {
  beat,
  fillComposer,
  gotoSession,
  installScenario,
  recordFlow,
  resolveBaseURL,
} from './harness';

// Flows are recorded as video (later converted to an inline GIF). Each flow
// runs in its own browser context (recordFlow) rather than the shared page
// fixture. Dark theme only — the animation, not the palette, is the point.
// (No serial mode: a flake in one flow must not skip/lose the other's recording.)

test('flow: open the slash menu and switch model', async ({
  browser,
}, testInfo) => {
  const url = resolveBaseURL(testInfo);
  await recordFlow(browser, url, 'model-switch', async (page) => {
    const scenario = createWebShellDaemonScenario();
    const daemon = await installScenario(page, scenario, url);
    await gotoSession(page, scenario, daemon, 'dark');
    await beat(page);

    const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
    await editor.click();
    await page.keyboard.type('/');
    await expect(page.locator('[data-web-shell-slash-menu]')).toBeVisible();
    await beat(page);
    await page.keyboard.type('model');
    await beat(page);
    await page.locator('[data-web-shell-composer-submit]').click();

    await expect(page.locator('[data-web-shell-model-dialog]')).toBeVisible();
    await beat(page);
    await page
      .locator('[data-web-shell-model-option][data-model-id="qwen-test-alt"]')
      .click();
    await expect(page.locator('[data-web-shell-model-dialog]')).toHaveCount(0);
    await beat(page, 900);
  });
});

test('flow: submit a prompt and watch the reply stream in', async ({
  browser,
}, testInfo) => {
  const url = resolveBaseURL(testInfo);
  await recordFlow(browser, url, 'prompt-stream', async (page) => {
    const scenario = createWebShellDaemonScenario();
    const daemon = await installScenario(page, scenario, url);
    await gotoSession(page, scenario, daemon, 'dark');
    await beat(page);

    await fillComposer(page, 'Summarize the web-shell architecture.');
    await beat(page);
    await page.locator('[data-web-shell-composer-submit]').click();

    await expect.poll(() => daemon.promptRequests().length).toBe(1);
    await daemon.sse.split(
      assistantTextEvent('Streaming a reply from the mock daemon', { id: 10 }),
    );
    await beat(page);
    // The mock returns promptId 'prompt-e2e' for a prompt with no
    // _meta.promptId, so complete the live turn with that id (clears the
    // streaming spinner before the recording ends).
    await daemon.sendEvent(turnCompleteEvent('prompt-e2e', { id: 11 }));

    await expect(page.locator('[data-web-shell-message-list]')).toContainText(
      'Streaming a reply',
    );
    await beat(page, 900);
  });
});
