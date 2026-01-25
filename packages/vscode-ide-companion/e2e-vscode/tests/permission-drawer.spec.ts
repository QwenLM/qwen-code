import {
  test,
  expect,
  runCommand,
  dispatchWebviewMessage,
  waitForWebviewReady,
} from '../fixtures/vscode-fixture.js';

test('shows permission drawer and closes after allow', async ({
  page,
}: {
  page: import('@playwright/test').Page;
}) => {
  await runCommand(page, 'Qwen Code: Open');
  const webview = await waitForWebviewReady(page);

  await dispatchWebviewMessage(webview, {
    type: 'authState',
    data: { authenticated: true },
  });
  await dispatchWebviewMessage(webview, {
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

  const allowButton = webview.getByRole('button', { name: 'Allow once' });
  await expect(allowButton).toBeVisible();

  // Wait a bit for any potential notifications to settle, then try clicking
  await page.waitForTimeout(500);

  // Use force click to bypass potential overlays
  await allowButton.click({ force: true });

  await expect(allowButton).toBeHidden();
});
