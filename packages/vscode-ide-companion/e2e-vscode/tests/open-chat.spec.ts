import {
  test,
  expect,
  runCommand,
  dispatchWebviewMessage,
  waitForWebviewReady,
} from '../fixtures/vscode-fixture.js';

test('opens Qwen Code webview via command palette', async ({
  page,
}: {
  page: import('@playwright/test').Page;
}) => {
  await runCommand(page, 'Qwen Code: Open');
  const webview = await waitForWebviewReady(page);

  // Explicitly set authentication state to true to ensure input form is displayed
  await dispatchWebviewMessage(webview, {
    type: 'authState',
    data: { authenticated: true },
  });

  // Wait a bit for the UI to update after auth state change
  await page.waitForTimeout(500);

  const input = webview.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible();
});
