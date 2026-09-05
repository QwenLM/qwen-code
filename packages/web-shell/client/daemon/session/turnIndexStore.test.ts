/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  DaemonSessionTurnIndexEntry,
  DaemonSessionTurnIndexPage,
  DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import {
  admitSeedPage,
  admitTurnIndexPage,
  adoptRefreshedTail,
  appendLivePromptEntry,
  appendLiveShellEntry,
  buildTurnLocator,
  classifyTurnIndexFailure,
  createSessionTurnIndexState,
  coveredOrdinalBounds,
  invalidateTurnIndexSnapshot,
  isOrdinalCovered,
  latchTurnIndexUnsupported,
  planEnsurePageRequest,
  planOlderPageRequest,
  planTailRefresh,
  reconcileLiveEntries,
  removeLiveEntry,
  resetToTailPage,
  turnIndexCoverage,
  type SessionTurnIndexState,
} from './turnIndexStore.js';

const PAGE_SIZE = 200;

function turn(
  ordinal: number,
  overrides: Partial<DaemonSessionTurnIndexEntry> = {},
): DaemonSessionTurnIndexEntry {
  return {
    ordinal,
    turnId: overrides.turnId ?? `turn-${ordinal}`,
    kind: 'prompt',
    label: overrides.label ?? `Turn ${ordinal}`,
    ...overrides,
  };
}

function turns(
  ordinals: readonly number[],
  overrides: Partial<DaemonSessionTurnIndexEntry> = {},
): DaemonSessionTurnIndexEntry[] {
  return ordinals.map((ordinal) => turn(ordinal, overrides));
}

function indexPage(
  page: Omit<DaemonSessionTurnIndexPage, 'v' | 'sessionId'>,
): DaemonSessionTurnIndexPage {
  return { v: 1, sessionId: 's1', ...page };
}

/** A store holding ordinals 5..9 of a ten-turn chain, minted by `snap-1`. */
function seededState(): SessionTurnIndexState {
  return admitSeedPage(
    createSessionTurnIndexState('s1', 'idle'),
    indexPage({
      snapshot: 'snap-1',
      totalTurns: 10,
      start: 5,
      turns: turns([5, 6, 7, 8, 9]),
    }),
  );
}

describe('seed', () => {
  it('adopts the snapshot and turn count and keys the page by its start', () => {
    const state = seededState();
    expect(state.status).toBe('ready');
    expect(state.snapshot).toBe('snap-1');
    expect(state.totalTurns).toBe(10);
    expect([...state.pages.keys()]).toEqual([5]);
    expect(coveredOrdinalBounds(state)).toEqual({ oldest: 5, newest: 9 });
  });

  it('seeds at ordinal 0 for a chain no longer than one page', () => {
    const state = admitSeedPage(
      createSessionTurnIndexState('s1', 'idle'),
      indexPage({
        snapshot: 'snap-1',
        totalTurns: 3,
        start: 0,
        turns: turns([0, 1, 2]),
      }),
    );
    expect([...state.pages.keys()]).toEqual([0]);
    // The oldest turn is retained, so no older page exists to ask for.
    expect(planOlderPageRequest(state, PAGE_SIZE)).toBeUndefined();
  });

  it('keeps an empty chain readable without a page', () => {
    const state = admitSeedPage(
      createSessionTurnIndexState('s1', 'idle'),
      indexPage({ snapshot: 'snap-1', totalTurns: 0, start: 0, turns: [] }),
    );
    expect(state.status).toBe('ready');
    expect(state.totalTurns).toBe(0);
    expect(state.pages.size).toBe(0);
  });
});

describe('coverage', () => {
  it('merges adjacent pages into one interval', () => {
    let state = seededState();
    state =
      admitTurnIndexPage(
        state,
        indexPage({
          snapshot: 'snap-1',
          totalTurns: 10,
          start: 2,
          turns: turns([2, 3, 4]),
        }),
        'snap-1',
      ) ?? state;
    expect(turnIndexCoverage(state)).toEqual([{ start: 2, endInclusive: 9 }]);
    expect(isOrdinalCovered(state, 2)).toBe(true);
    expect(isOrdinalCovered(state, 1)).toBe(false);
  });

  it('keeps a hole between non-adjacent pages', () => {
    let state = seededState();
    state =
      admitTurnIndexPage(
        state,
        indexPage({
          snapshot: 'snap-1',
          totalTurns: 10,
          start: 0,
          turns: turns([0, 1]),
        }),
        'snap-1',
      ) ?? state;
    expect(turnIndexCoverage(state)).toEqual([
      { start: 0, endInclusive: 1 },
      { start: 5, endInclusive: 9 },
    ]);
    expect(isOrdinalCovered(state, 3)).toBe(false);
  });
});

describe('planOlderPageRequest', () => {
  it('shrinks the limit to butt exactly against the covered ordinals', () => {
    expect(planOlderPageRequest(seededState(), PAGE_SIZE)).toEqual({
      snapshot: 'snap-1',
      start: 0,
      limit: 5,
    });
  });

  it('takes the newest slice of the uncovered older range', () => {
    expect(planOlderPageRequest(seededState(), 3)).toEqual({
      snapshot: 'snap-1',
      start: 2,
      limit: 3,
    });
  });

  it('sends nothing once the oldest turn is retained', () => {
    const state = admitSeedPage(
      createSessionTurnIndexState('s1', 'idle'),
      indexPage({
        snapshot: 'snap-1',
        totalTurns: 10,
        start: 0,
        turns: turns([0, 1, 2]),
      }),
    );
    // A clamped limit would compute to zero here, which the daemon rejects.
    expect(planOlderPageRequest(state, PAGE_SIZE)).toBeUndefined();
  });

  it('sends nothing before a snapshot exists', () => {
    expect(
      planOlderPageRequest(createSessionTurnIndexState('s1', 'idle'), 10),
    ).toBeUndefined();
  });
});

describe('planEnsurePageRequest', () => {
  it('is a no-op for a covered ordinal', () => {
    expect(planEnsurePageRequest(seededState(), 7, PAGE_SIZE)).toBeUndefined();
  });

  it('is a no-op outside the durable range', () => {
    expect(planEnsurePageRequest(seededState(), 10, PAGE_SIZE)).toBeUndefined();
    expect(planEnsurePageRequest(seededState(), -1, PAGE_SIZE)).toBeUndefined();
  });

  it('requests the whole uncovered interval when it fits', () => {
    expect(planEnsurePageRequest(seededState(), 2, PAGE_SIZE)).toEqual({
      snapshot: 'snap-1',
      start: 0,
      limit: 5,
    });
  });

  it('requests a slice that still contains the ordinal', () => {
    expect(planEnsurePageRequest(seededState(), 2, 2)).toEqual({
      snapshot: 'snap-1',
      start: 2,
      limit: 2,
    });
  });

  it('stays inside an interior hole', () => {
    const seeded = admitSeedPage(
      createSessionTurnIndexState('s1', 'idle'),
      indexPage({
        snapshot: 'snap-1',
        totalTurns: 20,
        start: 15,
        turns: turns([15, 16, 17, 18, 19]),
      }),
    );
    const state =
      admitTurnIndexPage(
        seeded,
        indexPage({
          snapshot: 'snap-1',
          totalTurns: 20,
          start: 5,
          turns: turns([5, 6, 7, 8, 9]),
        }),
        'snap-1',
      ) ?? seeded;
    expect(turnIndexCoverage(state)).toEqual([
      { start: 5, endInclusive: 9 },
      { start: 15, endInclusive: 19 },
    ]);
    // The hole is 10..14; the request must not overlap either page.
    expect(planEnsurePageRequest(state, 12, PAGE_SIZE)).toEqual({
      snapshot: 'snap-1',
      start: 10,
      limit: 5,
    });
    expect(planEnsurePageRequest(state, 11, 2)).toEqual({
      snapshot: 'snap-1',
      start: 11,
      limit: 2,
    });
  });
});

describe('admitTurnIndexPage', () => {
  it('admits a non-overlapping page minted by the requested snapshot', () => {
    const state =
      admitTurnIndexPage(
        seededState(),
        indexPage({
          snapshot: 'snap-1',
          totalTurns: 10,
          start: 3,
          turns: turns([3, 4]),
        }),
        'snap-1',
      ) ?? undefined;
    expect(state).toBeDefined();
    expect([...(state?.pages.keys() ?? [])].sort((a, b) => a - b)).toEqual([
      3, 5,
    ]);
  });

  it('refuses a page minted by a different snapshot', () => {
    expect(
      admitTurnIndexPage(
        seededState(),
        indexPage({
          snapshot: 'snap-2',
          totalTurns: 12,
          start: 3,
          turns: turns([3, 4]),
        }),
        'snap-1',
      ),
    ).toBeUndefined();
  });

  it('refuses a page that overlaps retained coverage', () => {
    expect(
      admitTurnIndexPage(
        seededState(),
        indexPage({
          snapshot: 'snap-1',
          totalTurns: 10,
          start: 4,
          turns: turns([4, 5]),
        }),
        'snap-1',
      ),
    ).toBeUndefined();
  });

  it('leaves the state alone for an empty page', () => {
    const state = seededState();
    expect(
      admitTurnIndexPage(
        state,
        indexPage({ snapshot: 'snap-1', totalTurns: 10, start: 3, turns: [] }),
        'snap-1',
      ),
    ).toBe(state);
  });
});

describe('planTailRefresh', () => {
  it('skips the fill when the append produced no new navigation turn', () => {
    const plan = planTailRefresh(
      seededState(),
      indexPage({
        snapshot: 'snap-2',
        totalTurns: 10,
        start: 5,
        turns: turns([5, 6, 7, 8, 9]),
      }),
      PAGE_SIZE,
    );
    expect(plan).toEqual({
      kind: 'append-only',
      snapshot: 'snap-2',
      totalTurns: 10,
      fills: [],
    });
  });

  it('plans one clamped fill landing on the grid', () => {
    const plan = planTailRefresh(
      seededState(),
      indexPage({
        snapshot: 'snap-2',
        totalTurns: 12,
        start: 5,
        turns: turns([5, 6, 7, 8, 9, 10, 11]),
      }),
      PAGE_SIZE,
    );
    expect(plan).toEqual({
      kind: 'append-only',
      snapshot: 'snap-2',
      totalTurns: 12,
      fills: [{ start: 10, limit: 2 }],
    });
  });

  it('chunks the fill when the uncovered tail exceeds one page', () => {
    // Validating with a narrower window than the fill page size is the only
    // way to expose more than a page of uncovered tail: overlap with the
    // retained page pins the newest covered ordinal inside the validation
    // window, so a same-sized validation always leaves less than a page.
    const state = admitSeedPage(
      createSessionTurnIndexState('s1', 'idle'),
      indexPage({
        snapshot: 'snap-1',
        totalTurns: 260,
        start: 250,
        turns: turns([250, 251, 252, 253, 254]),
      }),
    );
    const plan = planTailRefresh(
      state,
      indexPage({
        snapshot: 'snap-2',
        totalTurns: 460,
        start: 250,
        turns: turns([250, 251, 252, 253, 254, 255, 256, 257, 258, 259]),
      }),
      PAGE_SIZE,
    );
    expect(plan).toMatchObject({ kind: 'append-only', totalTurns: 460 });
    expect(plan.kind === 'append-only' ? plan.fills : undefined).toEqual([
      { start: 255, limit: 200 },
      { start: 455, limit: 5 },
    ]);
  });

  it('reports divergence when a retained turnId no longer matches', () => {
    expect(
      planTailRefresh(
        seededState(),
        indexPage({
          snapshot: 'snap-2',
          totalTurns: 10,
          start: 5,
          turns: turns([5, 6, 7, 8, 9], { turnId: 'rewritten' }),
        }),
        PAGE_SIZE,
      ),
    ).toEqual({ kind: 'divergent' });
  });

  it('reports divergence when there is no overlap to validate against', () => {
    expect(
      planTailRefresh(
        seededState(),
        indexPage({
          snapshot: 'snap-2',
          totalTurns: 400,
          start: 200,
          turns: turns([200, 201]),
        }),
        PAGE_SIZE,
      ),
    ).toEqual({ kind: 'divergent' });
  });

  it('reports divergence when the chain shrank past the retained coverage', () => {
    // Another client rewound the session: ordinals 5 and 6 still match, but
    // the store holds ordinals the chain no longer has. Without this exit the
    // fill limit would compute negative and `totalTurns` would drop below the
    // retained coverage.
    expect(
      planTailRefresh(
        seededState(),
        indexPage({
          snapshot: 'snap-2',
          totalTurns: 7,
          start: 5,
          turns: turns([5, 6]),
        }),
        PAGE_SIZE,
      ),
    ).toEqual({ kind: 'divergent' });
  });

  it('never admits the validation response and never mutates the store', () => {
    const state = seededState();
    const before = [...state.pages.entries()];
    planTailRefresh(
      state,
      indexPage({
        snapshot: 'snap-2',
        totalTurns: 12,
        start: 5,
        turns: turns([5, 6, 7, 8, 9, 10, 11]),
      }),
      PAGE_SIZE,
    );
    expect([...state.pages.entries()]).toEqual(before);
    expect(state.snapshot).toBe('snap-1');
    expect(state.totalTurns).toBe(10);
  });
});

describe('applying a refresh', () => {
  it('keeps retained pages when the chain only grew', () => {
    const state = adoptRefreshedTail(seededState(), 'snap-2', 12);
    expect(state.snapshot).toBe('snap-2');
    expect(state.totalTurns).toBe(12);
    expect([...state.pages.keys()]).toEqual([5]);
    // The retained page keeps the snapshot that produced it as its read
    // authority, so it stays usable after the store adopts a newer one.
    expect(state.pages.get(5)?.snapshot).toBe('snap-1');
  });

  it('admits a fill page against the refreshed snapshot', () => {
    const refreshed = adoptRefreshedTail(seededState(), 'snap-2', 12);
    const filled = admitTurnIndexPage(
      refreshed,
      indexPage({
        snapshot: 'snap-2',
        totalTurns: 12,
        start: 10,
        turns: turns([10, 11]),
      }),
      'snap-2',
    );
    expect(filled).toBeDefined();
    expect([...(filled?.pages.keys() ?? [])].sort((a, b) => a - b)).toEqual([
      5, 10,
    ]);
    expect(turnIndexCoverage(filled ?? refreshed)).toEqual([
      { start: 5, endInclusive: 11 },
    ]);
  });

  it('clears every page and adopts the response when divergent', () => {
    const withOlder =
      admitTurnIndexPage(
        seededState(),
        indexPage({
          snapshot: 'snap-1',
          totalTurns: 10,
          start: 0,
          turns: turns([0, 1, 2, 3, 4]),
        }),
        'snap-1',
      ) ?? seededState();
    const prompt = appendLivePromptEntry(withOlder, 'p1', 'in flight');
    const reset = resetToTailPage(
      prompt,
      indexPage({
        snapshot: 'snap-3',
        totalTurns: 4,
        start: 2,
        turns: turns([2, 3], { turnId: 'rewritten' }),
      }),
    );
    expect([...reset.pages.keys()]).toEqual([2]);
    expect(reset.pages.get(2)?.snapshot).toBe('snap-3');
    expect(reset.snapshot).toBe('snap-3');
    expect(reset.totalTurns).toBe(4);
    expect(reset.liveEntries).toEqual([]);
  });
});

describe('cached-page bounds', () => {
  /** A store seeded over a long chain, holding only the newest window. */
  function longChainState(): SessionTurnIndexState {
    return admitSeedPage(
      createSessionTurnIndexState('s1', 'idle'),
      indexPage({
        snapshot: 'snap-1',
        totalTurns: 1000,
        start: 990,
        turns: turns([990, 991, 992, 993, 994, 995, 996, 997, 998, 999]),
      }),
    );
  }

  function admitSingleTurnPage(
    state: SessionTurnIndexState,
    start: number,
    label = `Turn ${start}`,
  ): SessionTurnIndexState {
    return (
      admitTurnIndexPage(
        state,
        indexPage({
          snapshot: 'snap-1',
          totalTurns: 1000,
          start,
          turns: [turn(start, { label })],
        }),
        'snap-1',
      ) ?? state
    );
  }

  it('evicts by page count without touching totalTurns', () => {
    let state = longChainState();
    for (let start = 0; start < 40; start += 1) {
      state = admitSingleTurnPage(state, start);
    }
    expect(state.pages.size).toBeLessThanOrEqual(32);
    // Evicting metadata shortens the cache, never the session.
    expect(state.totalTurns).toBe(1000);
    expect(state.pages.has(0)).toBe(false);
  });

  it('pins the newest page so a refresh always has overlap', () => {
    let state = longChainState();
    for (let start = 0; start < 40; start += 1) {
      state = admitSingleTurnPage(state, start);
    }
    expect(state.pages.has(990)).toBe(true);
    expect(coveredOrdinalBounds(state)?.newest).toBe(999);
  });

  it('evicts by bytes when a few pages carry oversized previews', () => {
    const huge = 'x'.repeat(1_500_000);
    let state = longChainState();
    for (let start = 0; start < 4; start += 1) {
      state = admitSingleTurnPage(state, start, huge);
    }
    expect(state.pages.size).toBeLessThan(5);
    expect(state.pages.has(0)).toBe(false);
    // The pinned tail page survives whatever the byte pressure, and the newest
    // of the oversized pages is kept because dropping it would overshoot.
    expect(state.pages.has(990)).toBe(true);
    expect(state.pages.has(3)).toBe(true);
    expect(state.totalTurns).toBe(1000);
  });
});

describe('live entries and reconciliation', () => {
  function stateWithPrompt(label = 'do the thing'): SessionTurnIndexState {
    return appendLivePromptEntry(seededState(), 'p1', label);
  }

  it('appends a provisional once', () => {
    const state = appendLivePromptEntry(stateWithPrompt(), 'p1', 'again');
    expect(state.liveEntries).toHaveLength(1);
  });

  it('reconciles by exact promptId', () => {
    const state: SessionTurnIndexState = {
      ...stateWithPrompt(),
      pages: new Map([
        [
          5,
          {
            snapshot: 'snap-2',
            turns: [turn(5, { promptId: 'p1', turnId: 'record-5' })],
          },
        ],
      ]),
    };
    expect(reconcileLiveEntries(state).liveEntries).toEqual([]);
  });

  it('reconciles a legacy record by identity observed on its blocks', () => {
    const state: SessionTurnIndexState = {
      ...stateWithPrompt(),
      pages: new Map([
        [5, { snapshot: 'snap-2', turns: [turn(5, { turnId: 'record-5' })] }],
      ]),
    };
    // The persisted record carries no prompt id; the client learned the
    // association from the admitted blocks instead.
    expect(reconcileLiveEntries(state).liveEntries).toHaveLength(1);
    expect(
      reconcileLiveEntries(state, new Map([['p1', ['record-5']]])).liveEntries,
    ).toEqual([]);
  });

  it('never reconciles on a matching label', () => {
    const state: SessionTurnIndexState = {
      ...stateWithPrompt('do the thing'),
      pages: new Map([
        [
          5,
          {
            snapshot: 'snap-2',
            turns: [turn(5, { label: 'do the thing', turnId: 'record-5' })],
          },
        ],
      ]),
    };
    // Same label, different turn: matching on it would drop a provisional the
    // index has not actually caught up with.
    expect(reconcileLiveEntries(state).liveEntries).toHaveLength(1);
  });

  it('keeps an unmatched provisional for the next refresh', () => {
    expect(reconcileLiveEntries(stateWithPrompt()).liveEntries).toHaveLength(1);
  });

  it('leaves shell overlays to their own lifetime', () => {
    let state = appendLiveShellEntry(stateWithPrompt(), 'evt-1', 'ls -la');
    expect(state.liveEntries.map((entry) => entry.id)).toEqual([
      'live:p1',
      'shell:evt-1',
    ]);
    expect(reconcileLiveEntries(state).liveEntries).toHaveLength(2);
    state = removeLiveEntry(state, 'shell:evt-1');
    expect(state.liveEntries.map((entry) => entry.id)).toEqual(['live:p1']);
    expect(removeLiveEntry(state, 'shell:evt-1')).toBe(state);
  });
});

describe('buildTurnLocator', () => {
  function locatorBlock(
    id: string,
    sourceRecordIds?: readonly string[],
  ): DaemonTranscriptBlock {
    return {
      id,
      kind: 'user',
      text: `text-${id}`,
      clientReceivedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      ...(sourceRecordIds ? { sourceRecordIds } : {}),
    };
  }

  /** A store whose cached page knows `record-5` and `record-6` as turns. */
  function indexed(): SessionTurnIndexState {
    return admitSeedPage(
      createSessionTurnIndexState('s1', 'idle'),
      indexPage({
        snapshot: 'snap-1',
        totalTurns: 7,
        start: 5,
        turns: [
          turn(5, { turnId: 'record-5' }),
          turn(6, { turnId: 'record-6' }),
        ],
      }),
    );
  }

  it('maps a known turn id to the block rendering it', () => {
    const locator = buildTurnLocator(indexed(), [
      locatorBlock('b1', ['record-5']),
      locatorBlock('b2'),
      locatorBlock('b3', ['record-6']),
    ]);
    expect([...locator.entries()]).toEqual([
      ['record-5', 'b1'],
      ['record-6', 'b3'],
    ]);
  });

  it('ignores record ids the index does not know', () => {
    // Tool and assistant records are persisted too, but they are not
    // navigation turns, so they must not become locator keys.
    const locator = buildTurnLocator(indexed(), [
      locatorBlock('b1', ['tool-record-1', 'record-5']),
    ]);
    expect([...locator.keys()]).toEqual(['record-5']);
  });

  it('picks the indexed record rather than the first one listed', () => {
    const locator = buildTurnLocator(indexed(), [
      locatorBlock('b1', ['assistant-record', 'record-5']),
    ]);
    expect(locator.get('record-5')).toBe('b1');
    expect(locator.has('assistant-record')).toBe(false);
  });

  it('lets the oldest block carrying a turn id win', () => {
    const locator = buildTurnLocator(indexed(), [
      locatorBlock('b1', ['record-5']),
      locatorBlock('b2', ['record-5']),
    ]);
    expect(locator.get('record-5')).toBe('b1');
  });

  it('is empty while the index holds nothing', () => {
    const locator = buildTurnLocator(
      createSessionTurnIndexState('s1', 'idle'),
      [locatorBlock('b1', ['record-5'])],
    );
    expect(locator.size).toBe(0);
  });
});

describe('failure handling', () => {
  it('latches unsupported on the indexing ceiling', () => {
    expect(
      classifyTurnIndexFailure({ body: { code: 'transcript_too_large' } }),
    ).toBe('unsupported');
    expect(latchTurnIndexUnsupported(seededState()).status).toBe('unsupported');
  });

  it('invalidates on a lost or stale snapshot', () => {
    expect(
      classifyTurnIndexFailure({
        body: { code: 'transcript_snapshot_unavailable' },
      }),
    ).toBe('invalidate');
    expect(
      classifyTurnIndexFailure({ body: { code: 'invalid_transcript_cursor' } }),
    ).toBe('invalidate');
  });

  it('retries anything else', () => {
    expect(classifyTurnIndexFailure(new Error('offline'))).toBe('retry');
    expect(classifyTurnIndexFailure({ body: { code: 'internal_error' } })).toBe(
      'retry',
    );
  });

  it('drops snapshot, pages and provisionals on invalidation', () => {
    const state = invalidateTurnIndexSnapshot(
      appendLivePromptEntry(seededState(), 'p1', 'x'),
    );
    expect(state.status).toBe('idle');
    expect(state.snapshot).toBeUndefined();
    expect(state.totalTurns).toBe(0);
    expect(state.pages.size).toBe(0);
    expect(state.liveEntries).toEqual([]);
  });
});
