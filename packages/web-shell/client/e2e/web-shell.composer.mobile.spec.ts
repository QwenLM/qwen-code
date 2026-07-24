/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Mobile composer backend (#5958). Runs under the `mobile-chromium` project
// (Pixel 7 emulation: touch, coarse pointer, no hover), where the composer
// must render the plain-textarea backend instead of CodeMirror.

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  assistantTextEvent,
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  turnCompleteEvent,
  type DaemonRequestRecord,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const COMPOSER_TEXTAREA = 'textarea[data-web-shell-composer-editor]';

test('renders the textarea backend instead of CodeMirror on touch devices', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);

  await expect(page.locator(COMPOSER_TEXTAREA)).toBeVisible();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
});

test('tap, type, and Send submit through the shared prompt pipeline', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.tap();
  await page.keyboard.type('Ping from mobile');
  await expect(textarea).toHaveValue('Ping from mobile');

  const send = page.locator('[data-web-shell-composer-submit]');
  await expect(send).toBeEnabled();
  await send.tap();

  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expectPromptBodyToContainText(
    firstRequestBody(daemon.promptRequests()),
    'Ping from mobile',
  );
  await expect(textarea).toHaveValue('');

  await daemon.sse.split(assistantTextEvent('Pong from fake SSE', { id: 10 }));
  await daemon.sendEvent(turnCompleteEvent('prompt-mobile', { id: 11 }));
  await expect(page.locator('[data-web-shell-message-list]')).toContainText(
    'Pong from fake SSE',
  );
});

test('Enter inserts a newline and does not submit', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.tap();
  await page.keyboard.type('line one');
  const singleLineHeight = (await textarea.boundingBox())!.height;
  await page.keyboard.press('Enter');
  await page.keyboard.type('line two');
  await page.keyboard.press('Enter');
  await page.keyboard.type('line three');

  await expect(textarea).toHaveValue('line one\nline two\nline three');
  expect(daemon.promptRequests()).toHaveLength(0);
  // The textarea auto-grows with its content instead of scrolling inside a
  // single visible line.
  await expect
    .poll(async () => (await textarea.boundingBox())!.height)
    .toBeGreaterThan(singleLineHeight);
});

test('keeps the textarea scrollable once content exceeds the height cap', async ({
  page,
}, testInfo) => {
  // Regression: the textarea is .editorArea's last child and used to inherit
  // `overflow: clip`, which pinned scrollTop to 0 once auto-grow hit the
  // CSS max-height — content beyond the cap became unreachable.
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.tap();
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
    '\n',
  );
  await textarea.fill(lines);

  // Auto-grow stops at the cap…
  await expect
    .poll(async () => (await textarea.boundingBox())!.height)
    .toBeGreaterThan(250);
  const metrics = await textarea.evaluate((el) => {
    el.scrollTop = 10_000;
    return {
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      maxHeight: getComputedStyle(el).maxHeight,
    };
  });
  expect(metrics.maxHeight).toBe('300px');
  expect((await textarea.boundingBox())!.height).toBeLessThanOrEqual(304);
  // …and the overflowing content stays reachable by scrolling.
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.scrollTop).toBeGreaterThan(0);
  expect(metrics.scrollTop).toBeGreaterThanOrEqual(
    metrics.scrollHeight - metrics.clientHeight - 2,
  );
});

test('slash commands typed as text still execute as commands', async ({
  page,
}, testInfo) => {
  // The textarea backend has no slash completion menu, but commands are
  // interpreted from the submitted text at the App layer, so typing them
  // out still works.
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await gotoSession(page, scenario, daemon);
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.tap();
  await page.keyboard.type('/help');
  await page.locator('[data-web-shell-composer-submit]').tap();

  await expect(page.getByRole('dialog', { name: 'Help' })).toBeVisible();
  expect(daemon.promptRequests()).toHaveLength(0);
  await expect(textarea).toHaveValue('');
});

test('?composer=codemirror escape hatch forces the CodeMirror path', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);

  await page.goto(
    `/session/${encodeURIComponent(scenario.sessionId)}?composer=codemirror`,
  );
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await completeReplay(page, daemon, scenario.sessionId);

  await expect(page.locator('.cm-editor')).toBeVisible();
  await expect(page.locator(COMPOSER_TEXTAREA)).toHaveCount(0);
});

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
  await expect(page.locator('[data-web-shell-root]')).toBeVisible();
  await completeReplay(page, daemon, scenario.sessionId);
}

async function completeReplay(
  page: Page,
  daemon: MockDaemonController,
  sessionId?: string,
  replayedCount = 0,
): Promise<void> {
  const connection = await daemon.sse.waitForConnection(sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}

function firstRequestBody(
  requests: readonly DaemonRequestRecord[],
): Record<string, unknown> {
  const request = requests[0];
  if (!request) throw new Error('Expected a recorded daemon request.');
  expect(typeof request.body).toBe('object');
  expect(request.body).not.toBeNull();
  return request.body as Record<string, unknown>;
}

function expectPromptBodyToContainText(
  body: Record<string, unknown>,
  text: string,
): void {
  const prompt = body['prompt'];
  expect(Array.isArray(prompt)).toBe(true);
  const blocks = prompt as readonly unknown[];
  expect(
    blocks.some(
      (block) =>
        typeof block === 'object' &&
        block !== null &&
        (block as Record<string, unknown>)['type'] === 'text' &&
        (block as Record<string, unknown>)['text'] === text,
    ),
  ).toBe(true);
}
