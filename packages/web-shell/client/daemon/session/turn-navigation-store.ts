/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonEvent,
  DaemonSessionTranscriptPage,
  DaemonSessionTranscriptPageOptions,
  DaemonSessionTurnIndexEntry,
  DaemonSessionTurnIndexPage,
  DaemonSessionTurnIndexPageOptions,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import {
  WEB_SHELL_HISTORY_PAGE_SIZE,
  WEB_SHELL_HISTORICAL_MAX_BYTES,
  WEB_SHELL_HISTORICAL_MAX_PAGES,
  WEB_SHELL_TURN_INDEX_MAX_BYTES,
  WEB_SHELL_TURN_INDEX_MAX_PAGES,
  WEB_SHELL_TURN_INDEX_PAGE_SIZE,
} from '../../constants/sessions.js';
import { extractHttpStatus } from './httpErrors.js';
import {
  HistoricalTranscriptPageTooLargeError,
  HistoricalTranscriptPageTable,
  type HistoricalTranscriptPage,
  type HistoricalTranscriptRange,
  type MaterializedTranscriptPage,
  type TranscriptGapResolution,
} from './transcript-page-table.js';

class TurnIndexPageTooLargeError extends Error {
  constructor() {
    super('Turn-index page exceeds the cache budget');
    this.name = 'TurnIndexPageTooLargeError';
  }
}

export interface DaemonTurnIndexPage {
  start: number;
  end: number;
  snapshot: string;
  turns: readonly DaemonSessionTurnIndexEntry[];
  retainedBytes: number;
}

export interface DaemonProvisionalTurn {
  provisionalId: string;
  promptId: string;
  label: string;
  blockId?: string;
}

export interface DaemonTurnLocation {
  turnId: string;
  blockId: string;
  view: 'live' | 'historical';
  rangeId?: string;
  pageId?: string;
}

export interface DaemonSelectedTurnState {
  ordinal: number;
  turnId?: string;
  status: 'loading' | 'ready' | 'unavailable';
  location?: DaemonTurnLocation;
}

export interface DaemonTurnNavigationError {
  operation: 'index' | 'locate' | 'older' | 'newer';
  message: string;
  retryable: boolean;
  rangeId?: string;
  ordinal?: number;
}

export interface DaemonTurnNavigationSnapshot {
  sessionId?: string;
  mode: 'legacy' | 'loading' | 'ready' | 'degraded';
  fallbackReason?: 'unsupported' | 'too_large' | 'initial_error';
  totalTurns: number;
  effectiveTurnCount: number;
  indexPages: ReadonlyMap<number, DaemonTurnIndexPage>;
  provisionalTurns: readonly DaemonProvisionalTurn[];
  historicalPages: ReadonlyMap<string, HistoricalTranscriptPage>;
  historicalRanges: readonly HistoricalTranscriptRange[];
  locations: ReadonlyMap<string, DaemonTurnLocation>;
  selected?: DaemonSelectedTurnState;
  error?: DaemonTurnNavigationError;
}

export interface DaemonTurnNavigationClient {
  owner: object;
  getTurnIndexPage(
    options: DaemonSessionTurnIndexPageOptions,
  ): Promise<DaemonSessionTurnIndexPage>;
  getTranscriptPage(
    options: DaemonSessionTranscriptPageOptions,
  ): Promise<DaemonSessionTranscriptPage>;
  materializeTranscriptEvents(
    events: readonly DaemonEvent[],
    nextBlockOrdinal: number,
    excludedRecordIds: ReadonlySet<string>,
  ): MaterializedTranscriptPage;
}

export interface DaemonTurnNavigationSession {
  sessionId?: string;
  supported: boolean;
  client?: DaemonTurnNavigationClient;
}

export interface DaemonPromptAdmission {
  promptId: string;
  label: string;
  blockId?: string;
}

export interface DaemonTurnNavigationStore {
  getSnapshot(): DaemonTurnNavigationSnapshot;
  subscribe(listener: () => void): () => void;
  configure(session: DaemonTurnNavigationSession): void;
  observeLiveBlocks(blocks: readonly DaemonTranscriptBlock[]): void;
  recordPromptAdmitted(admission: DaemonPromptAdmission): void;
  recordPromptRemoved(promptId: string): void;
  handleSessionEvent(type: string): void;
  loadOrdinal(ordinal: number): Promise<void>;
  locateOrdinal(ordinal: number): Promise<DaemonTurnLocation>;
  refreshHead(): Promise<void>;
  loadOlder(rangeId: string): Promise<void>;
  loadNewer(rangeId: string): Promise<void>;
  retry(): Promise<void>;
}

export interface CreateDaemonTurnNavigationStoreOptions {
  indexPageSize?: number;
  maxIndexPages?: number;
  maxIndexBytes?: number;
  maxHistoricalPages?: number;
  maxHistoricalBytes?: number;
}

const EMPTY_MAP = new Map<never, never>();
const EMPTY_SNAPSHOT: DaemonTurnNavigationSnapshot = Object.freeze({
  mode: 'legacy',
  fallbackReason: 'unsupported',
  totalTurns: 0,
  effectiveTurnCount: 0,
  indexPages: EMPTY_MAP,
  provisionalTurns: Object.freeze([]),
  historicalPages: EMPTY_MAP,
  historicalRanges: Object.freeze([]),
  locations: EMPTY_MAP,
});

interface InternalIndexPage extends DaemonTurnIndexPage {
  accessedAt: number;
}

export function createDaemonTurnNavigationStore(
  options: CreateDaemonTurnNavigationStoreOptions = {},
): DaemonTurnNavigationStore {
  const indexPageSize = options.indexPageSize ?? WEB_SHELL_TURN_INDEX_PAGE_SIZE;
  const maxIndexPages = options.maxIndexPages ?? WEB_SHELL_TURN_INDEX_MAX_PAGES;
  const maxIndexBytes = options.maxIndexBytes ?? WEB_SHELL_TURN_INDEX_MAX_BYTES;
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_SNAPSHOT;
  let sessionId: string | undefined;
  let client: DaemonTurnNavigationClient | undefined;
  let clientOwner: object | undefined;
  let clientWasConnected = false;
  let sessionEpoch = 0;
  let chainEpoch = 0;
  let selectionGeneration = 0;
  let accessClock = 0;
  let pages = new Map<number, InternalIndexPage>();
  let provisionals: DaemonProvisionalTurn[] = [];
  const removedPromptIds = new Set<string>();
  let liveLocations = new Map<string, DaemonTurnLocation>();
  let livePromptAliases = new Map<string, DaemonTurnLocation>();
  let liveRecordIds = new Set<string>();
  let liveBlockIdByPromptId = new Map<string, string>();
  let lastLiveBlocks: readonly DaemonTranscriptBlock[] | undefined;
  let headRequest: Promise<void> | undefined;
  let headDirty = false;
  let headRetryPending = false;
  let tooLarge = false;
  let pageTable = createPageTable();

  function createPageTable(): HistoricalTranscriptPageTable {
    return new HistoricalTranscriptPageTable({
      maxPages: options.maxHistoricalPages ?? WEB_SHELL_HISTORICAL_MAX_PAGES,
      maxRetainedBytes:
        options.maxHistoricalBytes ?? WEB_SHELL_HISTORICAL_MAX_BYTES,
      materialize(events, nextBlockOrdinal, excludedRecordIds) {
        if (!client)
          throw new Error('Session navigation client is unavailable');
        return client.materializeTranscriptEvents(
          events,
          nextBlockOrdinal,
          excludedRecordIds,
        );
      },
    });
  }

  function isCurrentClient(candidate: DaemonTurnNavigationClient): boolean {
    return client?.owner === candidate.owner;
  }

  function publish(update: Partial<DaemonTurnNavigationSnapshot> = {}): void {
    const table = pageTable.getSnapshot();
    const error = 'error' in update ? update.error : snapshot.error;
    const boundaryOperation =
      error?.operation === 'older' || error?.operation === 'newer'
        ? error.operation
        : undefined;
    const obsoleteBoundaryError =
      boundaryOperation !== undefined &&
      !table.ranges.some(
        (range) =>
          range.id === error?.rangeId &&
          range[boundaryOperation].kind === 'error',
      );
    const indexedTurnIds = new Set(
      [...indexedEntries(pages).values()].map((entry) => entry.turnId),
    );
    const locations = new Map<string, DaemonTurnLocation>();
    for (const [turnId, location] of liveLocations) {
      if (indexedTurnIds.has(turnId)) locations.set(turnId, location);
    }
    for (const [turnId, location] of livePromptAliases) {
      if (indexedTurnIds.has(turnId) && !locations.has(turnId)) {
        locations.set(turnId, location);
      }
    }
    for (const range of table.ranges) {
      for (const pageId of range.pageIds) {
        const page = table.pages.get(pageId);
        if (!page) continue;
        for (const [turnId, blockId] of page.turnBlockById) {
          if (indexedTurnIds.has(turnId) && !locations.has(turnId)) {
            locations.set(turnId, {
              turnId,
              blockId,
              view: 'historical',
              rangeId: range.id,
              pageId,
            });
          }
        }
      }
    }
    snapshot = Object.freeze({
      ...snapshot,
      ...update,
      error: obsoleteBoundaryError ? undefined : error,
      sessionId,
      indexPages: new Map(
        [...pages.entries()].map(([start, page]) => [
          start,
          publicIndexPage(page),
        ]),
      ),
      provisionalTurns: Object.freeze([...provisionals]),
      effectiveTurnCount:
        (update.totalTurns ?? snapshot.totalTurns) + provisionals.length,
      historicalPages: table.pages,
      historicalRanges: table.ranges,
      locations,
    });
    for (const listener of listeners) listener();
  }

  function resetForSession(nextSessionId?: string): void {
    sessionId = nextSessionId;
    sessionEpoch += 1;
    chainEpoch += 1;
    selectionGeneration += 1;
    client = undefined;
    clientOwner = undefined;
    clientWasConnected = false;
    pages = new Map();
    provisionals = [];
    removedPromptIds.clear();
    liveLocations = new Map();
    livePromptAliases = new Map();
    liveBlockIdByPromptId = new Map();
    liveRecordIds = new Set();
    lastLiveBlocks = undefined;
    headRequest = undefined;
    headDirty = false;
    headRetryPending = false;
    tooLarge = false;
    pageTable = createPageTable();
    snapshot = Object.freeze({
      ...EMPTY_SNAPSHOT,
      sessionId: nextSessionId,
    });
  }

  function resetChain(): void {
    chainEpoch += 1;
    selectionGeneration += 1;
    pages = new Map();
    provisionals = [];
    removedPromptIds.clear();
    livePromptAliases = new Map();
    headRetryPending = false;
    pageTable.reset();
    syncLiveRecordIds();
    snapshot = Object.freeze({
      ...snapshot,
      totalTurns: 0,
      effectiveTurnCount: 0,
      indexPages: new Map(),
      historicalPages: new Map(),
      historicalRanges: Object.freeze([]),
      locations: new Map(),
      selected: undefined,
      error: undefined,
    });
  }

  function configure(next: DaemonTurnNavigationSession): void {
    const sessionChanged = next.sessionId !== sessionId;
    if (sessionChanged) resetForSession(next.sessionId);
    if (!next.sessionId || !next.supported) {
      if (
        !sessionChanged &&
        (client !== undefined ||
          snapshot.mode !== 'legacy' ||
          snapshot.fallbackReason !== 'unsupported')
      ) {
        sessionEpoch += 1;
        chainEpoch += 1;
        selectionGeneration += 1;
        headRequest = undefined;
        headDirty = false;
      }
      client = undefined;
      clientOwner = undefined;
      clientWasConnected = false;
      provisionals = [];
      removedPromptIds.clear();
      livePromptAliases = new Map();
      if (
        snapshot.mode !== 'legacy' ||
        snapshot.fallbackReason !== 'unsupported' ||
        sessionChanged
      ) {
        pages = new Map();
        pageTable.reset();
        pageTable.setLiveRecordIds(liveRecordIds);
        publish({
          mode: 'legacy',
          fallbackReason: 'unsupported',
          totalTurns: 0,
          selected: undefined,
          error: undefined,
        });
      }
      return;
    }
    if (tooLarge) {
      client = next.client;
      clientOwner = next.client?.owner;
      clientWasConnected = next.client !== undefined;
      if (snapshot.fallbackReason !== 'too_large') {
        publish({
          mode: 'legacy',
          fallbackReason: 'too_large',
          totalTurns: 0,
          selected: undefined,
          error: undefined,
        });
      }
      return;
    }
    if (!next.client) {
      let releasedBoundary = false;
      if (client) {
        sessionEpoch += 1;
        selectionGeneration += 1;
        headRequest = undefined;
        headDirty = false;
        releasedBoundary = pageTable.releaseLoadingBoundaries();
      }
      client = undefined;
      clientWasConnected = false;
      if (
        sessionChanged ||
        releasedBoundary ||
        snapshot.selected?.status === 'loading'
      ) {
        publish({
          ...(sessionChanged
            ? {
                mode: 'loading' as const,
                fallbackReason: undefined,
                totalTurns: 0,
              }
            : {}),
          selected: undefined,
          error: undefined,
        });
      }
      return;
    }
    const ownerChanged = clientOwner !== next.client.owner;
    if (ownerChanged && clientOwner !== undefined) {
      sessionEpoch += 1;
      selectionGeneration += 1;
      headRequest = undefined;
      headDirty = false;
      if (
        pageTable.releaseLoadingBoundaries() ||
        snapshot.selected?.status === 'loading'
      ) {
        publish({ selected: undefined, error: undefined });
      }
    }
    const shouldRefresh = ownerChanged || !clientWasConnected;
    client = next.client;
    clientOwner = next.client.owner;
    clientWasConnected = true;
    if (!shouldRefresh || snapshot.fallbackReason === 'too_large') return;
    if (pages.size === 0)
      publish({ mode: 'loading', fallbackReason: undefined });
    void refreshHead();
  }

  function observeLiveBlocks(blocks: readonly DaemonTranscriptBlock[]): void {
    if (blocks === lastLiveBlocks) return;
    lastLiveBlocks = blocks;
    const next = new Map<string, DaemonTurnLocation>();
    const blockIds = new Set<string>();
    const blockIdByPromptId = new Map<string, string>();
    const nextLiveRecordIds = new Set<string>();
    for (const block of blocks) {
      for (const recordId of block.sourceRecordIds ?? []) {
        nextLiveRecordIds.add(recordId);
      }
      if (block.kind !== 'user') continue;
      blockIds.add(block.id);
      const promptId = block.promptId ?? block.meta?.['promptId'];
      if (typeof promptId === 'string')
        blockIdByPromptId.set(promptId, block.id);
      for (const turnId of block.sourceRecordIds ?? []) {
        next.set(turnId, { turnId, blockId: block.id, view: 'live' });
      }
    }
    liveRecordIds = nextLiveRecordIds;
    liveBlockIdByPromptId = blockIdByPromptId;
    const nextLivePromptAliases = new Map(
      [...livePromptAliases].filter(
        ([turnId, location]) =>
          !next.has(turnId) && blockIds.has(location.blockId),
      ),
    );
    for (const entry of indexedEntries(pages).values()) {
      const blockId = blockIdByPromptId.get(entry.promptId ?? '');
      if (blockId && !next.has(entry.turnId)) {
        nextLivePromptAliases.set(entry.turnId, {
          turnId: entry.turnId,
          blockId,
          view: 'live',
        });
      }
    }
    const nextProvisionals = provisionals.map((provisional) => {
      const exactBlockId = blockIdByPromptId.get(provisional.promptId);
      const blockId = blockIds.has(provisional.blockId ?? '')
        ? provisional.blockId
        : exactBlockId;
      if (blockId === provisional.blockId) return provisional;
      const { blockId: _blockId, ...withoutBlockId } = provisional;
      return Object.freeze({
        ...withoutBlockId,
        ...(blockId ? { blockId } : {}),
      });
    });
    const provisionalsChanged = nextProvisionals.some(
      (provisional, index) => provisional !== provisionals[index],
    );
    if (
      !provisionalsChanged &&
      locationsEqual(liveLocations, next) &&
      locationsEqual(livePromptAliases, nextLivePromptAliases)
    ) {
      syncLiveRecordIds();
      return;
    }
    liveLocations = next;
    livePromptAliases = nextLivePromptAliases;
    provisionals = nextProvisionals;
    reconcileProvisionals();
    syncLiveRecordIds();
    publish();
  }

  function recordPromptAdmitted(admission: DaemonPromptAdmission): void {
    if (removedPromptIds.has(admission.promptId)) return;
    const blockId =
      admission.blockId ?? liveBlockIdByPromptId.get(admission.promptId);
    const entries = [...indexedEntries(pages).values()];
    const promptEntry = entries.find(
      (entry) => entry.promptId === admission.promptId,
    );
    if (promptEntry) {
      if (
        blockId &&
        !liveLocations.has(promptEntry.turnId) &&
        livePromptAliases.get(promptEntry.turnId)?.blockId !== blockId
      ) {
        livePromptAliases.set(promptEntry.turnId, {
          turnId: promptEntry.turnId,
          blockId,
          view: 'live',
        });
        syncLiveRecordIds();
        publish();
      }
      return;
    }
    if (
      snapshot.mode === 'legacy' ||
      provisionals.some((turn) => turn.promptId === admission.promptId) ||
      entries.some(
        (entry) =>
          blockId !== undefined &&
          findLiveLocation(entry.turnId)?.blockId === blockId,
      )
    ) {
      return;
    }
    if (provisionals.length >= indexPageSize) {
      enterTooLargeFallback();
      return;
    }
    provisionals = [
      ...provisionals,
      Object.freeze({
        provisionalId: `live:${admission.promptId}`,
        promptId: admission.promptId,
        label: compactLabel(admission.label),
        ...(blockId ? { blockId } : {}),
      }),
    ];
    publish();
  }

  function recordPromptRemoved(promptId: string): void {
    if (snapshot.mode === 'legacy') return;
    removedPromptIds.add(promptId);
    while (removedPromptIds.size > WEB_SHELL_TURN_INDEX_PAGE_SIZE) {
      removedPromptIds.delete(removedPromptIds.values().next().value!);
    }
    const next = provisionals.filter((turn) => turn.promptId !== promptId);
    if (next.length === provisionals.length) return;
    provisionals = next;
    publish();
  }

  function handleSessionEvent(type: string): void {
    if (type === 'session_rewound' || type === 'session.rewound') {
      liveLocations = new Map();
      livePromptAliases = new Map();
      liveRecordIds = new Set();
      liveBlockIdByPromptId = new Map();
      lastLiveBlocks = undefined;
      resetChain();
      if (tooLarge) {
        publish({ mode: 'legacy', fallbackReason: 'too_large' });
        return;
      }
      publish({ mode: client ? 'loading' : snapshot.mode });
      void refreshHead();
      return;
    }
    if (
      type === 'turn_complete' ||
      type === 'turn_error' ||
      type === 'replay_complete' ||
      type === 'session.replay_complete'
    ) {
      void refreshHead();
    }
  }

  async function refreshHead(): Promise<void> {
    if (!client || !sessionId || snapshot.mode === 'legacy' || tooLarge) return;
    if (headRequest) {
      headDirty = true;
      return headRequest;
    }
    const request = async () => {
      do {
        headDirty = false;
        const activeClient: DaemonTurnNavigationClient | undefined = client;
        if (!activeClient) return;
        const capturedSession = sessionEpoch;
        const capturedChain = chainEpoch;
        try {
          const response = await activeClient.getTurnIndexPage({
            limit: indexPageSize,
          });
          if (
            capturedSession !== sessionEpoch ||
            capturedChain !== chainEpoch ||
            !isCurrentClient(activeClient)
          ) {
            return;
          }
          admitHead(response);
        } catch (error) {
          if (
            capturedSession !== sessionEpoch ||
            capturedChain !== chainEpoch ||
            !isCurrentClient(activeClient)
          ) {
            return;
          }
          handleIndexError(error);
          if (tooLarge) return;
        }
      } while (headDirty);
    };
    const trackedRequest = request().finally(() => {
      if (headRequest !== trackedRequest) return;
      headRequest = undefined;
      if (headDirty) void refreshHead();
    });
    headRequest = trackedRequest;
    return headRequest;
  }

  async function loadOrdinal(
    ordinal: number,
    generation = selectionGeneration,
  ): Promise<void> {
    assertOrdinal(ordinal);
    if (findIndexEntry(ordinal)) return;
    const head = newestPage();
    const activeClient = client;
    if (
      !head ||
      !activeClient ||
      !sessionId ||
      ordinal >= snapshot.totalTurns
    ) {
      throw new Error('Turn ordinal is unavailable');
    }
    const capturedSession = sessionEpoch;
    const capturedChain = chainEpoch;
    const expectedTotalTurns = snapshot.totalTurns;
    const start = Math.floor(ordinal / indexPageSize) * indexPageSize;
    try {
      const response = await activeClient.getTurnIndexPage({
        snapshot: head.snapshot,
        start,
        limit: indexPageSize,
      });
      if (
        capturedSession !== sessionEpoch ||
        capturedChain !== chainEpoch ||
        !isCurrentClient(activeClient)
      ) {
        return;
      }
      admitIndexPage(
        response,
        head.snapshot,
        start,
        expectedTotalTurns,
        ordinal,
      );
      publish(
        snapshot.error?.operation === 'index' &&
          snapshot.error.ordinal === ordinal
          ? { error: undefined }
          : {},
      );
    } catch (error) {
      if (
        capturedSession !== sessionEpoch ||
        capturedChain !== chainEpoch ||
        !isCurrentClient(activeClient)
      ) {
        return;
      }
      if (
        isTranscriptTooLarge(error) ||
        error instanceof TurnIndexPageTooLargeError
      ) {
        enterTooLargeFallback();
      } else if (generation === selectionGeneration) {
        publish({
          error: navigationError(
            'index',
            error,
            isRetryable(error),
            undefined,
            ordinal,
          ),
        });
        if (extractHttpStatus(error) === 409) void refreshHead();
      }
      throw error;
    }
  }

  async function locateOrdinal(ordinal: number): Promise<DaemonTurnLocation> {
    assertOrdinal(ordinal);
    const generation = ++selectionGeneration;
    publish({
      selected: { ordinal, status: 'loading' },
      ...(snapshot.error?.operation === 'locate' ||
      (snapshot.error?.operation === 'index' &&
        snapshot.error.ordinal !== undefined)
        ? { error: undefined }
        : {}),
    });
    try {
      await loadOrdinal(ordinal, generation);
      if (generation !== selectionGeneration)
        throw new Error('Selection changed');
      const entryWithSnapshot = findIndexEntry(ordinal);
      if (!entryWithSnapshot) throw new Error('Turn metadata is unavailable');
      const existing = snapshot.locations.get(entryWithSnapshot.entry.turnId);
      if (existing) {
        if (
          existing.view === 'historical' &&
          existing.rangeId &&
          existing.pageId
        ) {
          pageTable.select(existing.rangeId, existing.pageId);
        }
        publish({
          selected: {
            ordinal,
            turnId: entryWithSnapshot.entry.turnId,
            status: 'ready',
            location: existing,
          },
        });
        return existing;
      }
      const activeClient = client;
      if (!activeClient) throw new Error('Session navigation is unavailable');
      const capturedSession = sessionEpoch;
      const capturedChain = chainEpoch;
      const response = await activeClient.getTranscriptPage({
        atRecordId: entryWithSnapshot.entry.turnId,
        snapshot: entryWithSnapshot.page.snapshot,
        limit: WEB_SHELL_HISTORY_PAGE_SIZE,
      });
      if (
        generation !== selectionGeneration ||
        capturedSession !== sessionEpoch ||
        capturedChain !== chainEpoch ||
        !isCurrentClient(activeClient)
      ) {
        throw new Error('Selection changed');
      }
      validateTranscriptResponse(response, sessionId);
      if (response.partial || response.replayError) {
        throw new Error(
          response.replayError ?? 'Historical transcript page was partial',
        );
      }
      const live = findLiveLocation(entryWithSnapshot.entry.turnId);
      if (live) {
        publish({
          selected: {
            ordinal,
            turnId: entryWithSnapshot.entry.turnId,
            status: 'ready',
            location: live,
          },
          ...(snapshot.error?.operation === 'locate'
            ? { error: undefined }
            : {}),
        });
        return live;
      }
      const target = pageTable.admitAnchor(
        ordinal,
        entryWithSnapshot.entry.turnId,
        entryWithSnapshot.page.snapshot,
        response,
      );
      const location: DaemonTurnLocation = {
        turnId: entryWithSnapshot.entry.turnId,
        blockId: target.blockId,
        view: 'historical',
        rangeId: target.rangeId,
        pageId: target.pageId,
      };
      publish({
        selected: {
          ordinal,
          turnId: entryWithSnapshot.entry.turnId,
          status: 'ready',
          location,
        },
        ...(snapshot.error?.operation === 'locate' ? { error: undefined } : {}),
      });
      return location;
    } catch (error) {
      if (generation === selectionGeneration) {
        if (isTranscriptTooLarge(error)) {
          enterTooLargeFallback();
        } else {
          publish({
            selected: { ordinal, status: 'unavailable' },
            error: navigationError('locate', error),
          });
          if (
            extractHttpStatus(error) === 409 ||
            getErrorCode(error) === 'invalid_turn_anchor'
          ) {
            void refreshHead();
          }
        }
      }
      throw error;
    }
  }

  async function loadBoundary(
    rangeId: string,
    direction: 'older' | 'newer',
  ): Promise<void> {
    const activeClient = client;
    if (!activeClient) return;
    const request = pageTable.beginBoundaryLoad(rangeId, direction);
    if (!request) return;
    const clearBoundaryError = () =>
      snapshot.error?.operation === direction &&
      snapshot.error.rangeId === rangeId
        ? { error: undefined }
        : {};
    publish(clearBoundaryError());
    const capturedSession = sessionEpoch;
    const capturedChain = chainEpoch;
    const isCurrentBoundary = () => {
      const boundary = pageTable
        .getSnapshot()
        .ranges.find((item) => item.id === rangeId)?.[direction];
      return (
        capturedSession === sessionEpoch &&
        capturedChain === chainEpoch &&
        isCurrentClient(activeClient) &&
        boundary?.kind === 'loading' &&
        boundary.request === request
      );
    };
    try {
      let response: DaemonSessionTranscriptPage;
      let recovery: TranscriptGapResolution | undefined;
      if (request.kind === 'gap') {
        response = await activeClient.getTranscriptPage({
          atRecordId: request.anchorRecordId,
          snapshot: request.snapshot,
          limit: WEB_SHELL_HISTORY_PAGE_SIZE,
        });
        let fromAnchor = true;
        let newerCandidate: DaemonSessionTranscriptPage | undefined;
        let candidateFromAnchor = false;
        let previousFirstRecordId: string | undefined;
        while (true) {
          if (!isCurrentBoundary()) return;
          validateHistoricalResponse(response, sessionId);
          if (
            fromAnchor &&
            response.targetRecordId !== request.anchorRecordId
          ) {
            throw new Error('Gap recovery response did not contain its anchor');
          }
          const recordIds = activeClient.materializeTranscriptEvents(
            response.events,
            1,
            new Set(),
          ).encounteredRecordIds;
          const edge = recordIds.indexOf(request.afterRecordId);
          if (edge >= 0) {
            if (edge < recordIds.length - 1) {
              recovery = {
                excludedRecordIds: recordIds.slice(0, edge + 1),
                fromAnchor,
              };
            } else if (newerCandidate) {
              response = newerCandidate;
              recovery = {
                excludedRecordIds: [],
                fromAnchor: candidateFromAnchor,
              };
            } else {
              recovery = { excludedRecordIds: recordIds, fromAnchor };
            }
            break;
          }
          const firstRecordId = recordIds[0];
          if (!firstRecordId || firstRecordId === previousFirstRecordId) {
            throw new Error(
              'Gap recovery did not advance to the retained record',
            );
          }
          previousFirstRecordId = firstRecordId;
          newerCandidate = response;
          candidateFromAnchor = fromAnchor;
          response = await activeClient.getTranscriptPage({
            beforeRecordId: firstRecordId,
            snapshot: request.snapshot,
            limit: WEB_SHELL_HISTORY_PAGE_SIZE,
          });
          fromAnchor = false;
        }
      } else {
        response = await activeClient.getTranscriptPage(
          request.kind === 'older'
            ? {
                beforeRecordId: request.beforeRecordId,
                snapshot: request.snapshot,
                limit: WEB_SHELL_HISTORY_PAGE_SIZE,
              }
            : { cursor: request.cursor, limit: WEB_SHELL_HISTORY_PAGE_SIZE },
        );
      }
      if (!isCurrentBoundary()) return;
      const table = pageTable.getSnapshot();
      const currentRange = table.ranges.find((item) => item.id === rangeId);
      if (!currentRange || currentRange[direction].kind !== 'loading') return;
      validateHistoricalResponse(response, sessionId);
      const firstPageId = currentRange.pageIds[0];
      const rangeSnapshot = firstPageId
        ? table.pages.get(firstPageId)?.snapshot
        : undefined;
      if (!rangeSnapshot) return;
      pageTable.admitBoundary(
        rangeId,
        direction,
        request.kind !== 'cursor' ? request.snapshot : rangeSnapshot,
        response,
        recovery,
      );
      publish(clearBoundaryError());
    } catch (error) {
      if (!isCurrentBoundary()) return;
      const currentRange = pageTable
        .getSnapshot()
        .ranges.find((item) => item.id === rangeId);
      if (!currentRange || currentRange[direction].kind !== 'loading') return;
      if (isTranscriptTooLarge(error)) {
        enterTooLargeFallback();
      } else {
        const retryable = isRetryable(error);
        pageTable.failBoundaryLoad(rangeId, direction, request, retryable);
        publish({
          error: navigationError(direction, error, retryable, rangeId),
        });
        if (extractHttpStatus(error) === 409) void refreshHead();
      }
      throw error;
    }
  }

  async function retry(): Promise<void> {
    const retriedHead = headRetryPending;
    if (retriedHead) await refreshHead();
    if (snapshot.error && !snapshot.error.retryable) return;
    const operation = snapshot.error?.operation;
    if (operation === 'index') {
      const ordinal = snapshot.error?.ordinal;
      if (ordinal !== undefined) return loadOrdinal(ordinal);
      if (!retriedHead) return refreshHead();
      return;
    }
    if (operation === 'locate' || snapshot.selected?.status === 'unavailable') {
      if (!snapshot.selected) return;
      await locateOrdinal(snapshot.selected.ordinal);
      return;
    }
    const rangeId = snapshot.error?.rangeId;
    const ranges = pageTable.getSnapshot().ranges;
    if (operation === 'older' || operation === 'newer') {
      const range = ranges.find(
        (item) =>
          (rangeId === undefined || item.id === rangeId) &&
          item[operation].kind === 'error',
      );
      if (range) await loadBoundary(range.id, operation);
      return;
    }
    for (const range of ranges) {
      if (range.older.kind === 'error' && range.older.retryable) {
        await loadBoundary(range.id, 'older');
        return;
      }
      if (range.newer.kind === 'error' && range.newer.retryable) {
        await loadBoundary(range.id, 'newer');
        return;
      }
    }
  }

  function admitHead(response: DaemonSessionTurnIndexPage): void {
    validateIndexResponse(response, sessionId, undefined, indexPageSize);
    if (response.start + response.turns.length !== response.totalTurns) {
      throw new Error('Turn-index head did not contain the newest page');
    }
    const nextHead = makeIndexPage(response);
    const oldEntries = indexedEntries(pages);
    const oldOrdinalsByTurnId = new Map(
      [...oldEntries].map(([ordinal, entry]) => [entry.turnId, ordinal]),
    );
    const shared = response.turns.filter((turn) =>
      oldEntries.has(turn.ordinal),
    );
    const compatible =
      snapshot.totalTurns === 0 ||
      (response.totalTurns >= snapshot.totalTurns &&
        shared.length > 0 &&
        shared.every(
          (turn) => oldEntries.get(turn.ordinal)?.turnId === turn.turnId,
        ) &&
        response.turns.every(
          (turn) =>
            oldOrdinalsByTurnId.get(turn.turnId) === undefined ||
            oldOrdinalsByTurnId.get(turn.turnId) === turn.ordinal,
        ));
    if (!compatible) resetChain();
    const retained = new Map<number, InternalIndexPage>();
    for (const [start, page] of pages) {
      if (page.end <= nextHead.start) retained.set(start, page);
    }
    retained.set(nextHead.start, nextHead);
    pages = retained;
    reconcileProvisionals(response.turns);
    evictIndexPages(nextHead.start);
    headRetryPending = false;
    publish({
      mode: 'ready',
      fallbackReason: undefined,
      totalTurns: response.totalTurns,
      ...(snapshot.error?.operation === 'index' ? { error: undefined } : {}),
    });
  }

  function admitIndexPage(
    response: DaemonSessionTurnIndexPage,
    expectedSnapshot: string,
    expectedStart: number,
    expectedTotalTurns: number,
    expectedOrdinal: number,
  ): void {
    validateIndexResponse(response, sessionId, expectedSnapshot, indexPageSize);
    const knownEntries = indexedEntries(pages);
    const knownOrdinalsByTurnId = new Map(
      [...knownEntries].map(([ordinal, entry]) => [entry.turnId, ordinal]),
    );
    if (
      response.start !== expectedStart ||
      response.totalTurns !== expectedTotalTurns ||
      expectedOrdinal < response.start ||
      expectedOrdinal >= response.start + response.turns.length ||
      response.turns.some(
        (turn) =>
          (knownEntries.get(turn.ordinal) !== undefined &&
            knownEntries.get(turn.ordinal)?.turnId !== turn.turnId) ||
          (knownOrdinalsByTurnId.get(turn.turnId) !== undefined &&
            knownOrdinalsByTurnId.get(turn.turnId) !== turn.ordinal),
      )
    ) {
      throw new Error('Frozen turn-index page changed');
    }
    const page = makeIndexPage(response);
    pages.set(page.start, page);
    reconcileProvisionals(response.turns);
    evictIndexPages(newestPage()?.start);
  }

  function makeIndexPage(
    response: DaemonSessionTurnIndexPage,
  ): InternalIndexPage {
    const page = {
      start: response.start,
      end: response.start + response.turns.length,
      snapshot: response.snapshot,
      turns: Object.freeze(
        response.turns.map((turn) => Object.freeze({ ...turn })),
      ),
      retainedBytes: estimateIndexPageBytes(response),
      accessedAt: ++accessClock,
    };
    if (maxIndexPages < 1 || page.retainedBytes > maxIndexBytes) {
      throw new TurnIndexPageTooLargeError();
    }
    return page;
  }

  function reconcileProvisionals(
    newEntries: readonly DaemonSessionTurnIndexEntry[] = [],
  ): void {
    const entries = [...indexedEntries(pages).values(), ...newEntries];
    for (const entry of entries) {
      const blockId = liveBlockIdByPromptId.get(entry.promptId ?? '');
      if (blockId && !liveLocations.has(entry.turnId)) {
        livePromptAliases.set(entry.turnId, {
          turnId: entry.turnId,
          blockId,
          view: 'live',
        });
      }
    }
    provisionals = provisionals.filter((provisional) => {
      const promptEntry = entries.find(
        (entry) => entry.promptId === provisional.promptId,
      );
      if (promptEntry) {
        if (provisional.blockId) {
          livePromptAliases.set(promptEntry.turnId, {
            turnId: promptEntry.turnId,
            blockId: provisional.blockId,
            view: 'live',
          });
        }
        return false;
      }
      return entries.every((entry) => {
        const blockId = liveLocations.get(entry.turnId)?.blockId;
        return !blockId || blockId !== provisional.blockId;
      });
    });
    syncLiveRecordIds();
  }

  function syncLiveRecordIds(): void {
    pageTable.setLiveRecordIds([...liveRecordIds, ...livePromptAliases.keys()]);
  }

  function evictIndexPages(pinnedHeadStart?: number): void {
    const selectedOrdinal = snapshot.selected?.ordinal;
    const retainedBytes = () =>
      [...pages.values()].reduce(
        (total, page) => total + page.retainedBytes,
        0,
      );
    while (pages.size > maxIndexPages || retainedBytes() > maxIndexBytes) {
      const candidate = [...pages.values()]
        .filter(
          (page) =>
            page.start !== pinnedHeadStart &&
            (selectedOrdinal === undefined ||
              selectedOrdinal < page.start ||
              selectedOrdinal >= page.end),
        )
        .sort((left, right) => left.accessedAt - right.accessedAt)[0];
      if (!candidate) break;
      pages.delete(candidate.start);
    }
    if (pages.size > maxIndexPages || retainedBytes() > maxIndexBytes) {
      throw new TurnIndexPageTooLargeError();
    }
  }

  function handleIndexError(error: unknown): void {
    if (
      isTranscriptTooLarge(error) ||
      error instanceof TurnIndexPageTooLargeError
    ) {
      enterTooLargeFallback();
      return;
    }
    headRetryPending = isRetryable(error);
    publish({
      mode: pages.size > 0 ? 'ready' : 'degraded',
      ...(pages.size === 0 ? { fallbackReason: 'initial_error' as const } : {}),
      ...(!snapshot.error || snapshot.error.operation === 'index'
        ? { error: navigationError('index', error) }
        : {}),
    });
  }

  function enterTooLargeFallback(): void {
    tooLarge = true;
    headRetryPending = false;
    chainEpoch += 1;
    selectionGeneration += 1;
    pages = new Map();
    provisionals = [];
    removedPromptIds.clear();
    livePromptAliases = new Map();
    pageTable.reset();
    publish({
      mode: 'legacy',
      fallbackReason: 'too_large',
      totalTurns: 0,
      selected: undefined,
      error: undefined,
    });
  }

  function newestPage(): InternalIndexPage | undefined {
    return [...pages.values()].sort((left, right) => right.end - left.end)[0];
  }

  function findIndexEntry(
    ordinal: number,
  ):
    | { entry: DaemonSessionTurnIndexEntry; page: InternalIndexPage }
    | undefined {
    for (const page of pages.values()) {
      const entry = page.turns.find((turn) => turn.ordinal === ordinal);
      if (entry) {
        page.accessedAt = ++accessClock;
        return { entry, page };
      }
    }
    return undefined;
  }

  function findLiveLocation(turnId: string): DaemonTurnLocation | undefined {
    return liveLocations.get(turnId) ?? livePromptAliases.get(turnId);
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    configure,
    observeLiveBlocks,
    recordPromptAdmitted,
    recordPromptRemoved,
    handleSessionEvent,
    loadOrdinal,
    locateOrdinal,
    refreshHead,
    loadOlder: (rangeId) => loadBoundary(rangeId, 'older'),
    loadNewer: (rangeId) => loadBoundary(rangeId, 'newer'),
    retry,
  };
}

function publicIndexPage(page: InternalIndexPage): DaemonTurnIndexPage {
  const { accessedAt: _accessedAt, ...value } = page;
  return Object.freeze(value);
}

function indexedEntries(
  pages: ReadonlyMap<number, InternalIndexPage>,
): Map<number, DaemonSessionTurnIndexEntry> {
  const entries = new Map<number, DaemonSessionTurnIndexEntry>();
  for (const page of pages.values()) {
    for (const turn of page.turns) entries.set(turn.ordinal, turn);
  }
  return entries;
}

function validateIndexResponse(
  response: DaemonSessionTurnIndexPage,
  sessionId: string | undefined,
  expectedSnapshot: string | undefined,
  maxPageSize: number,
): void {
  if (
    !sessionId ||
    response.sessionId !== sessionId ||
    (expectedSnapshot !== undefined &&
      response.snapshot !== expectedSnapshot) ||
    response.snapshot.length === 0 ||
    !Number.isInteger(response.start) ||
    response.start < 0 ||
    !Number.isInteger(response.totalTurns) ||
    response.totalTurns < 0 ||
    response.start + response.turns.length > response.totalTurns ||
    response.turns.length > maxPageSize ||
    new Set(response.turns.map((turn) => turn.turnId)).size !==
      response.turns.length ||
    response.turns.some(
      (turn, index) =>
        turn.ordinal !== response.start + index || turn.turnId.length === 0,
    )
  ) {
    throw new Error('Invalid turn-index response');
  }
}

function validateTranscriptResponse(
  response: DaemonSessionTranscriptPage,
  sessionId: string | undefined,
): void {
  if (
    !sessionId ||
    response.sessionId !== sessionId ||
    (response.hasMore && !response.nextCursor)
  ) {
    throw new Error('Invalid transcript page response');
  }
}

function estimateIndexPageBytes(response: DaemonSessionTurnIndexPage): number {
  let bytes = 128 + response.snapshot.length * 2;
  for (const turn of response.turns) {
    bytes +=
      96 +
      turn.turnId.length * 2 +
      turn.label.length * 2 +
      (turn.promptId?.length ?? 0) * 2 +
      (turn.timestamp?.length ?? 0) * 2 +
      (turn.detail?.length ?? 0) * 2;
  }
  return bytes;
}

function locationsEqual(
  left: ReadonlyMap<string, DaemonTurnLocation>,
  right: ReadonlyMap<string, DaemonTurnLocation>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (!other || other.blockId !== value.blockId) return false;
  }
  return true;
}

function assertOrdinal(ordinal: number): void {
  if (!Number.isInteger(ordinal) || ordinal < 0) {
    throw new Error('Turn ordinal must be a non-negative integer');
  }
}

function compactLabel(label: string): string {
  const compacted = label.replace(/\s+/gu, ' ').trim();
  const codePoints = Array.from(compacted);
  return codePoints.length <= 160
    ? compacted
    : `${codePoints.slice(0, 159).join('')}…`;
}

function navigationError(
  operation: DaemonTurnNavigationError['operation'],
  error: unknown,
  retryable = isRetryable(error),
  rangeId?: string,
  ordinal?: number,
): DaemonTurnNavigationError {
  return Object.freeze({
    operation,
    message: error instanceof Error ? error.message : String(error),
    retryable,
    ...(rangeId ? { rangeId } : {}),
    ...(ordinal !== undefined ? { ordinal } : {}),
  });
}

function isRetryable(error: unknown): boolean {
  if (
    error instanceof HistoricalTranscriptPageTooLargeError ||
    error instanceof TurnIndexPageTooLargeError
  ) {
    return false;
  }
  const status = extractHttpStatus(error);
  return (
    status === undefined ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  );
}

function validateHistoricalResponse(
  response: DaemonSessionTranscriptPage,
  sessionId: string | undefined,
): void {
  validateTranscriptResponse(response, sessionId);
  if (response.partial || response.replayError) {
    throw new Error(
      response.replayError ?? 'Historical transcript page was partial',
    );
  }
}

function isTranscriptTooLarge(error: unknown): boolean {
  return (
    extractHttpStatus(error) === 413 &&
    getErrorCode(error) === 'transcript_too_large'
  );
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const body = 'body' in error ? error.body : undefined;
  if (typeof body !== 'object' || body === null || !('code' in body)) {
    return undefined;
  }
  return typeof body.code === 'string' ? body.code : undefined;
}
