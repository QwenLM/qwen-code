/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The model sheet also stands in for the popover in narrow desktop windows:
// MODEL_SHEET_QUERY's second disjunct is (max-width: 639px), with no pointer
// condition. A mouse-driven window that narrow must get the sheet but none of
// the touch sizing. Runs under the desktop `chromium` project (no touch).

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
}

test('a narrow mouse-driven window gets the sheet without touch sizing', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 600, height: 800 });
  const scenario = createWebShellDaemonScenario();
  scenario.state.configOptions = [
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'none', name: 'Thinking off' },
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
      _meta: { 'qwenCode/reasoning': { defaultEffort: 'high' } },
    },
  ];
  const daemon = await installScenario(page, scenario, testInfo);
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: 0,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);

  // The window is narrow, but it is not a touch device.
  expect(
    await page.evaluate(
      () => matchMedia('(hover: none) and (pointer: coarse)').matches,
    ),
  ).toBe(false);

  await page.locator('[data-web-shell-model-button]').click();
  const sheet = page.locator('[data-web-shell-model-sheet]');
  await expect(sheet).toBeVisible();

  const effort = sheet.locator('[data-web-shell-effort]').first();
  await expect(effort).toBeVisible();
  expect((await effort.boundingBox())!.height).toBeLessThan(44);

  const done = sheet.locator('[data-web-shell-model-sheet-done]');
  await expect(done).toBeVisible();
  expect((await done.boundingBox())!.height).toBeLessThan(44);

  await sheet.locator('[data-web-shell-model-submenu-trigger]').click();
  const row = sheet.locator('[data-model-id]').first();
  await expect(row).toBeVisible();
  expect((await row.boundingBox())!.height).toBeLessThan(44);

  const search = sheet.locator('input[type="search"]');
  await expect(search).toBeVisible();
  expect((await search.boundingBox())!.height).toBeLessThan(44);
  // Spell-check stays on for a mouse-driven field.
  expect(await search.getAttribute('spellcheck')).toBeNull();
  expect(await search.getAttribute('enterkeyhint')).toBeNull();
});
