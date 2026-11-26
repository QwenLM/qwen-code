import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

test('keeps the footer timestamp visible without hover on touch devices @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Earlier question.', { id: 1 }),
      assistantTextEvent('Earlier answer.', { id: 2 }),
      turnCompleteEvent('earlier', { id: 3 }),
      userTextEvent('Latest question.', { id: 4 }),
      assistantTextEvent('Latest answer.', { id: 5 }),
      turnCompleteEvent('latest', { id: 6 }),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}?lang=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  const row = page
    .locator('[data-web-shell-message-row]')
    .filter({ hasText: 'Latest answer.' });
  const copy = row.getByRole('button', { name: 'Copy content', exact: true });
  await expect(copy).toBeVisible();
  const timestamp = copy
    .locator('..')
    .locator(':scope > span[aria-hidden="true"]');
  await expect(timestamp).toHaveCSS('opacity', '1');
});
