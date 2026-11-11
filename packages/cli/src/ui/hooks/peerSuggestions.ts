/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Peer-session rows for the `@` completion.
 *
 * See docs/designs/2026-08-17-at-mention-peer-sessions.md §6.5.
 */

import {
  escapePeerLabel,
  humanizeAge,
  mentionableLabelFor,
  unescapePath,
  type PeerEntry,
} from '@qwen-code/core';
import type { Suggestion } from '../components/SuggestionsDisplay.js';

/**
 * Most peer rows offered at once.
 *
 * Well under the 8 rows the suggestion list shows, because `@file` is the
 * dominant use of this completion and a peer block tall enough to fill the
 * window would bury it.
 */
export const MAX_PEER_SUGGESTIONS = 5;

/**
 * Whether a row answers to this partial.
 *
 * Two prefix tests, neither redundant. The whole-key test carries a spaced
 * label — the key starts with the label, so `fix lo` finds `Fix build bug`,
 * which no single segment could. The segment test carries the handle fallback —
 * for a session titled `fix <Button> render` the key reads
 * `-46 fix <button> render`, so `fix` finds it even though the key starts with
 * `-46`.
 *
 * Deliberately not the fuzzy match the neighbouring sources use: peer rows
 * compete for a hard cap of five, and a relevance-ranked slice whose contents
 * shift with the pattern is not worth the ranking here.
 */
function matchesPartial(searchKey: string, partial: string): boolean {
  if (searchKey.startsWith(partial)) return true;
  return searchKey.split(' ').some((segment) => segment.startsWith(partial));
}

/**
 * Rows for the live peers whose label answers to `partial`.
 *
 * An empty partial yields nothing: the bare `@` keeps showing files and agents
 * exactly as it does today, and never pays for a peer listing.
 */
export function peerSuggestionRows(
  peers: readonly PeerEntry[],
  partial: string,
  now: number = Date.now(),
): Suggestion[] {
  if (partial === '') return [];

  // The pattern arrives lowercased and still backslash-escaped, because the
  // token scanner cuts at the next *unescaped* space. Nothing case-sensitive
  // may be derived from it — every string on the row comes from the roster.
  const needle = unescapePath(partial).toLowerCase();
  if (needle === '') return [];

  const rows: Suggestion[] = [];
  for (const peer of peers) {
    if (rows.length >= MAX_PEER_SUGGESTIONS) break;

    // undefined means no form of this peer's name is both safe to render and
    // provably resolvable — omit it rather than offer a label that fails.
    const label = mentionableLabelFor(peers, peer);
    if (label === undefined) continue;

    // Matched on more than it inserts, so a peer whose title was rejected is
    // still findable by typing that title even though the row inserts `-46`.
    const searchKey = [label, peer.displayName, peer.baseName]
      .join(' ')
      .toLowerCase();
    if (!matchesPartial(searchKey, needle)) continue;

    const facts = [
      'session',
      // Only when the label is not already the title, so an ordinary row does
      // not say the same thing twice. Display-only: the title never reaches
      // `value`, and never reaches the model.
      ...(peer.displayName === label ? [] : [peer.displayName]),
      peer.session.status ?? 'unknown',
      `started ${humanizeAge(peer.session.startedAt, now)}`,
    ];

    rows.push({
      // Displayed with the `@` the user already typed, so a session row reads
      // as a mention rather than as a bare word sitting among file paths.
      // Display only: `value` is what gets inserted, and it replaces the text
      // *after* the `@`, so carrying the sigil here cannot double it.
      label: `@${label}`,
      value: escapePeerLabel(label),
      description: facts.join(' · '),
    });
  }
  return rows;
}
