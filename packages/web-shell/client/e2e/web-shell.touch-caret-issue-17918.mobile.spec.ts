/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';
import {
  createWebShellDaemonScenario,
  installMockDaemon,
  replayCompleteEvent,
} from './utils/mockDaemon';

const TEXTAREA = 'textarea[data-web-shell-composer-editor]';
const keySelectors: Record<string, string> = {
  ArrowDown: '[data-web-shell-mobile-caret-down]',
  ArrowRight: '[data-web-shell-mobile-caret-right]',
  ArrowUp: '[data-web-shell-mobile-caret-up]',
};

interface CaretCase {
  name: string;
  text: string;
  caret: number;
  keys: Array<'ArrowDown' | 'ArrowRight' | 'ArrowUp'>;
  width?: number;
  expected?: number[];
}

const cases: CaretCase[] = [
  {
    name: 'right clears the vertical anchor after a short-line clamp',
    text: 'abc\ndef\nghi\njkl',
    caret: 3,
    keys: ['ArrowDown', 'ArrowRight', 'ArrowDown'],
  },
  {
    name: 'right keeps the horizontal offset on the next vertical move',
    text: 'abcdef\nghijkl\nmnopqr',
    caret: 1,
    keys: ['ArrowDown', 'ArrowRight', 'ArrowDown'],
    // Touch restarts from the post-Right caret; native Chromium may retain
    // its earlier vertical goal. Before the fix touch regressed to offset 14.
    expected: [8, 9, 16],
  },
  {
    name: 'the next logical line contributes its first soft-wrap boundary',
    text: `0123456789\ngo ${'a'.repeat(60)}`,
    caret: 9,
    keys: ['ArrowDown', 'ArrowDown', 'ArrowUp'],
  },
  {
    name: 'down remembers a short wrapped destination line',
    text: `${'a'.repeat(39)} go ${'b'.repeat(50)}`,
    caret: 25,
    keys: ['ArrowDown', 'ArrowDown'],
    width: 346,
    // Preserve the grapheme column from the short wrapped line (43+25).
    // Native pixel-x positioning may select 67; neither choice lands at 93.
    expected: [43, 68],
  },
  {
    name: 'up returns from a short wrapped destination line',
    text: `${'a'.repeat(39)} go ${'b'.repeat(50)}`,
    caret: 25,
    keys: ['ArrowDown', 'ArrowUp'],
    width: 346,
  },
];

for (const caretCase of cases) {
  test(`@smoke touch caret: ${caretCase.name}`, async ({ page }, testInfo) => {
    if (caretCase.width) {
      await page.setViewportSize({ width: caretCase.width, height: 839 });
    }
    await openLayoutComposer(page, testInfo.project.use.baseURL);
    // Isolate navigation state from native pixel-x versus grapheme columns.
    await page.addStyleTag({
      content: `${TEXTAREA} { font-family: monospace !important; }`,
    });

    const nativePositions = await exercise(page, caretCase, false);
    const touchPositions = await exercise(page, caretCase, true);
    expect(
      touchPositions,
      'touch positions must follow the caret contract',
    ).toEqual(caretCase.expected ?? nativePositions);
  });
}

async function exercise(
  page: Page,
  caretCase: CaretCase,
  touch: boolean,
): Promise<number[]> {
  const textarea = page.locator(TEXTAREA);
  await textarea.fill(caretCase.text);
  await textarea.evaluate((element: HTMLTextAreaElement, caret: number) => {
    element.focus();
    element.setSelectionRange(caret, caret);
    element.dispatchEvent(new Event('select', { bubbles: true }));
  }, caretCase.caret);
  expect(await caretAtStart(textarea)).toBe(caretCase.caret);
  const positions: number[] = [];
  for (const key of caretCase.keys) {
    if (touch) {
      await page.locator(keySelectors[key]).tap();
    } else {
      await textarea.press(key);
    }
    positions.push(await caretAtStart(textarea));
  }
  await expect(textarea).toHaveValue(caretCase.text);
  return positions;
}

async function caretAtStart(
  textarea: ReturnType<Page['locator']>,
): Promise<number> {
  return textarea.evaluate(
    (element: HTMLTextAreaElement) => element.selectionStart,
  );
}

test('@smoke touch caret recalculates after font size changes at fixed width', async ({
  page,
}, testInfo) => {
  const textarea = await openLayoutComposer(page, testInfo.project.use.baseURL);
  await textarea.fill('a'.repeat(25));
  await textarea.evaluate((el) => {
    el.style.setProperty('width', '100px', 'important');
    el.style.position = 'fixed';
    el.style.left = '0';
    el.style.top = '0';
    el.style.fontFamily = 'monospace';
    el.style.fontSize = '16px';
    el.style.lineHeight = '20px';
  });
  await expect(textarea).toHaveCSS('font-size', '16px');
  await textarea.evaluate(() => document.fonts.ready);
  const before = await visualStarts(textarea);
  await textarea.evaluate((el) => {
    el.style.fontSize = '20px';
    el.style.lineHeight = '24px';
  });
  await expect(textarea).toHaveCSS('font-size', '20px');
  const cached = await visualStarts(textarea);
  const fresh = await textarea.evaluate(async (el) => {
    const sibling = document.createElement('textarea');
    sibling.style.cssText = el.style.cssText;
    sibling.value = el.value;
    document.body.appendChild(sibling);
    const entry = performance
      .getEntriesByType('resource')
      .map((item) => item.name)
      .find((name) => name.includes('/useComposerCore.ts'));
    if (!entry) throw new Error('useComposerCore module URL not found');
    const url = new URL('../utils/touchCaret.ts', entry).href;
    const { discardMirror, visualLineStartsAround } = await import(url);
    const starts = visualLineStartsAround(sibling, sibling.value, 5);
    discardMirror(sibling);
    sibling.remove();
    return starts;
  });
  expect(fresh).not.toEqual(before);
  expect(cached).toEqual(fresh);
});

test('@smoke touch caret recalculates word spacing under cached layout', async ({
  page,
}, testInfo) => {
  const textarea = await openLayoutComposer(page, testInfo.project.use.baseURL);
  await textarea.fill('a '.repeat(25));
  await textarea.evaluate((el) => {
    el.style.setProperty('width', '100px', 'important');
    el.style.position = 'fixed';
    el.style.left = '0';
    el.style.top = '0';
    el.style.fontFamily = 'monospace';
    el.style.fontSize = '16px';
    el.style.lineHeight = '20px';
    el.style.wordSpacing = '0px';
    el.setSelectionRange(5, 5);
  });
  await visualStarts(textarea);
  await textarea.evaluate((el) => {
    el.style.wordSpacing = '24px';
  });
  await expect(textarea).toHaveCSS('word-spacing', '24px');
  await page.locator('[data-web-shell-mobile-caret-down]').tap();
  const touch = await caretAtStart(textarea);
  await textarea.evaluate((el) => {
    el.setSelectionRange(5, 5);
    el.focus();
    el.dispatchEvent(new Event('select', { bubbles: true }));
  });
  await textarea.press('ArrowDown');
  expect(touch).toBe(await caretAtStart(textarea));
});

test('@smoke touch caret accounts for horizontal textarea borders', async ({
  page,
}, testInfo) => {
  const textarea = await openLayoutComposer(page, testInfo.project.use.baseURL);
  await textarea.fill('a'.repeat(25));
  await textarea.evaluate((el) => {
    el.style.setProperty('width', '100px', 'important');
    el.style.position = 'fixed';
    el.style.left = '0';
    el.style.top = '0';
    el.style.fontFamily = 'monospace';
    el.style.fontSize = '16px';
    el.style.lineHeight = '20px';
    el.style.boxSizing = 'content-box';
    el.style.borderLeft = '2px solid transparent';
    el.style.borderRight = '2px solid transparent';
    el.setSelectionRange(5, 5);
  });
  await page.locator('[data-web-shell-mobile-caret-down]').tap();
  const touch = await caretAtStart(textarea);
  await textarea.evaluate((el) => el.setSelectionRange(5, 5));
  await textarea.press('ArrowDown');
  expect(touch).toBe(await caretAtStart(textarea));
});

test('@smoke touch caret reveal includes the top padding', async ({
  page,
}, testInfo) => {
  const textarea = await openLayoutComposer(page, testInfo.project.use.baseURL);
  await textarea.fill('a\nb\nc\nd\ne');
  await textarea.evaluate((el) => {
    el.style.height = '100px';
    el.style.fontSize = '16px';
    el.style.lineHeight = '20px';
    el.style.paddingTop = '20px';
    el.style.paddingBottom = '20px';
    el.setSelectionRange(8, 8);
    el.scrollTop = 0;
  });
  await page.locator('[data-web-shell-mobile-caret-down]').tap();
  // Reveal the 100px of text after the 20px top padding. The bottom
  // padding need not scroll into view too, so the intended target is 20.
  expect(await textarea.evaluate((el) => el.clientHeight)).toBe(100);
  expect(await textarea.evaluate((el) => el.scrollTop)).toBe(20);
});

test('@smoke touch caret drops expanded textarea mirrors on close', async ({
  page,
}, testInfo) => {
  await openLayoutComposer(page, testInfo.project.use.baseURL);
  const mirrorCount = () =>
    page.locator('[data-web-shell-caret-mirror]').count();
  await page.getByRole('button', { name: 'Expand editor', exact: true }).tap();
  const expanded = page.locator('[data-web-shell-expanded-editor] textarea');
  await expanded.fill('abc\ndef');
  await expanded.evaluate((el) => el.setSelectionRange(3, 3));
  // Expanded textarea takes precedence even while this inline control is
  // covered. Invoke its handler without faking a pointer gesture at the overlay.
  await page
    .locator('[data-web-shell-mobile-caret-down]')
    .evaluate((el: HTMLButtonElement) => el.click());
  expect(await mirrorCount()).toBe(1);
  await page.getByRole('button', { name: 'Done', exact: true }).tap();
  await expect(page.locator('[data-web-shell-expanded-editor]')).toHaveCount(0);
  expect(await mirrorCount()).toBe(0);
  await page.getByRole('button', { name: 'Expand editor', exact: true }).tap();
  await expanded.evaluate((el) => el.setSelectionRange(3, 3));
  await page
    .locator('[data-web-shell-mobile-caret-down]')
    .evaluate((el: HTMLButtonElement) => el.click());
  expect(await mirrorCount()).toBe(1);
});

test('touch caret right reveals a caret that programmatic selection alone leaves offscreen', async ({
  page,
}, testInfo) => {
  const textarea = await openLayoutComposer(page, testInfo.project.use.baseURL);
  await textarea.fill(
    Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'),
  );
  await textarea.evaluate((el) => {
    el.style.height = '100px';
    el.style.fontSize = '16px';
    el.style.lineHeight = '20px';
    el.setSelectionRange(el.value.length - 1, el.value.length - 1);
    el.scrollTop = 0;
  });
  const read = () =>
    textarea.evaluate((el) => ({
      scrollTop: el.scrollTop,
      caret: el.selectionStart,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
  expect((await read()).scrollTop).toBe(0);
  await textarea.press('ArrowRight');
  expect((await read()).scrollTop).toBeGreaterThan(0);
  await textarea.evaluate((el) => {
    el.scrollTop = 0;
    el.setSelectionRange(el.value.length - 1, el.value.length - 1);
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  expect((await read()).scrollTop).toBe(0);
  // The native setter is insufficient here: retain the bounded reveal.
  await page.locator('[data-web-shell-mobile-caret-right]').tap();
  const revealed = await read();
  expect(revealed.scrollTop).toBe(
    revealed.scrollHeight - revealed.clientHeight,
  );
});

async function openLayoutComposer(page: Page, baseURL: unknown) {
  const scenario = createWebShellDaemonScenario();
  const daemon = await installMockDaemon(page, scenario, {
    baseURL: String(baseURL),
  });
  await page.goto(
    `/e2e/composer-layout-harness.html?tags=false&sessionId=${scenario.sessionId}`,
  );
  await expect(
    page.locator('[data-web-shell-root]:not([data-web-shell-gate])'),
  ).toBeVisible();
  const connection = await daemon.sse.waitForConnection(scenario.sessionId);
  await daemon.sendEvent(
    replayCompleteEvent({
      sessionId: connection.sessionId,
      replayedCount: 0,
    }),
  );
  const textarea = page.locator(TEXTAREA);
  await expect(textarea).toBeVisible();
  await expect(page.locator('.cm-editor')).toHaveCount(0);
  return textarea;
}

async function visualStarts(
  textarea: ReturnType<Page['locator']>,
): Promise<number[]> {
  return textarea.evaluate(async (el) => {
    const entry = performance
      .getEntriesByType('resource')
      .map((item) => item.name)
      .find((name) => name.includes('/useComposerCore.ts'));
    if (!entry) throw new Error('useComposerCore module URL not found');
    const url = new URL('../utils/touchCaret.ts', entry).href;
    const { visualLineStartsAround } = await import(url);
    return visualLineStartsAround(el, el.value, 5);
  });
}
