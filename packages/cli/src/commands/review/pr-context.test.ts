/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { collectSuggestionSummaries } from './pr-context.js';
import { SUMMARY_MARKER } from './post-suggestions.js';

// Guards the security-sensitive selection of "our own" suggestion-summary
// comments. This is what decides which issue comment is promoted into the
// trusted "Previous suggestion summary" section (and excluded from the
// "Already discussed" list), so the author check and latest-wins ordering
// must not regress.
describe('collectSuggestionSummaries', () => {
  const withMarker = (extra = '') => `${SUMMARY_MARKER}\n${extra}`;

  it('matches only comments authored by me that carry the marker', () => {
    const comments = [
      { id: 1, user: { login: 'me' }, body: withMarker('mine') },
      { id: 2, user: { login: 'me' }, body: 'no marker here' },
      { id: 3, user: { login: 'someone-else' }, body: withMarker('theirs') },
    ];
    const result = collectSuggestionSummaries(comments, 'me');
    expect(result.map((c) => c.id)).toEqual([1]);
  });

  it('rejects a third-party comment that embeds the marker (prompt injection)', () => {
    const comments = [
      { id: 10, user: { login: 'attacker' }, body: withMarker('malicious') },
    ];
    expect(collectSuggestionSummaries(comments, 'me')).toEqual([]);
  });

  it('is case-insensitive on the author login', () => {
    const comments = [{ id: 5, user: { login: 'Me' }, body: withMarker() }];
    expect(collectSuggestionSummaries(comments, 'mE').map((c) => c.id)).toEqual(
      [5],
    );
  });

  it('returns all of my summaries, newest (highest id) first', () => {
    const comments = [
      { id: 7, user: { login: 'me' }, body: withMarker('old') },
      { id: 21, user: { login: 'me' }, body: withMarker('new') },
      { id: 14, user: { login: 'me' }, body: withMarker('mid') },
      { id: 8, user: { login: 'other' }, body: withMarker('theirs') },
    ];
    // All three of mine are returned so the caller can exclude every stale
    // summary from the "Already discussed" list, not just the latest.
    expect(collectSuggestionSummaries(comments, 'me').map((c) => c.id)).toEqual(
      [21, 14, 7],
    );
  });

  it('tolerates comments missing user/body', () => {
    const comments = [
      { id: 1 },
      { id: 2, user: { login: 'me' } },
      { id: 3, body: withMarker() },
    ];
    expect(collectSuggestionSummaries(comments, 'me')).toEqual([]);
  });
});
