/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  estimateDaemonTranscriptBlockBytes,
  type DaemonEvent,
  type DaemonSessionTranscriptPage,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';

export type FrozenTranscriptBoundaryRequest =
  | { kind: 'older'; beforeRecordId: string; snapshot: string }
  | { kind: 'cursor'; cursor: string }
  | {
      kind: 'gap';
      anchorRecordId: string;
      afterRecordId: string;
      snapshot: string;
    };

export interface TranscriptGapResolution {
  excludedRecordIds: readonly string[];
  fromAnchor: boolean;
}

export type TranscriptBoundary =
  | { kind: 'end' }
  | { kind: 'live' }
  | { kind: 'cached'; rangeId: string }
  | { kind: 'loadable'; request: FrozenTranscriptBoundaryRequest }
  | { kind: 'loading'; request: FrozenTranscriptBoundaryRequest }
  | {
      kind: 'error';
      request: FrozenTranscriptBoundaryRequest;
      retryable: boolean;
    };

export interface HistoricalTranscriptPage {
  id: string;
  snapshot: string;
  blocks: readonly DaemonTranscriptBlock[];
  recordIds: ReadonlySet<string>;
  firstRecordId?: string;
  lastRecordId?: string;
  retainedBytes: number;
  turnBlockById: ReadonlyMap<string, string>;
  newerRequest?: FrozenTranscriptBoundaryRequest;
}

export interface HistoricalTranscriptRange {
  id: string;
  anchorOrdinal: number;
  anchorTurnId: string;
  pageIds: readonly string[];
  older: TranscriptBoundary;
  newer: TranscriptBoundary;
}

export interface HistoricalTranscriptPageTableSnapshot {
  pages: ReadonlyMap<string, HistoricalTranscriptPage>;
  ranges: readonly HistoricalTranscriptRange[];
  retainedBytes: number;
}

export interface MaterializedTranscriptPage {
  blocks: readonly DaemonTranscriptBlock[];
  nextBlockOrdinal: number;
  encounteredRecordIds: readonly string[];
}

export interface HistoricalTranscriptPageTableOptions {
  maxPages: number;
  maxRetainedBytes: number;
  materialize(
    events: readonly DaemonEvent[],
    nextBlockOrdinal: number,
    excludedRecordIds: ReadonlySet<string>,
  ): MaterializedTranscriptPage;
}

export interface AdmittedHistoricalTarget {
  rangeId: string;
  pageId: string;
  blockId: string;
}

export class HistoricalTranscriptPageTooLargeError extends Error {
  constructor() {
    super('Historical transcript page exceeds the cache budget');
    this.name = 'HistoricalTranscriptPageTooLargeError';
  }
}

export class HistoricalTranscriptWindowFullError extends Error {
  constructor() {
    super('Historical transcript window is full; move the selection and retry');
    this.name = 'HistoricalTranscriptWindowFullError';
  }
}

type BoundaryDirection = 'older' | 'newer';

const EMPTY_SNAPSHOT: HistoricalTranscriptPageTableSnapshot = Object.freeze({
  pages: new Map(),
  ranges: Object.freeze([]),
  retainedBytes: 0,
});

export class HistoricalTranscriptPageTable {
  private snapshot = EMPTY_SNAPSHOT;
  private nextPageId = 1;
  private nextRangeId = 1;
  private nextBlockOrdinal = 1;
  private readonly rangeAccess = new Map<string, number>();
  private accessClock = 0;
  private selectedRangeId: string | undefined;
  private selectedPageId: string | undefined;
  private liveRecordIds = new Set<string>();
  private readonly cachedBoundaryRequests = new Map<
    string,
    FrozenTranscriptBoundaryRequest
  >();

  constructor(private readonly options: HistoricalTranscriptPageTableOptions) {
    if (!Number.isInteger(options.maxPages) || options.maxPages < 1) {
      throw new RangeError(
        'Historical transcript maxPages must be a positive integer',
      );
    }
  }

  getSnapshot(): HistoricalTranscriptPageTableSnapshot {
    return this.snapshot;
  }

  reset(): void {
    this.snapshot = EMPTY_SNAPSHOT;
    this.nextPageId = 1;
    this.nextRangeId = 1;
    this.nextBlockOrdinal = 1;
    this.rangeAccess.clear();
    this.selectedRangeId = undefined;
    this.selectedPageId = undefined;
    this.liveRecordIds.clear();
    this.cachedBoundaryRequests.clear();
  }

  setLiveRecordIds(recordIds: Iterable<string>): void {
    this.liveRecordIds = new Set(recordIds);
  }

  releaseLoadingBoundaries(): boolean {
    let changed = false;
    const ranges = this.snapshot.ranges.map((range) => {
      const older = releaseBoundary(range.older);
      const newer = releaseBoundary(range.newer);
      if (older === range.older && newer === range.newer) return range;
      changed = true;
      return Object.freeze({ ...range, older, newer });
    });
    if (!changed) return false;
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ranges: Object.freeze(ranges),
      retainedBytes: this.measureRetainedBytes(this.snapshot.pages, ranges),
    });
    return true;
  }

  findTurn(turnId: string): AdmittedHistoricalTarget | undefined {
    for (const range of this.snapshot.ranges) {
      for (const pageId of range.pageIds) {
        const blockId = this.snapshot.pages
          .get(pageId)
          ?.turnBlockById.get(turnId);
        if (blockId) {
          this.select(range.id, pageId);
          return { rangeId: range.id, pageId, blockId };
        }
      }
    }
    return undefined;
  }

  select(rangeId: string, pageId: string): void {
    const range = this.snapshot.ranges.find((item) => item.id === rangeId);
    if (!range?.pageIds.includes(pageId)) return;
    this.selectedRangeId = rangeId;
    this.selectedPageId = pageId;
    this.touch(rangeId);
  }

  admitAnchor(
    ordinal: number,
    turnId: string,
    snapshot: string,
    response: DaemonSessionTranscriptPage,
  ): AdmittedHistoricalTarget {
    assertContinuationCursor(response);
    if (response.targetRecordId !== turnId) {
      throw new Error(
        'Anchored transcript response did not contain its target',
      );
    }
    const cached = this.findTurn(turnId);
    if (cached) return cached;

    const knownRecordIds = this.liveRecordIds;
    const materialized = this.materializePage(
      snapshot,
      response.events,
      knownRecordIds,
    );
    const reachedLive = [...materialized.encounteredRecordIds].some(
      (recordId) => this.liveRecordIds.has(recordId),
    );
    const filteredBlocks = filterOverlappingBlocks(
      materialized.page.blocks,
      knownRecordIds,
    );
    const filteredPage =
      filteredBlocks.length === materialized.page.blocks.length
        ? materialized.page
        : this.pageFromBlocks(materialized.page.id, snapshot, filteredBlocks);
    const page = this.withNewerRequest(filteredPage, forwardRequest(response));
    const blockId = page.turnBlockById.get(turnId);
    if (!blockId) {
      throw new Error('Anchored transcript target could not be materialized');
    }
    this.assertPageFits(page);

    const rangeId = `history-range-${this.nextRangeId++}`;
    const older: TranscriptBoundary =
      response.hasOlder && page.firstRecordId
        ? {
            kind: 'loadable',
            request: {
              kind: 'older',
              beforeRecordId: page.firstRecordId,
              snapshot,
            },
          }
        : { kind: 'end' };
    const newer: TranscriptBoundary = reachedLive
      ? { kind: 'live' }
      : response.hasMore && response.nextCursor
        ? {
            kind: 'loadable',
            request: { kind: 'cursor', cursor: response.nextCursor },
          }
        : { kind: 'end' };
    const range: HistoricalTranscriptRange = Object.freeze({
      id: rangeId,
      anchorOrdinal: ordinal,
      anchorTurnId: turnId,
      pageIds: Object.freeze([page.id]),
      older,
      newer,
    });
    if (
      this.measureRetainedBytes(new Map([[page.id, page]]), [range]) >
      this.options.maxRetainedBytes
    ) {
      throw new HistoricalTranscriptPageTooLargeError();
    }
    const pages = new Map(this.snapshot.pages);
    let retainedRanges = [...this.snapshot.ranges];
    for (const cachedRange of this.snapshot.ranges) {
      if (
        !cachedRange.pageIds.some((pageId) =>
          [...(pages.get(pageId)?.recordIds ?? [])].some((recordId) =>
            page.recordIds.has(recordId),
          ),
        )
      ) {
        continue;
      }
      // A cursor after this anchor cannot recover records deduplicated into
      // another range. Replace overlapping ranges instead of creating a gap.
      retainedRanges = this.restoreCachedBoundaries(
        retainedRanges.filter((item) => item.id !== cachedRange.id),
        cachedRange.id,
      );
      for (const pageId of cachedRange.pageIds) pages.delete(pageId);
      this.rangeAccess.delete(cachedRange.id);
      this.cachedBoundaryRequests.delete(
        this.boundaryKey(cachedRange.id, 'older'),
      );
      this.cachedBoundaryRequests.delete(
        this.boundaryKey(cachedRange.id, 'newer'),
      );
    }
    pages.set(page.id, page);
    const ranges = Object.freeze([...retainedRanges, range]);
    this.snapshot = Object.freeze({
      pages,
      ranges,
      retainedBytes: this.measureRetainedBytes(pages, ranges),
    });
    this.select(rangeId, page.id);
    this.evict(rangeId, page.id);
    return { rangeId, pageId: page.id, blockId };
  }

  beginBoundaryLoad(
    rangeId: string,
    direction: BoundaryDirection,
  ): FrozenTranscriptBoundaryRequest | undefined {
    const range = this.snapshot.ranges.find((item) => item.id === rangeId);
    const boundary = range?.[direction];
    if (!range || (boundary?.kind === 'error' && !boundary.retryable)) {
      return undefined;
    }
    if (boundary?.kind !== 'loadable' && boundary?.kind !== 'error') {
      return undefined;
    }
    const request = boundary.request;
    this.replaceRange(rangeId, {
      ...range,
      [direction]: { kind: 'loading', request },
    });
    return request;
  }

  failBoundaryLoad(
    rangeId: string,
    direction: BoundaryDirection,
    request: FrozenTranscriptBoundaryRequest,
    retryable: boolean,
  ): void {
    const range = this.snapshot.ranges.find((item) => item.id === rangeId);
    if (!range || range[direction].kind !== 'loading') return;
    this.replaceRange(rangeId, {
      ...range,
      [direction]: { kind: 'error', request, retryable },
    });
  }

  admitBoundary(
    rangeId: string,
    direction: BoundaryDirection,
    snapshot: string,
    response: DaemonSessionTranscriptPage,
    recovery?: TranscriptGapResolution,
  ): void {
    const previousSnapshot = this.snapshot;
    const previousCachedBoundaryRequests = new Map(this.cachedBoundaryRequests);
    const previousRangeAccess = new Map(this.rangeAccess);
    try {
      this.admitBoundaryPage(rangeId, direction, snapshot, response, recovery);
    } catch (error) {
      this.snapshot = previousSnapshot;
      this.cachedBoundaryRequests.clear();
      for (const [key, request] of previousCachedBoundaryRequests) {
        this.cachedBoundaryRequests.set(key, request);
      }
      this.rangeAccess.clear();
      for (const [key, access] of previousRangeAccess) {
        this.rangeAccess.set(key, access);
      }
      throw error;
    }
  }

  private admitBoundaryPage(
    rangeId: string,
    direction: BoundaryDirection,
    snapshot: string,
    response: DaemonSessionTranscriptPage,
    recovery?: TranscriptGapResolution,
  ): void {
    assertContinuationCursor(response);
    const range = this.snapshot.ranges.find((item) => item.id === rangeId);
    if (!range || range[direction].kind !== 'loading') return;
    const admittedRequest = range[direction].request;
    const knownRecordIds = this.allRecordIds();
    for (const recordId of recovery?.excludedRecordIds ?? []) {
      knownRecordIds.add(recordId);
    }
    const materialized = this.materializePage(
      snapshot,
      response.events,
      knownRecordIds,
    );
    const page = materialized.page;
    const reachedLive =
      direction === 'newer' &&
      [...materialized.encounteredRecordIds].some((recordId) =>
        this.liveRecordIds.has(recordId),
      );
    const cachedRangeId = this.findOverlappingRange(
      materialized.encounteredRecordIds,
      rangeId,
      direction,
    );
    const blocks = filterOverlappingBlocks(page.blocks, knownRecordIds);
    const filteredPage =
      blocks.length === page.blocks.length
        ? page
        : this.pageFromBlocks(page.id, snapshot, blocks);
    const newerRequest =
      (direction === 'older' || (recovery && !recovery.fromAnchor)) &&
      filteredPage.lastRecordId
        ? {
            kind: 'gap' as const,
            anchorRecordId: range.anchorTurnId,
            afterRecordId: filteredPage.lastRecordId,
            snapshot,
          }
        : forwardRequest(response);
    const admittedPage = this.withNewerRequest(filteredPage, newerRequest);
    if (admittedPage.blocks.length === 0) {
      if (recovery && !recovery.fromAnchor && !reachedLive && !cachedRangeId) {
        throw new Error('Gap recovery did not materialize newer records');
      }
      this.finishBoundaryWithoutPage(
        range,
        direction,
        response,
        reachedLive,
        cachedRangeId,
      );
      const activeRangeId = this.selectedRangeId ?? rangeId;
      const activeRange = this.snapshot.ranges.find(
        (item) => item.id === activeRangeId,
      );
      this.evict(
        activeRangeId,
        this.selectedPageId ?? activeRange?.pageIds[0] ?? range.pageIds[0]!,
        activeRangeId === rangeId
          ? { direction, request: admittedRequest }
          : undefined,
      );
      return;
    }
    this.assertPageFits(admittedPage);

    const pages = new Map(this.snapshot.pages);
    pages.set(admittedPage.id, admittedPage);
    const pageIds =
      direction === 'older'
        ? [admittedPage.id, ...range.pageIds]
        : [...range.pageIds, admittedPage.id];
    const boundary = reachedLive
      ? ({ kind: 'live' } as const)
      : cachedRangeId
        ? this.cachedBoundary(
            rangeId,
            direction,
            cachedRangeId,
            admittedRequest,
          )
        : direction === 'newer'
          ? requestBoundary(newerRequest)
          : this.nextBoundary(direction, snapshot, admittedPage, response);
    const nextRange = Object.freeze({
      ...range,
      pageIds: Object.freeze(pageIds),
      [direction]: boundary,
    });
    const ranges = Object.freeze(
      this.restoreCachedBoundaries(this.snapshot.ranges, rangeId).map((item) =>
        item.id === rangeId ? nextRange : item,
      ),
    );
    this.snapshot = Object.freeze({
      pages,
      ranges,
      retainedBytes: this.measureRetainedBytes(pages, ranges),
    });
    this.touch(rangeId);
    const activeRangeId = this.selectedRangeId ?? rangeId;
    const activeRange = this.snapshot.ranges.find(
      (item) => item.id === activeRangeId,
    );
    this.evict(
      activeRangeId,
      this.selectedPageId ?? activeRange?.pageIds[0] ?? range.pageIds[0]!,
      activeRangeId === rangeId
        ? { direction, request: admittedRequest, pageId: admittedPage.id }
        : undefined,
    );
  }

  private materializePage(
    snapshot: string,
    events: readonly DaemonEvent[],
    excludedRecordIds: ReadonlySet<string>,
  ): {
    page: HistoricalTranscriptPage;
    encounteredRecordIds: ReadonlySet<string>;
  } {
    const result = this.options.materialize(
      events,
      this.nextBlockOrdinal,
      excludedRecordIds,
    );
    this.nextBlockOrdinal = Math.max(
      this.nextBlockOrdinal,
      result.nextBlockOrdinal,
    );
    const pageId = `history-page-${this.nextPageId++}`;
    const page = this.pageFromBlocks(
      pageId,
      snapshot,
      result.blocks.map((block) => ({
        ...block,
        id: `${pageId}:${block.id}`,
        ...(block.kind === 'tool' && block.parentBlockId
          ? { parentBlockId: `${pageId}:${block.parentBlockId}` }
          : {}),
      })),
    );
    return {
      page,
      encounteredRecordIds: new Set(result.encounteredRecordIds),
    };
  }

  private pageFromBlocks(
    id: string,
    snapshot: string,
    blocks: readonly DaemonTranscriptBlock[],
  ): HistoricalTranscriptPage {
    const recordIds = new Set<string>();
    const turnBlockById = new Map<string, string>();
    let retainedBytes = 160 + id.length * 2 + snapshot.length * 2;
    for (const block of blocks) {
      retainedBytes += estimateDaemonTranscriptBlockBytes(block);
      for (const recordId of block.sourceRecordIds ?? []) {
        recordIds.add(recordId);
        if (block.kind === 'user') turnBlockById.set(recordId, block.id);
      }
    }
    retainedBytes += recordIds.size * 48 + turnBlockById.size * 48;
    const orderedIds = [...recordIds];
    return Object.freeze({
      id,
      snapshot,
      blocks: Object.freeze([...blocks]),
      recordIds,
      firstRecordId: orderedIds[0],
      lastRecordId: orderedIds.at(-1),
      retainedBytes,
      turnBlockById,
    });
  }

  private assertPageFits(page: HistoricalTranscriptPage): void {
    if (page.retainedBytes > this.options.maxRetainedBytes) {
      throw new HistoricalTranscriptPageTooLargeError();
    }
  }

  private withNewerRequest(
    page: HistoricalTranscriptPage,
    newerRequest: FrozenTranscriptBoundaryRequest | undefined,
  ): HistoricalTranscriptPage {
    return Object.freeze({
      ...page,
      ...(newerRequest ? { newerRequest } : {}),
      retainedBytes: page.retainedBytes + requestBytes(newerRequest),
    });
  }

  private nextBoundary(
    direction: BoundaryDirection,
    snapshot: string,
    page: HistoricalTranscriptPage,
    response: DaemonSessionTranscriptPage,
  ): TranscriptBoundary {
    assertContinuationCursor(response);
    if (direction === 'older') {
      if (!response.hasMore) return { kind: 'end' };
      return page.firstRecordId
        ? {
            kind: 'loadable',
            request: {
              kind: 'older',
              beforeRecordId: page.firstRecordId,
              snapshot,
            },
          }
        : {
            kind: 'loadable',
            request: { kind: 'cursor', cursor: response.nextCursor },
          };
    }
    return response.hasMore && response.nextCursor
      ? {
          kind: 'loadable',
          request: { kind: 'cursor', cursor: response.nextCursor },
        }
      : { kind: 'end' };
  }

  private finishBoundaryWithoutPage(
    range: HistoricalTranscriptRange,
    direction: BoundaryDirection,
    response: DaemonSessionTranscriptPage,
    reachedLive: boolean,
    cachedRangeId: string | undefined,
  ): void {
    assertContinuationCursor(response);
    const current = range[direction];
    if (current.kind !== 'loading') return;
    const terminal: TranscriptBoundary = reachedLive
      ? { kind: 'live' }
      : cachedRangeId
        ? this.cachedBoundary(
            range.id,
            direction,
            cachedRangeId,
            current.request,
          )
        : response.hasMore
          ? {
              kind: 'loadable',
              request: { kind: 'cursor', cursor: response.nextCursor },
            }
          : { kind: 'end' };
    this.replaceRange(range.id, { ...range, [direction]: terminal });
  }

  private allRecordIds(): Set<string> {
    const ids = new Set(this.liveRecordIds);
    for (const page of this.snapshot.pages.values()) {
      for (const id of page.recordIds) {
        ids.add(id);
      }
    }
    return ids;
  }

  private findOverlappingRange(
    recordIds: ReadonlySet<string>,
    excludedRangeId: string,
    direction: BoundaryDirection,
  ): string | undefined {
    const encountered = [...recordIds];
    for (const range of this.snapshot.ranges) {
      if (range.id === excludedRangeId) continue;
      const edgePageId =
        direction === 'older' ? range.pageIds.at(-1) : range.pageIds[0];
      const edgePage = edgePageId
        ? this.snapshot.pages.get(edgePageId)
        : undefined;
      const edgeRecordId =
        direction === 'older'
          ? edgePage?.lastRecordId
          : edgePage?.firstRecordId;
      if (!edgeRecordId) continue;
      const edgeIndex = encountered.indexOf(edgeRecordId);
      if (edgeIndex < 0) continue;
      const rangeRecordIds = new Set<string>();
      for (const pageId of range.pageIds) {
        for (const recordId of this.snapshot.pages.get(pageId)?.recordIds ??
          []) {
          rangeRecordIds.add(recordId);
        }
      }
      const overlapBand =
        direction === 'older'
          ? encountered.slice(0, edgeIndex + 1)
          : encountered.slice(edgeIndex);
      if (overlapBand.every((recordId) => rangeRecordIds.has(recordId))) {
        return range.id;
      }
    }
    return undefined;
  }

  private cachedBoundary(
    rangeId: string,
    direction: BoundaryDirection,
    cachedRangeId: string,
    request: FrozenTranscriptBoundaryRequest,
  ): TranscriptBoundary {
    this.cachedBoundaryRequests.set(
      this.boundaryKey(rangeId, direction),
      request,
    );
    return { kind: 'cached', rangeId: cachedRangeId };
  }

  private boundaryKey(rangeId: string, direction: BoundaryDirection): string {
    return `${rangeId}:${direction}`;
  }

  private replaceRange(rangeId: string, next: HistoricalTranscriptRange): void {
    const ranges = Object.freeze(
      this.snapshot.ranges.map((range) =>
        range.id === rangeId ? Object.freeze(next) : range,
      ),
    );
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ranges,
      retainedBytes: this.measureRetainedBytes(this.snapshot.pages, ranges),
    });
    this.touch(rangeId);
  }

  private touch(rangeId: string): void {
    this.rangeAccess.set(rangeId, ++this.accessClock);
  }

  private evict(
    activeRangeId: string,
    targetPageId: string,
    admittedBoundary?: {
      direction: BoundaryDirection;
      request: FrozenTranscriptBoundaryRequest;
      pageId?: string;
    },
  ): void {
    const pages = new Map(this.snapshot.pages);
    let ranges = [...this.snapshot.ranges];
    const overBudget = () =>
      pages.size > this.options.maxPages ||
      this.measureRetainedBytes(pages, ranges) > this.options.maxRetainedBytes;

    while (overBudget()) {
      const inactive = ranges
        .filter((range) => range.id !== activeRangeId)
        .sort(
          (left, right) =>
            (this.rangeAccess.get(left.id) ?? 0) -
            (this.rangeAccess.get(right.id) ?? 0),
        )[0];
      if (inactive) {
        ranges = ranges.filter((range) => range.id !== inactive.id);
        ranges = this.restoreCachedBoundaries(ranges, inactive.id);
        for (const pageId of inactive.pageIds) {
          pages.delete(pageId);
        }
        this.cachedBoundaryRequests.delete(
          this.boundaryKey(inactive.id, 'older'),
        );
        this.cachedBoundaryRequests.delete(
          this.boundaryKey(inactive.id, 'newer'),
        );
        this.rangeAccess.delete(inactive.id);
        continue;
      }
      const active = ranges.find((range) => range.id === activeRangeId);
      if (!active || active.pageIds.length <= 1) {
        if (active && admittedBoundary) {
          this.cachedBoundaryRequests.delete(
            this.boundaryKey(active.id, admittedBoundary.direction),
          );
          ranges = ranges.map((range) =>
            range.id === active.id
              ? Object.freeze({
                  ...range,
                  [admittedBoundary.direction]: {
                    kind: 'loading' as const,
                    request: admittedBoundary.request,
                  },
                })
              : range,
          );
          this.snapshot = Object.freeze({
            pages,
            ranges: Object.freeze(ranges),
            retainedBytes: this.measureRetainedBytes(pages, ranges),
          });
          throw new HistoricalTranscriptWindowFullError();
        }
        break;
      }
      const edges =
        admittedBoundary?.direction === 'older'
          ? [active.pageIds.at(-1), active.pageIds[0]]
          : [active.pageIds[0], active.pageIds.at(-1)];
      const removable = edges.find(
        (pageId) =>
          pageId !== targetPageId && pageId !== admittedBoundary?.pageId,
      );
      if (!removable) throw new HistoricalTranscriptWindowFullError();
      const removedFirst = removable === active.pageIds[0];
      pages.delete(removable);
      const pageIds = active.pageIds.filter((pageId) => pageId !== removable);
      const firstPage = pageIds[0] ? pages.get(pageIds[0]) : undefined;
      const lastPage = pages.get(pageIds.at(-1)!);
      if (!removedFirst && !lastPage?.newerRequest) {
        throw new HistoricalTranscriptWindowFullError();
      }
      if (removedFirst) {
        this.cachedBoundaryRequests.delete(
          this.boundaryKey(active.id, 'older'),
        );
      } else {
        this.cachedBoundaryRequests.delete(
          this.boundaryKey(active.id, 'newer'),
        );
      }
      ranges = this.restoreCachedBoundaries(ranges, active.id);
      ranges = ranges.map((range) =>
        range.id === active.id
          ? Object.freeze({
              ...range,
              pageIds: Object.freeze(pageIds),
              ...(removedFirst && firstPage?.firstRecordId
                ? {
                    older: {
                      kind: 'loadable' as const,
                      request: {
                        kind: 'older' as const,
                        beforeRecordId: firstPage.firstRecordId,
                        snapshot: firstPage.snapshot,
                      },
                    },
                  }
                : removedFirst && admittedBoundary?.direction === 'older'
                  ? {
                      older: {
                        kind: 'loadable' as const,
                        request: admittedBoundary.request,
                      },
                    }
                  : !removedFirst
                    ? {
                        newer: requestBoundary(lastPage?.newerRequest),
                      }
                    : {}),
            })
          : range,
      );
    }
    this.snapshot = Object.freeze({
      pages,
      ranges: Object.freeze(ranges),
      retainedBytes: this.measureRetainedBytes(pages, ranges),
    });
  }

  private measureRetainedBytes(
    pages: ReadonlyMap<string, HistoricalTranscriptPage>,
    ranges: readonly HistoricalTranscriptRange[],
  ): number {
    let bytes = 128;
    for (const page of pages.values()) bytes += page.retainedBytes;
    for (const range of ranges) {
      bytes +=
        128 +
        range.id.length * 2 +
        range.anchorTurnId.length * 2 +
        range.pageIds.length * 24;
      bytes += this.measureBoundaryBytes(range.id, 'older', range.older);
      bytes += this.measureBoundaryBytes(range.id, 'newer', range.newer);
    }
    return bytes;
  }

  private measureBoundaryBytes(
    rangeId: string,
    direction: BoundaryDirection,
    boundary: TranscriptBoundary,
  ): number {
    if (boundary.kind === 'end' || boundary.kind === 'live') return 24;
    if (boundary.kind === 'cached') {
      const request = this.cachedBoundaryRequests.get(
        this.boundaryKey(rangeId, direction),
      );
      return 48 + boundary.rangeId.length * 2 + requestBytes(request);
    }
    return 48 + requestBytes(boundary.request);
  }

  private restoreCachedBoundaries(
    ranges: readonly HistoricalTranscriptRange[],
    removedRangeId: string,
  ): HistoricalTranscriptRange[] {
    return ranges.map((range) => {
      const older = this.restoreCachedBoundary(range, 'older', removedRangeId);
      const newer = this.restoreCachedBoundary(range, 'newer', removedRangeId);
      return older === range.older && newer === range.newer
        ? range
        : Object.freeze({ ...range, older, newer });
    });
  }

  private restoreCachedBoundary(
    range: HistoricalTranscriptRange,
    direction: BoundaryDirection,
    removedRangeId: string,
  ): TranscriptBoundary {
    const boundary = range[direction];
    if (boundary.kind !== 'cached' || boundary.rangeId !== removedRangeId) {
      return boundary;
    }
    const key = this.boundaryKey(range.id, direction);
    const request = this.cachedBoundaryRequests.get(key);
    this.cachedBoundaryRequests.delete(key);
    if (!request) {
      throw new Error('Cached transcript boundary lost its request');
    }
    return { kind: 'loadable', request };
  }
}

function filterOverlappingBlocks(
  blocks: readonly DaemonTranscriptBlock[],
  knownRecordIds: ReadonlySet<string>,
): DaemonTranscriptBlock[] {
  return blocks.filter(
    (block) =>
      !block.sourceRecordIds?.some((recordId) => knownRecordIds.has(recordId)),
  );
}

function requestBytes(
  request: FrozenTranscriptBoundaryRequest | undefined,
): number {
  if (!request) return 0;
  if (request.kind === 'gap') {
    return (
      80 +
      2 *
        (request.anchorRecordId.length +
          request.afterRecordId.length +
          request.snapshot.length)
    );
  }
  return request.kind === 'older'
    ? 64 + request.beforeRecordId.length * 2 + request.snapshot.length * 2
    : 48 + request.cursor.length * 2;
}

function forwardRequest(
  response: DaemonSessionTranscriptPage,
): FrozenTranscriptBoundaryRequest | undefined {
  return response.hasMore && response.nextCursor
    ? { kind: 'cursor', cursor: response.nextCursor }
    : undefined;
}

function requestBoundary(
  request: FrozenTranscriptBoundaryRequest | undefined,
): TranscriptBoundary {
  return request ? { kind: 'loadable', request } : { kind: 'end' };
}

function releaseBoundary(boundary: TranscriptBoundary): TranscriptBoundary {
  return boundary.kind === 'loading'
    ? { kind: 'loadable', request: boundary.request }
    : boundary;
}

function assertContinuationCursor(
  response: DaemonSessionTranscriptPage,
): asserts response is DaemonSessionTranscriptPage &
  ({ hasMore: false } | { hasMore: true; nextCursor: string }) {
  if (response.hasMore && !response.nextCursor) {
    throw new Error('Transcript continuation response omitted its cursor');
  }
}
