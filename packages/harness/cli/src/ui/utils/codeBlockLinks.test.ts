/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { findCodeBlockLinks } from './codeBlockLinks.js';

describe('findCodeBlockLinks', () => {
  it.each([
    ['https://example.com/path', ['https://example.com/path']],
    [
      '"https://example.com/a?x=1&y=%2F#part",',
      ['https://example.com/a?x=1&y=%2F#part'],
    ],
    ["fetch('https://example.com/a');", ['https://example.com/a']],
    [
      "['https://example.com/a','http://example.com/b']",
      ['https://example.com/a', 'http://example.com/b'],
    ],
    ['(https://example.com/a(b))', ['https://example.com/a(b)']],
    ['{(https://example.com/a)}', ['https://example.com/a']],
    ['[https://[::1]:8080/a]', ['https://[::1]:8080/a']],
    ['https://example.com/a!;,.?x=1#f', ['https://example.com/a!;,.?x=1#f']],
    ["https://example.com/O'Reilly", ["https://example.com/O'Reilly"]],
    ['HTTP://example.com/%E4%B8%AD', ['HTTP://example.com/%E4%B8%AD']],
    [
      '中😀 https://example.com/中 http://127.0.0.1:18749/a',
      ['https://example.com/中', 'http://127.0.0.1:18749/a'],
    ],
  ])('finds exact original targets in %s', (line, expected) => {
    const links = findCodeBlockLinks(line);
    expect(links.map((link) => link.href)).toEqual(expected);
    for (const link of links) {
      expect(line.slice(link.start, link.end)).toBe(link.href);
    }
  });

  it.each(
    ["'", '"', '`'].flatMap((quote) =>
      [')', ']', '}'].map((close) => ({ quote, close })),
    ),
  )(
    'preserves a trailing $close inside $quote delimiters',
    ({ quote, close }) => {
      const href = `https://example.com/search?q=${close}`;
      const line = `fetch(${quote}${href}${quote});`;
      const start = line.indexOf(href);
      expect(findCodeBlockLinks(line)).toEqual([
        { start, end: start + href.length, href },
      ]);
    },
  );

  it.each([
    'javascript:alert(1)',
    'file:///tmp/a',
    'mailto:someone@example.com',
    'ftp://example.com/a',
    'prefixhttps://example.com/a',
    'https://',
    'https:///example.com/a',
    'https://example.com:99999/a',
    'https://[broken/a',
    'https://example.com/%zz',
    'https://example.com/a\\b',
    'https://example.com/a\u0007b',
    'https://example.com/a\u001b]8;;evil',
    'https://example.com/a\u009cb',
    'https://example.com/a\u0000b',
  ])('does not annotate unsafe or invalid input %s', (line) => {
    expect(findCodeBlockLinks(line)).toEqual([]);
  });
});
