/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

/**
 * QwenLM/qwen-code#12874: once the docked right panel is open, the header
 * toggle unmounts by design and the panel's own toolbar button (same label)
 * takes over the close action. On the macOS Desktop shell the fixed 38px
 * overlay-titlebar drag region used to cover that button, so the second
 * "toggle" click never reached it and the panel could not be closed.
 */

const RIGHT_PANEL = 'aside[aria-label="Right panel"]';
const TOGGLE_NAME = 'Toggle right panel';

async function openSessionWithMockDaemon(page: Page, baseURL: string) {
  const scenario = createWebShellDaemonScenario();
  await installMockDaemon(page, scenario, { baseURL });
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  const headerToggle = page.getByRole('button', { name: TOGGLE_NAME });
  await expect(headerToggle).toBeVisible();
  return headerToggle;
}

test('docked right panel closes from its own toolbar toggle', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const baseURL = String(testInfo.project.use.baseURL);
  const headerToggle = await openSessionWithMockDaemon(page, baseURL);

  await headerToggle.click();
  const panel = page.locator(RIGHT_PANEL);
  await expect(panel).toBeVisible();

  // Hand-over: the header toggle unmounts once the panel is open, and the
  // panel's toolbar button (same label, pressed) becomes the only toggle.
  const panelToggle = panel.getByRole('button', { name: TOGGLE_NAME });
  await expect(panelToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: TOGGLE_NAME })).toHaveCount(1);

  await panelToggle.click();
  await expect(panel).toBeHidden();
});

test('macOS desktop titlebar drag region does not occlude the panel toggle', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    (
      window as unknown as { __QWEN_CODE_MACOS_TITLEBAR__?: boolean }
    ).__QWEN_CODE_MACOS_TITLEBAR__ = true;
  });
  const baseURL = String(testInfo.project.use.baseURL);
  const headerToggle = await openSessionWithMockDaemon(page, baseURL);

  const dragRegion = page.locator('.qwen-code-macos-titlebar-drag-region');
  await expect(dragRegion).toBeAttached();

  await headerToggle.click();
  const panel = page.locator(RIGHT_PANEL);
  await expect(panel).toBeVisible();

  const panelToggle = panel.getByRole('button', { name: TOGGLE_NAME });
  await expect(panelToggle).toBeVisible();

  // The button's click point must resolve to the button itself (or its
  // contents), not to the fixed drag region painted above the dock.
  const occluded = await panelToggle.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    return hit !== null && hit !== button && !button.contains(hit);
  });
  expect(occluded).toBe(false);

  // Playwright's hit-target check would keep retrying while the drag region
  // intercepts pointer events, so this click alone catches the occlusion.
  await panelToggle.click({ timeout: 10_000 });
  await expect(panel).toBeHidden();
});
