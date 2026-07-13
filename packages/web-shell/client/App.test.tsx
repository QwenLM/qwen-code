// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonInputAnnotation } from '@qwen-code/sdk/daemon';
import type { WebShellApi } from './App';

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
    images?: undefined,
    commitAccepted?: () => void,
    metadata?: { inputAnnotations?: DaemonInputAnnotation[] },
  ) => boolean | void;
  skills?: Array<{ name: string; description: string }>;
  isPreparing?: boolean;
  dialogOpen?: boolean;
  placeholderText?: string;
};

const {
  mockConnection,
  mockSessionActions,
  mockWorkspace,
  mockWorkspaceActions,
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
    capabilities: { qwenCodeVersion: '1.2.3', features: [] },
    loadingTranscript: false,
    catchingUp: false,
  };
  const workspaceClient = {
    workspaceByCwd: vi.fn(() => ({
      workspaceGit: vi.fn().mockResolvedValue({ branch: 'main' }),
    })),
  };
  return {
    mockConnection: connection,
    mockSessionActions: {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
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
    },
    mockWorkspace: {
      capabilities: {
        workspaces: [{ id: 'primary', cwd: '/workspace', primary: true }],
      },
      client: workspaceClient,
    },
    mockWorkspaceActions: {
      loadSkillsStatus: vi.fn().mockResolvedValue({ skills: [] }),
      loadProviders: vi.fn().mockResolvedValue({ current: null }),
      loadPreflight: vi.fn().mockResolvedValue(null),
      loadEnv: vi.fn().mockResolvedValue(null),
      loadMcpStatus: vi.fn().mockResolvedValue({ servers: [] }),
      loadMcpTools: vi.fn().mockResolvedValue([]),
      loadMcpResources: vi.fn().mockResolvedValue([]),
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
      streamingState: 'idle' as StreamingState,
      blocks: [] as unknown[],
      latestChatEditorProps: null as ChatEditorTestProps | null,
      latestScheduledTasksProps: null as {
        onRunPrompt?: (
          prompt: string,
          sessionId: string | null,
        ) => Promise<void>;
        onCreateViaChat?: () => void;
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
  useStreamingState: () => testState.streamingState,
  useTranscriptBlocks: () => testState.blocks,
  useTranscriptStore: () => mockStore,
  useWorkspace: () => mockWorkspace,
  useWorkspaceActions: () => mockWorkspaceActions,
  useWorkspaceEventSignals: () => ({
    artifactsVersion: 0,
    extensionsVersion: 0,
  }),
}));

vi.mock('@qwen-code/sdk/daemon', () => ({
  DAEMON_GOAL_STATUS_SENTINEL_PREFIX: 'qwen-goal-status:',
  isDaemonTurnError: () => false,
}));

vi.mock('./hooks/useMessages', () => ({
  useMessages: () => [],
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
        insertText: (text: string) => void;
        focus: () => void;
      }>,
    ) {
      testState.latestChatEditorProps = props;
      React.useImperativeHandle(ref, () => ({
        clear: editorClear,
        insertText: editorInsertText,
        // The panel focus effect calls editorRef.current?.focus() when a panel
        // closes with no pending approval (e.g. resuming a session).
        focus: editorFocus,
      }));
      return React.createElement(
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
      props: { showRetryHint?: boolean; onRetryClick?: () => void },
      ref: React.ForwardedRef<{ scrollToBottom: () => void }>,
    ) {
      React.useImperativeHandle(ref, () => ({ scrollToBottom: vi.fn() }));
      return React.createElement(
        'div',
        { 'data-testid': 'messages' },
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
    SettingsMessage: (props: { onSubDialog?: (key: string) => void }) =>
      React.createElement(
        'div',
        { 'data-testid': 'settings-message' },
        React.createElement(
          'button',
          {
            'data-testid': 'open-fast-model',
            type: 'button',
            onClick: () => props.onSubDialog?.('fastModel'),
          },
          'fast model',
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
      onOpenDaemonStatus?: () => void;
      onOpenSessions?: () => void;
      onOpenSplitView?: () => void;
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
    }) => {
      testState.latestScheduledTasksProps = props;
      return React.createElement('div');
    },
  };
});
vi.doMock('./components/extensions/ExtensionsManagerPage', async () => {
  const React = await import('react');
  return {
    ExtensionsManagerPage: () =>
      React.createElement('div', {
        'data-testid': 'extensions-manager-page',
      }),
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
mockComponent('./components/dialogs/McpDialog', 'McpDialog');
mockComponent('./components/messages/AgentsMessage', 'AgentsMessage');
mockComponent('./components/messages/MemoryMessage', 'MemoryMessage');
mockComponent('./components/messages/AuthMessage', 'AuthMessage');
mockComponent('./components/messages/ToolApproval', 'ToolApproval');
mockComponent('./components/messages/AskUserQuestion', 'AskUserQuestion');
mockComponent('./components/messages/TasksStatusMessage', 'TasksStatusMessage');
mockComponent('./components/messages/BtwMessage', 'BtwMessage');
mockComponent('./components/QueuedPromptDisplay', 'QueuedPromptDisplay');

const { App } = await import('./App');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

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
  mockConnection.status = 'connected';
  mockConnection.displayName = 'Session One';
  mockConnection.error = undefined;
  mockConnection.errorStatus = undefined;
  mockConnection.missingSession = false;
  mockConnection.loadingTranscript = false;
  mockConnection.catchingUp = false;
  testState.prompt = 'hello';
  testState.inputAnnotations = undefined;
  testState.streamingState = 'idle';
  testState.blocks = [];
  testState.latestChatEditorProps = null;
  testState.latestScheduledTasksProps = null;
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

    expect(container.textContent).toContain('Pane artifact');
    expect(container.textContent).toContain('10 B');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-report-updated-artifact"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('20 B');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="split-clear-artifacts"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain('Artifact not found.');
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

    expect(container.textContent).toContain('Pane artifact');

    await act(async () => {
      mockConnection.sessionId = 'session-2';
      rerender();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Pane artifact');
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

  it('moves focus to the approval overlay when it appears', async () => {
    const { rerender } = renderApp();
    await flush();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });

    const overlay = document.querySelector('[data-testid="approval-overlay"]');
    expect(overlay).not.toBeNull();
    expect(document.activeElement).toBe(overlay);
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
        (c) => c[0] === '/model --fast fast-model-x',
      ),
    ).toBe(true);
    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
    expect(settingsReload).toHaveBeenCalled();
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
