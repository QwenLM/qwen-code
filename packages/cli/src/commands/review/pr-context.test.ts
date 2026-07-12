/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  isLegacySuggestionSummary,
  SUMMARY_MARKER,
  truncatedHeadings,
  buildMarkdown,
  fullBody,
  type PrMetadata,
  type RawComment,
} from './pr-context.js';

// Guards the recognition of legacy suggestion-summary comments. This is what
// decides which issue comment is excluded from the "Already discussed" list.
// A summary that slips through is rendered as settled discussion and tells
// the review agents not to re-report the findings it lists — so recognition
// must not regress, whoever authored the summary.
describe('isLegacySuggestionSummary', () => {
  const withMarker = (extra = '') => `${SUMMARY_MARKER}\n${extra}`;

  it('matches a summary regardless of who posted it', () => {
    // `/review` ran under whichever identity invoked it: a maintainer
    // locally, or the CI bot in the review workflow. Both left summaries
    // behind, and both must be excluded no matter who runs the next review.
    expect(isLegacySuggestionSummary(withMarker('by a maintainer'))).toBe(true);
    expect(isLegacySuggestionSummary(withMarker('by the CI bot'))).toBe(true);
  });

  it('does not match an ordinary comment', () => {
    expect(isLegacySuggestionSummary('no marker here')).toBe(false);
    expect(
      isLegacySuggestionSummary('mentions qwen-review-suggestion-summary'),
    ).toBe(false);
  });

  it('matches wherever the marker sits in the body', () => {
    expect(isLegacySuggestionSummary(`preamble\n${SUMMARY_MARKER}`)).toBe(true);
  });

  it('tolerates a missing body', () => {
    expect(isLegacySuggestionSummary(undefined)).toBe(false);
    expect(isLegacySuggestionSummary('')).toBe(false);
  });
});

describe('truncatedHeadings', () => {
  it('names the headings that begin past the limit', () => {
    const md = ['## A', 'x'.repeat(50), '## B', 'y'.repeat(10), '## C'].join(
      '\n',
    );
    const bOffset = md.indexOf('## B');
    const got = truncatedHeadings(md, bOffset);
    expect(got.map((h) => h.heading)).toEqual(['## B', '## C']);
    expect(got[0].offset).toBe(bOffset);
  });

  it('returns nothing when the whole document fits', () => {
    expect(truncatedHeadings('## A\nbody\n## B\n', 10_000)).toEqual([]);
  });

  it('scans ### as well as ##, and ignores # and ####', () => {
    const md = '# T\n## A\n### B\n#### C\n';
    expect(truncatedHeadings(md, 0).map((h) => h.heading)).toEqual([
      '## A',
      '### B',
    ]);
  });

  it('ignores a hash that is not at the start of a line', () => {
    expect(truncatedHeadings('text ## not a heading\n', 0)).toEqual([]);
  });
});

describe('buildMarkdown section order', () => {
  const meta = {
    title: 't',
    body: '',
    author: { login: 'a' },
    baseRefName: 'main',
    headRefName: 'f',
    headRefOid: 'abc',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    state: 'OPEN',
  } as PrMetadata;

  // One thread with a reply (already discussed) and one without (still open).
  const root: RawComment = {
    id: 1,
    user: { login: 'r' },
    body: 'settled',
    path: 'a.ts',
    line: 1,
  };
  const reply: RawComment = {
    id: 2,
    user: { login: 'a' },
    body: 'fixed',
    in_reply_to_id: 1,
  };
  const open: RawComment = {
    id: 3,
    user: { login: 'r' },
    body: 'still live',
    path: 'b.ts',
    line: 2,
  };

  it('puts the open comments before the already-discussed ones', () => {
    const md = buildMarkdown('1', 'o/r', meta, [root, reply, open], [], []);
    const openAt = md.indexOf('## Open inline comments');
    const discussedAt = md.indexOf('## Already discussed');
    expect(openAt).toBeGreaterThan(-1);
    expect(discussedAt).toBeGreaterThan(-1);
    // The section a review must answer is written first, so a truncated read
    // keeps it. PR 5738 lost it at char 27125 of a 31220-char file.
    expect(openAt).toBeLessThan(discussedAt);
  });

  it('still renders both sections in full', () => {
    const md = buildMarkdown('1', 'o/r', meta, [root, reply, open], [], []);
    expect(md).toContain('still live');
    expect(md).toContain('settled');
    expect(md).toContain('fixed');
  });

  it('omits the open section when every thread has a reply', () => {
    const md = buildMarkdown('1', 'o/r', meta, [root, reply], [], []);
    expect(md).not.toContain('## Open inline comments');
    expect(md).toContain('## Already discussed');
  });
});

describe('fullBody', () => {
  it('returns short bodies untouched', () => {
    expect(fullBody('a Critical here', 7)).toBe('a Critical here');
  });

  it('caps long bodies and names the review id for the tail', () => {
    const long = 'x'.repeat(9000);
    const got = fullBody(long, 42);
    expect(got).toContain('truncated at 8000 chars');
    expect(got).toContain('/reviews/42');
    expect(got).toContain('cannot tell');
  });
});

describe('buildMarkdown — review bodies and replied Criticals', () => {
  const meta = {
    title: 'T',
    body: 'D',
    author: { login: 'a' },
    baseRefName: 'main',
    headRefName: 'b',
    headRefOid: 'sha',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    state: 'OPEN',
  };

  it('renders review bodies in full, not 240-char snippets (a body-only blocker lives only here)', () => {
    const longBody = `**[Critical]** ${'y'.repeat(500)} the tail survives`;
    const md = buildMarkdown(
      '1',
      'o/r',
      meta,
      [],
      [],
      [
        {
          id: 7,
          user: { login: 'rev' },
          state: 'CHANGES_REQUESTED',
          body: longBody,
        },
      ],
    );
    expect(md).toContain('the tail survives');
    expect(md).toContain('(review 7)');
    expect(md).not.toContain('…');
  });

  it('pulls a replied Critical root out of Already discussed into the mandatory re-check section', () => {
    const inline = [
      {
        id: 1,
        user: { login: 'rev' },
        path: 'a.ts',
        line: 3,
        body: '**[Critical]** real blocker',
      },
      {
        id: 2,
        user: { login: 'author' },
        in_reply_to_id: 1,
        body: 'I disagree',
      },
      {
        id: 3,
        user: { login: 'rev' },
        path: 'b.ts',
        line: 9,
        body: '**[Suggestion]** nit',
      },
      { id: 4, user: { login: 'author' }, in_reply_to_id: 3, body: 'done' },
    ];
    const md = buildMarkdown('1', 'o/r', meta, inline, [], []);
    const critSection = md.indexOf('## Replied Criticals');
    const discussed = md.indexOf('## Already discussed');
    expect(critSection).toBeGreaterThan(-1);
    expect(critSection).toBeLessThan(discussed);
    // The Critical thread lives in the re-check section, not the settled one.
    const critIdx = md.indexOf('real blocker');
    expect(critIdx).toBeGreaterThan(critSection);
    expect(critIdx).toBeLessThan(discussed);
    // The Suggestion thread stays settled.
    expect(md.indexOf('**[Suggestion]** nit')).toBeGreaterThan(discussed);
    expect(md).toContain('a reply alone does NOT retire a blocker');
  });
});
