import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

test('warms Shiki within the transcript scroll margin, not for the entire replay @smoke', async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 650, height: 620 });
  const blockCount = 40;
  const markdown = Array.from({ length: blockCount }, (_, i) =>
    [
      '~~~ts',
      ...Array.from(
        { length: 18 },
        (_, line) => `const example_${i}_${line} = ${line};`,
      ),
      '~~~',
    ].join('\n'),
  ).join('\n\n');
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Show 40 examples', { id: 1 }),
      assistantTextEvent(markdown, { id: 2 }),
      turnCompleteEvent('highlight-replay', { id: 3 }),
    ],
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
  const list = page.locator('[data-web-shell-message-list]');
  const blocks = list.locator('[data-selection-code-language="typescript"]');
  await expect(blocks).toHaveCount(blockCount);
  await expect(list.locator('.shiki').first()).toBeVisible();
  const row = blocks
    .first()
    .locator('xpath=ancestor::*[@data-web-shell-message-row]');
  await expect(row).toHaveCSS('content-visibility', 'auto');
  const target = blocks.nth(17);
  await expect(target.locator('.shiki')).toHaveCount(0);
  const initial = await list.locator('.shiki').count();
  expect(initial).toBeLessThan(blockCount / 2);
  await target.evaluate((element) => {
    const root = element.closest('[data-web-shell-message-list]')!;
    root.scrollTop +=
      element.getBoundingClientRect().top -
      root.getBoundingClientRect().bottom -
      100;
  });
  await expect(target.locator('.shiki')).toHaveCount(1);
  const gap = await target.evaluate((element) => {
    const root = element.closest('[data-web-shell-message-list]')!;
    return (
      element.getBoundingClientRect().top - root.getBoundingClientRect().bottom
    );
  });
  expect(gap).toBeGreaterThan(0);
  expect(gap).toBeLessThan(200);
  info.annotations.push({
    type: 'initial highlighted code blocks',
    description: String(initial),
  });
});
