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
import stripAnsi from 'strip-ansi';
import { fallbackWrapAnsi, wrapAnsi } from './wrapAnsi.js';
import { stringWidth } from './stringWidth.js';

const SESSION_URL =
  'https://example.com/agents/session/qs_01kz87vg4wzd4878em4hhzm3x3';
const BANNER_LINE = `    Scan the QR or visit: ${SESSION_URL}`;

describe('wrapAnsi', () => {
  it('falls back to a local implementation when the npm package is not callable', () => {
    const options = { hard: true, trim: false } as const;

    expect(() => wrapAnsi('hello world', 5, options)).not.toThrow();
    // The resolved implementation may be the host's, npm wrap-ansi, or the
    // local fallback; they differ on where a lone break-point space lands, so
    // only assert that no visible character is lost.
    expect(wrapAnsi('hello world', 5, options).replace(/[\n ]/g, '')).toBe(
      'helloworld',
    );
    expect(fallbackWrapAnsi('hello world', 5, options)).toBe('hello\nworld');
  });

  it('preserves ansi styles across wrapped lines', () => {
    expect(
      fallbackWrapAnsi('\u001b[31mhello world\u001b[39m', 5, {
        hard: true,
        trim: false,
      }),
    ).toBe('\u001b[31mhello\n\u001b[31mworld\u001b[39m');
  });

  it('keeps the break-point space when trimming is disabled', () => {
    // Regression: swallowing this space made the wrapped text one character
    // shorter than the input, which shifted per-segment styles and OSC 8
    // hyperlinks one column on the continuation line — a soft-wrapped session
    // URL was rendered (and made clickable) as `ttps://…`.
    const wrapped = fallbackWrapAnsi(BANNER_LINE, 87, {
      hard: true,
      trim: false,
    });

    expect(wrapped.split('\n')).toEqual([
      '    Scan the QR or visit: ',
      SESSION_URL,
    ]);
    expect(stripAnsi(wrapped).replace(/\n/g, '')).toBe(BANNER_LINE);
  });

  it('matches the npm implementation for a soft-wrapped inline link', () => {
    const options = { hard: true, trim: false } as const;

    expect(fallbackWrapAnsi(BANNER_LINE, 87, options)).toBe(
      wrapAnsi(BANNER_LINE, 87, options),
    );
  });

  it('still drops the break-point space when trimming is enabled', () => {
    expect(
      fallbackWrapAnsi(BANNER_LINE, 87, { hard: true, trim: true }).split('\n'),
    ).toEqual([`Scan the QR or visit: ${SESSION_URL}`]);
  });

  it('preserves whitespace-only lines when trimming is enabled', () => {
    expect(
      fallbackWrapAnsi('first\n   \nlast', 5, {
        hard: true,
        trim: true,
      }),
    ).toBe('first\n\nlast');
  });

  it('does not let a lone surrogate hide a following ANSI sequence', () => {
    const input = '\ud800\u001b[31mred\u001b[39m';
    const wrapped = fallbackWrapAnsi(input, 3, {
      hard: true,
      trim: false,
    });

    expect(wrapped).toBe(input);
  });

  it('does not split a grapheme cluster across wrapped lines', () => {
    const family = '👨‍👩‍👧‍👦';

    expect(
      fallbackWrapAnsi(`a${family}b`, 2, {
        hard: true,
        trim: false,
      }).split('\n'),
    ).toEqual(['a', family, 'b']);
  });

  it('wraps a giant single-line Unicode payload within the linear-path performance budget', () => {
    // Regression: resuming a session whose first user message is a ~400 KB
    // single-line JSON payload starved the event loop for minutes because
    // every output line re-measured the whole remaining string (O(n²)).
    const giant = JSON.stringify({
      codesec_review: 'x'.repeat(409_000),
      note: '日本語のテキストと家族の絵文字 👨‍👩‍👧‍👦 も含まれる',
    });
    const startedAt = Date.now();
    const wrapped = fallbackWrapAnsi(giant, 118, {
      hard: true,
      trim: false,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(stripAnsi(wrapped).replace(/\n/g, '')).toBe(giant);
    // The quadratic implementation took ~80s at this size; a generous bound
    // keeps the test stable on slow CI while still catching regressions.
    expect(elapsedMs).toBeLessThan(2_000);
    for (const line of wrapped.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(118);
    }
  });

  it('does not drop wide characters when hard-wrapping CJK text without spaces', () => {
    const cjk = '日本語のテキストはとても長いですここで折り返しが発生します';
    const wrapped = fallbackWrapAnsi(cjk, 10, { hard: true, trim: false });

    expect(stripAnsi(wrapped).replace(/\n/g, '')).toBe(cjk);
    for (const line of wrapped.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(10);
    }
  });
});
