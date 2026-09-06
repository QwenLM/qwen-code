import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DaemonHttpError,
  type DaemonSessionTurnIndexEntry,
  type DaemonSessionTurnIndexPage,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import {
  SessionTurnIndexStore,
  type TurnIndexPageFetcher,
} from './turnIndexStore.js';

function turn(
  ordinal: number,
  turnId = `turn-${ordinal}`,
  promptId?: string,
): DaemonSessionTurnIndexEntry {
  return {
    ordinal,
    turnId,
    kind: 'prompt',
    ...(promptId !== undefined ? { promptId } : {}),
    label: `label-${ordinal}`,
  };
}

function page(input: {
  start: number;
  count: number;
  snapshot?: string;
  totalTurns?: number;
  firstOrdinal?: number;
  promptIds?: ReadonlyMap<number, string | undefined>;
}): DaemonSessionTurnIndexPage {
  const turns: DaemonSessionTurnIndexEntry[] = [];
  for (let index = 0; index < input.count; index += 1) {
    const ordinal = (input.firstOrdinal ?? input.start) + index;
    const promptId = input.promptIds?.get(ordinal);
    turns.push(turn(ordinal, `turn-${ordinal}`, promptId));
  }
  return {
    v: 1,
    sessionId: 'session-1',
    snapshot: input.snapshot ?? 'snap-1',
    totalTurns: input.totalTurns ?? input.start + input.count,
    start: input.start,
    turns,
  };
}

function makeStore(input?: {
  fetchPage?: TurnIndexPageFetcher;
  enabled?: boolean;
  pageSize?: number;
  maxPages?: number;
  maxPageBytes?: number;
  scheduled?: Array<{ fn: () => void; delayMs: number }>;
}) {
  const fetchPage =
    input?.fetchPage ?? vi.fn<TurnIndexPageFetcher>(() => Promise.reject());
  const scheduled = input?.scheduled ?? [];
  const store = new SessionTurnIndexStore({
    sessionId: 'session-1',
    fetchPage,
    enabled: input?.enabled,
    pageSize: input?.pageSize,
    maxPages: input?.maxPages,
    maxPageBytes: input?.maxPageBytes,
    scheduleRetry: (fn, delayMs) => scheduled.push({ fn, delayMs }),
  });
  return { store, fetchPage, scheduled };
}

function seedPageOf(count: number, total = count) {
  return page({ start: Math.max(0, total - count), count, totalTurns: total });
}

async function seededStore(
  input?: Parameters<typeof makeStore>[0] & {
    seedCount?: number;
    total?: number;
  },
) {
  const harness = makeStore({
    ...input,
    fetchPage: input?.fetchPage,
  });
  if (input?.fetchPage === undefined) {
    (harness.fetchPage as ReturnType<typeof vi.fn>).mockResolvedValue(
      seedPageOf(input?.seedCount ?? 3, input?.total ?? 3),
    );
  }
  await harness.store.seed();
  return harness;
}

describe('SessionTurnIndexStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('capability gate', () => {
    it('latches disabled when the capability is absent', async () => {
      const { store, fetchPage } = makeStore({ enabled: false });
      await store.seed();
      expect(store.getState().status).toBe('disabled');
      expect(fetchPage).not.toHaveBeenCalled();
    });
  });

  describe('seed', () => {
    it('loads the newest page first and adopts snapshot/totalTurns', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValue(
          page({ start: 8, count: 2, totalTurns: 10, snapshot: 'snap-a' }),
        );
      const { store } = makeStore({ fetchPage });
      await store.seed();
      expect(fetchPage).toHaveBeenCalledWith({ limit: 200 });
      const state = store.getState();
      expect(state.status).toBe('ready');
      expect(state.snapshot).toBe('snap-a');
      expect(state.totalTurns).toBe(10);
      expect([...state.pages.keys()]).toEqual([8]);
    });

    it('latches unsupported on 413 transcript_too_large', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockRejectedValue(
          new DaemonHttpError(413, { code: 'transcript_too_large' }, 'big'),
        );
      const { store } = makeStore({ fetchPage });
      await store.seed();
      expect(store.getState().status).toBe('unsupported');
      // Latched for the session: later seeds/refresh are no-ops.
      await store.seed();
      await store.refreshTail();
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('enters error and retries bounded on transient failure', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockRejectedValue(new Error('boom'));
      const { store, scheduled } = makeStore({ fetchPage });
      await store.seed();
      expect(store.getState().status).toBe('error');
      expect(scheduled).toHaveLength(1);
      // Retry keeps failing: attempts are bounded.
      for (let index = 0; index < 5; index += 1) {
        const task = scheduled.shift();
        if (task === undefined) break;
        await task.fn();
        await Promise.resolve();
      }
      expect(fetchPage).toHaveBeenCalledTimes(4); // initial + 3 retries
      expect(scheduled).toHaveLength(0);
      expect(store.getState().status).toBe('error');
    });
  });

  describe('older pages', () => {
    it('requests start=max(0,boundary-limit) with a clamped, butted limit', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 5, count: 5, totalTurns: 10, snapshot: 'snap-a' }),
        )
        .mockResolvedValueOnce(
          page({ start: 2, count: 3, totalTurns: 10, snapshot: 'snap-a' }),
        );
      const { store } = makeStore({ fetchPage, pageSize: 3 });
      await store.seed();
      await store.loadOlder();
      // boundary=5, pageSize=3 → start=2, limit=3 (butts against 5).
      expect(fetchPage).toHaveBeenNthCalledWith(2, {
        snapshot: 'snap-a',
        start: 2,
        limit: 3,
      });
      expect([...store.getState().pages.keys()].sort((a, b) => a - b)).toEqual([
        2, 5,
      ]);
    });

    it('sends no request when boundary == 0', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValue(page({ start: 0, count: 2, totalTurns: 2 }));
      const { store } = makeStore({ fetchPage });
      await store.seed();
      await store.loadOlder();
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('clamps the older request to ordinal 0 with a shrunk limit', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 2, count: 3, totalTurns: 10, snapshot: 'snap-a' }),
        )
        .mockResolvedValueOnce(
          page({ start: 0, count: 2, totalTurns: 10, snapshot: 'snap-a' }),
        );
      const { store } = makeStore({ fetchPage, pageSize: 5 });
      await store.seed();
      await store.loadOlder();
      // boundary=2, pageSize=5 → start=0, limit=2 (never 0/negative).
      expect(fetchPage).toHaveBeenNthCalledWith(2, {
        snapshot: 'snap-a',
        start: 0,
        limit: 2,
      });
    });
  });

  describe('ensurePage', () => {
    it('is a no-op when the ordinal is already covered', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValue(page({ start: 0, count: 3, totalTurns: 3 }));
      const { store } = makeStore({ fetchPage });
      await store.seed();
      await store.ensurePage(1);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('requests the largest non-overlapping slice of the uncovered interval', async () => {
      // Retained: [8,9]; then loadOlder admits [4..7]; ensurePage(1) must
      // fetch the remaining uncovered interval [0..3] in one slice.
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 8, count: 2, totalTurns: 10, snapshot: 'snap-a' }),
        )
        .mockResolvedValueOnce(
          page({ start: 4, count: 4, totalTurns: 10, snapshot: 'snap-a' }),
        )
        .mockResolvedValueOnce(
          page({ start: 0, count: 4, totalTurns: 10, snapshot: 'snap-a' }),
        );
      const { store } = makeStore({ fetchPage, pageSize: 4 });
      await store.seed();
      await store.loadOlder();
      await store.ensurePage(1);
      // loadOlder: boundary=8, pageSize 4 → start=4, limit=4.
      expect(fetchPage).toHaveBeenNthCalledWith(2, {
        snapshot: 'snap-a',
        start: 4,
        limit: 4,
      });
      // ensurePage(1): uncovered interval [0..3], pageSize 4 → start=0, limit=4.
      expect(fetchPage).toHaveBeenNthCalledWith(3, {
        snapshot: 'snap-a',
        start: 0,
        limit: 4,
      });
    });

    it('re-seeds when the response snapshot does not match the request', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 5, count: 5, totalTurns: 10, snapshot: 'snap-a' }),
        )
        .mockResolvedValueOnce(
          page({ start: 2, count: 3, totalTurns: 10, snapshot: 'snap-b' }),
        )
        .mockResolvedValueOnce(
          page({ start: 6, count: 4, totalTurns: 10, snapshot: 'snap-c' }),
        );
      const { store } = makeStore({ fetchPage, pageSize: 3 });
      await store.seed();
      await store.loadOlder();
      // Mismatched snapshot → invalidate and re-seed from a fresh tail request.
      expect(fetchPage).toHaveBeenNthCalledWith(3, { limit: 3 });
      const state = store.getState();
      expect(state.snapshot).toBe('snap-c');
      expect([...state.pages.keys()]).toEqual([6]);
    });
  });

  describe('tail refresh (two-step merge)', () => {
    it('skips the fill when no new navigation turn arrived, adopting the new snapshot', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 0, count: 3, totalTurns: 3, snapshot: 'snap-a' }),
        )
        .mockResolvedValueOnce(
          page({ start: 0, count: 3, totalTurns: 3, snapshot: 'snap-b' }),
        );
      const { store } = makeStore({ fetchPage });
      await store.seed();
      const pagesBefore = store.getState().pages;
      await store.refreshTail();
      // Validation response never admitted: retained pages are untouched.
      expect(store.getState().pages).toBe(pagesBefore);
      expect(store.getState().snapshot).toBe('snap-b');
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });

    it('lands a clamped fill on the grid for an append-only tail', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 0, count: 3, totalTurns: 3, snapshot: 'snap-a' }),
        )
        // validation: newest window [2..4] under snap-b, total 5
        .mockResolvedValueOnce(
          page({ start: 2, count: 3, totalTurns: 5, snapshot: 'snap-b' }),
        )
        // fill: start = largestCovered+1 = 3, limit = 5-3 = 2
        .mockResolvedValueOnce(
          page({ start: 3, count: 2, totalTurns: 5, snapshot: 'snap-b' }),
        );
      const { store } = makeStore({ fetchPage, pageSize: 3 });
      await store.seed();
      await store.refreshTail();
      expect(fetchPage).toHaveBeenNthCalledWith(3, {
        snapshot: 'snap-b',
        start: 3,
        limit: 2,
      });
      const state = store.getState();
      expect(state.snapshot).toBe('snap-b');
      expect(state.totalTurns).toBe(5);
      expect([...state.pages.keys()].sort((a, b) => a - b)).toEqual([0, 3]);
      // Ordinals 2 appears in both the old page and the validation response;
      // the fill starts at 3, so no overlap is admitted.
      const ordinals = [...state.pages.values()].flatMap((p) =>
        p.turns.map((t) => t.ordinal),
      );
      expect(ordinals).toEqual([0, 1, 2, 3, 4]);
    });

    it('chunks the fill when the uncovered tail exceeds one page', async () => {
      // The validation window overlaps retained coverage ({0,1}) but the
      // uncovered tail (ordinals 2..4) exceeds the page size of 2, so the
      // fill iterates in page-sized chunks.
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 0, count: 2, totalTurns: 2, snapshot: 'snap-a' }),
        )
        .mockResolvedValueOnce(
          page({ start: 0, count: 2, totalTurns: 5, snapshot: 'snap-b' }),
        )
        .mockResolvedValueOnce(
          page({ start: 2, count: 2, totalTurns: 5, snapshot: 'snap-b' }),
        )
        .mockResolvedValueOnce(
          page({ start: 4, count: 1, totalTurns: 5, snapshot: 'snap-b' }),
        );
      const { store } = makeStore({ fetchPage, pageSize: 2 });
      await store.seed();
      await store.refreshTail();
      // largestCovered=1, totalTurns-1=4 → fill start=2 limit=2, then start=4 limit=1.
      expect(fetchPage).toHaveBeenNthCalledWith(3, {
        snapshot: 'snap-b',
        start: 2,
        limit: 2,
      });
      expect(fetchPage).toHaveBeenNthCalledWith(4, {
        snapshot: 'snap-b',
        start: 4,
        limit: 1,
      });
      expect(store.getState().totalTurns).toBe(5);
      expect([...store.getState().pages.keys()].sort((a, b) => a - b)).toEqual([
        0, 2, 4,
      ]);
    });

    it('treats a shrunk chain (largest covered > totalTurns-1) as divergent', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 0, count: 5, totalTurns: 5, snapshot: 'snap-a' }),
        )
        // Another client rewound: chain now has 2 turns.
        .mockResolvedValueOnce(
          page({ start: 0, count: 2, totalTurns: 2, snapshot: 'snap-b' }),
        );
      const { store } = makeStore({ fetchPage, pageSize: 5 });
      await store.seed();
      await store.refreshTail();
      const state = store.getState();
      expect(state.snapshot).toBe('snap-b');
      expect(state.totalTurns).toBe(2);
      expect([...state.pages.keys()]).toEqual([0]);
      expect(state.pages.get(0)?.turns).toHaveLength(2);
    });

    it('treats a turnId mismatch on overlapping ordinals as divergent', async () => {
      const mismatching = page({
        start: 0,
        count: 3,
        totalTurns: 3,
        snapshot: 'snap-b',
      });
      mismatching.turns[1]!.turnId = 'rewritten';
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 0, count: 3, totalTurns: 3, snapshot: 'snap-a' }),
        )
        .mockResolvedValueOnce(mismatching);
      const { store } = makeStore({ fetchPage });
      await store.seed();
      await store.refreshTail();
      const state = store.getState();
      expect(state.snapshot).toBe('snap-b');
      expect(state.pages.get(0)?.turns[1]?.turnId).toBe('rewritten');
    });

    it('treats zero overlap as divergent and resets to the validation page', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 0, count: 2, totalTurns: 2, snapshot: 'snap-a' }),
        )
        .mockResolvedValueOnce(
          page({ start: 8, count: 2, totalTurns: 10, snapshot: 'snap-b' }),
        );
      const { store } = makeStore({ fetchPage, pageSize: 2 });
      await store.seed();
      await store.refreshTail();
      const state = store.getState();
      expect([...state.pages.keys()]).toEqual([8]);
      expect(state.snapshot).toBe('snap-b');
      expect(state.totalTurns).toBe(10);
    });

    it('re-seeds on 409 transcript_snapshot_unavailable', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 0, count: 2, totalTurns: 2, snapshot: 'snap-a' }),
        )
        .mockRejectedValueOnce(
          new DaemonHttpError(
            409,
            { code: 'transcript_snapshot_unavailable' },
            'gone',
          ),
        )
        .mockResolvedValueOnce(
          page({ start: 0, count: 2, totalTurns: 2, snapshot: 'snap-c' }),
        );
      const { store } = makeStore({ fetchPage });
      await store.seed();
      await store.refreshTail();
      // The recovery is a fresh tail request without a snapshot.
      expect(fetchPage).toHaveBeenNthCalledWith(3, { limit: 200 });
      expect(store.getState().snapshot).toBe('snap-c');
      expect(store.getState().status).toBe('ready');
    });
  });

  describe('LRU eviction', () => {
    it('bounds the page map, keeps totalTurns, and pins the newest page', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 6, count: 2, totalTurns: 8, snapshot: 'snap-a' }),
        );
      const { store } = makeStore({ fetchPage, pageSize: 2, maxPages: 2 });
      await store.seed();
      // Admit older pages [4..5], [2..3], [0..1] — exceeds maxPages=2.
      for (const start of [4, 2, 0]) {
        fetchPage.mockResolvedValueOnce(
          page({ start, count: 2, totalTurns: 8, snapshot: 'snap-a' }),
        );
        await store.loadOlder();
      }
      const state = store.getState();
      const starts = [...state.pages.keys()].sort((a, b) => a - b);
      expect(starts.length).toBeLessThanOrEqual(2);
      // The newest page (start 6) is pinned for refresh validation.
      expect(starts).toContain(6);
      // Evicting metadata never changes totalTurns.
      expect(state.totalTurns).toBe(8);
    });
  });

  describe('reconciliation', () => {
    it('removes a live prompt provisional when its promptId appears in the index', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 0, count: 2, totalTurns: 2, snapshot: 'snap-a' }),
        )
        .mockResolvedValueOnce(
          page({
            start: 1,
            count: 2,
            totalTurns: 3,
            snapshot: 'snap-b',
            promptIds: new Map([[2, 'prompt-x']]),
          }),
        )
        .mockResolvedValueOnce(
          page({
            start: 2,
            count: 1,
            totalTurns: 3,
            snapshot: 'snap-b',
            promptIds: new Map([[2, 'prompt-x']]),
          }),
        );
      const { store } = makeStore({ fetchPage, pageSize: 2 });
      await store.seed();
      store.addLivePrompt({ promptId: 'prompt-x', label: 'hello' });
      expect(store.getState().liveEntries).toHaveLength(1);
      await store.refreshTail();
      expect(store.getState().liveEntries).toHaveLength(0);
    });

    it('reconciles a legacy no-prompt-id provisional by record UUID', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 0, count: 2, totalTurns: 2, snapshot: 'snap-a' }),
        );
      const { store } = makeStore({ fetchPage });
      await store.seed();
      store.addLivePrompt({ promptId: 'prompt-legacy', label: 'legacy' });
      // The persisted echo lands without a promptId match in the index but
      // the block links the provisional to record turn-1's UUID.
      const echoBlock = {
        id: 'b-1',
        promptId: 'prompt-legacy',
        sourceRecordIds: ['turn-1'],
      } as DaemonTranscriptBlock;
      store.observeAdmittedBlocks([echoBlock]);
      expect(store.getState().liveEntries).toHaveLength(0);
    });

    it('never reconciles by label or timestamp', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 0, count: 2, totalTurns: 2, snapshot: 'snap-a' }),
        );
      const { store } = makeStore({ fetchPage });
      await store.seed();
      // The index entry label is "label-0"/"label-1"; a provisional with the
      // same label but an unmatched promptId must persist.
      store.addLivePrompt({ promptId: 'prompt-y', label: 'label-0' });
      await store.refreshTail();
      expect(store.getState().liveEntries).toHaveLength(1);
    });

    it('keeps unmatched provisionals across refreshes', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValue(
          page({ start: 0, count: 2, totalTurns: 2, snapshot: 'snap-a' }),
        );
      const { store } = makeStore({ fetchPage });
      await store.seed();
      store.addLivePrompt({ promptId: 'prompt-z', label: 'pending' });
      await store.refreshTail();
      expect(store.getState().liveEntries).toHaveLength(1);
    });

    it('manages shell overlays as live-only entries', async () => {
      const { store } = await seededStore();
      store.addLiveShell({ blockId: 'blk-1', label: 'ls -la' });
      expect(store.getState().liveEntries).toEqual([
        { id: 'shell:blk-1', kind: 'shell', label: 'ls -la' },
      ]);
      // Shell overlays never affect totalTurns.
      expect(store.getState().totalTurns).toBe(3);
      store.removeLiveShell('blk-1');
      expect(store.getState().liveEntries).toHaveLength(0);
    });
  });

  describe('rewind', () => {
    it('clears pages and provisionals, then re-seeds', async () => {
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValue(
          page({ start: 0, count: 2, totalTurns: 2, snapshot: 'snap-r' }),
        );
      const { store } = makeStore({ fetchPage });
      await store.seed();
      store.addLivePrompt({ promptId: 'prompt-w', label: 'gone' });
      await store.handleRewind();
      const state = store.getState();
      expect(state.liveEntries).toHaveLength(0);
      expect(state.snapshot).toBe('snap-r');
      // Seed + reseed = two tail requests.
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });
  });

  describe('findTurn', () => {
    it('returns the entry with its own page snapshot', async () => {
      // Pages minted by different snapshots legitimately coexist after an
      // append-only refresh: the seed page keeps snap-a, the fill page
      // carries snap-b.
      const fetchPage = vi
        .fn<TurnIndexPageFetcher>()
        .mockResolvedValueOnce(
          page({ start: 4, count: 2, totalTurns: 6, snapshot: 'snap-a' }),
        )
        .mockResolvedValueOnce(
          page({ start: 5, count: 2, totalTurns: 7, snapshot: 'snap-b' }),
        )
        .mockResolvedValueOnce(
          page({ start: 6, count: 1, totalTurns: 7, snapshot: 'snap-b' }),
        );
      const { store } = makeStore({ fetchPage, pageSize: 2 });
      await store.seed();
      await store.refreshTail();
      expect(store.findTurn('turn-4')).toEqual({
        entry: expect.objectContaining({ ordinal: 4 }),
        snapshot: 'snap-a',
      });
      expect(store.findTurn('turn-6')?.snapshot).toBe('snap-b');
      expect(store.findTurn('missing')).toBeUndefined();
    });

    it('exposes known turn ids for the locator map', async () => {
      const { store } = await seededStore({ seedCount: 2, total: 4 });
      expect([...store.getKnownTurnIds()].sort()).toEqual(['turn-2', 'turn-3']);
    });
  });
});
