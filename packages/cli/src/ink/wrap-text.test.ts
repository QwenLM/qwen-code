/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

import { describe, expect, it } from 'vitest';
import wrapText from './wrap-text.js';
import { stringWidth } from './stringWidth.js';

describe('wrapText truncation', () => {
  it.each([
    'truncate-end',
    'truncate-start',
    'truncate-middle',
  ] as const)('respects terminal columns for CJK with %s', (mode) => {
    const result = wrapText('你好，terminal world', 10, mode);

    expect(stringWidth(result)).toBeLessThanOrEqual(10);
    expect(result).toContain('…');
  });

  it('keeps the ellipsis inside the requested width for long mixed text', () => {
    const text =
      '执行 MCP elicitation idle timeout CLI 验收。必须严格按顺序完成以下步骤：'.repeat(
        3,
      );
    const result = wrapText(text, 154, 'truncate-end');

    expect(stringWidth(result)).toBe(154);
    expect(result.endsWith('…')).toBe(true);
  });

  it('respects terminal columns for ANSI-styled CJK text', () => {
    const result = wrapText(
      '\x1b[31m你好，terminal world\x1b[0m',
      10,
      'truncate-end',
    );

    expect(stringWidth(result)).toBeLessThanOrEqual(10);
    expect(result).toContain('…');
  });

  it('truncates a long ANSI-styled line without losing its active style', () => {
    const result = wrapText(
      `\x1b[31m${'x'.repeat(32 * 1024)}\x1b[0m`,
      80,
      'truncate-end',
    );

    expect(result).toBe(`\x1b[31m${'x'.repeat(79)}…`);
    expect(stringWidth(result)).toBe(80);
  });
});
