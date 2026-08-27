/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { markdownToPlainText, stripAnsi } from './a11y-plain-text.js';

describe('stripAnsi', () => {
  it('removes SGR color and attribute sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b[1;33mbold yellow\x1b[0m')).toBe('bold yellow');
    expect(stripAnsi('\x1b[38:5:208mext\x1b[0m')).toBe('ext');
  });

  it('removes cursor movement and erase sequences', () => {
    expect(stripAnsi('\x1b[2K\x1b[1Atext\x1b[2J')).toBe('text');
    expect(stripAnsi('\x1b[?25lhidden cursor\x1b[?25h')).toBe('hidden cursor');
  });

  it('removes OSC sequences with BEL or ST terminators', () => {
    expect(stripAnsi('\x1b]8;;https://example.com\x07link\x1b]8;;\x07')).toBe(
      'link',
    );
    expect(stripAnsi('\x1b]0;window title\x1b\\body')).toBe('body');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
    expect(stripAnsi('')).toBe('');
  });
});

describe('markdownToPlainText', () => {
  it('strips heading markers', () => {
    expect(markdownToPlainText('# Title')).toBe('Title');
    expect(markdownToPlainText('### Deep heading')).toBe('Deep heading');
  });

  it('strips emphasis and inline code markers', () => {
    expect(markdownToPlainText('**bold** and *em* and _u_')).toBe(
      'bold and em and u',
    );
    expect(markdownToPlainText('run `npm test` now')).toBe('run npm test now');
    expect(markdownToPlainText('__strong__ ~~gone~~')).toBe('strong gone');
  });

  it('reduces links and images to their text', () => {
    expect(markdownToPlainText('see [docs](https://x.dev) now')).toBe(
      'see docs now',
    );
    expect(markdownToPlainText('logo ![alt text](img.png) end')).toBe(
      'logo alt text end',
    );
  });

  it('keeps fenced code bodies, dropping the fences', () => {
    const md = ['```ts', 'const a = 1;', '```'].join('\n');
    expect(markdownToPlainText(md)).toBe('const a = 1;');
  });

  it('drops blockquote prefixes and horizontal rules', () => {
    expect(markdownToPlainText('> quoted line')).toBe('quoted line');
    expect(markdownToPlainText('a\n---\nb')).toBe('a\n\nb');
  });

  it('keeps bullet markers and plain lines', () => {
    expect(markdownToPlainText('- first\n- second')).toBe('- first\n- second');
    expect(markdownToPlainText('just text')).toBe('just text');
  });

  it('leaves dunders and snake_case identifiers untouched', () => {
    expect(markdownToPlainText('def __init__(self):')).toBe(
      'def __init__(self):',
    );
    expect(markdownToPlainText('use snake_case_name here')).toBe(
      'use snake_case_name here',
    );
    // Boundary-guarded underscore emphasis still works.
    expect(markdownToPlainText('really _important_ now')).toBe(
      'really important now',
    );
  });

  it('keeps fence-like lines inside a block opened by the other character (R1-47/48)', () => {
    // CommonMark: a fence only closes on the same character.
    expect(markdownToPlainText('~~~\n```\nbody\n~~~\nafter')).toBe(
      '```\nbody\nafter',
    );
    expect(markdownToPlainText('```\n~~~\nbody\n```\nafter')).toBe(
      '~~~\nbody\nafter',
    );
  });

  it('recognizes headings inside blockquotes (R1-1)', () => {
    expect(markdownToPlainText('> # Title')).toBe('Title');
  });

  it('keeps code-span contents literal — no link/emphasis consumption (R1-1)', () => {
    expect(markdownToPlainText('`[a](b)`')).toBe('[a](b)');
    expect(markdownToPlainText('`**not bold**`')).toBe('**not bold**');
  });
});
