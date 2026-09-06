/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Text } from 'ink';
import { MainContent } from './MainContent.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';
import { AppContext } from '../contexts/AppContext.js';
import { StreamingContext } from '../contexts/StreamingContext.js';
import {
  ThoughtExpandedProvider,
  type ThoughtExpandedValue,
} from '../contexts/ThoughtExpandedContext.js';
import { ToolCallStatus, StreamingState } from '../types.js';
import type { HistoryItem } from '../types.js';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  renderWithProviders,
  withProviders,
  type RenderWithProvidersOptions,
} from '../../test-utils/render.js';
import { LoadedSettings, type Settings } from '../../config/settings.js';

// Settings with a ui.shellOutputMaxLines override for budget-vs-cap tests.
const settingsWithShellCap = (shellOutputMaxLines: number) =>
  new LoadedSettings(
    { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: {}, originalSettings: {} },
    {
      path: '',
      // InferSettings narrows shellOutputMaxLines to its literal default;
      // the schema accepts any number at runtime.
      settings: { ui: { shellOutputMaxLines } } as Settings,
      originalSettings: { ui: { shellOutputMaxLines } } as Settings,
    },
    { path: '', settings: {}, originalSettings: {} },
    true,
    new Set(),
  );

// Rebuilds the exact root structure renderWithProviders mounted (shared
// withProviders wrapper, no hand copy), so rerender() reconciles in place.
const wrappedTree = (uiState: UIState, options?: RenderWithProvidersOptions) =>
  withProviders(appTree(uiState), { config: mockConfig, ...options });

// Input/measurement plumbing irrelevant to the overflow decision path.
vi.mock('../hooks/useMouseEvents.js', () => ({
  useMouseEvents: vi.fn(),
}));

vi.mock('../utils/measure-element-position.js', () => ({
  measureElementPosition: vi.fn(() => ({
    x: 0,
    y: 0,
    width: 120,
    height: 40,
  })),
  layoutRowForEvent: vi.fn(),
}));

// Skip the virtualization math: drive the real renderItem for every history
// item so each mounts through the real component stack, exactly as the
// visible window of the real VirtualizedList would render it.
vi.mock('./shared/ScrollableList.js', async () => {
  const actual = await vi.importActual<
    typeof import('./shared/ScrollableList.js')
  >('./shared/ScrollableList.js');
  const { Fragment } = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    ScrollableList: (props: {
      data: Array<{ id: number }>;
      renderItem: (info: {
        item: { id: number };
        index: number;
      }) => React.ReactNode;
    }) => (
      <>
        {props.data.map((item, index) => (
          <Fragment key={index}>{props.renderItem({ item, index })}</Fragment>
        ))}
      </>
    ),
  };
});

vi.mock('./AppHeader.js', () => ({
  AppHeader: ({ version }: { version: string }) => (
    <Text>{`APP_HEADER:${version}`}</Text>
  ),
}));

vi.mock('./Notifications.js', () => ({
  Notifications: () => <Text>NOTIFICATIONS</Text>,
}));

vi.mock('./DebugModeNotification.js', () => ({
  DebugModeNotification: () => <Text>DEBUG_NOTIFICATION</Text>,
}));

vi.mock('../selection/use-text-selection.js', () => ({
  TextSelectionController: () => null,
}));

const thoughtValue: ThoughtExpandedValue = {
  allExpanded: false,
  expandedHeadIds: new Set(),
  toggle: () => {},
};

const HINT = 'Press ctrl-s to show more lines';

const mockConfig = {
  getShouldUseNodePtyShell: () => false,
  getTargetDir: () => '/tmp',
} as unknown as Config;

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
    memoryFileCount: 0,
    streamingState: StreamingState.Idle,
    initError: null,
    pendingLlmHistoryItems: [],
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
    isMcpApprovalDialogOpen: false,
    currentMcpApproval: undefined,
    pendingMcpApprovals: [],
    mcpApprovalRemaining: 0,
    isTrustedFolder: true,
    constrainHeight: true,
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
    currentModel: 'qwen3-test',
    contextFileNames: [],
    availableTerminalHeight: 40,
    useTerminalBuffer: true,
    mainAreaWidth: 100,
    staticAreaMaxItemHeight: 160,
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
    voiceMicWarnedStatusRef: { current: null },
    currentIDE: null,
    startupIdeConnectionStatus: {} as UIState['startupIdeConnectionStatus'],
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
    isSkillsManagerDialogOpen: false,
    isExtensionsManagerDialogOpen: false,
    isMcpDialogOpen: false,
    isHooksDialogOpen: false,
    isStatsDialogOpen: false,
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
    workflowKeywordActive: false,
    showWorktreeExitDialog: false,
    activeWorktree: null,
    ...overrides,
  }) as unknown as UIState;

const createUIActions = (): UIActions =>
  ({ refreshStatic: vi.fn() }) as unknown as UIActions;

const appTree = (uiState: UIState) => (
  <AppContext.Provider value={{ version: '1.2.3', startupWarnings: [] }}>
    <UIActionsContext.Provider value={createUIActions()}>
      <UIStateContext.Provider value={uiState}>
        <StreamingContext.Provider value={StreamingState.Idle}>
          <ThoughtExpandedProvider value={thoughtValue}>
            <MainContent />
          </ThoughtExpandedProvider>
        </StreamingContext.Provider>
      </UIStateContext.Provider>
    </UIActionsContext.Provider>
  </AppContext.Provider>
);

const renderMainContent = (
  uiState: UIState,
  options?: RenderWithProvidersOptions,
) => renderWithProviders(appTree(uiState), { config: mockConfig, ...options });

// Live shell output always arrives renderOutputAsMarkdown:false
// (ShellTool's isOutputMarkdown=false); resumed sessions omit the flag and
// hit ToolMessage's default true. Model both shapes explicitly instead of
// silently rendering every fixture with the resumed-session default.
const toolCall = (
  name: string,
  output: string,
  renderOutputAsMarkdown?: boolean,
) => ({
  callId: 'call-1',
  name,
  displayName: name.toLowerCase(),
  description: 'a command',
  resultDisplay: output,
  status: ToolCallStatus.Success,
  confirmationDetails: undefined,
  ...(renderOutputAsMarkdown === undefined ? {} : { renderOutputAsMarkdown }),
});

const turnWithToolOutput = (
  toolName: string,
  output: string,
  renderOutputAsMarkdown?: boolean,
) => [
  { id: 1, type: 'user', text: 'run' } as HistoryItem,
  {
    id: 2,
    type: 'tool_group',
    tools: [toolCall(toolName, output, renderOutputAsMarkdown)],
  } as unknown as HistoryItem,
  { id: 3, type: 'gemini', text: 'Done.' } as HistoryItem,
];

// Overflow registration lands in a post-mount effect, and ink flushes the
// resulting re-render on its own throttle, which can take longer than any
// fixed sleep under load. Poll for the expected frame with a bounded
// timeout instead (repo convention; see AuthDialog.test.tsx).
const WAIT_FOR_OPTIONS = { timeout: 2000, interval: 10 };

describe('ctrl+s hint honesty for capped shell output (#10640)', () => {
  it('does not show the hint when the only hidden lines come from the ui.shellOutputMaxLines cap', async () => {
    // 10-line shell result in the live shape (renderOutputAsMarkdown:false);
    // the default cap (5) hides the first lines and ctrl+s cannot lift that
    // cap — the hint must not advertise them.
    const output = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    );
    const { lastFrame } = renderMainContent(
      createUIState({
        history: turnWithToolOutput('Shell', output, false),
      }),
    );
    await vi.waitFor(() => {
      const current = lastFrame() ?? '';
      expect(current).toContain('... first 5 lines hidden ...');
      expect(current).toContain('line 10');
    }, WAIT_FOR_OPTIONS);
    // Negative assertion: the hint must never appear for shell-capped
    // lines, and waitFor-toContain cannot prove an absence (it passes
    // trivially while the content stays missing). Poll a bounded window
    // instead, failing fast if the hint surfaces, then assert it stayed
    // absent.
    const deadline = Date.now() + 300;
    while (Date.now() < deadline) {
      expect(lastFrame() ?? '').not.toContain(HINT);
      await new Promise((resolve) =>
        setTimeout(resolve, WAIT_FOR_OPTIONS.interval),
      );
    }
    const frame = lastFrame() ?? '';
    // The cap itself is unchanged: marker plus the last five lines.
    expect(frame).toContain('... first 5 lines hidden ...');
    expect(frame).toContain('line 10');
    expect(frame).not.toContain('line 1\n');
    // But the hint no longer promises lines ctrl+s cannot reveal.
    expect(frame).not.toContain(HINT);
  });

  it('still shows the hint when hidden lines respond to ctrl+s', async () => {
    // A non-shell tool has no shellOutputMaxLines cap: its truncation comes
    // from the item height budget, which constrainHeight=false lifts.
    const output = Array.from({ length: 80 }, (_, i) => `row ${i + 1}`).join(
      '\n',
    );
    const { lastFrame } = renderMainContent(
      createUIState({
        history: turnWithToolOutput('read_file', output),
        staticAreaMaxItemHeight: 30,
      }),
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('hidden ...');
    }, WAIT_FOR_OPTIONS);
    // The hint is driven by the post-mount overflow registration, which
    // ink flushes one tick after the truncation marker itself.
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(HINT);
    }, WAIT_FOR_OPTIONS);
  });

  it('reveals height-budget-capped lines when constrainHeight is lifted', async () => {
    const output = Array.from({ length: 80 }, (_, i) => `row ${i + 1}`).join(
      '\n',
    );
    const history = turnWithToolOutput('read_file', output);
    const { lastFrame, rerender } = renderMainContent(
      createUIState({ history, staticAreaMaxItemHeight: 30 }),
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('hidden ...');
    }, WAIT_FOR_OPTIONS);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(HINT);
    }, WAIT_FOR_OPTIONS);
    expect(lastFrame()).not.toContain('row 1\n');

    // ctrl+s: constrainHeight off -> static items get no height budget.
    rerender(
      wrappedTree(
        createUIState({
          history,
          staticAreaMaxItemHeight: 30,
          constrainHeight: false,
        }),
      ),
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('row 1');
    }, WAIT_FOR_OPTIONS);
    // The overflow unregistration lands in a post-commit effect, so the
    // hint can survive one more ink flush than the expanded content; poll
    // for its disappearance instead of asserting on the first expanded
    // frame.
    await vi.waitFor(() => {
      expect(lastFrame() ?? '').not.toContain(HINT);
    }, WAIT_FOR_OPTIONS);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('row 1');
    expect(frame).not.toContain('hidden ...');
    expect(frame).not.toContain(HINT);
  });

  it('keeps resumed-session shell output capped when ctrl+s lifts the height budget', async () => {
    // Resumed sessions rebuild tool displays without renderOutputAsMarkdown
    // (ToolMessage default true). Pressing ctrl+s then drops the height
    // budget (constrainHeight=false), but the ui.shellOutputMaxLines cap must
    // still bind — the output must not escape through the markdown branch,
    // which MaxSizedBox does not contain (#10640).
    const output = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    );
    // renderOutputAsMarkdown omitted on purpose: the resumed-session shape.
    const { lastFrame } = renderMainContent(
      createUIState({
        history: turnWithToolOutput('Shell', output),
        constrainHeight: false,
      }),
    );
    await vi.waitFor(() => {
      const current = lastFrame() ?? '';
      expect(current).toContain('... first 5 lines hidden ...');
      expect(current).toContain('line 10');
    }, WAIT_FOR_OPTIONS);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('... first 5 lines hidden ...');
    expect(frame).not.toContain('line 1\n');
    expect(frame).not.toContain(HINT);
  });

  it('keeps the hint when the height budget binds tighter than the shell cap', async () => {
    // ui.shellOutputMaxLines=50 with a small per-item height budget: the
    // hidden lines come from the budget, which ctrl+s CAN lift — the hint
    // must stay until the budget is lifted, and the expanded output stops at
    // the (larger) shell cap rather than ignoring it.
    const output = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join(
      '\n',
    );
    const history = turnWithToolOutput('Shell', output, false);
    const options = { settings: settingsWithShellCap(50) };
    const { lastFrame, rerender } = renderMainContent(
      createUIState({ history, staticAreaMaxItemHeight: 12 }),
      options,
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('hidden ...');
    }, WAIT_FOR_OPTIONS);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain(HINT);
    }, WAIT_FOR_OPTIONS);

    // ctrl+s lifts the budget; the output expands and the hint disappears
    // once the overflow unregisters.
    rerender(
      wrappedTree(
        createUIState({
          history,
          staticAreaMaxItemHeight: 12,
          constrainHeight: false,
        }),
        options,
      ),
    );
    await vi.waitFor(() => {
      expect(lastFrame()).toContain('row 1');
    }, WAIT_FOR_OPTIONS);
    await vi.waitFor(() => {
      expect(lastFrame() ?? '').not.toContain(HINT);
    }, WAIT_FOR_OPTIONS);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('row 20');
    expect(frame).not.toContain('hidden ...');
  });
});
