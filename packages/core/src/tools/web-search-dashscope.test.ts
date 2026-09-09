/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { attachSideModelTitles } from './web-search-dashscope.js';

const CANDIDATES = [
  { url: 'https://example.com/a' },
  { url: 'https://example.com/b' },
];
const OPENED = ['https://example.com/a'];

function attach(answerText: string) {
  return attachSideModelTitles(answerText, CANDIDATES, OPENED);
}

describe('attachSideModelTitles', () => {
  it('reads "- Title — url" lines and removes the block from the narration', () => {
    const { answerText, titles } = attach(
      [
        'The answer is 42.',
        '',
        'Sources:',
        '- Example A page — https://example.com/a',
        '- Example B page — https://example.com/b',
      ].join('\n'),
    );

    expect(titles.get('example.com/a')).toBe('Example A page');
    expect(titles.get('example.com/b')).toBe('Example B page');
    expect(answerText).toBe('The answer is 42.');
  });

  it('reads markdown link entries', () => {
    const { answerText, titles } = attach(
      ['Answer.', 'Sources:', '- [Example A page](https://example.com/a)'].join(
        '\n',
      ),
    );

    expect(titles.get('example.com/a')).toBe('Example A page');
    expect(answerText).toBe('Answer.');
  });

  it('accepts the separators and bullets models actually emit', () => {
    const { titles } = attach(
      [
        'Answer.',
        '**Sources:**',
        '* Example A page: https://example.com/a',
        '1. Example B page - <https://example.com/b>',
      ].join('\n'),
    );

    expect(titles.get('example.com/a')).toBe('Example A page');
    expect(titles.get('example.com/b')).toBe('Example B page');
  });

  it('matches URLs the model retyped with a different slash, scheme, case or fragment', () => {
    const { titles } = attach(
      [
        'Answer.',
        'Sources:',
        '- Trailing slash — https://example.com/a/',
        '- Scheme and case — HTTP://Example.COM/b#section',
      ].join('\n'),
    );

    expect(titles.get('example.com/a')).toBe('Trailing slash');
    expect(titles.get('example.com/b')).toBe('Scheme and case');
  });

  it('drops entries whose URL the search never returned', () => {
    const { answerText, titles } = attach(
      [
        'Answer.',
        'Sources:',
        '- Example A page — https://example.com/a',
        '- Somewhere else — https://unrelated.example/x',
      ].join('\n'),
    );

    expect([...titles.keys()]).toEqual(['example.com/a']);
    // The block still goes, so the URL the model invented never reaches the
    // main model as a citable source.
    expect(answerText).toBe('Answer.');
  });

  it('leaves the answer untouched when no entry matches', () => {
    const original = [
      'Answer.',
      'Sources:',
      '- Somewhere else — https://unrelated.example/x',
    ].join('\n');

    const { answerText, titles } = attach(original);

    expect(titles.size).toBe(0);
    expect(answerText).toBe(original);
  });

  it('leaves the answer untouched when there is no Sources block', () => {
    const original = 'The answer is 42, per https://example.com/a.';
    const { answerText, titles } = attach(original);

    expect(titles.size).toBe(0);
    expect(answerText).toBe(original);
  });

  it('keeps prose that follows the block', () => {
    const { answerText } = attach(
      [
        'Answer.',
        'Sources:',
        '- Example A page — https://example.com/a',
        '',
        'Note: prices change daily.',
      ].join('\n'),
    );

    expect(answerText).toBe('Answer.\n\nNote: prices change daily.');
  });

  it('reads a block that leads the answer, as the instructions ask for', () => {
    const { answerText, titles } = attach(
      [
        'Sources:',
        '- Example A page — https://example.com/a',
        '',
        'The answer is 42.',
      ].join('\n'),
    );

    expect(titles.get('example.com/a')).toBe('Example A page');
    expect(answerText).toBe('The answer is 42.');
  });

  it('reads a leading and a trailing block together', () => {
    const { answerText, titles } = attach(
      [
        'Sources:',
        '- Example A page — https://example.com/a',
        '',
        'The answer is 42.',
        '',
        'Sources:',
        '- Example B page — https://example.com/b',
      ].join('\n'),
    );

    expect(titles.get('example.com/a')).toBe('Example A page');
    expect(titles.get('example.com/b')).toBe('Example B page');
    expect(answerText).toBe('The answer is 42.');
  });

  it('uses the last block when the answer quotes the word earlier', () => {
    const { answerText, titles } = attach(
      [
        'Sources: the agency publishes two of them.',
        '',
        'Sources:',
        '- Example A page — https://example.com/a',
      ].join('\n'),
    );

    expect(titles.get('example.com/a')).toBe('Example A page');
    expect(answerText).toBe('Sources: the agency publishes two of them.');
  });

  it('strips quotes and bold, and bounds an overlong title', () => {
    const long = 'T'.repeat(260);
    const { titles } = attach(
      [
        'Answer.',
        'Sources:',
        `- **"${long}"** — https://example.com/a`,
        "- 'Example B page' — https://example.com/b",
      ].join('\n'),
    );

    expect(titles.get('example.com/a')).toBe('T'.repeat(200));
    expect(titles.get('example.com/b')).toBe('Example B page');
  });

  it('ignores an entry that carries no title', () => {
    const { titles } = attach(
      ['Answer.', 'Sources:', '- https://example.com/a'].join('\n'),
    );

    expect(titles.size).toBe(0);
  });

  it('is a no-op on an empty narration', () => {
    const { answerText, titles } = attach('');
    expect(answerText).toBe('');
    expect(titles.size).toBe(0);
  });
});
