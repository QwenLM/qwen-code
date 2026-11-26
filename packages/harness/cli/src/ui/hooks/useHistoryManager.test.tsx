/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '../../test-utils/render.js';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { useHistory } from './useHistoryManager.js';
import type { HistoryItemWithoutId } from '../types.js';

function makeItems(count: number): HistoryItemWithoutId[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? { type: 'user' as const, text: `prompt ${index}` }
      : { type: 'gemini' as const, text: `answer ${index}` },
  );
}

describe('useHistory loadHistoryItems', () => {
  it('loads a resumed history in one state update', async () => {
    const items = makeItems(5);
    let renders = 0;
    const useTest = () => {
      renders++;
      return useHistory();
    };
    const { result } = await renderHook(() => useTest());
    const renderCountBeforeLoad = renders;

    await act(async () => {
      result.current.loadHistoryItems(items);
    });

    // One state update → the hook body runs exactly once after the load.
    // The old clearItems() + addItem() per-item flow scheduled one update
    // per item (6 updates for 5 items).
    expect(renders - renderCountBeforeLoad).toBe(1);
    expect(result.current.history).toHaveLength(5);
    expect(result.current.history.map((item) => item.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(result.current.history[0]?.type).toBe('user');
    expect(result.current.history[0]?.text).toBe('prompt 0');
  });

  it('matches sequential clearItems() + addItem(item, index, true) output, including duplicate-user suppression and id assignment', async () => {
    const items: HistoryItemWithoutId[] = [
      { type: 'user', text: 'same prompt' },
      { type: 'user', text: 'same prompt' }, // dropped as duplicate
      { type: 'gemini', text: 'hi' },
      { type: 'user', text: 'next' },
      { type: 'user', text: 'next' }, // dropped as duplicate
      { type: 'gemini', text: 'bye' },
    ];

    // Sequential path (the pre-fix resume flow).
    const sequential = await renderHook(() => useHistory());
    await act(async () => {
      sequential.result.current.clearItems();
      items.forEach((item, index) => {
        sequential.result.current.addItem(item, index, true);
      });
    });

    // Bulk path.
    const bulk = await renderHook(() => useHistory());
    await act(async () => {
      bulk.result.current.loadHistoryItems(items);
    });

    expect(bulk.result.current.history).toEqual(sequential.result.current.history);

    // Duplicates dropped; ids advance past dropped slots (4 items, max id 6).
    expect(bulk.result.current.history).toHaveLength(4);
    expect(bulk.result.current.history.map((item) => item.id)).toEqual([
      1, 3, 4, 6,
    ]);

    // A later addItem continues from the same id counter as the sequential
    // flow would.
    await act(async () => {
      bulk.result.current.addItem({ type: 'gemini', text: 'tail' }, 0, true);
      sequential.result.current.addItem(
        { type: 'gemini', text: 'tail' },
        0,
        true,
      );
    });
    expect(bulk.result.current.history.at(-1)?.id).toBe(
      sequential.result.current.history.at(-1)?.id,
    );
    expect(bulk.result.current.history.at(-1)?.id).toBe(7);
  });

  it('does not record loaded items via onRecordItem (resume semantics)', async () => {
    const onRecordItem = vi.fn();
    const { result } = await renderHook(() =>
      useHistory({ onRecordItem }),
    );

    await act(async () => {
      result.current.loadHistoryItems(makeItems(3));
    });

    expect(onRecordItem).not.toHaveBeenCalled();
  });
});
