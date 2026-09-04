/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonSessionTurnIndexEntry,
  DaemonSessionTurnIndexPage,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { getDaemonErrorCode } from './session-context.js';

export type SessionTurnIndexStatus =
  | 'disabled'
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error'
  | 'unsupported';

export interface TurnIndexPageCacheEntry {
  /** The snapshot that produced this page, and the authority for reading it. */
  snapshot: string;
  turns: readonly DaemonSessionTurnIndexEntry[];
}

/**
 * A tail turn the client knows about but the durable index does not yet.
 * `live:` entries reconcile away by exact identity; `shell:` entries are
 * live-only overlays that never become durable turns.
 */
export type LiveTurnEntry =
  | { id: `live:${string}`; kind: 'prompt'; promptId: string; label: string }
  | { id: `shell:${string}`; kind: 'shell'; label: string };

export interface SessionTurnIndexState {
  sessionId: string;
  status: SessionTurnIndexStatus;
  /** Newest snapshot; the authority for seeding and older-page requests. */
  snapshot?: string;
  totalTurns: number;
  /** Cached pages keyed by their server-chosen `start`. */
  pages: ReadonlyMap<number, TurnIndexPageCacheEntry>;
  liveEntries: readonly LiveTurnEntry[];
}

/**
 * Cached-page budgets. Index previews are hard-truncated server-side, so a
 * page's cost is proportional to its entry count and stays two orders of
 * magnitude below the transcript's; these bounds exist to keep a long session
 * from accumulating unbounded metadata, not to protect against one huge page.
 */
const MAX_CACHED_PAGES = 32;
const MAX_CACHED_BYTES = 4 * 1024 * 1024;

export function createSessionTurnIndexState(
  sessionId: string,
  status: 'disabled' | 'idle',
): SessionTurnIndexState {
  return {
    sessionId,
    status,
    totalTurns: 0,
    pages: new Map(),
    liveEntries: [],
  };
}

export function withTurnIndexStatus(
  state: SessionTurnIndexState,
  status: SessionTurnIndexStatus,
): SessionTurnIndexState {
  return state.status === status ? state : { ...state, status };
}

export interface TurnIndexInterval {
  start: number;
  endInclusive: number;
}

/** Covered ordinal runs, sorted and merged. */
export function turnIndexCoverage(
  state: SessionTurnIndexState,
): TurnIndexInterval[] {
  const intervals: TurnIndexInterval[] = [];
  for (const [start, page] of state.pages) {
    if (page.turns.length === 0) continue;
    intervals.push({ start, endInclusive: start + page.turns.length - 1 });
  }
  intervals.sort((a, b) => a.start - b.start);
  const merged: TurnIndexInterval[] = [];
  for (const interval of intervals) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.endInclusive + 1) {
      last.endInclusive = Math.max(last.endInclusive, interval.endInclusive);
      continue;
    }
    merged.push({ ...interval });
  }
  return merged;
}

export function isOrdinalCovered(
  state: SessionTurnIndexState,
  ordinal: number,
): boolean {
  for (const interval of turnIndexCoverage(state)) {
    if (ordinal >= interval.start && ordinal <= interval.endInclusive) {
      return true;
    }
  }
  return false;
}

/**
 * The oldest and newest covered ordinals. The oldest is the boundary an
 * older-page request butts against; the newest is where a tail refresh has to
 * land on the grid.
 */
export function coveredOrdinalBounds(
  state: SessionTurnIndexState,
): { oldest: number; newest: number } | undefined {
  const coverage = turnIndexCoverage(state);
  const oldest = coverage[0];
  const newest = coverage[coverage.length - 1];
  if (!oldest || !newest) return undefined;
  return { oldest: oldest.start, newest: newest.endInclusive };
}

export interface TurnIndexPageRequest {
  snapshot: string;
  start: number;
  limit: number;
}

/**
 * Plans the next older-metadata page.
 *
 * Requests are issued only when the oldest covered ordinal is above zero: at
 * zero the oldest turn is retained and no older page exists, and the clamped
 * limit would compute to zero, which the daemon rejects. The limit shrinks to
 * butt exactly against the retained ordinals so pages never overlap — ordinals
 * are frozen within a snapshot, so the grid stays stable until a refresh.
 */
export function planOlderPageRequest(
  state: SessionTurnIndexState,
  limit: number,
): TurnIndexPageRequest | undefined {
  if (state.snapshot === undefined) return undefined;
  const bounds = coveredOrdinalBounds(state);
  if (!bounds || bounds.oldest <= 0) return undefined;
  const start = Math.max(0, bounds.oldest - limit);
  return { snapshot: state.snapshot, start, limit: bounds.oldest - start };
}

/**
 * Plans the page that makes `ordinal` readable, or nothing when it is already
 * covered or outside the durable range. The request is the largest slice that
 * fits inside the uncovered run containing the ordinal and still contains it.
 */
export function planEnsurePageRequest(
  state: SessionTurnIndexState,
  ordinal: number,
  limit: number,
): TurnIndexPageRequest | undefined {
  if (state.snapshot === undefined) return undefined;
  if (ordinal < 0 || ordinal >= state.totalTurns) return undefined;
  if (isOrdinalCovered(state, ordinal)) return undefined;
  let low = 0;
  let high = state.totalTurns - 1;
  for (const interval of turnIndexCoverage(state)) {
    if (interval.endInclusive < ordinal) {
      low = Math.max(low, interval.endInclusive + 1);
      continue;
    }
    if (interval.start > ordinal) {
      high = Math.min(high, interval.start - 1);
    }
    break;
  }
  if (ordinal < low || ordinal > high) return undefined;
  const start = Math.max(low, Math.min(ordinal, high - limit + 1));
  return {
    snapshot: state.snapshot,
    start,
    limit: Math.min(limit, high - start + 1),
  };
}

function estimateEntryBytes(entry: DaemonSessionTurnIndexEntry): number {
  return (
    64 +
    entry.turnId.length * 2 +
    entry.label.length * 2 +
    (entry.detail?.length ?? 0) * 2 +
    (entry.promptId?.length ?? 0) * 2
  );
}

function estimatePageBytes(page: TurnIndexPageCacheEntry): number {
  let bytes = page.snapshot.length * 2;
  for (const entry of page.turns) bytes += estimateEntryBytes(entry);
  return bytes;
}

/**
 * Drops cached pages until the map is inside its budgets.
 *
 * The newest page is pinned: every tail refresh validates itself against the
 * overlap with retained coverage, so evicting it would turn an ordinary
 * refresh into an unverifiable zero-overlap one and force a needless reset.
 * Insertion order stands in for recency until the Phase 3 rail reports which
 * pages its viewport actually reads. Evicting metadata never changes
 * `totalTurns`; an evicted range is a hole to refetch, not a shorter session.
 */
function evictCachedPages(
  pages: Map<number, TurnIndexPageCacheEntry>,
): Map<number, TurnIndexPageCacheEntry> {
  if (pages.size <= 1) return pages;
  let pinnedStart: number | undefined;
  for (const start of pages.keys()) {
    if (pinnedStart === undefined || start > pinnedStart) pinnedStart = start;
  }
  let bytes = 0;
  for (const page of pages.values()) bytes += estimatePageBytes(page);
  const drop: number[] = [];
  for (const start of pages.keys()) {
    if (
      pages.size - drop.length <= MAX_CACHED_PAGES &&
      bytes <= MAX_CACHED_BYTES
    ) {
      break;
    }
    if (start === pinnedStart) continue;
    const page = pages.get(start);
    if (!page) continue;
    drop.push(start);
    bytes -= estimatePageBytes(page);
  }
  for (const start of drop) pages.delete(start);
  return pages;
}

function withPage(
  state: SessionTurnIndexState,
  start: number,
  page: TurnIndexPageCacheEntry,
): SessionTurnIndexState {
  const pages = new Map(state.pages);
  pages.set(start, page);
  return { ...state, status: 'ready', pages: evictCachedPages(pages) };
}

/** True when `page` touches an ordinal the store already covers. */
function overlapsCoverage(
  state: SessionTurnIndexState,
  start: number,
  length: number,
): boolean {
  if (length === 0) return false;
  const endInclusive = start + length - 1;
  for (const interval of turnIndexCoverage(state)) {
    if (interval.start <= endInclusive && interval.endInclusive >= start) {
      return true;
    }
  }
  return false;
}

/**
 * Adopts the newest page as the store's first and only one. The seed request
 * omits `snapshot` because the client does not have one yet, so the response
 * mints it.
 */
export function admitSeedPage(
  state: SessionTurnIndexState,
  page: DaemonSessionTurnIndexPage,
): SessionTurnIndexState {
  const pages = new Map<number, TurnIndexPageCacheEntry>();
  if (page.turns.length > 0) {
    pages.set(page.start, { snapshot: page.snapshot, turns: page.turns });
  }
  return {
    ...state,
    status: 'ready',
    snapshot: page.snapshot,
    totalTurns: page.totalTurns,
    pages,
  };
}

/**
 * Admits a page fetched against an explicit snapshot — an older-metadata page
 * or a post-refresh fill.
 *
 * Returns undefined when the page must not be admitted: it was minted by a
 * different snapshot than the one requested, or it overlaps coverage the store
 * already holds. Both mean the request plan and the chain disagree, and
 * admitting either way would break the "pages never overlap" invariant or mix
 * ordinals frozen by different snapshots.
 */
export function admitTurnIndexPage(
  state: SessionTurnIndexState,
  page: DaemonSessionTurnIndexPage,
  requestedSnapshot: string,
): SessionTurnIndexState | undefined {
  if (page.snapshot !== requestedSnapshot) return undefined;
  if (overlapsCoverage(state, page.start, page.turns.length)) return undefined;
  if (page.turns.length === 0) return state;
  return withPage(state, page.start, {
    snapshot: page.snapshot,
    turns: page.turns,
  });
}

export interface TurnIndexFill {
  start: number;
  limit: number;
}

export type TurnIndexRefreshPlan =
  | {
      kind: 'append-only';
      snapshot: string;
      totalTurns: number;
      fills: readonly TurnIndexFill[];
    }
  | { kind: 'divergent' };

/**
 * Decides what a tail refresh means.
 *
 * A refresh deliberately omits `snapshot` — it cannot choose its `start`, so
 * the response always covers the server-computed newest window and partially
 * overlaps the retained tail whenever the appended count is not a multiple of
 * the page size. That forces a two-step merge:
 *
 * 1. Validate by comparing every ordinal present in both the response and the
 *    retained pages by `turnId`. All matching means the chain only grew; any
 *    mismatch, or no overlap to compare at all, means it was rewritten.
 * 2. Land on the grid by comparing the largest covered ordinal against
 *    `totalTurns - 1`. Equal means the append produced no new navigation turn,
 *    so there is nothing to fill. Greater means the store still holds ordinals
 *    the chain no longer has — a rewind this client has not processed — which
 *    is divergent by definition; that exit matters because a truncated tail
 *    does not fail a snapshot-less request, so without it the store would
 *    compute a negative fill limit and adopt a `totalTurns` smaller than its
 *    own coverage. Smaller means a clamped fill against the new snapshot.
 *
 * The validation response is never admitted on the append-only path: it
 * overlaps retained coverage by construction, and it was fetched without a
 * snapshot, so it is not bound to one the way an admissible page must be.
 */
export function planTailRefresh(
  state: SessionTurnIndexState,
  validationPage: DaemonSessionTurnIndexPage,
  pageSize: number,
): TurnIndexRefreshPlan {
  const turnIdByOrdinal = new Map<number, string>();
  for (const entry of validationPage.turns) {
    turnIdByOrdinal.set(entry.ordinal, entry.turnId);
  }
  let overlap = 0;
  for (const page of state.pages.values()) {
    for (const entry of page.turns) {
      const refreshed = turnIdByOrdinal.get(entry.ordinal);
      if (refreshed === undefined) continue;
      overlap += 1;
      if (refreshed !== entry.turnId) return { kind: 'divergent' };
    }
  }
  if (overlap === 0) return { kind: 'divergent' };
  const bounds = coveredOrdinalBounds(state);
  if (!bounds) return { kind: 'divergent' };
  if (bounds.newest > validationPage.totalTurns - 1) {
    return { kind: 'divergent' };
  }
  // Uncovered tail, in page-sized chunks. Validating and filling with the same
  // limit yields at most one chunk — overlap with the retained tail puts the
  // newest covered ordinal inside the validation window, so the tail beyond it
  // is shorter than a page — and the loop covers a caller that validates with a
  // narrower window than it fills with.
  const fills: TurnIndexFill[] = [];
  let start = bounds.newest + 1;
  while (start < validationPage.totalTurns) {
    const limit = Math.min(pageSize, validationPage.totalTurns - start);
    fills.push({ start, limit });
    start += limit;
  }
  return {
    kind: 'append-only',
    snapshot: validationPage.snapshot,
    totalTurns: validationPage.totalTurns,
    fills,
  };
}

/**
 * Adopts a refreshed snapshot and turn count while keeping every retained
 * page. An append-only chain leaves older snapshots readable, and each page
 * keeps the snapshot that produced it as its own read authority.
 */
export function adoptRefreshedTail(
  state: SessionTurnIndexState,
  snapshot: string,
  totalTurns: number,
): SessionTurnIndexState {
  return { ...state, status: 'ready', snapshot, totalTurns };
}

/**
 * Discards every snapshot-bound page and adopts the refresh response as the
 * new tail page. Deliberately conservative: a rewritten active chain leaves no
 * retained page trustworthy, and a page from the old snapshot could name
 * ordinals the new chain assigns to different turns.
 */
export function resetToTailPage(
  state: SessionTurnIndexState,
  page: DaemonSessionTurnIndexPage,
): SessionTurnIndexState {
  return admitSeedPage(
    { ...state, snapshot: undefined, liveEntries: [] },
    page,
  );
}

/** Drops the snapshot and every page bound to it, ready to re-seed. */
export function invalidateTurnIndexSnapshot(
  state: SessionTurnIndexState,
): SessionTurnIndexState {
  return {
    ...state,
    status: 'idle',
    snapshot: undefined,
    totalTurns: 0,
    pages: new Map(),
    liveEntries: [],
  };
}

export function appendLivePromptEntry(
  state: SessionTurnIndexState,
  promptId: string,
  label: string,
): SessionTurnIndexState {
  const id = `live:${promptId}` as `live:${string}`;
  if (state.liveEntries.some((entry) => entry.id === id)) return state;
  return {
    ...state,
    liveEntries: [
      ...state.liveEntries,
      { id, kind: 'prompt', promptId, label },
    ],
  };
}

export function appendLiveShellEntry(
  state: SessionTurnIndexState,
  eventId: string,
  label: string,
): SessionTurnIndexState {
  const id = `shell:${eventId}` as `shell:${string}`;
  if (state.liveEntries.some((entry) => entry.id === id)) return state;
  return {
    ...state,
    liveEntries: [...state.liveEntries, { id, kind: 'shell', label }],
  };
}

export function removeLiveEntry(
  state: SessionTurnIndexState,
  id: string,
): SessionTurnIndexState {
  const liveEntries = state.liveEntries.filter((entry) => entry.id !== id);
  return liveEntries.length === state.liveEntries.length
    ? state
    : { ...state, liveEntries };
}

/**
 * Drops the prompt provisionals the durable index has caught up with.
 *
 * A provisional goes exactly when an index entry carries the same `promptId`,
 * or — for records that predate prompt-id stamping — when one of the record
 * ids the client observed for that prompt appears as an entry's `turnId`.
 * Labels and timestamps are never identity: two prompts reading "yes" or
 * landing in the same second are different turns, and matching on either would
 * silently drop one from the rail. An unmatched provisional stays and the next
 * coalesced refresh retries it.
 */
export function reconcileLiveEntries(
  state: SessionTurnIndexState,
  recordIdsByPromptId?: ReadonlyMap<string, readonly string[]>,
): SessionTurnIndexState {
  const prompts = state.liveEntries.filter(
    (entry): entry is Extract<LiveTurnEntry, { kind: 'prompt' }> =>
      entry.kind === 'prompt',
  );
  if (prompts.length === 0) return state;
  const knownPromptIds = indexedPromptIds(state);
  const knownTurnIds = indexedTurnIds(state);
  const settled = new Set<string>();
  for (const provisional of prompts) {
    if (knownPromptIds.has(provisional.promptId)) {
      settled.add(provisional.id);
      continue;
    }
    const recordIds = recordIdsByPromptId?.get(provisional.promptId);
    if (recordIds?.some((recordId) => knownTurnIds.has(recordId)) === true) {
      settled.add(provisional.id);
    }
  }
  if (settled.size === 0) return state;
  return {
    ...state,
    liveEntries: state.liveEntries.filter((entry) => !settled.has(entry.id)),
  };
}

/** Turn ids the durable index currently knows, across every cached page. */
function indexedTurnIds(state: SessionTurnIndexState): Set<string> {
  const ids = new Set<string>();
  for (const page of state.pages.values()) {
    for (const entry of page.turns) ids.add(entry.turnId);
  }
  return ids;
}

/** Prompt correlation ids the durable index currently knows. */
function indexedPromptIds(state: SessionTurnIndexState): Set<string> {
  const ids = new Set<string>();
  for (const page of state.pages.values()) {
    for (const entry of page.turns) {
      if (entry.promptId !== undefined) ids.add(entry.promptId);
    }
  }
  return ids;
}

/**
 * Maps a canonical `turnId` to the block currently rendering it.
 *
 * A block can list several persisted records — an aggregated record, or a tool
 * block a later `assistant.done` unioned onto — so the locator keeps the id the
 * index actually knows instead of assuming the first array element is the turn
 * head. The oldest block carrying a turn id wins: that is the turn's head, and
 * a newer block re-listing the same record must not move where a jump lands.
 */
export function buildTurnLocator(
  state: SessionTurnIndexState,
  blocks: readonly DaemonTranscriptBlock[],
): ReadonlyMap<string, string> {
  const locator = new Map<string, string>();
  const known = indexedTurnIds(state);
  if (known.size === 0) return locator;
  for (const block of blocks) {
    for (const recordId of block.sourceRecordIds ?? []) {
      if (!known.has(recordId) || locator.has(recordId)) continue;
      locator.set(recordId, block.id);
    }
  }
  return locator;
}

/**
 * How the store reacts to a failed index request.
 *
 * `unsupported` latches for the rest of the session: the transcript is above
 * the indexing ceiling, so no retry can succeed and the rail falls back to the
 * loaded messages. `invalidate` drops the snapshot and pages for a chain that
 * moved underneath them. Everything else is transient and retryable, and never
 * touches session load, streaming, permissions, or already retained history.
 */
export type TurnIndexFailure = 'unsupported' | 'invalidate' | 'retry';

export function classifyTurnIndexFailure(error: unknown): TurnIndexFailure {
  const code = getDaemonErrorCode(error);
  if (code === 'transcript_too_large') return 'unsupported';
  if (code === 'transcript_snapshot_unavailable') return 'invalidate';
  if (code === 'invalid_transcript_cursor') return 'invalidate';
  return 'retry';
}

export function latchTurnIndexUnsupported(
  state: SessionTurnIndexState,
): SessionTurnIndexState {
  return { ...state, status: 'unsupported' };
}
