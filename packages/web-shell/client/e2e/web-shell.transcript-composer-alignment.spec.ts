import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

// The turn-navigation rail is an in-flow flex sibling of the transcript
// scroller, so the margin-centered content column must compensate for it or
// it drifts half a rail width off the axis the composer is centered on.
test('transcript column stays on the composer axis while the turn rail is visible @smoke', async ({
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
  const messageBox = await message.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(messageBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  if (!messageBox || !composerBox) return;
  expect(Math.abs(messageBox.x - composerBox.x)).toBeLessThanOrEqual(1);
  expect(
    Math.abs(
      messageBox.x + messageBox.width - (composerBox.x + composerBox.width),
    ),
  ).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 599, height: 900 });
  await expect(rail).toBeHidden();
  await expect(messageList.locator('..')).toHaveCSS('padding-right', '0px');
  await expect
    .poll(async () => {
      const narrowMessageBox = await message.boundingBox();
      const narrowComposerBox = await composer.boundingBox();
      if (!narrowMessageBox || !narrowComposerBox) return Infinity;
      return Math.abs(
        narrowMessageBox.x +
          narrowMessageBox.width / 2 -
          (narrowComposerBox.x + narrowComposerBox.width / 2),
      );
    })
    .toBeLessThanOrEqual(1);
});
