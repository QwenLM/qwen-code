import { expect, test } from '@playwright/test';
import { setupConversationSearch } from './utils/conversationSearchScenario';

for (const theme of ['light', 'dark']) {
  for (const [language, width] of [
    ['en', 1440],
    ['zh-CN', 390],
  ] as const) {
    test(`external record navigation with hidden timeline ${theme} ${language} ${width}`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await setupConversationSearch(page, baseURL, {
        history: true,
        externalNavigation: true,
        theme,
        language,
      });
      await expect(page.locator('[data-global-turn-navigation]')).toHaveCount(
        0,
      );
      await expect(
        page.getByRole('button', {
          name: /Search this conversation|搜索当前会话/,
          exact: true,
        }),
      ).toHaveCount(0);
      const editor = page.locator(
        '[data-web-shell-composer-editor] .cm-content',
      );
      await editor.fill('Unsent synthetic draft');
      const status = await page.evaluate(async () => {
        const host = window as unknown as {
          navigateSyntheticMessage: (request: {
            sessionId: string;
            recordId: string;
          }) => Promise<{ status: string }>;
        };
        return host.navigateSyntheticMessage({
          sessionId: 'search-fixture',
          recordId: 'record-3',
        });
      });
      expect(status).toEqual({ status: 'located' });
      const historical = page.locator('[data-history-viewport="historical"]');
      await expect(historical).toContainText('Archived UNIQUE-NEEDLE answer.');
      await expect(historical.locator('[class*="flash"]')).toBeVisible();
      await expect(editor).toHaveText('Unsent synthetic draft');
      await page.screenshot({
        path: `/tmp/qwen-12234-external-navigation-${theme}-${language}-${width}.png`,
      });
      const missing = await page.evaluate(async () => {
        const host = window as unknown as {
          navigateSyntheticMessage: (request: {
            sessionId: string;
            recordId: string;
          }) => Promise<{ status: string }>;
        };
        return host.navigateSyntheticMessage({
          sessionId: 'search-fixture',
          recordId: 'missing-record',
        });
      });
      expect(missing).toEqual({ status: 'not_found' });
      await expect(historical).toContainText('Archived UNIQUE-NEEDLE answer.');
      await expect(editor).toHaveText('Unsent synthetic draft');
    });
  }
}
