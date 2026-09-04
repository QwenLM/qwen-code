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
 * Ordered page/gap spans covering the retained window. Spans are ordered
 * oldest → newest and page spans hold blocks that are contiguous in the flat
 * store, so the page blocks are exactly the store's blocks minus the live
 * tail.
 */
export interface TranscriptPageLedger {
  sessionId?: string;
  spans: readonly TranscriptPageSpan[];
}

export type TranscriptPageSpan = {
  kind: 'page';
  entry: TranscriptPageLedgerEntry;
};

export function createTranscriptPageLedger(
  sessionId?: string,
): TranscriptPageLedger {
  return { ...(sessionId !== undefined ? { sessionId } : {}), spans: [] };
}

/**
 * Returns the ledger to record a new page into: the one for `sessionId` when
 * it still describes `blocks`, an empty one otherwise.
 *
 * Pages are session-scoped, so a branch or a switch must never inherit the
 * previous chain's boundaries. The window check matters because the store is
 * also wiped from places that know nothing about the ledger (clear screen,
 * session clear): recording against a wiped window would carry boundaries for
 * blocks that no longer exist into the new page's ledger.
 */
export function ledgerForWindow(
  ledger: TranscriptPageLedger,
  sessionId: string,
  blocks: readonly DaemonTranscriptBlock[],
): TranscriptPageLedger {
  const scoped =
    ledger.sessionId === sessionId
      ? ledger
      : createTranscriptPageLedger(sessionId);
  return ledgerCoversBlockPrefix(scoped, blocks)
    ? scoped
    : createTranscriptPageLedger(sessionId);
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
 * Block id of the first live-tail block, i.e. the block right after the newest
 * page. Undefined when the ledger holds no page, in which case the whole store
 * is live tail.
 */
export function ledgerLiveTailFirstBlockId(
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
  return blocks[covered - 1]?.id === ledgerLiveTailFirstBlockId(ledger);
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
 * any previously retained page is gone with it.
 */
export function recordLedgerLoadPage(
  ledger: TranscriptPageLedger,
  entry: TranscriptPageLedgerEntry,
): TranscriptPageLedger {
  return { ...ledger, spans: [{ kind: 'page', entry }] };
}

/**
 * Records a prepended page. Prepend admission places the page's blocks before
 * every retained block, so the span goes at the head.
 */
export function recordLedgerPrependPage(
  ledger: TranscriptPageLedger,
  entry: TranscriptPageLedgerEntry,
): TranscriptPageLedger {
  return { ...ledger, spans: [{ kind: 'page', entry }, ...ledger.spans] };
}

/**
 * Reconciles the ledger after the store dropped blocks from one end.
 *
 * `blocks` is the pre-eviction flat block list and `retainedBlockCount` the
 * post-eviction one, both of which the store's truncation detail already
 * reports. An oldest-first retention trim evicts a prefix; a rewind evicts a
 * suffix. Either way a page span that survives only partially is clipped to
 * its surviving blocks rather than dropped, so the ledger keeps covering
 * exactly the blocks the store holds.
 */
export function clipLedgerToRetainedBlocks(
  ledger: TranscriptPageLedger,
  blocks: readonly DaemonTranscriptBlock[],
  retainedBlockCount: number,
  evictedOldest: boolean,
): TranscriptPageLedger {
  if (!ledgerCoversBlockPrefix(ledger, blocks)) {
    return createTranscriptPageLedger(ledger.sessionId);
  }
  const retained = Math.max(0, Math.min(retainedBlockCount, blocks.length));
  const low = evictedOldest ? blocks.length - retained : 0;
  const high = evictedOldest ? blocks.length : retained;
  if (low <= 0 && high >= blocks.length) return ledger;
  const spans: TranscriptPageSpan[] = [];
  let offset = 0;
  for (const span of ledger.spans) {
    if (span.kind !== 'page') continue;
    const entry = span.entry;
    const start = offset;
    const end = offset + entry.blockCount;
    offset = end;
    const clippedStart = Math.max(start, low);
    const clippedEnd = Math.min(end, high);
    if (clippedStart >= clippedEnd) continue;
    if (clippedStart === start && clippedEnd === end) {
      spans.push(span);
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
    if (clipped) spans.push({ kind: 'page', entry: clipped });
  }
  return { ...ledger, spans };
}
