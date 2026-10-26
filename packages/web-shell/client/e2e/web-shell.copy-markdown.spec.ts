import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  userTextEvent,
} from './utils/mockDaemon';

async function hoverAction(page: Page, button: Locator) {
  await page.mouse.move(0, 0, { steps: 12 });
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 12,
  });
}

const plainContent =
  'Markdown example\nCopy formatted text and a link.\nFirst item\nSecond item\nconst answer = 42;';

const content =
  '## Markdown example\n\nCopy **formatted text** and [a link](https://example.com).\n\n- First item\n- Second item\n\n```ts\nconst answer = 42;\n```';

for (const language of ['en', 'zh-CN'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`assistant footer copies complete Markdown beside Copy (${language}, ${theme})${language === 'en' && theme === 'light' ? ' @smoke' : ''}`, async ({
      page,
      context,
    }, info) => {
      const copyLabel = language === 'en' ? 'Copy content' : '复制内容';
      const markdownLabel =
        language === 'en' ? 'Copy Markdown source' : '复制 Markdown 源文';
      const newChatLabel =
        language === 'en' ? 'New chat from here' : '从此处新建对话';
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      const scenario = createWebShellDaemonScenario({
        events: [
          userTextEvent('Earlier question.', { id: 1 }),
          assistantTextEvent('Earlier answer.', { id: 2 }),
          turnCompleteEvent('earlier', { id: 3 }),
          userTextEvent('Show a Markdown example.', { id: 4 }),
          assistantTextEvent(content, {
            id: 5,
            branchRecordId: '22222222-2222-4222-8222-222222222222',
          }),
          turnCompleteEvent('copy-markdown', { id: 6 }),
        ],
      });
      const daemon = await installMockDaemon(page, scenario, {
        baseURL: String(info.project.use.baseURL),
      });
      await page.goto(
        `/session/${scenario.sessionId}?theme=${theme}&lang=${language}`,
      );
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
      await page.mouse.move(0, 0, { steps: 12 });
      const markdown = row.getByRole('button', {
        name: markdownLabel,
        exact: true,
      });
      const copy = markdown
        .locator('..')
        .getByRole('button', { name: copyLabel, exact: true });
      await expect(markdown).toBeVisible();
      await expect(markdown.locator('..')).toHaveCSS('opacity', '1');
      const timestamp = markdown
        .locator('..')
        .locator(':scope > span[aria-hidden="true"]');
      await expect(timestamp).toHaveCSS('opacity', '0');
      await row.hover();
      await expect(timestamp).toHaveCSS('opacity', '1');
      await page.mouse.move(0, 0, { steps: 12 });
      await expect(timestamp).toHaveCSS('opacity', '0');
      const olderMarkdown = page
        .locator('[data-web-shell-message-row]')
        .filter({ hasText: 'Earlier answer.' })
        .getByRole('button', { name: markdownLabel, exact: true });
      await expect(olderMarkdown.locator('..')).toHaveCSS('opacity', '0');
      await olderMarkdown.hover();
      await expect(olderMarkdown.locator('..')).toHaveCSS('opacity', '1');
      const olderCopy = olderMarkdown
        .locator('..')
        .getByRole('button', { name: copyLabel, exact: true });
      await hoverAction(page, olderCopy);
      const tooltipBubble = page.locator('[data-slot="tooltip-content"]');
      await expect(tooltipBubble).toBeVisible();
      const bubbleBox = (await tooltipBubble.boundingBox())!;
      await page.mouse.move(
        bubbleBox.x + bubbleBox.width / 2,
        bubbleBox.y + bubbleBox.height / 2,
        { steps: 6 },
      );
      await expect(tooltipBubble).toHaveCount(0);
      await page.mouse.move(0, 0, { steps: 12 });
      await expect(olderMarkdown.locator('..')).toHaveCSS('opacity', '0');
      expect(
        await copy.evaluate((button) =>
          button.nextElementSibling?.getAttribute('aria-label'),
        ),
      ).toBe(markdownLabel);
      const newChat = row.getByRole('button', {
        name: newChatLabel,
        exact: true,
      });
      const icon = newChat.locator('svg');
      await expect(icon).toHaveCSS('width', '13px');
      await expect(icon).toHaveCSS('height', '13px');
      await expect(icon).toHaveCSS('transform', 'matrix(0, 1, -1, 0, 0, 0)');
      await expect(icon).toHaveCSS('stroke-width', '2.4px');
      for (const [button, label] of [
        [copy, copyLabel],
        [markdown, markdownLabel],
        [newChat, newChatLabel],
      ] as const) {
        await expect(button).not.toHaveAttribute('title');
        await hoverAction(page, button);
        await expect(page.getByRole('tooltip')).toHaveText(label);
        const content = page.locator('[data-slot="tooltip-content"]');
        await expect(content).toHaveCSS('background-color', 'rgb(0, 0, 0)');
        await expect(content).toHaveCSS('color', 'rgb(255, 255, 255)');
        await expect(
          content.locator('[data-slot="tooltip-arrow"] path').first(),
        ).toHaveCSS('fill', 'rgb(0, 0, 0)');
        await expect(content).toHaveClass(/\bring-border\b/);
        await expect(content).toHaveCSS('box-shadow', /rgb\(64, 64, 64\)/);
        await expect(
          content.locator('[data-slot="tooltip-arrow"] path'),
        ).toHaveCount(2);
        await expect(
          content.locator('[data-slot="tooltip-arrow"] path').last(),
        ).toHaveCSS('stroke', 'rgb(64, 64, 64)');
        await button.press('Escape');
        await expect(page.getByRole('tooltip')).toHaveCount(0);
      }
      await hoverAction(page, newChat);
      await expect(page.getByRole('tooltip')).toHaveText(newChatLabel);
      await page.screenshot({
        path: info.outputPath('copy-markdown.png'),
        fullPage: true,
        animations: 'disabled',
      });
      await page.mouse.move(0, 0, { steps: 12 });
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
        .toBe(plainContent);
      await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
      await copy.focus();
      await copy.press('Enter');
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(plainContent);
      await page
        .locator('[data-web-shell-composer-editor] .cm-content')
        .focus();
      await page.mouse.move(0, 0, { steps: 12 });
      await daemon.sendEvent(userTextEvent('Next question.', { id: 7 }));
      await expect(markdown.locator('..')).toHaveCSS('opacity', '0');
    });
  }
}
