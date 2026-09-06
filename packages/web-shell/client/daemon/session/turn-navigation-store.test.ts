/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  appendLocalUserTranscriptMessage,
  createDaemonTranscriptState,
} from '@qwen-code/sdk/daemon';
import type {
  DaemonEvent,
  DaemonSessionTranscriptPage,
  DaemonSessionTurnIndexPage,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import {
  createDaemonTurnNavigationStore,
  type DaemonTurnNavigationClient,
} from './turn-navigation-store.js';

function turnPage(
  start: number,
  ids: string[],
  options: Partial<DaemonSessionTurnIndexPage> = {},
): DaemonSessionTurnIndexPage {
  return {
    v: 1,
    sessionId: 'session-1',
    snapshot: 'snapshot-1',
    totalTurns: start + ids.length,
    start,
    turns: ids.map((turnId, index) => ({
      ordinal: start + index,
      turnId,
      kind: 'prompt',
      label: turnId,
      promptId: `prompt-${turnId}`,
    })),
    ...options,
  };
}

function transcriptPage(
  turnId: string | string[],
  options: Partial<DaemonSessionTranscriptPage> = {},
): DaemonSessionTranscriptPage {
  return {
    v: 1,
    sessionId: 'session-1',
    events: (typeof turnId === 'string' ? [turnId] : turnId).map(
      (recordId) =>
        ({ type: 'user_message_chunk', data: { recordId } }) as DaemonEvent,
    ),
    hasMore: false,
    ...(typeof turnId === 'string' ? { targetRecordId: turnId } : {}),
    ...options,
  };
}

function userBlock(
  id: string,
  turnId: string,
  promptId?: string,
): DaemonTranscriptBlock {
  return {
    id,
    kind: 'user',
    text: turnId,
    sourceRecordIds: [turnId],
    ...(promptId ? { promptId } : {}),
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function assistantBlock(id: string, recordId: string): DaemonTranscriptBlock {
  return {
    id,
    kind: 'assistant',
    text: recordId,
    sourceRecordIds: [recordId],
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function createClient() {
  const getTurnIndexPage =
    vi.fn<DaemonTurnNavigationClient['getTurnIndexPage']>();
  const getTranscriptPage =
    vi.fn<DaemonTurnNavigationClient['getTranscriptPage']>();
  const client: DaemonTurnNavigationClient = {
    owner: {},
    getTurnIndexPage,
    getTranscriptPage,
    materializeTranscriptEvents: materialize,
  };
  return { client, getTurnIndexPage, getTranscriptPage };
}

async function flushInitialHead(
  store: ReturnType<typeof createDaemonTurnNavigationStore>,
) {
  await vi.waitFor(() => expect(store.getSnapshot().mode).not.toBe('loading'));
}

function materialize(
  events: readonly DaemonEvent[],
  nextBlockOrdinal: number,
  excludedRecordIds: ReadonlySet<string>,
) {
  const encounteredRecordIds = events.map(
    (event) => (event.data as { recordId: string }).recordId,
  );
  const retained = encounteredRecordIds.filter(
    (recordId) => !excludedRecordIds.has(recordId),
  );
  const blocks: DaemonTranscriptBlock[] = retained.map((recordId, offset) => {
    const state = appendLocalUserTranscriptMessage(
      {
        ...createDaemonTranscriptState(),
        nextOrdinal: nextBlockOrdinal + offset,
      },
      recordId,
    );
    return { ...state.blocks[0]!, sourceRecordIds: [recordId] };
  });
  return {
    blocks,
    nextBlockOrdinal: nextBlockOrdinal + retained.length,
    encounteredRecordIds,
  };
}

async function ready(
  store: ReturnType<typeof createDaemonTurnNavigationStore>,
  client: DaemonTurnNavigationClient,
) {
  store.configure({ sessionId: 'session-1', supported: true, client });
  await vi.waitFor(() => expect(store.getSnapshot().mode).toBe('ready'));
}

function indexPage(
  ids: string[],
  start = 0,
  totalTurns = start + ids.length,
): DaemonSessionTurnIndexPage {
  return turnPage(start, ids, { totalTurns });
}

describe('createDaemonTurnNavigationStore', () => {
  it.each([
    ['admit', 'echo', 'index'],
    ['echo', 'admit', 'index'],
    ['echo', 'index', 'admit'],
    ['index', 'admit', 'echo'],
    ['index', 'echo', 'admit'],
    ['admit', 'index', 'echo'],
  ])('reconciles exact queued identity in %s/%s/%s order', async (...order) => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValue(indexPage(['turn-0']));
    await ready(store, client);
    const echo = appendLocalUserTranscriptMessage(
      createDaemonTranscriptState(),
      'same text',
    ).blocks[0]!;
    for (const step of order) {
      if (step === 'admit')
        store.recordPromptAdmitted({
          promptId: 'prompt-turn-1',
          label: 'same text',
        });
      if (step === 'echo')
        store.observeLiveBlocks([
          { ...echo, meta: { promptId: 'prompt-turn-1' } },
        ]);
      if (step === 'index') {
        getTurnIndexPage.mockResolvedValue(indexPage(['turn-0', 'turn-1']));
        await store.refreshHead();
      }
    }
    getTranscriptPage
      .mockResolvedValueOnce(
        transcriptPage(['turn-0'], {
          targetRecordId: 'turn-0',
          hasMore: true,
          nextCursor: 'after-0',
        }),
      )
      .mockResolvedValueOnce(transcriptPage(['turn-1']));
    expect(await store.locateOrdinal(1)).toMatchObject({
      view: 'live',
      blockId: echo.id,
    });
    const location = await store.locateOrdinal(0);
    await store.loadNewer(location.rangeId!);
    expect(
      [...store.getSnapshot().historicalPages.values()].some((page) =>
        page.recordIds.has('turn-1'),
      ),
    ).toBe(false);
    expect(store.getSnapshot().historicalRanges[0]?.newer).toEqual({
      kind: 'live',
    });
    store.observeLiveBlocks([]);
    expect(store.getSnapshot().locations.has('turn-1')).toBe(false);
  });

  it('does not bind a queued echo by text or retain its identity after rewind', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage.mockResolvedValue(indexPage(['turn-0']));
    await ready(store, client);
    const echo = appendLocalUserTranscriptMessage(
      createDaemonTranscriptState(),
      'turn-0',
    ).blocks[0]!;
    store.observeLiveBlocks([
      { ...echo, meta: { promptId: 'different-prompt' } },
    ]);
    expect(store.getSnapshot().locations.size).toBe(0);
    store.observeLiveBlocks([{ ...echo, meta: { promptId: 'prompt-turn-0' } }]);
    expect(store.getSnapshot().locations.get('turn-0')?.view).toBe('live');
    store.handleSessionEvent('session.rewound');
    await store.refreshHead();
    expect(store.getSnapshot().locations.size).toBe(0);
  });

  it('clears a boundary error when opposite-direction eviction repairs the boundary', async () => {
    const store = createDaemonTurnNavigationStore({ maxHistoricalPages: 2 });
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValue(
      indexPage(['turn-0', 'turn-1', 'turn-2']),
    );
    getTranscriptPage
      .mockResolvedValueOnce(
        transcriptPage(['turn-1'], {
          targetRecordId: 'turn-1',
          hasOlder: true,
          hasMore: true,
          nextCursor: 'after-1',
        }),
      )
      .mockResolvedValueOnce(
        transcriptPage(['turn-0'], { hasMore: true, nextCursor: 'before-0' }),
      )
      .mockRejectedValueOnce(new Error('older timeout'))
      .mockResolvedValueOnce(transcriptPage(['turn-2']));
    await ready(store, client);
    const location = await store.locateOrdinal(1);
    await store.loadOlder(location.rangeId!);
    await expect(store.loadOlder(location.rangeId!)).rejects.toThrow(
      'older timeout',
    );
    expect(store.getSnapshot().error?.operation).toBe('older');
    await store.loadNewer(location.rangeId!);
    expect(store.getSnapshot().historicalRanges[0]?.older.kind).toBe(
      'loadable',
    );
    expect(store.getSnapshot().error).toBeUndefined();
    await store.retry();
    expect(getTranscriptPage).toHaveBeenCalledTimes(4);
  });

  it('retries an independent metadata failure after a successful boundary load', async () => {
    const store = createDaemonTurnNavigationStore({ indexPageSize: 1 });
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage
      .mockResolvedValueOnce(indexPage(['turn-1'], 1, 2))
      .mockRejectedValueOnce(new Error('index timeout'))
      .mockResolvedValue(indexPage(['turn-0'], 0, 2));
    getTranscriptPage
      .mockResolvedValueOnce(
        transcriptPage(['turn-1'], {
          targetRecordId: 'turn-1',
          hasOlder: true,
        }),
      )
      .mockResolvedValueOnce(transcriptPage(['turn-0']));
    await ready(store, client);
    const location = await store.locateOrdinal(1);
    await expect(store.loadOrdinal(0)).rejects.toThrow('index timeout');
    await store.loadOlder(location.rangeId!);
    expect(store.getSnapshot().error).toMatchObject({
      operation: 'index',
      ordinal: 0,
    });
    await store.retry();
    expect(getTurnIndexPage).toHaveBeenCalledTimes(3);
    expect(getTurnIndexPage).toHaveBeenLastCalledWith({
      start: 0,
      snapshot: 'snapshot-1',
      limit: 1,
    });
    expect(store.getSnapshot().error).toBeUndefined();
  });

  it('allows a window-full retry after the selected page moves', async () => {
    const store = createDaemonTurnNavigationStore({ maxHistoricalPages: 2 });
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValue(
      indexPage(['turn-3', 'turn-4', 'turn-5']),
    );
    getTranscriptPage
      .mockResolvedValueOnce(
        transcriptPage(['turn-3'], {
          targetRecordId: 'turn-3',
          hasMore: true,
          nextCursor: 'after-3',
        }),
      )
      .mockResolvedValueOnce(
        transcriptPage(['turn-4'], { hasMore: true, nextCursor: 'after-4' }),
      )
      .mockResolvedValue(transcriptPage(['turn-5']));
    await ready(store, client);
    const location = await store.locateOrdinal(0);
    await store.loadNewer(location.rangeId!);
    await expect(store.loadNewer(location.rangeId!)).rejects.toThrow(
      'window is full',
    );
    expect(store.getSnapshot().error?.retryable).toBe(true);
    await store.locateOrdinal(1);
    await store.retry();
    expect(getTranscriptPage).toHaveBeenCalledTimes(4);
    expect(store.getSnapshot().error).toBeUndefined();
    expect(
      [...store.getSnapshot().historicalPages.values()].flatMap((page) => [
        ...page.recordIds,
      ]),
    ).toEqual(['turn-4', 'turn-5']);
  });

  it('stays legacy and issues no request when the capability is absent', () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();

    store.configure({ sessionId: 'session-1', supported: false, client });

    expect(store.getSnapshot().mode).toBe('legacy');
    expect(getTurnIndexPage).not.toHaveBeenCalled();
  });

  it('recovers evicted newer pages through backward-only gaps and resumes forward cursors', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `turn-${i}`);
    const store = createDaemonTurnNavigationStore({ maxHistoricalPages: 3 });
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValue(indexPage(ids));
    getTranscriptPage.mockImplementation(async (options) => {
      let start: number;
      let backward = false;
      if (options.atRecordId) {
        expect(options.snapshot).toBe('snapshot-1');
        start = ids.indexOf(options.atRecordId);
      } else if (options.beforeRecordId) {
        expect(options.snapshot).toBe('snapshot-1');
        start = Math.max(0, ids.indexOf(options.beforeRecordId) - 2);
        backward = true;
      } else {
        expect(options.cursor).toMatch(/^forward:/);
        expect(options.snapshot).toBeUndefined();
        start = Number(options.cursor!.split(':')[1]);
      }
      const end = Math.min(start + 2, ids.length);
      const hasMore = backward ? start > 0 : end < ids.length;
      return transcriptPage(ids.slice(start, end), {
        ...(options.atRecordId
          ? { targetRecordId: options.atRecordId, hasOlder: start > 0 }
          : {}),
        hasMore,
        ...(hasMore
          ? {
              nextCursor: `${backward ? 'backward' : 'forward'}:${backward ? start : end}`,
            }
          : {}),
      });
    });
    await ready(store, client);
    const location = await store.locateOrdinal(8);
    const rangeId = location.rangeId!;
    const records = () =>
      store
        .getSnapshot()
        .historicalRanges[0]!.pageIds.flatMap((pageId) => [
          ...store.getSnapshot().historicalPages.get(pageId)!.recordIds,
        ]);
    for (const selected of [8, 6, 4, 2]) {
      await store.locateOrdinal(selected);
      await store.loadOlder(rangeId);
      expect(store.getSnapshot().historicalPages.size).toBeLessThanOrEqual(3);
      expect(new Set(records()).size).toBe(records().length);
    }
    expect(records()).toEqual(ids.slice(0, 6));
    expect(store.getSnapshot().historicalRanges[0]!.newer).toMatchObject({
      kind: 'loadable',
      request: {
        kind: 'gap',
        anchorRecordId: 'turn-8',
        afterRecordId: 'turn-5',
      },
    });
    for (const selected of [4, 6, 8]) {
      await store.locateOrdinal(selected);
      await store.loadNewer(rangeId);
      expect(records()).toEqual(ids.slice(selected - 2, selected + 4));
      expect(store.getSnapshot().historicalPages.size).toBe(3);
      expect(store.getSnapshot().error).toBeUndefined();
    }
    expect(getTranscriptPage).toHaveBeenLastCalledWith({
      cursor: 'forward:10',
      limit: 200,
    });
    expect(store.getSnapshot().historicalRanges[0]!.newer).toEqual({
      kind: 'end',
    });
  });

  it.each(['overlap', 'disconnect', 'no-progress'] as const)(
    'guards %s while recovering a newer gap',
    async (scenario) => {
      const store = createDaemonTurnNavigationStore({ maxHistoricalPages: 2 });
      const { client, getTurnIndexPage, getTranscriptPage } = createClient();
      getTurnIndexPage.mockResolvedValue(
        indexPage(['turn-0', 'turn-1', 'turn-2', 'turn-3']),
      );
      getTranscriptPage
        .mockResolvedValueOnce(
          transcriptPage(['turn-3'], {
            targetRecordId: 'turn-3',
            hasOlder: true,
          }),
        )
        .mockResolvedValueOnce(
          transcriptPage(['turn-2'], {
            hasMore: true,
            nextCursor: 'backward-2',
          }),
        )
        .mockResolvedValueOnce(
          transcriptPage(['turn-1'], {
            hasMore: true,
            nextCursor: 'backward-1',
          }),
        );
      await ready(store, client);
      const location = await store.locateOrdinal(3);
      await store.loadOlder(location.rangeId!);
      await store.locateOrdinal(2);
      await store.loadOlder(location.rangeId!);
      const before = store.getSnapshot().historicalPages;
      expect(store.getSnapshot().historicalRanges[0]?.newer).toMatchObject({
        kind: 'loadable',
        request: { kind: 'gap' },
      });
      if (scenario === 'overlap') {
        getTranscriptPage.mockResolvedValue(
          transcriptPage(['turn-0', 'turn-1', 'turn-2', 'turn-3'], {
            targetRecordId: 'turn-3',
          }),
        );
        await store.loadNewer(location.rangeId!);
        const records = [
          ...store.getSnapshot().historicalPages.values(),
        ].flatMap((page) => [...page.recordIds]);
        expect(records).toEqual(['turn-2', 'turn-3']);
        expect(store.getSnapshot().historicalRanges[0]?.newer).toEqual({
          kind: 'end',
        });
      } else if (scenario === 'disconnect') {
        let finish!: (page: DaemonSessionTranscriptPage) => void;
        getTranscriptPage.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
        const pending = store.loadNewer(location.rangeId!);
        store.configure({ sessionId: 'session-1', supported: true });
        finish(
          transcriptPage(['turn-3'], {
            targetRecordId: 'turn-3',
            hasOlder: true,
          }),
        );
        await pending;
        expect(getTranscriptPage).toHaveBeenCalledTimes(4);
        expect(store.getSnapshot().historicalPages).toBe(before);
        expect(store.getSnapshot().historicalRanges[0]?.newer.kind).toBe(
          'loadable',
        );
      } else {
        getTranscriptPage.mockResolvedValue(
          transcriptPage(['turn-3'], {
            targetRecordId: 'turn-3',
            hasOlder: true,
          }),
        );
        await expect(store.loadNewer(location.rangeId!)).rejects.toThrow(
          'did not advance',
        );
        expect(getTranscriptPage).toHaveBeenCalledTimes(5);
        expect(store.getSnapshot().historicalPages).toBe(before);
        expect(store.getSnapshot().error).toMatchObject({
          operation: 'newer',
          retryable: true,
        });
      }
    },
  );

  it('loads only the newest index page while exposing the exact total', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage.mockResolvedValueOnce(
      turnPage(800, ['turn-800', 'turn-801'], { totalTurns: 802 }),
    );

    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);

    expect(getTurnIndexPage).toHaveBeenCalledWith({ limit: 200 });
    expect(store.getSnapshot()).toMatchObject({
      mode: 'ready',
      totalTurns: 802,
      effectiveTurnCount: 802,
    });
    expect([...store.getSnapshot().indexPages.keys()]).toEqual([800]);
  });

  it('rejects duplicate durable identities in one index page', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage.mockResolvedValueOnce(
      turnPage(0, ['turn-0', 'turn-0'], { totalTurns: 2 }),
    );

    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);

    expect(store.getSnapshot()).toMatchObject({
      mode: 'degraded',
      fallbackReason: 'initial_error',
      indexPages: new Map(),
    });
  });

  it('keeps an in-flight request across equivalent owner bindings', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    let resolveHead!: (page: DaemonSessionTurnIndexPage) => void;
    getTurnIndexPage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHead = resolve;
        }),
    );
    store.configure({ sessionId: 'session-1', supported: true, client });

    store.configure({
      sessionId: 'session-1',
      supported: true,
      client: { ...client },
    });
    resolveHead(turnPage(0, ['turn-0'], { totalTurns: 1 }));
    await flushInitialHead(store);

    expect(store.getSnapshot()).toMatchObject({ mode: 'ready', totalTurns: 1 });
    expect(getTurnIndexPage).toHaveBeenCalledTimes(1);
  });

  it('loads an aligned frozen metadata page for an arbitrary ordinal', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage
      .mockResolvedValueOnce(turnPage(800, ['turn-800'], { totalTurns: 801 }))
      .mockResolvedValueOnce(turnPage(200, ['turn-200'], { totalTurns: 801 }));
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);

    await store.loadOrdinal(200);

    expect(getTurnIndexPage).toHaveBeenLastCalledWith({
      snapshot: 'snapshot-1',
      start: 200,
      limit: 200,
    });
    expect([...store.getSnapshot().indexPages.keys()]).toEqual([800, 200]);
  });

  it('rejects conflicting overlap from an arbitrary metadata page', async () => {
    const store = createDaemonTurnNavigationStore({ indexPageSize: 2 });
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage
      .mockResolvedValueOnce(
        turnPage(1, ['turn-1', 'turn-2'], { totalTurns: 3 }),
      )
      .mockResolvedValueOnce(
        turnPage(0, ['turn-0', 'wrong-turn-1'], { totalTurns: 3 }),
      );
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);

    await expect(store.loadOrdinal(0)).rejects.toThrow(
      'Frozen turn-index page changed',
    );

    expect([...store.getSnapshot().indexPages.keys()]).toEqual([1]);
    expect(store.getSnapshot().error).toMatchObject({
      operation: 'index',
      ordinal: 0,
    });
  });

  it('evicts unselected metadata pages without changing the logical count', async () => {
    const store = createDaemonTurnNavigationStore({ maxIndexPages: 2 });
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage
      .mockResolvedValueOnce(turnPage(800, ['turn-800'], { totalTurns: 801 }))
      .mockResolvedValueOnce(turnPage(0, ['turn-0'], { totalTurns: 801 }))
      .mockResolvedValueOnce(turnPage(200, ['turn-200'], { totalTurns: 801 }));
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    await store.loadOrdinal(0);

    await store.loadOrdinal(200);

    expect([...store.getSnapshot().indexPages.keys()]).toEqual([800, 200]);
    expect(store.getSnapshot().totalTurns).toBe(801);
  });

  it('falls back when the selected and head metadata pages cannot both fit', async () => {
    const store = createDaemonTurnNavigationStore({ maxIndexPages: 1 });
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage
      .mockResolvedValueOnce(turnPage(2, ['turn-2'], { totalTurns: 3 }))
      .mockResolvedValueOnce(turnPage(0, ['turn-0'], { totalTurns: 3 }));
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);

    await expect(store.locateOrdinal(0)).rejects.toThrow(
      'Turn-index page exceeds the cache budget',
    );

    expect(store.getSnapshot()).toMatchObject({
      mode: 'legacy',
      fallbackReason: 'too_large',
      indexPages: new Map(),
    });
  });

  it('retries the exact failed metadata ordinal', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage
      .mockResolvedValueOnce(turnPage(800, ['turn-800'], { totalTurns: 801 }))
      .mockRejectedValueOnce(new Error('temporary metadata failure'))
      .mockResolvedValueOnce(turnPage(0, ['turn-0'], { totalTurns: 801 }));
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);

    await expect(store.loadOrdinal(0)).rejects.toThrow(
      'temporary metadata failure',
    );
    expect(store.getSnapshot().error).toMatchObject({
      operation: 'index',
      ordinal: 0,
    });

    await store.retry();

    expect(store.getSnapshot().indexPages.get(0)?.turns[0]?.turnId).toBe(
      'turn-0',
    );
  });

  it('keeps an older page snapshot after an append-compatible head refresh', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage
      .mockResolvedValueOnce(
        turnPage(800, ['turn-800'], {
          totalTurns: 801,
          snapshot: 'snapshot-1',
        }),
      )
      .mockResolvedValueOnce(
        turnPage(0, ['turn-0'], {
          totalTurns: 801,
          snapshot: 'snapshot-1',
        }),
      )
      .mockResolvedValueOnce(
        turnPage(800, ['turn-800', 'turn-801'], {
          totalTurns: 802,
          snapshot: 'snapshot-2',
        }),
      );
    getTranscriptPage.mockResolvedValueOnce(transcriptPage('turn-0'));
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    await store.loadOrdinal(0);

    await store.refreshHead();
    await store.locateOrdinal(0);

    expect(getTranscriptPage).toHaveBeenCalledWith({
      atRecordId: 'turn-0',
      snapshot: 'snapshot-1',
      limit: 200,
    });
  });

  it('admits an old-snapshot metadata page across a compatible append', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    let resolveOlder!: (page: DaemonSessionTurnIndexPage) => void;
    getTurnIndexPage
      .mockResolvedValueOnce(
        turnPage(800, ['turn-800'], {
          totalTurns: 801,
          snapshot: 'snapshot-1',
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOlder = resolve;
          }),
      )
      .mockResolvedValueOnce(
        turnPage(800, ['turn-800', 'turn-801'], {
          totalTurns: 802,
          snapshot: 'snapshot-2',
        }),
      );
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);

    const loading = store.loadOrdinal(0);
    await vi.waitFor(() => expect(getTurnIndexPage).toHaveBeenCalledTimes(2));
    await store.refreshHead();
    resolveOlder(
      turnPage(0, ['turn-0'], {
        totalTurns: 801,
        snapshot: 'snapshot-1',
      }),
    );
    await loading;

    expect(store.getSnapshot().totalTurns).toBe(802);
    expect(store.getSnapshot().indexPages.get(0)?.snapshot).toBe('snapshot-1');
  });

  it('refreshes the head when the same session owner reconnects', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage
      .mockResolvedValueOnce(turnPage(0, ['turn-0'], { totalTurns: 1 }))
      .mockResolvedValueOnce(
        turnPage(0, ['turn-0', 'turn-1'], { totalTurns: 2 }),
      );
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);

    store.configure({ sessionId: 'session-1', supported: true });
    store.configure({ sessionId: 'session-1', supported: true, client });
    await vi.waitFor(() => expect(store.getSnapshot().totalTurns).toBe(2));
    expect(getTurnIndexPage).toHaveBeenCalledTimes(2);

    expect(store.getSnapshot().totalTurns).toBe(2);
  });

  it('opens an arbitrary turn with the snapshot carried by its index page', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValueOnce(
      turnPage(0, ['turn-0'], { totalTurns: 1 }),
    );
    getTranscriptPage.mockResolvedValueOnce(transcriptPage('turn-0'));
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);

    const location = await store.locateOrdinal(0);

    expect(getTranscriptPage).toHaveBeenCalledWith({
      atRecordId: 'turn-0',
      snapshot: 'snapshot-1',
      limit: 200,
    });
    expect(location).toMatchObject({
      turnId: 'turn-0',
      blockId: 'history-page-1:user-1',
      view: 'historical',
    });
  });

  it('retains and retries the exact failed range boundary', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage
      .mockResolvedValueOnce(turnPage(0, ['turn-0'], { totalTurns: 1 }))
      .mockResolvedValueOnce(turnPage(0, ['turn-0'], { totalTurns: 1 }));
    getTranscriptPage
      .mockResolvedValueOnce(
        transcriptPage('turn-0', { hasMore: true, nextCursor: 'next-1' }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('snapshot unavailable'), { status: 409 }),
      )
      .mockResolvedValueOnce(transcriptPage('turn-1'));
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    await store.locateOrdinal(0);
    const rangeId = store.getSnapshot().historicalRanges[0]!.id;

    await expect(store.loadNewer(rangeId)).rejects.toThrow(
      'snapshot unavailable',
    );
    expect(store.getSnapshot().error).toMatchObject({
      operation: 'newer',
      rangeId,
      retryable: true,
    });
    await vi.waitFor(() => expect(getTurnIndexPage).toHaveBeenCalledTimes(2));
    expect(store.getSnapshot().error).toMatchObject({
      operation: 'newer',
      rangeId,
    });

    await store.retry();

    expect(store.getSnapshot().historicalRanges[0]?.newer).toEqual({
      kind: 'end',
    });
    expect(store.getSnapshot().historicalPages.size).toBe(2);
  });

  it('releases a loading boundary when its session owner disconnects', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValueOnce(
      turnPage(0, ['turn-0'], { totalTurns: 1 }),
    );
    let resolveBoundary!: (page: DaemonSessionTranscriptPage) => void;
    getTranscriptPage
      .mockResolvedValueOnce(
        transcriptPage('turn-0', { hasMore: true, nextCursor: 'next-1' }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveBoundary = resolve;
          }),
      );
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    await store.locateOrdinal(0);
    const rangeId = store.getSnapshot().historicalRanges[0]!.id;
    const loading = store.loadNewer(rangeId);
    await vi.waitFor(() => expect(getTranscriptPage).toHaveBeenCalledTimes(2));

    store.configure({ sessionId: 'session-1', supported: true });
    expect(store.getSnapshot().historicalRanges[0]?.newer).toEqual({
      kind: 'loadable',
      request: { kind: 'cursor', cursor: 'next-1' },
    });
    resolveBoundary(transcriptPage('turn-1'));
    await loading;

    expect(store.getSnapshot().historicalPages.size).toBe(1);
    expect(store.getSnapshot().historicalRanges[0]?.newer.kind).toBe(
      'loadable',
    );
  });

  it('drops a boundary result after its range is evicted', async () => {
    const store = createDaemonTurnNavigationStore({ maxHistoricalPages: 1 });
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValueOnce(
      turnPage(0, ['turn-0', 'turn-1'], { totalTurns: 2 }),
    );
    let resolveBoundary!: (page: DaemonSessionTranscriptPage) => void;
    getTranscriptPage
      .mockResolvedValueOnce(
        transcriptPage('turn-0', { hasMore: true, nextCursor: 'next-1' }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveBoundary = resolve;
          }),
      )
      .mockResolvedValueOnce(transcriptPage('turn-1'));
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    await store.locateOrdinal(0);
    const oldRangeId = store.getSnapshot().historicalRanges[0]!.id;
    const loading = store.loadNewer(oldRangeId);
    await vi.waitFor(() => expect(getTranscriptPage).toHaveBeenCalledTimes(2));

    await store.locateOrdinal(1);
    resolveBoundary(transcriptPage('turn-late'));
    await loading;

    expect(store.getSnapshot().selected).toMatchObject({
      ordinal: 1,
      turnId: 'turn-1',
      status: 'ready',
    });
    expect(store.getSnapshot().historicalRanges).toHaveLength(1);
    expect(store.getSnapshot().historicalRanges[0]?.id).not.toBe(oldRangeId);
    expect(store.getSnapshot().error).toBeUndefined();
  });

  it('uses an exact live source record locator without loading history', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValueOnce(
      turnPage(0, ['turn-0'], { totalTurns: 1 }),
    );
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    store.observeLiveBlocks([userBlock('live-user-1', 'turn-0')]);

    await expect(store.locateOrdinal(0)).resolves.toMatchObject({
      blockId: 'live-user-1',
      view: 'live',
    });
    expect(getTranscriptPage).not.toHaveBeenCalled();
  });

  it('detects a historical boundary that overlaps a non-user live record', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValue(
      turnPage(0, ['turn-0'], { totalTurns: 1 }),
    );
    getTranscriptPage
      .mockResolvedValueOnce(
        transcriptPage('turn-0', { hasMore: true, nextCursor: 'next-1' }),
      )
      .mockResolvedValueOnce(transcriptPage('assistant-live'));
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    store.observeLiveBlocks([
      assistantBlock('live-assistant-1', 'assistant-live'),
    ]);
    store.configure({ sessionId: 'session-1', supported: false });
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    await store.locateOrdinal(0);
    const rangeId = store.getSnapshot().historicalRanges[0]!.id;

    await store.loadNewer(rangeId);

    expect(store.getSnapshot().historicalRanges[0]?.newer).toEqual({
      kind: 'live',
    });
  });

  it('reconciles an admitted prompt only by exact prompt identity', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    let resolveHead!: (page: DaemonSessionTurnIndexPage) => void;
    getTurnIndexPage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHead = resolve;
        }),
    );
    store.configure({ sessionId: 'session-1', supported: true, client });
    store.recordPromptAdmitted({
      promptId: 'prompt-exact',
      label: 'same label',
      blockId: 'live-user-1',
    });
    store.recordPromptAdmitted({
      promptId: 'prompt-other',
      label: 'same label',
      blockId: 'live-user-2',
    });
    const localBlock = {
      ...userBlock('live-user-1', 'local-only'),
      sourceRecordIds: [],
    };
    store.observeLiveBlocks([localBlock]);
    expect(store.getSnapshot().effectiveTurnCount).toBe(2);

    const page = turnPage(0, ['turn-0'], { totalTurns: 1 });
    page.turns[0] = { ...page.turns[0]!, promptId: 'prompt-exact' };
    resolveHead(page);
    await flushInitialHead(store);

    expect(store.getSnapshot().provisionalTurns).toMatchObject([
      { promptId: 'prompt-other', label: 'same label' },
    ]);
    expect(store.getSnapshot().effectiveTurnCount).toBe(2);
    expect(store.getSnapshot().locations.get('turn-0')).toMatchObject({
      blockId: 'live-user-1',
      view: 'live',
    });

    store.observeLiveBlocks([
      localBlock,
      assistantBlock('live-assistant', 'assistant-live'),
    ]);
    expect(store.getSnapshot().locations.get('turn-0')?.blockId).toBe(
      'live-user-1',
    );

    store.observeLiveBlocks([]);
    expect(store.getSnapshot().locations.has('turn-0')).toBe(false);
  });

  it('attaches an exact live alias when metadata wins the admission race', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    const page = turnPage(0, ['turn-0'], { totalTurns: 1 });
    page.turns[0] = { ...page.turns[0]!, promptId: 'prompt-exact' };
    getTurnIndexPage.mockResolvedValueOnce(page);
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    store.observeLiveBlocks([
      { ...userBlock('live-user-1', 'local-only'), sourceRecordIds: [] },
    ]);

    store.recordPromptAdmitted({
      promptId: 'prompt-exact',
      label: 'prompt',
      blockId: 'live-user-1',
    });

    expect(store.getSnapshot().provisionalTurns).toHaveLength(0);
    expect(store.getSnapshot().locations.get('turn-0')).toEqual({
      turnId: 'turn-0',
      blockId: 'live-user-1',
      view: 'live',
    });
  });

  it('reconciles a provisional by exact live record identity', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    let resolveHead!: (page: DaemonSessionTurnIndexPage) => void;
    getTurnIndexPage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHead = resolve;
        }),
    );
    store.configure({ sessionId: 'session-1', supported: true, client });
    store.recordPromptAdmitted({
      promptId: 'local-prompt',
      label: 'prompt',
      blockId: 'live-user-1',
    });
    store.observeLiveBlocks([userBlock('live-user-1', 'turn-0')]);

    resolveHead(turnPage(0, ['turn-0'], { totalTurns: 1 }));
    await flushInitialHead(store);

    expect(store.getSnapshot().provisionalTurns).toHaveLength(0);
    expect(store.getSnapshot().effectiveTurnCount).toBe(1);
  });

  it('attaches and clears a provisional locator by exact live prompt identity', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage.mockResolvedValueOnce(turnPage(0, [], { totalTurns: 0 }));
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    store.recordPromptAdmitted({
      promptId: 'prompt-live',
      label: 'prompt',
    });

    store.observeLiveBlocks([
      userBlock('live-user-1', 'turn-live', 'prompt-live'),
    ]);
    expect(store.getSnapshot().provisionalTurns[0]?.blockId).toBe(
      'live-user-1',
    );

    store.observeLiveBlocks([]);
    expect(store.getSnapshot().provisionalTurns[0]?.blockId).toBeUndefined();
  });

  it('falls back before unreconciled provisional metadata can grow unbounded', async () => {
    const store = createDaemonTurnNavigationStore({ indexPageSize: 1 });
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage.mockResolvedValueOnce(turnPage(0, [], { totalTurns: 0 }));
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    store.recordPromptAdmitted({ promptId: 'prompt-1', label: 'one' });

    store.recordPromptAdmitted({ promptId: 'prompt-2', label: 'two' });

    expect(store.getSnapshot()).toMatchObject({
      mode: 'legacy',
      fallbackReason: 'too_large',
      provisionalTurns: [],
    });
  });

  it('resets cached lineage when a head refresh changes overlapping identity', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage
      .mockResolvedValueOnce(
        turnPage(0, ['turn-old'], { totalTurns: 1, snapshot: 'snapshot-1' }),
      )
      .mockResolvedValueOnce(
        turnPage(0, ['turn-new'], { totalTurns: 1, snapshot: 'snapshot-2' }),
      );
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    store.recordPromptAdmitted({
      promptId: 'stale-prompt',
      label: 'stale prompt',
    });

    await store.refreshHead();

    expect(store.getSnapshot().indexPages.get(0)?.turns[0]?.turnId).toBe(
      'turn-new',
    );
    expect(store.getSnapshot().indexPages.get(0)?.snapshot).toBe('snapshot-2');
    expect(store.getSnapshot().provisionalTurns).toHaveLength(0);
  });

  it('resets cached lineage when a durable identity moves ordinal', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage
      .mockResolvedValueOnce(
        turnPage(0, ['turn-a', 'turn-b'], {
          totalTurns: 2,
          snapshot: 'snapshot-1',
        }),
      )
      .mockResolvedValueOnce(
        turnPage(1, ['turn-b', 'turn-a'], {
          totalTurns: 3,
          snapshot: 'snapshot-2',
        }),
      );
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    store.recordPromptAdmitted({
      promptId: 'stale-prompt',
      label: 'stale prompt',
    });

    await store.refreshHead();

    expect(store.getSnapshot().indexPages.get(1)?.turns).toMatchObject([
      { ordinal: 1, turnId: 'turn-b' },
      { ordinal: 2, turnId: 'turn-a' },
    ]);
    expect(store.getSnapshot().provisionalTurns).toHaveLength(0);
  });

  it('drops a late selected-page result after the active session changes', async () => {
    const store = createDaemonTurnNavigationStore();
    const first = createClient();
    first.getTurnIndexPage.mockResolvedValueOnce(
      turnPage(0, ['turn-0'], { totalTurns: 1 }),
    );
    let resolveTranscript!: (page: DaemonSessionTranscriptPage) => void;
    first.getTranscriptPage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscript = resolve;
        }),
    );
    store.configure({
      sessionId: 'session-1',
      supported: true,
      client: first.client,
    });
    await flushInitialHead(store);
    const locating = store.locateOrdinal(0);
    await vi.waitFor(() => expect(first.getTranscriptPage).toHaveBeenCalled());

    store.configure({ sessionId: 'session-2', supported: false });
    resolveTranscript(transcriptPage('turn-0'));

    await expect(locating).rejects.toThrow('Selection changed');
    expect(store.getSnapshot()).toMatchObject({
      sessionId: 'session-2',
      mode: 'legacy',
      historicalRanges: [],
    });
  });

  it('drops a late selected-page result after capability is revoked', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValueOnce(
      turnPage(0, ['turn-0'], { totalTurns: 1 }),
    );
    let resolveTranscript!: (page: DaemonSessionTranscriptPage) => void;
    getTranscriptPage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveTranscript = resolve;
        }),
    );
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    const locating = store.locateOrdinal(0);
    await vi.waitFor(() => expect(getTranscriptPage).toHaveBeenCalled());

    store.configure({ sessionId: 'session-1', supported: false });
    resolveTranscript(transcriptPage('turn-0'));

    await expect(locating).rejects.toThrow('Selection changed');
    expect(store.getSnapshot()).toMatchObject({
      sessionId: 'session-1',
      mode: 'legacy',
      fallbackReason: 'unsupported',
    });
    expect(store.getSnapshot().selected).toBeUndefined();
    expect(store.getSnapshot().error).toBeUndefined();
  });

  it('drops an older locate result after a later selection wins', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValueOnce(
      turnPage(0, ['turn-0', 'turn-1'], { totalTurns: 2 }),
    );
    let resolveFirst!: (page: DaemonSessionTranscriptPage) => void;
    getTranscriptPage
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(transcriptPage('turn-1'));
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);
    const first = store.locateOrdinal(0);
    await vi.waitFor(() => expect(getTranscriptPage).toHaveBeenCalledTimes(1));

    await expect(store.locateOrdinal(1)).resolves.toMatchObject({
      turnId: 'turn-1',
    });
    resolveFirst(transcriptPage('turn-0'));

    await expect(first).rejects.toThrow('Selection changed');
    expect(store.getSnapshot().selected).toMatchObject({
      ordinal: 1,
      turnId: 'turn-1',
      status: 'ready',
    });
    expect(store.getSnapshot().historicalPages.size).toBe(1);
  });

  it('latches loaded-only fallback on a 413 response', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage.mockRejectedValueOnce({
      status: 413,
      body: { code: 'transcript_too_large' },
    });

    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);

    expect(store.getSnapshot()).toMatchObject({
      mode: 'legacy',
      fallbackReason: 'too_large',
    });

    store.configure({ sessionId: 'session-1', supported: false });
    store.configure({ sessionId: 'session-1', supported: true, client });
    store.handleSessionEvent('session_rewound');
    await flushInitialHead(store);

    expect(getTurnIndexPage).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().fallbackReason).toBe('too_large');
  });

  it('falls back when one turn-index page exceeds the local cache', async () => {
    const store = createDaemonTurnNavigationStore({ maxIndexBytes: 1 });
    const { client, getTurnIndexPage } = createClient();
    getTurnIndexPage.mockResolvedValueOnce(
      turnPage(0, ['turn-0'], { totalTurns: 1 }),
    );

    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);

    expect(store.getSnapshot()).toMatchObject({
      mode: 'legacy',
      fallbackReason: 'too_large',
    });
  });

  it('keeps a local historical-page overflow non-retryable', async () => {
    const store = createDaemonTurnNavigationStore({ maxHistoricalBytes: 1 });
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage
      .mockResolvedValueOnce(turnPage(0, ['turn-0'], { totalTurns: 1 }))
      .mockResolvedValueOnce(turnPage(0, ['turn-0'], { totalTurns: 1 }));
    getTranscriptPage.mockResolvedValueOnce(transcriptPage('turn-0'));
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);

    await expect(store.locateOrdinal(0)).rejects.toThrow(
      'Historical transcript page exceeds the cache budget',
    );

    expect(store.getSnapshot()).toMatchObject({
      mode: 'ready',
      selected: { ordinal: 0, status: 'unavailable' },
      error: { operation: 'locate', retryable: false },
    });

    await store.refreshHead();
    await store.retry();

    expect(getTranscriptPage).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().error).toMatchObject({
      operation: 'locate',
      retryable: false,
    });
  });

  it('keeps index navigation ready when one transcript page is too large', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValueOnce(
      turnPage(0, ['turn-0'], { totalTurns: 1 }),
    );
    getTranscriptPage.mockRejectedValueOnce({
      status: 413,
      body: { code: 'transcript_page_too_large' },
    });
    store.configure({ sessionId: 'session-1', supported: true, client });
    await flushInitialHead(store);

    await expect(store.locateOrdinal(0)).rejects.toMatchObject({ status: 413 });

    expect(store.getSnapshot()).toMatchObject({
      mode: 'ready',
      fallbackReason: undefined,
      selected: { ordinal: 0, status: 'unavailable' },
    });
  });

  it.each(['before', 'after'] as const)(
    'removes a prompt removed %s its admission completed',
    async (order) => {
      const store = createDaemonTurnNavigationStore();
      const { client, getTurnIndexPage } = createClient();
      getTurnIndexPage.mockResolvedValue(indexPage(['turn-0']));
      await ready(store, client);
      if (order === 'before')
        store.recordPromptRemoved('removed-before-admission');
      store.recordPromptAdmitted({
        promptId: 'removed-before-admission',
        label: 'Never executed',
      });
      if (order === 'after')
        store.recordPromptRemoved('removed-before-admission');
      await store.refreshHead();
      expect(store.getSnapshot().provisionalTurns).toEqual([]);
      expect(store.getSnapshot().effectiveTurnCount).toBe(1);
    },
  );

  it.each(['older', 'newer'] as const)(
    'rolls back a selection-pinned %s admission with a retryable window error',
    async (direction) => {
      const store = createDaemonTurnNavigationStore({ maxHistoricalPages: 2 });
      const { client, getTurnIndexPage, getTranscriptPage } = createClient();
      getTurnIndexPage.mockResolvedValue(indexPage(['turn-3']));
      getTranscriptPage
        .mockResolvedValueOnce(
          transcriptPage(['turn-3'], {
            targetRecordId: 'turn-3',
            hasOlder: true,
            hasMore: true,
            nextCursor: 'after-3',
          }),
        )
        .mockResolvedValueOnce(
          transcriptPage([direction === 'older' ? 'turn-2' : 'turn-4'], {
            hasMore: true,
            nextCursor: direction === 'older' ? 'before-2' : 'after-4',
          }),
        )
        .mockResolvedValue(
          transcriptPage([direction === 'older' ? 'turn-1' : 'turn-5'], {
            hasMore: true,
            nextCursor: direction === 'older' ? 'before-1' : 'after-5',
          }),
        );
      await ready(store, client);
      const location = await store.locateOrdinal(0);
      const load = direction === 'older' ? store.loadOlder : store.loadNewer;
      await load(location.rangeId!);
      expect(getTranscriptPage).toHaveBeenLastCalledWith(
        direction === 'older'
          ? { beforeRecordId: 'turn-3', snapshot: 'snapshot-1', limit: 200 }
          : { cursor: 'after-3', limit: 200 },
      );
      const before = store.getSnapshot().historicalRanges[0]!;
      await expect(load(location.rangeId!)).rejects.toThrow('window is full');
      const after = store.getSnapshot().historicalRanges[0]!;
      expect(after.pageIds).toEqual(before.pageIds);
      expect(store.getSnapshot().error?.operation).toBe(direction);
      expect(after[direction]).toMatchObject({
        kind: 'error',
        retryable: true,
      });
      const requests = getTranscriptPage.mock.calls.length;
      await expect(store.retry()).rejects.toThrow('window is full');
      expect(getTranscriptPage).toHaveBeenCalledTimes(requests + 1);
    },
  );

  it('uses distinct historical and live block identities in one epoch', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValue(indexPage(['turn-0', 'turn-1']));
    getTranscriptPage.mockResolvedValue(
      transcriptPage(['turn-0'], { targetRecordId: 'turn-0' }),
    );
    await ready(store, client);
    const liveState = appendLocalUserTranscriptMessage(
      createDaemonTranscriptState(),
      'live',
    );
    const liveBlock = { ...liveState.blocks[0]!, sourceRecordIds: ['turn-1'] };
    store.observeLiveBlocks([liveBlock]);
    const historical = await store.locateOrdinal(0);
    expect(historical.blockId).not.toBe(liveBlock.id);
    const page = store.getSnapshot().historicalPages.get(historical.pageId!);
    expect(page?.blocks.some((block) => block.id === historical.blockId)).toBe(
      true,
    );
  });

  it('deduplicates a durable alias of a record-less live echo and ends at live', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = createClient();
    getTurnIndexPage.mockResolvedValue(indexPage(['turn-0', 'turn-1']));
    getTranscriptPage
      .mockResolvedValueOnce(
        transcriptPage(['turn-0'], {
          targetRecordId: 'turn-0',
          hasMore: true,
          nextCursor: 'after-0',
        }),
      )
      .mockResolvedValueOnce(transcriptPage(['turn-1']));
    await ready(store, client);
    const echo = appendLocalUserTranscriptMessage(
      createDaemonTranscriptState(),
      'own echo',
    ).blocks[0]!;
    store.observeLiveBlocks([{ ...echo, promptId: 'prompt-turn-1' }]);
    store.recordPromptAdmitted({
      promptId: 'prompt-turn-1',
      label: 'own echo',
      blockId: echo.id,
    });
    expect(await store.locateOrdinal(1)).toMatchObject({
      view: 'live',
      blockId: echo.id,
    });
    const older = await store.locateOrdinal(0);
    await store.loadNewer(older.rangeId!);
    const snapshot = store.getSnapshot();
    expect(
      [...snapshot.historicalPages.values()].flatMap((page) => [
        ...page.recordIds,
      ]),
    ).not.toContain('turn-1');
    expect(snapshot.historicalRanges[0]?.newer).toEqual({ kind: 'live' });
  });

  it.each(['locate', 'older'] as const)(
    'retains a failed head refresh across successful %s recovery',
    async (operation) => {
      const store = createDaemonTurnNavigationStore();
      const { client, getTurnIndexPage, getTranscriptPage } = createClient();
      getTurnIndexPage
        .mockResolvedValueOnce(indexPage(['turn-0']))
        .mockRejectedValueOnce(new Error('head timeout'))
        .mockResolvedValue(indexPage(['turn-0', 'turn-1']));
      await ready(store, client);
      if (operation === 'locate') {
        getTranscriptPage.mockRejectedValueOnce(new Error('locate timeout'));
        await expect(store.locateOrdinal(0)).rejects.toThrow('locate timeout');
        await store.refreshHead();
        getTranscriptPage.mockResolvedValue(
          transcriptPage(['turn-0'], { targetRecordId: 'turn-0' }),
        );
        await store.retry();
      } else {
        getTranscriptPage
          .mockResolvedValueOnce(
            transcriptPage(['turn-0'], {
              targetRecordId: 'turn-0',
              hasOlder: true,
            }),
          )
          .mockResolvedValueOnce(transcriptPage(['older-record']));
        const location = await store.locateOrdinal(0);
        await store.refreshHead();
        await store.loadOlder(location.rangeId!);
        expect(store.getSnapshot().error).toMatchObject({ operation: 'index' });
      }
      await store.retry();
      expect(store.getSnapshot().totalTurns).toBe(2);
      expect(getTurnIndexPage).toHaveBeenCalledTimes(3);
    },
  );

  it.each([true, false])(
    'keeps boundary errors only for retained ranges after anchor overlap=%s',
    async (overlap) => {
      const store = createDaemonTurnNavigationStore();
      const { client, getTurnIndexPage, getTranscriptPage } = createClient();
      getTurnIndexPage.mockResolvedValue(indexPage(['turn-0', 'turn-1']));
      getTranscriptPage
        .mockResolvedValueOnce(
          transcriptPage(['turn-1'], {
            targetRecordId: 'turn-1',
            hasOlder: true,
          }),
        )
        .mockRejectedValueOnce(new Error('older timeout'))
        .mockResolvedValueOnce(
          transcriptPage(overlap ? ['turn-0', 'turn-1'] : ['turn-0'], {
            targetRecordId: 'turn-0',
          }),
        )
        .mockResolvedValueOnce(transcriptPage(['older-record']));
      await ready(store, client);
      const original = await store.locateOrdinal(1);
      await expect(store.loadOlder(original.rangeId!)).rejects.toThrow(
        'older timeout',
      );
      const boundaryError = store.getSnapshot().error;
      expect(boundaryError).toMatchObject({
        operation: 'older',
        rangeId: original.rangeId,
        retryable: true,
      });

      await store.locateOrdinal(0);

      const snapshot = store.getSnapshot();
      expect(snapshot.selected).toMatchObject({ ordinal: 0, status: 'ready' });
      expect(
        snapshot.historicalRanges.some(
          (range) => range.id === original.rangeId,
        ),
      ).toBe(!overlap);
      if (overlap) {
        await store.retry();
        expect(getTranscriptPage).toHaveBeenCalledTimes(3);
        expect(store.getSnapshot().error).toBeUndefined();
      } else {
        expect(snapshot.error).toEqual(boundaryError);
        await store.retry();
        expect(getTranscriptPage).toHaveBeenCalledTimes(4);
        expect(getTranscriptPage).toHaveBeenLastCalledWith({
          beforeRecordId: 'turn-1',
          snapshot: 'snapshot-1',
          limit: 200,
        });
        expect(store.getSnapshot().error).toBeUndefined();
      }
    },
  );

  it.each(['locateOrdinal', 'loadOrdinal'] as const)(
    'does not publish an old %s failure over a newer successful selection',
    async (operation) => {
      const store = createDaemonTurnNavigationStore({ indexPageSize: 1 });
      const { client, getTurnIndexPage } = createClient();
      let rejectOld!: (error: Error) => void;
      getTurnIndexPage
        .mockResolvedValueOnce(indexPage(['turn-1'], 1, 2))
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectOld = reject;
            }),
        );
      await ready(store, client);
      const live = appendLocalUserTranscriptMessage(
        createDaemonTranscriptState(),
        'live',
      ).blocks[0]!;
      store.observeLiveBlocks([{ ...live, sourceRecordIds: ['turn-1'] }]);
      const pending = store[operation](0);
      const rejection = pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      await store.locateOrdinal(1);
      rejectOld(new Error('old index timeout'));
      expect(await rejection).toMatchObject({ message: 'old index timeout' });
      expect(store.getSnapshot().selected).toMatchObject({
        ordinal: 1,
        status: 'ready',
      });
      expect(store.getSnapshot().error).toBeUndefined();
    },
  );
});
