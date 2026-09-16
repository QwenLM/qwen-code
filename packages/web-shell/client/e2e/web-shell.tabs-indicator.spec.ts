/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';

async function openSidebarWithSourceSwitch(page: Page, baseURL: string) {
  const scenario = createWebShellDaemonScenario({
    workspaceCwd: '/tmp/qwen-web-shell-e2e',
    capabilities: {
      features: ['session_events', 'session_source_metadata'],
    },
  });
  await installMockDaemon(page, scenario, { baseURL });
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
}

async function horizontalBox(locator: Locator) {
  const rect = await locator.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { left: box.left, width: box.width };
  });
  return rect;
}

test.describe('session source switch sliding indicator', () => {
  test('pill overlays the active trigger and slides on switch @smoke', async ({
    page,
  }, testInfo) => {
    await openSidebarWithSourceSwitch(
      page,
      String(testInfo.project.use.baseURL),
    );

    const tasksTab = page.getByRole('tab', { name: 'Tasks' });
    const channelsTab = page.getByRole('tab', { name: 'Channels' });
    const indicator = page.locator('[data-slot="tabs-list-indicator"]');
    await expect(indicator).toBeVisible();

    const expectOverlay = async (tab: Locator) => {
      const [tabBox, pillBox] = await Promise.all([
        horizontalBox(tab),
        horizontalBox(indicator),
      ]);
      expect(pillBox.left).toBeCloseTo(tabBox.left, 0);
      expect(pillBox.width).toBeCloseTo(tabBox.width, 0);
    };

    await expectOverlay(tasksTab);

    // Record the pill's left edge through the switch to prove it slides
    // (intermediate positions) instead of cross-fading in place.
    const tracePromise = page.evaluate(async () => {
      const pill = document.querySelector('[data-slot="tabs-list-indicator"]');
      if (!pill) {
        return [];
      }
      const samples: number[] = [];
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const tick = () => {
          samples.push(pill.getBoundingClientRect().left);
          if (performance.now() - start < 400) {
            requestAnimationFrame(tick);
          } else {
            resolve();
          }
        };
        requestAnimationFrame(tick);
      });
      return samples;
    });
    await channelsTab.click();
    const trace = await tracePromise;

    await expectOverlay(channelsTab);

    const startLeft = (await horizontalBox(tasksTab)).left;
    const endLeft = (await horizontalBox(channelsTab)).left;
    const intermediate = trace.filter(
      (left) =>
        left > startLeft + 1 && left < endLeft - 1 && Number.isFinite(left),
    );
    expect(intermediate.length).toBeGreaterThan(0);
  });

  test('snaps without a transition under prefers-reduced-motion @smoke', async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openSidebarWithSourceSwitch(
      page,
      String(testInfo.project.use.baseURL),
    );

    const indicator = page.locator('[data-slot="tabs-list-indicator"]');
    await expect(indicator).toBeVisible();

    const tasksLeft = (
      await horizontalBox(page.getByRole('tab', { name: 'Tasks' }))
    ).left;
    const channelsLeft = (
      await horizontalBox(page.getByRole('tab', { name: 'Channels' }))
    ).left;

    const tracePromise = page.evaluate(async () => {
      const pill = document.querySelector('[data-slot="tabs-list-indicator"]');
      if (!pill) {
        return [];
      }
      const samples: number[] = [];
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const tick = () => {
          samples.push(pill.getBoundingClientRect().left);
          if (performance.now() - start < 400) {
            requestAnimationFrame(tick);
          } else {
            resolve();
          }
        };
        requestAnimationFrame(tick);
      });
      return samples;
    });
    await page.getByRole('tab', { name: 'Channels' }).click();
    const trace = await tracePromise;

    // The pill jumps: every sampled position is one of the two endpoints.
    const endpoints = [tasksLeft, channelsLeft];
    const offEndpoint = trace.filter((left) =>
      endpoints.every((end) => Math.abs(left - end) > 1),
    );
    expect(offEndpoint).toEqual([]);
    expect(trace.some((left) => Math.abs(left - channelsLeft) <= 1)).toBe(true);
  });
});
