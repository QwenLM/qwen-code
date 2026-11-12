/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ScrollActions } from '../contexts/ScrollContext.js';
import type { HistoryItem } from '../types.js';
import { buildVirtualItems } from '../utils/virtual-items.js';
import {
  pickInitialMatchPosition,
  useTranscriptSearch,
} from './use-transcript-search.js';

const history: HistoryItem[] = [
  { id: 1, type: 'user', text: 'first prompt about ports' },
  { id: 2, type: 'gemini', text: 'no match here' },
  { id: 3, type: 'user', text: 'second prompt about ports' },
  { id: 4, type: 'gemini', text: 'ports again, third hit' },
];
const items = buildVirtualItems(history, []);
// Viewport indexes of the three matches: 1, 3, 4.

function makeScrollActions(topIndex: number | null, supported = true) {
  const jumps: number[] = [];
  const actions: ScrollActions = {
    scrollBy: () => {},
    hasScrollableTranscript: () => true,
    scrollToIndex: (index: number) => {
      jumps.push(index);
      return supported;
    },
    scrollToEnd: () => {},
    getScrollIndex: () => topIndex,
  };
  return { actions, jumps };
}

describe('pickInitialMatchPosition', () => {
  const matches = [
    { index: 1, itemType: 'user', snippet: 'a' },
    { index: 3, itemType: 'user', snippet: 'b' },
    { index: 4, itemType: 'gemini', snippet: 'c' },
  ];

  it('returns -1 with no matches', () => {
    expect(pickInitialMatchPosition([], 5)).toBe(-1);
  });

  it('prefers the most recent match when the viewport is unknown', () => {
    expect(pickInitialMatchPosition(matches, null)).toBe(2);
  });

  it('picks the closest match at or above the viewport top', () => {
    expect(pickInitialMatchPosition(matches, 4)).toBe(2);
    expect(pickInitialMatchPosition(matches, 3)).toBe(1);
    expect(pickInitialMatchPosition(matches, 2)).toBe(0);
  });

  it('falls back to the oldest match when the viewport is above all of them', () => {
    expect(pickInitialMatchPosition(matches, 0)).toBe(0);
  });
});

describe('useTranscriptSearch', () => {
  it('does not search or scroll while inactive', () => {
    const { actions, jumps } = makeScrollActions(0);
    const { result } = renderHook(() =>
      useTranscriptSearch({
        isActive: false,
        query: 'ports',
        items,
        scrollActions: actions,
      }),
    );
    expect(result.current.matches).toHaveLength(0);
    expect(result.current.activeMatch).toBeNull();
    expect(jumps).toHaveLength(0);
  });

  it('jumps to the closest match at or above the viewport on a fresh query', () => {
    const { actions, jumps } = makeScrollActions(4);
    const { result } = renderHook(() =>
      useTranscriptSearch({
        isActive: true,
        query: 'ports',
        items,
        scrollActions: actions,
      }),
    );
    expect(result.current.matches).toHaveLength(3);
    expect(result.current.activeMatch?.index).toBe(4);
    expect(jumps).toEqual([4]);
  });

  it('wraps through matches in both directions', () => {
    const { actions, jumps } = makeScrollActions(4);
    const { result } = renderHook(() =>
      useTranscriptSearch({
        isActive: true,
        query: 'ports',
        items,
        scrollActions: actions,
      }),
    );
    act(() => result.current.nextMatch());
    expect(result.current.activeMatch?.index).toBe(1);
    act(() => result.current.nextMatch());
    expect(result.current.activeMatch?.index).toBe(3);
    act(() => result.current.previousMatch());
    expect(result.current.activeMatch?.index).toBe(1);
    expect(jumps).toEqual([4, 1, 3, 1]);
  });

  it('re-centres when the query changes and clears the match when nothing matches', () => {
    const { actions } = makeScrollActions(4);
    const { result, rerender } = renderHook(
      (props: { isActive: boolean; query: string }) =>
        useTranscriptSearch({ ...props, items, scrollActions: actions }),
      { initialProps: { isActive: true, query: 'ports' } },
    );
    expect(result.current.matches).toHaveLength(3);
    rerender({ isActive: true, query: 'second' });
    expect(result.current.matches).toHaveLength(1);
    expect(result.current.activeMatch?.index).toBe(3);
    rerender({ isActive: true, query: 'zzz-no-such-text' });
    expect(result.current.matches).toHaveLength(0);
    expect(result.current.activeMatch).toBeNull();
    expect(result.current.activeMatchPosition).toBe(-1);
  });

  it('reports an unsupported jump instead of pretending it worked', () => {
    const { actions } = makeScrollActions(4, false);
    const { result } = renderHook(() =>
      useTranscriptSearch({
        isActive: true,
        query: 'ports',
        items,
        scrollActions: actions,
      }),
    );
    expect(result.current.jumpUnsupported).toBe(true);
  });

  it('clamps the cursor when history grows instead of re-centring', () => {
    const { actions } = makeScrollActions(1);
    const { result, rerender } = renderHook(
      (props: { isActive: boolean; query: string; itemCount: number }) =>
        useTranscriptSearch({
          isActive: props.isActive,
          query: props.query,
          items: buildVirtualItems(history.slice(0, props.itemCount), []),
          scrollActions: actions,
        }),
      { initialProps: { isActive: true, query: 'ports', itemCount: 3 } },
    );
    expect(result.current.matches).toHaveLength(2);
    expect(result.current.activeMatch?.index).toBe(1);
    // A new matching message arrives mid-search: the user stays on the match
    // they already chose rather than being teleported to the newest hit.
    rerender({ isActive: true, query: 'ports', itemCount: 4 });
    expect(result.current.matches).toHaveLength(3);
    expect(result.current.activeMatch?.index).toBe(1);
  });
});
