/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Oversized pastes fold into an attachment card. The card is exercised here in
// a real browser; the send path it feeds is covered at the actions layer, where
// the mock daemon has no attachment store.

import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const COMPOSER_EDITOR = '[data-web-shell-composer-editor] .cm-content';
const COMPOSER_ATTACHMENTS = '[data-web-shell-composer-attachments]';

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
}

async function gotoSession(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
): Promise<void> {
  await page.goto(`/session/${encodeURIComponent(scenario.sessionId)}`);
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: scenario.events.length,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}

async function pasteText(editor: Locator, text: string): Promise<void> {
  await editor.evaluate((element, pasted) => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', pasted);
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  }, text);
}

function longText(lines: number): string {
  return `${Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n')}\n`;
}

test('folds a long paste into a card and keeps the editor empty @paste-fold @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  const editor = page.locator(COMPOSER_EDITOR);
  const text = longText(250);
  await pasteText(editor, text);

  const attachments = page.locator(COMPOSER_ATTACHMENTS);
  await expect(attachments).toBeVisible();
  // The card is titled by the content's first line; the attachment's name is
  // that same title with a .txt suffix, which the card does not show, and only
  // a size sits beside the action.
  await expect(attachments).toContainText('line 0');
  await expect(attachments).not.toContainText('.txt');
  await expect(attachments).not.toContainText('lines');
  await expect(attachments).toContainText(/\d+(\.\d+)? (B|KB|MB)/);
  await expect(page.getByRole('button', { name: 'Show inline' })).toBeVisible();
  // The placeholder lives inside `.cm-content`, so assert on the pasted text.
  await expect(editor).not.toContainText('line 249');
});

test('keeps a short paste inline @paste-fold @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  const editor = page.locator(COMPOSER_EDITOR);
  await pasteText(editor, 'short line\nsecond line\n');

  await expect(editor).toContainText('short line');
  await expect(page.locator(COMPOSER_ATTACHMENTS)).toHaveCount(0);
});

test('moves the folded paste into the editor on request @paste-fold @smoke', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoSession(page, scenario, daemon);

  const editor = page.locator(COMPOSER_EDITOR);
  const text = longText(250);
  await pasteText(editor, text);
  await expect(page.locator(COMPOSER_ATTACHMENTS)).toBeVisible();

  await page.getByRole('button', { name: 'Show inline' }).click();

  await expect(page.locator(COMPOSER_ATTACHMENTS)).toHaveCount(0);
  await expect(editor).toContainText('line 249');
});
