import {
  DaemonHttpError,
  type DaemonSessionTurnIndexEntry,
  type DaemonSessionTurnIndexPage,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import { isRecord } from './httpErrors.js';

/**
 * Client-side session-wide turn-index store for Web Shell turn navigation.
 * Loads the newest metadata page first and pages older metadata
 * independently of transcript blocks. See
 * `docs/design/web-shell/web-shell-global-turn-navigation-phase2.md`.
 */
export type SessionTurnIndexStatus =
  | 'disabled'
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error'
  | 'unsupported';

export type LiveTurnEntry =
  | { id: `live:${string}`; kind: 'prompt'; promptId: string; label: string }
  | { id: `shell:${string}`; kind: 'shell'; label: string };

export interface TurnIndexPageCacheEntry {
  /** The snapshot that minted this page — the read authority for it. */
  snapshot: string;
  turns: readonly DaemonSessionTurnIndexEntry[];
}

export interface SessionTurnIndexState {
  sessionId: string;
  status: SessionTurnIndexStatus;
  /** Newest snapshot; authority for seed/older-page requests only. */
  snapshot?: string;
  totalTurns: number;
  /** Key = page start ordinal. Pages never overlap in stable state. */
  pages: ReadonlyMap<number, TurnIndexPageCacheEntry>;
  /** Tail-only provisional entries not yet persisted. */
  liveEntries: readonly LiveTurnEntry[];
}

export type TurnIndexPageFetcher = (opts: {
  snapshot?: string;
  start?: number;
  limit?: number;
}) => Promise<DaemonSessionTurnIndexPage>;

export interface SessionTurnIndexStoreOptions {
  sessionId: string;
  fetchPage: TurnIndexPageFetcher;
  /** Capability gate: false latches `disabled` and turns fetches into no-ops. */
  enabled?: boolean;
  pageSize?: number;
  /** LRU bounds over the page map; the newest page is pinned. */
  maxPages?: number;
  maxPageBytes?: number;
  /** Injectable retry scheduler; defaults to setTimeout. */
  scheduleRetry?: (fn: () => void, delayMs: number) => void;
}

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 8;
const DEFAULT_MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];

interface RetainedPage extends TurnIndexPageCacheEntry {
  lastUsed: number;
  bytes: number;
}

function estimatePageBytes(
  turns: readonly DaemonSessionTurnIndexEntry[],
): number {
  let total = 0;
  for (const turn of turns) {
    total +=
      turn.turnId.length +
      turn.label.length +
      (turn.promptId?.length ?? 0) +
      (turn.detail?.length ?? 0) +
      16;
  }
  return total;
}

function daemonErrorCode(error: unknown): string | undefined {
  if (!(error instanceof DaemonHttpError) || !isRecord(error.body)) {
    return undefined;
  }
  const code = error.body['code'];
  return typeof code === 'string' ? code : undefined;
}

export class SessionTurnIndexStore {
  private readonly sessionId: string;
  private readonly fetchPage: TurnIndexPageFetcher;
  private readonly enabled: boolean;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly maxPageBytes: number;
  private readonly scheduleRetry: (fn: () => void, delayMs: number) => void;

  private status: SessionTurnIndexStatus;
  private snapshot: string | undefined;
  private totalTurns = 0;
  private pages = new Map<number, RetainedPage>();
  private liveEntries: LiveTurnEntry[] = [];
  /** prompt provisional id → persisted record ids observed on its echo block. */
  private readonly linkedRecordIds = new Map<string, readonly string[]>();

  private lruClock = 0;
  private generation = 0;
  private retryAttempts = 0;
  private seeding: Promise<void> | undefined;
  private tailRefresh: Promise<void> | undefined;
  private readonly inFlightPages = new Map<number, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private stateCache: SessionTurnIndexState | undefined;

  constructor(options: SessionTurnIndexStoreOptions) {
    this.sessionId = options.sessionId;
    this.fetchPage = options.fetchPage;
    this.enabled = options.enabled !== false;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.maxPageBytes = options.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES;
    this.scheduleRetry =
      options.scheduleRetry ?? ((fn, delayMs) => setTimeout(fn, delayMs));
    this.status = this.enabled ? 'idle' : 'disabled';
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): SessionTurnIndexState => {
    if (this.stateCache === undefined) {
      this.stateCache = {
        sessionId: this.sessionId,
        status: this.status,
        snapshot: this.snapshot,
        totalTurns: this.totalTurns,
        pages: this.pages,
        liveEntries: this.liveEntries,
      };
    }
    return this.stateCache;
  };

  private notify(): void {
    this.stateCache = undefined;
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    this.generation += 1;
    this.listeners.clear();
  }

  /** Persisted turn ids across retained pages; keys the locator map. */
  getKnownTurnIds(): ReadonlySet<string> {
    const known = new Set<string>();
    for (const page of this.pages.values()) {
      for (const turn of page.turns) known.add(turn.turnId);
    }
    return known;
  }

  /**
   * Locate a persisted turn for anchored reads. The returned snapshot is
   * the entry's OWN page snapshot — the protocol's read authority for
   * anchored transcript fetches at that entry.
   */
  findTurn(
    turnId: string,
  ): { entry: DaemonSessionTurnIndexEntry; snapshot: string } | undefined {
    for (const page of this.pages.values()) {
      const entry = page.turns.find((turn) => turn.turnId === turnId);
      if (entry !== undefined) {
        return { entry, snapshot: page.snapshot };
      }
    }
    return undefined;
  }

  private coveredIntervals(): Array<[number, number]> {
    const intervals: Array<[number, number]> = [];
    for (const [start, page] of this.pages) {
      if (page.turns.length > 0) {
        intervals.push([start, start + page.turns.length - 1]);
      }
    }
    intervals.sort((a, b) => a[0] - b[0]);
    return intervals;
  }

  private isCovered(ordinal: number): boolean {
    for (const [start, page] of this.pages) {
      if (ordinal >= start && ordinal < start + page.turns.length) {
        page.lastUsed = ++this.lruClock;
        return true;
      }
    }
    return false;
  }

  /** Smallest covered ordinal, or undefined when no page is retained. */
  private boundary(): number | undefined {
    let min: number | undefined;
    for (const [start, page] of this.pages) {
      if (page.turns.length === 0) continue;
      if (min === undefined || start < min) min = start;
    }
    return min;
  }

  async seed(): Promise<void> {
    if (!this.enabled || this.status === 'unsupported') return;
    if (this.seeding !== undefined) return this.seeding;
    const generation = this.generation;
    this.seeding = (async () => {
      this.status = 'loading';
      this.notify();
      try {
        const page = await this.fetchPage({ limit: this.pageSize });
        if (generation !== this.generation) return;
        this.pages = new Map([[page.start, this.retain(page)]]);
        this.snapshot = page.snapshot;
        this.totalTurns = page.totalTurns;
        this.status = 'ready';
        this.retryAttempts = 0;
        this.afterAdmission();
      } catch (error) {
        if (generation !== this.generation) return;
        this.handleFetchError(error, () => this.invalidateAndReseed());
      } finally {
        if (generation === this.generation) this.seeding = undefined;
      }
    })();
    return this.seeding;
  }

  /** Re-seed from a fresh tail request after snapshot invalidation. */
  async invalidateAndReseed(): Promise<void> {
    this.pages = new Map();
    this.snapshot = undefined;
    this.totalTurns = 0;
    this.generation += 1;
    this.seeding = undefined;
    this.tailRefresh = undefined;
    this.inFlightPages.clear();
    await this.seed();
  }

  /** Latch `unsupported` (indexing-ceiling exceeded) for the session. */
  markUnsupported(): void {
    if (this.status === 'unsupported') return;
    this.status = 'unsupported';
    this.pages = new Map();
    this.snapshot = undefined;
    // Drop in-flight responses too: nothing may be admitted after the latch.
    this.generation += 1;
    this.seeding = undefined;
    this.tailRefresh = undefined;
    this.inFlightPages.clear();
    this.notify();
  }

  /**
   * Ensure the page covering `ordinal` is retained. No-op when already
   * covered; otherwise requests the largest non-overlapping slice of the
   * uncovered interval containing the ordinal.
   */
  async ensurePage(ordinal: number): Promise<void> {
    if (!this.enabled || this.status === 'unsupported') return;
    if (this.snapshot === undefined) return;
    if (ordinal < 0 || ordinal >= this.totalTurns) return;
    if (this.isCovered(ordinal)) return;
    const intervals = this.coveredIntervals();
    let lo = 0;
    let hi = this.totalTurns - 1;
    for (const [start, end] of intervals) {
      if (ordinal < start) {
        hi = start - 1;
        break;
      }
      lo = end + 1;
    }
    if (lo > hi) return;
    const start = Math.max(lo, Math.min(ordinal, hi - this.pageSize + 1));
    const limit = Math.min(this.pageSize, hi - start + 1);
    if (limit < 1) return;
    await this.fetchOlderSlice(start, limit);
  }

  /**
   * Fetch the metadata page immediately older than the retained coverage.
   * `boundary == 0` means the oldest turn is already retained — the
   * clamped limit would be 0 (a 400), so no request is sent.
   */
  async loadOlder(): Promise<void> {
    if (!this.enabled || this.status === 'unsupported') return;
    if (this.snapshot === undefined) return;
    const boundary = this.boundary();
    if (boundary === undefined || boundary === 0) return;
    const start = Math.max(0, boundary - this.pageSize);
    await this.fetchOlderSlice(start, boundary - start);
  }

  private async fetchOlderSlice(start: number, limit: number): Promise<void> {
    const snapshot = this.snapshot;
    if (snapshot === undefined) return;
    const inFlight = this.inFlightPages.get(start);
    if (inFlight !== undefined) return inFlight;
    const generation = this.generation;
    const request = (async () => {
      try {
        const page = await this.fetchPage({ snapshot, start, limit });
        if (generation !== this.generation) return;
        // Admission-time snapshot rule: a page returned for a
        // store-snapshot request must carry that same snapshot.
        if (page.snapshot !== snapshot) {
          await this.invalidateAndReseed();
          return;
        }
        const next = new Map(this.pages);
        next.set(page.start, this.retain(page));
        this.pages = next;
        this.afterAdmission();
      } catch (error) {
        if (generation !== this.generation) return;
        this.handleFetchError(error, () => this.fetchOlderSlice(start, limit));
      } finally {
        if (generation === this.generation) {
          this.inFlightPages.delete(start);
        }
      }
    })();
    this.inFlightPages.set(start, request);
    return request;
  }

  /**
   * Two-step tail merge on prompt terminal. The validation fetch omits the
   * snapshot by design, so it always covers the server-computed newest
   * window and is never admitted itself (it overlaps retained coverage by
   * construction); only the clamped fill pages land on the grid.
   */
  async refreshTail(): Promise<void> {
    if (!this.enabled || this.status === 'unsupported') return;
    if (this.snapshot === undefined) return this.seed();
    if (this.tailRefresh !== undefined) return this.tailRefresh;
    const generation = this.generation;
    this.tailRefresh = (async () => {
      try {
        const validation = await this.fetchPage({ limit: this.pageSize });
        if (generation !== this.generation) return;
        const retainedByOrdinal = new Map<number, string>();
        for (const page of this.pages.values()) {
          for (const turn of page.turns) {
            retainedByOrdinal.set(turn.ordinal, turn.turnId);
          }
        }
        let overlap = 0;
        let mismatch = false;
        for (const turn of validation.turns) {
          const known = retainedByOrdinal.get(turn.ordinal);
          if (known === undefined) continue;
          overlap += 1;
          if (known !== turn.turnId) {
            mismatch = true;
            break;
          }
        }
        let largestCovered = -1;
        for (const ordinal of retainedByOrdinal.keys()) {
          if (ordinal > largestCovered) largestCovered = ordinal;
        }
        const divergent =
          mismatch ||
          overlap === 0 ||
          // The store holds ordinals the chain no longer has (a rewind or
          // truncation this client has not processed yet).
          largestCovered > validation.totalTurns - 1;
        if (divergent) {
          // Deliberately conservative: drop every snapshot-bound page and
          // admit the validation response as the new tail page.
          this.pages = new Map([[validation.start, this.retain(validation)]]);
          this.snapshot = validation.snapshot;
          this.totalTurns = validation.totalTurns;
          this.retryAttempts = 0;
          this.afterAdmission();
          return;
        }
        if (largestCovered === validation.totalTurns - 1) {
          // No new navigation turn — adopt the fresh snapshot/total only.
          this.snapshot = validation.snapshot;
          this.totalTurns = validation.totalTurns;
          this.retryAttempts = 0;
          this.afterAdmission();
          return;
        }
        // Append-only with new turns: clamped fill against the new
        // snapshot, chunked when the uncovered tail exceeds one page.
        const newSnapshot = validation.snapshot;
        let start = largestCovered + 1;
        while (start <= validation.totalTurns - 1) {
          const limit = Math.min(this.pageSize, validation.totalTurns - start);
          const fill = await this.fetchPage({
            snapshot: newSnapshot,
            start,
            limit,
          });
          if (generation !== this.generation) return;
          if (fill.snapshot !== newSnapshot || fill.turns.length === 0) {
            await this.invalidateAndReseed();
            return;
          }
          const next = new Map(this.pages);
          next.set(fill.start, this.retain(fill));
          this.pages = next;
          start = fill.start + fill.turns.length;
        }
        this.snapshot = newSnapshot;
        this.totalTurns = validation.totalTurns;
        this.retryAttempts = 0;
        this.afterAdmission();
      } catch (error) {
        if (generation !== this.generation) return;
        this.handleFetchError(error, () => {
          this.tailRefresh = undefined;
          return this.refreshTail();
        });
      } finally {
        if (generation === this.generation) this.tailRefresh = undefined;
      }
    })();
    return this.tailRefresh;
  }

  private retain(page: DaemonSessionTurnIndexPage): RetainedPage {
    return {
      snapshot: page.snapshot,
      turns: page.turns,
      lastUsed: ++this.lruClock,
      bytes: estimatePageBytes(page.turns),
    };
  }

  private afterAdmission(): void {
    this.reconcileLiveEntries();
    this.evictLru();
    this.notify();
  }

  /** LRU eviction; the newest page is pinned so tail refreshes keep overlap. */
  private evictLru(): void {
    let totalBytes = 0;
    let newestStart = -1;
    for (const [start, page] of this.pages) {
      totalBytes += page.bytes;
      if (start > newestStart) newestStart = start;
    }
    const next = new Map(this.pages);
    while (next.size > 1) {
      const overCount = next.size > this.maxPages;
      const overBytes = totalBytes > this.maxPageBytes;
      if (!overCount && !overBytes) break;
      let victimStart: number | undefined;
      let victimUsed = Infinity;
      for (const [start, page] of next) {
        if (start === newestStart) continue;
        if (page.lastUsed < victimUsed) {
          victimUsed = page.lastUsed;
          victimStart = start;
        }
      }
      if (victimStart === undefined) break;
      totalBytes -= next.get(victimStart)?.bytes ?? 0;
      next.delete(victimStart);
    }
    // Keep map identity stable when nothing was evicted: refresh paths
    // that admitted nothing must leave retained pages untouched.
    if (next.size !== this.pages.size) this.pages = next;
  }

  /**
   * A `live:` prompt provisional is removed exactly when an index entry
   * appears with the same `promptId`, or (legacy records without a prompt
   * id) when its persisted record UUID — linked from the admitted echo
   * block — appears as an index turn. Label/timestamp matching is
   * forbidden by design.
   */
  private reconcileLiveEntries(): void {
    if (!this.liveEntries.some((entry) => entry.kind === 'prompt')) return;
    const promptIds = new Set<string>();
    const turnIds = new Set<string>();
    for (const page of this.pages.values()) {
      for (const turn of page.turns) {
        turnIds.add(turn.turnId);
        if (turn.promptId !== undefined) promptIds.add(turn.promptId);
      }
    }
    const kept: LiveTurnEntry[] = [];
    let changed = false;
    for (const entry of this.liveEntries) {
      if (entry.kind !== 'prompt') {
        kept.push(entry);
        continue;
      }
      if (promptIds.has(entry.promptId)) {
        this.linkedRecordIds.delete(entry.id);
        changed = true;
        continue;
      }
      const linked = this.linkedRecordIds.get(entry.id);
      if (linked !== undefined && linked.some((id) => turnIds.has(id))) {
        this.linkedRecordIds.delete(entry.id);
        changed = true;
        continue;
      }
      kept.push(entry);
    }
    if (changed) this.liveEntries = kept;
  }

  addLivePrompt(input: { promptId: string; label: string }): void {
    if (!this.enabled || this.status === 'unsupported') return;
    if (
      this.liveEntries.some(
        (entry) => entry.kind === 'prompt' && entry.promptId === input.promptId,
      )
    ) {
      return;
    }
    this.liveEntries = [
      ...this.liveEntries,
      {
        id: `live:${input.promptId}`,
        kind: 'prompt',
        promptId: input.promptId,
        label: input.label,
      },
    ];
    this.notify();
  }

  addLiveShell(input: { blockId: string; label: string }): void {
    if (!this.enabled || this.status === 'unsupported') return;
    const id = `shell:${input.blockId}` as const;
    if (this.liveEntries.some((entry) => entry.id === id)) return;
    this.liveEntries = [
      ...this.liveEntries,
      { id, kind: 'shell', label: input.label },
    ];
    this.notify();
  }

  /** `shell:` overlays are live-only; removed when their live block is evicted. */
  removeLiveShell(blockId: string): void {
    const id = `shell:${blockId}`;
    if (!this.liveEntries.some((entry) => entry.id === id)) return;
    this.liveEntries = this.liveEntries.filter((entry) => entry.id !== id);
    this.notify();
  }

  /**
   * Link prompt provisionals to their persisted record UUID once the
   * persisted echo lands in admitted blocks (the legacy no-prompt-id
   * reconciliation path), then reconcile against the index.
   */
  observeAdmittedBlocks(blocks: readonly DaemonTranscriptBlock[]): void {
    if (!this.liveEntries.some((entry) => entry.kind === 'prompt')) return;
    for (const block of blocks) {
      if (block.promptId === undefined) continue;
      const recordIds = block.sourceRecordIds;
      if (recordIds === undefined || recordIds.length === 0) continue;
      const provisional = this.liveEntries.find(
        (entry) => entry.kind === 'prompt' && entry.promptId === block.promptId,
      );
      if (provisional !== undefined) {
        this.linkedRecordIds.set(provisional.id, recordIds);
      }
    }
    const before = this.liveEntries;
    this.reconcileLiveEntries();
    if (before !== this.liveEntries) this.notify();
  }

  /** Rewind: drop snapshot-bound pages and provisionals, then re-seed. */
  async handleRewind(): Promise<void> {
    if (!this.enabled || this.status === 'unsupported') return;
    this.liveEntries = this.liveEntries.filter(
      (entry) => entry.kind !== 'prompt',
    );
    this.linkedRecordIds.clear();
    await this.invalidateAndReseed();
  }

  private handleFetchError(error: unknown, retry: () => Promise<void>): void {
    const code = daemonErrorCode(error);
    if (code === 'transcript_too_large') {
      // The transcript exceeds the daemon's indexing ceiling; the rail
      // falls back to loaded messages for the rest of the session.
      this.markUnsupported();
      return;
    }
    if (
      code === 'transcript_snapshot_unavailable' ||
      code === 'invalid_transcript_cursor'
    ) {
      // Expected invalidation after snapshot replacement/rewind, not a
      // retryable error storm: drop the snapshot and re-seed the tail.
      this.generation += 1;
      void this.invalidateAndReseed();
      return;
    }
    // Anything else — including an index-path 413
    // `transcript_page_too_large`, which is structurally unreachable — is a
    // generic transient index failure: surface `error` and retry bounded.
    this.status = 'error';
    this.notify();
    if (this.retryAttempts >= MAX_RETRY_ATTEMPTS) return;
    const attempt = this.retryAttempts;
    this.retryAttempts += 1;
    const generation = this.generation;
    this.scheduleRetry(
      () => {
        if (generation !== this.generation) return;
        void retry();
      },
      RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!,
    );
  }
}
