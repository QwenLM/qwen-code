/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { FileHistoryService, TurnDiff } from '@qwen-code/qwen-code-core';
import { useTurnDiffs } from './useTurnDiffs.js';
import type { HistoryItem } from '../types.js';

// The shared debug logger pulls in the full core module graph during test
// startup, which is overkill for a focused renderHook spec. Stub it so the
// hook can call `createDebugLogger(...)` without instantiating Storage etc.
vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function userTurn(id: number, text: string, promptId?: string): HistoryItem {
  return {
    id,
    type: 'user',
    text,
    ...(promptId !== undefined ? { promptId } : {}),
  } as HistoryItem;
}

function slashTurn(id: number, text: string): HistoryItem {
  // Slash commands are also `type: 'user'` but `isRealUserTurn` filters them
  // out — useful for the "empty filter" assertion.
  return { id, type: 'user', text } as HistoryItem;
}

function fakeDiff(promptId: string, fileCount: number): TurnDiff {
  return {
    promptId,
    timestamp: new Date(),
    files: Array.from({ length: fileCount }, (_, i) => ({
      filePath: `f${i}.txt`,
      hunks: [],
      isNewFile: false,
      isDeleted: false,
      linesAdded: 1,
      linesRemoved: 0,
      oversized: false,
      isBinary: false,
    })),
    stats: {
      filesChanged: fileCount,
      linesAdded: fileCount,
      linesRemoved: 0,
      filesOmitted: 0,
    },
  };
}

function makeService(
  responder: (promptId: string) => Promise<TurnDiff | undefined>,
): FileHistoryService {
  // Only `getTurnDiff` is touched by the hook; everything else stays
  // undefined and would throw if accessed (which itself is a useful guard).
  return { getTurnDiff: responder } as unknown as FileHistoryService;
}

describe('useTurnDiffs', () => {
  it('returns empty when disabled', async () => {
    const service = makeService(async () => fakeDiff('p1', 1));
    // Stable history reference: useEffect deps include `history`, so a new
    // array on every render would re-fire the effect → infinite loop.
    const history = [userTurn(1, 'hello', 'p1')];
    const { result } = renderHook(() => useTurnDiffs(history, service, false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.turns).toEqual([]);
  });

  it('returns empty when fileHistoryService is undefined', async () => {
    const history = [userTurn(1, 'hello', 'p1')];
    const { result } = renderHook(() => useTurnDiffs(history, undefined, true));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.turns).toEqual([]);
  });

  it('filters out slash-commands, missing promptId, and empty diffs', async () => {
    const service = makeService(async (id) => {
      if (id === 'p-empty') return fakeDiff(id, 0); // empty: should drop
      if (id === 'p-good') return fakeDiff(id, 2);
      return undefined; // no snapshot: should drop
    });

    const history: HistoryItem[] = [
      slashTurn(1, '/help'),
      userTurn(2, 'no prompt id'), // no promptId → filtered
      userTurn(3, 'empty diff', 'p-empty'),
      userTurn(4, 'good one', 'p-good'),
      userTurn(5, 'missing snapshot', 'p-missing'),
    ];

    const { result } = renderHook(() => useTurnDiffs(history, service, true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].diff.promptId).toBe('p-good');
  });

  it('orders results most-recent-first', async () => {
    const service = makeService(async (id) => fakeDiff(id, 1));
    const history: HistoryItem[] = [
      userTurn(1, 'oldest', 'p1'),
      userTurn(2, 'middle', 'p2'),
      userTurn(3, 'newest', 'p3'),
    ];

    const { result } = renderHook(() => useTurnDiffs(history, service, true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.turns.map((t) => t.diff.promptId)).toEqual([
      'p3',
      'p2',
      'p1',
    ]);
    // 1-based turn index follows the original history order, not the
    // most-recent-first display order — newest turn = highest index.
    expect(result.current.turns.map((t) => t.turnIndex)).toEqual([3, 2, 1]);
  });

  it('isolates per-turn errors so one bad turn does not poison the rest', async () => {
    const service = makeService(async (id) => {
      if (id === 'p-bad') throw new Error('disk fell over');
      return fakeDiff(id, 1);
    });
    const history: HistoryItem[] = [
      userTurn(1, 'good a', 'p-a'),
      userTurn(2, 'bad', 'p-bad'),
      userTurn(3, 'good c', 'p-c'),
    ];

    const { result } = renderHook(() => useTurnDiffs(history, service, true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    // p-bad's throw is swallowed; the two good turns still arrive.
    expect(result.current.turns.map((t) => t.diff.promptId).sort()).toEqual([
      'p-a',
      'p-c',
    ]);
  });

  it('processes more than TURN_CONCURRENCY (4) turns without dropping any', async () => {
    // 10 turns × concurrency 4 forces ≥3 batches. Verifies the for-loop
    // walks every batch instead of returning after the first.
    const promptIds = Array.from({ length: 10 }, (_, i) => `p${i + 1}`);
    const service = makeService(async (id) => fakeDiff(id, 1));
    const history: HistoryItem[] = promptIds.map((id, i) =>
      userTurn(i + 1, `turn ${i + 1}`, id),
    );

    const { result } = renderHook(() => useTurnDiffs(history, service, true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.turns).toHaveLength(10);
    // All promptIds present, ordering still newest-first.
    expect(result.current.turns.map((t) => t.diff.promptId)).toEqual(
      [...promptIds].reverse(),
    );
  });

  it('caps in-flight calls at TURN_CONCURRENCY (concurrent fan-out bounded)', async () => {
    let inFlight = 0;
    let peak = 0;
    const service = makeService(async (id) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Yield so other queued calls can observe the gate.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return fakeDiff(id, 1);
    });

    const history: HistoryItem[] = Array.from({ length: 12 }, (_, i) =>
      userTurn(i + 1, `t${i + 1}`, `p${i + 1}`),
    );
    const { result } = renderHook(() => useTurnDiffs(history, service, true));
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.turns).toHaveLength(12);
    // Hook's TURN_CONCURRENCY = 4; never more than 4 simultaneous calls.
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(0);
  });
});
