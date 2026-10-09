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
import { regionListWindow } from './dialogs-core.js';
import { clampDialogHeight } from '../utils/layoutUtils.js';

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

  it('keeps the ink diff sample with the hunk-header counts corrected', () => {
    expect(THEME_PREVIEW_DIFF).toBe(
      [
        '--- a/util.py',
        '+++ b/util.py',
        '@@ -1,1 +1,1 @@',
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
  it('keeps padding when the region pays for it', () => {
    const layout = computeThemePreviewLayout(40);
    expect(layout.includePadding).toBe(true);
    expect(layout.codeBlockHeight).toBeGreaterThan(0);
    expect(layout.diffHeight).toBeGreaterThan(0);
  });

  it('drops padding when the region cannot pay for it', () => {
    const layout = computeThemePreviewLayout(14);
    expect(layout.includePadding).toBe(false);
    expect(layout.showPreview).toBe(true);
  });

  it('splits the remaining space 60/40 between code and diff', () => {
    const layout = computeThemePreviewLayout(60);
    expect(layout.codeBlockHeight).toBeGreaterThanOrEqual(layout.diffHeight);
  });

  it('pins the 60/40 split to the exact pair, not just the inequality', () => {
    // Region 40 leaves the columns 34 rows; the pane chrome pays five and
    // the padding two, so the panes split 27 rows as ceil(27 * 0.6) = 17
    // code and the remaining 10 diff. A `>=` pin alone cannot tell the diff
    // pane shrinking to zero from the intended ratio.
    const layout = computeThemePreviewLayout(40);
    expect(layout.includePadding).toBe(true);
    expect(layout.codeBlockHeight).toBe(17);
    expect(layout.diffHeight).toBe(10);
  });

  it('stops painting the pane when even its one-row-per-pane minimum does not fit', () => {
    // Region 12 leaves the columns 6 rows; the pane chrome pays 5, so one
    // row is left — less than the code+diff minimum of two.
    const layout = computeThemePreviewLayout(12);
    expect(layout.showPreview).toBe(false);
  });

  it('keeps the frame no taller than the region at every budget', () => {
    // The windowed left column plus the preview column share the frame: the
    // frame (4) and the footer hint (2) come off the region, and whichever
    // column is taller must fit what is left. With 16 theme items (15
    // built-in + Auto) this is red at every region of 18 rows or fewer when
    // the pane sizes from the unwindowed item count instead of the region.
    const ITEM_COUNT = 16;
    for (let height = 10; height <= 24; height++) {
      const region = clampDialogHeight(height)!;
      const window = regionListWindow(
        region,
        // The frame (4), the title row and its margin (2) and the footer
        // hint (2) — both runs fit their one row at any width this pure
        // arithmetic walk uses.
        { fixed: 8 },
        ITEM_COUNT,
        THEME_DIALOG_MAX_ITEMS_TO_SHOW,
      );
      const leftRows =
        2 + window.maxItemsToShow + (window.showScrollArrows ? 2 : 0);
      const layout = computeThemePreviewLayout(region);
      const previewRows = layout.showPreview
        ? 5 +
          (layout.includePadding ? 2 : 0) +
          layout.codeBlockHeight +
          layout.diffHeight
        : 0;
      expect(6 + Math.max(leftRows, previewRows)).toBeLessThanOrEqual(region);
    }
  });
});
