/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

for (const { language, theme } of [
  { language: 'en', theme: 'light' },
  { language: 'zh-CN', theme: 'dark' },
]) {
  test(`touch Workflow control keeps unavailable-on reversible at 390px ${language} ${theme} @smoke`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(
      ({ language, theme }) => {
        localStorage.setItem('qwen-code-web-shell-language', language);
        localStorage.setItem('qwen-code-web-shell-theme', theme);
      },
      { language, theme },
    );
    const scenario = createWebShellDaemonScenario({
      state: {
        configOptions: [
          {
            id: 'workflow_mode',
            name: 'Workflow mode',
            type: 'select',
            currentValue: 'on',
            options: [
              { value: 'off', name: 'Off' },
              { value: 'on', name: 'On' },
            ],
            _meta: {
              'qwen.workflowMode': {
                available: false,
                effective: false,
                reason: 'workflow_unavailable',
              },
            },
          },
        ],
      },
    });
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    await page.goto(`/session/${scenario.sessionId}`);
    await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({ sessionId: scenario.sessionId }),
    );
    const trigger = page.getByTestId('composer-add-menu-trigger');
    const toggle = page.getByTestId('composer-add-menu-workflow');
    await expect(toggle).toHaveCount(0);
    await trigger.tap();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(toggle).toBeEnabled();
    await expect(toggle).toContainText(
      language === 'en'
        ? 'Workflow mode is on, but currently unavailable.'
        : 'Workflow 模式已开启，但当前不可用。',
    );
    const details = page.getByRole('dialog');
    await expect(details).toBeVisible();
    await details.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    await toggle.scrollIntoViewIfNeeded();
    const rowBounds = await toggle.boundingBox();
    const planBounds = await page
      .getByTestId('composer-add-menu-plan')
      .boundingBox();
    expect(rowBounds).not.toBeNull();
    expect(planBounds).not.toBeNull();
    expect(rowBounds!.height).toBeLessThanOrEqual(planBounds!.height + 1);
    const detailsBounds = await details.boundingBox();
    expect(detailsBounds).not.toBeNull();
    expect(detailsBounds!.x).toBeGreaterThanOrEqual(0);
    expect(detailsBounds!.x + detailsBounds!.width).toBeLessThanOrEqual(390);
    await testInfo.attach('workflow-details-bounds', {
      body: JSON.stringify({
        viewport: page.viewportSize(),
        rect: detailsBounds,
      }),
      contentType: 'application/json',
    });
    await page.screenshot({
      path: testInfo.outputPath(`workflow-${language}-${theme}-details.png`),
      animations: 'disabled',
    });
    await toggle.tap();
    await expect(details).toBeHidden();
    await trigger.tap();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toBeDisabled();
    expect(
      daemon.configOptionRequests().map((request) => request.body),
    ).toEqual([{ configId: 'workflow_mode', value: 'off' }]);
    expect(daemon.promptRequests()).toHaveLength(0);
    const bounds = await toggle.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: testInfo.outputPath(`workflow-${language}-${theme}-off.png`),
    });
    await page.keyboard.press('Escape');
    await expect(
      page.locator('[data-web-shell-composer-submit]'),
    ).toBeVisible();
  });
}
