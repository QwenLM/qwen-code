// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type StreamingState = 'idle' | 'responding';

type MockConnection = {
  status: 'connected';
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
};

type ChatEditorTestProps = {
  onSubmit: (
    text: string,
    images?: undefined,
    commitAccepted?: () => void,
  ) => boolean | void;
  isPreparing?: boolean;
};

const {
  mockConnection,
  mockSessionActions,
  mockWorkspaceActions,
  mockStore,
  mockFollowup,
  testState,
  sidebarTokens,
  rawEnqueuePrompt,
  editorClear,
  editorCommit,
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
  return {
    mockConnection: connection,
    mockSessionActions: {
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
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
      streamingState: 'idle' as StreamingState,
      blocks: [] as unknown[],
      latestChatEditorProps: null as ChatEditorTestProps | null,
    },
    sidebarTokens: [] as Array<number | undefined>,
    rawEnqueuePrompt: vi.fn(() => true),
    editorClear: vi.fn(),
    editorCommit: vi.fn(),
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
  useSettings: () => ({
    settings: [],
    setValue: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn().mockResolvedValue(undefined),
    loading: false,
  }),
  useStreamingState: () => testState.streamingState,
  useTranscriptBlocks: () => testState.blocks,
  useTranscriptStore: () => mockStore,
  useWorkspaceActions: () => mockWorkspaceActions,
  useWorkspaceEventSignals: () => ({ extensionsVersion: 0 }),
}));

vi.mock('@qwen-code/sdk/daemon', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/sdk/daemon')>()),
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
      }>,
    ) {
      testState.latestChatEditorProps = props;
      React.useImperativeHandle(ref, () => ({
        clear: editorClear,
        insertText: vi.fn(),
      }));
      return React.createElement(
        'button',
        {
          'data-testid': 'submit',
          'data-preparing': props.isPreparing ? 'true' : 'false',
          onClick: () =>
            props.onSubmit(testState.prompt, undefined, editorCommit),
          type: 'button',
        },
        'submit',
      );
    }),
  };
});

vi.mock('./components/MessageList', async () => {
  const React = await import('react');
  return {
    MessageList: React.forwardRef(function MessageList(
      props: { showRetryHint?: boolean; onRetryClick?: () => void },
      ref: React.ForwardedRef<{ scrollToBottom: () => void }>,
    ) {
      React.useImperativeHandle(ref, () => ({ scrollToBottom: vi.fn() }));
      return React.createElement(
        'div',
        { 'data-testid': 'messages' },
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

vi.mock('./components/sidebar/WebShellSidebar', async () => {
  const React = await import('react');
  return {
    WebShellSidebar: (props: { sessionListReloadToken?: number }) => {
      sidebarTokens.push(props.sessionListReloadToken);
      return React.createElement('div', { 'data-testid': 'sidebar' });
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
mockComponent('./components/dialogs/DialogShell', 'DialogShell');
mockComponent('./components/dialogs/ModelDialog', 'ModelDialog');
mockComponent('./components/dialogs/ToolsDialog', 'ToolsDialog');
mockComponent('./components/dialogs/DaemonStatusDialog', 'DaemonStatusDialog');
mockComponent('./components/dialogs/ExtensionsDialog', 'ExtensionsDialog');
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
mockComponent('./components/messages/SettingsMessage', 'SettingsMessage');
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
  mounted.push({ root, container });
  return { container, rerender: doRender };
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
    value: vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  mockConnection.sessionId = 'session-1';
  mockConnection.displayName = 'Session One';
  mockConnection.loadingTranscript = false;
  mockConnection.catchingUp = false;
  testState.prompt = 'hello';
  testState.streamingState = 'idle';
  testState.blocks = [];
  testState.latestChatEditorProps = null;
  sidebarTokens.length = 0;
  rawEnqueuePrompt.mockClear();
  editorClear.mockClear();
  editorCommit.mockClear();
  mockFollowup.clear.mockClear();
  for (const value of Object.values(mockSessionActions)) {
    if (typeof value === 'function' && 'mockClear' in value) value.mockClear();
  }
  mockSessionActions.sendPrompt.mockResolvedValue(undefined);
  mockSessionActions.createSession.mockResolvedValue({
    sessionId: 'session-1',
  });
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
    expect(container.querySelector('[data-testid="inline-panel"]')).not.toBeNull();

    // A gated tool call arrives.
    await act(async () => {
      testState.blocks = [makePendingPermissionBlock()];
      rerender();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="inline-panel"]')).toBeNull();
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
    expect(container.querySelector('[data-testid="inline-panel"]')).not.toBeNull();

    await act(async () => {
      testState.blocks = [
        makePendingPermissionBlock({ toolName: 'ask_user_question' }),
      ];
      rerender();
      await Promise.resolve();
    });

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
    expect(container.querySelector('[data-testid="inline-panel"]')).not.toBeNull();

    await act(async () => {
      testState.blocks = [makePendingPermissionBlock({ resolved: true })];
      rerender();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="inline-panel"]')).not.toBeNull();
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
