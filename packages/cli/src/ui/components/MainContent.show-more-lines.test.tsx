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
import { renderWithProviders } from '../../test-utils/render.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { ShellFocusContext } from '../contexts/ShellFocusContext.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { LoadedSettings } from '../../config/settings.js';

const emptySettings = new LoadedSettings(
  { path: '', settings: {}, originalSettings: {} },
  { path: '', settings: {}, originalSettings: {} },
  { path: '', settings: {}, originalSettings: {} },
  { path: '', settings: {}, originalSettings: {} },
  true,
  new Set(),
);

// The same provider stack renderWithProviders wraps around the tree —
// rerender must keep the identical root structure to reconcile in place.
const fullTree = (uiState: UIState) => (
  <SettingsContext.Provider value={emptySettings}>
    <ConfigContext.Provider value={mockConfig}>
      <ShellFocusContext.Provider value={true}>
        <KeypressProvider kittyProtocolEnabled={true}>
          {appTree(uiState)}
        </KeypressProvider>
      </ShellFocusContext.Provider>
    </ConfigContext.Provider>
  </SettingsContext.Provider>
);

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

const renderMainContent = (uiState: UIState) =>
  renderWithProviders(appTree(uiState), { config: mockConfig });

const toolCall = (name: string, output: string) => ({
  callId: 'call-1',
  name,
  displayName: name.toLowerCase(),
  description: 'a command',
  resultDisplay: output,
  status: ToolCallStatus.Success,
  confirmationDetails: undefined,
});

const turnWithToolOutput = (toolName: string, output: string) => [
  { id: 1, type: 'user', text: 'run' } as HistoryItem,
  {
    id: 2,
    type: 'tool_group',
    tools: [toolCall(toolName, output)],
  } as unknown as HistoryItem,
  { id: 3, type: 'gemini', text: 'Done.' } as HistoryItem,
];

// Overflow registration lands in a post-mount effect; let ink flush the
// resulting re-render before asserting on the frame.
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('ctrl+s hint honesty for capped shell output (#10640)', () => {
  it('does not show the hint when the only hidden lines come from the ui.shellOutputMaxLines cap', async () => {
    // 10-line shell result; the default cap (5) hides the first lines and
    // ctrl+s cannot lift that cap — the hint must not advertise them.
    const output = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    );
    const { lastFrame } = renderMainContent(
      createUIState({ history: turnWithToolOutput('Shell', output) }),
    );
    await settle();
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
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hidden ...');
    expect(frame).toContain(HINT);
  });

  it('reveals height-budget-capped lines when constrainHeight is lifted', async () => {
    const output = Array.from({ length: 80 }, (_, i) => `row ${i + 1}`).join(
      '\n',
    );
    const history = turnWithToolOutput('read_file', output);
    const { lastFrame, rerender } = renderMainContent(
      createUIState({ history, staticAreaMaxItemHeight: 30 }),
    );
    await settle();
    expect(lastFrame()).toContain(HINT);
    expect(lastFrame()).not.toContain('row 1\n');

    // ctrl+s: constrainHeight off -> static items get no height budget.
    rerender(
      fullTree(
        createUIState({
          history,
          staticAreaMaxItemHeight: 30,
          constrainHeight: false,
        }),
      ),
    );
    await settle();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('row 1');
    expect(frame).not.toContain('hidden ...');
    expect(frame).not.toContain(HINT);
  });
});
