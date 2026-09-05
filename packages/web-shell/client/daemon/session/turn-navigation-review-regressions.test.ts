/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  appendLocalUserTranscriptMessage,
  createDaemonTranscriptState,
  createDaemonTranscriptStore,
  type DaemonEvent,
  type DaemonSessionTranscriptPage,
  type DaemonSessionTurnIndexPage,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import {
  createDaemonTurnNavigationStore,
  type DaemonTurnNavigationClient,
} from './turn-navigation-store.js';
import { HistoricalTranscriptPageTable } from './transcript-page-table.js';

function indexPage(
  ids: string[],
  start = 0,
  totalTurns = start + ids.length,
): DaemonSessionTurnIndexPage {
  return {
    v: 1,
    sessionId: 'session-1',
    snapshot: 'snapshot-1',
    start,
    totalTurns,
    turns: ids.map((turnId, offset) => ({
      ordinal: start + offset,
      turnId,
      kind: 'prompt',
      label: turnId,
      promptId: `prompt-${turnId}`,
    })),
  };
}

function transcriptPage(
  recordIds: string[],
  options: Partial<DaemonSessionTranscriptPage> = {},
): DaemonSessionTranscriptPage {
  return {
    v: 1,
    sessionId: 'session-1',
    events: recordIds.map(
      (recordId) =>
        ({ type: 'user_message_chunk', data: { recordId } }) as DaemonEvent,
    ),
    hasMore: false,
    ...options,
  };
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

function clientFixture() {
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

async function ready(
  store: ReturnType<typeof createDaemonTurnNavigationStore>,
  client: DaemonTurnNavigationClient,
) {
  store.configure({ sessionId: 'session-1', supported: true, client });
  await vi.waitFor(() => expect(store.getSnapshot().mode).toBe('ready'));
}

describe('navigation review regressions', () => {
  it.each(['before', 'after'] as const)(
    'removes a prompt removed %s its admission completed',
    async (order) => {
      const store = createDaemonTurnNavigationStore();
      const { client, getTurnIndexPage } = clientFixture();
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
    'does not successfully reload an unchanged %s boundary at the page cap',
    async (direction) => {
      const store = createDaemonTurnNavigationStore({ maxHistoricalPages: 2 });
      const { client, getTurnIndexPage, getTranscriptPage } = clientFixture();
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
        .mockResolvedValueOnce(
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
      let rejected = false;
      try {
        await load(location.rangeId!);
      } catch {
        rejected = true;
      }
      const after = store.getSnapshot().historicalRanges[0]!;
      expect({
        rejected,
        boundary: after[direction],
        pageIds: after.pageIds,
      }).not.toEqual({
        rejected: false,
        boundary: before[direction],
        pageIds: before.pageIds,
      });
      if (rejected) {
        expect(store.getSnapshot().error?.operation).toBe(direction);
        expect(after[direction]).toMatchObject({
          kind: 'error',
          retryable: false,
        });
        const requests = getTranscriptPage.mock.calls.length;
        await load(location.rangeId!);
        expect(getTranscriptPage).toHaveBeenCalledTimes(requests);
      }
    },
  );

  it('uses distinct historical and live block identities in one epoch', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = clientFixture();
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

  it('remaps a historical child tool to its namespaced parent block', () => {
    const transcript = createDaemonTranscriptStore();
    transcript.dispatch([
      {
        type: 'user.text.delta',
        text: 'Inspect files',
        sourceRecordIds: ['turn-0'],
      },
      {
        type: 'tool.update',
        toolCallId: 'parent-call',
        title: 'Delegate',
        status: 'completed',
      },
      {
        type: 'tool.update',
        toolCallId: 'child-call',
        parentToolCallId: 'parent-call',
        title: 'Read file',
        status: 'completed',
      },
    ]);
    const original = transcript.getSnapshot();
    const originalParent = original.blocks.find(
      (block) => block.kind === 'tool' && block.toolCallId === 'parent-call',
    )!;
    const originalChild = original.blocks.find(
      (block) => block.kind === 'tool' && block.toolCallId === 'child-call',
    )!;
    expect(originalChild).toMatchObject({ parentBlockId: originalParent.id });
    const table = new HistoricalTranscriptPageTable({
      maxPages: 5,
      maxRetainedBytes: 1024 * 1024,
      materialize: () => ({
        blocks: original.blocks,
        nextBlockOrdinal: original.nextOrdinal,
        encounteredRecordIds: ['turn-0'],
      }),
    });
    const target = table.admitAnchor(
      0,
      'turn-0',
      'snapshot-1',
      transcriptPage(['turn-0'], { targetRecordId: 'turn-0' }),
    );
    const page = table.getSnapshot().pages.get(target.pageId)!;
    const parent = page.blocks.find(
      (block) => block.kind === 'tool' && block.toolCallId === 'parent-call',
    )!;
    const child = page.blocks.find(
      (block) => block.kind === 'tool' && block.toolCallId === 'child-call',
    )!;
    expect(parent.id).toBe(`${page.id}:${originalParent.id}`);
    expect(child).toMatchObject({
      id: `${page.id}:${originalChild.id}`,
      parentBlockId: parent.id,
      parentToolCallId: 'parent-call',
      toolCallId: 'child-call',
    });
    expect(originalChild).toMatchObject({ parentBlockId: originalParent.id });
  });

  it('deduplicates a durable alias of a record-less live echo and ends at live', async () => {
    const store = createDaemonTurnNavigationStore();
    const { client, getTurnIndexPage, getTranscriptPage } = clientFixture();
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
      const { client, getTurnIndexPage, getTranscriptPage } = clientFixture();
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
      const { client, getTurnIndexPage, getTranscriptPage } = clientFixture();
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

  it('does not publish an old index failure over a newer successful selection', async () => {
    const store = createDaemonTurnNavigationStore({ indexPageSize: 1 });
    const { client, getTurnIndexPage } = clientFixture();
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
    const pending = store.locateOrdinal(0);
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
  });

  it('preserves traversal through cached records overlapped by a new anchor', () => {
    const table = new HistoricalTranscriptPageTable({
      maxPages: 5,
      maxRetainedBytes: 1024 * 1024,
      materialize,
    });
    const cached = table.admitAnchor(
      2,
      'turn-2',
      'snapshot-1',
      transcriptPage(['turn-2', 'turn-3'], { targetRecordId: 'turn-2' }),
    );
    const anchor = table.admitAnchor(
      1,
      'turn-1',
      'snapshot-1',
      transcriptPage(['turn-1', 'turn-2', 'turn-3'], {
        targetRecordId: 'turn-1',
        hasMore: true,
        nextCursor: 'after-3',
      }),
    );
    const snapshot = table.getSnapshot();
    const range = snapshot.ranges.find((item) => item.id === anchor.rangeId)!;
    const records = range.pageIds.flatMap((pageId) => [
      ...snapshot.pages.get(pageId)!.recordIds,
    ]);
    expect(
      records.includes('turn-2') ||
        (range.newer.kind === 'cached' &&
          range.newer.rangeId === cached.rangeId),
    ).toBe(true);
  });
});
