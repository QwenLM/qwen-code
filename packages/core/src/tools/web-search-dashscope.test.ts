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
    const { titles } = attachSideModelTitles(
      [
        'Answer.',
        '**Sources:**',
        '* Example A page: https://example.com/a',
        '1. Example B page - <https://example.com/b>',
        '+ Example C page — https://example.com/c',
        '– Example D page — https://example.com/d',
        '— Example E page — https://example.com/e',
      ].join('\n'),
      [
        { url: 'https://example.com/a' },
        { url: 'https://example.com/b' },
        { url: 'https://example.com/c' },
        { url: 'https://example.com/d' },
        { url: 'https://example.com/e' },
      ],
      [],
    );

    expect(titles.get('example.com/a')).toBe('Example A page');
    expect(titles.get('example.com/b')).toBe('Example B page');
    expect(titles.get('example.com/c')).toBe('Example C page');
    expect(titles.get('example.com/d')).toBe('Example D page');
    expect(titles.get('example.com/e')).toBe('Example E page');
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

  it('does not read a narration line that merely begins with "Sources:" as a header', () => {
    const { answerText, titles } = attach(
      [
        'Sources: the agency publishes two of them.',
        '- Example A page — https://example.com/a',
        '',
        'Sources:',
        '- Example B page — https://example.com/b',
      ].join('\n'),
    );

    expect(titles.get('example.com/a')).toBeUndefined();
    expect(titles.get('example.com/b')).toBe('Example B page');
    expect(answerText).toBe(
      'Sources: the agency publishes two of them.\n- Example A page — https://example.com/a',
    );
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

  it('keeps narration that merely ends in a URL out of the block', () => {
    const { answerText, titles } = attach(
      [
        'Sources:',
        '- Example A page — https://example.com/a',
        '',
        'The fix landed in https://example.com/b.',
      ].join('\n'),
    );

    expect(answerText).toBe('The fix landed in https://example.com/b.');
    expect(titles.get('example.com/a')).toBe('Example A page');
    expect(titles.get('example.com/b')).toBeUndefined();
  });

  it('drops the whole block when a non-entry bullet sits among its entries', () => {
    const { answerText, titles } = attach(
      [
        'The answer is 42.',
        'Sources:',
        '- Example A page — https://example.com/a',
        '- (see also the archive)',
        '- Example B page — https://example.com/b',
      ].join('\n'),
    );

    expect(answerText).toBe('The answer is 42.');
    expect(titles.get('example.com/a')).toBe('Example A page');
    expect(titles.get('example.com/b')).toBe('Example B page');
  });

  it('leaves an over-long line in a matched block unparsed and in place', () => {
    const longLine = `- ${'T'.repeat(2_000)} — https://example.com/b`;
    const { answerText, titles } = attach(
      ['Sources:', '- Example A page — https://example.com/a', longLine].join(
        '\n',
      ),
    );

    expect(titles.get('example.com/a')).toBe('Example A page');
    expect(titles.get('example.com/b')).toBeUndefined();
    expect(answerText).toBe(longLine);
  });

  it('strips URLs smuggled into a relayed title', () => {
    const { titles } = attach(
      [
        'Answer.',
        'Sources:',
        '- Example — https://attacker.example/x — https://example.com/a',
        '- [Docs https://attacker.example/y](https://example.com/b)',
      ].join('\n'),
    );

    expect(titles.get('example.com/a')).toBeDefined();
    expect(titles.get('example.com/a')).not.toContain('https://');
    expect(titles.get('example.com/b')).toBeDefined();
    expect(titles.get('example.com/b')).not.toContain('https://');
  });

  it('reads markdown entries whose URLs contain parentheses', () => {
    const wiki = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    const msdn = 'https://msdn.example.com/en-us/lib_(x)';
    const { answerText, titles } = attachSideModelTitles(
      [
        'Answer.',
        'Sources:',
        `- [Foo (bar) - Wikipedia](${wiki})`,
        `- [Lib](<${msdn}>)`,
      ].join('\n'),
      [{ url: wiki }, { url: msdn }],
      [],
    );

    expect(titles.get('en.wikipedia.org/wiki/Foo_(bar)')).toBe(
      'Foo (bar) - Wikipedia',
    );
    expect(titles.get('msdn.example.com/en-us/lib_(x)')).toBe('Lib');
    expect(answerText).toBe('Answer.');
  });

  it('accepts a title for an opened URL the search did not list', () => {
    const { answerText, titles } = attachSideModelTitles(
      [
        'Answer.',
        'Sources:',
        '- Opened Only page — https://example.com/opened-only',
      ].join('\n'),
      [{ url: 'https://example.com/a' }],
      ['https://example.com/opened-only'],
    );

    expect(titles.get('example.com/opened-only')).toBe('Opened Only page');
    expect(answerText).toBe('Answer.');
  });
});
