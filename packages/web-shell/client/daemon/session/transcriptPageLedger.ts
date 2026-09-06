import {
  estimateDaemonTranscriptBlockBytes,
  type DaemonTranscriptBlock,
  type DaemonTranscriptState,
} from '@qwen-code/sdk/daemon';

/**
 * Provider-owned page ledger for the flat daemon transcript store.
 *
 * The store stays the single render source; the ledger records which block
 * ranges arrived as which fetched page, plus the explicit gaps between them,
 * so historical pages can be evicted and re-fetched without conflating
 * non-contiguous ranges. See
 * `docs/design/web-shell/web-shell-global-turn-navigation-phase2.md`.
 */
export interface TranscriptPageLedgerEntry {
  id: string;
  source: 'load' | 'prepend' | 'anchored' | 'continuation';
  /** Inclusive boundary block ids within the flat store. */
  firstBlockId: string;
  lastBlockId: string;
  /** Persisted record ids at the page boundaries, when known. */
  firstRecordId?: string;
  lastRecordId?: string;
  /**
   * Forward continuation minted by this page's fetch; present only on
   * forward reads with `hasMore` (load / anchored / forward continuation —
   * never on backward prepends).
   */
  nextCursor?: string;
  byteSize: number;
  /** Persisted record ids present on the page (from `sourceRecordIds`). */
  turnIds: readonly string[];
  /** Turn-index snapshot that produced an anchored page. */
  snapshot?: string;
}

export interface TranscriptGap {
  /** Direction in which the gap can be resolved. */
  older?: { beforeRecordId: string; snapshot?: string };
  /** Self-bound signed cursor, sent alone — never paired with a snapshot. */
  newer?: { cursor: string };
}

export type TranscriptPageLedgerEntryInput = Omit<
  TranscriptPageLedgerEntry,
  'id'
>;

/**
 * Build a ledger entry from a page's materialized blocks. Returns undefined
 * for an empty page. `turnIds` collects every persisted record id present
 * on the page (a superset of navigation turn ids until the turn-index
 * store narrows it).
 */
export function ledgerEntryFromBlocks(
  source: TranscriptPageLedgerEntry['source'],
  blocks: readonly DaemonTranscriptBlock[],
  extra?: Partial<
    Pick<TranscriptPageLedgerEntryInput, 'nextCursor' | 'snapshot'>
  >,
): TranscriptPageLedgerEntryInput | undefined {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  if (first === undefined || last === undefined) return undefined;
  const turnIds: string[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    for (const recordId of block.sourceRecordIds ?? []) {
      if (seen.has(recordId)) continue;
      seen.add(recordId);
      turnIds.push(recordId);
    }
  }
  return {
    source,
    firstBlockId: first.id,
    lastBlockId: last.id,
    firstRecordId: firstRecordIdOf(blocks),
    lastRecordId: lastRecordIdOf(blocks),
    byteSize: byteSizeOf(blocks),
    turnIds,
    ...extra,
  };
}

function firstRecordIdOf(
  blocks: readonly DaemonTranscriptBlock[],
): string | undefined {
  for (const block of blocks) {
    const recordId = block.sourceRecordIds?.[0];
    if (recordId !== undefined) return recordId;
  }
  return undefined;
}

function lastRecordIdOf(
  blocks: readonly DaemonTranscriptBlock[],
): string | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const recordId = blocks[index]?.sourceRecordIds?.[0];
    if (recordId !== undefined) return recordId;
  }
  return undefined;
}

function byteSizeOf(blocks: readonly DaemonTranscriptBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    total += estimateDaemonTranscriptBlockBytes(block);
  }
  return total;
}

/**
 * Per-session canonical locator: persisted turn id → first block carrying
 * it. Only record ids the turn-index store knows as navigation turns
 * qualify; when a block lists several source records, the ids present in
 * the index win — the first array element is not assumed to be the turn
 * head. Existing presentation-layer `turnId` usages (reducer message ids)
 * are unrelated to this map.
 */
export function buildTurnLocator(
  blocks: readonly DaemonTranscriptBlock[],
  knownTurnIds: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const locator = new Map<string, string>();
  for (const block of blocks) {
    for (const recordId of block.sourceRecordIds ?? []) {
      if (!knownTurnIds.has(recordId) || locator.has(recordId)) continue;
      locator.set(recordId, block.id);
    }
  }
  return locator;
}

export class TranscriptPageLedger {
  private entries: TranscriptPageLedgerEntry[] = [];
  /**
   * `gaps[i]` is the unloaded range immediately before `entries[i]`;
   * `gaps[entries.length]` is the range between the newest entry and the
   * live tail. An empty object means contiguous.
   */
  private gaps: TranscriptGap[] = [{}];
  private nextPageOrdinal = 1;

  getEntries(): readonly TranscriptPageLedgerEntry[] {
    return [...this.entries];
  }

  getGaps(): readonly TranscriptGap[] {
    return this.gaps.map((gap) => ({ ...gap }));
  }

  getEntry(id: string): TranscriptPageLedgerEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  clear(): void {
    this.entries = [];
    this.gaps = [{}];
  }

  private createEntry(
    input: TranscriptPageLedgerEntryInput,
  ): TranscriptPageLedgerEntry {
    const entry: TranscriptPageLedgerEntry = {
      ...input,
      id: `page-${this.nextPageOrdinal}`,
    };
    this.nextPageOrdinal += 1;
    return entry;
  }

  recordInitialLoad(page: TranscriptPageLedgerEntryInput): void {
    this.entries = [this.createEntry(page)];
    this.gaps = [{}, {}];
  }

  /**
   * A backward prepend butts exactly against the previous oldest entry;
   * `remainingOlder` becomes the gap before the new oldest entry.
   */
  recordPrepend(
    page: TranscriptPageLedgerEntryInput,
    remainingOlder?: TranscriptGap,
  ): void {
    this.entries.unshift(this.createEntry(page));
    this.gaps = [remainingOlder ?? {}, {}, ...this.gaps.slice(1)];
  }

  setOlderGap(gap?: TranscriptGap): void {
    this.gaps[0] = gap ?? {};
  }

  /**
   * Insert a page at a ledger position (anchored open, newer-direction
   * continuation). `index` is the position in the oldest-first entries
   * order; `gapBefore` describes the unresolved range above the new page.
   * The gap the insertion displaces (the range between the old neighbors)
   * becomes the gap after the new page — pass an explicit `gapAfter` only
   * when the new page resolves it (a butted continuation), otherwise the
   * displaced gap's locator is preserved.
   */
  insertEntry(
    page: TranscriptPageLedgerEntryInput,
    index: number,
    gapBefore?: TranscriptGap,
    gapAfter?: TranscriptGap,
  ): TranscriptPageLedgerEntry {
    const entry = this.createEntry(page);
    this.entries.splice(index, 0, entry);
    this.gaps.splice(index, 0, gapBefore ?? {});
    if (gapAfter !== undefined) this.gaps[index + 1] = gapAfter;
    return entry;
  }

  updateEntry(
    id: string,
    patch: Partial<TranscriptPageLedgerEntryInput>,
  ): void {
    const index = this.entries.findIndex((entry) => entry.id === id);
    const current = this.entries[index];
    if (current === undefined) return;
    this.entries[index] = { ...current, ...patch };
  }

  /**
   * Reconcile after the store's oldest-first trim. The truncation callback
   * fires mid-reduce while `store.getSnapshot()` is still pre-trim, so the
   * pre-trim state plus the detail's post-trim `blockCount` together
   * identify the evicted prefix `[0, cut)`.
   */
  applyPrefixTrim(
    preTrim: DaemonTranscriptState,
    detail: {
      blockCount?: number;
      oldestRetainedRecordId?: string;
    },
  ): void {
    if (this.entries.length === 0) return;
    const postCount = detail.blockCount ?? preTrim.blocks.length;
    const cut = preTrim.blocks.length - postCount;
    if (cut <= 0) return;

    let droppedAny = false;
    let straddled = false;
    const kept: Array<{
      entry: TranscriptPageLedgerEntry;
      gapBefore: TranscriptGap;
    }> = [];
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!;
      const firstIndex = preTrim.blockIndexById[entry.firstBlockId];
      const lastIndex = preTrim.blockIndexById[entry.lastBlockId];
      if (firstIndex === undefined || lastIndex === undefined) {
        kept.push({ entry, gapBefore: this.gaps[index] ?? {} });
        continue;
      }
      if (lastIndex < cut) {
        droppedAny = true;
        continue;
      }
      if (firstIndex < cut) {
        straddled = true;
        const retainedSlice = preTrim.blocks.slice(cut, lastIndex + 1);
        const newFirst = retainedSlice[0];
        if (newFirst === undefined) {
          droppedAny = true;
          continue;
        }
        kept.push({
          entry: {
            ...entry,
            firstBlockId: newFirst.id,
            firstRecordId:
              detail.oldestRetainedRecordId ?? firstRecordIdOf(retainedSlice),
            byteSize: byteSizeOf(retainedSlice),
            nextCursor: undefined,
          },
          gapBefore: this.gaps[index] ?? {},
        });
        continue;
      }
      kept.push({ entry, gapBefore: this.gaps[index] ?? {} });
    }
    if (!droppedAny && !straddled) return;

    // The evicted band collapses into the older gap: it stays persisted
    // daemon-side and is re-fetchable from the oldest retained record.
    // When no retained record carries an id the band is unreachable
    // (mirroring the provider's fail-closed anchor drop), so the gap
    // closes empty instead of offering an unresolvable locator.
    const previousOlder = this.gaps[0]?.older;
    const olderGap: TranscriptGap =
      detail.oldestRetainedRecordId !== undefined
        ? {
            older: {
              beforeRecordId: detail.oldestRetainedRecordId,
              ...(previousOlder?.snapshot !== undefined
                ? { snapshot: previousOlder.snapshot }
                : {}),
            },
          }
        : {};
    this.entries = kept.map((item) => item.entry);
    if (kept.length === 0) {
      this.gaps = [olderGap];
    } else {
      // The gap after the newest entry (toward the live tail) is
      // unaffected by a prefix trim and carries over.
      const trailing = this.gaps[this.gaps.length - 1] ?? {};
      this.gaps = [
        olderGap,
        ...kept.slice(1).map((item) => item.gapBefore),
        trailing,
      ];
    }
  }

  /**
   * Reconcile after a rewind, which drops the NEWEST blocks. Entries past
   * the rewind point are dropped; a straddling newest entry is shrunk and
   * loses its forward cursor (it points past rewound content).
   */
  applyRewind(
    preRewind: DaemonTranscriptState,
    detail: { blockCount?: number },
  ): void {
    if (this.entries.length === 0) return;
    const postCount = detail.blockCount ?? preRewind.blocks.length;
    if (postCount >= preRewind.blocks.length) return;

    const kept: Array<{
      entry: TranscriptPageLedgerEntry;
      gapBefore: TranscriptGap;
    }> = [];
    let changed = false;
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!;
      const firstIndex = preRewind.blockIndexById[entry.firstBlockId];
      const lastIndex = preRewind.blockIndexById[entry.lastBlockId];
      if (firstIndex === undefined || lastIndex === undefined) {
        kept.push({ entry, gapBefore: this.gaps[index] ?? {} });
        continue;
      }
      if (firstIndex >= postCount) {
        changed = true;
        continue;
      }
      if (lastIndex >= postCount) {
        changed = true;
        const retainedSlice = preRewind.blocks.slice(firstIndex, postCount);
        const newLast = retainedSlice[retainedSlice.length - 1];
        if (newLast === undefined) {
          continue;
        }
        kept.push({
          entry: {
            ...entry,
            lastBlockId: newLast.id,
            lastRecordId: lastRecordIdOf(retainedSlice),
            byteSize: byteSizeOf(retainedSlice),
            nextCursor: undefined,
          },
          gapBefore: this.gaps[index] ?? {},
        });
        continue;
      }
      kept.push({ entry, gapBefore: this.gaps[index] ?? {} });
    }
    if (!changed) return;
    this.entries = kept.map((item) => item.entry);
    // Ranges beyond the rewind point no longer exist; gaps that pointed
    // into them close empty rather than resolve into a rewritten chain.
    this.gaps = [...kept.map((item) => item.gapBefore), {}];
  }
}
