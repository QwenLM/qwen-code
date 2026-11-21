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
    const scenario = createWebShellDaemonScenario();
    const daemon = await installMockDaemon(page, scenario, {
      baseURL: String(testInfo.project.use.baseURL),
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
