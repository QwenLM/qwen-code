import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  test,
  expect,
  runCommand,
  dispatchWebviewMessage,
  waitForWebviewReady,
} from '../fixtures/vscode-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspacePath = path.resolve(__dirname, '../../test/fixtures/workspace');
const sampleFilePath = path.join(workspacePath, 'sample.txt');

const enableWebviewTestMode = async (
  page: import('@playwright/test').Page,
) => {
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
};

const waitForAuthenticatedChat = async (
  webview: import('@playwright/test').Frame,
) => {
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
};

test('shows injected permission drawer and closes after allow', async ({
  page,
}: {
  page: import('@playwright/test').Page;
}) => {
  await enableWebviewTestMode(page);

  await runCommand(page, 'Qwen Code: Open');
  const webview = await waitForWebviewReady(page);
  await waitForAuthenticatedChat(webview);
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

test('triggers a real permission request for file edits and applies the change after allow', async ({
  page,
}: {
  page: import('@playwright/test').Page;
}) => {
  test.setTimeout(180_000);

  const originalSample = await fs.readFile(sampleFilePath, 'utf8');
  const marker = `permission-e2e-${Date.now()}`;

  try {
    await enableWebviewTestMode(page);

    await runCommand(page, 'Qwen Code: Open');
    const webview = await waitForWebviewReady(page);
    await waitForAuthenticatedChat(webview);

    const input = webview.getByRole('textbox', { name: 'Message input' });
    await expect(input).toBeVisible();

    await webview.evaluate(() => {
      const holder = window as typeof window & {
        __qwenPostedMessages?: unknown[];
        __qwenReceivedMessages?: unknown[];
      };
      holder.__qwenPostedMessages = [];
      holder.__qwenReceivedMessages = [];
    });

    await input.fill(
      `Append the exact line "${marker}" to sample.txt in the workspace root. Make no other changes.`,
    );
    await input.press('Enter');

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
            return (
              (message as {
                type?: string;
                data?: { toolCall?: { kind?: string } };
              }).type === 'permissionRequest'
            );
          })
        );
      },
      { timeout: 120_000 },
    );

    const allowButton = webview.getByRole('button', { name: 'Allow once' });
    await expect(allowButton).toBeVisible();
    await allowButton.click({ force: true });

    await webview.waitForFunction(
      () => {
        const posted = (window as typeof window & {
          __qwenPostedMessages?: unknown[];
        }).__qwenPostedMessages;
        return (
          Array.isArray(posted) &&
          posted.some(
            (message) =>
              !!message &&
              typeof message === 'object' &&
              (message as { type?: string }).type === 'permissionResponse',
          )
        );
      },
      { timeout: 30_000 },
    );

    await webview.waitForFunction(
      () => {
        const received = (window as typeof window & {
          __qwenReceivedMessages?: unknown[];
        }).__qwenReceivedMessages;
        return (
          Array.isArray(received) &&
          received.some(
            (message) =>
              !!message &&
              typeof message === 'object' &&
              (message as { type?: string }).type === 'permissionResolved',
          )
        );
      },
      { timeout: 30_000 },
    );

    await expect
      .poll(
        async () => {
          const current = await fs.readFile(sampleFilePath, 'utf8');
          return current.includes(marker);
        },
        { timeout: 120_000, intervals: [1000, 2000, 5000] },
      )
      .toBe(true);
  } finally {
    await fs.writeFile(sampleFilePath, originalSample, 'utf8');
  }
});
