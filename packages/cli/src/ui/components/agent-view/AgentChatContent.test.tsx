/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Teammate-tab transcript scrolling (#9507).
 *
 * In Virtualized History mode (`ui.useTerminalBuffer`, the default) the
 * interactive UI takes over the whole terminal, so there is no
 * terminal-native scrollback. The main conversation view renders its
 * transcript in a scrollable virtual viewport (Page Up/Page Down + mouse
 * wheel), but the teammate tab used ink's `<Static>` directly — content
 * that scrolled off screen was unrecoverable. These tests pin the
 * viewport contract for the teammate tab:
 *
 *  - VP mode: the transcript lives in a scrollable viewport pinned to
 *    the tail; Page Up reveals earlier output (and the tail leaves the
 *    visible window).
 *  - Legacy mode (`useTerminalBuffer: false`): the transcript keeps
 *    flowing through `<Static>` into the terminal's native scrollback —
 *    every line is emitted and Page Up must not hide anything.
 *  - VP mode keeps the executing/confirming split: items from an
 *    executing tool group onward render through the pending (interactive)
 *    path so confirmation dialogs keep working inside the viewport.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { act } from '@testing-library/react';
import { Text } from 'ink';
import { AgentChatContent } from './AgentChatContent.js';
import { UIStateContext, type UIState } from '../../contexts/UIStateContext.js';
import { KeypressProvider } from '../../contexts/KeypressContext.js';
import { AgentStatus } from '@qwen-code/qwen-code-core';
import type { AgentMessage } from '@qwen-code/qwen-code-core';

vi.mock('../../utils/measure-element-position.js', () => ({
  measureElementPosition: () => ({ x: 0, y: 0, width: 80, height: 8 }),
}));

// ink-testing-library's fake stdout has no `isTTY`; ScrollableList's
// `useMouseEvents` gates SGR mouse mode on it. Report a TTY so the
// viewport arms as in a real terminal (mirrors ScrollableList.test).
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return {
    ...actual,
    useStdout: () => ({
      stdout: { write: vi.fn(), isTTY: true },
      writeToStdout: vi.fn(),
    }),
  };
});

vi.mock('../HistoryItemDisplay.js', () => ({
  HistoryItemDisplay: ({
    item,
    isPending,
  }: {
    item: { id: number; type: string; text?: string };
    isPending?: boolean;
  }) => (
    <Text>
      {item.type === 'tool_group'
        ? `TOOLGROUP:${item.id}`
        : (item.text ?? `ITEM:${item.id}`)}
      {isPending ? ':pending' : ''}
    </Text>
  ),
}));

vi.mock('./AgentHeader.js', () => ({
  AgentHeader: () => <Text>AGENT_HEADER</Text>,
}));

vi.mock('../GeminiRespondingSpinner.js', () => ({
  GeminiRespondingSpinner: () => <Text>SPINNER</Text>,
}));

const textSelectionControllerSpy = vi.hoisted(() => vi.fn());
vi.mock('../../selection/use-text-selection.js', () => ({
  TextSelectionController: (props: { isActive: boolean }) => {
    textSelectionControllerSpy(props);
    return null;
  },
}));

const setAgentShellFocusedSpy = vi.hoisted(() => vi.fn());
vi.mock('../../contexts/AgentViewContext.js', () => ({
  useAgentViewActions: () => ({
    setAgentShellFocused: setAgentShellFocusedSpy,
  }),
}));

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
    currentModel: 'test-model',
    contextFileNames: [],
    availableTerminalHeight: 8,
    mainAreaWidth: 76,
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
    terminalWidth: 80,
    terminalHeight: 24,
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
    useTerminalBuffer: true,
    showScrollbar: false,
    ...overrides,
  }) as UIState;

const makeMessages = (n: number): AgentMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    role: 'user' as const,
    content: `user-msg-${i}`,
    timestamp: Date.now(),
  }));

const makeCore = (messages: AgentMessage[]) => {
  const emitter = { on: vi.fn(), off: vi.fn() };
  return {
    getEventEmitter: () => emitter,
    getMessages: () => messages,
    getPendingApprovals: () => new Map(),
    getLiveOutputs: () => new Map(),
    getShellPids: () => new Map(),
    runtimeContext: { getTargetDir: () => '' },
    modelConfig: { model: 'test-model' },
  } as never;
};

const makeInteractiveAgent = () =>
  ({
    getStatus: () => AgentStatus.COMPLETED,
    getExecutionStartTimes: () => new Map(),
  }) as never;

const renderContent = (uiState: UIState, core: unknown) =>
  render(
    <KeypressProvider kittyProtocolEnabled={false}>
      <UIStateContext.Provider value={uiState}>
        <AgentChatContent
          core={core as never}
          interactiveAgent={makeInteractiveAgent()}
          instanceKey="teammate@team"
          modelName="teammate"
        />
      </UIStateContext.Provider>
    </KeypressProvider>,
  );

const PAGE_UP = '\x1b[5~';
const settle = () => act(async () => {});

// Page Ups one at a time with a settle between them. Each press moves
// roughly one viewport page, but newly revealed items shrink from their
// estimated height to their measured height as they render, so a single
// press advances fewer items than `containerHeight` — keep pressing
// until the head is guaranteed to be in view.
const pageUpToTop = async (view: { stdin: { write: (s: string) => void } }) => {
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      view.stdin.write(PAGE_UP);
    });
    await settle();
  }
};

describe('AgentChatContent teammate-tab scrolling (#9507)', () => {
  beforeEach(() => {
    setAgentShellFocusedSpy.mockClear();
    textSelectionControllerSpy.mockClear();
  });

  it('VP mode: Page Up scrolls the teammate transcript back to earlier output', async () => {
    const messages = makeMessages(40);
    const view = renderContent(createUIState(), makeCore(messages));
    await settle();

    expect(textSelectionControllerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ isActive: true }),
    );

    // The viewport starts pinned to the tail, like the main view.
    expect(view.lastFrame()).toContain('user-msg-39');
    // Earlier output must NOT be on screen before scrolling — this is
    // what fails with the old always-`<Static>` renderer, which emits
    // every line unconditionally and has no viewport to scroll.
    expect(view.lastFrame()).not.toContain('user-msg-0');

    // Page Up until the head of the transcript is back in view.
    await pageUpToTop(view);

    expect(view.lastFrame()).toContain('user-msg-0');
    // Scrolled away from the tail: the newest line left the viewport.
    expect(view.lastFrame()).not.toContain('user-msg-39');
  });

  it('legacy mode: transcript still flows to terminal scrollback and Page Up hides nothing', async () => {
    const messages = makeMessages(40);
    const view = renderContent(
      createUIState({ useTerminalBuffer: false }),
      makeCore(messages),
    );
    await settle();

    // `<Static>` emits everything — native terminal scrollback works here.
    expect(view.lastFrame()).toContain('user-msg-0');
    expect(view.lastFrame()).toContain('user-msg-39');

    await pageUpToTop(view);

    // No in-app viewport exists in legacy mode; nothing may disappear.
    expect(view.lastFrame()).toContain('user-msg-0');
    expect(view.lastFrame()).toContain('user-msg-39');
  });

  it('VP mode: executing tool groups stay on the interactive (pending) render path', async () => {
    // tool_call without a matching tool_result → Executing → must render
    // through the pending path so confirmation dialogs remain input-
    // capable inside the viewport (mirrors the `<Static>`-mode split).
    const messages: AgentMessage[] = [
      ...makeMessages(20),
      {
        role: 'tool_call',
        content: '',
        timestamp: Date.now(),
        metadata: { callId: 'call-1', toolName: 'run_shell_command' },
      },
    ];
    const view = renderContent(createUIState(), makeCore(messages));
    await settle();

    // The viewport is pinned to the tail, where the executing tool group
    // lives: it must render through the pending (interactive) path.
    expect(view.lastFrame()).toContain('TOOLGROUP:20:pending');

    // Scrolling away must not flip it to the committed path when it
    // re-enters the window: scroll to the head and back to the tail.
    await pageUpToTop(view);
    expect(view.lastFrame()).toContain('user-msg-0');
  });
});
