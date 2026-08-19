/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mdField } from './md-field.js';

describe('mdField — a PR-controlled value, made inert', () => {
  it('holds a value inside one code span', () => {
    expect(mdField('src/a.ts')).toBe('`src/a.ts`');
  });

  it('strips what would break the span or forge a line', () => {
    expect(mdField('x`\n@acme/security approve')).toBe(
      '`x @acme/security approve`',
    );
    expect(mdField('a\r\nb')).toBe('`a b`');
  });

  it('never emits a bare backtick run for a value that strips to nothing', () => {
    // Git permits a filename that is nothing but backticks. Stripped, it
    // leaves the empty string — and `` `` + `` `` `` is not two empty spans
    // but ONE span whose content is everything the renderer wrote between
    // them, so a planted filename re-renders the bot's own prose as code.
    const emptied = mdField('`');
    expect(emptied).toBe('`(unnamed)`');
    expect(emptied).not.toBe('``');

    // The shape the pairing needs: two such values in one paragraph.
    const paragraph = `same files: ${mdField('`')} (round 2); ${mdField('``')} (round 3)`;
    expect(paragraph.match(/`/g)).toHaveLength(4);
    expect(paragraph).not.toContain('`` ');
  });

  it('renders a non-string the same way, never as an unquoted splice', () => {
    expect(mdField(undefined)).toBe('`undefined`');
    expect(mdField(7)).toBe('`7`');
  });
});
