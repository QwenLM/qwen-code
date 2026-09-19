import { expect, test, type Page } from '@playwright/test';
import { setupConversationSearch as setup } from './utils/conversationSearchScenario';

const searchButton = (page: Page) =>
  page.getByRole('button', {
    name: /Search this conversation|搜索当前会话/,
    exact: true,
  });

for (const count of [10, 11]) {
  test(`conversation search defaults to strictly more than ten messages: ${count} @smoke`, async ({
    page,
    baseURL,
  }) => {
    await setup(page, baseURL, { count });
    await expect(
      page.getByText(`Synthetic message ${count - 2}`, { exact: true }),
    ).toBeVisible();
    await expect(searchButton(page)).toHaveCount(count > 10 ? 1 : 0);
  });
}

test('search locates persisted history outside the live window without changing a draft @smoke', async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { anchors } = await setup(page, baseURL, { history: true });
  const prompt = page.locator('[data-web-shell-composer-editor] .cm-content');
  await prompt.click();
  await page.keyboard.type('Unsaved synthetic draft');
  await searchButton(page).click();
  const dialog = page.locator('[data-conversation-search]');
  const input = dialog.locator('input');
  await expect(input).toBeFocused();
  await input.fill('unique-needle');
  const hit = dialog
    .getByRole('button')
    .filter({ hasText: 'Archived UNIQUE-NEEDLE answer.' });
  await expect(hit).toBeVisible();
  await page.screenshot({ path: '/tmp/qwen-12231-search-history-dialog.png' });
  await hit.click();
  await expect(dialog).toHaveCount(0);
  const historical = page.locator('[data-history-viewport="historical"]');
  await expect(historical).toContainText('Archived UNIQUE-NEEDLE answer.');
  await expect(historical.locator('[class*="flash"]')).toBeVisible();
  await page.screenshot({ path: '/tmp/qwen-12231-search-history-located.png' });
  expect(anchors).toContain('record-2');
  await expect(prompt).toHaveText('Unsaved synthetic draft');
});

for (const theme of ['light', 'dark']) {
  for (const language of ['en', 'zh-CN']) {
    for (const width of [1440, 390]) {
      test(`conversation search content and layout ${theme} ${language} ${width} @smoke`, async ({
        page,
        baseURL,
      }) => {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 900,
        });
        await setup(page, baseURL, { theme, language });
        const button = searchButton(page);
        if (width === 390) {
          await expect(button).toBeHidden();
          return;
        }
        const scroll = page.locator('[data-web-shell-message-list]');
        await scroll.hover();
        await page.mouse.wheel(0, -100000);
        const bottom = page.getByRole('button', {
          name: /Scroll to bottom|回到底部/,
          exact: true,
        });
        await expect(bottom).toBeVisible();
        const searchBox = await button.boundingBox();
        const timeline = page.getByRole('navigation', {
          name: /Session timeline|会话时间线/,
        });
        await expect(
          timeline.getByRole('button', {
            name: /Search this conversation|搜索当前会话/,
            exact: true,
          }),
        ).toBeVisible();
        expect(searchBox!.width).toBeLessThanOrEqual(20);
        expect(searchBox!.height).toBe(24);
        if (width === 1440) {
          const tick = await timeline
            .locator('li button span')
            .first()
            .boundingBox();
          expect(
            Math.abs(
              searchBox!.x + searchBox!.width / 2 - (tick!.x + tick!.width / 2),
            ),
          ).toBeLessThan(1);
        }
        await page.screenshot({
          path: `/tmp/qwen-12231-entry-${theme}-${language}-${width}.png`,
        });
        await button.click();
        const dialog = page.locator('[data-conversation-search]');
        const input = dialog.locator('input');
        const shell = page.getByRole('dialog', {
          name: /Search this conversation|搜索当前会话/,
          exact: true,
        });
        await shell.evaluate(async (element) => {
          await Promise.all(
            element.getAnimations().map((animation) => animation.finished),
          );
        });
        const initialBox = await shell.boundingBox();
        await input.fill('中文检索');
        await expect(dialog.locator('mark')).toHaveText('中文检索');
        expect((await shell.boundingBox())!.height).toBe(initialBox!.height);
        expect((await shell.boundingBox())!.y).toBe(initialBox!.y);
        await input.fill('sampleNeedle');
        await expect(dialog.locator('mark')).toHaveText('sampleNeedle');
        expect((await shell.boundingBox())!.height).toBe(initialBox!.height);
        await input.fill('NO-SUCH-KEYWORD');
        await expect(dialog.locator('mark')).toHaveCount(0);
        expect((await shell.boundingBox())!.height).toBe(initialBox!.height);
        expect((await shell.boundingBox())!.y).toBe(initialBox!.y);
        await input.fill('sampleNeedle');
        await expect(dialog.locator('mark')).toHaveText('sampleNeedle');
        const box = await dialog.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: `/tmp/qwen-12231-search-${theme}-${language}-${width}.png`,
        });
        await input.fill('nonexistent-synthetic-keyword');
        await expect(dialog.locator('ol > li')).toHaveCount(0);
        await expect(dialog.getByRole('status')).toContainText(
          /No matching messages|没有|未找到/,
        );
        await input.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(button).toBeFocused();
      });
    }
  }
}
