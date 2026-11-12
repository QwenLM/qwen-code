/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';
import { MainContent } from './MainContent.js';
import { AppContext } from '../contexts/AppContext.js';
import { UIActionsContext } from '../contexts/UIActionsContext.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import { OverflowProvider } from '../contexts/OverflowContext.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';

// ScrollableList is kept at a ref boundary with a *mutable* anchor, so a test
// can drive onNavigateStructure directly and emulate the clamped last page.
const harness = vi.hoisted(() => {
  const state = { anchor: 4 };
  const props: { current: Record<string, unknown> | null } = { current: null };
  const listApi = {
    scrollBy: vi.fn(),
    scrollTo: vi.fn(),
    scrollToEnd: vi.fn(),
    scrollToIndex: vi.fn(),
    scrollToItem: vi.fn(),
    hitTestScrollbar: vi.fn(() => false),
    scrollToScrollbarRow: vi.fn(),
    getScrollIndex: () => state.anchor,
    getScrollState: () => ({
      scrollTop: 0,
      scrollHeight: 100,
      innerHeight: 20,
    }),
    getViewportRect: () => null,
  };
  return { state, props, listApi };
});

vi.mock('./shared/ScrollableList.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./shared/ScrollableList.js')>();
  const MockScrollableList = forwardRef((props, ref) => {
    harness.props.current = props as Record<string, unknown>;
    useImperativeHandle(ref, () => harness.listApi, []);
    return null;
  });
  MockScrollableList.displayName = 'MockScrollableList';
  return {
    ...actual,
    ScrollableList: MockScrollableList,
  };
});

// The hint row has its own provider requirements and nothing to do with the
// navigation cursor being tested.
vi.mock('./ShowMoreLines.js', () => ({
  ShowMoreLines: () => null,
}));

const historyBase: UIState['history'] = [
  { id: 1, type: 'user', text: 'turn one', sentToModel: true },
  { id: 2, type: 'gemini', text: 'answer one' },
  { id: 3, type: 'user', text: 'turn two', sentToModel: true },
  { id: 4, type: 'gemini', text: 'answer two' },
];

// Viewport layout: [banner, turn-one, answer-one, turn-two, answer-two].
// Turn anchors are therefore indexes 1 and 3, and the tail is index 4.
const makeUIState = (history: UIState['history']): UIState =>
  ({
    useTerminalBuffer: true,
    useAlternateBuffer: false,
    constrainHeight: false,
    availableTerminalHeight: 24,
    availableTerminalWidth: 120,
    terminalWidth: 120,
    dialogsVisible: false,
    history,
    pendingHistoryItems: [],
    pendingLlmHistoryItems: [],
    messageQueue: [],
    streamingState: {},
    isInputActive: false,
    btwItem: null,
    historyManager: { sessionId: 'test-session' },
  }) as unknown as UIState;

const mainContentTree = (uiState: UIState) => (
  <AppContext.Provider value={{ version: '1.2.3', startupWarnings: [] }}>
    <UIActionsContext.Provider value={{ refreshStatic: vi.fn() }}>
      <UIStateContext.Provider value={uiState}>
        <KeypressProvider kittyProtocolEnabled={false}>
          <OverflowProvider>
            <MainContent />
          </OverflowProvider>
        </KeypressProvider>
      </UIStateContext.Provider>
    </UIActionsContext.Provider>
  </AppContext.Provider>
);

const renderMainContent = (uiState: UIState) =>
  render(mainContentTree(uiState));

const jump = (
  direction: 'previous' | 'next',
  kind: 'turn' | 'tool' = 'turn',
) => {
  const props = harness.props.current as {
    onNavigateStructure: (d: 'previous' | 'next', k: 'turn' | 'tool') => void;
  };
  act(() => {
    props.onNavigateStructure(direction, kind);
  });
};

const lastJumpIndex = () =>
  harness.listApi.scrollToIndex.mock.calls.at(-1)?.[0].index;

describe('<MainContent /> structure-navigation cursor', () => {
  beforeEach(() => {
    harness.state.anchor = 4;
    harness.props.current = null;
    vi.clearAllMocks();
  });

  it('keeps advancing after appending rows that did NOT move the reading position', () => {
    const { rerender } = renderMainContent(makeUIState(historyBase));
    jump('previous');
    expect(lastJumpIndex()).toBe(3);
    // Clamped viewport: the anchor still reports the tail after the jump.
    expect(harness.state.anchor).toBe(4);

    // Stream one more answer row WITHOUT moving the reading position.
    const appended = [
      ...historyBase,
      { id: 5, type: 'gemini', text: 'answer two, continued' },
    ] as UIState['history'];
    rerender(mainContentTree(makeUIState(appended)));

    // The cursor must survive the append: the next back-step targets the
    // first turn, not a replay of the same turn-two jump.
    jump('previous');
    expect(lastJumpIndex()).toBe(1);
  });

  it('resets the cursor when an append really re-anchors the reading position', () => {
    const { rerender } = renderMainContent(makeUIState(historyBase));
    jump('previous');
    expect(lastJumpIndex()).toBe(3);

    // Auto-follow: the anchor moves to the NEWEST appended row.
    harness.state.anchor = 5;
    const appended = [
      ...historyBase,
      { id: 5, type: 'gemini', text: 'answer two, continued' },
    ] as UIState['history'];
    rerender(mainContentTree(makeUIState(appended)));

    // The reading position followed the new tail, so the next back-step is
    // computed from there (index 4) rather than from the recorded target 3.
    jump('previous');
    expect(lastJumpIndex()).toBe(3);
  });

  it('resets the cursor on a manual scroll reported by onUserScroll', () => {
    renderMainContent(makeUIState(historyBase));
    jump('previous');
    expect(lastJumpIndex()).toBe(3);
    const jumpsBefore = harness.listApi.scrollToIndex.mock.calls.length;

    // The user scrolls back to the first turn by hand: the next forward step
    // must come from that live position, not from the recorded target.
    const props = harness.props.current as { onUserScroll: () => void };
    act(() => props.onUserScroll());
    harness.state.anchor = 1;
    jump('next');
    expect(lastJumpIndex()).toBe(3);
    // Without the reset, the recorded target 3 would send this to the tail
    // (scrollToEnd) instead of producing a fresh scrollToIndex.
    expect(harness.listApi.scrollToIndex.mock.calls.length).toBe(
      jumpsBefore + 1,
    );
  });
});
