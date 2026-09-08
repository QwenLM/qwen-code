import { expect, test, type Locator } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

async function expectSameAxis(message: Locator, composer: Locator) {
  await expect
    .poll(async () => {
      const messageBox = await message.boundingBox();
      const composerBox = await composer.boundingBox();
      if (!messageBox || !composerBox) return Infinity;
      return Math.abs(
        messageBox.x +
          messageBox.width / 2 -
          (composerBox.x + composerBox.width / 2),
      );
    })
    .toBeLessThanOrEqual(1);
}

for (const navigation of [true, false]) {
  test(`transcript stays on the composer axis with turn navigation ${navigation ? 'enabled' : 'unsupported'} @smoke`, async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const scenario = createWebShellDaemonScenario({
      events: [
        userTextEvent('What is the weather?', { id: 1 }),
        assistantTextEvent(
          `the weather report is ready\n\n${Array.from(
            { length: 80 },
            (_, index) => `Forecast detail ${index + 1}.`,
          ).join('\n\n')}`,
          { id: 2 },
        ),
        turnCompleteEvent('prompt-alignment', { id: 3 }),
      ],
    });
    if (navigation)
      scenario.capabilities.features.push('session_turn_navigation');
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
    });
    await page.route(`${baseURL}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.endsWith('/turn-index')) return route.fallback();
      await route.fulfill({
        json: {
          v: 1,
          sessionId: scenario.sessionId,
          snapshot: 'mock-snapshot',
          totalTurns: 1,
          start: 0,
          turns: [
            {
              ordinal: 0,
              turnId: 'record-0',
              kind: 'prompt',
              label: 'What is the weather?',
            },
          ],
        },
      });
    });
    await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
    await expect(page.locator('[data-web-shell-root]')).toBeVisible();
    const connection = await daemon.sse.waitForConnection(scenario.sessionId);
    await daemon.sendEvent(
      replayCompleteEvent({
        sessionId: connection.sessionId,
        replayedCount: scenario.events.length,
      }),
    );
    await expect(page.getByText('Loading...')).toHaveCount(0);

    const rail = page.locator('[data-global-turn-navigation]');
    if (navigation) await expect(rail).toBeVisible();
    else await expect(rail).toHaveCount(0);

    const messageList = page.locator('[data-web-shell-message-list]');
    const message = messageList
      .locator('[data-web-shell-message-row]')
      .filter({ hasText: 'the weather report is ready' });
    await expect(message).toBeVisible();
    const composer = page.locator('[data-web-shell-composer]');
    await expect(composer).toBeVisible();
    await expect
      .poll(() =>
        messageList.evaluate(
          (element) => element.scrollHeight - element.clientHeight,
        ),
      )
      .toBeGreaterThan(0);
    await expectSameAxis(message, composer);
    const column = page.locator('[data-history-viewport] > div').last();
    await expect(column).toHaveCSS(
      'padding-right',
      navigation ? '64px' : '0px',
    );

    // The columns have different widths in this band but still share an axis.
    await page.setViewportSize({ width: 1300, height: 900 });
    if (navigation) {
      await expect(rail).toBeVisible();
      await expect
        .poll(async () => {
          const messageBox = await message.boundingBox();
          const composerBox = await composer.boundingBox();
          return (composerBox?.width ?? 0) - (messageBox?.width ?? Infinity);
        })
        .toBeGreaterThan(1);
    }
    await expectSameAxis(message, composer);

    await page.setViewportSize({ width: 599, height: 900 });
    await expect(rail).toBeHidden();
    await expect(column).toHaveCSS('padding-right', '0px');
    await expectSameAxis(message, composer);
  });
}
