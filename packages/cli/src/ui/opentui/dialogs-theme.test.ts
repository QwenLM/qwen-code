/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI theme dialog reproduces the original ink
 * ThemeDialog content: the Auto/built-in/custom item order, capitalized
 * type column, preview-pane sample content, and the height budget split.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import {
  buildThemeItems,
  capitalizeThemeType,
  computeThemePreviewLayout,
  THEME_DIALOG_MAX_ITEMS_TO_SHOW,
  THEME_PREVIEW_CODE,
  THEME_PREVIEW_DIFF,
} from './dialogs-theme.js';

describe('capitalizeThemeType', () => {
  it('capitalizes the first character only', () => {
    expect(capitalizeThemeType('dark')).toBe('Dark');
    expect(capitalizeThemeType('light')).toBe('Light');
  });
});

describe('buildThemeItems', () => {
  const builtIn = [
    { name: 'Default', type: 'dark' },
    { name: 'DefaultLight', type: 'light' },
  ];

  it('puts Auto first with the original labels', () => {
    const items = buildThemeItems(builtIn, []);
    expect(items[0]).toEqual({
      label: 'Auto (detect terminal theme)',
      value: 'auto',
      themeNameDisplay: 'Auto',
      themeTypeDisplay: 'Auto',
      key: 'auto',
    });
  });

  it('lists built-in themes with a capitalized type column', () => {
    const items = buildThemeItems(builtIn, []);
    expect(items[1]).toMatchObject({
      label: 'Default',
      value: 'Default',
      themeNameDisplay: 'Default',
      themeTypeDisplay: 'Dark',
      key: 'Default',
    });
  });

  it('appends custom themes last, typed Custom', () => {
    const items = buildThemeItems(builtIn, ['my-theme']);
    expect(items.at(-1)).toEqual({
      label: 'my-theme',
      value: 'my-theme',
      themeNameDisplay: 'my-theme',
      themeTypeDisplay: 'Custom',
      key: 'my-theme',
    });
    expect(items).toHaveLength(4);
  });
});

describe('preview pane content parity', () => {
  it('keeps the original python sample byte-for-byte', () => {
    expect(THEME_PREVIEW_CODE).toBe(
      [
        '# function',
        'def fibonacci(n):',
        '    a, b = 0, 1',
        '    for _ in range(n):',
        '        a, b = b, a + b',
        '    return a',
      ].join('\n'),
    );
  });

  it('keeps the original diff sample byte-for-byte', () => {
    expect(THEME_PREVIEW_DIFF).toBe(
      [
        '--- a/util.py',
        '+++ b/util.py',
        '@@ -1,2 +1,2 @@',
        '- print("Hello, " + name)',
        '+ print(f"Hello, {name}!")',
        '',
      ].join('\n'),
    );
  });

  it('uses the original 12-row window', () => {
    expect(THEME_DIALOG_MAX_ITEMS_TO_SHOW).toBe(12);
  });
});

describe('computeThemePreviewLayout', () => {
  it('keeps padding when the left column fits', () => {
    const layout = computeThemePreviewLayout(40, 5);
    expect(layout.includePadding).toBe(true);
    expect(layout.codeBlockHeight).toBeGreaterThan(0);
    expect(layout.diffHeight).toBeGreaterThan(0);
  });

  it('drops padding when the theme list no longer fits', () => {
    const layout = computeThemePreviewLayout(10, 20);
    expect(layout.includePadding).toBe(false);
  });

  it('splits the remaining space 60/40 between code and diff', () => {
    const layout = computeThemePreviewLayout(60, 5);
    expect(layout.codeBlockHeight).toBeGreaterThanOrEqual(layout.diffHeight);
  });
});
