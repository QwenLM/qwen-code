import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';
import { completeReplay } from './visuals/harness';

for (const enabled of [false, true, undefined]) {
  test(`loading phrase setting ${enabled} controls host phrases @smoke`, async ({
    page,
  }, testInfo) => {
    const key = 'ui.accessibility.enableLoadingPhrases';
    const phrase = 'Host loading phrase';
    const scenario = createWebShellDaemonScenario();
    if (enabled !== undefined) {
      scenario.settings.settings.push({
        key,
        type: 'boolean',
        label: 'Enable Loading Phrases',
        category: 'UI',
        requiresRestart: true,
        default: true,
        values: { effective: enabled },
      });
    }
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    const params = new URLSearchParams({
      sessionId: scenario.sessionId,
      loadingPhrase: phrase,
      theme: 'light',
      sidebar: 'false',
    });
    await page.clock.install();
    await page.goto(`/e2e/settings-harness.html?${params}`);
    await completeReplay(
      page,
      daemon,
      scenario.sessionId,
      scenario.events.length,
    );
    const stream = () =>
      daemon.sendEvent(
        assistantTextEvent('Response in progress', {
          sessionId: scenario.sessionId,
        }),
      );
    await stream();
    const meta = page
      .locator('span')
      .filter({ hasText: /^\(\d+s.*esc to cancel\)$/ });
    await expect(meta).toBeVisible();
    const status = meta.locator('..');
    await expect(status.locator('span').first()).not.toBeEmpty();
    await expect(status).toContainText('tokens');
    await expect(page.getByText(phrase, { exact: true })).toHaveCount(
      enabled === false ? 0 : 1,
    );
    await page.screenshot({
      path: testInfo.outputPath(`loading-phrases-${enabled}.png`),
    });

    await page.clock.fastForward(16_000);
    await stream();
    await expect(meta).toBeVisible();
    await expect(page.getByText(phrase, { exact: true })).toHaveCount(
      enabled === false ? 0 : 1,
    );

    const updated = enabled === false;
    scenario.settings.settings = scenario.settings.settings.filter(
      (setting) => setting.key !== key,
    );
    scenario.settings.settings.push({
      key,
      type: 'boolean',
      label: 'Enable Loading Phrases',
      category: 'UI',
      requiresRestart: true,
      default: true,
      values: { effective: updated },
    });
    await daemon.sendEvent({
      v: 1,
      type: 'settings_changed',
      data: { key, value: updated, scope: 'user' },
    });
    await stream();
    await expect(meta).toBeVisible();
    await expect(page.getByText(phrase, { exact: true })).toHaveCount(
      updated ? 1 : 0,
    );
  });
}
