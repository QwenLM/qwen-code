import {
  test,
  expect,
  runCommand,
  waitForWebviewReady,
} from '../fixtures/vscode-fixture.js';

test('opens Qwen Code webview via command palette', async ({
  page,
}: {
  page: import('@playwright/test').Page;
}) => {
  await runCommand(page, 'Qwen Code: Open');
  const webview = await waitForWebviewReady(page);

  const input = webview.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible();
});
