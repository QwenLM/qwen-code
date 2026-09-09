import { expect, test, type Locator } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

async function expectSameEdges(message: Locator, composer: Locator) {
  await expect
    .poll(async () => {
      const messageBox = await message.boundingBox();
      const composerBox = await composer.boundingBox();
      if (!messageBox || !composerBox) return Infinity;
      return Math.max(
        Math.abs(messageBox.x - composerBox.x),
        Math.abs(
          messageBox.x + messageBox.width - composerBox.x - composerBox.width,
        ),
      );
    })
    .toBeLessThanOrEqual(1);
}

for (const navigation of [true, false]) {
  test(`transcript matches composer edges with turn navigation ${navigation ? 'enabled' : 'unsupported'} @smoke`, async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const scenario = createWebShellDaemonScenario({
      events: Array.from({ length: 4 }, (_, index) => [
        userTextEvent('What is the weather?', { id: index * 3 + 1 }),
        assistantTextEvent(
          index < 3
            ? 'Earlier forecast.'
            : `the weather report is ready\n\n${Array.from(
                { length: 80 },
                (_, index) => `Forecast detail ${index + 1}.`,
              ).join('\n\n')}`,
          { id: index * 3 + 2 },
        ),
        turnCompleteEvent(`prompt-alignment-${index}`, { id: index * 3 + 3 }),
      ]).flat(),
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
          totalTurns: 4,
          start: 0,
          turns: Array.from({ length: 4 }, (_, ordinal) => ({
            ordinal,
            turnId: `record-${ordinal}`,
            kind: 'prompt',
            label: 'What is the weather?',
            detail: 'The weather report includes the weekly forecast.',
          })),
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

    const rail = navigation
      ? page.locator('[data-global-turn-navigation]')
      : page.getByTestId('session-timeline');
    await expect(rail).toBeVisible();

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
    for (const width of [1440, 1300, 1261, 1260, 1259, 1000, 802, 700, 599]) {
      await page.setViewportSize({ width, height: 900 });
      await expectSameEdges(message, composer);
      const viewport = page.locator('[data-history-viewport]');
      await expect
        .poll(async () => {
          const scrollBox = await messageList.boundingBox();
          const viewportBox = await viewport.boundingBox();
          if (!scrollBox || !viewportBox) return Infinity;
          return Math.abs(
            scrollBox.x + scrollBox.width - viewportBox.x - viewportBox.width,
          );
        })
        .toBeLessThanOrEqual(1);
      const viewportBox = await viewport.boundingBox();
      if (viewportBox && viewportBox.width >= 1000) {
        await expect(rail).toBeVisible();
        const railBox = await rail.boundingBox();
        const messageBox = await message.boundingBox();
        expect(railBox!.x + railBox!.width).toBeLessThanOrEqual(messageBox!.x);
      } else {
        await expect(rail).toBeHidden();
      }
    }
    {
      const shell = page.locator('[data-web-shell-root]');
      for (const minWidth of [800, 1200, 1000]) {
        await shell.evaluate((element, width) => {
          element.style.setProperty(
            '--chat-regular-content-width',
            `${width}px`,
          );
        }, minWidth);
        for (const offset of [-1, 0, 1]) {
          await page.setViewportSize({
            width: minWidth + 260 + offset,
            height: 900,
          });
          if (offset < 0) await expect(rail).toBeHidden();
          else await expect(rail).toBeVisible();
        }
      }
      await page.setViewportSize({ width: 1260, height: 900 });
      await shell.evaluate((element) => {
        element.style.setProperty('--chat-regular-content-width', '1200px');
      });
      await expect(rail).toBeHidden();
      await shell.evaluate((element) => {
        element.style.setProperty('--chat-regular-content-width', '1000px');
      });
      await expect(rail).toBeVisible();
    }
    for (const width of [1440, 1260]) {
      await page.setViewportSize({ width, height: 900 });
      const button = rail.locator('button').first();
      const tick = button.locator(':scope > span').first();
      await button.hover();
      await expect
        .poll(async () => (await tick.boundingBox())?.width ?? 0)
        .toBeGreaterThan(27);
      const tickBox = await tick.boundingBox();
      const railScrollBox = await rail.locator(':scope > div').boundingBox();
      expect(tickBox!.x + tickBox!.width).toBeLessThanOrEqual(
        railScrollBox!.x + railScrollBox!.width,
      );
      const preview = page.locator(
        navigation
          ? '[data-slot="tooltip-content"]'
          : '#session-timeline-detail-tooltip',
      );
      await expect(preview).toBeVisible();
      await expect(preview).toContainText('What is the weather?');
      if (navigation)
        await expect(preview).toContainText(
          'The weather report includes the weekly forecast.',
        );
      await expect(preview).toHaveCSS('border-radius', '14px');
      await expect(preview).toHaveCSS('padding', '12px 14px');
      await expect(preview.locator('[data-slot="tooltip-arrow"]')).toBeHidden();
      await preview.evaluate((element) => {
        element.style.pointerEvents = 'none';
      });
      const buttonBox = await button.boundingBox();
      expect(
        await message.evaluate(
          (element, y) =>
            Boolean(
              document
                .elementFromPoint(element.getBoundingClientRect().x + 5, y)
                ?.closest(
                  '[data-global-turn-navigation], [data-testid="session-timeline"]',
                ),
            ),
          buttonBox!.y + buttonBox!.height / 2,
        ),
      ).toBe(false);
      await page.mouse.move(500, 10);
      await expect(preview).toHaveCount(0);
    }
    await test.step('docked environment panel preserves composer alignment', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      const toggle = page.locator('[data-web-shell-environment-toggle]');
      const panel = page.getByTestId('environment-panel');
      await toggle.click();
      await expect(panel).toBeVisible();
      await expect(panel).toHaveAttribute('data-floating', 'false');
      await expectSameEdges(message, composer);
      await toggle.click();
      await expect(panel).toBeHidden();
      await expectSameEdges(message, composer);
    });
  });
}
