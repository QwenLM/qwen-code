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

function makeScrollActions(initialTopIndex: number | null, supported = true) {
  let topIndex = initialTopIndex;
  const jumps: number[] = [];
  const anchorReads: number[] = [];
  const actions: ScrollActions = {
    scrollBy: () => {},
    hasScrollableTranscript: () => true,
    scrollToIndex: (index: number) => {
      jumps.push(index);
      return supported;
    },
    scrollToEnd: () => {},
    getScrollIndex: () => {
      anchorReads.push(1);
      return topIndex;
    },
  };
  return {
    actions,
    jumps,
    anchorReads,
    // Tests can move the reader so "clamp" and "re-pick" disagree.
    setTop: (index: number | null) => {
      topIndex = index;
    },
  };
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

  it('re-picks on a real query change even when clamping would keep an older match', () => {
    const { actions, setTop } = makeScrollActions(4);
    const { result, rerender } = renderHook(
      (props: { isActive: boolean; query: string }) =>
        useTranscriptSearch({ ...props, items, scrollActions: actions }),
      { initialProps: { isActive: true, query: 'ports' } },
    );
    expect(result.current.activeMatch?.index).toBe(4);

    // Move the reader above every match: clamping would keep position 1 of
    // the two 'prompt' hits (index 3), while a genuine re-pick must choose
    // index 1. Deleting the render-phase reset turns this assertion red.
    setTop(0);
    rerender({ isActive: true, query: 'prompt' });
    expect(result.current.matches).toHaveLength(2);
    expect(result.current.activeMatch?.index).toBe(1);

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

  it('keeps the already-chosen match when history grows', () => {
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

    // Navigate first: a re-pick on growth would teleport the user back to the
    // oldest hit, which the previous version of this test could not see.
    act(() => result.current.previousMatch());
    expect(result.current.activeMatch?.index).toBe(3);

    rerender({ isActive: true, query: 'ports', itemCount: 4 });
    expect(result.current.matches).toHaveLength(3);
    expect(result.current.activeMatch?.index).toBe(3);
  });

  it('steps from the clamped match after an empty result set gains matches', () => {
    const { actions } = makeScrollActions(0);
    const { result, rerender } = renderHook(
      (props: { isActive: boolean; withHistory: boolean }) =>
        useTranscriptSearch({
          isActive: props.isActive,
          query: 'ports',
          items: props.withHistory ? items : buildVirtualItems([], []),
          scrollActions: actions,
        }),
      { initialProps: { isActive: true, withHistory: false } },
    );
    expect(result.current.activeMatchPosition).toBe(-1);

    rerender({ isActive: true, withHistory: true });
    // The stored -1 sentinel must not become a dead key or an off-by-one.
    expect(result.current.activeMatch?.index).toBe(1);
    act(() => result.current.nextMatch());
    expect(result.current.activeMatch?.index).toBe(3);
    act(() => result.current.previousMatch());
    expect(result.current.activeMatch?.index).toBe(1);
    act(() => result.current.previousMatch());
    // From the first match, previous wraps to the last one.
    expect(result.current.activeMatch?.index).toBe(4);
  });

  it('previousMatch from a stored empty-position sentinel lands on the prior match', () => {
    const { actions } = makeScrollActions(0);
    const { result, rerender } = renderHook(
      (props: { isActive: boolean; itemCount: number }) =>
        useTranscriptSearch({
          isActive: props.isActive,
          query: 'ports',
          items: buildVirtualItems(history.slice(0, props.itemCount), []),
          scrollActions: actions,
        }),
      { initialProps: { isActive: true, itemCount: 0 } },
    );
    rerender({ isActive: true, itemCount: 3 });
    // This is a clamped -1, so previous must select match 2 of 2, NOT loop
    // through the sentinel to match 1. Mirrors nextMatch above, not a rerun.
    act(() => result.current.previousMatch());
    expect(result.current.matches).toHaveLength(2);
    expect(result.current.activeMatch?.index).toBe(3);
    act(() => result.current.nextMatch());
    expect(result.current.activeMatch?.index).toBe(1);
  });

  it('does not re-anchor on keystrokes while the search is closed', () => {
    const { actions, anchorReads } = makeScrollActions(4);
    const { rerender } = renderHook(
      (props: { isActive: boolean; query: string }) =>
        useTranscriptSearch({ ...props, items, scrollActions: actions }),
      { initialProps: { isActive: false, query: 'ports' } },
    );
    // Never opened: no reset and no anchor read yet.
    expect(anchorReads.length).toBe(0);

    rerender({ isActive: false, query: 'ports and more text' });
    expect(anchorReads.length).toBe(0);

    // Opening re-anchors through the isActive transition; closing is also a
    // transition, so only the actual typing-while-closed window is guarded.
    rerender({ isActive: true, query: 'ports and more text' });
    expect(anchorReads.length).toBe(1);

    rerender({ isActive: false, query: 'ports and more text again' });
    const readsAfterClose = anchorReads.length;
    rerender({ isActive: false, query: 'ports and more text again, typed' });
    expect(anchorReads.length).toBe(readsAfterClose);
  });
});
