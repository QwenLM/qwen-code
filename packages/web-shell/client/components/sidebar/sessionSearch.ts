/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

// Sidebar search matches git context beyond the label: PR number and the
// numbers of the issues a bound PR closes (with or without '#'), branch name,
// and worktree slug. `query` must already be lowercased.
export function sessionMatchesGitQuery(
  session: DaemonSessionSummary,
  query: string,
): boolean {
  const matchesNumber = (number: number): boolean =>
    query === String(number) || query === `#${number}`;
  for (const pr of session.prs ?? []) {
    if (matchesNumber(pr.number)) return true;
    if ((pr.issues ?? []).some((issue) => matchesNumber(issue.number))) {
      return true;
    }
  }
  const candidates = [
    session.branch?.name,
    session.worktree?.branch,
    session.worktree?.slug,
  ];
  return candidates.some(
    (candidate) =>
      candidate !== undefined && candidate.toLowerCase().includes(query),
  );
}

/**
 * The sidebar's session-source scope: the "channel" tab lists only
 * channel-source sessions, the "default" tab lists unattributed (legacy)
 * and default-source ones, and no filter lists everything.
 */
export function sessionMatchesSource(
  session: DaemonSessionSummary,
  source: string | undefined,
): boolean {
  if (source === 'channel') return session.sourceType === 'channel';
  if (source === 'default') {
    return session.sourceType === undefined || session.sourceType === 'default';
  }
  return true;
}

/**
 * Merges daemon transcript-content search hits into the local title/id/git
 * matches, in place of the previously duplicated inline merges in
 * WebShellSidebar and WorkspaceSection. Local matches come first (catalog
 * order), then content hits in server (recency) order. Hits the loaded
 * catalog carries keep their catalog entry — it holds the live state the
 * persisted-only search summary lacks; `seen` dedupes sessions matched by
 * both paths; uncatalogued ("ghost") hits are dropped when they fall
 * outside the `source` scope, and pass through `mapSession` (the
 * optimistic-pin overlay) like every other rendered session.
 */
export function mergeSessionContentHits(
  scopedSessions: readonly DaemonSessionSummary[],
  localMatches: readonly DaemonSessionSummary[],
  hits: ReadonlyMap<string, { session: DaemonSessionSummary; snippet: string }>,
  source: string | undefined,
  mapSession?: (session: DaemonSessionSummary) => DaemonSessionSummary,
): DaemonSessionSummary[] {
  if (hits.size === 0) return [...localMatches];
  const catalogById = new Map(
    scopedSessions.map((session) => [session.sessionId, session]),
  );
  const seen = new Set(localMatches.map((session) => session.sessionId));
  const merged = [...localMatches];
  for (const [sessionId, hit] of hits) {
    if (seen.has(sessionId)) continue;
    const catalogEntry = catalogById.get(sessionId);
    if (!catalogEntry && !sessionMatchesSource(hit.session, source)) continue;
    merged.push(catalogEntry ?? mapSession?.(hit.session) ?? hit.session);
  }
  return merged;
}
