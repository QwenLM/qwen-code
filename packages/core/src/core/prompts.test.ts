/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { formatCompactSummary, parseCompactSummary } from './prompts.js';

describe('formatCompactSummary', () => {
  // Expected outputs follow the compact formatter, including its
  // permissive handling of incomplete markup and first-match regex behavior.
  it.each([
    ['plain text', '  Useful summary  ', 'Useful summary'],
    [
      'missing closing tag',
      '<summary>Useful summary',
      '<summary>Useful summary',
    ],
    [
      'missing opening tag',
      'Useful summary</summary>',
      'Useful summary</summary>',
    ],
    [
      'analysis then text',
      '<analysis>draft</analysis>\nUseful summary',
      'Useful summary',
    ],
    [
      'multiple analysis blocks',
      '<analysis>first</analysis><analysis>second</analysis>Body',
      '<analysis>second</analysis>Body',
    ],
    [
      'complete summary',
      '<analysis>draft</analysis>\n<summary> Body </summary>',
      'Summary:\nBody',
    ],
    [
      'uppercase tags',
      '<ANALYSIS>draft</ANALYSIS><SUMMARY>Body</SUMMARY>',
      '<ANALYSIS>draft</ANALYSIS><SUMMARY>Body</SUMMARY>',
    ],
    ['incomplete uppercase tags', '<SUMMARY>Body', '<SUMMARY>Body'],
    ['blank lines', 'First\n\n\n\nSecond', 'First\n\nSecond'],
    [
      'outside text',
      'Before\n<summary>Body</summary>\nAfter',
      'Before\nSummary:\nBody\nAfter',
    ],
    ['empty paired summary', '<summary></summary>', 'Summary:'],
    ['whitespace summary', '<summary> \n </summary>', 'Summary:'],
    ['empty tags then text', '<summary></summary>Body', 'Summary:\nBody'],
    ['analysis only', '<analysis>draft</analysis>', ''],
    ['empty analysis', '<analysis></analysis>', ''],
    [
      'unclosed analysis',
      '<analysis>unfinished draft',
      '<analysis>unfinished draft',
    ],
    [
      'unclosed analysis then summary',
      '<analysis>draft\n<summary>Body</summary>',
      '<analysis>draft\nSummary:\nBody',
    ],
    [
      'analysis containing summary',
      '<analysis><summary>draft</summary></analysis>',
      '',
    ],
    [
      'analysis then empty summary',
      '<analysis>draft</analysis><summary></summary>',
      'Summary:',
    ],
    ['opening tag only', '<summary>', '<summary>'],
    ['closing tag only', '</summary>', '</summary>'],
    [
      'only first summary formatted',
      '<summary>One</summary><summary>Two</summary>',
      'Summary:\nOne<summary>Two</summary>',
    ],
    [
      'paired literal after draft',
      '<analysis>draft</analysis><summary>Keep `<analysis>example</analysis>`.</summary>',
      'Summary:\nKeep `<analysis>example</analysis>`.',
    ],
    [
      'paired literal without draft',
      '<summary>Keep `<analysis>example</analysis>`.</summary>',
      'Summary:\nKeep ``.',
    ],
    [
      'later closing analysis',
      '<analysis>draft\n<summary>Before </analysis> after</summary>',
      'after</summary>',
    ],
  ])('formats %s', (_name, raw, expected) => {
    expect(formatCompactSummary(raw)).toBe(expected);
  });

  it('preserves literal opening tags and the summary tail from the truncation incident', () => {
    const body =
      '当前消息要求仅输出 `<analysis>` 与 `<summary>` 文本，不调用任何工具。\nPending: 修复 A';
    expect(
      formatCompactSummary(
        `<analysis>draft</analysis>\n<summary>${body}</summary>`,
      ),
    ).toBe(`Summary:\n${body}`);
  });

  it.each(['', ' \n\t '])('rejects blank raw text: %j', (raw) => {
    expect(formatCompactSummary(raw)).toBeNull();
  });
});

describe('parseCompactSummary', () => {
  it.each([
    ['<summary>Body</summary>', 'paired'],
    ['<summary>Body', 'open_only'],
    ['Body</summary>', 'close_only'],
    ['Body', 'plain'],
    ['<summary></summary>', 'paired'],
    ['<analysis>draft</analysis>', 'plain'],
    ['<analysis>unfinished draft', 'plain'],
    ['<SUMMARY>Body</SUMMARY>', 'plain'],
    ['', 'empty'],
  ] as const)('classifies %s as %s without enforcing tags', (raw, mode) => {
    expect(parseCompactSummary(raw).mode).toBe(mode);
  });

  it('accepts nonempty raw text even when formatting removes all text', () => {
    expect(parseCompactSummary('<analysis>draft</analysis>')).toEqual({
      summary: '',
      mode: 'plain',
    });
  });
});
