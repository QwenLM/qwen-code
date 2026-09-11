/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { sourceKey } from './web-search-backend.js';
import { readSideModelTitles } from './web-search-dashscope.js';

const known = (...urls: string[]) => new Set(urls.map(sourceKey));
/** Titles for URLs without a fragment are keyed by page identity alone. */
const titleOf = (titles: Map<string, string>, url: string) =>
  titles.get(sourceKey(url));
const reply = (...lines: string[]) => lines.join('\n');

describe('sourceKey', () => {
  it('treats scheme, host case, trailing slashes and fragments as the same page', () => {
    const key = sourceKey('https://example.com/docs/page');
    expect(sourceKey('http://EXAMPLE.com/docs/page/')).toBe(key);
    expect(sourceKey('https://example.com/docs/page#section')).toBe(key);
  });

  it('keeps the query string and a non-default port significant', () => {
    expect(sourceKey('https://example.com/p?id=1')).not.toBe(
      sourceKey('https://example.com/p?id=2'),
    );
    expect(sourceKey('https://example.com:8443/p')).not.toBe(
      sourceKey('https://example.com/p'),
    );
    expect(sourceKey('http://example.com:80/p')).toBe(
      sourceKey('http://example.com/p'),
    );
  });

  it('matches literal and percent-encoded parentheses in the path', () => {
    expect(sourceKey('https://en.wikipedia.org/wiki/Foo_%28bar%29')).toBe(
      sourceKey('https://en.wikipedia.org/wiki/Foo_(bar)'),
    );
  });

  it('keeps an encoded path delimiter distinct from the delimiter itself', () => {
    expect(sourceKey('https://ex.com/a%3Fb=c')).not.toBe(
      sourceKey('https://ex.com/a?b=c'),
    );
    expect(sourceKey('https://example.com/docs%2F')).not.toBe(
      sourceKey('https://example.com/docs/'),
    );
    expect(sourceKey('https://example.com/AC%2FDC')).not.toBe(
      sourceKey('https://example.com/AC/DC'),
    );
  });

  it('keeps an undecodable path as written instead of throwing', () => {
    expect(sourceKey('https://example.com/%E0%A4%A')).toBe(
      'example.com/%E0%A4%A',
    );
  });

  it('keeps other schemes and unparseable text apart from http(s) pages', () => {
    expect(sourceKey('ftp://example.com/a')).not.toBe(
      sourceKey('https://example.com/a'),
    );
    expect(sourceKey('ftp://example.com/a')).not.toBe(
      sourceKey('example.com/a'),
    );
    expect(sourceKey('  Not A URL ')).toBe('raw:not a url');
  });
});

describe('readSideModelTitles', () => {
  it('reads "- title — url" entries from the list that opens the reply', () => {
    const narration = reply(
      'Sources:',
      '- Node.js Releases — https://nodejs.org/en/about/previous-releases',
      '- Node.js | endoflife.date — https://endoflife.date/nodejs',
      '',
      'Node.js 24 is the Active LTS line.',
    );
    const titles = readSideModelTitles(
      narration,
      known(
        'https://nodejs.org/en/about/previous-releases',
        'https://endoflife.date/nodejs',
      ),
    );
    expect(
      titleOf(titles, 'https://nodejs.org/en/about/previous-releases'),
    ).toBe('Node.js Releases');
    expect(titleOf(titles, 'https://endoflife.date/nodejs')).toBe(
      'Node.js | endoflife.date',
    );
  });

  it('accepts markdown links, numbered markers, URL-first entries and other separators', () => {
    const narration = reply(
      '**Sources:**',
      '1. [Page A](https://a.example/one)',
      '2) Page B: https://b.example/two',
      '- https://c.example/three — Page C',
      '- Page D · https://d.example/four',
      '- Page E • https://e.example/five',
      '- [Page F](<https://f.example/six>) — read in full',
    );
    const urls = [
      'https://a.example/one',
      'https://b.example/two',
      'https://c.example/three',
      'https://d.example/four',
      'https://e.example/five',
      'https://f.example/six',
    ];
    const titles = readSideModelTitles(narration, known(...urls));
    expect(urls.map((url) => titleOf(titles, url))).toEqual([
      'Page A',
      'Page B',
      'Page C',
      'Page D',
      'Page E',
      'Page F',
    ]);
  });

  it('reads the title around a wrapped URL without bracket debris', () => {
    const narration = reply(
      'Sources:',
      '- Qwen docs (https://a.example/one)',
      '- <Angle Title> — <https://b.example/two>',
      '- Alpha — [https://c.example/three]',
      '- [See [1]](https://d.example/four)',
      '- (Bar page — https://e.example/five)',
      '- Foo — https://en.wikipedia.org/wiki/Foo_(bar)',
    );
    const urls = [
      'https://a.example/one',
      'https://b.example/two',
      'https://c.example/three',
      'https://d.example/four',
      'https://e.example/five',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ];
    const titles = readSideModelTitles(narration, known(...urls));
    expect(urls.map((url) => titleOf(titles, url))).toEqual([
      'Qwen docs',
      'Angle Title',
      'Alpha',
      'See [1]',
      'Bar page',
      'Foo',
    ]);
  });

  it('does not end the list at an entry that carries no title', () => {
    const narration = reply(
      'Sources:',
      '- https://a.example/one',
      '- Page B — https://b.example/two',
    );
    const titles = readSideModelTitles(
      narration,
      known('https://a.example/one', 'https://b.example/two'),
    );
    expect(titleOf(titles, 'https://a.example/one')).toBeUndefined();
    expect(titleOf(titles, 'https://b.example/two')).toBe('Page B');
  });

  it('drops entries whose URL the search never returned', () => {
    const narration = reply(
      'Sources:',
      '- Fabricated — https://evil.example/x',
      '- Page A — https://a.example/one',
    );
    const titles = readSideModelTitles(
      narration,
      known('https://a.example/one'),
    );
    expect([...titles.values()]).toEqual(['Page A']);
  });

  it('reads only a list that opens the reply', () => {
    const url = 'https://a.example/one';
    const read = (narration: string) =>
      readSideModelTitles(narration, known(url)).size;
    expect(
      read(reply('Here are my sources.', 'Sources:', `- A — ${url}`)),
    ).toBe(0);
    expect(read(reply('The answer.', '', '## Sources', `- A — ${url}`))).toBe(
      0,
    );
    expect(read(reply('```', 'Sources:', `- Fenced — ${url}`, '```'))).toBe(0);
    expect(
      read(reply('```', '~~~', 'Sources:', `- Fake — ${url}`, '```')),
    ).toBe(0);
    expect(read(reply('', '  ', 'Sources:', `- A — ${url}`))).toBe(1);
  });

  it('ends the list at a blank line or a line that is not an entry, so the answer is never read', () => {
    const a = 'https://a.example/one';
    const b = 'https://b.example/two';
    const read = (narration: string) => [
      ...readSideModelTitles(narration, known(a, b)).values(),
    ];
    expect(
      read(
        reply(
          'Sources:',
          `- Page A — ${a}`,
          '',
          `Qwen Code 1.2 adds a --json flag. Details in the release notes: ${b}`,
        ),
      ),
    ).toEqual(['Page A']);
    expect(
      read(
        reply(
          'Sources:',
          `- Page A — ${a}`,
          `Details in the release notes: ${b}`,
        ),
      ),
    ).toEqual(['Page A']);
    expect(
      read(
        reply(
          'Sources:',
          `- Page A — ${a}`,
          '',
          `- Every flag is listed in the CLI reference: ${b}`,
        ),
      ),
    ).toEqual(['Page A']);
    expect(
      read(
        reply(
          'Sources:',
          `- Page A — ${a}`,
          `- https://other.example/x — ${b}`,
          `- Page B — ${b}`,
        ),
      ),
    ).toEqual(['Page A']);
  });

  it('allows blank lines between the header and the first entry', () => {
    const titles = readSideModelTitles(
      reply('Sources:', '', '- Page A — https://a.example/one'),
      known('https://a.example/one'),
    );
    expect(titleOf(titles, 'https://a.example/one')).toBe('Page A');
  });

  it('keeps the first title for a URL listed twice under different spellings', () => {
    const titles = readSideModelTitles(
      reply(
        'Sources:',
        '- First — https://a.example/one',
        '- Second — https://A.example/one/',
      ),
      known('https://a.example/one'),
    );
    expect(titleOf(titles, 'https://a.example/one')).toBe('First');
  });

  it('cleans emphasis, quotes and separator residue, and bounds the length', () => {
    const narration = reply(
      'Sources:',
      '- **Bold Title** — https://a.example/one',
      '- "Quoted Title" — https://b.example/two',
      '- Dangling — — https://c.example/three',
      `- ${'x'.repeat(300)} — https://d.example/four`,
      '- ** — https://e.example/five',
    );
    const titles = readSideModelTitles(
      narration,
      known(
        'https://a.example/one',
        'https://b.example/two',
        'https://c.example/three',
        'https://d.example/four',
        'https://e.example/five',
      ),
    );
    expect(titleOf(titles, 'https://a.example/one')).toBe('Bold Title');
    expect(titleOf(titles, 'https://b.example/two')).toBe('Quoted Title');
    expect(titleOf(titles, 'https://c.example/three')).toBe('Dangling');
    expect(titleOf(titles, 'https://d.example/four')).toHaveLength(200);
    expect(titleOf(titles, 'https://e.example/five')).toBeUndefined();
  });

  it('never cuts a title between the halves of a surrogate pair', () => {
    const url = 'https://a.example/one';
    const titles = readSideModelTitles(
      reply('Sources:', `- ${'x'.repeat(199)}😀tail — ${url}`),
      known(url),
    );
    const title = titleOf(titles, url) ?? '';
    expect(title).toHaveLength(199);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title)).toBe(false);
  });

  it('reads a long list of admitted entries in linear time', () => {
    // Every line is inside the length gates and is a real entry, in the two
    // shapes that made the earlier parser quadratic per line: a long run of
    // separators inside a title, and a long run of closers after a URL.
    const urls = Array.from(
      { length: 1_000 },
      (_, i) => `https://a.example/page/${i}`,
    );
    const lines = urls.map((url, i) =>
      i % 2 === 0
        ? `- Start ${' -'.repeat(900)} end — ${url}`
        : `- Title ${i} — ${url}${')'.repeat(1_880)}`,
    );
    const startedAt = Date.now();
    const titles = readSideModelTitles(
      reply('Sources:', ...lines),
      known(...urls),
    );
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(titles.size).toBe(1_000);
  });

  it('rejects an over-long header candidate before matching it', () => {
    const url = 'https://a.example/one';
    const startedAt = Date.now();
    const titles = readSideModelTitles(
      reply(`${'Sources'.padEnd(40_000, ' ')}:x`, `- A — ${url}`),
      known(url),
    );
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(titles.size).toBe(0);
  });

  it('returns nothing for an empty narration or when no URL is known', () => {
    expect(readSideModelTitles('', known('https://a.example/one')).size).toBe(
      0,
    );
    expect(
      readSideModelTitles('Sources:\n- A — https://a.example/one', new Set())
        .size,
    ).toBe(0);
  });
});
