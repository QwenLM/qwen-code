/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  safeLiteralReplace,
  normalizeContent,
  stripAnsiAndControl,
} from './textUtils.js';

describe('safeLiteralReplace', () => {
  it('returns original string when oldString empty or not found', () => {
    expect(safeLiteralReplace('abc', '', 'X')).toBe('abc');
    expect(safeLiteralReplace('abc', 'z', 'X')).toBe('abc');
  });

  it('fast path when newString has no $', () => {
    expect(safeLiteralReplace('abc', 'b', 'X')).toBe('aXc');
  });

  it('treats $ literally', () => {
    expect(safeLiteralReplace('foo', 'foo', "bar$'baz")).toBe("bar$'baz");
  });

  it("does not interpret replacement patterns like $&, $', $` and $1", () => {
    expect(safeLiteralReplace('hello', 'hello', '$&-replacement')).toBe(
      '$&-replacement',
    );
    expect(safeLiteralReplace('mid', 'mid', 'new$`content')).toBe(
      'new$`content',
    );
    expect(safeLiteralReplace('test', 'test', '$1$2value')).toBe('$1$2value');
  });

  it('preserves end-of-line $ in regex-like text', () => {
    const current = "| select('match', '^[sv]d[a-z]$')";
    const oldStr = "'^[sv]d[a-z]$'";
    const newStr = "'^[sv]d[a-z]$' # updated";
    const expected = "| select('match', '^[sv]d[a-z]$' # updated)";
    expect(safeLiteralReplace(current, oldStr, newStr)).toBe(expected);
  });

  it('handles multiple $ characters', () => {
    expect(safeLiteralReplace('x', 'x', '$$$')).toBe('$$$');
  });

  it('preserves pre-escaped $$ literally', () => {
    expect(safeLiteralReplace('x', 'x', '$$value')).toBe('$$value');
  });

  it('handles complex malicious patterns from PR #7871', () => {
    const original = 'The price is PRICE.';
    const result = safeLiteralReplace(
      original,
      'PRICE',
      "$& Wow, that's a lot! $'",
    );
    expect(result).toBe("The price is $& Wow, that's a lot! $'.");
  });

  it('handles multiple replacements correctly', () => {
    const text = 'Replace FOO and FOO again';
    const result = safeLiteralReplace(text, 'FOO', '$100');
    expect(result).toBe('Replace $100 and $100 again');
  });

  it('preserves $ at different positions', () => {
    expect(safeLiteralReplace('test', 'test', '$')).toBe('$');
    expect(safeLiteralReplace('test', 'test', 'prefix$')).toBe('prefix$');
    expect(safeLiteralReplace('test', 'test', '$suffix')).toBe('$suffix');
  });

  it('handles edge case with $$$$', () => {
    expect(safeLiteralReplace('x', 'x', '$$$$')).toBe('$$$$');
  });

  it('handles newString with only dollar signs', () => {
    expect(safeLiteralReplace('abc', 'b', '$$')).toBe('a$$c');
  });
});

describe('normalizeContent', () => {
  it('strips UTF-8 BOM from the beginning of the string', () => {
    const contentWithBOM = '\uFEFFHello World';
    expect(normalizeContent(contentWithBOM)).toBe('Hello World');
  });

  it('preserves BOM-like characters not at the beginning', () => {
    const content = 'Hello\uFEFFWorld';
    expect(normalizeContent(content)).toBe('Hello\uFEFFWorld');
  });

  it('converts CRLF to LF', () => {
    const content = 'Line 1\r\nLine 2';
    expect(normalizeContent(content)).toBe('Line 1\nLine 2');
  });

  it('converts standalone CR to LF', () => {
    const content = 'Line 1\rLine 2';
    expect(normalizeContent(content)).toBe('Line 1\nLine 2');
  });

  it('leaves existing LF unchanged', () => {
    const content = 'Line 1\nLine 2';
    expect(normalizeContent(content)).toBe('Line 1\nLine 2');
  });

  it('handles mixed line endings correctly', () => {
    const content = 'Line 1\r\nLine 2\rLine 3\nLine 4';
    expect(normalizeContent(content)).toBe('Line 1\nLine 2\nLine 3\nLine 4');
  });

  it('handles empty strings', () => {
    expect(normalizeContent('')).toBe('');
  });

  it('handles strings without newlines or BOM', () => {
    expect(normalizeContent('Just a single line')).toBe('Just a single line');
  });
});

describe('stripAnsiAndControl', () => {
  const ESC = '\x1b';

  it('leaves ordinary text untouched', () => {
    expect(stripAnsiAndControl('hello world 123')).toBe('hello world 123');
  });

  it('strips ANSI/VT escape sequences (e.g. clear-screen, color)', () => {
    expect(stripAnsiAndControl(`${ESC}[2Jevil`)).toBe('evil');
    expect(stripAnsiAndControl(`${ESC}[31mred${ESC}[0m`)).toBe('red');
  });

  it('strips OSC 8 hyperlink sequences but keeps the link text', () => {
    const osc = `${ESC}]8;;http://attacker\u0007click${ESC}]8;;\u0007`;
    expect(stripAnsiAndControl(osc)).toBe('click');
  });

  it('removes residual C0 control chars and DEL', () => {
    // NUL, BEL and DEL between letters are dropped (no escape prefix).
    expect(stripAnsiAndControl('a\u0000b\u0007c\u007fd')).toBe('abcd');
  });

  it('removes C1 control chars (the range a drifted local copy missed)', () => {
    expect(stripAnsiAndControl('x\u0080y\u0081z')).toBe('xyz');
  });
});
