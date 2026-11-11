/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  extractWords,
  MAX_SPELLCHECK_TEXT_LENGTH,
  resetSpellcheckWordWarningsForTesting,
} from './spellcheckWords.js';

/** Just the words, for assertions about what survives the filters. */
function wordsIn(text: string): string[] {
  return extractWords(text).map((word) => word.word);
}

describe('extractWords', () => {
  beforeEach(() => {
    resetSpellcheckWordWarningsForTesting();
  });

  it('takes prose words with their offsets', () => {
    expect(extractWords('hello there')).toEqual([
      { word: 'hello', start: 0, end: 5 },
      { word: 'there', start: 6, end: 11 },
    ]);
  });

  it('keeps an apostrophe inside a word', () => {
    expect(wordsIn("don't stop")).toEqual(["don't", 'stop']);
    expect(wordsIn('it’s fine')).toEqual(['it’s', 'fine']);
  });

  it('skips words inside inline code and fences', () => {
    expect(wordsIn('run `mispeled` now')).toEqual(['run', 'now']);
    expect(wordsIn('up ```\nmispeled code\n``` down')).toEqual(['up', 'down']);
  });

  it('skips words that are too short or too long', () => {
    expect(wordsIn('a be')).toEqual(['be']);
    expect(wordsIn(`x${'a'.repeat(70)} ok`)).toEqual(['ok']);
  });

  it('skips anything with an interior capital', () => {
    // CamelCase, acronyms and API names are not dictionary words.
    expect(wordsIn('the getUserName helper')).toEqual(['the', 'helper']);
    expect(wordsIn('an HTTP request')).toEqual(['an', 'request']);
    // A leading capital is just a sentence starting.
    expect(wordsIn('Hello there')).toEqual(['Hello', 'there']);
  });

  it('skips words in scripts a Latin dictionary cannot judge', () => {
    expect(wordsIn('这是 中文 text')).toEqual(['text']);
    expect(wordsIn('こんにちは world')).toEqual(['world']);
  });

  it('skips the whole chunk when it looks like code', () => {
    expect(wordsIn('see src/some/path.ts here')).toEqual(['see', 'here']);
    expect(wordsIn('visit https://example.com/page now')).toEqual([
      'visit',
      'now',
    ]);
    expect(wordsIn('mail someone@example.com today')).toEqual([
      'mail',
      'today',
    ]);
    expect(wordsIn('pass --some-flag along')).toEqual(['pass', 'along']);
    expect(wordsIn('call fn(arg) later')).toEqual(['call', 'later']);
    expect(wordsIn('the value2 thing')).toEqual(['the', 'thing']);
    expect(wordsIn('tag <div> here')).toEqual(['tag', 'here']);
  });

  it('skips the bracketed parts of a placeholder', () => {
    // A placeholder is rendered as its own highlight token, so the renderer
    // never underlines inside one whatever comes back from here. What this
    // rule buys is not asking about the brackets in the first place; an
    // ordinary word between them ("Text") is checked like any other prose.
    expect(wordsIn('before [Pasted Text: 6 lines] after')).toEqual([
      'before',
      'Text',
      'after',
    ]);
    expect(wordsIn('before [Image shot.png] after')).toEqual([
      'before',
      'after',
    ]);
  });

  it('keeps prose punctuation from disqualifying a chunk', () => {
    expect(wordsIn('hello, world.')).toEqual(['hello', 'world']);
    expect(wordsIn('"quoted" and (parenthetical)')).toEqual([
      'quoted',
      'and',
      'parenthetical',
    ]);
  });

  it('reports code-point offsets, not UTF-16 indices', () => {
    // The emoji is one code point but two UTF-16 units; a raw regex index
    // would put the underline one column to the left.
    const [word] = extractWords('🙂 helo');
    expect(word).toEqual({ word: 'helo', start: 2, end: 6 });
  });

  it('gives up on input too large to be worth checking', () => {
    const long = 'word '.repeat(MAX_SPELLCHECK_TEXT_LENGTH / 2);
    expect(long.length).toBeGreaterThan(MAX_SPELLCHECK_TEXT_LENGTH);
    expect(extractWords(long)).toEqual([]);
  });

  it('handles an empty buffer', () => {
    expect(extractWords('')).toEqual([]);
  });
});
