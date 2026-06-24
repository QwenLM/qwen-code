/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { MainContent } from './MainContent.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';
import { AppContext } from '../contexts/AppContext.js';
import { OverflowProvider } from '../contexts/OverflowContext.js';
import { ToolCallStatus } from '../types.js';

const staticPropsSpy = vi.fn();
const staticItemsSpy = vi.fn();
const historyItemDisplayPropsSpy = vi.fn();
const appHeaderSpy = vi.fn();
const scrollableListPropsSpy = vi.fn();

vi.mock('ink', async () => {
  const actual = await vi.importActual<typeof import('ink')>('ink');

  return {
    ...actual,
    Static: ({
      children,
      items,
      ...props
    }: React.ComponentProps<typeof actual.Static>) => {
      staticPropsSpy(props);
      staticItemsSpy(items);
      return <>{items.map((item, index) => children(item, index))}</>;
    },
  };
});

vi.mock('./AppHeader.js', () => ({
  AppHeader: ({ version }: { version: string }) => {
    appHeaderSpy(version);
    return <Text>{`APP_HEADER:${version}`}</Text>;
  },
}));

vi.mock('./HistoryItemDisplay.js', () => ({
  HistoryItemDisplay: (props: { item: { id: number } }) => {
    historyItemDisplayPropsSpy(props);
    return <Text>{`HISTORY:${props.item.id}`}</Text>;
  },
}));

// Context-aware mock — `useOverflowState()` returns undefined when the
// component is not nested under <OverflowProvider>. We render different
// markers for the two outcomes so the VP-mode "ShowMoreLines reachable"
// test can distinguish between "mounted but disconnected from overflow
// state" and "mounted with a live overflow context".
vi.mock('./ShowMoreLines.js', async () => {
  const { useOverflowState } = await vi.importActual<
    typeof import('../contexts/OverflowContext.js')
  >('../contexts/OverflowContext.js');
  return {
    ShowMoreLines: () => {
      const overflow = useOverflowState();
      // Non-overlapping markers so a `toContain('SHOW_MORE')` substring
      // assertion can't accidentally match the disconnected case.
      return (
        <Text>
          {overflow === undefined ? 'OVERFLOW_DISCONNECTED' : 'SHOW_MORE'}
        </Text>
      );
    },
  };
});

vi.mock('./Notifications.js', () => ({
  Notifications: () => <Text>NOTIFICATIONS</Text>,
}));

vi.mock('./DebugModeNotification.js', () => ({
  DebugModeNotification: () => <Text>DEBUG_NOTIFICATION</Text>,
}));

vi.mock('./shared/ScrollableList.js', async () => {
  const actual = await vi.importActual<
    typeof import('./shared/ScrollableList.js')
  >('./shared/ScrollableList.js');
  return {
    ...actual,
    ScrollableList: (props: {
      data: Array<{ id: number }>;
      renderItem: (info: { item: { id: number }; index: number }) => unknown;
    }) => {
      scrollableListPropsSpy(props);
      // Drive renderItem once per item so historyItemDisplayPropsSpy fires —
      // mirrors what the real VirtualizedList does for the visible window.
      return (
        <>
          {props.data.map((item) => (
            <Text key={item.id}>{`VP_ITEM:${item.id}`}</Text>
          ))}
          {props.data.map((item, index) => props.renderItem({ item, index }))}
        </>
      );
    },
  };
});

const createUIState = (overrides: Partial<UIState> = {}): UIState =>
  ({
    history: [],
    historyManager: {} as UIState['historyManager'],
    isThemeDialogOpen: false,
    themeError: null,
    auth: {
      authError: null,
      isAuthDialogOpen: false,
      isAuthenticating: false,
      pendingAuthType: undefined,
      externalAuthState: null,
      qwenAuthState: {
        deviceAuth: null,
        authStatus: 'idle',
        authMessage: null,
      },
    },
    isConfigInitialized: true,
    editorError: null,
    isEditorDialogOpen: false,
    debugMessage: '',
    quittingMessages: null,
    isSettingsDialogOpen: false,
    isStatusLineDialogOpen: false,
    isMemoryDialogOpen: false,
    isModelDialogOpen: false,
    isFastModelMode: false,
    isTrustDialogOpen: false,
    activeArenaDialog: null,
    isPermissionsDialogOpen: false,
    isApprovalModeDialogOpen: false,
    isResumeDialogOpen: false,
    resumeMatchedSessions: undefined,
    isDeleteDialogOpen: false,
    slashCommands: [],
    pendingSlashCommandHistoryItems: [],
    commandContext: {} as UIState['commandContext'],
    shellConfirmationRequest: null,
    confirmationRequest: null,
    confirmUpdateExtensionRequests: [],
    providerUpdateRequest: undefined,
    settingInputRequests: [],
    pluginChoiceRequests: [],
    loopDetectionConfirmationRequest: null,
    geminiMdFileCount: 0,
    streamingState: {} as UIState['streamingState'],
    initError: null,
    pendingGeminiHistoryItems: [],
    thought: null,
    shellModeActive: false,
    userMessages: [],
    buffer: {} as UIState['buffer'],
    inputWidth: 80,
    suggestionsWidth: 80,
    isInputActive: true,
    shouldShowIdePrompt: false,
    shouldShowCommandMigrationNudge: false,
    commandMigrationTomlFiles: [],
    isFolderTrustDialogOpen: false,
    isTrustedFolder: true,
    constrainHeight: false,
    ideContextState: undefined,
    showToolDescriptions: false,
    ctrlCPressedOnce: false,
    ctrlDPressedOnce: false,
    showEscapePrompt: false,
    elapsedTime: 0,
    currentLoadingPhrase: '',
    historyRemountKey: 1,
    messageQueue: [],
    showAutoAcceptIndicator: {} as UIState['showAutoAcceptIndicator'],
    currentModel: 'gpt-5.5',
    contextFileNames: [],
    availableTerminalHeight: undefined,
    mainAreaWidth: 100,
    staticAreaMaxItemHeight: 100,
    staticExtraHeight: 0,
    dialogsVisible: false,
    pendingHistoryItems: [],
    stickyTodos: null,
    btwItem: null,
    setBtwItem: vi.fn(),
    cancelBtw: vi.fn(),
    nightly: false,
    branchName: 'main',
    sessionStats: { lastPromptTokenCount: 0 } as UIState['sessionStats'],
    terminalWidth: 120,
    terminalHeight: 40,
    mainControlsRef: { current: null },
    currentIDE: null,
    updateInfo: null,
    showIdeRestartPrompt: false,
    ideTrustRestartReason: {} as UIState['ideTrustRestartReason'],
    isRestarting: false,
    extensionsUpdateState: new Map(),
    activePtyId: undefined,
    embeddedShellFocused: false,
    showWelcomeBackDialog: false,
    welcomeBackInfo: null,
    welcomeBackChoice: null,
    isSubagentCreateDialogOpen: false,
    isAgentsManagerDialogOpen: false,
    isExtensionsManagerDialogOpen: false,
    isMcpDialogOpen: false,
    isHooksDialogOpen: false,
    isFeedbackDialogOpen: false,
    taskStartTokens: 0,
    taskStartStreamingChars: 0,
    responseCandidateTokens: 0,
    streamingResponseLengthRef: { current: 0 },
    isReceivingContent: false,
    sessionName: null,
    setSessionName: vi.fn(),
    promptSuggestion: null,
    abortPromptSuggestion: vi.fn(),
    isRewindSelectorOpen: false,
    rewindEscPending: false,
    ...overrides,
  }) as UIState;

const createUIActions = (): UIActions =>
  ({
    refreshStatic: vi.fn(),
  }) as unknown as UIActions;

const renderMainContent = (uiState: UIState) =>
  render(
    <AppContext.Provider value={{ version: '1.2.3', startupWarnings: [] }}>
      <UIActionsContext.Provider value={createUIActions()}>
        <UIStateContext.Provider value={uiState}>
          <OverflowProvider>
            <MainContent />
          </OverflowProvider>
        </UIStateContext.Provider>
      </UIActionsContext.Provider>
    </AppContext.Provider>,
  );

describe('<MainContent />', () => {
  it('renders AppHeader inside Static at the top of the static content', () => {
    staticPropsSpy.mockClear();
    staticItemsSpy.mockClear();
    historyItemDisplayPropsSpy.mockClear();
    appHeaderSpy.mockClear();

    const { lastFrame, rerender } = renderMainContent(
      createUIState({ currentModel: 'gpt-5.5', historyRemountKey: 7 }),
    );

    expect(lastFrame()).toContain('APP_HEADER:1.2.3');
    expect(lastFrame()).toContain('DEBUG_NOTIFICATION');
    expect(lastFrame()).toContain('NOTIFICATIONS');
    expect(staticPropsSpy).toHaveBeenCalled();
    expect(staticItemsSpy).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: 'app-header' }),
        expect.objectContaining({ key: 'debug-notification' }),
        expect.objectContaining({ key: 'notifications' }),
      ]),
    );
    expect(staticItemsSpy.mock.calls.at(-1)?.[0]).toHaveLength(3);
    expect(appHeaderSpy).toHaveBeenCalledTimes(1);

    rerender(
      <AppContext.Provider value={{ version: '1.2.3', startupWarnings: [] }}>
        <UIActionsContext.Provider value={createUIActions()}>
          <UIStateContext.Provider
            value={createUIState({
              currentModel: 'gpt-5.4',
              historyRemountKey: 7,
            })}
          >
            <OverflowProvider>
              <MainContent />
            </OverflowProvider>
          </UIStateContext.Provider>
        </UIActionsContext.Provider>
      </AppContext.Provider>,
    );

    expect(staticItemsSpy.mock.calls.at(-1)?.[0]).toHaveLength(3);
    expect(appHeaderSpy).toHaveBeenCalledTimes(2);
  });

  it('continues source copy numbering from static history into pending chunks', () => {
    historyItemDisplayPropsSpy.mockClear();

    renderMainContent(
      createUIState({
        history: [
          {
            id: 1,
            type: 'gemini_content',
            text: [
              '```mermaid',
              'flowchart TD',
              '  A --> B',
              '```',
              '$$',
              '\\alpha',
              '$$',
            ].join('\n'),
          },
        ],
        pendingHistoryItems: [
          {
            type: 'gemini_content',
            text: [
              '```mermaid',
              'sequenceDiagram',
              '  A->>B: hi',
              '```',
              '$$',
              '\\beta',
              '$$',
            ].join('\n'),
          },
        ],
      }),
    );

    const pendingProps = historyItemDisplayPropsSpy.mock.calls
      .map((call) => call[0])
      .find((props) => props.isPending);

    expect(pendingProps?.sourceCopyIndexOffsets).toMatchObject({
      mathBlockCount: 1,
    });
    expect(
      pendingProps?.sourceCopyIndexOffsets?.codeBlockLanguageCounts.get(
        'mermaid',
      ),
    ).toBe(1);
  });

  it('passes the full history to Static in one render when below the progressive replay threshold', () => {
    staticItemsSpy.mockClear();
    const history = Array.from({ length: 50 }, (_, i) => ({
      type: 'user' as const,
      id: i,
      text: `msg ${i}`,
    }));

    renderMainContent(createUIState({ history }));

    // 3 prefix items (header / debug / notifications) + 50 history items
    expect(staticItemsSpy.mock.calls.at(-1)?.[0]).toHaveLength(53);
  });

  it('progressively replays Static items when history exceeds the threshold (issue #3899)', async () => {
    staticItemsSpy.mockClear();
    const history = Array.from({ length: 200 }, (_, i) => ({
      type: 'user' as const,
      id: i,
      text: `msg ${i}`,
    }));

    renderMainContent(createUIState({ history }));

    const lengthAtLastCall = () =>
      staticItemsSpy.mock.calls.at(-1)?.[0].length ?? 0;

    // Initial render: only the first chunk (50) plus the 3 prefix items
    // should be in Static — long history must not block the input thread.
    const TOTAL = 203; // 200 history + 3 prefix items
    expect(lengthAtLastCall()).toBe(53);
    expect(lengthAtLastCall()).toBeLessThan(TOTAL);

    // Drain setImmediate ticks. Each iteration must not regress the visible
    // count (monotonic) and we must reach TOTAL inside the loop budget — a
    // silent regression that stops advancing will fail the final assert
    // rather than spuriously time out.
    let prev = lengthAtLastCall();
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const curr = lengthAtLastCall();
      expect(curr).toBeGreaterThanOrEqual(prev); // never shrinks mid-replay
      prev = curr;
      if (curr === TOTAL) break;
    }

    // After catch-up the full history must be present.
    expect(lengthAtLastCall()).toBe(TOTAL);
  });

  it('renders newly finalized item without a disappear frame when gap is within CHUNK_SIZE (issue #3899)', () => {
    // Regression: when a pending item finalizes, it is removed from
    // pendingHistoryItems immediately. If replayCount still lags behind
    // mergedHistory.length by ≤ PROGRESSIVE_REPLAY_CHUNK_SIZE, the item
    // would be absent from BOTH areas for one render frame. The gap-based
    // condition must render the full list synchronously in that case.
    //
    // Setup: 100 items = exactly the replay threshold, so initialReplayCount
    // returns 100 (fully shown, no chunking). The component state is stable
    // at replayCount=100 with no pending effects.
    staticItemsSpy.mockClear();
    const history = Array.from({ length: 100 }, (_, i) => ({
      type: 'user' as const,
      id: i,
      text: `msg ${i}`,
    }));

    const { rerender } = renderMainContent(
      createUIState({ history, historyRemountKey: 1 }),
    );
    // All 100 + 3 prefix items rendered immediately (below/at threshold).
    expect(staticItemsSpy.mock.calls.at(-1)?.[0]).toHaveLength(103);

    // Simulate a pending item finalizing: history grows by 1, same remount key.
    // replayCount is 100; new length is 101; gap = 1 ≤ PROGRESSIVE_REPLAY_CHUNK_SIZE (50).
    staticItemsSpy.mockClear();
    rerender(
      <AppContext.Provider value={{ version: '1.2.3', startupWarnings: [] }}>
        <UIActionsContext.Provider value={createUIActions()}>
          <UIStateContext.Provider
            value={createUIState({
              history: [
                ...history,
                { type: 'user' as const, id: 100, text: 'new msg' },
              ],
              historyRemountKey: 1,
            })}
          >
            <OverflowProvider>
              <MainContent />
            </OverflowProvider>
          </UIStateContext.Provider>
        </UIActionsContext.Provider>
      </AppContext.Provider>,
    );

    // The first render after the append must show all 104 items — no frame
    // where the 101st item disappears (which would register as 103 here).
    expect(staticItemsSpy.mock.calls[0]?.[0]).toHaveLength(104);
  });

  it('synchronously resets to the first chunk on historyRemountKey change after a full catch-up (Ctrl+O regression, issue #3899)', async () => {
    // Wenshao's review: with the previous useEffect-based reset, the FIRST
    // render after a Ctrl+O-induced historyRemountKey bump would still feed
    // <Static> the full (pre-reset) replayCount, causing the synchronous
    // remount blocking the input thread that the PR is trying to fix. This
    // test pins the synchronous-reset behavior.
    staticItemsSpy.mockClear();
    const history = Array.from({ length: 200 }, (_, i) => ({
      type: 'user' as const,
      id: i,
      text: `msg ${i}`,
    }));
    const TOTAL = 203;

    const { rerender } = renderMainContent(
      createUIState({ history, historyRemountKey: 1 }),
    );

    // Drive the chunked replay to completion.
    for (let i = 0; i < 50; i++) {
      const len = staticItemsSpy.mock.calls.at(-1)?.[0].length ?? 0;
      if (len === TOTAL) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(staticItemsSpy.mock.calls.at(-1)?.[0]).toHaveLength(TOTAL);

    // Re-render with a bumped key — analogous to refreshStatic() firing.
    // The very next render must immediately drop back to the first chunk;
    // if reset were deferred to useEffect, <Static> would receive 203 items
    // first and Ink would do the synchronous full-history layout the PR is
    // meant to avoid.
    rerender(
      <AppContext.Provider value={{ version: '1.2.3', startupWarnings: [] }}>
        <UIActionsContext.Provider value={createUIActions()}>
          <UIStateContext.Provider
            value={createUIState({ history, historyRemountKey: 2 })}
          >
            <OverflowProvider>
              <MainContent />
            </OverflowProvider>
          </UIStateContext.Provider>
        </UIActionsContext.Provider>
      </AppContext.Provider>,
    );

    expect(staticItemsSpy.mock.calls.at(-1)?.[0]).toHaveLength(53);
  });

  it('filters out suppressed history items from rendering', async () => {
    staticItemsSpy.mockClear();
    historyItemDisplayPropsSpy.mockClear();
    const history = [
      { type: 'user' as const, id: 1, text: 'hello' },
      {
        type: 'gemini' as const,
        id: 2,
        text: 'hi',
        display: { suppressOnRestore: true },
      },
      {
        type: 'info' as const,
        id: 3,
        text: 'History collapsed: 1 messages hidden.',
        display: { kind: 'collapse-summary' as const },
      },
    ];
    const uiState = createUIState({ history });
    renderMainContent(uiState);
    expect(historyItemDisplayPropsSpy).toHaveBeenCalled();
    const renderedHistoryItems = historyItemDisplayPropsSpy.mock.calls.map(
      (c) => c[0].item,
    );
    // Unsuppressed user message and collapse-summary should render (summary has no suppressOnRestore)
    expect(renderedHistoryItems).toHaveLength(2);
    expect(renderedHistoryItems.find((i) => i.id === 1)).toMatchObject({
      id: 1,
    });
    expect(renderedHistoryItems.find((i) => i.id === 3)).toMatchObject({
      id: 3,
    });
    // Suppressed gemini item should NOT render
    expect(renderedHistoryItems.find((i) => i.id === 2)).toBeUndefined();
  });

  it('does NOT reset progressive replay when only currentModel changes (PR #4119 regression guard)', async () => {
    // Wenshao's review on PR #4119: if AppContainer splits the model-change
    // wiring into two separate effects (setCurrentModel first, refreshStatic
    // -> historyRemountKey bump second), there is a render where currentModel
    // is new but historyRemountKey is still the old value. <Static>'s key is
    // `${historyRemountKey}-${currentModel}`, so the key changes (Ink remounts
    // Static), but the render-phase reset (lastRemountKey !== historyRemountKey)
    // does NOT fire — so the new <Static> is mounted with the full pre-catch-up
    // replayCount, and Ink does the synchronous full-history layout the PR is
    // meant to avoid.
    //
    // This test reproduces only the dangerous half of that interleaving:
    // currentModel flips while historyRemountKey is held constant. Under the
    // correct (single-batch) AppContainer wiring this combination never
    // appears in practice, but the test pins the MainContent invariant —
    // currentModel alone must not trigger progressive-replay reset, which
    // makes any future "two-effect" regression visible here as a freeze.
    staticItemsSpy.mockClear();
    const history = Array.from({ length: 200 }, (_, i) => ({
      type: 'user' as const,
      id: i,
      text: `msg ${i}`,
    }));
    const TOTAL = 203;

    const { rerender } = renderMainContent(
      createUIState({
        history,
        historyRemountKey: 1,
        currentModel: 'model-a',
      }),
    );

    // Drive the chunked replay to completion (replayCount === TOTAL).
    for (let i = 0; i < 50; i++) {
      const len = staticItemsSpy.mock.calls.at(-1)?.[0].length ?? 0;
      if (len === TOTAL) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(staticItemsSpy.mock.calls.at(-1)?.[0]).toHaveLength(TOTAL);

    // Re-render with a NEW currentModel but the SAME historyRemountKey.
    // <Static>'s key will change (Ink remounts), but replayCount must stay
    // at TOTAL — i.e. progressive replay must NOT re-trigger. Any future
    // refactor that re-introduces a one-render gap between setCurrentModel
    // and the historyRemountKey bump will trip this assertion the moment
    // someone correctly drives the reset off the model dimension instead.
    rerender(
      <AppContext.Provider value={{ version: '1.2.3', startupWarnings: [] }}>
        <UIActionsContext.Provider value={createUIActions()}>
          <UIStateContext.Provider
            value={createUIState({
              history,
              historyRemountKey: 1,
              currentModel: 'model-b',
            })}
          >
            <OverflowProvider>
              <MainContent />
            </OverflowProvider>
          </UIStateContext.Provider>
        </UIActionsContext.Provider>
      </AppContext.Provider>,
    );

    // No reset means the LAST staticItemsSpy call still received TOTAL.
    expect(staticItemsSpy.mock.calls.at(-1)?.[0]).toHaveLength(TOTAL);
  });

  describe('Static path (useTerminalBuffer=false)', () => {
    it('renders tool_groups 1:1 in Static mode (no cross-group merge)', () => {
      staticItemsSpy.mockClear();
      historyItemDisplayPropsSpy.mockClear();

      // Two consecutive tool_groups. There is no cross-group merge layer, so
      // each tool_group renders as its own item (no item-count change that
      // Ink's append-only <Static> couldn't handle).
      const history = [
        {
          id: 1,
          type: 'tool_group' as const,
          tools: [
            {
              callId: 'a1',
              name: 'bash',
              description: 'run ls',
              status: ToolCallStatus.Success,
              resultDisplay: undefined,
              confirmationDetails: undefined,
            },
          ],
        },
        {
          id: 2,
          type: 'tool_group' as const,
          tools: [
            {
              callId: 'b1',
              name: 'bash',
              description: 'run wc',
              status: ToolCallStatus.Success,
              resultDisplay: undefined,
              confirmationDetails: undefined,
            },
          ],
        },
      ];

      // Render in the default Static path (useTerminalBuffer=false).
      render(
        <AppContext.Provider value={{ version: '1.2.3', startupWarnings: [] }}>
          <UIActionsContext.Provider value={createUIActions()}>
            <UIStateContext.Provider value={createUIState({ history })}>
              <OverflowProvider>
                <MainContent />
              </OverflowProvider>
            </UIStateContext.Provider>
          </UIActionsContext.Provider>
        </AppContext.Provider>,
      );

      // 3 prefix items (header / debug / notifications) + 2 raw history items
      // The 2 tool_groups should NOT be merged into 1.
      expect(staticItemsSpy.mock.calls.at(-1)?.[0]).toHaveLength(5);
      // Verify both tool_group ids are present via historyItemDisplayPropsSpy.
      const renderedIds = historyItemDisplayPropsSpy.mock.calls
        .map((call) => call[0].item.id)
        .filter((id) => id === 1 || id === 2);
      expect(renderedIds).toEqual([1, 2]);
    });

    it('preserves tool_use_summary as standalone line in Static mode', () => {
      staticItemsSpy.mockClear();
      historyItemDisplayPropsSpy.mockClear();

      // History with a tool_group followed by its tool_use_summary, then another tool_group.
      // In Static mode, absorbedCallIds returns EMPTY_ABSORBED_CALL_IDS so
      // isSummaryAbsorbed returns false — the summary MUST pass through as a standalone
      // item and render as `● <label>` line in HistoryItemDisplay.
      const history = [
        {
          id: 1,
          type: 'tool_group' as const,
          tools: [
            {
              callId: 'a1',
              name: 'bash',
              description: 'run ls',
              status: ToolCallStatus.Success,
              resultDisplay: undefined,
              confirmationDetails: undefined,
            },
          ],
        },
        {
          id: 2,
          type: 'tool_use_summary' as const,
          precedingToolUseIds: ['a1'],
          summary: 'Searched in auth/',
        },
        {
          id: 3,
          type: 'tool_group' as const,
          tools: [
            {
              callId: 'b1',
              name: 'bash',
              description: 'run wc',
              status: ToolCallStatus.Success,
              resultDisplay: undefined,
              confirmationDetails: undefined,
            },
          ],
        },
      ];

      render(
        <AppContext.Provider value={{ version: '1.2.3', startupWarnings: [] }}>
          <UIActionsContext.Provider value={createUIActions()}>
            <UIStateContext.Provider value={createUIState({ history })}>
              <OverflowProvider>
                <MainContent />
              </OverflowProvider>
            </UIStateContext.Provider>
          </UIActionsContext.Provider>
        </AppContext.Provider>,
      );

      // 3 prefix items (header / debug / notifications) + 3 raw history items
      // (tool_group + tool_use_summary + tool_group). The summary must NOT be dropped.
      expect(staticItemsSpy.mock.calls.at(-1)?.[0]).toHaveLength(6);
      // Verify all three history item ids are present.
      const renderedIds = historyItemDisplayPropsSpy.mock.calls
        .map((call) => call[0].item.id)
        .filter((id) => id === 1 || id === 2 || id === 3);
      expect(renderedIds).toEqual([1, 2, 3]);
    });
  });

  describe('virtual viewport path (ui.useTerminalBuffer)', () => {
    it('renders ScrollableList and skips <Static> entirely when useTerminalBuffer is true', () => {
      staticPropsSpy.mockClear();
      scrollableListPropsSpy.mockClear();

      const { lastFrame } = renderMainContent(
        createUIState({
          useTerminalBuffer: true,
          history: [
            { id: 1, type: 'user', text: 'hello' },
            { id: 2, type: 'gemini', text: 'world' },
          ],
        }),
      );

      expect(scrollableListPropsSpy).toHaveBeenCalled();
      expect(staticPropsSpy).not.toHaveBeenCalled();
      expect(lastFrame()).toContain('APP_HEADER:1.2.3');
      // Items reach VP via renderItem
      expect(lastFrame()).toMatch(/VP_ITEM:1[\s\S]*VP_ITEM:2/);
    });

    it('keeps ShowMoreLines reachable in VP mode (regression of OverflowProvider misplacement)', () => {
      const { lastFrame } = renderMainContent(
        createUIState({
          useTerminalBuffer: true,
          constrainHeight: true,
          // Build pending content tall enough that ShowMoreLines would announce
          // hidden lines if it sees the overflow context. We don't assert the
          // hidden-line count here (depends on OverflowContext internals); the
          // smoke check is that <ShowMoreLines> mounts at all, which the
          // previous OverflowProvider-misplacement bug suppressed.
          pendingHistoryItems: [
            {
              type: 'gemini',
              text: Array.from({ length: 200 }, (_, i) => `line ${i}`).join(
                '\n',
              ),
            },
          ],
        }),
      );

      // SHOW_MORE = live overflow context; OVERFLOW_DISCONNECTED = mounted
      // but the OverflowProvider does not wrap it (the previous bug).
      expect(lastFrame()).toContain('SHOW_MORE');
      expect(lastFrame()).not.toContain('OVERFLOW_DISCONNECTED');
    });

    it('threads source-copy index offsets into renderItem for static history', () => {
      historyItemDisplayPropsSpy.mockClear();

      renderMainContent(
        createUIState({
          useTerminalBuffer: true,
          history: [
            {
              id: 1,
              type: 'gemini_content',
              text: ['```mermaid', 'flowchart TD', '  A --> B', '```'].join(
                '\n',
              ),
            },
            {
              id: 2,
              type: 'gemini_content',
              text: ['```mermaid', 'flowchart TD', '  C --> D', '```'].join(
                '\n',
              ),
            },
          ],
        }),
      );

      // Both items routed through renderItem; the SECOND one's offsets must
      // include the mermaid block from item #1 — i.e. mermaidBlockCount > 0
      // for the second call. This is the legacy contract; VP path was missing
      // it until the audit follow-up.
      const calls = historyItemDisplayPropsSpy.mock.calls.map((c) => c[0]);
      const item2Call = calls.find((p) => p?.item?.id === 2);
      expect(item2Call).toBeDefined();
      expect(item2Call.sourceCopyIndexOffsets).toBeDefined();
    });

    it('reads pending-only UI state via refs (renderItem callback identity stable across activePtyId flips)', () => {
      scrollableListPropsSpy.mockClear();

      // History / pending / slashCommands arrays MUST be reused across the two
      // renders — otherwise their new references invalidate
      // `mergedHistory` / `allVirtualItems` / renderItem's own slashCommands
      // dep and cascade independently of the activePtyId field we're testing.
      // The test fixture defaults create fresh `[]` literals on each call;
      // pin them to stable refs here to isolate the flip.
      const stableHistory: UIState['history'] = [
        { id: 1, type: 'user', text: 'hello' },
      ];
      const stablePending: UIState['pendingHistoryItems'] = [];
      const stableSlashCommands: UIState['slashCommands'] = [];

      // Render once without an active shell.
      const { rerender } = renderMainContent(
        createUIState({
          useTerminalBuffer: true,
          activePtyId: undefined,
          history: stableHistory,
          pendingHistoryItems: stablePending,
          slashCommands: stableSlashCommands,
        }),
      );

      const firstRenderItem =
        scrollableListPropsSpy.mock.calls.at(-1)?.[0].renderItem;

      // Flip activePtyId; identical re-render except this one streaming-state field.
      rerender(
        <AppContext.Provider value={{ version: '1.2.3', startupWarnings: [] }}>
          <UIActionsContext.Provider value={createUIActions()}>
            <UIStateContext.Provider
              value={createUIState({
                useTerminalBuffer: true,
                activePtyId: 1,
                history: stableHistory,
                pendingHistoryItems: stablePending,
                slashCommands: stableSlashCommands,
              })}
            >
              <OverflowProvider>
                <MainContent />
              </OverflowProvider>
            </UIStateContext.Provider>
          </UIActionsContext.Provider>
        </AppContext.Provider>,
      );

      const secondRenderItem =
        scrollableListPropsSpy.mock.calls.at(-1)?.[0].renderItem;

      // If activePtyId were still a useCallback dep, the identity would
      // change here and static items would re-render on every shell tick.
      // The ref-based read keeps identity stable.
      expect(secondRenderItem).toBe(firstRenderItem);
    });
  });
});
