import { expect, test } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

const content =
  '## Markdown example\n\nCopy **formatted text** and [a link](https://example.com).\n\n- First item\n- Second item\n\n```ts\nconst answer = 42;\n```';

test('assistant footer copies complete Markdown beside Copy', async ({
  page,
  context,
}, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const scenario = createWebShellDaemonScenario({
    events: [
      userTextEvent('Earlier question.', { id: 1 }),
      assistantTextEvent('Earlier answer.', { id: 2 }),
      turnCompleteEvent('earlier', { id: 3 }),
      userTextEvent('Show a Markdown example.', { id: 4 }),
      assistantTextEvent(content, { id: 5 }),
      turnCompleteEvent('copy-markdown', { id: 6 }),
    ],
  });
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(info.project.use.baseURL),
  });
  await page.goto(`/session/${scenario.sessionId}?theme=light&lang=en`);
  await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: scenario.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  const row = page.locator('[data-web-shell-message-row]').filter({
    has: page.getByRole('heading', { name: 'Markdown example' }),
  });
  await expect(row).toBeVisible();
  await page.mouse.move(0, 0);
  const markdown = row.getByRole('button', {
    name: 'Copy Markdown',
    exact: true,
  });
  const copy = markdown
    .locator('..')
    .getByRole('button', { name: 'Copy', exact: true });
  await expect(markdown).toBeVisible();
  await expect(markdown.locator('..')).toHaveCSS('opacity', '1');
  const olderMarkdown = page
    .locator('[data-web-shell-message-row]')
    .filter({ hasText: 'Earlier answer.' })
    .getByRole('button', { name: 'Copy Markdown', exact: true });
  await expect(olderMarkdown.locator('..')).toHaveCSS('opacity', '0');
  await olderMarkdown.hover();
  await expect(olderMarkdown.locator('..')).toHaveCSS('opacity', '1');
  await page.mouse.move(0, 0);
  await expect(olderMarkdown.locator('..')).toHaveCSS('opacity', '0');
  expect(
    await copy.evaluate((button) =>
      button.nextElementSibling?.getAttribute('aria-label'),
    ),
  ).toBe('Copy Markdown');
  await page.screenshot({
    path: info.outputPath('copy-markdown.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await markdown.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(content);
  await expect(markdown.locator('rect')).toHaveCount(0);
  await expect(copy.locator('rect')).toHaveCount(1);
  await expect(markdown.locator('rect')).toHaveCount(1);
  await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
  await markdown.focus();
  await markdown.press('Enter');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(content);
  await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
  await copy.click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(content);
  await page.locator('[data-web-shell-composer-editor] .cm-content').focus();
  await page.mouse.move(0, 0);
  await daemon.sendEvent(userTextEvent('Next question.', { id: 7 }));
  await expect(markdown.locator('..')).toHaveCSS('opacity', '0');
});
