// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createRef, type CSSProperties } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonInputAnnotation } from '@qwen-code/sdk/daemon';
import type { WebShellApi } from './App';
import type { Message } from './adapters/types';
import { loadSplitSessions, saveSplitSessions } from './utils/splitUrl';

type StreamingState = 'idle' | 'responding';

type MockConnection = {
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  sessionId: string | undefined;
  clientId: string;
  displayName: string | undefined;
  workspaceCwd: string;
  currentModel: string;
  currentMode: string;
  models: Array<{ id: string; label?: string }>;
  commands: unknown[];
  skills: string[];
  capabilities: { qwenCodeVersion: string; features: string[] };
  loadingTranscript: boolean;
  catchingUp: boolean;
  error?: string;
  errorStatus?: number;
  missingSession?: boolean;
};

type ChatEditorTestProps = {
  onSubmit: (
    text: string,
    images?: { data: string; media_type: string }[],
    commitAccepted?: () => void,
    metadata?: { inputAnnotations?: DaemonInputAnnotation[] },
  ) => boolean | void;
  onInputTextChange?: (text: string) => void;
  onStartNewSessionSuggestion?: () => void;
  newSessionSuggestion?: { isVisible: boolean; classifiedInput: string } | null;
  skills?: Array<{ name: string; description: string }>;
  commands?: Array<{ name: string }>;
  isPreparing?: boolean;
  dialogOpen?: boolean;
  placeholderText?: string;
  workspaces?: Array<{ id: string; cwd: string }>;
  atWorkspaceCwd?: string;
  selectedWorkspaceCwd?: string;
  onSelectWorkspace?: (cwd: string | undefined) => void;
  onCreateScratchWorkspace?: () => void;
  onOpenExistingWorkspace?: () => void;
  scratchWorkspaceSupported?: boolean;
  existingFolderWorkspaceSupported?: boolean;
};

type AddWorkspaceDialogTestProps = {
  onClose: () => void;
  onAdd: (cwd: string, persist: boolean, displayName?: string) => Promise<void>;
  displayNameEnabled?: boolean;
  persistenceSupported?: boolean;
};

const {
  mockConnection,
  mockSessionActions,
  mockWorkspace,
  mockWorkspaceActions,
  mockMcp,
  mockStore,
  mockFollowup,
  testState,
  sidebarTokens,
  rawEnqueuePrompt,
  editorClear,
  editorCommit,
  editorFocus,
  editorInsertText,
  settingsReload,
} = vi.hoisted(() => {
  const connection: MockConnection = {
    status: 'connected',
    sessionId: 'session-1',
    clientId: 'client-1',
    displayName: 'Session One',
    workspaceCwd: '/tmp/project',
    currentModel: 'qwen',
    currentMode: 'default',
    models: [{ id: 'qwen', label: 'Qwen' }],
    commands: [],
    skills: [],
    capabilities: { qwenCodeVersion: '1.2.3', features: [] },
    loadingTranscript: false,
    catchingUp: false,
  };
  const loadSkillsStatus = vi.fn().mockResolvedValue({ skills: [] });
  const workspaceClient = {
    workspaceByCwd: vi.fn(() => ({
      workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
      workspaceSkills: loadSkillsStatus,
    })),
    sessionStatus: vi.fn(() => Promise.resolve({})),
  };
  return {
    mockConnection: connection,
    mockSessionActions: {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      generateSessionContent: vi.fn(async function* () {}),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      attachSession: vi.fn().mockResolvedValue(undefined),
      clearSession: vi.fn().mockResolvedValue(undefined),
      releaseSession: vi.fn().mockResolvedValue(undefined),
      refreshCommands: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
      setApprovalMode: vi.fn().mockResolvedValue(undefined),
      getRewindSnapshots: vi.fn().mockResolvedValue([]),
      rewindSession: vi.fn().mockResolvedValue(undefined),
      submitPermission: vi.fn().mockResolvedValue(undefined),
      clearGoal: vi.fn().mockResolvedValue(undefined),
      forkSession: vi.fn().mockResolvedValue({ launched: false }),
      sendShellCommand: vi.fn().mockResolvedValue(undefined),
      getStats: vi.fn().mockResolvedValue({}),
      loadArtifacts: vi.fn().mockResolvedValue({ artifacts: [] }),
      loadSession: vi.fn().mockResolvedValue(undefined),
      reloadSession: vi.fn().mockResolvedValue(undefined),
    },
    mockWorkspace: {
      capabilities: {
        workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
      },
      client: workspaceClient,
      refreshCapabilities: vi.fn(),
    },
    mockWorkspaceActions: {
      loadSkillsStatus,
      loadProviders: vi.fn().mockResolvedValue({ current: null }),
      loadPreflight: vi.fn().mockResolvedValue(null),
      loadEnv: vi.fn().mockResolvedValue(null),
      loadMcpStatus: vi.fn().mockResolvedValue({ servers: [] }),
      loadMcpTools: vi.fn().mockResolvedValue([]),
      loadMcpResources: vi.fn().mockResolvedValue([]),
      addWorkspace: vi.fn(),
      addScratchWorkspace: vi.fn(),
      suggestWorkspacePaths: vi.fn(),
    },
    mockMcp: {
      initialize: vi.fn().mockResolvedValue({ accepted: true }),
      reloadConfig: vi.fn().mockResolvedValue({ accepted: true }),
      reload: vi.fn(),
      loadTools: vi.fn(),
      loadResources: vi.fn(),
      restartServer: vi.fn(),
      manageServer: vi.fn(),
      addServer: vi.fn(),
      removeServer: vi.fn(),
      loading: false,
      error: undefined,
    },
    mockStore: {
      dispatch: vi.fn(),
      reset: vi.fn(),
      appendLocalUserMessage: vi.fn(),
      appendLocalAssistantMessage: vi.fn(),
    },
    mockFollowup: {
      clear: vi.fn(),
      onAcceptFollowup: vi.fn(),
      onDismissFollowup: vi.fn(),
    },
    testState: {
      prompt: 'hello',
      inputAnnotations: undefined as DaemonInputAnnotation[] | undefined,
      promptImages: undefined as
        | { data: string; media_type: string }[]
        | undefined,
      streamingState: 'idle' as StreamingState,
      blocks: [] as unknown[],
      messages: [] as unknown[],
      latestChatEditorProps: null as ChatEditorTestProps | null,
      latestAddWorkspaceDialogProps: null as AddWorkspaceDialogTestProps | null,
      latestToolApprovalKeyboardActive: null as boolean | null,
      latestAskUserQuestionKeyboardActive: null as boolean | null,
      latestScheduledTasksProps: null as {
        onRunPrompt?: (
          prompt: string,
          sessionId: string | null,
        ) => Promise<void>;
        onCreateViaChat?: () => void;
        workspaces?: Array<{ id: string; cwd: string }>;
        lockedWorkspace?: { id: string; cwd: string; primary: boolean };
      } | null,
      latestGoalsProps: null as {
        onCreateGoal?: (condition: string) => Promise<void>;
        onOpenSession?: (sessionId: string) => void;
      } | null,
    },
    sidebarTokens: [] as Array<number | undefined>,
    rawEnqueuePrompt: vi.fn(() => true),
    editorClear: vi.fn(),
    editorCommit: vi.fn(),
    editorFocus: vi.fn(),
    editorInsertText: vi.fn(),
    settingsReload: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES: ['default', 'plan', 'auto-edit', 'auto', 'yolo'],
  useActions: () => mockSessionActions,
  useConnection: () => mockConnection,
  useDaemonFollowupSuggestion: () => ({
    followupState: null,
    clear: mockFollowup.clear,
    onAcceptFollowup: mockFollowup.onAcceptFollowup,
    onDismissFollowup: mockFollowup.onDismissFollowup,
  }),
  useSessionNotices: () => ({ notices: [], dismissNotice: vi.fn() }),
  usePromptStatus: () => 'idle',
  useSettings: () => ({
    settings: [],
    setValue: vi.fn().mockResolvedValue(undefined),
    reload: settingsReload,
    loading: false,
  }),
  useProviders: () => ({
    providers: [],
    current: undefined,
    loading: false,
    error: undefined,
    reload: vi.fn().mockResolvedValue(undefined),
  }),
  useStreamingState: () => testState.streamingState,
  useTranscriptBlocks: () => testState.blocks,
  useTranscriptHistory: () => ({
    hasMore: false,
    loading: false,
    capacityReached: false,
    loadMore: vi.fn(),
    release: vi.fn(),
  }),
  useTranscriptStore: () => mockStore,
  useWorkspace: () => mockWorkspace,
  useWorkspaceActions: () => mockWorkspaceActions,
  useMcp: () => mockMcp,
  useWorkspaceEventSignals: () => ({
    artifactsVersion: 0,
    extensionsVersion: 0,
  }),
}));

vi.mock('@qwen-code/sdk/daemon', () => ({
  DaemonHttpError: class DaemonHttpError extends Error {
    constructor(
      readonly status: number,
      readonly body: unknown,
      message: string,
    ) {
      super(message);
    }
  },
  DAEMON_GOAL_STATUS_SENTINEL_PREFIX: 'qwen-goal-status:',
  isDaemonTurnError: () => false,
}));

vi.mock('./hooks/useMessages', () => ({
  useMessages: () => testState.messages,
}));

vi.mock('./hooks/useBackgroundTasks', () => ({
  useBackgroundTasks: () => [],
}));

vi.mock('./hooks/useAnimationFrameValue', () => ({
  useAnimationFrameValue: (value: unknown) => value,
}));

vi.mock('./hooks/useQueuedPrompts', () => ({
  useQueuedPrompts: () => ({
    queuedPrompts: [],
    queuedTexts: [],
    enqueuePrompt: rawEnqueuePrompt,
    removeQueuedPrompt: vi.fn(),
    insertQueuedPrompt: vi.fn(),
    editQueuedPrompt: vi.fn(),
    editLastQueuedPrompt: vi.fn(() => false),
    clearQueuedPrompts: vi.fn(() => false),
  }),
}));

vi.mock('./components/ChatEditor', async () => {
  const React = await import('react');
  return {
    ChatEditor: React.forwardRef(function ChatEditor(
      props: ChatEditorTestProps,
      ref: React.ForwardedRef<{
        clear: () => void;
        hasInput: () => boolean;
        insertText: (text: string) => void;
        focus: () => void;
      }>,
    ) {
      testState.latestChatEditorProps = props;
      React.useImperativeHandle(ref, () => ({
        clear: () => {
          testState.prompt = '';
          testState.promptImages = undefined;
          props.onInputTextChange?.('');
          editorClear();
        },
        hasInput: () => testState.prompt.trim().length > 0,
        insertText: editorInsertText,
        submit: () => {
          props.onSubmit(
            testState.prompt,
            testState.promptImages,
            editorCommit,
            testState.inputAnnotations
              ? { inputAnnotations: testState.inputAnnotations }
              : undefined,
          );
        },
        // The panel focus effect calls editorRef.current?.focus() when a panel
        // closes with no pending approval (e.g. resuming a session).
        focus: editorFocus,
      }));
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'button',
          {
            'data-testid': 'submit',
            'data-preparing': props.isPreparing ? 'true' : 'false',
            onClick: () => {
              if (testState.inputAnnotations) {
                props.onSubmit(testState.prompt, undefined, editorCommit, {
                  inputAnnotations: testState.inputAnnotations,
                });
                return;
              }
              props.onSubmit(testState.prompt, undefined, editorCommit);
            },
            type: 'button',
          },
          'submit',
        ),
        props.newSessionSuggestion
          ? React.createElement(
              'div',
              { 'data-testid': 'new-session-suggestion' },
              React.createElement(
                'button',
                {
                  'data-testid': 'new-session-suggestion-start',
                  onClick: () => props.onStartNewSessionSuggestion?.(),
                  type: 'button',
                },
                'This looks like a new topic',
              ),
            )
          : null,
      );
    }),
  };
});

vi.mock('./components/MessageList', async () => {
  const React = await import('react');
  const { useInteractionBlocker } = await import('./interactionBlockContext');
  function InteractionBlockerProbe() {
    const registerInteractionBlocker = useInteractionBlocker();
    const releaseRef = React.useRef<(() => void) | null>(null);
    return React.createElement(
      'button',
      {
        'data-testid': 'interaction-blocker',
        onClick: () => {
          if (releaseRef.current) {
            releaseRef.current();
            releaseRef.current = null;
          } else {
            releaseRef.current = registerInteractionBlocker();
          }
        },
        type: 'button',
      },
      releaseRef.current ? 'release blocker' : 'register blocker',
    );
  }
  return {
    MessageList: React.forwardRef(function MessageList(
      props: {
        showRetryHint?: boolean;
        onRetryClick?: () => void;
        welcomeHeader?: React.ReactNode;
      },
      ref: React.ForwardedRef<{ scrollToBottom: () => void }>,
    ) {
      React.useImperativeHandle(ref, () => ({ scrollToBottom: vi.fn() }));
      return React.createElement(
        'div',
        { 'data-testid': 'messages' },
        props.welcomeHeader ?? null,
        React.createElement(InteractionBlockerProbe),
        props.showRetryHint
          ? React.createElement(
              'button',
              {
                'data-testid': 'retry',
                onClick: props.onRetryClick,
                type: 'button',
              },
              'retry',
            )
          : null,
      );
    }),
  };
});

// SettingsMessage / ModelDialog expose their callbacks as buttons so tests can
// walk the fast-model path: open Settings -> onSubDialog('fastModel') opens the
// model picker -> onSelect fires handleFastModelSelect.
vi.mock('./components/messages/SettingsMessage', async () => {
  const React = await import('react');
  return {
    SettingsMessage: (props: {
      onSubDialog?: (key: string, scope: 'user' | 'workspace') => void;
      onLanguageChange?: (
        language: string,
        scope: 'user' | 'workspace',
      ) => void;
    }) =>
      React.createElement(
        'div',
        { 'data-testid': 'settings-message' },
        React.createElement(
          'button',
          {
            'data-testid': 'open-fast-model',
            type: 'button',
            // The real panel forwards the active tab's scope; default is
            // workspace, which drives the `--project` flag below.
            onClick: () => props.onSubDialog?.('fastModel', 'workspace'),
          },
          'fast model',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-fast-model-user',
            type: 'button',
            // User tab → drives the `--global` flag.
            onClick: () => props.onSubDialog?.('fastModel', 'user'),
          },
          'fast model (user)',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'change-language-workspace',
            type: 'button',
            // Workspace tab language change → /language ui en --project.
            onClick: () => props.onLanguageChange?.('en', 'workspace'),
          },
          'language (workspace)',
        ),
      ),
  };
});

vi.mock('./components/dialogs/ModelDialog', async () => {
  const React = await import('react');
  return {
    ModelDialog: (props: { onSelect?: (id: string) => void }) =>
      React.createElement(
        'button',
        {
          'data-testid': 'model-select',
          type: 'button',
          onClick: () => props.onSelect?.('fast-model-x'),
        },
        'select model',
      ),
  };
});

// The /diff intercept opens this dialog; render it through the (mocked)
// DialogShell so tests can detect it via [data-testid="dialog-shell"] without
// exercising the dialog's diff-fetching hooks.
vi.mock('./components/dialogs/GitDiffDialog', async () => {
  const React = await import('react');
  const { DialogShell } = await import('./components/dialogs/DialogShell');
  return {
    GitDiffDialog: () =>
      React.createElement(DialogShell, null, 'changes dialog'),
    GitDiffContent: () => React.createElement('div', null, 'changes dialog'),
  };
});

// Render DialogShell as an observable container so tests can detect an open
// sub-dialog (model picker, approval-mode picker) via [data-testid="dialog-shell"].
vi.mock('./components/dialogs/DialogShell', async () => {
  const React = await import('react');
  return {
    DialogShell: (props: { children?: React.ReactNode }) =>
      React.createElement(
        'div',
        { 'data-testid': 'dialog-shell' },
        props.children,
      ),
  };
});

vi.mock('./components/sidebar/WebShellSidebar', async () => {
  const React = await import('react');
  return {
    WebShellSidebar: (props: {
      sessionListReloadToken?: number;
      collapsed?: boolean;
      onOpenPlugins?: () => void;
      onOpenDaemonStatus?: () => void;
      onOpenSessions?: () => void;
      onOpenSplitView?: () => void;
      onNewSession?: () => Promise<boolean> | boolean;
      onLoadSession?: (sessionId: string) => Promise<void> | void;
      onOpenAddWorkspace?: () => void;
    }) => {
      sidebarTokens.push(props.sessionListReloadToken);
      // Expose the Daemon Status / Session Overview openers so tests can
      // exercise those activePanel branches (neither has a slash command).
      return React.createElement(
        'div',
        {
          'data-testid': 'sidebar',
          'data-collapsed': String(Boolean(props.collapsed)),
        },
        React.createElement(
          'button',
          {
            'data-testid': 'open-add-workspace',
            type: 'button',
            onClick: props.onOpenAddWorkspace,
          },
          'add workspace',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'new-session',
            type: 'button',
            onClick: props.onNewSession,
          },
          'new session',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'load-session',
            type: 'button',
            onClick: () => props.onLoadSession?.('session-2'),
          },
          'load session',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-plugins',
            type: 'button',
            onClick: props.onOpenPlugins,
          },
          'plugins',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-daemon-status',
            type: 'button',
            onClick: props.onOpenDaemonStatus,
          },
          'daemon status',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-sessions-overview',
            type: 'button',
            onClick: props.onOpenSessions,
          },
          'sessions overview',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'open-split-view',
            type: 'button',
            onClick: props.onOpenSplitView,
          },
          'split view',
        ),
      );
    },
  };
});

vi.mock('./components/dialogs/AddWorkspaceDialog', async () => {
  const React = await import('react');
  return {
    AddWorkspaceDialog: (props: AddWorkspaceDialogTestProps) => {
      testState.latestAddWorkspaceDialogProps = props;
      return React.createElement('div', {
        'data-testid': 'add-workspace-dialog',
      });
    },
  };
});

function mockComponent(path: string, exportName: string): void {
  vi.doMock(path, async () => {
    const React = await import('react');
    return {
      [exportName]: () => React.createElement('div'),
    };
  });
}

mockComponent('./components/StatusBar', 'StatusBar');
mockComponent('./components/StreamingStatus', 'StreamingStatus');
mockComponent('./components/ToastHost', 'ToastHost');
mockComponent('./components/panels/TodoPanel', 'TodoPanel');
mockComponent('./components/WelcomeHeader', 'WelcomeHeader');
mockComponent('./components/dialogs/ApprovalModeDialog', 'ApprovalModeDialog');
mockComponent('./components/dialogs/ResumeDialog', 'ResumeDialog');
mockComponent('./components/dialogs/ToolsDialog', 'ToolsDialog');
mockComponent('./components/tools/ToolsManagerPage', 'ToolsManagerPage');
mockComponent('./components/skills/SkillsManagerPage', 'SkillsManagerPage');
mockComponent('./components/dialogs/DaemonStatusDialog', 'DaemonStatusDialog');
mockComponent('./components/SessionOverviewPanel', 'SessionOverviewPanel');
vi.doMock('./components/SplitView', async () => {
  const React = await import('react');
  return {
    SplitView: (props: {
      onExit?: () => void;
      sessionIds?: string[];
      onPanesChange?: (ids: string[]) => void;
      onPaneArtifactsChange?: (
        sessionId: string,
        artifacts: unknown[],
        workspaceActions: unknown,
      ) => void;
      onRightPanelOpen?: (request: unknown) => void;
    }) => {
      const paneActions = {
        readWorkspaceFile: vi.fn().mockResolvedValue('<p>pane</p>'),
      };
      const artifact = {
        id: 'pane-artifact',
        kind: 'report',
        storage: 'memory',
        source: 'tool',
        status: 'available',
        title: 'Pane artifact',
        updatedAt: '2026-07-10T00:00:00Z',
        sizeBytes: 10,
      };
      const updatedArtifact = {
        ...artifact,
        title: 'Updated pane artifact',
        updatedAt: '2026-07-10T00:01:00Z',
        sizeBytes: 20,
      };
      return React.createElement(
        'div',
        { 'data-testid': 'split-view-mock' },
        // Surface the seed so a test can assert the App preserved / restored it.
        React.createElement(
          'span',
          { 'data-testid': 'split-initial' },
          (props.sessionIds ?? []).join(','),
        ),
        // Simulate the real SplitView reporting its live pane set up to the App.
        React.createElement(
          'button',
          {
            'data-testid': 'split-report-panes',
            type: 'button',
            onClick: () => props.onPanesChange?.(['s1', 's2', 's3']),
          },
          'report',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-report-artifact',
            type: 'button',
            onClick: () =>
              props.onPaneArtifactsChange?.(
                'pane-session',
                [artifact],
                paneActions,
              ),
          },
          'artifact',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-report-updated-artifact',
            type: 'button',
            onClick: () =>
              props.onPaneArtifactsChange?.(
                'pane-session',
                [updatedArtifact],
                paneActions,
              ),
          },
          'updated artifact',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-clear-artifacts',
            type: 'button',
            onClick: () =>
              props.onPaneArtifactsChange?.('pane-session', [], paneActions),
          },
          'clear artifacts',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-open-artifact',
            type: 'button',
            onClick: () =>
              props.onRightPanelOpen?.({
                id: 'artifact:pane-artifact:pane-session',
                kind: 'artifact',
                title: artifact.title,
                turnId: 'turn-1',
                artifactId: artifact.id,
                artifact,
                workspaceActions: paneActions,
                previewContent: '<p>stale</p>',
              }),
          },
          'open artifact',
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'split-back',
            type: 'button',
            onClick: props.onExit,
          },
          'back',
        ),
      );
    },
  };
});
// Capturing mock: stores the onRunPrompt handler (App's real runTaskManually)
// so tests can drive the manual-run orchestration directly, then renders a bare
// node like the other dialog mocks.
vi.doMock('./components/dialogs/ScheduledTasksDialog', async () => {
  const React = await import('react');
  return {
    ScheduledTasksDialog: (props: {
      onRunPrompt?: (prompt: string, sessionId: string | null) => Promise<void>;
      workspaces?: Array<{ id: string; cwd: string }>;
      lockedWorkspace?: { id: string; cwd: string; primary: boolean };
    }) => {
      testState.latestScheduledTasksProps = props;
      return React.createElement('div');
    },
  };
});
// Capturing mock: stores App's real onCreateGoal / onOpenSession handlers so
// tests can drive the goal-creation orchestration without a daemon.
vi.doMock('./components/dialogs/GoalsDialog', async () => {
  const React = await import('react');
  return {
    GoalsDialog: (props: {
      onCreateGoal?: (condition: string) => Promise<void>;
      onOpenSession?: (sessionId: string) => void;
    }) => {
      testState.latestGoalsProps = props;
      return React.createElement('div');
    },
  };
});
vi.doMock('./components/extensions/ExtensionsManagerPage', async () => {
  const React = await import('react');
  return {
    ExtensionsManagerPage: (props: {
      onClose: () => void;
      initialFocusRef?: React.Ref<HTMLHeadingElement>;
      embedded?: unknown;
    }) =>
      React.createElement(
        'div',
        { 'data-testid': 'extensions-manager-page' },
        React.createElement(
          'h1',
          {
            ref: props.initialFocusRef,
            tabIndex: -1,
            'data-testid': 'extensions-manager-heading',
          },
          'Manage extensions',
        ),
        React.createElement('button', {
          'data-testid': 'extensions-manager-back',
          onClick: props.onClose,
        }),
      ),
  };
});
mockComponent('./components/dialogs/ThemeDialog', 'ThemeDialog');
mockComponent(
  './components/dialogs/DeleteSessionDialog',
  'DeleteSessionDialog',
);
mockComponent(
  './components/dialogs/ReleaseSessionDialog',
  'ReleaseSessionDialog',
);
mockComponent('./components/dialogs/RewindDialog', 'RewindDialog');
mockComponent('./components/messages/AgentsMessage', 'AgentsMessage');
mockComponent('./components/messages/MemoryMessage', 'MemoryMessage');
mockComponent('./components/messages/AuthMessage', 'AuthMessage');
// Record keyboardActive so app-level tests can assert the overlay is told to
// grab focus when it becomes topmost (the actual focus lives in the real
// components, covered by their own unit tests).
vi.doMock('./components/messages/ToolApproval', async () => {
  const React = await import('react');
  return {
    ToolApproval: (props: { keyboardActive?: boolean }) => {
      testState.latestToolApprovalKeyboardActive = props.keyboardActive ?? null;
      return React.createElement('div', {
        'data-web-shell-permission-panel': '',
      });
    },
  };
});
vi.doMock('./components/messages/AskUserQuestion', async () => {
  const React = await import('react');
  return {
    AskUserQuestion: (props: { keyboardActive?: boolean }) => {
      testState.latestAskUserQuestionKeyboardActive =
        props.keyboardActive ?? null;
      return React.createElement('div', { 'data-web-shell-ask-panel': '' });
    },
  };
});
mockComponent('./components/messages/TasksStatusMessage', 'TasksStatusMessage');
mockComponent('./components/messages/BtwMessage', 'BtwMessage');
mockComponent('./components/QueuedPromptDisplay', 'QueuedPromptDisplay');

const { App, getBackgroundTaskActivityKey } = await import('./App');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

describe('background task activity key', () => {
  it('includes background shells and excludes background agents', () => {
    const messages = [
      {
        id: 'tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'shell-call',
            toolName: 'shell',
            status: 'in_progress',
            args: { is_background: true },
          },
          {
            callId: 'agent-call',
            toolName: 'agent',
            status: 'pending',
            args: { run_in_background: true },
          },
        ],
      },
    ] satisfies Message[];

    expect(getBackgroundTaskActivityKey(messages)).toBe(
      'shell-call:in_progress',
    );
  });
});

function renderApp(props: React.ComponentProps<typeof App> = {}): {
  container: HTMLElement;
  rerender: (nextProps?: React.ComponentProps<typeof App>) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const doRender = (nextProps: React.ComponentProps<typeof App> = props) => {
    act(() => {
      root.render(<App sidebar={{ enabled: true }} {...nextProps} />);
    });
  };
  doRender(props);
  const entry = { root, container };
  mounted.push(entry);
  const unmount = () => {
    const index = mounted.indexOf(entry);
    if (index >= 0) mounted.splice(index, 1);
    act(() => root.unmount());
    container.remove();
  };
  return { container, rerender: doRender, unmount };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function clickSubmit(container: HTMLElement): Promise<void> {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('[data-testid="submit"]')
      ?.click();
    await Promise.resolve();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value as T | PromiseLike<T>);
    reject = rej;
  });
  return { promise, resolve, reject };
}

// A transcript block shaped like extractPendingPermission() expects. Defaults to
// a non-AskUserQuestion tool (→ pendingToolApproval); pass toolName
// 'ask_user_question' to exercise the pendingAskUserApproval branch instead.
// isAskUserPermission() classifies by rawInput.questions being a non-empty
// array, so the ask-user variant carries a toolCall.input.questions payload
// (getPermissionRawInput reads toolCall.input) — a bare toolName isn't enough.
function makePendingPermissionBlock(
  overrides: { resolved?: boolean; toolName?: string } = {},
): unknown {
  const toolName = overrides.toolName ?? 'run_shell_command';
  const isAskUser = toolName === 'ask_user_question';
  return {
    kind: 'permission',
    resolved: overrides.resolved ?? false,
    requestId: 'req-1',
    sessionId: 'session-1',
    title: 'Run ls',
    toolCall: {
      toolCallId: 'tc-1',
      kind: isAskUser ? 'other' : 'execute',
      _meta: { toolName },
      ...(isAskUser
        ? { input: { questions: [{ question: 'Pick one', options: [] }] } }
        : {}),
    },
    options: [
      { optionId: 'proceed_once', label: 'Allow', raw: {} },
      { optionId: 'cancel', label: 'Reject', raw: {} },
    ],
  };
}

beforeEach(() => {
  // Split persistence uses sessionStorage; clear it so one test's split doesn't
  // auto-restore into the next test's App mount.
  sessionStorage.clear();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    // Query-aware: report a large screen (min-width matches) so the Session
    // Overview entry point is available, while keeping the mobile (max-width)
    // query false as the other tests expect.
    value: vi.fn().mockImplementation((query: string) => ({
      matches: typeof query === 'string' && query.includes('min-width'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  mockConnection.sessionId = 'session-1';
  mockConnection.workspaceCwd = '/tmp/project';
  mockConnection.status = 'connected';
  mockConnection.displayName = 'Session One';
  mockConnection.error = undefined;
  mockConnection.errorStatus = undefined;
  mockConnection.missingSession = false;
  mockConnection.commands = [];
  mockConnection.skills = [];
  mockConnection.loadingTranscript = false;
  mockConnection.catchingUp = false;
  mockWorkspace.capabilities = {
    workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
  };
  mockWorkspace.refreshCapabilities.mockReset();
  mockWorkspace.refreshCapabilities.mockResolvedValue(
    mockWorkspace.capabilities,
  );
  mockWorkspace.client.workspaceByCwd.mockClear();
  testState.prompt = 'hello';
  testState.inputAnnotations = undefined;
  testState.promptImages = undefined;
  testState.streamingState = 'idle';
  testState.blocks = [];
  testState.messages = [];
  testState.latestChatEditorProps = null;
  testState.latestAddWorkspaceDialogProps = null;
  testState.latestToolApprovalKeyboardActive = null;
  testState.latestAskUserQuestionKeyboardActive = null;
  testState.latestScheduledTasksProps = null;
  testState.latestGoalsProps = null;
  sidebarTokens.length = 0;
  rawEnqueuePrompt.mockClear();
  editorClear.mockClear();
  editorCommit.mockClear();
  editorFocus.mockClear();
  editorInsertText.mockClear();
  settingsReload.mockClear();
  settingsReload.mockResolvedValue(undefined);
  mockFollowup.clear.mockClear();
  for (const value of Object.values(mockSessionActions)) {
    if (typeof value === 'function' && 'mockClear' in value) value.mockClear();
  }
  mockSessionActions.sendPrompt.mockResolvedValue(undefined);
  mockSessionActions.createSession.mockResolvedValue({
    sessionId: 'session-1',
  });
  mockSessionActions.attachSession.mockResolvedValue(undefined);
  mockSessionActions.clearSession.mockResolvedValue(undefined);
  mockSessionActions.releaseSession.mockResolvedValue(undefined);
  mockSessionActions.loadSession.mockResolvedValue(undefined);
  mockSessionActions.reloadSession.mockResolvedValue(undefined);
  mockSessionActions.refreshCommands.mockResolvedValue(undefined);
  mockSessionActions.setModel.mockResolvedValue(undefined);
  mockSessionActions.setApprovalMode.mockResolvedValue(undefined);
  mockSessionActions.getRewindSnapshots.mockResolvedValue([]);
  mockSessionActions.rewindSession.mockResolvedValue(undefined);
  mockSessionActions.submitPermission.mockResolvedValue(undefined);
  mockSessionActions.clearGoal.mockResolvedValue(undefined);
  mockSessionActions.forkSession.mockResolvedValue({ launched: false });
  mockSessionActions.sendShellCommand.mockResolvedValue(undefined);
  mockSessionActions.getStats.mockResolvedValue({});
  mockSessionActions.loadSession.mockResolvedValue(undefined);
  mockStore.reset.mockClear();
  mockStore.dispatch.mockClear();
  mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({ skills: [] });
  mockWorkspaceActions.loadProviders.mockResolvedValue({ current: null });
  mockWorkspaceActions.loadPreflight.mockResolvedValue(null);
  mockWorkspaceActions.loadEnv.mockResolvedValue(null);
  mockWorkspaceActions.loadMcpStatus.mockResolvedValue({ servers: [] });
  mockWorkspaceActions.loadMcpTools.mockResolvedValue([]);
  mockWorkspaceActions.loadMcpResources.mockResolvedValue([]);
  mockWorkspaceActions.addWorkspace.mockReset();
  mockWorkspaceActions.addScratchWorkspace.mockReset();
  mockWorkspaceActions.suggestWorkspacePaths.mockReset();
  mockMcp.initialize.mockClear();
  mockMcp.initialize.mockResolvedValue({ accepted: true });
  mockMcp.reloadConfig.mockClear();
  mockMcp.reloadConfig.mockResolvedValue({ accepted: true });
  mockMcp.reload.mockReset();
  mockMcp.loadTools.mockReset();
  mockMcp.loadResources.mockReset();
  mockMcp.restartServer.mockReset();
  mockMcp.restartServer.mockResolvedValue({
    serverName: 'server',
    restarted: true,
    durationMs: 1,
  });
  mockMcp.manageServer.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('App session callbacks', () => {
  it('submits through a disconnected session when prompt SSE restart is enabled', async () => {
    mockConnection.status = 'disconnected';
    renderApp({ restartSseOnPrompt: true });

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('recover connection');
      await Promise.resolve();
    });

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'recover connection',
      expect.objectContaining({ images: undefined }),
    );
  });

  it('reports the current workspace id and path', async () => {
    mockConnection.workspaceCwd = '/work/secondary';
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true },
        { id: 'secondary', cwd: '/work/secondary', primary: false },
      ],
    };
    const onSessionIdChange = vi.fn();

    renderApp({ onSessionIdChange });
    await flush();

    expect(onSessionIdChange).toHaveBeenCalledWith(
      'session-1',
      'secondary',
      '/work/secondary',
    );
  });

  it('creates scratch once, accepts refreshed capabilities, and opens a fresh chat', async () => {
    mockWorkspace.capabilities = {
      features: [
        'dynamic_workspace_registration',
        'scratch_workspace_registration',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    let resolveScratch!: (value: {
      id: string;
      cwd: string;
      primary: boolean;
      trusted: boolean;
      persisted: false;
    }) => void;
    mockWorkspaceActions.addScratchWorkspace.mockReturnValue(
      new Promise((resolve) => {
        resolveScratch = resolve;
      }),
    );
    const accepted = {
      features: ['scratch_workspace_registration'],
      workspaces: [
        ...mockWorkspace.capabilities.workspaces,
        {
          id: 'scratch',
          cwd: '/managed/scratch-Ab3',
          primary: false,
          trusted: true,
        },
      ],
    };
    mockWorkspace.refreshCapabilities.mockResolvedValue(accepted);
    renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
    });
    expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledOnce();
    await act(async () => {
      resolveScratch({
        id: 'scratch',
        cwd: '/managed/scratch-Ab3',
        primary: false,
        trusted: true,
        persisted: false,
      });
      await vi.waitFor(() => {
        expect(mockSessionActions.clearSession).toHaveBeenCalled();
      });
    });

    expect(mockWorkspace.refreshCapabilities).toHaveBeenCalledOnce();
    expect(mockWorkspace.client.workspaceByCwd).toHaveBeenCalledWith(
      '/managed/scratch-Ab3',
    );
  });

  it('opens one App-owned Add workspace dialog from both entry points', async () => {
    mockWorkspace.capabilities = {
      features: [
        'dynamic_workspace_registration',
        'persistent_workspace_registration',
        'workspace_display_name',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { container } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onOpenExistingWorkspace?.();
    });
    expect(
      container.querySelectorAll('[data-testid="add-workspace-dialog"]'),
    ).toHaveLength(1);
    expect(testState.latestAddWorkspaceDialogProps).toMatchObject({
      displayNameEnabled: true,
      persistenceSupported: true,
    });

    act(() => {
      testState.latestAddWorkspaceDialogProps?.onClose();
    });
    expect(
      container.querySelector('[data-testid="add-workspace-dialog"]'),
    ).toBeNull();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-add-workspace"]')
        ?.click();
    });
    expect(
      container.querySelectorAll('[data-testid="add-workspace-dialog"]'),
    ).toHaveLength(1);
  });

  it('forwards a supported workspace display name through the shared mutation lane', async () => {
    const added = {
      id: 'payments',
      cwd: '/tmp/payments',
      displayName: 'Payments API',
      primary: false,
      trusted: true,
      persisted: true,
    };
    mockWorkspace.capabilities = {
      features: [
        'dynamic_workspace_registration',
        'persistent_workspace_registration',
        'workspace_display_name',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.addWorkspace.mockResolvedValue(added);
    mockWorkspace.refreshCapabilities.mockResolvedValue({
      ...mockWorkspace.capabilities,
      workspaces: [...mockWorkspace.capabilities.workspaces, added],
    });
    renderApp();
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onOpenExistingWorkspace?.();
    });

    await act(async () => {
      await testState.latestAddWorkspaceDialogProps?.onAdd(
        '/tmp/payments',
        true,
        'Payments API',
      );
    });

    expect(mockWorkspaceActions.addWorkspace).toHaveBeenCalledWith(
      '/tmp/payments',
      { persist: true, displayName: 'Payments API' },
    );
    expect(mockWorkspace.refreshCapabilities).toHaveBeenCalledOnce();
  });

  it('omits unsupported persistence and display-name options', async () => {
    const added = {
      id: 'local',
      cwd: '/tmp/local',
      primary: false,
      trusted: true,
    };
    mockWorkspace.capabilities = {
      features: ['dynamic_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.addWorkspace.mockResolvedValue(added);
    mockWorkspace.refreshCapabilities.mockResolvedValue({
      ...mockWorkspace.capabilities,
      workspaces: [...mockWorkspace.capabilities.workspaces, added],
    });
    renderApp();
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onOpenExistingWorkspace?.();
    });
    expect(testState.latestAddWorkspaceDialogProps).toMatchObject({
      displayNameEnabled: false,
      persistenceSupported: false,
    });

    await act(async () => {
      await testState.latestAddWorkspaceDialogProps?.onAdd(
        '/tmp/local',
        true,
        'Ignored name',
      );
    });

    expect(mockWorkspaceActions.addWorkspace).toHaveBeenCalledWith(
      '/tmp/local',
      { persist: false },
    );
  });

  it('rejects when the daemon does not confirm persistent registration', async () => {
    mockWorkspace.capabilities = {
      features: [
        'dynamic_workspace_registration',
        'persistent_workspace_registration',
      ],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.addWorkspace.mockResolvedValue({
      id: 'payments',
      cwd: '/tmp/payments',
      primary: false,
      trusted: true,
      persisted: false,
    });
    renderApp();
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onOpenExistingWorkspace?.();
    });

    await expect(
      testState.latestAddWorkspaceDialogProps?.onAdd('/tmp/payments', true),
    ).rejects.toThrow(
      'The daemon did not confirm persistent workspace registration',
    );
  });

  it('surfaces an inline error when an added folder cannot refresh capabilities', async () => {
    const added = {
      id: 'payments',
      cwd: '/tmp/payments',
      primary: false,
      trusted: true,
    };
    mockWorkspace.capabilities = {
      features: ['dynamic_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.addWorkspace.mockResolvedValue(added);
    mockWorkspace.refreshCapabilities.mockRejectedValueOnce(
      new Error('refresh failed'),
    );
    renderApp();
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onOpenExistingWorkspace?.();
    });

    await expect(
      testState.latestAddWorkspaceDialogProps?.onAdd('/tmp/payments', false),
    ).rejects.toThrow(
      'Workspace added, but the workspace list could not be refreshed',
    );
    expect(mockWorkspaceActions.addWorkspace).toHaveBeenCalledOnce();
  });

  it('retries only capability refresh after a committed scratch cannot reconcile', async () => {
    mockWorkspace.capabilities = {
      features: ['scratch_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const result = {
      id: 'scratch',
      cwd: '/managed/scratch-retry',
      primary: false,
      trusted: true,
      persisted: false as const,
    };
    const accepted = {
      features: ['scratch_workspace_registration'],
      workspaces: [...mockWorkspace.capabilities.workspaces, { ...result }],
    };
    mockWorkspaceActions.addScratchWorkspace.mockResolvedValue(result);
    mockWorkspace.refreshCapabilities
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce(accepted);
    renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
      await vi.waitFor(() => {
        expect(mockWorkspace.refreshCapabilities).toHaveBeenCalledOnce();
      });
    });
    act(() => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
    });
    expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledOnce();

    const refreshButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Refresh workspace list');
    await act(async () => {
      refreshButton?.click();
      await vi.waitFor(() => {
        expect(mockWorkspace.refreshCapabilities).toHaveBeenCalledTimes(2);
        expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();
      });
    });

    expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledOnce();
  });

  it('locks scratch creation after an unknown outcome until acknowledged', async () => {
    mockWorkspace.capabilities = {
      features: ['scratch_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    mockWorkspaceActions.addScratchWorkspace.mockRejectedValue(
      new Error('Add scratch workspace timed out'),
    );
    mockWorkspace.refreshCapabilities.mockResolvedValue(
      mockWorkspace.capabilities,
    );
    renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
      await vi.waitFor(() => {
        expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledOnce();
        expect(mockWorkspace.refreshCapabilities).toHaveBeenCalledOnce();
      });
    });
    await flush();
    act(() => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
    });

    expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('I checked the workspace list');

    const ackButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'I checked the workspace list');
    expect(ackButton).toBeDefined();
    mockWorkspaceActions.addScratchWorkspace.mockResolvedValue({
      id: 'scratch-2',
      cwd: '/managed/scratch-2',
      primary: false,
      trusted: true,
      persisted: false,
    });
    mockWorkspace.refreshCapabilities.mockResolvedValue({
      features: ['scratch_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'scratch-2',
          cwd: '/managed/scratch-2',
          primary: false,
          trusted: true,
        },
      ],
    });
    await act(async () => {
      ackButton?.click();
      await vi.waitFor(() => {
        expect(document.body.textContent).not.toContain(
          'I checked the workspace list',
        );
      });
    });

    await act(async () => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
      await vi.waitFor(() => {
        expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledTimes(
          2,
        );
      });
    });
  });

  it('reports a definitive 4xx rejection without locking scratch creation', async () => {
    mockWorkspace.capabilities = {
      features: ['scratch_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const { DaemonHttpError: MockDaemonHttpError } = await import(
      '@qwen-code/sdk/daemon'
    );
    mockWorkspaceActions.addScratchWorkspace.mockRejectedValue(
      new MockDaemonHttpError(403, {}, 'Forbidden'),
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    renderApp();
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
      await vi.waitFor(() => {
        expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledOnce();
      });
    });
    await flush();

    expect(consoleError).toHaveBeenCalledWith(
      '[web-shell]',
      expect.stringContaining('Forbidden'),
      expect.anything(),
    );
    expect(document.body.textContent).not.toContain(
      'I checked the workspace list',
    );

    mockWorkspaceActions.addScratchWorkspace.mockResolvedValue({
      id: 'scratch-3',
      cwd: '/managed/scratch-3',
      primary: false,
      trusted: true,
      persisted: false,
    });
    mockWorkspace.refreshCapabilities.mockResolvedValue({
      features: ['scratch_workspace_registration'],
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'scratch-3',
          cwd: '/managed/scratch-3',
          primary: false,
          trusted: true,
        },
      ],
    });
    await act(async () => {
      testState.latestChatEditorProps?.onCreateScratchWorkspace?.();
      await vi.waitFor(() => {
        expect(mockWorkspaceActions.addScratchWorkspace).toHaveBeenCalledTimes(
          2,
        );
      });
    });
    consoleError.mockRestore();
  });

  it('falls back to primary when the draft workspace becomes untrusted', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    const view = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/secondary');
    });
    expect(testState.latestChatEditorProps?.selectedWorkspaceCwd).toBe(
      '/work/secondary',
    );

    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: false,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    view.rerender();
    await flush();

    expect(
      testState.latestChatEditorProps?.selectedWorkspaceCwd,
    ).toBeUndefined();
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('primary prompt');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalled();
      });
    });
    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: '/tmp/project' }),
    );
  });

  it('revalidates a draft workspace before its cleanup effect runs', async () => {
    mockConnection.sessionId = undefined;
    const secondaryWorkspace = {
      id: 'secondary',
      cwd: '/work/secondary',
      primary: false,
      trusted: true,
    };
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        secondaryWorkspace,
      ],
    } as typeof mockWorkspace.capabilities;
    renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/secondary');
    });
    // Mutate the accepted snapshot in place so the selection ref remains stale
    // and the create-time trust guard, rather than the cleanup effect, is tested.
    secondaryWorkspace.trusted = false;

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('primary prompt');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalled();
      });
    });
    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: '/tmp/project' }),
    );
  });

  it('does not start a new chat when selecting the active workspace', async () => {
    mockConnection.workspaceCwd = '/tmp/project';
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.(undefined);
    });

    expect(mockSessionActions.clearSession).not.toHaveBeenCalled();
  });

  it('starts a fresh chat when an active session selects a different trusted workspace', async () => {
    mockConnection.sessionId = 'session-1';
    mockConnection.workspaceCwd = '/tmp/project';
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    renderApp();
    await flush();

    mockSessionActions.clearSession.mockClear();
    await act(async () => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/secondary');
      await vi.waitFor(() => {
        expect(mockSessionActions.clearSession).toHaveBeenCalled();
      });
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
  });

  it('executes one clear when two workspace-switch intents arrive in the same tick', async () => {
    mockConnection.sessionId = 'session-1';
    mockConnection.workspaceCwd = '/tmp/project';
    mockWorkspace.capabilities = {
      workspaces: [
        {
          id: 'primary',
          cwd: '/tmp/project',
          primary: true,
          trusted: true,
        },
        {
          id: 'secondary',
          cwd: '/work/secondary',
          primary: false,
          trusted: true,
        },
        {
          id: 'tertiary',
          cwd: '/work/tertiary',
          primary: false,
          trusted: true,
        },
      ],
    } as typeof mockWorkspace.capabilities;
    renderApp();
    await flush();

    mockSessionActions.clearSession.mockClear();
    act(() => {
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/secondary');
      testState.latestChatEditorProps?.onSelectWorkspace?.('/work/tertiary');
    });
    await flush();

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
  });

  it('creates new sessions in the locked workspace without a selector', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaces: [
        { id: 'primary', cwd: '/workspace', primary: true },
        { id: 'secondary', cwd: '/work/secondary', primary: false },
      ],
    };
    renderApp({ lockedWorkspaceCwd: '/work/secondary' });
    await flush();

    expect(testState.latestChatEditorProps?.workspaces).toBeUndefined();
    expect(testState.latestChatEditorProps?.atWorkspaceCwd).toBe(
      '/work/secondary',
    );

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('locked prompt');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalled();
      });
    });
    expect(mockSessionActions.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: '/work/secondary' }),
    );
  });

  describe('worktree welcome toggle', () => {
    beforeEach(() => {
      mockConnection.sessionId = undefined;
      mockWorkspace.capabilities = {
        workspaces: [
          { id: 'primary', cwd: '/workspace', primary: true, trusted: true },
        ],
      };
      mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
        workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
        workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
      }));
    });

    const toggleSelector = '[data-testid="worktree-welcome-toggle"]';
    const cancelSelector = '[data-testid="worktree-welcome-cancel"]';
    const badgeDesc = 'Changes happen';

    async function waitForToggle(container: HTMLElement): Promise<void> {
      await vi.waitFor(() => {
        expect(container.querySelector(toggleSelector)).not.toBeNull();
      });
    }

    async function clickButton(
      container: HTMLElement,
      selector: string,
    ): Promise<void> {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(selector)?.click();
      });
    }

    it('shows the toggle in the empty state for a trusted git workspace', async () => {
      const { container } = renderApp({ showWorktreeToggle: true });
      await waitForToggle(container);
    });

    it('hides the toggle for an untrusted workspace', async () => {
      mockWorkspace.capabilities = {
        workspaces: [
          { id: 'primary', cwd: '/workspace', primary: true, trusted: false },
        ],
      };
      const { container } = renderApp({ showWorktreeToggle: true });
      await flush();
      await flush();
      expect(container.querySelector(toggleSelector)).toBeNull();
    });

    it('hides the toggle when the workspace is not a git repository', async () => {
      mockWorkspace.client.workspaceByCwd.mockImplementation(() => ({
        workspaceGit: vi.fn().mockRejectedValue(new Error('not a git repo')),
        workspaceSkills: mockWorkspaceActions.loadSkillsStatus,
      }));
      const { container } = renderApp({ showWorktreeToggle: true });
      await flush();
      await flush();
      expect(container.querySelector(toggleSelector)).toBeNull();
    });

    it('toggles the pending badge on and off', async () => {
      const { container } = renderApp({ showWorktreeToggle: true });
      await waitForToggle(container);

      await clickButton(container, toggleSelector);
      expect(container.textContent).toContain(badgeDesc);
      expect(container.querySelector(toggleSelector)).toBeNull();

      await clickButton(container, cancelSelector);
      expect(container.textContent).not.toContain(badgeDesc);
      expect(container.querySelector(toggleSelector)).not.toBeNull();
    });

    it('creates the session with worktree when the toggle is enabled', async () => {
      const { container } = renderApp({ showWorktreeToggle: true });
      await waitForToggle(container);
      await clickButton(container, toggleSelector);

      await act(async () => {
        testState.latestChatEditorProps?.onSubmit('work in isolation');
        await vi.waitFor(() => {
          expect(mockSessionActions.createSession).toHaveBeenCalled();
        });
      });
      const arg = mockSessionActions.createSession.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(arg?.['worktree']).toEqual({});
    });

    it('creates the session without worktree when the toggle is off', async () => {
      renderApp({ showWorktreeToggle: true });
      await flush();

      await act(async () => {
        testState.latestChatEditorProps?.onSubmit('regular session');
        await vi.waitFor(() => {
          expect(mockSessionActions.createSession).toHaveBeenCalled();
        });
      });
      const arg = mockSessionActions.createSession.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(arg?.['worktree']).toBeUndefined();
    });

    it('clears the pending worktree intent when starting a new session from the sidebar', async () => {
      const { container } = renderApp({ showWorktreeToggle: true });
      await waitForToggle(container);
      await clickButton(container, toggleSelector);
      expect(container.textContent).toContain(badgeDesc);

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
          ?.click();
        await Promise.resolve();
      });

      await act(async () => {
        testState.latestChatEditorProps?.onSubmit('regular session');
        await vi.waitFor(() => {
          expect(mockSessionActions.createSession).toHaveBeenCalled();
        });
      });
      const arg = mockSessionActions.createSession.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      expect(arg?.['worktree']).toBeUndefined();
    });
  });

  it('reloads skills from the target workspace when starting a new session', async () => {
    const { container } = renderApp({
      lockedWorkspaceCwd: '/work/secondary',
    });
    await flush();
    mockWorkspace.client.workspaceByCwd.mockClear();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mockWorkspace.client.workspaceByCwd).toHaveBeenCalledWith(
      '/work/secondary',
    );
  });

  it('uses a registered capability fallback while the workspace list is stale', async () => {
    mockConnection.sessionId = undefined;
    mockWorkspace.capabilities = {
      workspaceCwd: '/workspace',
      workspaces: undefined,
    };
    const lockedWorkspaceCapability = {
      id: 'secondary',
      cwd: '/work/secondary',
      primary: false,
      trusted: true,
    };
    testState.prompt = '/schedule';
    const { container } = renderApp({
      lockedWorkspaceCwd: '/work/secondary',
      lockedWorkspaceCapability,
    });
    await flush();
    await clickSubmit(container);
    await flush();

    expect(testState.latestScheduledTasksProps?.workspaces).toEqual([
      lockedWorkspaceCapability,
    ]);
    expect(testState.latestScheduledTasksProps?.lockedWorkspace).toEqual(
      lockedWorkspaceCapability,
    );
  });

  it('uses configured composer placeholders by state and falls back for blank values', async () => {
    const composerPlaceholders = {
      idle: 'Ask a question',
      loading: 'Preparing chat',
      processing: 'Working on it',
    };
    const { rerender } = renderApp({ composerPlaceholders });
    await flush();

    expect(testState.latestChatEditorProps?.placeholderText).toBe(
      'Ask a question',
    );

    testState.streamingState = 'responding';
    rerender({ composerPlaceholders });
    await flush();
    expect(testState.latestChatEditorProps?.placeholderText).toBe(
      'Working on it',
    );

    rerender({ composerPlaceholders: { idle: 'Ask a question' } });
    await flush();
    expect(testState.latestChatEditorProps?.placeholderText).toBe(
      'Processing. New messages will be queued.',
    );

    mockConnection.catchingUp = true;
    rerender({ composerPlaceholders });
    await flush();
    expect(testState.latestChatEditorProps?.placeholderText).toBe(
      'Preparing chat',
    );

    mockConnection.catchingUp = false;
    testState.streamingState = 'idle';
    rerender({ composerPlaceholders: { idle: '   ' } });
    await flush();
    expect(testState.latestChatEditorProps?.placeholderText).toBe(
      'Type a message or @ file path',
    );
  });

  it('filters disabled skills from the web-shell skills list', async () => {
    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({
      skills: [
        {
          name: 'enabled-skill',
          description: 'Enabled',
          status: 'ok',
        },
        {
          name: 'disabled-extension-skill',
          description: 'Disabled',
          status: 'disabled',
        },
      ],
    });

    renderApp();
    await flush();

    expect(testState.latestChatEditorProps?.skills).toEqual([
      { name: 'enabled-skill', description: 'Enabled' },
    ]);
  });

  it('reloads skills when starting a new session', async () => {
    mockConnection.commands = [
      {
        name: 'review',
        description: 'Review',
        raw: {
          name: 'review',
          description: 'Review',
          input: null,
          _meta: { source: 'skill' },
        },
      },
    ];
    mockConnection.skills = ['review'];
    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({
      skills: [{ name: 'review', description: 'Review', status: 'ok' }],
    });
    const { container } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.skills).toEqual([
      { name: 'review', description: 'Review' },
    ]);
    expect(testState.latestChatEditorProps?.commands).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'review' })]),
    );

    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({
      skills: [{ name: 'review', description: 'Review', status: 'disabled' }],
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
        ?.click();
      await Promise.resolve();
    });

    expect(testState.latestChatEditorProps?.skills).toEqual([]);
    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'review' })]),
    );
    expect(mockWorkspaceActions.loadSkillsStatus).toHaveBeenCalledTimes(2);
  });

  it('adds an enabled skill command when starting a new session', async () => {
    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({
      skills: [{ name: 'review', description: 'Review', status: 'disabled' }],
    });
    const { container } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'review' })]),
    );

    mockWorkspaceActions.loadSkillsStatus.mockResolvedValue({
      skills: [
        {
          name: 'review',
          description: 'Review',
          argumentHint: '<path>',
          status: 'ok',
        },
      ],
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
        ?.click();
      await Promise.resolve();
    });

    expect(testState.latestChatEditorProps?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'review',
          argumentHint: '<path>',
          source: 'skill',
        }),
      ]),
    );
  });

  it.each([404, 410])(
    'shows a missing-session empty state with a new-session action for %d',
    async (status) => {
      mockConnection.status = 'disconnected';
      mockConnection.sessionId = undefined;
      mockConnection.error = 'Session load failed';
      mockConnection.errorStatus = status;
      mockConnection.missingSession = true;

      const onSessionIdChange = vi.fn();
      const { container } = renderApp({
        onSessionIdChange,
      });
      await flush();

      expect(container.textContent).toContain('Current session does not exist');
      const submit = container.querySelector('[data-testid="submit"]');
      expect(submit?.closest('[class*="chatSubtreeHidden"]')).not.toBeNull();
      expect(onSessionIdChange).not.toHaveBeenCalledWith(undefined);

      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'New session')
          ?.click();
        await Promise.resolve();
      });

      expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
      expect(mockSessionActions.createSession).not.toHaveBeenCalled();
      expect(mockSessionActions.attachSession).not.toHaveBeenCalled();
      expect(onSessionIdChange).toHaveBeenCalledWith(undefined);
      expect(onSessionIdChange).toHaveBeenCalledTimes(1);
    },
  );

  it('focuses the composer after starting a new session', async () => {
    const { container } = renderApp();
    await flush();
    editorFocus.mockClear();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledOnce();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(editorFocus).toHaveBeenCalledOnce();
  });

  it('focuses a cleared new session without waiting for detach', async () => {
    const clear = deferred<void>();
    mockSessionActions.clearSession.mockReturnValueOnce(clear.promise);
    const { container } = renderApp();
    await flush();
    editorFocus.mockClear();

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="new-session"]')
        ?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(editorFocus).toHaveBeenCalledOnce();
    await act(async () => clear.resolve());
  });

  it('focuses the composer after loading an existing session', async () => {
    const { container, rerender } = renderApp();
    await flush();
    editorFocus.mockClear();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="load-session"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mockSessionActions.loadSession).toHaveBeenCalledWith('session-2', {
      workspaceCwd: undefined,
    });

    mockConnection.sessionId = 'session-2';
    rerender();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(editorFocus).toHaveBeenCalledOnce();
  });

  it('does not steal focus when an approval appears before deferred session focus', async () => {
    vi.useFakeTimers();
    const { container, rerender } = renderApp();
    await flush();
    editorFocus.mockClear();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="load-session"]')
        ?.click();
      await Promise.resolve();
    });
    mockConnection.sessionId = 'session-2';
    rerender();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    editorFocus.mockClear();
    act(() => vi.runOnlyPendingTimers());

    // The editor isn't refocused while an approval is pending; instead the app
    // tells the approval overlay to take focus (keyboardActive), so a stray
    // keystroke can't send a message past the pending approval.
    expect(editorFocus).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
    expect(testState.latestToolApprovalKeyboardActive).toBe(true);
  });

  it('does not show missing-session state for non-404/410 errors', async () => {
    mockConnection.status = 'disconnected';
    mockConnection.sessionId = undefined;
    mockConnection.error = 'Server error';
    mockConnection.errorStatus = 500;
    mockConnection.missingSession = false;

    const { container } = renderApp({ onSessionIdChange: vi.fn() });
    await flush();

    expect(container.textContent).not.toContain(
      'Current session does not exist',
    );
  });

  it('does not show missing-session state while connecting', async () => {
    mockConnection.status = 'connecting';
    mockConnection.sessionId = undefined;
    mockConnection.error = 'Session load failed';
    mockConnection.errorStatus = 404;
    mockConnection.missingSession = true;

    const { container } = renderApp({ onSessionIdChange: vi.fn() });
    await flush();

    expect(container.textContent).not.toContain(
      'Current session does not exist',
    );
  });

  it('does not notify session change when missing-session new chat fails', async () => {
    mockConnection.status = 'disconnected';
    mockConnection.sessionId = undefined;
    mockConnection.error = 'Session load failed';
    mockConnection.errorStatus = 404;
    mockConnection.missingSession = true;
    mockSessionActions.clearSession.mockRejectedValueOnce(new Error('network'));

    const onSessionIdChange = vi.fn();
    const { container } = renderApp({ onSessionIdChange });
    await flush();

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'New session')
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    expect(onSessionIdChange).not.toHaveBeenCalled();
  });

  it('preserves active goal for the same session and clears it after session changes', async () => {
    const activeGoals: unknown[] = [];
    const { rerender } = renderApp({
      renderFooter: (props) => {
        activeGoals.push(props.activeGoal);
        return null;
      },
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('web-shell-goal-status-active', {
          detail: {
            active: true,
            condition: 'ship it',
            setAt: 123,
          },
        }),
      );
      await Promise.resolve();
    });

    expect(activeGoals.at(-1)).toMatchObject({
      condition: 'ship it',
      setAt: 123,
    });

    mockConnection.errorStatus = 404;
    rerender({
      renderFooter: (props) => {
        activeGoals.push(props.activeGoal);
        return null;
      },
    });
    await flush();

    expect(activeGoals.at(-1)).toMatchObject({
      condition: 'ship it',
      setAt: 123,
    });

    mockConnection.sessionId = 'session-2';
    rerender({
      renderFooter: (props) => {
        activeGoals.push(props.activeGoal);
        return null;
      },
    });
    await flush();

    expect(activeGoals.at(-1)).toBeNull();
  });

  it('gates direct submissions and dispatches submit events with delayed sidebar reload', async () => {
    vi.useFakeTimers();
    const onSubmitBefore = vi.fn().mockResolvedValue(undefined);
    const onSessionChange = vi.fn();
    const { container } = renderApp({ onSubmitBefore, onSessionChange });
    await flush();

    await clickSubmit(container);
    await flush();

    expect(onSubmitBefore).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: 'hello',
    });
    expect(mockFollowup.clear).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ retry: undefined }),
    );
    expect(editorCommit).toHaveBeenCalledTimes(1);
    expect(editorClear).not.toHaveBeenCalled();
    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'submit',
      sessionId: 'session-1',
      prompt: 'hello',
      queued: false,
    });

    const tokenAfterSubmit = sidebarTokens.at(-1);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(sidebarTokens.at(-1)).not.toBe(tokenAfterSubmit);
  });

  it('does not suggest a new session for obvious follow-up prompts', async () => {
    vi.useFakeTimers();
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `m-followup-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing session topic ${index} about daemon generation review work`,
      timestamp: index,
    }));
    testState.prompt = '顺手补个测试';

    const { container } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="new-session-suggestion"]'),
    ).toBeNull();
    expect(mockSessionActions.generateSessionContent).not.toHaveBeenCalled();
  });

  it('suggests starting a new session for a new-topic prompt and auto-sends it in the fresh session', async () => {
    vi.useFakeTimers();
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing session topic ${index} about daemon generation review work`,
      timestamp: index,
    }));
    const suggestedPrompt =
      'Help me brainstorm Web Shell interaction ideas on top of this interface for a design doc';
    testState.prompt = suggestedPrompt;
    testState.promptImages = [{ data: 'abc', media_type: 'image/png' }];
    mockSessionActions.clearSession.mockImplementation(async () => {
      mockConnection.sessionId = undefined;
    });
    mockSessionActions.createSession.mockImplementation(async () => {
      mockConnection.sessionId = 'session-created';
      return { sessionId: 'session-created' };
    });
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'req-1',
          seq: 0,
          text: JSON.stringify({
            shouldSuggestNewSession: true,
            confidence: 0.91,
          }),
        };
        yield {
          type: 'done',
          requestId: 'req-1',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );

    const { container } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(121);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="new-session-suggestion"]')
        ?.textContent,
    ).toContain('This looks like a new topic');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-session-suggestion-start"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    act(() => {
      vi.runOnlyPendingTimers();
    });
    await flush();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      suggestedPrompt,
      expect.objectContaining({
        images: [{ data: 'abc', media_type: 'image/png' }],
      }),
    );
    expect(editorInsertText).not.toHaveBeenCalled();
  });

  it('waits for the current session to detach before auto-submitting the suggested new-session draft', async () => {
    vi.useFakeTimers();
    const clear = deferred<void>();
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `m-delayed-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing session topic ${index} about daemon generation review work`,
      timestamp: index,
    }));
    const delayedPrompt =
      'Help me brainstorm Web Shell interaction ideas on top of this interface for a design doc';
    testState.prompt = delayedPrompt;
    mockSessionActions.clearSession.mockImplementation(() => {
      mockConnection.sessionId = undefined;
      return clear.promise;
    });
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'req-2',
          seq: 0,
          text: JSON.stringify({
            shouldSuggestNewSession: true,
            confidence: 0.91,
          }),
        };
        yield {
          type: 'done',
          requestId: 'req-2',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );

    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(121);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-session-suggestion-start"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    rerender();
    await flush();
    act(() => {
      vi.runOnlyPendingTimers();
    });
    await flush();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();

    await act(async () => clear.resolve());
    act(() => {
      vi.runOnlyPendingTimers();
    });
    await flush();

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      delayedPrompt,
      expect.any(Object),
    );
  });

  it('dismisses a stale new-session suggestion after the draft changes before acceptance', async () => {
    vi.useFakeTimers();
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `m-stale-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing session topic ${index} about daemon generation review work`,
      timestamp: index,
    }));
    testState.prompt =
      'Help me brainstorm Web Shell interaction ideas on top of this interface for a design doc';
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'req-stale',
          seq: 0,
          text: JSON.stringify({
            shouldSuggestNewSession: true,
            confidence: 0.91,
          }),
        };
        yield {
          type: 'done',
          requestId: 'req-stale',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );

    const { container } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(121);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    expect(
      container.querySelector('[data-testid="new-session-suggestion"]'),
    ).not.toBeNull();

    testState.prompt = '顺手补个测试并继续当前实现';
    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-session-suggestion-start"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();

    expect(mockSessionActions.clearSession).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="new-session-suggestion"]'),
    ).toBeNull();
  });

  it('cancels the pending new-session auto-submit when another session becomes active first', async () => {
    vi.useFakeTimers();
    const clear = deferred<void>();
    mockConnection.capabilities.features = ['session_generation'];
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).tokenCount = 600;
    (
      mockConnection as typeof mockConnection & {
        tokenCount?: number;
        contextWindow?: number;
      }
    ).contextWindow = 1000;
    testState.messages = Array.from({ length: 8 }, (_, index) => ({
      id: `m-switch-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `existing session topic ${index} about daemon generation review work`,
      timestamp: index,
    }));
    testState.prompt =
      'Help me brainstorm Web Shell interaction ideas on top of this interface for a design doc';
    mockSessionActions.clearSession.mockImplementation(() => clear.promise);
    mockSessionActions.generateSessionContent.mockImplementation(
      async function* () {
        yield {
          type: 'delta',
          requestId: 'req-switch',
          seq: 0,
          text: JSON.stringify({
            shouldSuggestNewSession: true,
            confidence: 0.91,
          }),
        };
        yield {
          type: 'done',
          requestId: 'req-switch',
          model: 'fast-model',
          modelSource: 'fast',
        };
      },
    );

    const { container, rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onInputTextChange?.(testState.prompt);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(121);
    });
    await flush();
    act(() => {
      vi.advanceTimersByTime(701);
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="new-session-suggestion-start"]',
        )
        ?.click();
      await Promise.resolve();
    });

    mockConnection.sessionId = 'session-other';
    rerender();
    await flush();

    await act(async () => clear.resolve());
    act(() => {
      vi.runOnlyPendingTimers();
    });
    await flush();

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('keeps concurrent programmatic submissions behind session preparation', async () => {
    mockConnection.sessionId = undefined;
    const callbackStarted = deferred<void>();
    const callbackFinished = deferred<void>();
    mockSessionActions.createSession.mockImplementation(async () => {
      mockConnection.sessionId = 'session-created';
      return { sessionId: 'session-created' };
    });
    const onSessionCreated = vi.fn(async () => {
      callbackStarted.resolve();
      await callbackFinished.promise;
    });
    renderApp({ onSessionCreated });
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('first');
      await callbackStarted.promise;
    });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('second');
      await Promise.resolve();
    });

    expect(mockSessionActions.createSession).toHaveBeenCalledOnce();
    expect(mockSessionActions.attachSession).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();

    await act(async () => {
      callbackFinished.resolve();
      await vi.waitFor(() => {
        expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(2);
      });
    });
    expect(mockSessionActions.attachSession).toHaveBeenCalledOnce();
  });

  it('lets a selected session bypass a stale preparation promise', async () => {
    mockConnection.sessionId = undefined;
    const callbackStarted = deferred<void>();
    const callbackFinished = deferred<void>();
    mockSessionActions.createSession.mockImplementation(async () => {
      mockConnection.sessionId = 'session-created';
      return { sessionId: 'session-created' };
    });
    const onSessionCreated = vi.fn(async () => {
      callbackStarted.resolve();
      await callbackFinished.promise;
    });
    const { rerender } = renderApp({ onSessionCreated });
    await flush();

    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('first');
      await callbackStarted.promise;
    });
    mockConnection.sessionId = 'session-selected';
    rerender({ onSessionCreated });
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('second');
      await vi.waitFor(() => {
        expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
      });
    });

    expect(mockSessionActions.attachSession).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'second',
      expect.any(Object),
    );

    await act(async () => {
      callbackFinished.resolve();
      await vi.waitFor(() => {
        expect(mockSessionActions.releaseSession).toHaveBeenCalledWith(
          'session-created',
        );
      });
    });
    expect(mockSessionActions.attachSession).not.toHaveBeenCalled();
    expect(mockSessionActions.clearSession).not.toHaveBeenCalled();
  });

  it('lets a selected session bypass creation before its id is allocated', async () => {
    mockConnection.sessionId = undefined;
    const creationFinished = deferred<{ sessionId: string }>();
    mockSessionActions.createSession.mockImplementation(
      () => creationFinished.promise,
    );
    const { rerender } = renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('first');
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.createSession).toHaveBeenCalledOnce();
    });
    mockConnection.sessionId = 'session-selected';
    rerender();
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('second');
      await vi.waitFor(() => {
        expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
      });
    });

    expect(mockSessionActions.attachSession).not.toHaveBeenCalled();
    await act(async () => {
      creationFinished.resolve({ sessionId: 'session-created' });
      await vi.waitFor(() => {
        expect(mockSessionActions.releaseSession).toHaveBeenCalledWith(
          'session-created',
        );
      });
    });
    expect(mockSessionActions.attachSession).not.toHaveBeenCalled();
    expect(mockSessionActions.clearSession).not.toHaveBeenCalled();
  });

  it('clears a shared rejected preparation so a later submit can retry', async () => {
    mockConnection.sessionId = undefined;
    const firstCreation = deferred<{ sessionId: string }>();
    mockSessionActions.createSession
      .mockImplementationOnce(() => firstCreation.promise)
      .mockImplementationOnce(async () => {
        mockConnection.sessionId = 'session-retry';
        return { sessionId: 'session-retry' };
      });
    renderApp();
    await flush();

    act(() => {
      testState.latestChatEditorProps?.onSubmit('first');
      testState.latestChatEditorProps?.onSubmit('second');
    });
    await vi.waitFor(() => {
      expect(mockSessionActions.createSession).toHaveBeenCalledOnce();
    });
    firstCreation.reject(new Error('create failed'));
    await flush();
    await flush();

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    await act(async () => {
      testState.latestChatEditorProps?.onSubmit('third');
      await vi.waitFor(() => {
        expect(mockSessionActions.createSession).toHaveBeenCalledTimes(2);
      });
      await vi.waitFor(() => {
        expect(mockSessionActions.sendPrompt).toHaveBeenCalledTimes(1);
      });
    });
  });

  it('cancels direct submissions when onSubmitBefore rejects and preserves retry state', async () => {
    const onSubmitBefore = vi.fn((params: { prompt: string }) =>
      params.prompt === 'blocked'
        ? Promise.reject(new Error('blocked'))
        : Promise.resolve(),
    );
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'first',
      expect.objectContaining({ retry: undefined }),
    );

    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      rerender({ onSubmitBefore });
    });
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    mockSessionActions.sendPrompt.mockClear();
    editorClear.mockClear();
    editorCommit.mockClear();
    testState.prompt = 'blocked';
    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(mockFollowup.clear).toHaveBeenCalledTimes(1);
    expect(editorClear).toHaveBeenCalledTimes(0);
    expect(editorCommit).toHaveBeenCalledTimes(0);
    expect(testState.latestChatEditorProps?.isPreparing).toBe(false);
    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'first',
      expect.objectContaining({ retry: true }),
    );
  });

  it('allows manual retry after a model stream interrupted turn error', async () => {
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = 'recover this stream';
    await clickSubmit(container);
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'recover this stream',
      expect.objectContaining({ retry: undefined }),
    );

    mockSessionActions.sendPrompt.mockClear();
    act(() => {
      testState.blocks = [
        {
          kind: 'error',
          source: 'turn_error',
          id: 'turn-error-stream-interrupted',
          errorKind: 'model_stream_interrupted',
          text: 'terminated',
        },
      ];
      rerender();
    });

    expect(container.querySelector('[data-testid="retry"]')).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="retry"]')
        ?.click();
      await Promise.resolve();
    });

    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      'recover this stream',
      expect.objectContaining({
        optimisticUserMessage: false,
        retry: true,
      }),
    );
  });

  it('gates queued submissions and only enqueues after approval', async () => {
    let approve: (() => void) | undefined;
    const onSubmitBefore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          approve = resolve;
        }),
    );
    const onSessionChange = vi.fn();
    const { container, rerender } = renderApp({
      onSubmitBefore,
      onSessionChange,
    });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSubmitBefore, onSessionChange });
    });
    testState.prompt = 'queued';
    await clickSubmit(container);
    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();

    await act(async () => {
      approve?.();
      await Promise.resolve();
    });

    expect(rawEnqueuePrompt).toHaveBeenCalledWith(
      'queued',
      undefined,
      undefined,
      undefined,
    );
    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'submit',
      sessionId: 'session-1',
      prompt: 'queued',
      queued: true,
    });
    expect(editorCommit).toHaveBeenCalledTimes(1);
    expect(editorClear).not.toHaveBeenCalled();
  });

  it('cancels queued submissions when onSubmitBefore rejects', async () => {
    const onSubmitBefore = vi.fn().mockRejectedValue(new Error('blocked'));
    const { container, rerender } = renderApp({ onSubmitBefore });
    await flush();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSubmitBefore });
    });
    await clickSubmit(container);
    await flush();

    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
  });

  it('keeps daemon-bound slash command drafts when onSubmitBefore rejects', async () => {
    const onSubmitBefore = vi.fn().mockRejectedValue(new Error('blocked'));
    const { container } = renderApp({ onSubmitBefore });
    await flush();

    testState.prompt = '/goal ship it';
    await clickSubmit(container);
    await flush();

    expect(onSubmitBefore).toHaveBeenCalledWith({
      sessionId: 'session-1',
      prompt: '/goal ship it',
    });
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(editorCommit).not.toHaveBeenCalled();
    expect(editorClear).not.toHaveBeenCalled();
  });

  it('notifies the host before forwarding a slash command', async () => {
    const onSlashCommand = vi.fn();
    const { container } = renderApp({ onSlashCommand });
    await flush();

    testState.prompt = '/Deploy staging';
    await clickSubmit(container);
    await flush();

    expect(onSlashCommand).toHaveBeenCalledWith({
      command: 'deploy',
      args: 'staging',
      input: '/Deploy staging',
    });
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      '/Deploy staging',
      expect.any(Object),
    );
  });

  it('lets the host handle a slash command instead of forwarding it', async () => {
    const onSlashCommand = vi.fn(() => true);
    const { container } = renderApp({ onSlashCommand });
    await flush();

    testState.prompt = '/deploy production';
    await clickSubmit(container);
    await flush();

    expect(onSlashCommand).toHaveBeenCalledWith({
      command: 'deploy',
      args: 'production',
      input: '/deploy production',
    });
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('lets the host override a built-in slash command', async () => {
    const onSlashCommand = vi.fn(() => true);
    const { container } = renderApp({ onSlashCommand });
    await flush();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    expect(onSlashCommand).toHaveBeenCalledWith({
      command: 'settings',
      args: '',
      input: '/settings',
    });
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('does not treat an absolute path as a slash command', async () => {
    const onSlashCommand = vi.fn(() => true);
    const { container } = renderApp({ onSlashCommand });
    await flush();

    testState.prompt = '/usr/local/bin/tool';
    await clickSubmit(container);
    await flush();

    expect(onSlashCommand).not.toHaveBeenCalled();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      '/usr/local/bin/tool',
      expect.any(Object),
    );
  });

  it('lets the host handle a slash command while the daemon is unavailable', async () => {
    mockConnection.status = 'error';
    const onSlashCommand = vi.fn(() => true);
    const onToast = vi.fn();
    const { container } = renderApp({ onSlashCommand, onToast });
    await flush();

    testState.prompt = '/deploy production';
    await clickSubmit(container);
    await flush();

    expect(onSlashCommand).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    expect(onToast).not.toHaveBeenCalled();
  });

  it('reports a host slash command error and continues default handling', async () => {
    const error = new Error('host handler exploded');
    const onSlashCommand = vi.fn(() => {
      throw error;
    });
    const onToast = vi.fn();
    const { container } = renderApp({ onSlashCommand, onToast });
    await flush();

    testState.prompt = '/deploy staging';
    await clickSubmit(container);
    await flush();

    expect(onToast).toHaveBeenCalledWith('error', 'host handler exploded');
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      '/deploy staging',
      expect.any(Object),
    );
  });

  it('uses the latest slash command handler after a rerender', async () => {
    const firstHandler = vi.fn();
    const secondHandler = vi.fn(() => true);
    const { container, rerender } = renderApp({
      onSlashCommand: firstHandler,
    });
    await flush();

    rerender({ onSlashCommand: secondHandler });
    await flush();

    testState.prompt = '/deploy staging';
    await clickSubmit(container);
    await flush();
    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledTimes(1);
  });

  it('forwards input annotations for /plan prompts in active sessions', async () => {
    const annotation: DaemonInputAnnotation = {
      type: 'reference',
      text: '@.husky/',
      start: 0,
      end: 8,
      reference: {
        id: '.husky/',
        value: '.husky/',
        serialized: '@.husky/',
      },
    };
    const { container } = renderApp();
    await flush();

    testState.prompt = '/plan @.husky/ explain';
    testState.inputAnnotations = [annotation];
    await clickSubmit(container);
    await flush();

    expect(mockSessionActions.setApprovalMode).toHaveBeenCalledWith('plan');
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      '@.husky/ explain',
      expect.objectContaining({
        inputAnnotations: [annotation],
      }),
    );
  });

  it('dispatches turn_complete only for the session that was streaming', async () => {
    const onSessionChange = vi.fn();
    const { container, rerender } = renderApp({ onSessionChange });
    await flush();

    testState.prompt = 'first';
    await clickSubmit(container);
    onSessionChange.mockClear();

    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSessionChange });
    });
    act(() => {
      testState.blocks = [
        { kind: 'error', source: 'turn_error', id: 'turn-error-1' },
      ];
      testState.streamingState = 'idle';
      rerender({ onSessionChange });
    });

    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'turn_complete',
      sessionId: 'session-1',
      error: expect.objectContaining({
        message: 'Turn error (block turn-error-1)',
      }),
    });

    onSessionChange.mockClear();
    act(() => {
      testState.streamingState = 'responding';
      rerender({ onSessionChange });
    });
    act(() => {
      mockConnection.sessionId = 'session-2';
      testState.streamingState = 'idle';
      rerender({ onSessionChange });
    });

    expect(onSessionChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'turn_complete' }),
    );
  });

  it('auto-closes an open Settings/Status panel when a tool approval becomes pending', async () => {
    // Regression: the approval overlay lives in the chat footer, which is
    // hidden (display:none) while a panel is shown. If a gated tool call
    // arrives while Settings/Status is open, the panel must step aside so the
    // approval is visible instead of the turn hanging behind it.
    const { container, rerender } = renderApp();
    await flush();

    // Open the Settings panel via the /settings command; the panel host carries
    // data-testid="inline-panel", so its presence tracks the panel.
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    // A gated tool call arrives.
    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('does not open the extensions manager page with /extension manage', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/extension manage';
    await clickSubmit(container);
    await flush();

    expect(
      container.querySelector('[data-testid="extensions-manager-page"]'),
    ).toBeNull();
  });

  it('opens the extensions manager page with /extensions manage', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/extensions manage';
    await clickSubmit(container);
    await flush();

    expect(
      container.querySelector('[data-testid="extensions-manager-page"]'),
    ).not.toBeNull();
    const backButton = container.querySelector(
      '[data-testid="extensions-manager-back"]',
    );
    expect(document.activeElement).not.toBe(backButton);
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="extensions-manager-heading"]'),
    );

    editorFocus.mockClear();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="extensions-manager-back"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="extensions-manager-page"]'),
    ).toBeNull();
    expect(editorFocus).toHaveBeenCalled();
  });

  it.each(['/skills', '/skills detail', '/skills details'])(
    'opens the Skill manager page with %s',
    async (command) => {
      const { container } = renderApp();
      await flush();

      testState.prompt = command;
      await clickSubmit(container);
      await flush();

      expect(
        container
          .querySelector('[data-testid="inline-panel"]')
          ?.getAttribute('aria-label'),
      ).toBe('Skills');
      expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
    },
  );

  it('opens plugin management tabs from the sidebar', async () => {
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'completed',
      servers: [],
    });
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-plugins"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();

    const panel = container.querySelector('[data-testid="inline-panel"]');
    const extensionsTab =
      panel?.querySelector<HTMLButtonElement>('button[role="tab"]');
    const tabs =
      panel?.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    expect(panel?.getAttribute('aria-label')).toBe('Plugins');
    expect(Array.from(tabs ?? []).map((tab) => tab.textContent)).toEqual([
      'Extensions',
      'MCP',
      'Skills',
    ]);
    expect(extensionsTab?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(extensionsTab);

    await act(async () => {
      tabs?.[2]?.focus();
      tabs?.[2]?.click();
      await Promise.resolve();
    });
    expect(
      panel
        ?.querySelectorAll<HTMLButtonElement>('button[role="tab"]')[2]
        ?.getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('shadow-isolates only the plugin manager body when plugins is enabled', async () => {
    const { container } = renderApp({
      shadowDom: {
        plugins: true,
        portals: false,
        styles: '.plugin-shadow-content { color: rebeccapurple; }',
      },
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-plugins"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();

    const panel = container.querySelector('[data-testid="inline-panel"]');
    const host = panel?.querySelector<HTMLElement>(
      '[data-web-shell-shadow-host="plugins"]',
    );
    const extensionsTab =
      host?.shadowRoot?.querySelector<HTMLButtonElement>('button[role="tab"]');
    expect(host?.shadowRoot).not.toBeNull();
    expect(host?.shadowRoot?.firstElementChild?.tagName).toBe('STYLE');
    expect(panel?.querySelector('button[role="tab"]')).toBeNull();
    expect(extensionsTab?.textContent).toBe('Extensions');
    expect(host?.shadowRoot?.activeElement).toBe(extensionsTab);
    expect(
      document.querySelector('[data-web-shell-portal-root]'),
    ).not.toBeNull();
  });

  it('uses one shadow root for all portals without moving plugin content', async () => {
    const { container } = renderApp({
      shadowDom: {
        plugins: false,
        portals: true,
        styles: '.consumer-shadow-content { color: rebeccapurple; }',
      },
      style: {
        '--web-shell-portal-root-z-index': '2345',
      } as CSSProperties,
    });
    await flush();

    const portalHost = document.querySelector<HTMLElement>(
      '[data-web-shell-shadow-host="portals"]',
    );
    const portalRoot = portalHost?.shadowRoot?.querySelector(
      '[data-web-shell-portal-root]',
    );
    expect(portalRoot).not.toBeNull();
    expect(portalHost?.style.zIndex).toBe(
      'var(--web-shell-portal-root-z-index, 1000)',
    );
    expect(portalHost?.style.getPropertyPriority('z-index')).toBe('important');
    expect(
      portalHost?.style.getPropertyValue('--web-shell-portal-root-z-index'),
    ).toBe('2345');
    expect(portalHost?.shadowRoot?.firstElementChild?.tagName).toBe('STYLE');
    expect(portalHost?.shadowRoot?.lastElementChild).toBe(portalRoot);
    expect(document.querySelector('[data-web-shell-portal-root]')).toBeNull();
    expect(
      Array.from(portalHost?.shadowRoot?.querySelectorAll('style') ?? []).some(
        (style) => style.textContent?.includes('.consumer-shadow-content'),
      ),
    ).toBe(true);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-plugins"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();

    const panel = container.querySelector('[data-testid="inline-panel"]');
    expect(panel?.querySelector('button[role="tab"]')).not.toBeNull();
    expect(
      panel?.querySelector('[data-web-shell-shadow-host="plugins"]'),
    ).toBeNull();
  });

  it('only shows server startup progress during MCP discovery', async () => {
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'starting',
      servers: [
        {
          name: 'filesystem',
          source: 'project',
          configOrigin: 'workspace_settings',
          disabled: false,
          mcpStatus: 'connecting',
        },
      ],
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/mcp';
    await clickSubmit(container);
    await flush();

    expect(container.textContent).toContain(
      'MCP servers are starting up (1 initializing)',
    );
    expect(container.textContent).not.toContain('Loading MCP tools...');
    expect(
      container.querySelector('[role="button"][aria-label="filesystem"]'),
    ).toHaveProperty('tabIndex', 0);
  });

  it('shows server operations without duplicating tools and resources tabs', async () => {
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'completed',
      workspaceCwd: '/workspace',
      servers: [
        {
          name: 'filesystem',
          source: 'project',
          configOrigin: 'workspace_settings',
          disabled: false,
          mcpStatus: 'disconnected',
          resourceCount: 1,
          removable: true,
        },
      ],
    });
    mockMcp.loadTools.mockResolvedValue({
      serverName: 'filesystem',
      tools: [{ name: 'read_file', description: 'Read a file' }],
    });
    mockMcp.loadResources.mockResolvedValue({
      serverName: 'filesystem',
      resources: [{ uri: 'file:///README.md', name: 'README' }],
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/mcp';
    await clickSubmit(container);
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="filesystem"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="mcp-server-actions"]')
        ?.dispatchEvent(
          new MouseEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('View tools');
    expect(document.body.textContent).not.toContain('View resources');
    expect(document.body.textContent).toContain('Reconnect');
    expect(document.body.textContent).not.toContain('Authenticate');
    expect(document.body.textContent).toContain('Disable');
    expect(document.body.textContent).toContain('Delete');

    await act(async () => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="mcp-server-action-reconnect"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();
    expect(mockMcp.restartServer).toHaveBeenCalledWith('filesystem');
  });

  it('polls workspace MCP status until browser authentication completes', async () => {
    vi.useFakeTimers();
    const disconnectedServer = {
      name: 'yuque',
      source: 'project' as const,
      configOrigin: 'workspace_settings' as const,
      disabled: false,
      mcpStatus: 'disconnected' as const,
      requiresAuth: true,
      resourceCount: 0,
    };
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'completed',
      workspaceCwd: '/workspace',
      servers: [disconnectedServer],
    });
    mockMcp.loadTools.mockResolvedValue({ serverName: 'yuque', tools: [] });
    mockMcp.manageServer.mockResolvedValue({
      serverName: 'yuque',
      action: 'authenticate',
      ok: true,
      pending: true,
      messages: ['Open the browser to authenticate.'],
      authUrl: 'https://example.com/oauth',
    });
    mockMcp.reload
      .mockResolvedValueOnce({
        initialized: true,
        discoveryState: 'completed',
        workspaceCwd: '/workspace',
        servers: [
          { ...disconnectedServer, authenticationState: 'pending' as const },
        ],
      })
      .mockResolvedValueOnce({
        initialized: true,
        discoveryState: 'completed',
        workspaceCwd: '/workspace',
        servers: [
          {
            ...disconnectedServer,
            mcpStatus: 'connected' as const,
            hasOAuthTokens: true,
            authenticationState: 'succeeded' as const,
          },
        ],
      });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/mcp';
    await clickSubmit(container);
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="yuque"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="mcp-server-actions"]')
        ?.dispatchEvent(
          new MouseEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
          }),
        );
      await Promise.resolve();
    });
    await act(async () => {
      document
        .querySelector<HTMLElement>(
          '[data-testid="mcp-server-action-authenticate"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain(
      'Open the browser to authenticate.',
    );
    expect(mockMcp.reload).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(mockMcp.reload).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Authenticating');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await flush();
    expect(mockMcp.reload).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Authenticate complete.');
  });

  it('does not show MCP discovery progress', async () => {
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'starting',
      servers: [],
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/mcp';
    await clickSubmit(container);
    await flush();

    expect(container.textContent).not.toContain('Loading MCP tools...');
  });

  it('does not initialize MCP discovery when it is already complete', async () => {
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'completed',
      servers: [],
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/mcp';
    await clickSubmit(container);
    await flush();

    expect(mockMcp.initialize).not.toHaveBeenCalled();
    expect(mockMcp.reloadConfig).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('MCP tools are ready.');
    expect(container.textContent).not.toContain('Loading MCP tools...');
  });

  it('does not show MCP discovery progress before or after completion', async () => {
    vi.useFakeTimers();
    mockWorkspaceActions.loadMcpStatus.mockResolvedValue({
      initialized: true,
      discoveryState: 'starting',
      servers: [],
    });
    mockMcp.reload.mockResolvedValue({
      initialized: true,
      discoveryState: 'completed',
      servers: [],
    });
    const { container } = renderApp();
    await flush();

    testState.prompt = '/mcp';
    await clickSubmit(container);
    await flush();
    expect(container.textContent).not.toContain('Loading MCP tools...');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await flush();

    expect(container.textContent).not.toContain('Loading MCP tools...');
    expect(container.textContent).not.toContain('MCP tools are ready.');
  });

  it('auto-closes an open panel when an AskUserQuestion approval becomes pending', async () => {
    // The auto-close effect gates on pendingToolApproval || pendingAskUserApproval;
    // this covers the second branch (ask_user_question resolves to
    // pendingAskUserApproval), whose overlay is also hidden behind the panel.
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.blocks = [
        makePendingPermissionBlock({ toolName: 'ask_user_question' }),
      ];
      rerender();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('opens the Daemon Status panel and auto-closes it on a pending approval', async () => {
    // Covers the activePanel === 'status' branch (DaemonStatusDialog); the other
    // panel tests all open via /settings, so this guards the 'status' literal and
    // confirms the auto-close is panel-type-agnostic.
    const { container, rerender } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-daemon-status"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('opens the Session Overview panel from the sidebar', async () => {
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    const panel = container.querySelector('[data-testid="inline-panel"]');
    expect(panel).not.toBeNull();
    // The panelHost aria-label distinguishes which panel is up.
    expect(panel?.getAttribute('aria-label')).toBe('Session Overview');
  });

  it('opens the split view from the sidebar', async () => {
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    // The outer chat subtree is hidden (display:none + aria-hidden) behind the
    // split, so keyboard/AT can't reach the outer composer/toolbar. Assert the
    // node is present first, so a missing subtree fails rather than passing
    // vacuously through the optional chain.
    const messages = container.querySelector('[data-testid="messages"]');
    expect(messages).not.toBeNull();
    expect(messages?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('restores a persisted split on load (survives a refresh)', async () => {
    // Simulate the storage left behind by a split that was open before a refresh.
    saveSplitSessions(['s1', 's2']);
    const { container } = renderApp();
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1,s2');
  });

  it('does not open the split when nothing was persisted', async () => {
    const { container } = renderApp();
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
  });

  it('clears the persisted split when the user leaves the split view', async () => {
    saveSplitSessions(['s1', 's2']);
    const { container } = renderApp();
    await flush();
    // Restored into the split; leaving via its back button must clear storage
    // so a later refresh doesn't bring the split back uninvited.
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-back"]')
        ?.click();
      await Promise.resolve();
    });
    expect(loadSplitSessions()).toEqual([]);
  });

  it('syncs the split view from external session ids without the sidebar', async () => {
    const { container, rerender } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1'],
    });
    await flush();

    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1');

    rerender({ sidebar: false, splitSessionIds: ['s1', 's2'] });
    await flush();
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1,s2');

    rerender({ sidebar: false, splitSessionIds: [] });
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();

    rerender({ sidebar: false, splitSessionIds: ['s1', 's2'] });
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1,s2');
  });

  it('dedupes and caps external split session ids', async () => {
    const { container } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1', 's1', 's2', 's3', 's4', 's5', 's6', 's7'],
    });
    await flush();

    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1,s2,s3,s4,s5,s6');
  });

  it('does not reopen controlled split view when the same ids get a new array reference', async () => {
    const { container, rerender } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1', 's2'],
    });
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-back"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="inline-panel"]')
        ?.getAttribute('aria-label'),
    ).toBe('Session Overview');

    rerender({ sidebar: false, splitSessionIds: ['s1', 's2'] });
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="inline-panel"]')
        ?.getAttribute('aria-label'),
    ).toBe('Session Overview');
  });

  it('notifies external callers when split session ids change inside WebShell', async () => {
    const onSplitSessionIdsChange = vi.fn();
    const { container, rerender } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1'],
      onSplitSessionIdsChange,
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-report-panes"]')
        ?.click();
      await Promise.resolve();
    });

    expect(onSplitSessionIdsChange).toHaveBeenCalledWith(['s1', 's2', 's3']);
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1');

    rerender({
      sidebar: false,
      splitSessionIds: ['s1', 's2', 's3'],
      onSplitSessionIdsChange,
    });
    await flush();
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1,s2,s3');
  });

  it('notifies external callers when uncontrolled split session ids change', async () => {
    const onSplitSessionIdsChange = vi.fn();
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({
      sidebar: false,
      onSplitSessionIdsChange,
      shellRef,
    });
    await flush();

    await act(async () => {
      shellRef.current?.openSplitView();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-report-panes"]')
        ?.click();
      await Promise.resolve();
    });

    expect(onSplitSessionIdsChange).toHaveBeenCalledWith(['s1', 's2', 's3']);
  });

  it('opens the split view from the external shell ref like the sidebar button', async () => {
    let shellApi: WebShellApi | null = null;
    const { container } = renderApp({
      sidebar: false,
      shellRef: (api) => {
        shellApi = api;
      },
    });
    await flush();

    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();

    await act(async () => {
      shellApi?.openSplitView();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('session-1');
  });

  it('requests controlled split ids from the external shell ref', async () => {
    const onSplitSessionIdsChange = vi.fn();
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({
      sidebar: false,
      splitSessionIds: [],
      onSplitSessionIdsChange,
      shellRef,
    });
    await flush();

    await act(async () => {
      shellRef.current?.openSplitView();
      await Promise.resolve();
    });

    expect(onSplitSessionIdsChange).toHaveBeenCalledWith(['session-1']);
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
  });

  it('assigns and clears the external shell object ref', async () => {
    const shellRef = createRef<WebShellApi>();
    const { unmount } = renderApp({
      sidebar: false,
      shellRef,
    });
    await flush();

    expect(shellRef.current).not.toBeNull();

    unmount();

    expect(shellRef.current).toBeNull();
  });

  it('opens the Session Overview from the external shell ref like the sidebar button', async () => {
    let shellApi: WebShellApi | null = null;
    const { container } = renderApp({
      sidebar: false,
      shellRef: (api) => {
        shellApi = api;
      },
    });
    await flush();

    expect(container.querySelector('[data-testid="sidebar"]')).toBeNull();

    await act(async () => {
      shellApi?.openSessionOverview();
      await Promise.resolve();
    });

    const panel = container.querySelector('[data-testid="inline-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('aria-label')).toBe('Session Overview');
  });

  it('forces the compact session drawer from the external shell ref', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });

    const drawer = container.querySelector(
      '[data-sidebar-shell][role="dialog"]',
    );
    expect(drawer).not.toBeNull();
    expect(drawer?.className).toContain('mobileDrawerForced');
  });

  it('does not open or lock scrolling when the sidebar is disabled', async () => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'auto';

    try {
      const shellRef = createRef<WebShellApi>();
      const { container } = renderApp({ sidebar: false, shellRef });
      await flush();

      await act(async () => {
        shellRef.current?.openSessionDrawer();
        await Promise.resolve();
      });

      expect(container.querySelector('[data-sidebar-shell]')).toBeNull();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(document.body.style.overflow).toBe('auto');
    } finally {
      document.body.style.overflow = previousOverflow;
    }
  });

  it('closes a forced compact drawer when the sidebar becomes disabled', async () => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'auto';
    const shellRef = createRef<WebShellApi>();
    const { container, rerender, unmount } = renderApp({
      sidebar: true,
      shellRef,
    });

    try {
      await flush();
      await act(async () => {
        shellRef.current?.openSessionDrawer();
        await Promise.resolve();
      });

      expect(
        container.querySelector('[data-sidebar-shell][role="dialog"]'),
      ).not.toBeNull();
      expect(document.body.style.overflow).toBe('hidden');

      rerender({ sidebar: false, shellRef });
      await flush();

      expect(container.querySelector('[data-sidebar-shell]')).toBeNull();
      expect(container.querySelector('[role="dialog"]')).toBeNull();
      expect(document.body.style.overflow).toBe('auto');
    } finally {
      unmount();
      document.body.style.overflow = previousOverflow;
    }
  });

  it('dismisses a forced compact drawer before opening split view', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).not.toBeNull();

    await act(async () => {
      shellRef.current?.openSplitView();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-sidebar-shell]')?.className,
    ).not.toContain('mobileDrawerForced');
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('dismisses a forced compact drawer before opening the Session Overview', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).not.toBeNull();

    await act(async () => {
      shellRef.current?.openSessionOverview();
      await Promise.resolve();
    });

    const panel = container.querySelector('[data-testid="inline-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('aria-label')).toBe('Session Overview');
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-sidebar-shell]')?.className,
    ).not.toContain('mobileDrawerForced');
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('returns a forced compact drawer to viewport control when dismissed', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-sidebar-shell]')?.className,
    ).toContain('mobileDrawerForced');

    await act(async () => {
      container
        .querySelector<HTMLElement>(
          '[data-sidebar-shell] > div[aria-hidden="true"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-sidebar-shell]')?.className,
    ).not.toContain('mobileDrawerForced');
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).toBeNull();
  });

  it('returns to chat and clears the current page when opening the compact drawer', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSessionOverview();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();

    await act(async () => {
      shellRef.current?.openSplitView();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).not.toBeNull();
  });

  it('clears a forced compact drawer after crossing to a wide viewport', async () => {
    let mobileChangeHandler:
      | ((event: { matches: boolean }) => void)
      | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('min-width'),
        media: query,
        addEventListener: (
          _type: string,
          handler: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('max-width')) mobileChangeHandler = handler;
        },
        removeEventListener: vi.fn(),
      })),
    });
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSessionDrawer();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-sidebar-shell]')?.className,
    ).toContain('mobileDrawerForced');

    await act(async () => {
      mobileChangeHandler?.({ matches: false });
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-sidebar-shell]')?.className,
    ).not.toContain('mobileDrawerForced');
    expect(
      container.querySelector('[data-sidebar-shell][role="dialog"]'),
    ).toBeNull();
  });

  it('starts a new session from the external shell ref and returns to chat', async () => {
    const shellRef = createRef<WebShellApi>();
    const { container } = renderApp({ sidebar: true, shellRef });
    await flush();

    await act(async () => {
      shellRef.current?.openSplitView();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    vi.useFakeTimers();
    let created: boolean | undefined;
    await act(async () => {
      created = await shellRef.current?.createNewSession();
      vi.runOnlyPendingTimers();
    });

    expect(created).toBe(true);
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
  });

  it('reports a failed external new-session attempt through its boolean result', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSessionActions.clearSession.mockRejectedValueOnce(new Error('boom'));
    const shellRef = createRef<WebShellApi>();
    renderApp({ sidebar: true, shellRef });
    await flush();

    vi.useFakeTimers();
    let created: boolean | undefined;
    await act(async () => {
      created = await shellRef.current?.createNewSession();
      vi.runOnlyPendingTimers();
    });

    expect(created).toBe(false);
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '[web-shell]',
      'boom',
      expect.any(Error),
    );
  });

  it('returns to the Session Overview when leaving the split view', async () => {
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-back"]')
        ?.click();
      await Promise.resolve();
    });
    // Split closed; the Session Overview panel is shown instead of the chat.
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    const panel = container.querySelector('[data-testid="inline-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('aria-label')).toBe('Session Overview');
  });

  it('notifies controlled callers when leaving the split view', async () => {
    const onSplitSessionIdsChange = vi.fn();
    const { container } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1', 's2'],
      onSplitSessionIdsChange,
    });
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-back"]')
        ?.click();
      await Promise.resolve();
    });

    expect(onSplitSessionIdsChange).toHaveBeenCalledWith([]);
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="inline-panel"]')
        ?.getAttribute('aria-label'),
    ).toBe('Session Overview');
  });

  it('preserves the pane set when leaving the split view and reopening it', async () => {
    const { container } = renderApp();
    await flush();

    // Open the split, then let SplitView report a live pane set (s1,s2,s3) back
    // to the App — the same way real add/remove mirrors up via onPanesChange.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-report-panes"]')
        ?.click();
      await Promise.resolve();
    });

    // Leave the split (back to the overview)…
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-back"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();

    // …and reopen it from the toolbar. The reported panes must be restored, not
    // reset to empty / the current session (the regression this guards).
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-initial"]')?.textContent,
    ).toBe('s1,s2,s3');
  });

  it('reconciles split pane artifact snapshots in the right panel', async () => {
    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-report-artifact"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-open-artifact"]')
        ?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Pane artifact');
    expect(document.body.textContent).toContain('10 B');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-report-updated-artifact"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('20 B');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-clear-artifacts"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Artifact not found.');
  });

  it('clears split pane artifact snapshots when switching sessions', async () => {
    const { container, rerender } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-report-artifact"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="split-open-artifact"]')
        ?.click();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Pane artifact');

    await act(async () => {
      mockConnection.sessionId = 'session-2';
      rerender();
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain('Pane artifact');
  });

  it('enters the split view from a ?split= URL and consumes the param', async () => {
    window.history.pushState({}, '', '/?split=s1,s2');
    try {
      const { container } = renderApp();
      await flush();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).not.toBeNull();
      // The one-shot param is stripped so a reload/exit doesn't force it back.
      expect(window.location.search).toBe('');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('lets controlled split session ids take precedence over a ?split= URL', async () => {
    window.history.pushState({}, '', '/?split=s1,s2');
    try {
      const { container } = renderApp({
        sidebar: false,
        splitSessionIds: ['s3'],
      });
      await flush();
      expect(
        container.querySelector('[data-testid="split-initial"]')?.textContent,
      ).toBe('s3');
      expect(window.location.search).toBe('');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('seeds the split from a ?split= URL, deduping and capping the explicit selection', async () => {
    // Duplicates and more than MAX_SPLIT_PANES (6) ids drive the explicit-
    // selection branch of openSplitView (dedupe + cap + replace), distinct from
    // the no-selection restore branch covered above.
    window.history.pushState({}, '', '/?split=s1,s1,s2,s3,s4,s5,s6,s7');
    try {
      const { container } = renderApp();
      await flush();
      expect(
        container.querySelector('[data-testid="split-initial"]')?.textContent,
      ).toBe('s1,s2,s3,s4,s5,s6');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('keeps the split view open when an approval becomes pending (unlike the scheduled-tasks page)', async () => {
    // Each split pane owns its own session's approval, so an approval on the
    // outer main session must NOT yank the user out of the split.
    const { container, rerender } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();
    // The outer session's approval overlay must NOT render behind the split —
    // otherwise its global keyboard shortcuts could confirm an unseen approval.
    expect(
      container.querySelector('[data-testid="approval-overlay"]'),
    ).toBeNull();
  });

  it('surfaces the outer approval as a split notice and returns to chat when clicked', async () => {
    // The overlay is suppressed under the split, so the outer approval would be
    // invisible; a notice banner (with a way back) is the only signal.
    const { container, rerender } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    const notice = container.querySelector(
      '[data-testid="split-approval-notice"]',
    );
    expect(notice).not.toBeNull();
    // Its button leaves the split (mainView -> 'chat') so the approval overlay,
    // which only renders in chat, becomes visible and actionable.
    await act(async () => {
      notice!
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
  });

  it('auto-closes the split view when the screen shrinks below the breakpoint', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });

    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-split-view"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    await act(async () => {
      large = false;
      changeHandler?.({ matches: false });
      await Promise.resolve();
    });
    // Shrinking below the large-screen breakpoint folds the split back to chat.
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
  });

  it('notifies controlled callers when a screen shrink closes the split view', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    const onSplitSessionIdsChange = vi.fn();

    const { container } = renderApp({
      sidebar: false,
      splitSessionIds: ['s1', 's2'],
      onSplitSessionIdsChange,
    });
    await flush();
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).not.toBeNull();

    await act(async () => {
      large = false;
      changeHandler?.({ matches: false });
      await Promise.resolve();
    });

    expect(onSplitSessionIdsChange).toHaveBeenCalledWith([]);
    expect(
      container.querySelector('[data-testid="split-view-page"]'),
    ).toBeNull();
  });

  it('folds the split without switching the chat session on shrink', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    mockConnection.sessionId = 'session-1';
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).not.toBeNull();

      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });

      // The split folds back to chat, but folding must leave the chat's own
      // connection untouched — switching sessions here would drop its session /
      // git-branch / URL context and break the lossless restore on regrow.
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();
      expect(mockSessionActions.loadSession).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('restores the split view when the screen grows back after a shrink', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).not.toBeNull();

      // Shrinking below the breakpoint folds the split away...
      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();

      // ...and growing back past it restores the same split (a transient resize
      // is lossless, not a permanent drop of the panes).
      await act(async () => {
        large = true;
        changeHandler?.({ matches: true });
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).not.toBeNull();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('auto-collapses the sidebar in a narrow split and expands it when wide', async () => {
    let wide = false;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          // Keep the large-screen (>=1024) query true so the split renders;
          // the >=1200 "sidebar has room" query is the one under test.
          if (query.includes('1200')) return wide;
          return query.includes('min-width');
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1200')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      const sidebar = () => container.querySelector('[data-testid="sidebar"]');
      // Narrow split (< 1200px): the sidebar collapses to free room for panes.
      expect(sidebar()?.getAttribute('data-collapsed')).toBe('true');

      // Grow past 1200px: the sidebar expands again.
      await act(async () => {
        wide = true;
        changeHandler?.({ matches: true });
        await Promise.resolve();
      });
      expect(sidebar()?.getAttribute('data-collapsed')).toBe('false');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('lands on the first pane, not an empty new chat, when a shrink closes a URL-driven split', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          // Capture the isLargeScreen (1024px) query specifically — not the
          // separate 1200px split-sidebar query — so flipping it drives the fold.
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    // The single chat has no session of its own — the split was entered from a
    // `?split=` deep link — so a naive close would strand on an empty new chat.
    mockConnection.sessionId = undefined;
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).not.toBeNull();

      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });

      // The split folds back to chat and re-attaches to the first pane's
      // session instead of stranding the user on an empty new chat.
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();
      expect(mockSessionActions.loadSession).toHaveBeenCalledWith('s1');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('keeps the chat on its own session (does not re-point to the first pane) when a shrink closes the split', async () => {
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });
    // This chat HAS a session of its own — folding must leave it (and its git
    // branch / URL) untouched rather than re-pointing at the split's first pane.
    mockConnection.sessionId = 'own-session';
    window.history.replaceState(null, '', '/?split=s1,s2');

    try {
      const { container } = renderApp();
      await flush();
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).not.toBeNull();
      mockSessionActions.loadSession.mockClear();

      await act(async () => {
        large = false;
        changeHandler?.({ matches: false });
        await Promise.resolve();
      });

      // Folded back to chat, but the guard kept the existing session — no
      // re-point to the first pane.
      expect(
        container.querySelector('[data-testid="split-view-page"]'),
      ).toBeNull();
      expect(mockSessionActions.loadSession).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('auto-closes the Session Overview when the screen shrinks below the breakpoint', async () => {
    // Drive isLargeScreen through a controllable media query: open the panel on
    // a large screen, then flip below the breakpoint and confirm it closes.
    let large = true;
    let changeHandler: ((event: { matches: boolean }) => void) | undefined;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        get matches() {
          return query.includes('min-width') ? large : false;
        },
        media: query,
        addEventListener: (
          _type: string,
          cb: (event: { matches: boolean }) => void,
        ) => {
          if (query.includes('1024')) changeHandler = cb;
        },
        removeEventListener: vi.fn(),
      })),
    });

    const { container } = renderApp();
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-sessions-overview"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    await act(async () => {
      large = false;
      changeHandler?.({ matches: false });
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('dismisses the Scheduled Tasks page when an approval becomes pending', async () => {
    // The scheduled-tasks fullPage overlay covers the chat footer where the
    // approval renders, so an approval must close it too (like the panel).
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/schedule';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="scheduled-tasks-page"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="scheduled-tasks-page"]'),
    ).toBeNull();
  });

  it('opening Daemon Status closes the Scheduled Tasks page (mutually exclusive full-pane views)', async () => {
    // Regression: both are full-pane views; the Scheduled Tasks fullPage is a
    // position:absolute overlay, so opening Daemon Status while it was up left
    // the panel rendered *behind* it — the button looked dead.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/schedule';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="scheduled-tasks-page"]'),
    ).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-daemon-status"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="scheduled-tasks-page"]'),
    ).toBeNull();
  });

  it('opening Scheduled Tasks closes an open Settings/Status panel', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    testState.prompt = '/schedule';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="scheduled-tasks-page"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('keeps the panel open when transcript blocks carry no actionable approval', async () => {
    // Negative control: a resolved permission is not actionable, so the panel
    // must stay put (guards against an unconditional "close on any block").
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock({ resolved: true })];
      rerender();
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
  });

  it('keeps the composer dormant (dialogOpen) while an approval overlay is up', async () => {
    // Regression: after the panel auto-closes for an approval, interactionBlocked
    // flips false. Unless dialogOpen also keys off the pending approval,
    // useComposerCore refocuses the composer and ToolApproval — which ignores
    // keys from editable targets — stops responding to its approval shortcuts.
    const { rerender } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.dialogOpen).toBe(false);

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });

    expect(testState.latestChatEditorProps?.dialogOpen).toBe(true);
  });

  it('dismisses an open sub-dialog (model picker) when an approval becomes pending', async () => {
    // A DialogShell sub-dialog left open would sit (backdrop) over the approval
    // overlay in the chat footer, hiding it — and, for the approval-mode picker,
    // let the user yolo-approve an unseen tool call. /model (no arg) opens the
    // picker; an approval must dismiss it.
    const { container, rerender } = renderApp();
    await flush();

    testState.prompt = '/model';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="dialog-shell"]'),
    ).not.toBeNull();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="dialog-shell"]')).toBeNull();
  });

  it('opens the Changes dialog for /diff and does not forward it to the agent', async () => {
    // /diff is intercepted locally — it opens the working-tree Changes dialog
    // rather than being forwarded to the daemon/agent as a prompt.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/diff';
    await clickSubmit(container);
    await flush();

    expect(
      container.querySelector('[data-testid="dialog-shell"]'),
    ).not.toBeNull();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('marks the approval overlay keyboard-active when it appears', async () => {
    // Focus itself is owned by ToolApproval/AskUserQuestion (covered by their
    // own tests); the app's job is to render the overlay and tell it to grab
    // focus (keyboardActive) once it's the topmost surface.
    const { rerender } = renderApp();
    await flush();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
    expect(testState.latestToolApprovalKeyboardActive).toBe(true);
  });

  it('marks the ask-user question overlay keyboard-active when it appears', async () => {
    // Symmetric to the ToolApproval case: guards against askUserOverlayVisible
    // being mis-derived (e.g. from pendingToolApproval) so the question overlay
    // would never pull focus.
    const { rerender } = renderApp();
    await flush();

    await act(async () => {
      testState.blocks = [
        makePendingPermissionBlock({ toolName: 'ask_user_question' }),
      ];
      rerender();
      await Promise.resolve();
    });

    expect(
      document.querySelector('[data-testid="approval-overlay"]'),
    ).not.toBeNull();
    expect(testState.latestAskUserQuestionKeyboardActive).toBe(true);
  });

  it('closes the panel on Escape from outside the sidebar', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    const panel = container.querySelector('[data-testid="inline-panel"]');
    expect(panel).not.toBeNull();

    await act(async () => {
      panel?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
  });

  it('keeps the panel open on Escape originating inside the sidebar', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    const sidebar = container.querySelector('[data-testid="sidebar"]');
    await act(async () => {
      sidebar?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
  });

  it('marks the composer dormant (dialogOpen) while a panel replaces the chat', async () => {
    const { container } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.dialogOpen).toBe(false);

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(testState.latestChatEditorProps?.dialogOpen).toBe(true);
  });

  it('blocks app-level shortcuts while an external modal is registered', async () => {
    const { container } = renderApp();
    await flush();
    expect(testState.latestChatEditorProps?.dialogOpen).toBe(false);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="interaction-blocker"]')
        ?.click();
      await Promise.resolve();
    });

    expect(testState.latestChatEditorProps?.dialogOpen).toBe(true);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          key: 'l',
        }),
      );
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          key: 'y',
        }),
      );
    });

    expect(mockStore.reset).not.toHaveBeenCalled();
    expect(mockStore.dispatch).not.toHaveBeenCalled();
  });

  it('restores composer focus after an approval resolves following a panel auto-close', async () => {
    // Regression: on panel auto-close the editor focus is intentionally skipped
    // (the approval owns the keyboard); when the approval later resolves with no
    // panel to return to, focus must come back to the composer rather than being
    // orphaned on <body>.
    const { container, rerender } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });
    editorFocus.mockClear();

    await act(async () => {
      testState.blocks = [];
      rerender();
      await Promise.resolve();
    });
    expect(editorFocus).toHaveBeenCalled();
  });

  it('closes the panel and restores composer focus on Back button click', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();
    editorFocus.mockClear();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="panel-back"]')
        ?.click();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
    expect(editorFocus).toHaveBeenCalled();
  });

  it('closes the panel, sends /model --fast, and reloads settings on fast-model pick', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    // Open the fast-model picker from Settings, then pick a model.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="open-fast-model"]')
        ?.click();
      await Promise.resolve();
    });
    expect(
      container.querySelector('[data-testid="dialog-shell"]'),
    ).not.toBeNull();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="model-select"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();

    expect(
      mockSessionActions.sendPrompt.mock.calls.some(
        // Workspace tab → the command carries the --project scope flag so the
        // fast-model choice persists to workspace settings, not the default.
        (c) => c[0] === '/model --fast fast-model-x --project',
      ),
    ).toBe(true);
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
    expect(settingsReload).toHaveBeenCalled();
  });

  it('sends /model --fast with --global when the fast-model picker is opened from the User tab', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-fast-model-user"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="model-select"]')
        ?.click();
      await Promise.resolve();
    });
    await flush();

    expect(
      mockSessionActions.sendPrompt.mock.calls.some(
        (c) => c[0] === '/model --fast fast-model-x --global',
      ),
    ).toBe(true);
  });

  it('sends /language ui --project for a workspace-scoped language change from Settings', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="change-language-workspace"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await flush();

    expect(
      mockSessionActions.sendPrompt.mock.calls.some(
        (c) => c[0] === '/language ui en --project',
      ),
    ).toBe(true);
  });

  it('marks the chat view aria-hidden while a panel is shown', async () => {
    const { container } = renderApp();
    await flush();
    expect(
      container
        .querySelector('[data-testid="submit"]')
        ?.closest('[aria-hidden="true"]'),
    ).toBeNull();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container
        .querySelector('[data-testid="submit"]')
        ?.closest('[aria-hidden="true"]'),
    ).not.toBeNull();
  });

  it('closes an open panel when resuming a session via /resume', async () => {
    // Resuming a session must surface that chat, not leave it hidden behind an
    // open Settings/Status panel — mirrors createNewSession / loadSidebarSession.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/settings';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="inline-panel"]'),
    ).not.toBeNull();

    testState.prompt = '/resume session-2';
    await clickSubmit(container);
    await flush();

    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
    expect(mockSessionActions.loadSession).toHaveBeenCalledWith('session-2');
  });

  it('dispatches rename only after the current session name changes', async () => {
    const onSessionChange = vi.fn();
    const { rerender } = renderApp({ onSessionChange });
    await flush();

    expect(onSessionChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'rename' }),
    );

    act(() => {
      mockConnection.displayName = 'Renamed Session';
      rerender({ onSessionChange });
    });

    expect(onSessionChange).toHaveBeenCalledWith({
      type: 'rename',
      sessionId: 'session-1',
      newName: 'Renamed Session',
    });

    onSessionChange.mockClear();
    act(() => {
      rerender({ onSessionChange });
    });
    expect(onSessionChange).not.toHaveBeenCalled();
  });
});

describe('App /goal command', () => {
  it('opens the Goals page for a bare /goal instead of sending a prompt', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    expect(
      container.querySelector('[data-testid="goals-page"]'),
    ).not.toBeNull();
    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });

  it('opens the Goals page for a bare /goal even while a turn is running', async () => {
    const { container, rerender } = renderApp();
    await flush();
    act(() => {
      testState.streamingState = 'responding';
      rerender({});
    });

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    expect(
      container.querySelector('[data-testid="goals-page"]'),
    ).not.toBeNull();
    expect(rawEnqueuePrompt).not.toHaveBeenCalled();
  });

  it('still sends /goal <condition> as a prompt rather than opening the page', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal ship it';
    await clickSubmit(container);
    await flush();

    expect(container.querySelector('[data-testid="goals-page"]')).toBeNull();
    expect(mockSessionActions.sendPrompt).toHaveBeenCalled();
  });

  it('still routes /goal clear through the daemon clear path', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal clear';
    await clickSubmit(container);
    await flush();

    expect(container.querySelector('[data-testid="goals-page"]')).toBeNull();
    expect(mockSessionActions.clearGoal).toHaveBeenCalled();
  });

  it('starts a goal in a fresh session from the Goals page', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');
    mockSessionActions.clearSession.mockClear();
    mockSessionActions.sendPrompt.mockClear();

    await act(async () => {
      await onCreateGoal('all tests pass');
    });

    // A goal takes over its session's turns, so it starts in a NEW one
    // (clearSession is how createNewSession starts one) rather than hijacking
    // the conversation the user was already having.
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.sendPrompt).toHaveBeenCalledWith(
      '/goal all tests pass',
      expect.anything(),
    );
  });

  it('keeps the Goals page mounted across createNewSession, not just after it', async () => {
    // `createNewSession` switches to the chat view itself, before any await. That
    // silently defeated the deferred switch below: by the time `sendPrompt`
    // rejected, the Goals page — and the form that renders the error — was already
    // gone, dumping the user in an empty chat with no explanation. The handler
    // passes `keepView` so the page survives until the prompt is admitted.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');
    mockSessionActions.sendPrompt.mockRejectedValueOnce(
      new Error('daemon says no'),
    );

    await act(async () => {
      await expect(onCreateGoal('all tests pass')).rejects.toThrow(
        'daemon says no',
      );
    });

    // createNewSession ran (a fresh session was started) …
    expect(mockSessionActions.clearSession).toHaveBeenCalled();
    // … and the Goals page is STILL up, so the rejection has somewhere to land.
    expect(
      container.querySelector('[data-testid="goals-page"]'),
    ).not.toBeNull();
  });

  it('keeps the Goals page open when the goal prompt is rejected', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');
    mockSessionActions.sendPrompt.mockRejectedValueOnce(
      new Error('daemon says no'),
    );

    await act(async () => {
      await expect(onCreateGoal('all tests pass')).rejects.toThrow(
        'daemon says no',
      );
    });

    // Switching to the chat first would unmount the page, leaving the rejection
    // with nowhere to render: the user would land in an empty session with no
    // explanation.
    expect(
      container.querySelector('[data-testid="goals-page"]'),
    ).not.toBeNull();
  });

  it('switches to the chat view only after the goal prompt is admitted', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');

    await act(async () => {
      await onCreateGoal('all tests pass');
    });

    expect(container.querySelector('[data-testid="goals-page"]')).toBeNull();
  });

  it("opens a goal's session in the chat view", async () => {
    // The goal's session transcript IS its history, so the Goals page has to be
    // able to hand off to it. Nothing exercised this wiring before.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();
    expect(
      container.querySelector('[data-testid="goals-page"]'),
    ).not.toBeNull();

    const onOpenSession = testState.latestGoalsProps?.onOpenSession;
    if (!onOpenSession) throw new Error('onOpenSession was not captured');
    mockSessionActions.loadSession.mockClear();

    await act(async () => {
      onOpenSession('goal-session-9');
    });
    await flush();

    // Pin the session id, not the options bag — main added a `{ workspaceCwd }`
    // second argument and will likely keep evolving it; the id is what this test
    // is about.
    expect(mockSessionActions.loadSession.mock.calls[0][0]).toBe(
      'goal-session-9',
    );
    // It must leave the Goals page, or the user loads a transcript they cannot see.
    expect(container.querySelector('[data-testid="goals-page"]')).toBeNull();
  });

  it("reports a failure to open a goal's session instead of swallowing it", async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onOpenSession = testState.latestGoalsProps?.onOpenSession;
    if (!onOpenSession) throw new Error('onOpenSession was not captured');
    mockSessionActions.loadSession.mockRejectedValueOnce(
      new Error('session is gone'),
    );
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await act(async () => {
      onOpenSession('goal-session-9');
    });
    await flush();

    // `loadSidebarSession` rethrows, so the handler's own `.catch` is the only
    // thing standing between a dead session and an unhandled rejection. It has
    // to route the failure to `reportError` (console + toast), not swallow it.
    expect(consoleError).toHaveBeenCalledWith(
      '[web-shell]',
      expect.stringContaining('session is gone'),
      expect.anything(),
    );
    consoleError.mockRestore();
  });

  it('reuses the empty session a failed goal attempt left behind', async () => {
    // `sendPrompt` creates the daemon session lazily, so a prompt that fails
    // after admission leaves a created-but-empty session. The form keeps the
    // condition and invites a retry; if that retry started ANOTHER new session,
    // every failed attempt would strand a blank chat in the sidebar.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');

    mockSessionActions.clearSession.mockClear();
    mockSessionActions.sendPrompt.mockRejectedValueOnce(
      new Error('daemon says no'),
    );

    await act(async () => {
      await expect(onCreateGoal('all tests pass')).rejects.toThrow(
        'daemon says no',
      );
    });
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);

    // Retry: the session from the failed attempt is still current and empty, so
    // it is reused rather than abandoned. No second clearSession.
    await act(async () => {
      await onCreateGoal('all tests pass');
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    expect(mockSessionActions.sendPrompt).toHaveBeenLastCalledWith(
      '/goal all tests pass',
      expect.anything(),
    );
  });

  it('forgets the stranded session once the user leaves the Goals page', async () => {
    // The stranded session is only a scratch session while the Goals page is
    // up. Leave, and the composer can talk to it — reusing it for a later goal
    // would drop the goal loop on top of a real conversation, which is the very
    // thing starting a fresh session exists to prevent.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');

    mockSessionActions.clearSession.mockClear();
    mockSessionActions.sendPrompt.mockRejectedValueOnce(
      new Error('daemon says no'),
    );
    await act(async () => {
      await expect(onCreateGoal('all tests pass')).rejects.toThrow(
        'daemon says no',
      );
    });
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);

    // Leave the Goals page via its Back button, then use the session from the
    // composer — it is now a real conversation, not a scratch session.
    const back = container.querySelector<HTMLButtonElement>(
      '[data-testid="goals-page"] button[aria-label="back"]',
    );
    if (!back) throw new Error('Back button not found');
    await act(async () => {
      back.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-testid="goals-page"]')).toBeNull();

    testState.prompt = 'hello from the composer';
    await clickSubmit(container);
    await flush();

    // Re-open Goals and set a goal: it must NOT reuse the session the user has
    // since been talking to.
    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoalAgain = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoalAgain) throw new Error('onCreateGoal was not captured');
    mockSessionActions.clearSession.mockClear();

    await act(async () => {
      await onCreateGoalAgain('all tests pass');
    });

    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh session again once a goal has actually been sent', async () => {
    // The reuse above is only for a session stranded by a failure. Once a goal
    // lands, that session belongs to it, and the next goal must not be dropped
    // on top of the running one.
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');

    mockSessionActions.clearSession.mockClear();
    mockSessionActions.sendPrompt.mockRejectedValueOnce(
      new Error('daemon says no'),
    );
    await act(async () => {
      await expect(onCreateGoal('first goal')).rejects.toThrow(
        'daemon says no',
      );
    });
    await act(async () => {
      await onCreateGoal('first goal');
    });
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);

    // A brand-new goal after a successful send: fresh session again.
    await act(async () => {
      await onCreateGoal('second goal');
    });
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(2);
  });

  it('does not drop the goal into the current session when the new session fails', async () => {
    const { container } = renderApp();
    await flush();

    testState.prompt = '/goal';
    await clickSubmit(container);
    await flush();

    const onCreateGoal = testState.latestGoalsProps?.onCreateGoal;
    if (!onCreateGoal) throw new Error('onCreateGoal was not captured');
    mockSessionActions.clearSession.mockRejectedValueOnce(
      new Error('daemon unreachable'),
    );
    mockSessionActions.sendPrompt.mockClear();

    await act(async () => {
      await onCreateGoal('all tests pass');
    });

    expect(mockSessionActions.sendPrompt).not.toHaveBeenCalled();
  });
});

describe('App manual-run orchestration (scheduled tasks)', () => {
  // Drives App's real runTaskManually / enqueueManualRun / tryFireBoundRun via
  // the onRunPrompt prop the (captured) ScheduledTasksDialog mock receives.
  // Opening the page with /schedule mounts the dialog and captures the handler.
  async function openRunHandler(
    container: HTMLElement,
  ): Promise<(prompt: string, sessionId: string | null) => Promise<void>> {
    testState.prompt = '/schedule';
    await clickSubmit(container);
    await flush();
    const handler = testState.latestScheduledTasksProps?.onRunPrompt;
    if (!handler) throw new Error('onRunPrompt was not captured');
    return handler;
  }

  // Make sendPrompt admit the prompt (fire onAdmitted) then resolve, the normal
  // "daemon accepted it" path.
  const admitOnSend = () =>
    mockSessionActions.sendPrompt.mockImplementation(
      (_text: string, opts?: { onAdmitted?: () => void }) => {
        opts?.onAdmitted?.();
        return Promise.resolve(undefined);
      },
    );

  it('resolves an unbound run once the daemon admits the prompt', async () => {
    admitOnSend();
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    await act(async () => {
      await expect(run('do the thing', null)).resolves.toBeUndefined();
    });
  });

  it('rejects an unbound run that settles without admitting (cancel path)', async () => {
    // Default sendPrompt resolves WITHOUT onAdmitted → onSubmitBefore cancel /
    // never reached the session: the caller must skip recording a run.
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    await act(async () => {
      await expect(run('do the thing', null)).rejects.toThrow(
        /cancelled before it started/,
      );
    });
  });

  it('rejects an unbound run when the send throws before admission', async () => {
    mockSessionActions.sendPrompt.mockRejectedValue(new Error('daemon boom'));
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    await act(async () => {
      await expect(run('do the thing', null)).rejects.toThrow('daemon boom');
    });
  });

  it('fires a bound run immediately when its session is already active', async () => {
    admitOnSend();
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    // session-1 is the current, fully-loaded session, so tryFireBoundRun fires
    // right after loadSidebarSession without waiting on a dep-change effect.
    await act(async () => {
      await expect(run('do the thing', 'session-1')).resolves.toBeUndefined();
    });
    expect(mockSessionActions.loadSession).toHaveBeenCalledWith('session-1', {
      workspaceCwd: undefined,
    });
  });

  it('supersedes an older pending bound run with a newer one', async () => {
    // Neither target is the active session, so both stay latched; the second
    // must reject the first so its caller does not record a dropped run.
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    vi.useFakeTimers();
    let firstErr: unknown;
    let second: Promise<void> | undefined;
    await act(async () => {
      void run('first', 'sess-A').catch((e) => {
        firstErr = e;
      });
      second = run('second', 'sess-B').catch(() => {});
      await Promise.resolve();
    });
    expect((firstErr as Error | undefined)?.message).toMatch(/superseded/);
    vi.clearAllTimers();
    void second;
  });

  it('rejects a bound run when the session switch times out', async () => {
    const { container } = renderApp();
    await flush();
    const run = await openRunHandler(container);
    vi.useFakeTimers();
    let err: unknown;
    await act(async () => {
      void run('do the thing', 'never-active').catch((e) => {
        err = e;
      });
      await Promise.resolve(); // loadSidebarSession resolves; no fire (not current)
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect((err as Error | undefined)?.message).toMatch(/Timed out switching/);
  });

  it('"create via chat" starts a fresh session and primes the composer', async () => {
    const { container } = renderApp();
    await flush();
    testState.prompt = '/schedule';
    await clickSubmit(container);
    await flush();
    const onCreateViaChat =
      testState.latestScheduledTasksProps?.onCreateViaChat;
    if (!onCreateViaChat) throw new Error('onCreateViaChat was not captured');
    mockSessionActions.clearSession.mockClear();
    editorInsertText.mockClear();
    await act(async () => {
      onCreateViaChat();
    });
    await flush();
    // Jumps to a NEW session (clearSession is how createNewSession starts one)
    // rather than piling the task-creation chat onto the current conversation.
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1);
    // ...then primes the composer with the task starter (deferred one tick).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(editorInsertText).toHaveBeenCalled();
  });

  it('"create via chat" does NOT prime the composer when the new session fails', async () => {
    // If createNewSession() fails, the error is already surfaced — priming the
    // (still-current) session would drop the task starter into the wrong chat.
    const { container } = renderApp();
    await flush();
    testState.prompt = '/schedule';
    await clickSubmit(container);
    await flush();
    const onCreateViaChat =
      testState.latestScheduledTasksProps?.onCreateViaChat;
    if (!onCreateViaChat) throw new Error('onCreateViaChat was not captured');
    mockSessionActions.clearSession.mockClear();
    mockSessionActions.clearSession.mockRejectedValueOnce(new Error('boom'));
    editorInsertText.mockClear();
    await act(async () => {
      onCreateViaChat();
    });
    await flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockSessionActions.clearSession).toHaveBeenCalledTimes(1); // attempted
    expect(editorInsertText).not.toHaveBeenCalled(); // but priming skipped
  });
});
