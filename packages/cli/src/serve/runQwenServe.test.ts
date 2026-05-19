/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { extractContextFilename } from './runQwenServe.js';

/**
 * #4297 fold-in 7 (deepseek S1, addresses #3262690842). Lock the
 * `context.fileName` extraction logic so a regression doesn't
 * silently re-enable the P2-1 bug (init writes default `QWEN.md`
 * even when the workspace configured `AGENTS.md` etc.). The four
 * branches the suggestion called out are exercised explicitly here;
 * the runQwenServe boot path itself stays integration-tested
 * end-to-end via the daemon-process tests in
 * `integration-tests/cli/qwen-serve-routes.test.ts`.
 */
describe('extractContextFilename (#4297 fold-in 7 P2-1 helper)', () => {
  it('returns a trimmed string when given a non-empty string', () => {
    expect(extractContextFilename('AGENTS.md')).toBe('AGENTS.md');
    expect(extractContextFilename('  CUSTOM.md  ')).toBe('CUSTOM.md');
  });

  it('returns undefined for empty / whitespace-only strings', () => {
    expect(extractContextFilename('')).toBeUndefined();
    expect(extractContextFilename('   ')).toBeUndefined();
    expect(extractContextFilename('\n\t')).toBeUndefined();
  });

  it('returns the first non-empty string when given an array', () => {
    expect(extractContextFilename(['AGENTS.md', 'BACKUP.md'])).toBe(
      'AGENTS.md',
    );
    // Skips empty and whitespace entries to find the first valid name.
    expect(extractContextFilename(['', '  ', 'PRIMARY.md', 'OTHER.md'])).toBe(
      'PRIMARY.md',
    );
    // Trims the picked element.
    expect(extractContextFilename(['  CUSTOM.md  '])).toBe('CUSTOM.md');
  });

  it('returns undefined when the array has no string entries', () => {
    expect(extractContextFilename([])).toBeUndefined();
    expect(extractContextFilename(['', '  ', '\n'])).toBeUndefined();
    // Non-string entries are filtered out — when nothing valid remains,
    // the bridge falls back to its own default.
    expect(
      extractContextFilename([null, undefined, 42, { a: 1 }] as unknown[]),
    ).toBeUndefined();
  });

  it('returns undefined for non-string non-array inputs', () => {
    // Hand-edited `settings.json` could land any of these shapes;
    // the helper must NOT coerce (avoids the literal `[object Object]`
    // filename that the previous `String(...)` cast produced).
    expect(extractContextFilename(undefined)).toBeUndefined();
    expect(extractContextFilename(null)).toBeUndefined();
    expect(extractContextFilename(42)).toBeUndefined();
    expect(extractContextFilename(true)).toBeUndefined();
    expect(extractContextFilename({ fileName: 'AGENTS.md' })).toBeUndefined();
  });
});
