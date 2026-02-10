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
  await page.addInitScript(() => {
    (window as typeof window & {
      __qwenTestMode?: boolean;
      __qwenPostedMessages?: unknown[];
      __qwenReceivedMessages?: unknown[];
    }).__qwenTestMode = true;
    (window as typeof window & {
      __qwenPostedMessages?: unknown[];
      __qwenReceivedMessages?: unknown[];
    }).__qwenPostedMessages = [];
    (window as typeof window & {
      __qwenPostedMessages?: unknown[];
      __qwenReceivedMessages?: unknown[];
    }).__qwenReceivedMessages = [];
  });

  await runCommand(page, 'Qwen Code: Open');
  const webview = await waitForWebviewReady(page);

  await webview.waitForFunction(
    () => {
      const received = (window as typeof window & {
        __qwenReceivedMessages?: unknown[];
      }).__qwenReceivedMessages;
      return (
        Array.isArray(received) &&
        received.some((message) => {
          if (!message || typeof message !== 'object') {
            return false;
          }
          const payload = message as {
            type?: string;
            data?: { authenticated?: boolean | null };
          };
          return (
            payload.type === 'agentConnected' ||
            (payload.type === 'authState' &&
              payload.data?.authenticated === true)
          );
        })
      );
    },
    { timeout: 60_000 },
  );

  const input = webview.getByRole('textbox', { name: 'Message input' });
  await expect(input).toBeVisible();

  await webview.evaluate(() => {
    const holder = window as typeof window & {
      __qwenPostedMessages?: unknown[];
    };
    holder.__qwenPostedMessages = [];
  });

  await input.fill('Hello from e2e');
  await input.press('Enter');

  await webview.waitForFunction(
    () => {
      const posted = (window as typeof window & {
        __qwenPostedMessages?: unknown[];
      }).__qwenPostedMessages;
      return (
        Array.isArray(posted) &&
        posted.some((message) => {
          if (!message || typeof message !== 'object') {
            return false;
          }
          return (message as { type?: string }).type === 'sendMessage';
        })
      );
    },
    { timeout: 60_000 },
  );
});
