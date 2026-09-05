/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  estimateDaemonTranscriptBlockBytes,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';

/** How a page entered the retained window. */
export type TranscriptPageSource =
  | 'load'
  | 'prepend'
  | 'anchored'
  | 'continuation';

/**
 * One admitted transcript page.
 *
 * The flat SDK store stays the single render source; this entry only records
 * which slice of it one fetch produced, so eviction can remove whole pages and
 * unloaded ranges can stay explicit instead of being implied contiguous.
 */
export interface TranscriptPageLedgerEntry {
  id: string;
  source: TranscriptPageSource;
  /** Inclusive block boundaries within the flat store. */
  firstBlockId: string;
  lastBlockId: string;
  blockCount: number;
  /** Persisted record boundaries, when the page carried any. */
  firstRecordId?: string;
  lastRecordId?: string;
  /**
   * Forward continuation minted by this page's fetch. Only forward reads
   * (load, anchored, forward continuation) produce one; a backward prepend
   * never does.
   */
  nextCursor?: string;
  byteSize: number;
  /** Persisted record identities carried by the page, in transcript order. */
  turnIds: readonly string[];
  /** Turn-index snapshot that produced an anchored page. */
  snapshot?: string;
}

/**
 * An unloaded range between two retained pages, or between the oldest page and
 * the start of the session. A gap is always explicit: two neighbouring pages
 * are never assumed contiguous just because nothing sits between them.
 *
 * A side is absent when the range is known to be missing but carries no
 * locator to re-fetch it with — a window whose oldest retained block lost its
 * record identity, for example.
 */
export interface TranscriptGap {
  /** Direction in which the gap can be resolved. */
  older?: { beforeRecordId: string; snapshot?: string };
  /** Self-bound continuation; the protocol requires it to be sent alone. */
  newer?: { cursor: string };
}

/**
 * Ordered page/gap spans covering the retained window. Spans are ordered
 * oldest → newest and page spans hold blocks that are contiguous in the flat
 * store, so the page blocks are exactly the store's blocks minus the live
 * tail.
 */
export interface TranscriptPageLedger {
  sessionId?: string;
  /**
   * The store's ordinal counter when these spans were last validated against a
   * window. Absent on a ledger that has never been validated, which makes the
   * reset check below skip rather than guess.
   */
  nextOrdinal?: number;
  spans: readonly TranscriptPageSpan[];
}

export type TranscriptPageSpan =
  | { kind: 'page'; entry: TranscriptPageLedgerEntry }
  | { kind: 'gap'; gap: TranscriptGap };

/** A gap towards older content, located by the oldest retained record. */
function olderGap(beforeRecordId?: string): TranscriptGap {
  return beforeRecordId === undefined ? {} : { older: { beforeRecordId } };
}

export function createTranscriptPageLedger(
  sessionId?: string,
): TranscriptPageLedger {
  return { ...(sessionId !== undefined ? { sessionId } : {}), spans: [] };
}

/** The part of the transcript window a ledger validates itself against. */
export interface LedgerWindow {
  blocks: readonly DaemonTranscriptBlock[];
  /**
   * The store's block ordinal counter. It only advances while a window lives —
   * history admission seeds its throwaway store from the current value — and a
   * bare `store.reset()` restarts it at 1.
   */
  nextOrdinal: number;
}

/**
 * Returns the ledger to record a new page into: the one for `sessionId` when it
 * still describes `window`, an empty one otherwise. The result carries the
 * window's ordinal so the next call can tell a reset from growth.
 *
 * Pages are session-scoped, so a branch or a switch must never inherit the
 * previous chain's boundaries. The window check matters because the store is
 * also wiped from places that know nothing about the ledger (clear screen,
 * session clear): recording against a wiped window would carry boundaries for
 * blocks that no longer exist into the new page's ledger.
 *
 * Size and block ids alone cannot detect that wipe. A reset restarts the ordinal
 * counter, so the regrown window recycles the same ids, and once it holds as many
 * blocks as the spans claim, the prefix check compares equal against blocks that
 * are not the pages'. An ordinal that went backwards is the only tell.
 */
export function ledgerForWindow(
  ledger: TranscriptPageLedger,
  sessionId: string,
  window: LedgerWindow,
): TranscriptPageLedger {
  const fresh = {
    ...createTranscriptPageLedger(sessionId),
    nextOrdinal: window.nextOrdinal,
  };
  if (ledger.sessionId !== sessionId) return fresh;
  if (
    ledger.nextOrdinal !== undefined &&
    window.nextOrdinal < ledger.nextOrdinal
  ) {
    return fresh;
  }
  if (!ledgerCoversBlockPrefix(ledger, window.blocks)) return fresh;
  return ledger.nextOrdinal === window.nextOrdinal
    ? ledger
    : { ...ledger, nextOrdinal: window.nextOrdinal };
}

export function ledgerPageEntries(
  ledger: TranscriptPageLedger,
): readonly TranscriptPageLedgerEntry[] {
  const entries: TranscriptPageLedgerEntry[] = [];
  for (const span of ledger.spans) {
    if (span.kind === 'page') entries.push(span.entry);
  }
  return entries;
}

export function ledgerBlockCount(ledger: TranscriptPageLedger): number {
  let total = 0;
  for (const span of ledger.spans) {
    if (span.kind === 'page') total += span.entry.blockCount;
  }
  return total;
}

/**
 * How many page blocks precede a span index, i.e. the flat-store offset a page
 * inserted at that span index must be spliced in at. Gaps contribute nothing:
 * an unloaded range occupies no blocks.
 */
export function ledgerBlockOffset(
  ledger: TranscriptPageLedger,
  spanIndex: number,
): number {
  let offset = 0;
  for (
    let index = 0;
    index < spanIndex && index < ledger.spans.length;
    index += 1
  ) {
    const span = ledger.spans[index];
    if (span?.kind === 'page') offset += span.entry.blockCount;
  }
  return offset;
}

/**
 * Block id of the newest page's last block — the boundary the live tail starts
 * after. Undefined when the ledger holds no page, in which case the whole store
 * is live tail. The ledger cannot name the first live-tail block itself: live
 * blocks are not entries, so a caller derives it as the store's next block.
 */
export function ledgerNewestPageLastBlockId(
  ledger: TranscriptPageLedger,
): string | undefined {
  for (let index = ledger.spans.length - 1; index >= 0; index -= 1) {
    const span = ledger.spans[index];
    if (span?.kind === 'page') return span.entry.lastBlockId;
  }
  return undefined;
}

/**
 * True when the ledger's page spans still cover exactly a prefix of `blocks`.
 *
 * The transcript store is reset from several places that know nothing about
 * the ledger (session clear, session switch, resync reload), and a load commit
 * replaces every span — but between such a reset and the next commit the
 * ledger describes blocks that no longer exist. Mutating it from that state
 * would compute gap boundaries against the wrong offsets, so callers discard
 * the ledger instead.
 */
export function ledgerCoversBlockPrefix(
  ledger: TranscriptPageLedger,
  blocks: readonly DaemonTranscriptBlock[],
): boolean {
  const covered = ledgerBlockCount(ledger);
  if (covered === 0) return true;
  if (covered > blocks.length) return false;
  return blocks[covered - 1]?.id === ledgerNewestPageLastBlockId(ledger);
}

interface LedgerEntryBlockBounds {
  id: string;
  source: TranscriptPageSource;
  nextCursor?: string;
  snapshot?: string;
}

function entryFromBlocks(
  bounds: LedgerEntryBlockBounds,
  blocks: readonly DaemonTranscriptBlock[],
): TranscriptPageLedgerEntry | undefined {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (first === undefined || last === undefined) return undefined;
  const turnIds: string[] = [];
  const seen = new Set<string>();
  let byteSize = 0;
  let firstRecordId: string | undefined;
  let lastRecordId: string | undefined;
  for (const block of blocks) {
    byteSize += estimateDaemonTranscriptBlockBytes(block);
    const recordIds = block.sourceRecordIds;
    if (recordIds === undefined || recordIds.length === 0) continue;
    firstRecordId ??= recordIds[0];
    lastRecordId = recordIds[recordIds.length - 1];
    for (const recordId of recordIds) {
      if (seen.has(recordId)) continue;
      seen.add(recordId);
      turnIds.push(recordId);
    }
  }
  return {
    id: bounds.id,
    source: bounds.source,
    firstBlockId: first.id,
    lastBlockId: last.id,
    blockCount: blocks.length,
    ...(firstRecordId !== undefined ? { firstRecordId } : {}),
    ...(lastRecordId !== undefined ? { lastRecordId } : {}),
    ...(bounds.nextCursor !== undefined
      ? { nextCursor: bounds.nextCursor }
      : {}),
    byteSize,
    turnIds,
    ...(bounds.snapshot !== undefined ? { snapshot: bounds.snapshot } : {}),
  };
}

/** Builds a ledger entry from an admitted page's blocks. */
export function createLedgerPageEntry(
  bounds: LedgerEntryBlockBounds,
  blocks: readonly DaemonTranscriptBlock[],
): TranscriptPageLedgerEntry | undefined {
  return entryFromBlocks(bounds, blocks);
}

/**
 * Records the initial replay commit. The replay replaces the whole window, so
 * any previously retained page is gone with it. `olderContentRemains` says
 * whether the session has durable content older than the replayed window, in
 * which case the window starts with an explicit gap rather than implying that
 * the first retained block is the first turn.
 */
export function recordLedgerLoadPage(
  ledger: TranscriptPageLedger,
  entry: TranscriptPageLedgerEntry,
  olderContentRemains: boolean,
): TranscriptPageLedger {
  const page: TranscriptPageSpan = { kind: 'page', entry };
  return {
    ...ledger,
    spans: olderContentRemains
      ? [{ kind: 'gap', gap: olderGap(entry.firstRecordId) }, page]
      : [page],
  };
}

/**
 * Records a prepended page. Prepend admission places the page's blocks before
 * every retained block, so the span goes at the head.
 *
 * The page resolves the front of the older gap, so that gap is replaced rather
 * than kept: what is still missing now sits before this page and is located by
 * this page's oldest record. When the fetch reached the start of the session
 * nothing older remains and the gap closes.
 */
export function recordLedgerPrependPage(
  ledger: TranscriptPageLedger,
  entry: TranscriptPageLedgerEntry,
  olderContentRemains: boolean,
): TranscriptPageLedger {
  const rest =
    ledger.spans[0]?.kind === 'gap' ? ledger.spans.slice(1) : ledger.spans;
  const page: TranscriptPageSpan = { kind: 'page', entry };
  return {
    ...ledger,
    spans: olderContentRemains
      ? [{ kind: 'gap', gap: olderGap(entry.firstRecordId) }, page, ...rest]
      : [page, ...rest],
  };
}

/** A gap towards older content, located by the record a fetch stopped at. */
export function olderGapAt(
  beforeRecordId?: string,
  snapshot?: string,
): TranscriptGap {
  if (beforeRecordId === undefined) return {};
  return {
    older: {
      beforeRecordId,
      ...(snapshot !== undefined ? { snapshot } : {}),
    },
  };
}

/** A gap towards newer content, located by a forward continuation cursor. */
export function newerGapAt(cursor?: string): TranscriptGap {
  return cursor === undefined ? {} : { newer: { cursor } };
}

/**
 * Records a page landed by a random-access read at its position in the window.
 *
 * `insertAt` is the span index the page goes in at. A gap span already there is
 * consumed: the page landed inside that unloaded range, so what is still
 * missing on either side is described by the gaps passed in, which the caller
 * derives from the read's own `hasOlder` and forward-continuation facts rather
 * than from an assumption that the page butted against its neighbours.
 */
export function recordLedgerAnchoredPage(
  ledger: TranscriptPageLedger,
  entry: TranscriptPageLedgerEntry,
  insertAt: number,
  placement: { older?: TranscriptGap; newer?: TranscriptGap },
): TranscriptPageLedger {
  const spans = [...ledger.spans];
  const index = Math.max(0, Math.min(insertAt, spans.length));
  const consumed = spans[index]?.kind === 'gap' ? 1 : 0;
  const inserted: TranscriptPageSpan[] = [
    ...(placement.older
      ? ([{ kind: 'gap', gap: placement.older }] as TranscriptPageSpan[])
      : []),
    { kind: 'page', entry },
    ...(placement.newer
      ? ([{ kind: 'gap', gap: placement.newer }] as TranscriptPageSpan[])
      : []),
  ];
  spans.splice(index, consumed, ...inserted);
  return { ...ledger, spans };
}

/** The ordinal range a page is known to cover, when the index knows any of it. */
function pageOrdinalBounds(
  entry: TranscriptPageLedgerEntry,
  ordinalByRecordId: ReadonlyMap<string, number>,
): { lowest: number; highest: number } | undefined {
  let lowest: number | undefined;
  let highest: number | undefined;
  for (const recordId of entry.turnIds) {
    const ordinal = ordinalByRecordId.get(recordId);
    if (ordinal === undefined) continue;
    if (lowest === undefined || ordinal < lowest) lowest = ordinal;
    if (highest === undefined || ordinal > highest) highest = ordinal;
  }
  if (lowest === undefined || highest === undefined) return undefined;
  return { lowest, highest };
}

/**
 * The span index a page landing at `targetOrdinal` belongs in: the first span
 * covering that ordinal or a newer one, or `spans.length` when the target is
 * newer than everything retained, so the page lands just before the live tail.
 *
 * Order comes from the caller-supplied ordinal lookup because record ids are not
 * themselves ordered. Two cases report undefined instead of guessing a position,
 * because a wrong one interleaves ranges that were never adjacent:
 *
 * - no retained page carries an ordinal the index knows, so nothing can be
 *   ordered against — and a sparse, evictable index makes that ordinary rather
 *   than evidence the incoming page is the newest thing in the session;
 * - the target falls strictly inside a retained page's known range. An anchored
 *   read expands backward off its target, so the page it returns can carry
 *   records older than the target while that retained page already holds records
 *   on both sides of it, and no position for the newcomer avoids claiming an
 *   adjacency nobody verified.
 *
 * A target equal to a page's lowest ordinal is not inside it: the newcomer can
 * only carry records older than that one, so it belongs in front.
 */
export function ledgerInsertIndexForOrdinal(
  ledger: TranscriptPageLedger,
  ordinalByRecordId: ReadonlyMap<string, number>,
  targetOrdinal: number,
): number | undefined {
  for (const [index, span] of ledger.spans.entries()) {
    if (span.kind === 'gap') continue;
    const bounds = pageOrdinalBounds(span.entry, ordinalByRecordId);
    if (bounds === undefined) return undefined;
    if (targetOrdinal <= bounds.lowest) return index;
    if (targetOrdinal <= bounds.highest) return undefined;
  }
  return ledger.spans.length;
}

/** How to fetch the range a gap describes. */
export type LedgerGapFetch =
  | { kind: 'older'; beforeRecordId: string; snapshot?: string }
  | { kind: 'cursor'; cursor: string }
  | { kind: 'anchor'; atRecordId: string; snapshot: string };

function neighbourPage(
  ledger: TranscriptPageLedger,
  gapIndex: number,
  direction: 'older' | 'newer',
): TranscriptPageLedgerEntry | undefined {
  const step = direction === 'older' ? -1 : 1;
  for (
    let index = gapIndex + step;
    index >= 0 && index < ledger.spans.length;
    index += step
  ) {
    const span = ledger.spans[index];
    if (span?.kind === 'page') return span.entry;
  }
  return undefined;
}

/**
 * Chooses how to resolve a gap.
 *
 * The protocol has no "page after record X" operation, so a gap's newer side is
 * resolvable three ways and they are tried in this order: the forward cursor the
 * older neighbour's read minted, which is self-bound and must be sent alone;
 * re-anchoring on a navigation turn inside the gap, which the caller supplies
 * from the turn index and which is the only option once the older neighbour —
 * and the cursor with it — has been evicted; and backfilling from the newer
 * neighbour with `beforeRecordId`, which walks newest-to-oldest into the gap and
 * is the only way across a hole that holds no navigation turn at all, because
 * such a hole lies entirely inside one long turn.
 *
 * The gap's own older side needs no strategy and is the fallback: it already
 * carries its locator. Undefined means the gap is unresolvable — no locator on
 * either side and no neighbour to borrow one from.
 */
export function resolveLedgerGap(
  ledger: TranscriptPageLedger,
  gapIndex: number,
  reanchor?: { atRecordId: string; snapshot: string },
): LedgerGapFetch | undefined {
  const span = ledger.spans[gapIndex];
  if (span?.kind !== 'gap') return undefined;
  const gap = span.gap;
  if (gap.newer) return { kind: 'cursor', cursor: gap.newer.cursor };
  const older = neighbourPage(ledger, gapIndex, 'older');
  if (older?.nextCursor) return { kind: 'cursor', cursor: older.nextCursor };
  if (reanchor) {
    return {
      kind: 'anchor',
      atRecordId: reanchor.atRecordId,
      snapshot: reanchor.snapshot,
    };
  }
  const newer = neighbourPage(ledger, gapIndex, 'newer');
  if (newer?.firstRecordId) {
    return {
      kind: 'older',
      beforeRecordId: newer.firstRecordId,
      ...(newer.snapshot !== undefined ? { snapshot: newer.snapshot } : {}),
    };
  }
  if (gap.older) {
    return {
      kind: 'older',
      beforeRecordId: gap.older.beforeRecordId,
      ...(gap.older.snapshot !== undefined
        ? { snapshot: gap.older.snapshot }
        : {}),
    };
  }
  return undefined;
}

/** What the store reported when it dropped blocks from one end. */
export interface LedgerEviction {
  /** Pre-eviction flat block list. */
  blocks: readonly DaemonTranscriptBlock[];
  /** How many of them survive. */
  retainedBlockCount: number;
  /** True for an oldest-first retention trim, false for a rewind. */
  evictedOldest: boolean;
  /** Oldest surviving persisted record id, when a survivor carries one. */
  oldestRetainedRecordId?: string;
}

/**
 * Reconciles the ledger after the store dropped blocks from one end.
 *
 * An oldest-first retention trim evicts a prefix; a rewind evicts a suffix.
 * Either way a page span that survives only partially is clipped to its
 * surviving blocks rather than dropped, so the ledger keeps covering exactly
 * the blocks the store holds.
 *
 * The two directions treat gaps differently. A trim pushes the window's older
 * boundary back, so every missing range it exposes folds into one head gap
 * located by the oldest surviving record — folding gaps is safe because a
 * union of unloaded ranges is still unloaded, whereas folding pages would
 * claim contiguity that does not exist. A rewind drops the newest content, so
 * gaps beyond the cut are dropped with the pages they separated.
 */
export function clipLedgerToRetainedBlocks(
  ledger: TranscriptPageLedger,
  eviction: LedgerEviction,
): TranscriptPageLedger {
  const { blocks, retainedBlockCount, evictedOldest } = eviction;
  if (!ledgerCoversBlockPrefix(ledger, blocks)) {
    return createTranscriptPageLedger(ledger.sessionId);
  }
  const retained = Math.max(0, Math.min(retainedBlockCount, blocks.length));
  const low = evictedOldest ? blocks.length - retained : 0;
  const high = evictedOldest ? blocks.length : retained;
  if (low <= 0 && high >= blocks.length) return ledger;
  const kept: TranscriptPageSpan[] = [];
  let offset = 0;
  let lostPageContent = false;
  for (const span of ledger.spans) {
    if (span.kind === 'gap') {
      if (!evictedOldest && offset >= high) continue;
      kept.push(span);
      continue;
    }
    const entry = span.entry;
    const start = offset;
    const end = offset + entry.blockCount;
    offset = end;
    const clippedStart = Math.max(start, low);
    const clippedEnd = Math.min(end, high);
    if (clippedStart >= clippedEnd) {
      lostPageContent = true;
      continue;
    }
    if (clippedStart !== start || clippedEnd !== end) lostPageContent = true;
    if (clippedStart === start && clippedEnd === end) {
      kept.push(span);
      continue;
    }
    const clipped = entryFromBlocks(
      {
        id: entry.id,
        source: entry.source,
        ...(entry.nextCursor !== undefined
          ? { nextCursor: entry.nextCursor }
          : {}),
        ...(entry.snapshot !== undefined ? { snapshot: entry.snapshot } : {}),
      },
      blocks.slice(clippedStart, clippedEnd),
    );
    if (clipped) kept.push({ kind: 'page', entry: clipped });
  }
  if (!evictedOldest) return { ...ledger, spans: kept };
  const firstPage = kept.findIndex((span) => span.kind === 'page');
  const leadingGap = kept.some(
    (span, index) =>
      span.kind === 'gap' && (firstPage < 0 || index < firstPage),
  );
  if (!lostPageContent && !leadingGap) return { ...ledger, spans: kept };
  const survivors = firstPage < 0 ? [] : kept.slice(firstPage);
  return {
    ...ledger,
    spans: [
      { kind: 'gap', gap: olderGap(eviction.oldestRetainedRecordId) },
      ...survivors,
    ],
  };
}
