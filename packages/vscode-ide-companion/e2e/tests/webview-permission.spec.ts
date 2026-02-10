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

test('permission drawer sends allow response', async ({ page }: { page: Page }) => {
  await sendWebviewMessage(page, {
    type: 'permissionRequest',
    data: {
      options: [
        { name: 'Allow once', kind: 'allow_once', optionId: 'allow_once' },
        { name: 'Reject', kind: 'reject', optionId: 'reject' },
      ],
      toolCall: {
        toolCallId: 'tc-1',
        title: 'Edit file',
        kind: 'edit',
        locations: [{ path: '/repo/src/file.ts' }],
        status: 'pending',
      },
    },
  });

  const allowButton = page.getByRole('button', { name: 'Allow once' });
  await expect(allowButton).toBeVisible();
  await allowButton.click();

  await page.waitForFunction(
    () =>
      Array.isArray(window.__postedMessages) &&
      window.__postedMessages.some((msg) => msg?.type === 'permissionResponse'),
  );

  const postedMessages = await page.evaluate(() => window.__postedMessages);
  expect(postedMessages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'permissionResponse',
        data: { optionId: 'allow_once' },
      }),
    ]),
  );
});
