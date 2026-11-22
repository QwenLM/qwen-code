/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Touch follow-up suggestion acceptance. Runs under the `mobile-chromium`
// (Pixel 7) project, and — apart from the CDP-IME and 50k-timing cases — under
// `mobile-webkit`, which selects `*.mobile.spec.ts` via its `@smoke` grep.
// The composer is the
// plain-textarea backend: the suggestion renders as a single tappable chip
// bar above the input in every variant — its content is its label, and the
// editing row carries no follow-up-specific key. Tapping the chip fills the
// textarea without submitting, matching desktop Tab. Ordinary prose keeps
// the direct empty/prefix Send path; a model-completed slash command is first
// filled for review and requires a second deliberate Send to submit.

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

test('@smoke mobile suggestion bar fills the textarea without submitting', async ({
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

test('@smoke mobile suggestion dismiss clears the placeholder and send', async ({
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

test('@smoke mobile empty send submits the visible suggestion directly', async ({
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

test('@smoke mobile typing hides the suggestion bar and sends the draft', async ({
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

test('@smoke mobile prefix typing keeps the send completion without the bar', async ({
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

test('@smoke mobile editing row carries no follow-up key while the chip bar accepts', async ({
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

test('@smoke mobile slash-suggestion empty Send first fills without submitting', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'simple');
  await pushSuggestion(daemon, scenario.sessionId, '/help');
  await expect(page.locator(FOLLOWUP_ACCEPT)).toBeVisible();
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const send = page.locator(COMPOSER_SUBMIT);

  await send.tap();

  await expect(textarea).toHaveValue('/help');
  await expect(page.getByRole('dialog', { name: 'Help' })).toHaveCount(0);
  await expect(page.locator(FOLLOWUP_BAR)).toHaveCount(0);
  expect(daemon.promptRequests()).toHaveLength(0);
  await send.tap();
  await expect(page.getByRole('dialog', { name: 'Help' })).toBeVisible();
});

test('@smoke mobile slash-prefix Send replaces the draft instead of appending', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'simple');
  await pushSuggestion(daemon, scenario.sessionId, '/help');
  await expect(page.locator(FOLLOWUP_ACCEPT)).toBeVisible();
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const send = page.locator(COMPOSER_SUBMIT);
  await textarea.fill('/he');
  await textarea.focus();
  await textarea.evaluate((el) => el.setSelectionRange(3, 3));

  await send.tap();

  await expect(textarea).toHaveValue('/help');
  await expect(page.getByRole('dialog', { name: 'Help' })).toHaveCount(0);
  expect(daemon.promptRequests()).toHaveLength(0);
  await send.tap();
  await expect(page.getByRole('dialog', { name: 'Help' })).toBeVisible();
});

test('@smoke mobile a fully typed slash command keeps direct Send', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'simple');
  await pushSuggestion(daemon, scenario.sessionId, '/help');
  await expect(page.locator(FOLLOWUP_ACCEPT)).toBeVisible();
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.fill('/help');

  await page.locator(COMPOSER_SUBMIT).tap();

  await expect(page.getByRole('dialog', { name: 'Help' })).toBeVisible();
});

test('@smoke mobile switching sessions clears a pending slash suggestion without submitting', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'simple');
  await pushSuggestion(daemon, scenario.sessionId, '/help');
  await expect(page.locator(FOLLOWUP_ACCEPT)).toBeVisible();

  await page.goto('/session/previous-session');
  await daemon.sse.waitForConnection('previous-session');
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: 'previous-session',
      replayedCount: 0,
    }),
  );
  await expect(page.getByText('Loading...')).toHaveCount(0);

  await expect(page.locator(FOLLOWUP_ACCEPT)).toHaveCount(0);
  await expect(page.locator(COMPOSER_TEXTAREA)).toHaveValue('');
  await expect(page.locator(COMPOSER_SUBMIT)).toBeDisabled();
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('@smoke mobile editing-row direction keys move the caret', async ({
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
    path: testInfo.outputPath('followup-keys-row-v9.png'),
  });
});

test('@smoke mobile editing controls keep the keyboard and expand tail right aligned', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const keys = page.locator('[data-web-shell-mobile-editing-keys]');
  await textarea.evaluate((el) => el.blur());

  const checkTail = async (keyboardVisible: boolean) => {
    for (const width of [390, 240]) {
      await page.setViewportSize({ width, height: 844 });
      await expect
        .poll(async () =>
          keys.evaluate((group, hasKeyboard) => {
            const buttons = Array.from(
              group.querySelectorAll<HTMLButtonElement>('button'),
            );
            const labels = buttons.map((button) =>
              button.getAttribute('aria-label'),
            );
            const expectedLabels = [
              'Move cursor up',
              'Move cursor down',
              'Move cursor right',
              'Insert slash',
              ...(hasKeyboard ? ['Hide keyboard'] : []),
              'Expand editor',
            ];
            if (labels.join('\n') !== expectedLabels.join('\n')) return false;
            const rects = buttons.map((button) =>
              button.getBoundingClientRect(),
            );
            const expand = rects.at(-1)!;
            const slash = rects[3]!;
            const expandRight = expand.x + expand.width;
            if (
              !rects.every(
                (rect) =>
                  expandRight >= rect.x + rect.width - 1 &&
                  expand.width >= 44 &&
                  expand.height >= 44,
              )
            ) {
              return false;
            }
            if (hasKeyboard) {
              const keyboard = rects.at(-2)!;
              if (
                Math.abs(keyboard.y - expand.y) > 1 ||
                expand.x < keyboard.x + keyboard.width
              ) {
                return false;
              }
            }
            return expand.x >= slash.x + slash.width;
          }, keyboardVisible),
        )
        .toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(width);
      await page.screenshot({
        path: testInfo.outputPath(
          `editing-tail-${keyboardVisible ? 'focused' : 'idle'}-${width}px-v9.png`,
        ),
      });
    }
  };

  await checkTail(false);
  await textarea.focus();
  await checkTail(true);
  await page.getByRole('button', { name: 'Hide keyboard', exact: true }).tap();
  await expect(textarea).not.toBeFocused();
  await checkTail(false);
  await expect(keys.getByRole('button')).toHaveCount(5);
  await expect(
    page.getByRole('button', { name: 'Hide keyboard', exact: true }),
  ).toHaveCount(0);
});

test('@smoke mobile right key accepts the visible suggestion', async ({
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

test('@smoke mobile right key label and accept stay in sync on a typed prefix', async ({
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

test('@smoke mobile right key steps whole graphemes and slash keeps emoji intact', async ({
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
  const family = '👨‍👩‍👧‍👦';
  await textarea.fill(`A${family}B`);
  await textarea.evaluate((el) => el.setSelectionRange(1, 1));
  await page.locator('[data-web-shell-mobile-caret-right]').tap();
  expect(await caret()).toBe(12);
  await page.locator('[data-web-shell-mobile-insert-slash]').tap();
  await expect(textarea).toHaveValue(`A${family}/B`);
  // Native parity: ArrowRight from the same caret also lands after the pair.
  await textarea.fill('A😀B');
  await textarea.evaluate((el) => el.setSelectionRange(1, 1));
  await textarea.focus();
  await page.keyboard.press('ArrowRight');
  expect(await caret()).toBe(3);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('@smoke mobile vertical keys follow soft-wrapped lines like the native arrows', async ({
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

test('@smoke mobile up-move to a wrapped line end keeps the emoji whole', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const draft = '😀' + 'a'.repeat(60);
  await textarea.fill(draft);
  await textarea.evaluate((el) => el.setSelectionRange(6, 6));
  await page.locator('[data-web-shell-mobile-caret-up]').tap();
  expect(
    await textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
  ).toBe(2);
  await page.locator('[data-web-shell-mobile-insert-slash]').tap();
  const value = await textarea.evaluate(
    (el) => (el as HTMLTextAreaElement).value,
  );
  expect(value).toBe('😀/' + 'a'.repeat(60));
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(value)).toBe(false);
  expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)).toBe(false);
  // Native parity for the same up-move.
  await textarea.fill(draft);
  await textarea.evaluate((el) => el.setSelectionRange(6, 6));
  await textarea.focus();
  await page.keyboard.press('ArrowUp');
  expect(
    await textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
  ).toBe(2);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('@smoke mobile down after a horizontal move does not restore the old column', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.fill('abc\ndef');
  await textarea.evaluate((el) => el.setSelectionRange(1, 1));
  await page.locator('[data-web-shell-mobile-caret-right]').tap();
  expect(
    await textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
  ).toBe(2);
  await page.locator('[data-web-shell-mobile-caret-down]').tap();
  expect(
    await textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
  ).toBe(6);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('mobile keys stay responsive on a 50k draft without full-draft measurement', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await textarea.fill('a'.repeat(50000));
  await textarea.evaluate((el) => el.setSelectionRange(0, 0));
  const timeClick = async (hook: string) =>
    page.evaluate((selector) => {
      const button = document.querySelector(selector) as HTMLButtonElement;
      const t0 = performance.now();
      button.click();
      return performance.now() - t0;
    }, hook);
  expect(await timeClick('[data-web-shell-mobile-caret-right]')).toBeLessThan(
    200,
  );
  expect(
    await textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
  ).toBe(1);
  expect(await timeClick('[data-web-shell-mobile-caret-up]')).toBeLessThan(200);
  // Cached-mirror repeat is cheaper still.
  expect(await timeClick('[data-web-shell-mobile-caret-up]')).toBeLessThan(200);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('@smoke mobile vertical run holds the preferred column through short lines', async ({
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

test('@smoke mobile caret keys scroll long drafts back into the visible window', async ({
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

test('@smoke mobile dismiss does not focus the empty composer', async ({
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

test('@smoke mobile expanded dialog keeps the suggestion on its placeholder', async ({
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
  await expect(expanded).toBeFocused();
  await expect(expanded).toHaveAttribute('placeholder', SUGGESTION);
  await expect(expanded).toHaveAttribute('aria-label', SUGGESTION);
  await page.screenshot({
    path: testInfo.outputPath('followup-expanded-v7.png'),
  });
  await expanded.fill('draft');
  await expect(expanded).not.toHaveAttribute('placeholder', SUGGESTION);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('@smoke mobile mirror does not accumulate and is discarded on clear', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const up = page.locator('[data-web-shell-mobile-caret-up]');
  const mirrorCount = () =>
    page.locator('[data-web-shell-caret-mirror]').count();
  await textarea.fill('a');
  await up.tap();
  expect(await mirrorCount()).toBe(1);
  for (let i = 2; i <= 10; i += 1) {
    await textarea.fill('a'.repeat(i));
    await up.tap();
  }
  expect(await mirrorCount()).toBe(1);
  await textarea.fill('');
  expect(await mirrorCount()).toBe(0);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('@smoke mobile down lands on an empty next line and continues', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const down = page.locator('[data-web-shell-mobile-caret-down]');
  const caret = () =>
    textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart);
  await textarea.fill('abcd\n\nwxyz');
  await textarea.evaluate((el) => el.setSelectionRange(3, 3));
  await down.tap();
  expect(await caret()).toBe(5);
  await down.tap();
  expect(await caret()).toBe(9);
  await textarea.fill('hello\n\nworld');
  await textarea.evaluate((el) => el.setSelectionRange(5, 5));
  await down.tap();
  expect(await caret()).toBe(6);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('@smoke mobile repeated up crosses a wrap boundary like native arrows', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  const up = page.locator('[data-web-shell-mobile-caret-up]');
  const caret = () =>
    textarea.evaluate((el) => (el as HTMLTextAreaElement).selectionStart);
  await textarea.fill('go ' + 'a'.repeat(60));
  await textarea.evaluate((el) => el.setSelectionRange(9, 9));
  const seen: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    await up.tap();
    seen.push(await caret());
  }
  expect(seen).toEqual([3, 0, 0]);
  await textarea.evaluate((el) => el.setSelectionRange(9, 9));
  await textarea.focus();
  const native: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('ArrowUp');
    native.push(await caret());
  }
  expect(native).toEqual(seen);
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('@smoke mobile caret and dismiss icons share the 18px sibling geometry', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  await pushSuggestion(daemon, scenario.sessionId);
  await expect(page.locator(FOLLOWUP_BAR)).toBeVisible();
  const expandSvg = page
    .getByRole('button', {
      name: 'Expand editor',
      exact: true,
    })
    .locator('svg');
  const caretSvg = page.locator('[data-web-shell-mobile-caret-up] svg');
  const dismissSvg = page.locator(`${FOLLOWUP_DISMISS} svg`);
  for (const [name, svg] of [
    ['expand', expandSvg],
    ['caret', caretSvg],
    ['dismiss', dismissSvg],
  ] as const) {
    expect(await svg.boundingBox(), name).toMatchObject({
      width: 18,
      height: 18,
    });
  }
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

test('@smoke mobile slash key inserts a literal slash', async ({
  page,
}, testInfo) => {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installScenario(page, scenario, testInfo);
  await gotoHarness(page, scenario, daemon, 'default');
  const textarea = page.locator(COMPOSER_TEXTAREA);
  await page.locator('[data-web-shell-mobile-insert-slash]').tap();
  await expect(textarea).toHaveValue('/');
  expect(daemon.promptRequests()).toHaveLength(0);
});

test('@smoke mobile follow-up bar renders in Simplified Chinese', async ({
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

test('@smoke mobile chip bar accepts in Simplified Chinese with caret keys only', async ({
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
    path: testInfo.outputPath('followup-keys-row-zh-v9.png'),
  });
  await page.locator(FOLLOWUP_ACCEPT).tap();
  await expect(textarea).toHaveValue(ZH_SUGGESTION);
  await expect(page.locator(FOLLOWUP_BAR)).toHaveCount(0);
  expect(daemon.promptRequests()).toHaveLength(0);
});
