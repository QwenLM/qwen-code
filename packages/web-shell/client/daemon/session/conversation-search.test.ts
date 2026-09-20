/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  DaemonSessionTurnIndexPage,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import {
  createConversationSearchSnippet,
  createDaemonTurnNavigationStore,
  type DaemonTurnNavigationClient,
} from './turn-navigation-store';

function fixture(maxHistoricalPages = 2) {
  const turns: DaemonSessionTurnIndexPage = {
    v: 1,
    sessionId: 'session',
    snapshot: 'frozen',
    totalTurns: 2,
    start: 0,
    turns: [
      { ordinal: 0, turnId: 'u1', kind: 'realtime', label: 'first' },
      { ordinal: 1, turnId: 'u2', kind: 'scheduled', label: 'second' },
    ],
  };
  const block = (
    id: string,
    role: 'user' | 'assistant',
    text: string,
  ): DaemonTranscriptBlock => ({
    id,
    kind: role,
    text,
    sourceRecordIds: [id],
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  });
  const first = [
    block('u1', 'user', 'First prompt'),
    block('a1', 'assistant', 'An older MATCH answer'),
  ];
  const second = [
    block('u2', 'user', 'Second match prompt'),
    block('a2', 'assistant', 'Newest answer'),
  ];
  const client: DaemonTurnNavigationClient = {
    owner: {},
    getTurnIndexPage: vi.fn(async (options) => {
      if (options.start !== undefined && !options.snapshot)
        throw new Error('`start` requires `snapshot`');
      return turns;
    }),
    getTranscriptPage: vi.fn(async (options) => ({
      v: 1,
      sessionId: 'session',
      events: (options.cursor ? second : first).map((item) => ({
        v: 1,
        type: 'test',
        data: item,
      })),
      hasMore: !options.cursor,
      ...(options.cursor ? {} : { nextCursor: 'second' }),
      targetRecordId: 'u1',
    })),
    materializeTranscriptEvents: (events, nextOrdinal, excluded) => {
      const blocks = events
        .map((event) => event.data as DaemonTranscriptBlock)
        .filter((item) => !excluded.has(item.sourceRecordIds![0]!));
      return {
        blocks,
        nextBlockOrdinal: nextOrdinal + blocks.length,
        encounteredRecordIds: blocks.flatMap(
          (item) => item.sourceRecordIds ?? [],
        ),
      };
    },
  };
  const store = createDaemonTurnNavigationStore({ maxHistoricalPages });
  store.configure({ sessionId: 'session', supported: true, client });
  return { store, client, first, second, turns };
}

async function ready(
  store: ReturnType<typeof createDaemonTurnNavigationStore>,
) {
  await vi.waitFor(() => expect(store.getSnapshot().mode).toBe('ready'));
}

describe('conversation search', () => {
  it('streams the exact target page before replacing a full pinned reading window', async () => {
    const { store, client, second } = fixture(1);
    await ready(store);
    const hit = (
      await store.scanConversation('Newest answer', { isCurrent: () => true })
    ).hits[0]!;
    const original = await store.locateOrdinal(0);
    store.setViewportAnchor('reader', original.pageId);
    vi.mocked(client.getTranscriptPage).mockImplementation(async (options) => ({
      v: 1,
      sessionId: 'session',
      targetRecordId: 'u2',
      events: (options.cursor ? [second[1]!] : [second[0]!]).map((data) => ({
        v: 1,
        type: 'test',
        data,
      })),
      hasMore: !options.cursor,
      ...(options.cursor ? {} : { nextCursor: 'target-page' }),
    }));
    const release = vi.fn(() => store.setViewportAnchor('reader'));
    const located = await store.locateViewportSearchHit(
      hit,
      { isCurrent: () => true },
      release,
    );
    expect(release).toHaveBeenCalledOnce();
    expect(located.view).toBe('historical');
    const page = store.getViewportSnapshot().pages.get(located.pageId!)!;
    expect(
      page.blocks.find((block) => block.id === located.blockId)
        ?.sourceRecordIds,
    ).toEqual(['a2']);
    expect([...page.recordIds]).toEqual(['a2']);
    expect(store.getViewportSnapshot().pages.size).toBe(1);
    expect(store.getViewportSnapshot().ranges[0]?.older.kind).toBe('loadable');
    expect(store.getSnapshot().error).toBeUndefined();
  });

  it('replaces an overlapping pinned sequential page only when the exact hit is ready', async () => {
    const { store } = fixture(1);
    await ready(store);
    const hit = (
      await store.scanConversation('older MATCH', { isCurrent: () => true })
    ).hits[0]!;
    const rangeId = await store.openBeforeLive('u2', { isCurrent: () => true });
    const original = store
      .getViewportSnapshot()
      .ranges.find((range) => range.id === rangeId)!;
    store.setViewportAnchor('reader', original.pageIds[0]);
    const release = vi.fn(() => store.setViewportAnchor('reader'));
    const located = await store.locateViewportSearchHit(
      hit,
      { isCurrent: () => true },
      release,
    );
    expect(release).toHaveBeenCalledOnce();
    const page = store.getViewportSnapshot().pages.get(located.pageId!)!;
    expect(
      page.blocks.find((block) => block.id === located.blockId)
        ?.sourceRecordIds,
    ).toEqual(['a1']);
    expect(store.getViewportSnapshot().pages.size).toBe(1);
  });

  it('resolves the exact persisted record even when messages have identical text', async () => {
    const { store, client, first, second } = fixture();
    await ready(store);
    first[1]!.text = 'Repeated answer';
    second[1]!.text = 'Repeated answer';
    vi.mocked(client.getTranscriptPage).mockClear();
    const hit = await store.resolveMessageRecord('a2', {
      isCurrent: () => true,
    });
    expect(hit).toMatchObject({
      recordId: 'a2',
      turnId: 'u2',
      turnOrdinal: 1,
      sessionId: 'session',
    });
    expect(client.getTranscriptPage).toHaveBeenCalledTimes(2);
  });

  it('stops reading after finding a record and returns undefined for missing records', async () => {
    const { store, client } = fixture();
    await ready(store);
    vi.mocked(client.getTranscriptPage).mockClear();
    expect(
      await store.resolveMessageRecord('a1', { isCurrent: () => true }),
    ).toMatchObject({ recordId: 'a1' });
    expect(client.getTranscriptPage).toHaveBeenCalledTimes(1);
    expect(
      await store.resolveMessageRecord('missing', { isCurrent: () => true }),
    ).toBeUndefined();
  });

  it('cancels external record resolution before reading history', async () => {
    const { store, client } = fixture();
    await ready(store);
    vi.mocked(client.getTranscriptPage).mockClear();
    await expect(
      store.resolveMessageRecord('a1', { isCurrent: () => false }),
    ).rejects.toThrow('cancelled');
    expect(client.getTranscriptPage).not.toHaveBeenCalled();
  });

  it('acquires a snapshot before requesting the first page of a long index', async () => {
    const { store, client, turns } = fixture();
    await ready(store);
    vi.mocked(client.getTurnIndexPage)
      .mockClear()
      .mockImplementation(async (options) => {
        if (options.start !== undefined) {
          expect(options.snapshot).toBe('frozen');
          expect(options.start).toBe(0);
          return turns;
        }
        return { ...turns, start: 1, turns: turns.turns.slice(1) };
      });
    const result = await store.scanConversation('match', {
      isCurrent: () => true,
    });
    expect(result.complete).toBe(true);
    expect(result.messageCount).toBe(4);
    expect(result.matchCount).toBe(2);
    expect(client.getTurnIndexPage).toHaveBeenNthCalledWith(1, {
      limit: expect.any(Number),
    });
    expect(client.getTurnIndexPage).toHaveBeenNthCalledWith(2, {
      snapshot: 'frozen',
      start: 0,
      limit: expect.any(Number),
    });
  });

  it('scans all pages without filling the historical viewport and maps actual navigation turns', async () => {
    const { store } = fixture();
    await ready(store);
    const result = await store.scanConversation('match', {
      isCurrent: () => true,
    });
    expect(result).toMatchObject({
      messageCount: 4,
      matchCount: 2,
      complete: true,
      truncated: false,
    });
    expect(
      result.hits.map((hit) => [hit.recordId, hit.turnOrdinal, hit.role]),
    ).toEqual([
      ['a1', 0, 'assistant'],
      ['u2', 1, 'user'],
    ]);
    expect(store.getViewportSnapshot().pages.size).toBe(0);
    expect(
      result.hits[0]!.snippet.slice(
        result.hits[0]!.matchStart,
        result.hits[0]!.matchEnd,
      ),
    ).toBe('MATCH');
  });
  it('stops the threshold count before fetching all history', async () => {
    const { store, client } = fixture();
    await ready(store);
    expect(
      await store.scanConversation('', {
        isCurrent: () => true,
        stopAfterMessages: 2,
      }),
    ).toMatchObject({ messageCount: 2, complete: false });
    expect(client.getTranscriptPage).toHaveBeenCalledTimes(1);
  });
  it('cancels when the request changes', async () => {
    const { store } = fixture();
    await ready(store);
    let active = true;
    await expect(
      store.scanConversation('match', {
        isCurrent: () => active,
        onProgress: () => {
          active = false;
        },
      }),
    ).rejects.toThrow('cancelled');
  });
  it('does not claim partial replay is complete', async () => {
    const { store, client } = fixture();
    await ready(store);
    vi.mocked(client.getTranscriptPage).mockResolvedValueOnce({
      v: 1,
      sessionId: 'session',
      events: [],
      hasMore: false,
      partial: true,
    });
    await expect(
      store.scanConversation('match', { isCurrent: () => true }),
    ).rejects.toThrow();
  });
  it('locates an old assistant using persisted record identity', async () => {
    const { store } = fixture();
    await ready(store);
    const hit = (
      await store.scanConversation('match', { isCurrent: () => true })
    ).hits[0]!;
    expect(
      await store.locateViewportSearchHit(
        hit,
        { isCurrent: () => true },
        () => {},
      ),
    ).toMatchObject({
      view: 'historical',
      blockId: expect.stringContaining('a1'),
    });
  });
  it.each(['user', 'assistant', 'later assistant'] as const)(
    'locates the exact persisted %s record when its turn has an unstamped live alias',
    async (role) => {
      const { store, first, second, turns } = fixture();
      if (role === 'later assistant') second.unshift(first.pop()!);
      turns.turns[0]!.promptId = 'prompt-1';
      first[0]!.promptId = 'prompt-1';
      await ready(store);
      store.observeLiveBlocks([
        { ...first[0]!, id: 'local-user', sourceRecordIds: [] },
      ]);
      const hit = (
        await store.scanConversation(
          role === 'user' ? 'First prompt' : 'older MATCH',
          { isCurrent: () => true },
        )
      ).hits[0]!;
      expect(hit.recordId).toBe(role === 'user' ? 'u1' : 'a1');
      await expect(
        store.locateViewportSearchHit(hit, { isCurrent: () => true }, () => {}),
      ).resolves.toMatchObject(
        role === 'user'
          ? { view: 'live', blockId: 'local-user' }
          : { view: 'historical', blockId: expect.stringContaining('a1') },
      );
    },
  );

  it.each(['loading', 'error'] as const)(
    'locates an exact record beyond a %s newer boundary',
    async (boundaryState) => {
      const { store, client, first, second } = fixture();
      second.unshift(first.pop()!);
      await ready(store);
      const hit = (
        await store.scanConversation('older MATCH', { isCurrent: () => true })
      ).hits[0]!;
      const anchor = await store.locateOrdinal(0);
      expect(anchor.rangeId).toBeDefined();
      let release!: () => void;
      if (boundaryState === 'loading') {
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        vi.mocked(client.getTranscriptPage).mockImplementationOnce(async () => {
          await gate;
          return {
            v: 1,
            sessionId: 'session',
            events: second.map((data) => ({ v: 1, type: 'test', data })),
            hasMore: false,
          };
        });
      } else {
        vi.mocked(client.getTranscriptPage).mockRejectedValueOnce(
          new Error('temporary network failure'),
        );
      }
      const boundary = store.loadViewportBoundary(anchor.rangeId!, 'newer', {
        isCurrent: () => true,
      });
      if (boundaryState === 'error')
        await expect(boundary).rejects.toThrow('temporary network failure');
      expect(store.getViewportSnapshot().ranges[0]!.newer.kind).toBe(
        boundaryState,
      );
      let settled = false;
      const pending = store
        .locateViewportSearchHit(hit, { isCurrent: () => true }, () => {})
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      if (boundaryState === 'loading') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const settledBeforeLoad = settled;
        release();
        await boundary;
        expect(settledBeforeLoad).toBe(false);
      }
      const result = await pending;
      expect(result).toMatchObject({
        value: { view: 'historical', blockId: expect.stringContaining('a1') },
      });
    },
  );

  it('locates a later page of a long turn while evicting the old page', async () => {
    const { store, client, first, second } = fixture(2);
    second.unshift(first.pop()!);
    const middle = [
      {
        ...second[0]!,
        id: 'middle',
        sourceRecordIds: ['middle'],
        text: 'intermediate output',
      },
    ];
    vi.mocked(client.getTranscriptPage).mockImplementation(async (options) => ({
      v: 1,
      sessionId: 'session',
      events: (options.cursor === 'third'
        ? second
        : options.cursor
          ? middle
          : first
      ).map((data) => ({ v: 1, type: 'test', data })),
      hasMore: options.cursor !== 'third',
      ...(options.cursor === 'third'
        ? {}
        : { nextCursor: options.cursor ? 'third' : 'second' }),
      targetRecordId: 'u1',
    }));
    await ready(store);
    const hit = (
      await store.scanConversation('older', { isCurrent: () => true })
    ).hits[0]!;
    expect(hit.turnOrdinal).toBe(0);
    const location = await store.locateViewportSearchHit(
      hit,
      { isCurrent: () => true },
      () => {},
    );
    expect(location).toMatchObject({
      view: 'historical',
      blockId: expect.stringContaining('a1'),
    });
    expect(store.getViewportSnapshot().pages.size).toBeLessThanOrEqual(2);
  });

  it('rejects an expired revision', async () => {
    const { store } = fixture();
    await ready(store);
    const hit = (
      await store.scanConversation('match', { isCurrent: () => true })
    ).hits[0]!;
    await expect(
      store.locateViewportSearchHit(
        { ...hit, revision: hit.revision - 1 },
        { isCurrent: () => true },
        () => {},
      ),
    ).rejects.toThrow('expired');
  });
  it('counts empty attachment messages and finds later fragments without duplicate hits', async () => {
    const { store, first, second } = fixture();
    (first[0] as Extract<DaemonTranscriptBlock, { kind: 'user' }>).text = '';
    first.splice(1, 0, {
      ...first[1]!,
      text: 'unrelated prefix',
    } as DaemonTranscriptBlock);
    second.unshift(first.at(-1)!);
    await ready(store);
    const result = await store.scanConversation('match', {
      isCurrent: () => true,
    });
    expect(result).toMatchObject({
      messageCount: 4,
      matchCount: 2,
      complete: true,
    });
    expect(result.hits.filter((hit) => hit.recordId === 'a1')).toHaveLength(1);
  });

  it('bounds stored results while continuing to count all matching messages', async () => {
    const { store, second } = fixture();
    for (let i = 0; i < 205; i++)
      second.push({
        ...second[1]!,
        id: `extra-${i}`,
        sourceRecordIds: [`extra-${i}`],
        text: 'match',
      } as DaemonTranscriptBlock);
    await ready(store);
    const result = await store.scanConversation('match', {
      isCurrent: () => true,
    });
    expect(result).toMatchObject({
      matchCount: 207,
      complete: true,
      truncated: true,
    });
    expect(result.hits).toHaveLength(200);
    expect(store.getViewportSnapshot().pages.size).toBe(0);
  });

  it('uses frozen index pages to map scheduled and realtime boundaries', async () => {
    const { store, client, turns } = fixture();
    await ready(store);
    vi.mocked(client.getTurnIndexPage).mockImplementation(async (options) => ({
      ...turns,
      start: options.start ?? 0,
      turns: [turns.turns[options.start ?? 0]!],
    }));
    const result = await store.scanConversation('match', {
      isCurrent: () => true,
    });
    expect(result.hits.map((hit) => hit.turnOrdinal)).toEqual([0, 1]);
    expect(client.getTurnIndexPage).toHaveBeenCalledWith(
      expect.objectContaining({ start: 1, snapshot: 'frozen' }),
    );
  });

  it('fails closed when a replay omits a known turn boundary', async () => {
    const { store, second } = fixture();
    second.shift();
    await ready(store);
    await expect(
      store.scanConversation('match', { isCurrent: () => true }),
    ).rejects.toThrow('omitted navigation turns');
  });

  it('counts the unpersisted live tail without double counting persisted blocks or local echoes', async () => {
    const { store, first, second } = fixture();
    first[0]!.promptId = 'prompt-1';
    await ready(store);
    store.observeLiveBlocks([
      {
        ...first[0]!,
        id: 'local-user',
        sourceRecordIds: [],
        promptId: 'prompt-1',
      },
      second[1]!,
      {
        ...second[1]!,
        id: 'new-live',
        sourceRecordIds: [],
        promptId: 'new-prompt',
      },
    ]);
    const result = await store.scanConversation('', { isCurrent: () => true });
    expect(result.messageCount).toBe(5);
  });

  it('escapes patterns and preserves original Unicode offsets', () => {
    expect(createConversationSearchSnippet('İ [a.b] MATCH', '[a.b]')).toEqual({
      snippet: 'İ [a.b] MATCH',
      matchStart: 2,
      matchEnd: 7,
    });
    expect(
      createConversationSearchSnippet('前文 搜索 内容', '搜索'),
    ).toMatchObject({ matchStart: 3, matchEnd: 5 });
    expect(createConversationSearchSnippet('ordinary', '.*')).toBeUndefined();
  });
});
