/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Touch follow-up suggestion acceptance. Runs under the `mobile-chromium`
// (Pixel 7) project only: `mobile-webkit` greps @smoke and these cases carry
// no such tag, so WebKit coverage is not claimed here. The composer is the
// plain-textarea backend: the suggestion renders as a single tappable chip
// bar above the input in every variant — its content is its label, and the
// editing row carries no follow-up-specific key. Tapping the chip fills the
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

test('mobile editing-row direction keys move the caret', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.fill('aa\nbbb\ncc');
  const caret = () =>
    textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart);
  expect(await caret()).toBe(9);
  await page.locator('[data-web-shell-mobile-caret-up]').tap();
  expect(await caret()).toBe(5);
  await page.locator('[data-web-shell-mobile-caret-down]').tap();
  expect(await caret()).toBe(9);
  await textarea.evaluate((el) => el.setSelectionRange(1, 1));
  await page.locator('[data-web-shell-mobile-caret-right]').tap();
  expect(await caret()).toBe(2);
  expect(daemon.promptRequests()).toHaveLength(0);
  // The chip bar only renders with an empty draft (single-surface rule).
  await textarea.fill('');
  await pushSuggestion(daemon, scenario.sessionId);
  await expect(page.locator(FOLLOWUP_BAR)).toBeVisible();
  // Evidence shots share one focus state: unfocused, so the conditional
  // hide-keyboard control is absent and no tap-hover tile lingers on a key.
  await textarea.evaluate((el) => el.blur());
  await page.mouse.move(0, 0);
  await expect(
    page.getByRole('button', { name: 'Hide keyboard', exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('followup-keys-row-v6.png'),
  });
});

test('mobile editing keys share the row at 390px and own a line at 240px', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const caretUp = page.locator('[data-web-shell-mobile-caret-up]');
  const expand = page.getByRole('button', {
    name: 'Expand editor',
    exact: true,
  });
  await expect(caretUp).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const up = (await caretUp.boundingBox())!;
      const exp = (await expand.boundingBox())!;
      return Math.abs(up.y - exp.y) <= 1;
    })
    .toBe(true);
  await page.setViewportSize({ width: 240, height: 844 });
  await expect
    .poll(async () => {
      const up = (await caretUp.boundingBox())!;
      const exp = (await expand.boundingBox())!;
      return up.y > exp.y + 1;
    })
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    240,
  );
});

test('mobile right key accepts the visible suggestion', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await pushSuggestion(daemon, scenario.sessionId);
  await expect(page.locator(FOLLOWUP_BAR)).toBeVisible();
  const rightKey = page.locator('[data-web-shell-mobile-caret-right]');
  await expect(rightKey).toHaveAttribute('aria-label', 'Accept suggestion');
  await rightKey.tap();
  await expect(textarea).toHaveValue(SUGGESTION);
  await expect(page.locator(FOLLOWUP_BAR)).toHaveCount(0);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile right key label and accept stay in sync on a typed prefix', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await pushSuggestion(daemon, scenario.sessionId);
  await expect(page.locator(FOLLOWUP_BAR)).toBeVisible();
  await textarea.fill('run');
  // The chip hides on a non-empty draft, but the right key still accepts the
  // completion, so its label must announce the accept, not caret movement.
  await expect(page.locator(FOLLOWUP_BAR)).toHaveCount(0);
  const rightKey = page.locator('[data-web-shell-mobile-caret-right]');
  await expect(rightKey).toHaveAttribute('aria-label', 'Accept suggestion');
  await rightKey.tap();
  await expect(textarea).toHaveValue(SUGGESTION);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile right key steps whole graphemes and slash keeps emoji intact', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const caret = () =>
    textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart);
  await textarea.fill('A😀B');
  await textarea.evaluate((el) => el.setSelectionRange(1, 1));
  await page.locator('[data-web-shell-mobile-caret-right]').tap();
  expect(await caret()).toBe(3);
  await page.locator('[data-web-shell-mobile-insert-slash]').tap();
  await expect(textarea).toHaveValue('A😀/B');
  // Native parity: ArrowRight from the same caret also lands after the pair.
  await textarea.fill('A😀B');
  await textarea.evaluate((el) => el.setSelectionRange(1, 1));
  await textarea.focus();
  await page.keyboard.press('ArrowRight');
  expect(await caret()).toBe(3);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile vertical keys follow soft-wrapped lines like the native arrows', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const caret = () =>
    textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart);
  await textarea.fill('a'.repeat(150));
  for (const [hook, native] of [
    ['[data-web-shell-mobile-caret-up]', 'ArrowUp'],
    ['[data-web-shell-mobile-caret-down]', 'ArrowDown'],
  ] as const) {
    await textarea.evaluate((el) => el.setSelectionRange(64, 64));
    await page.locator(hook).tap();
    const touch = await caret();
    await textarea.evaluate((el) => el.setSelectionRange(64, 64));
    await textarea.focus();
    await page.keyboard.press(native);
    const nativeCaret = await caret();
    expect(touch).toBe(nativeCaret);
    expect(touch).not.toBe(0);
    expect(touch).not.toBe(150);
  }
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile vertical run holds the preferred column through short lines', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const caret = () =>
    textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart);
  await textarea.fill('aaaa\nbb\ncccc');
  await textarea.evaluate((el) => el.setSelectionRange(12, 12));
  const up = page.locator('[data-web-shell-mobile-caret-up]');
  const down = page.locator('[data-web-shell-mobile-caret-down]');
  await up.tap();
  expect(await caret()).toBe(7);
  await up.tap();
  expect(await caret()).toBe(4);
  await down.tap();
  expect(await caret()).toBe(7);
  await down.tap();
  expect(await caret()).toBe(12);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile caret keys scroll long drafts back into the visible window', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const draft = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  await textarea.fill(draft);
  const initialScroll = await textarea.evaluate((el) => {
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  expect(initialScroll).toBeGreaterThan(0);
  const up = page.locator('[data-web-shell-mobile-caret-up]');
  for (let i = 0; i < 15; i += 1) await up.tap();
  const after = await textarea.evaluate((el) => ({
    scrollTop: el.scrollTop,
    caret: el.selectionStart,
    clientHeight: el.clientHeight,
  }));
  expect(after.scrollTop).toBeLessThan(initialScroll);
  const caretLine = draft.slice(0, after.caret).split('\n').length - 1;
  const lineHeight = await textarea.evaluate(
    (el) => parseFloat(getComputedStyle(el).lineHeight) || 25.6,
  );
  expect(caretLine * lineHeight).toBeGreaterThanOrEqual(after.scrollTop);
  expect(caretLine * lineHeight + lineHeight).toBeLessThanOrEqual(
    after.scrollTop + after.clientHeight,
  );
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile dismiss does not focus the empty composer', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await pushSuggestion(daemon, scenario.sessionId);
  await expect(page.locator(FOLLOWUP_BAR)).toBeVisible();
  await textarea.evaluate((el) => el.blur());
  await page.locator(FOLLOWUP_DISMISS).tap();
  await expect(page.locator(FOLLOWUP_BAR)).toHaveCount(0);
  await expect(textarea).not.toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Hide keyboard', exact: true }),
  ).toHaveCount(0);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile expanded dialog keeps the suggestion on its placeholder', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  await pushSuggestion(daemon, scenario.sessionId);
  await expect(page.locator(FOLLOWUP_BAR)).toBeVisible();
  await page.getByRole('button', { name: 'Expand editor', exact: true }).tap();
  const expanded = page.locator('[data-web-shell-expanded-editor] textarea');
  await expect(expanded).toBeVisible();
  await expect(expanded).toHaveAttribute('placeholder', SUGGESTION);
  await expect(expanded).toHaveAttribute('aria-label', SUGGESTION);
  await page.screenshot({
    path: testInfo.outputPath('followup-expanded-v7.png'),
  });
  await expanded.fill('draft');
  await expect(expanded).not.toHaveAttribute('placeholder', SUGGESTION);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile caret keys yield to an active IME composition', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.fill('abcd');
  await textarea.evaluate((el) => el.setSelectionRange(2, 2));
  await textarea.focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', {
    text: 'ni',
    selectionStart: 2,
    selectionEnd: 2,
    replacementStart: 2,
    replacementEnd: 2,
  });
  const before = await textarea.evaluate((el) => ({
    value: el.value,
    caret: el.selectionStart,
  }));
  expect(before.value).toContain('ni');
  await page.locator('[data-web-shell-mobile-caret-up]').tap();
  await page.locator('[data-web-shell-mobile-caret-right]').tap();
  await page.locator('[data-web-shell-mobile-insert-slash]').tap();
  const during = await textarea.evaluate((el) => ({
    value: el.value,
    caret: el.selectionStart,
  }));
  expect(during).toEqual(before);
  await cdp.send('Input.imeSetComposition', {
    text: '',
    selectionStart: 0,
    selectionEnd: 0,
    replacementStart: 2,
    replacementEnd: 4,
  });
  await expect(textarea).toHaveValue('abcd');
  await page.locator('[data-web-shell-mobile-caret-right]').tap();
  expect(
    await textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
  ).toBe(3);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile slash key inserts a literal slash', async ({ page }, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await page.locator('[data-web-shell-mobile-insert-slash]').tap();
  await expect(textarea).toHaveValue('/');
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

test('mobile chip bar accepts in Simplified Chinese with caret keys only', async ({
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
    editingRow.locator('[data-web-shell-mobile-caret-up]'),
  ).toHaveAttribute('aria-label', '光标上移');
  await expect(
    editingRow.locator('[data-web-shell-mobile-insert-slash]'),
  ).toHaveAttribute('aria-label', '插入斜杠');
  await expect(textarea).toHaveAttribute('placeholder', idlePlaceholder!);
  // Same unfocused evidence state as the English key-row shot.
  await expect(
    page.getByRole('button', { name: '收起键盘', exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('followup-keys-row-zh-v6.png'),
  });
  await page.locator(FOLLOWUP_ACCEPT).tap();
  await expect(textarea).toHaveValue(ZH_SUGGESTION);
  await expect(page.locator(FOLLOWUP_BAR)).toHaveCount(0);
  expect(daemon.promptRequests()).toHaveLength(0);
});
