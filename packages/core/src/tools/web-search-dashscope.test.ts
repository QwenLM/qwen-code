/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { sourceKey } from './web-search-backend.js';
import { readSideModelTitles } from './web-search-dashscope.js';

const known = (...urls: string[]) => new Set(urls.map(sourceKey));
const titleOf = (titles: Map<string, string>, url: string) =>
  titles.get(sourceKey(url));

describe('sourceKey', () => {
  it('treats scheme, host case, trailing slashes and fragments as the same page', () => {
    const key = sourceKey('https://example.com/docs/page');
    expect(sourceKey('http://EXAMPLE.com/docs/page/')).toBe(key);
    expect(sourceKey('https://example.com/docs/page#section')).toBe(key);
  });

  it('keeps the query string and the port significant', () => {
    expect(sourceKey('https://example.com/p?id=1')).not.toBe(
      sourceKey('https://example.com/p?id=2'),
    );
    expect(sourceKey('https://example.com:8443/p')).not.toBe(
      sourceKey('https://example.com/p'),
    );
  });

  it('matches literal and percent-encoded parentheses in the path', () => {
    expect(sourceKey('https://en.wikipedia.org/wiki/Foo_%28bar%29')).toBe(
      sourceKey('https://en.wikipedia.org/wiki/Foo_(bar)'),
    );
  });

  it('keeps an undecodable path as written instead of throwing', () => {
    expect(sourceKey('https://example.com/%E0%A4%A')).toBe(
      'example.com/%E0%A4%A',
    );
  });

  it('falls back to the trimmed, lower-cased text for an unparseable URL', () => {
    expect(sourceKey('  Not A URL ')).toBe('not a url');
  });
});

describe('readSideModelTitles', () => {
  it('reads "title — url" entries under a leading Sources header', () => {
    const narration = [
      'Sources:',
      '- Node.js Releases — https://nodejs.org/en/about/previous-releases',
      '- Node.js | endoflife.date — https://endoflife.date/nodejs',
      '',
      'Node.js 24 is the Active LTS line.',
    ].join('\n');
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

  it('accepts markdown, numbered and unbulleted entries', () => {
    const narration = [
      '**Sources:**',
      '1. [Page A](https://a.example/one)',
      '2) Page B: https://b.example/two',
      'Page C | https://c.example/three',
      '- [Page D](<https://d.example/four>) — read in full',
    ].join('\n');
    const titles = readSideModelTitles(
      narration,
      known(
        'https://a.example/one',
        'https://b.example/two',
        'https://c.example/three',
        'https://d.example/four',
      ),
    );
    expect(titleOf(titles, 'https://a.example/one')).toBe('Page A');
    expect(titleOf(titles, 'https://b.example/two')).toBe('Page B');
    expect(titleOf(titles, 'https://c.example/three')).toBe('Page C');
    expect(titleOf(titles, 'https://d.example/four')).toBe('Page D');
  });

  it('does not end a list at an entry that carries no title', () => {
    const narration = [
      'Sources:',
      '- https://a.example/one',
      '- Page B — https://b.example/two',
    ].join('\n');
    const titles = readSideModelTitles(
      narration,
      known('https://a.example/one', 'https://b.example/two'),
    );
    expect(titleOf(titles, 'https://a.example/one')).toBeUndefined();
    expect(titleOf(titles, 'https://b.example/two')).toBe('Page B');
  });

  it('drops entries whose URL the search never returned', () => {
    const narration = [
      'Sources:',
      '- Fabricated — https://evil.example/x',
      '- Page A — https://a.example/one',
    ].join('\n');
    const titles = readSideModelTitles(
      narration,
      known('https://a.example/one'),
    );
    expect(titles.size).toBe(1);
    expect(titleOf(titles, 'https://a.example/one')).toBe('Page A');
  });

  it('ends a list at the first line that is not an entry', () => {
    const narration = [
      'Sources:',
      '- Page A — https://a.example/one',
      'Node 24 is the LTS line, see https://b.example/two',
      '- Page C — https://c.example/three',
    ].join('\n');
    const titles = readSideModelTitles(
      narration,
      known(
        'https://a.example/one',
        'https://b.example/two',
        'https://c.example/three',
      ),
    );
    expect([...titles.values()]).toEqual(['Page A']);
  });

  it('ignores lists inside code fences and a Sources mention mid-sentence', () => {
    const narration = [
      '```',
      'Sources:',
      '- Fenced — https://a.example/one',
      '```',
      'See the Sources: list — https://a.example/one',
    ].join('\n');
    expect(
      readSideModelTitles(narration, known('https://a.example/one')).size,
    ).toBe(0);
  });

  it('reads a leading and a trailing list together', () => {
    const narration = [
      'Sources:',
      '- Page A — https://a.example/one',
      '',
      'The answer.',
      '',
      '## Sources',
      '- Page B — https://b.example/two',
    ].join('\n');
    const titles = readSideModelTitles(
      narration,
      known('https://a.example/one', 'https://b.example/two'),
    );
    expect(titleOf(titles, 'https://a.example/one')).toBe('Page A');
    expect(titleOf(titles, 'https://b.example/two')).toBe('Page B');
  });

  it('keeps the first title for a page listed twice under different spellings', () => {
    const narration = [
      'Sources:',
      '- First — https://a.example/one',
      '- Second — https://A.example/one/',
    ].join('\n');
    const titles = readSideModelTitles(
      narration,
      known('https://a.example/one'),
    );
    expect(titleOf(titles, 'https://a.example/one')).toBe('First');
  });

  it('cleans emphasis, quotes and separator residue, and bounds the length', () => {
    const narration = [
      'Sources:',
      '- **Bold Title** — https://a.example/one',
      '- "Quoted Title" — https://b.example/two',
      '- Dangling — — https://c.example/three',
      `- ${'x'.repeat(300)} — https://d.example/four`,
      '- ** — https://e.example/five',
    ].join('\n');
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

  it('keeps a URL with balanced parentheses and trims a closer it never opened', () => {
    const narration = [
      'Sources:',
      '- Foo — https://en.wikipedia.org/wiki/Foo_(bar)',
      '- (Bar page — https://b.example/two)',
    ].join('\n');
    const titles = readSideModelTitles(
      narration,
      known('https://en.wikipedia.org/wiki/Foo_(bar)', 'https://b.example/two'),
    );
    expect(titleOf(titles, 'https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(
      'Foo',
    );
    expect(titleOf(titles, 'https://b.example/two')).toBe('(Bar page');
  });

  it('stays fast on adversarial lines shaped to make the patterns backtrack', () => {
    const url = 'https://a.example/one';
    // Each hazard sits where the parser would otherwise run a pattern on it:
    // a header candidate, then an entry candidate directly under a header.
    const narration = [
      `${'Sources'.padEnd(40_000, ' ')}:x`,
      'Sources:',
      `- ${'https://'.repeat(20_000)}`,
      'Sources:',
      `- ${' -'.repeat(20_000)}x — ${url}`,
      'Sources:',
      `- https://${'.'.repeat(40_000)}x`,
    ].join('\n');
    const startedAt = Date.now();
    const titles = readSideModelTitles(narration, known(url));
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
