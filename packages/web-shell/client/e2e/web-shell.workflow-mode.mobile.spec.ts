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
    const control = page.locator('[data-web-shell-workflow-mode-control]');
    const toggle = page.getByRole('switch', {
      name: language === 'en' ? 'Workflow mode' : 'Workflow 模式',
      exact: true,
    });
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    await control.getByRole('button').tap();
    const details = page.getByRole('dialog', {
      name: language === 'en' ? 'Workflow mode' : 'Workflow 模式',
      exact: true,
    });
    await expect(details).toBeVisible();
    await details.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
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
    await page.keyboard.press('Escape');
    await toggle.tap();
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeDisabled();
    expect(
      daemon.configOptionRequests().map((request) => request.body),
    ).toEqual([{ configId: 'workflow_mode', value: 'off' }]);
    expect(daemon.promptRequests()).toHaveLength(0);
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await expect(
      page.locator('[data-web-shell-composer-submit]'),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`workflow-${language}-${theme}-off.png`),
    });
  });
}
