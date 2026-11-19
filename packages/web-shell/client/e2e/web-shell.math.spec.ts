import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

test('renders Markdown and Mermaid math without inherited trust', async ({
  page,
}, info) => {
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Show math.', { id: 1 }),
      assistantTextEvent(
        'Inline $x^2$.\n\n$$\ny = x + 1\n$$\n\n' +
          '```mermaid\nflowchart LR\nA["$$x^2$$"] --> B["ok"]\n```\n\n' +
          '$\\href{https://example.com/untrusted}{click}$',
        { id: 2 },
      ),
      turnCompleteEvent('math', { id: 3 }),
    ],
  });
  await page.addInitScript(() => {
    Object.defineProperty(Object.prototype, 'trust', {
      value: true,
      configurable: true,
      writable: true,
    });
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(info.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}?lang=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await expect(page.locator('.katex-display')).toHaveCount(1);
  await expect(page.locator('svg .katex')).toHaveCount(1);
  await expect(page.locator('.katex')).toHaveCount(4);
  await expect(
    page.locator('a[href="https://example.com/untrusted"]'),
  ).toHaveCount(0);
});
