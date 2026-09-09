import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

test('user message URLs render as clickable links', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('see https://example.com/docs, then reply', { id: 1 }),
      turnCompleteEvent('prompt-links', { id: 2 }),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
  await gotoSession(page, scenario, daemon);

  const bubble = page.locator('[data-web-shell-user-bubble]');
  const link = bubble.locator('a[href="https://example.com/docs"]');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveText('https://example.com/docs');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener noreferrer/);
  await expect(bubble).toContainText('see ');
  await expect(bubble).toContainText(', then reply');
});

async function gotoSession(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
): Promise<void> {
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}
