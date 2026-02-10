import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

declare global {
  interface Window {
    __postedMessages?: Array<{ type?: string; data?: unknown }>;
  }
}

const sendWebviewMessage = async (page: Page, payload: unknown) => {
  await page.evaluate((message: unknown) => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  }, payload);
};

test.beforeEach(async ({ page }: { page: Page }) => {
  await page.goto('webview-harness.html');
  await page.waitForFunction(
    () => document.querySelector('#root')?.children.length,
  );
  await page.waitForTimeout(50);
  await sendWebviewMessage(page, {
    type: 'authState',
    data: { authenticated: true },
  });
  await expect(
    page.getByRole('textbox', { name: 'Message input' }),
  ).toBeVisible();
});

test('sends a message when pressing Enter', async ({ page }: { page: Page }) => {
  const input = page.getByRole('textbox', { name: 'Message input' });
  await input.click();
  await page.keyboard.type('Hello from Playwright');
  await page.keyboard.press('Enter');

  await page.waitForFunction(
    () =>
      Array.isArray(window.__postedMessages) &&
      window.__postedMessages.some((msg) => msg?.type === 'sendMessage'),
  );

  const postedMessages = await page.evaluate(() => window.__postedMessages);
  expect(postedMessages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'sendMessage',
        data: expect.objectContaining({ text: 'Hello from Playwright' }),
      }),
    ]),
  );
});
