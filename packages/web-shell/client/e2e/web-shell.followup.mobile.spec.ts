/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Touch follow-up suggestion acceptance. Runs under the `mobile-chromium`
// (Pixel 7) and `mobile-webkit` (iPhone 13) projects, where the composer is
// the plain-textarea backend: the suggestion renders as a single tappable
// chip bar above the input in every variant — its content is its label, and
// the editing row carries no follow-up key. Tapping the chip fills the
// textarea without submitting, matching desktop Tab; Send with an empty
// input keeps submitting the suggestion directly.

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
  type DaemonRequestRecord,
  type MockDaemonController,
  type WebShellDaemonScenario,
} from './utils/mockDaemon';

const COMPOSER_TEXTAREA = 'textarea[data-web-shell-composer-editor]';
const COMPOSER_SUBMIT = '[data-web-shell-composer-submit]';
const FOLLOWUP_BAR = '[data-web-shell-mobile-followup]';
const FOLLOWUP_ACCEPT = '[data-web-shell-mobile-followup-accept]';
const FOLLOWUP_DISMISS = '[data-web-shell-mobile-followup-dismiss]';
const SUGGESTION = 'run the tests';
const ZH_SUGGESTION = '运行测试';

async function installScenario(
  page: Page,
  scenario: WebShellDaemonScenario,
  testInfo: TestInfo,
): Promise<MockDaemonController> {
  return installMockDaemon(page, scenario, {
    baseURL: String(testInfo.project.use.baseURL),
  });
}

async function gotoHarness(
  page: Page,
  scenario: WebShellDaemonScenario,
  daemon: MockDaemonController,
  composerVariant: 'simple' | 'default',
  language?: 'zh-CN',
): Promise<void> {
  const languageQuery = language ? `&language=${language}` : '';
  await page.goto(
    `/e2e/composer-layout-harness.html?composerVariant=${composerVariant}&tags=false&sessionId=${scenario.sessionId}${languageQuery}`,
  );
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: 0,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);
}

async function pushSuggestion(
  daemon: MockDaemonController,
  sessionId: string,
  suggestion: string = SUGGESTION,
): Promise<void> {
  await daemon.sendEvent({
    v: 1,
    type: 'followup_suggestion',
    data: {
      sessionId,
      suggestion,
      promptId: `${sessionId}########1`,
    },
  });
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

test('mobile suggestion bar fills the textarea without submitting', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'simple');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const send = page.locator(COMPOSER_SUBMIT);
  await expect(textarea).toBeVisible();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  await expect(page.locator(FOLLOWUP_BAR)).toHaveCount(0);
  const idlePlaceholder = await textarea.getAttribute('placeholder');
  await pushSuggestion(daemon, scenario.sessionId);
  const bar = page.locator(FOLLOWUP_BAR);
  await expect(bar).toBeVisible();
  await expect(page.locator(FOLLOWUP_ACCEPT)).toHaveText(SUGGESTION);
  // Single surface: the bar carries the suggestion text; the textarea keeps
  // its ordinary placeholder instead of repeating it.
  await expect(textarea).toHaveAttribute('placeholder', idlePlaceholder!);
  await expect(textarea).not.toHaveAttribute('placeholder', SUGGESTION);
  await expect(send).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath('followup-bar-simple-v4.png'),
  });
  await page.locator(FOLLOWUP_ACCEPT).tap();
  await expect(textarea).toHaveValue(SUGGESTION);
  await expect(textarea).toBeFocused();
  await expect(bar).toHaveCount(0);
  expect(daemon.promptRequests()).toHaveLength(0);
  await send.tap();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expectPromptBodyToContainText(
    firstRequestBody(daemon.promptRequests()),
    SUGGESTION,
  );
  await expect(textarea).toHaveValue('');
});

test('mobile suggestion dismiss clears the placeholder and send', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'simple');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const send = page.locator(COMPOSER_SUBMIT);
  await pushSuggestion(daemon, scenario.sessionId);
  await expect(page.locator(FOLLOWUP_BAR)).toBeVisible();
  await page.locator(FOLLOWUP_DISMISS).tap();
  await expect(page.locator(FOLLOWUP_BAR)).toHaveCount(0);
  await expect(textarea).toHaveValue('');
  await expect(textarea).not.toHaveAttribute('placeholder', SUGGESTION);
  await expect(send).toBeDisabled();
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile empty send submits the visible suggestion directly', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'simple');
  await pushSuggestion(daemon, scenario.sessionId);
  await expect(page.locator(FOLLOWUP_BAR)).toBeVisible();
  await page.locator(COMPOSER_SUBMIT).tap();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expectPromptBodyToContainText(
    firstRequestBody(daemon.promptRequests()),
    SUGGESTION,
  );
  await expect(page.locator(COMPOSER_TEXTAREA)).toHaveValue('');
});

test('mobile typing hides the suggestion bar and sends the draft', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'simple');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await pushSuggestion(daemon, scenario.sessionId);
  await expect(page.locator(FOLLOWUP_BAR)).toBeVisible();
  await textarea.fill('something else');
  await expect(page.locator(FOLLOWUP_BAR)).toHaveCount(0);
  await page.locator(COMPOSER_SUBMIT).tap();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expectPromptBodyToContainText(
    firstRequestBody(daemon.promptRequests()),
    'something else',
  );
});

test('mobile prefix typing keeps the send completion without the bar', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'simple');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await pushSuggestion(daemon, scenario.sessionId);
  await expect(page.locator(FOLLOWUP_BAR)).toBeVisible();
  await textarea.fill('run');
  await expect(page.locator(FOLLOWUP_BAR)).toHaveCount(0);
  await page.locator(COMPOSER_SUBMIT).tap();
  await expect.poll(() => daemon.promptRequests().length).toBe(1);
  expectPromptBodyToContainText(
    firstRequestBody(daemon.promptRequests()),
    SUGGESTION,
  );
});

test('mobile editing row carries no follow-up key while the chip bar accepts', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const editingRow = page.locator('[data-web-shell-mobile-editing-actions]');
  await expect(editingRow).toBeVisible();
  const idlePlaceholder = await textarea.getAttribute('placeholder');
  await pushSuggestion(daemon, scenario.sessionId);
  await expect(page.locator(FOLLOWUP_BAR)).toBeVisible();
  await expect(editingRow.locator(FOLLOWUP_ACCEPT)).toHaveCount(0);
  await expect(editingRow.locator(FOLLOWUP_DISMISS)).toHaveCount(0);
  await expect(
    editingRow.getByRole('button', { name: 'Fill in', exact: true }),
  ).toHaveCount(0);
  await expect(textarea).toHaveAttribute('placeholder', idlePlaceholder!);
  await page.screenshot({
    path: testInfo.outputPath('followup-bar-default-v4.png'),
  });
  await page.locator(FOLLOWUP_ACCEPT).tap();
  await expect(textarea).toHaveValue(SUGGESTION);
  await expect(textarea).toBeFocused();
  await expect(page.locator(FOLLOWUP_BAR)).toHaveCount(0);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile follow-up bar renders in Simplified Chinese', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'simple', 'zh-CN');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const idlePlaceholder = await textarea.getAttribute('placeholder');
  await pushSuggestion(daemon, scenario.sessionId, ZH_SUGGESTION);
  await expect(page.locator(FOLLOWUP_BAR)).toBeVisible();
  await expect(page.locator(FOLLOWUP_ACCEPT)).toHaveText(ZH_SUGGESTION);
  await expect(page.locator(FOLLOWUP_DISMISS)).toHaveAttribute(
    'aria-label',
    '忽略建议',
  );
  await expect(textarea).toHaveAttribute('placeholder', idlePlaceholder!);
  await expect(textarea).not.toHaveAttribute('placeholder', ZH_SUGGESTION);
  await page.screenshot({
    path: testInfo.outputPath('followup-bar-simple-zh-v2.png'),
  });
  await page.locator(FOLLOWUP_ACCEPT).tap();
  await expect(textarea).toHaveValue(ZH_SUGGESTION);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile chip bar accepts in Simplified Chinese without an editing-row key', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default', 'zh-CN');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const editingRow = page.locator('[data-web-shell-mobile-editing-actions]');
  await expect(editingRow).toBeVisible();
  const idlePlaceholder = await textarea.getAttribute('placeholder');
  await pushSuggestion(daemon, scenario.sessionId, ZH_SUGGESTION);
  await expect(page.locator(FOLLOWUP_ACCEPT)).toHaveText(ZH_SUGGESTION);
  await expect(editingRow.locator(FOLLOWUP_ACCEPT)).toHaveCount(0);
  await expect(
    editingRow.getByRole('button', { name: '填入', exact: true }),
  ).toHaveCount(0);
  await expect(textarea).toHaveAttribute('placeholder', idlePlaceholder!);
  await page.screenshot({
    path: testInfo.outputPath('followup-bar-default-zh-v2.png'),
  });
  await page.locator(FOLLOWUP_ACCEPT).tap();
  await expect(textarea).toHaveValue(ZH_SUGGESTION);
  await expect(page.locator(FOLLOWUP_BAR)).toHaveCount(0);
  expect(daemon.promptRequests()).toHaveLength(0);
});
