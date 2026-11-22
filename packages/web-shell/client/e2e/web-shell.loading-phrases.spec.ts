import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
} from './utils/mockDaemon';
import { completeReplay } from './visuals/harness';

for (const { enabled, theme } of [
  { enabled: false, theme: 'light' },
  { enabled: true, theme: 'light' },
  { enabled: undefined, theme: 'light' },
  { enabled: false, theme: 'dark' },
  { enabled: true, theme: 'dark' },
  { enabled: undefined, theme: 'dark' },
]) {
  test(`loading phrase setting ${enabled} controls host phrases (${theme}) @smoke`, async ({
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
      theme,
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
      .filter({ hasText: /^\d+s.*esc to cancel$/ });
    await expect(meta).toBeVisible();
    const status = meta.locator('..');
    const expectPresentation = async (labelVisible: boolean) => {
      await expect(meta).toHaveText(
        /^\d+s · [↑↓] [\d.]+k? tokens · esc to cancel$/,
      );
      await expect
        .poll(() =>
          meta.evaluate((element) => ({
            before: getComputedStyle(element, '::before').content,
            after: getComputedStyle(element, '::after').content,
            color: getComputedStyle(element).color,
          })),
        )
        .toEqual({
          before: labelVisible ? '"("' : 'none',
          after: labelVisible ? '")"' : 'none',
          color: await status
            .locator('span')
            .first()
            .evaluate((element) => getComputedStyle(element).color),
        });
    };
    await expectPresentation(enabled !== false);
    await expect(status.locator('span').first()).not.toBeEmpty();
    await expect(status).toContainText('tokens');
    await expect(page.getByText(phrase, { exact: true })).toHaveCount(
      enabled === false ? 0 : 1,
    );
    await page.screenshot({
      path: testInfo.outputPath(`loading-phrases-${enabled}-${theme}.png`),
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
    await expectPresentation(updated);
    await page.setViewportSize({ width: 600, height: 900 });
    await expectPresentation(false);
    await page.screenshot({
      path: testInfo.outputPath(
        `loading-phrases-narrow-${enabled}-${theme}.png`,
      ),
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await expectPresentation(updated);
  });
}
