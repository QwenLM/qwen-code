/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '../../test-utils/render.js';
import { describe, expect, it } from 'vitest';
import { useAnchoredWindow } from './useAnchoredWindow.js';

type Item = { id: string };
const keyOf = (item: Item) => item.id;

function useTwoStageWindow(items: Array<Item & { renderable: boolean }>) {
  const raw = useAnchoredWindow(items, 'conversation', {
    capacity: 100,
    step: 10,
    keyOf,
  });
  const renderable = raw.items.filter((item) => item.renderable);
  const rendered = useAnchoredWindow(renderable, 'conversation', {
    capacity: 50,
    step: 10,
    keyOf,
  });
  return { raw, rendered };
}

describe('useAnchoredWindow', () => {
  it('keeps the anchor stable while the same conversation appends', async () => {
    let items = Array.from({ length: 61 }, (_, index) => ({
      id: `a-${index}`,
    }));
    const result = await renderHook(() =>
      useAnchoredWindow(items, 'agent-a', {
        capacity: 50,
        step: 10,
        keyOf,
      }),
    );

    expect(result.result.current.startIndex).toBe(11);
    expect(result.result.current.items[0]?.id).toBe('a-11');

    items = [...items, { id: 'a-61' }];
    result.rerender();

    expect(result.result.current.startIndex).toBe(11);
    expect(result.result.current.items[0]?.id).toBe('a-11');
  });

  it('resets the anchor when the conversation changes', async () => {
    let conversationKey = 'agent-a';
    let items = Array.from({ length: 61 }, (_, index) => ({
      id: `a-${index}`,
    }));
    const result = await renderHook(() =>
      useAnchoredWindow(items, conversationKey, {
        capacity: 50,
        step: 10,
        keyOf,
      }),
    );

    expect(result.result.current.startIndex).toBe(11);

    conversationKey = 'agent-b';
    items = Array.from({ length: 60 }, (_, index) => ({ id: `b-${index}` }));
    result.rerender();

    expect(result.result.current.startIndex).toBe(0);
    expect(result.result.current.items[0]?.id).toBe('b-0');
  });

  it('bypasses windowing when the owning renderer manages scrolling', async () => {
    const items = Array.from({ length: 61 }, (_, index) => ({
      id: `a-${index}`,
    }));
    const { result } = await renderHook(() =>
      useAnchoredWindow(items, 'agent-a', {
        capacity: 50,
        step: 10,
        keyOf,
        enabled: false,
      }),
    );

    expect(result.current.startIndex).toBe(0);
    expect(result.current.items).toBe(items);
  });

  it('keeps raw and renderable anchors independent', async () => {
    const rawHeavy = Array.from({ length: 111 }, (_, index) => ({
      id: `raw-${index}`,
      renderable: index % 2 === 0,
    }));
    const rawResult = await renderHook(() => useTwoStageWindow(rawHeavy));

    expect(rawResult.result.current.raw.startIndex).toBe(11);
    expect(rawResult.result.current.rendered.startIndex).toBe(0);

    const renderHeavy = Array.from({ length: 61 }, (_, index) => ({
      id: `render-${index}`,
      renderable: true,
    }));
    const renderResult = await renderHook(() =>
      useTwoStageWindow(renderHeavy),
    );

    expect(renderResult.result.current.raw.startIndex).toBe(0);
    expect(renderResult.result.current.rendered.startIndex).toBe(11);
  });
});
