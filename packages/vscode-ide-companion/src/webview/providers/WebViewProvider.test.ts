/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockConfigChangeHandlers,
  availableCommandsCallbackRef,
  mockCreateImagePathResolver,
  mockConfigGet,
  mockConfigUpdate,
  mockGetGlobalTempDir,
  mockGetPanel,
  mockMessageHandlerInstances,
  mockOnDidChangeConfiguration,
  mockOnDidChangeActiveTextEditor,
  mockOnDidChangeTextEditorSelection,
  mockOpenExternal,
  mockReadQwenSettingsForVSCode,
  mockWriteCodingPlanConfig,
  mockWriteModelProvidersConfig,
  mockClearPersistedAuth,
  slashCommandNotificationCallbackRef,
  endTurnCallbackRef,
  streamChunkCallbackRef,
  permissionRequestCallbackRef,
  askUserQuestionCallbackRef,
  mockShowInformationMessage,
  mockWindowState,
  mockQwenAgentManagerInstances,
} = vi.hoisted(() => ({
  mockConfigChangeHandlers: [] as Array<
    (event: { affectsConfiguration: (section: string) => boolean }) => unknown
  >,
  availableCommandsCallbackRef: {
    current: undefined as
      | ((commands: Array<{ name: string; description?: string }>) => void)
      | undefined,
  },
  mockCreateImagePathResolver: vi.fn(),
  mockConfigGet: vi.fn(),
  mockConfigUpdate: vi.fn(),
  mockGetGlobalTempDir: vi.fn(() => '/global-temp'),
  mockGetPanel: vi.fn<() => { webview: { postMessage: unknown } } | null>(
    () => null,
  ),
  mockMessageHandlerInstances: [] as Array<{
    permissionHandler?: (message: {
      type: string;
      data: { optionId?: string };
    }) => void;
  }>,
  mockOnDidChangeConfiguration: vi.fn(
    (
      handler: (event: {
        affectsConfiguration: (section: string) => boolean;
      }) => unknown,
    ) => {
      mockConfigChangeHandlers.push(handler);
      return { dispose: vi.fn() };
    },
  ),
  mockOnDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  mockOnDidChangeTextEditorSelection: vi.fn(() => ({ dispose: vi.fn() })),
  mockOpenExternal: vi.fn(),
  mockReadQwenSettingsForVSCode: vi.fn<
    () => {
      provider: 'coding-plan' | 'api-key';
      apiKey: string;
      codingPlanRegion: 'china' | 'global';
    } | null
  >(() => null),
  mockWriteCodingPlanConfig: vi.fn(() => ({})),
  mockWriteModelProvidersConfig: vi.fn(),
  mockClearPersistedAuth: vi.fn(),
  slashCommandNotificationCallbackRef: {
    current: undefined as
      | ((event: {
          sessionId: string;
          command: string;
          messageType: 'info' | 'error';
          message: string;
        }) => void)
      | undefined,
  },
  endTurnCallbackRef: {
    current: undefined as ((reason?: string) => void) | undefined,
  },
  streamChunkCallbackRef: {
    current: undefined as ((chunk: string) => void) | undefined,
  },
  permissionRequestCallbackRef: {
    current: undefined as ((request: unknown) => Promise<string>) | undefined,
  },
  askUserQuestionCallbackRef: {
    current: undefined as
      | ((request: unknown) => Promise<{ optionId: string }>)
      | undefined,
  },
  mockShowInformationMessage: vi.fn<
    (message: string, ...items: string[]) => Thenable<string | undefined>
  >(() => Promise.resolve(undefined)),
  mockWindowState: { focused: true },
  mockQwenAgentManagerInstances: [] as Array<{
    permissionRequestCallback?: (request: unknown) => Promise<string>;
    cancelCurrentPrompt: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('@qwen-code/qwen-code-core', async () => {
  const actual = await vi.importActual<
    typeof import('@qwen-code/qwen-code-core')
  >('@qwen-code/qwen-code-core');
  return {
    ...actual,
    Storage: {
      getGlobalTempDir: mockGetGlobalTempDir,
    },
  };
});

vi.mock('vscode', () => ({
  ConfigurationTarget: {
    Global: 'global',
  },
  Uri: {
    joinPath: vi.fn((base: { fsPath?: string }, ...parts: string[]) => ({
      fsPath: `${base.fsPath ?? ''}/${parts.join('/')}`.replace(/\/+/g, '/'),
    })),
    file: vi.fn((filePath: string) => ({ fsPath: filePath })),
  },
  env: {
    openExternal: mockOpenExternal,
  },
  window: {
    onDidChangeActiveTextEditor: mockOnDidChangeActiveTextEditor,
    onDidChangeTextEditorSelection: mockOnDidChangeTextEditorSelection,
    activeTextEditor: undefined,
    showInformationMessage: mockShowInformationMessage,
    state: mockWindowState,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace-root' } }],
    onDidChangeConfiguration: mockOnDidChangeConfiguration,
    getConfiguration: vi.fn(() => ({
      get: mockConfigGet,
      update: mockConfigUpdate,
    })),
  },
  commands: {
    executeCommand: vi.fn(),
  },
}));

vi.mock('../../services/settingsWriter.js', () => ({
  writeCodingPlanConfig: mockWriteCodingPlanConfig,
  writeModelProvidersConfig: mockWriteModelProvidersConfig,
  readQwenSettingsForVSCode: mockReadQwenSettingsForVSCode,
  clearPersistedAuth: mockClearPersistedAuth,
}));

vi.mock('../../services/qwenAgentManager.js', () => ({
  QwenAgentManager: class {
    isConnected = false;
    currentSessionId = null;
    connect = vi.fn();
    createNewSession = vi.fn();
    setModelFromUi = vi.fn();
    onMessage = vi.fn();
    onStreamChunk = vi.fn((cb: (chunk: string) => void) => {
      streamChunkCallbackRef.current = cb;
    });
    onThoughtChunk = vi.fn();
    onModeInfo = vi.fn();
    onModeChanged = vi.fn();
    onUsageUpdate = vi.fn();
    onModelInfo = vi.fn();
    onModelChanged = vi.fn();
    onAvailableCommands = vi.fn(
      (
        callback: (
          commands: Array<{ name: string; description?: string }>,
        ) => void,
      ) => {
        availableCommandsCallbackRef.current = callback;
      },
    );
    onAvailableSkills = vi.fn();
    onAvailableModels = vi.fn();
    onSlashCommandNotification = vi.fn(
      (
        callback: (event: {
          sessionId: string;
          command: string;
          messageType: 'info' | 'error';
          message: string;
        }) => void,
      ) => {
        slashCommandNotificationCallbackRef.current = callback;
      },
    );
    onEndTurn = vi.fn((cb: (reason?: string) => void) => {
      endTurnCallbackRef.current = cb;
    });
    onToolCall = vi.fn();
    onPlan = vi.fn();
    onPermissionRequest = vi.fn(
      (callback: (request: unknown) => Promise<string>) => {
        this.permissionRequestCallback = callback;
        permissionRequestCallbackRef.current = callback;
      },
    );
    onAskUserQuestion = vi.fn(
      (callback: (request: unknown) => Promise<{ optionId: string }>) => {
        askUserQuestionCallbackRef.current = callback;
      },
    );
    onDisconnected = vi.fn();
    permissionRequestCallback?: (request: unknown) => Promise<string>;
    cancelCurrentPrompt = vi.fn();
    disconnect = vi.fn();
    constructor() {
      mockQwenAgentManagerInstances.push(this);
    }
  },
}));

vi.mock('../../services/conversationStore.js', () => ({
  ConversationStore: class {
    constructor(_context: unknown) {}
    createConversation = vi.fn().mockResolvedValue({
      id: 'conversation-1',
      messages: [],
    });
  },
}));

vi.mock('./PanelManager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./PanelManager.js')>();

  return {
    ...actual,
    PanelManager: class {
      constructor(_extensionUri: unknown, _onPanelDispose: () => void) {}
      getPanel() {
        return mockGetPanel();
      }
      setPanel = vi.fn();
    },
  };
});

vi.mock('./MessageHandler.js', () => ({
  MessageHandler: class {
    constructor(
      _agentManager: unknown,
      _conversationStore: unknown,
      _currentConversationId: string | null,
      _sendToWebView: (message: unknown) => void,
    ) {
      mockMessageHandlerInstances.push(this);
    }
    setAuthInteractiveHandler = vi.fn();
    permissionHandler?: (message: {
      type: string;
      data: { optionId?: string };
    }) => void;
    setPermissionHandler = vi.fn(
      (
        handler: (message: {
          type: string;
          data: { optionId?: string };
        }) => void,
      ) => {
        this.permissionHandler = handler;
      },
    );
    setAskUserQuestionHandler = vi.fn();
    setCurrentConversationId = vi.fn();
    getCurrentConversationId = vi.fn(() => null);
    setupFileWatchers = vi.fn(() => ({ dispose: vi.fn() }));
    appendStreamContent = vi.fn();
    route = vi.fn();
  },
}));

vi.mock('./WebViewContent.js', () => ({
  WebViewContent: {
    generate: vi.fn(() => '<html />'),
  },
}));

vi.mock('../utils/imageHandler.js', () => ({
  createImagePathResolver: mockCreateImagePathResolver,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    exec: vi.fn((_cmd: string, cb?: (err: Error | null) => void) => {
      cb?.(null);
    }),
    execFile: vi.fn(
      (_file: string, _args?: string[], cb?: (err: Error | null) => void) => {
        if (typeof _args === 'function') {
          (_args as unknown as (err: Error | null) => void)(null);
        } else {
          cb?.(null);
        }
      },
    ),
  };
});

vi.mock('../../utils/authErrors.js', () => ({
  isAuthenticationRequiredError: vi.fn(() => false),
}));

vi.mock('../../utils/errorMessage.js', () => ({
  getErrorMessage: vi.fn((error: unknown) => String(error)),
}));

import { WebViewProvider } from './WebViewProvider.js';
import {
  truncatePanelTitle,
  MAX_PANEL_TITLE_LENGTH,
} from '../utils/panelTitleUtils.js';

const createConfigChangeEvent = (...affectedSections: string[]) => ({
  affectsConfiguration: (section: string) => affectedSections.includes(section),
});

type WebViewMessageHandler = (message: {
  type: string;
  data?: unknown;
}) => Promise<void>;

/**
 * Create a mock webview + provider and attach them.
 * If `captureMessageHandler` is true, the `onDidReceiveMessage` handler is
 * captured and returned so the test can simulate messages from the webview.
 */
async function setupAttachedProvider(options?: {
  captureMessageHandler?: boolean;
}) {
  let messageHandler: WebViewMessageHandler | undefined;

  const postMessage = vi.fn();
  const webview = {
    options: undefined as unknown,
    html: '',
    postMessage,
    asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
      toString: () => `webview:${uri.fsPath}`,
    })),
    onDidReceiveMessage: vi.fn((handler: WebViewMessageHandler) => {
      if (options?.captureMessageHandler) {
        messageHandler = handler;
      } else {
        void handler;
      }
      return { dispose: vi.fn() };
    }),
  };

  const provider = new WebViewProvider(
    { subscriptions: [] } as never,
    { fsPath: '/extension-root' } as never,
  );

  await provider.attachToView(
    {
      webview,
      visible: true,
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    } as never,
    'qwen-code.chatView.sidebar',
  );

  return { webview, postMessage, provider, messageHandler };
}

beforeEach(() => {
  mockConfigChangeHandlers.length = 0;
  endTurnCallbackRef.current = undefined;
  streamChunkCallbackRef.current = undefined;
  permissionRequestCallbackRef.current = undefined;
  askUserQuestionCallbackRef.current = undefined;
  mockWindowState.focused = true;
  mockShowInformationMessage.mockReset();
  mockShowInformationMessage.mockReturnValue(Promise.resolve(undefined));
});

describe('WebViewProvider.attachToView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageHandlerInstances.length = 0;
    mockQwenAgentManagerInstances.length = 0;
    mockGetPanel.mockReturnValue(null);
    mockConfigGet.mockImplementation(
      (_key: string, defaultValue: unknown) => defaultValue,
    );
    availableCommandsCallbackRef.current = undefined;
    slashCommandNotificationCallbackRef.current = undefined;
    mockCreateImagePathResolver.mockReturnValue((paths: string[]) =>
      paths.map((entry) => ({
        path: entry,
        src: `webview:${entry}`,
      })),
    );
    vi.spyOn(
      WebViewProvider.prototype as unknown as {
        initializeAgentConnection: () => Promise<void>;
      },
      'initializeAgentConnection',
    ).mockResolvedValue(undefined);
  });

  it('configures sidebar views with workspace/temp roots and resolves image paths through the attached webview', async () => {
    let messageHandler:
      | ((message: { type: string; data?: unknown }) => Promise<void>)
      | undefined;

    const postMessage = vi.fn();
    const webview = {
      options: undefined as unknown,
      html: '',
      postMessage,
      asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
        toString: () => `webview:${uri.fsPath}`,
      })),
      onDidReceiveMessage: vi.fn(
        (
          handler: (message: { type: string; data?: unknown }) => Promise<void>,
        ) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        },
      ),
    };

    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );

    await provider.attachToView(
      {
        webview,
        visible: true,
        onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      } as never,
      'qwen-code.chatView.sidebar',
    );

    const roots = (
      webview.options as { localResourceRoots?: Array<{ fsPath: string }> }
    ).localResourceRoots;
    expect(roots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fsPath: '/extension-root/dist' }),
        expect.objectContaining({ fsPath: '/extension-root/assets' }),
        expect.objectContaining({ fsPath: '/global-temp' }),
        expect.objectContaining({ fsPath: '/workspace-root' }),
      ]),
    );

    expect(messageHandler).toBeTypeOf('function');

    await messageHandler?.({
      type: 'resolveImagePaths',
      data: { paths: ['clipboard/example.png'], requestId: 7 },
    });

    expect(mockCreateImagePathResolver).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoots: ['/workspace-root'],
        toWebviewUri: expect.any(Function),
      }),
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: 'imagePathsResolved',
      data: {
        resolved: [
          {
            path: 'clipboard/example.png',
            src: 'webview:clipboard/example.png',
          },
        ],
        requestId: 7,
      },
    });
  });

  it('streams slash-command notifications into the attached webview', async () => {
    const { postMessage } = await setupAttachedProvider();

    slashCommandNotificationCallbackRef.current?.({
      sessionId: 'session-1',
      command: '/summary',
      messageType: 'info',
      message: 'Generating project summary...',
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'streamChunk',
      data: {
        chunk: 'Generating project summary...\n',
      },
    });
  });

  it('re-sends cached available commands when the webview becomes ready', async () => {
    const { postMessage, messageHandler } = await setupAttachedProvider({
      captureMessageHandler: true,
    });

    availableCommandsCallbackRef.current?.([
      {
        name: 'insight',
        description: 'Generate personalized insights',
      },
    ]);
    postMessage.mockClear();

    await messageHandler?.({
      type: 'webviewReady',
      data: {},
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'availableCommands',
      data: {
        commands: [
          {
            name: 'insight',
            description: 'Generate personalized insights',
          },
        ],
      },
    });
  });

  it('does not special-case plain insight slash notifications in the provider', async () => {
    const { postMessage } = await setupAttachedProvider();

    slashCommandNotificationCallbackRef.current?.({
      sessionId: 'session-1',
      command: '/insight',
      messageType: 'info',
      message: 'Starting insight generation...',
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'streamChunk',
      data: {
        chunk: 'Starting insight generation...\n',
      },
    });
  });

  it('routes structured insight progress markers into the attached webview', async () => {
    const { postMessage } = await setupAttachedProvider();

    slashCommandNotificationCallbackRef.current?.({
      sessionId: 'session-1',
      command: '/insight',
      messageType: 'info',
      message:
        '{"insight_progress":{"stage":"Analyzing sessions","progress":42,"detail":"21/50"}}',
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'insightProgress',
      data: {
        stage: 'Analyzing sessions',
        progress: 42,
        detail: '21/50',
      },
    });
  });

  it('routes structured insight progress markers even when command text is normalized differently', async () => {
    const { postMessage } = await setupAttachedProvider();

    slashCommandNotificationCallbackRef.current?.({
      sessionId: 'session-1',
      command: 'insight',
      messageType: 'info',
      message:
        '{"insight_progress":{"stage":"Analyzing sessions","progress":42,"detail":"21/50"}}',
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'insightProgress',
      data: {
        stage: 'Analyzing sessions',
        progress: 42,
        detail: '21/50',
      },
    });
  });

  it('clears structured insight progress when the ready marker arrives', async () => {
    const { webview } = await setupAttachedProvider();

    slashCommandNotificationCallbackRef.current?.({
      sessionId: 'session-1',
      command: '/insight',
      messageType: 'info',
      message: '{"insight_ready":{"path":"/tmp/insight-report.html"}}',
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(webview.postMessage).toHaveBeenCalledWith({
      type: 'insightReportReady',
      data: {
        path: '/tmp/insight-report.html',
      },
    });
  });

  it('opens the insight report in the browser when requested from the webview', async () => {
    const { messageHandler } = await setupAttachedProvider({
      captureMessageHandler: true,
    });

    await messageHandler?.({
      type: 'openInsightReport',
      data: { path: '/tmp/insight-report.html' },
    });

    expect(mockOpenExternal).toHaveBeenCalledWith({
      fsPath: '/tmp/insight-report.html',
    });
  });

  it('routes resolved image paths back to the requesting attached webview even when a panel exists', async () => {
    let messageHandler:
      | ((message: { type: string; data?: unknown }) => Promise<void>)
      | undefined;

    const attachedPostMessage = vi.fn();
    const panelPostMessage = vi.fn();
    mockGetPanel.mockReturnValue({
      webview: {
        postMessage: panelPostMessage,
      },
    });

    const webview = {
      options: undefined as unknown,
      html: '',
      postMessage: attachedPostMessage,
      asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
        toString: () => `attached:${uri.fsPath}`,
      })),
      onDidReceiveMessage: vi.fn(
        (
          handler: (message: { type: string; data?: unknown }) => Promise<void>,
        ) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        },
      ),
    };

    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );

    await provider.attachToView(
      {
        webview,
        visible: true,
        onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      } as never,
      'qwen-code.chatView.sidebar',
    );

    await messageHandler?.({
      type: 'resolveImagePaths',
      data: { paths: ['/global-temp/clipboard/example.png'], requestId: 8 },
    });

    expect(attachedPostMessage).toHaveBeenCalledWith({
      type: 'imagePathsResolved',
      data: {
        resolved: [
          {
            path: '/global-temp/clipboard/example.png',
            src: 'webview:/global-temp/clipboard/example.png',
          },
        ],
        requestId: 8,
      },
    });
    expect(panelPostMessage).not.toHaveBeenCalled();
  });

  it('marks rejected switch_mode permission requests as failed without cancelling the session', async () => {
    const postMessage = vi.fn();
    const webview = {
      options: undefined as unknown,
      html: '',
      postMessage,
      asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
        toString: () => `webview:${uri.fsPath}`,
      })),
      onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    };

    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );

    await provider.attachToView(
      {
        webview,
        visible: true,
        onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      } as never,
      'qwen-code.chatView.sidebar',
    );

    const agentManager = mockQwenAgentManagerInstances.at(-1);
    const messageHandler = mockMessageHandlerInstances.at(-1);

    expect(agentManager?.permissionRequestCallback).toBeTypeOf('function');

    const permissionPromise = agentManager?.permissionRequestCallback?.({
      options: [
        {
          optionId: 'proceed_once',
          name: 'Yes',
          kind: 'allow_once',
        },
        {
          optionId: 'cancel',
          name: 'No, keep planning (esc)',
          kind: 'reject_once',
        },
      ],
      toolCall: {
        toolCallId: 'tool-call-1',
        title: 'Would you like to proceed?',
        kind: 'switch_mode',
        status: 'pending',
      },
    });

    expect(messageHandler?.permissionHandler).toBeTypeOf('function');

    messageHandler?.permissionHandler?.({
      type: 'permissionResponse',
      data: { optionId: 'cancel' },
    });

    await expect(permissionPromise).resolves.toBe('cancel');
    expect(agentManager?.cancelCurrentPrompt).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'streamEnd',
      }),
    );
    expect(postMessage).toHaveBeenCalledWith({
      type: 'toolCall',
      data: expect.objectContaining({
        type: 'tool_call_update',
        toolCallId: 'tool-call-1',
        kind: 'switch_mode',
        status: 'failed',
      }),
    });
  });

  it('replays available skills to the webview after webviewReady', async () => {
    let messageHandler:
      | ((message: { type: string; data?: unknown }) => Promise<void>)
      | undefined;

    const postMessage = vi.fn();
    const webview = {
      options: undefined as unknown,
      html: '',
      postMessage,
      asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
        toString: () => `webview:${uri.fsPath}`,
      })),
      onDidReceiveMessage: vi.fn(
        (
          handler: (message: { type: string; data?: unknown }) => Promise<void>,
        ) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        },
      ),
    };

    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );

    await provider.attachToView(
      {
        webview,
        visible: true,
        onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      } as never,
      'qwen-code.chatView.sidebar',
    );

    const agentManager = (
      provider as unknown as {
        agentManager: {
          onAvailableSkills: ReturnType<typeof vi.fn>;
        };
      }
    ).agentManager;
    const onAvailableSkills = agentManager.onAvailableSkills.mock
      .calls[0]?.[0] as ((skills: string[]) => void) | undefined;

    expect(onAvailableSkills).toBeTypeOf('function');

    const skills = ['code-review-expert'];
    onAvailableSkills?.(skills);

    postMessage.mockClear();

    await messageHandler?.({
      type: 'webviewReady',
      data: {},
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'availableSkills',
      data: { skills },
    });
  });

  it('replays available commands to the webview after webviewReady', async () => {
    let messageHandler:
      | ((message: { type: string; data?: unknown }) => Promise<void>)
      | undefined;

    const postMessage = vi.fn();
    const webview = {
      options: undefined as unknown,
      html: '',
      postMessage,
      asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
        toString: () => `webview:${uri.fsPath}`,
      })),
      onDidReceiveMessage: vi.fn(
        (
          handler: (message: { type: string; data?: unknown }) => Promise<void>,
        ) => {
          messageHandler = handler;
          return { dispose: vi.fn() };
        },
      ),
    };

    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );

    await provider.attachToView(
      {
        webview,
        visible: true,
        onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
      } as never,
      'qwen-code.chatView.sidebar',
    );

    const agentManager = (
      provider as unknown as {
        agentManager: {
          onAvailableCommands: ReturnType<typeof vi.fn>;
        };
      }
    ).agentManager;
    const onAvailableCommands = agentManager.onAvailableCommands.mock
      .calls[0]?.[0] as
      | ((commands: Array<{ name: string; description: string }>) => void)
      | undefined;

    expect(onAvailableCommands).toBeTypeOf('function');

    const commands = [
      { name: 'skills', description: 'List available skills' },
      { name: 'compress', description: 'Compress the context' },
    ];
    onAvailableCommands?.(commands);

    postMessage.mockClear();

    await messageHandler?.({
      type: 'webviewReady',
      data: {},
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'availableCommands',
      data: { commands },
    });
  });
});

describe('WebViewProvider settings sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigChangeHandlers.length = 0;
    mockConfigGet.mockImplementation(
      (_key: string, defaultValue: unknown) => defaultValue,
    );
  });

  it('does not report success for api-key settings without interactive auth data', async () => {
    mockConfigGet.mockImplementation((key: string, defaultValue: unknown) => {
      if (key === 'apiKey') {
        return 'sk-test';
      }
      if (key === 'provider') {
        return 'api-key';
      }
      return defaultValue;
    });

    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );

    const synced = await (
      provider as unknown as {
        syncVSCodeSettingsToQwenConfig: () => Promise<boolean>;
      }
    ).syncVSCodeSettingsToQwenConfig();

    expect(synced).toBe(false);
    expect(mockWriteCodingPlanConfig).not.toHaveBeenCalled();
    expect(mockWriteModelProvidersConfig).not.toHaveBeenCalled();
  });

  it('only syncs non-secret VS Code settings from ~/.qwen/settings.json', async () => {
    mockReadQwenSettingsForVSCode.mockReturnValue({
      provider: 'coding-plan',
      apiKey: 'sk-updated',
      codingPlanRegion: 'global',
    });
    mockConfigGet.mockImplementation((key: string, defaultValue: unknown) => {
      if (key === 'provider') {
        return 'api-key';
      }
      if (key === 'apiKey') {
        return 'sk-current';
      }
      if (key === 'codingPlanRegion') {
        return 'china';
      }
      return defaultValue;
    });

    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );

    await (
      provider as unknown as {
        syncQwenConfigToVSCodeSettings: () => Promise<void>;
      }
    ).syncQwenConfigToVSCodeSettings();

    expect(mockConfigUpdate).toHaveBeenCalledTimes(2);
    expect(mockConfigUpdate).toHaveBeenCalledWith(
      'provider',
      'coding-plan',
      expect.anything(),
    );
    expect(mockConfigUpdate).toHaveBeenCalledWith(
      'codingPlanRegion',
      'global',
      expect.anything(),
    );
    expect(mockConfigUpdate).not.toHaveBeenCalledWith(
      'apiKey',
      'sk-updated',
      expect.anything(),
    );
  });

  it('ignores non-auth qwen-code setting changes', async () => {
    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );
    const syncSpy = vi
      .spyOn(
        provider as unknown as {
          syncVSCodeSettingsToQwenConfig: () => Promise<boolean>;
        },
        'syncVSCodeSettingsToQwenConfig',
      )
      .mockResolvedValue(true);

    const configChangeHandler = mockConfigChangeHandlers.at(-1);
    expect(configChangeHandler).toBeDefined();

    await configChangeHandler?.(createConfigChangeEvent('qwen-code'));

    expect(syncSpy).not.toHaveBeenCalled();
  });

  it('reacts to auth-related qwen-code setting changes', async () => {
    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );
    const syncSpy = vi
      .spyOn(
        provider as unknown as {
          syncVSCodeSettingsToQwenConfig: () => Promise<boolean>;
        },
        'syncVSCodeSettingsToQwenConfig',
      )
      .mockResolvedValue(false);

    const configChangeHandler = mockConfigChangeHandlers.at(-1);
    expect(configChangeHandler).toBeDefined();

    await configChangeHandler?.(
      createConfigChangeEvent('qwen-code', 'qwen-code.apiKey'),
    );

    expect(syncSpy).toHaveBeenCalledTimes(1);
  });

  it('clears persisted credentials and disconnects when apiKey is emptied', async () => {
    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );

    // Simulate an already-initialized agent connection
    (provider as unknown as { agentInitialized: boolean }).agentInitialized =
      true;

    // syncVSCodeSettingsToQwenConfig returns false because apiKey is empty
    vi.spyOn(
      provider as unknown as {
        syncVSCodeSettingsToQwenConfig: () => Promise<boolean>;
      },
      'syncVSCodeSettingsToQwenConfig',
    ).mockResolvedValue(false);

    // apiKey is empty (user cleared it in Settings)
    mockConfigGet.mockImplementation((key: string, defaultValue: unknown) => {
      if (key === 'apiKey') {
        return '';
      }
      return defaultValue;
    });

    const configChangeHandler = mockConfigChangeHandlers.at(-1);
    expect(configChangeHandler).toBeDefined();

    await configChangeHandler?.(
      createConfigChangeEvent('qwen-code', 'qwen-code.apiKey'),
    );

    // Should clear persisted auth
    expect(mockClearPersistedAuth).toHaveBeenCalledTimes(1);

    // Should disconnect the agent
    const agentManager = mockQwenAgentManagerInstances.at(-1);
    expect(agentManager?.disconnect).toHaveBeenCalledTimes(1);

    // agentInitialized should be reset
    expect(
      (provider as unknown as { agentInitialized: boolean }).agentInitialized,
    ).toBe(false);
  });

  it('does not de-auth when non-apiKey auth settings change on an api-key provider', async () => {
    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );

    // Simulate an already-initialized agent with api-key provider
    (provider as unknown as { agentInitialized: boolean }).agentInitialized =
      true;

    // syncVSCodeSettingsToQwenConfig returns false — normal for api-key providers
    vi.spyOn(
      provider as unknown as {
        syncVSCodeSettingsToQwenConfig: () => Promise<boolean>;
      },
      'syncVSCodeSettingsToQwenConfig',
    ).mockResolvedValue(false);

    // apiKey is empty because api-key providers don't use this VS Code setting
    mockConfigGet.mockImplementation((key: string, defaultValue: unknown) => {
      if (key === 'apiKey') {
        return '';
      }
      if (key === 'provider') {
        return 'api-key';
      }
      return defaultValue;
    });

    const configChangeHandler = mockConfigChangeHandlers.at(-1);
    expect(configChangeHandler).toBeDefined();

    // Changing codingPlanRegion should NOT trigger de-auth
    await configChangeHandler?.(
      createConfigChangeEvent('qwen-code', 'qwen-code.codingPlanRegion'),
    );

    expect(mockClearPersistedAuth).not.toHaveBeenCalled();

    const agentManager = mockQwenAgentManagerInstances.at(-1);
    expect(agentManager?.disconnect).not.toHaveBeenCalled();

    // agentInitialized should remain true
    expect(
      (provider as unknown as { agentInitialized: boolean }).agentInitialized,
    ).toBe(true);
  });
});

describe('WebViewProvider.createNewSession', () => {
  it('forces a fresh ACP session for the sidebar new-session action', async () => {
    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );
    const agentManager = (
      provider as unknown as {
        agentManager: {
          createNewSession: ReturnType<typeof vi.fn>;
        };
      }
    ).agentManager;
    const messageHandler = (
      provider as unknown as {
        messageHandler: {
          setCurrentConversationId: ReturnType<typeof vi.fn>;
        };
      }
    ).messageHandler;

    await provider.createNewSession();

    expect(agentManager.createNewSession).toHaveBeenCalledWith(
      '/workspace-root',
      { forceNew: true },
    );
    expect(messageHandler.setCurrentConversationId).toHaveBeenCalledWith(null);
  });
});

describe('truncatePanelTitle', () => {
  it('passes through a short title unchanged', () => {
    expect(truncatePanelTitle('Short title')).toBe('Short title');
  });

  it('passes through an empty string unchanged', () => {
    expect(truncatePanelTitle('')).toBe('');
  });

  it(`passes through a title of exactly ${MAX_PANEL_TITLE_LENGTH} code points unchanged`, () => {
    const title = 'a'.repeat(MAX_PANEL_TITLE_LENGTH);
    expect(truncatePanelTitle(title)).toBe(title);
  });

  it('truncates a title of MAX+1 characters to MAX content chars + ellipsis', () => {
    const title = 'a'.repeat(MAX_PANEL_TITLE_LENGTH + 1);
    const result = truncatePanelTitle(title);
    expect(result).toBe('a'.repeat(MAX_PANEL_TITLE_LENGTH) + '…');
    expect([...result].length).toBe(MAX_PANEL_TITLE_LENGTH + 1);
  });

  it('truncates a very long title to MAX content code points + ellipsis', () => {
    const title = 'a'.repeat(200);
    const result = truncatePanelTitle(title);
    expect(result).toBe('a'.repeat(MAX_PANEL_TITLE_LENGTH) + '…');
    expect([...result].length).toBe(MAX_PANEL_TITLE_LENGTH + 1);
  });

  it('does not split a surrogate pair (emoji) at the truncation boundary', () => {
    // 49 ASCII chars + emoji (1 code point, 2 UTF-16 code units) + trailing text
    // Total: 49 + 1 + 5 = 55 code points → needs truncation
    const emoji = '😀';
    const title = 'a'.repeat(MAX_PANEL_TITLE_LENGTH - 1) + emoji + 'extra';
    const result = truncatePanelTitle(title);
    // First 50 code points: 49 'a's + emoji, then '…' — emoji is not split
    expect(result).toBe('a'.repeat(MAX_PANEL_TITLE_LENGTH - 1) + emoji + '…');
    expect([...result].length).toBe(MAX_PANEL_TITLE_LENGTH + 1);
  });
});

describe('WebViewProvider initial model inheritance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPanel.mockReturnValue(null);
  });

  it('applies the requested initial model after creating a new session', async () => {
    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );
    provider.setInitialModelId('glm-5');

    const agentManager = (
      provider as unknown as {
        agentManager: {
          currentSessionId: string | null;
          createNewSession: ReturnType<typeof vi.fn>;
          setModelFromUi: ReturnType<typeof vi.fn>;
        };
      }
    ).agentManager;
    agentManager.createNewSession.mockResolvedValue('session-1');
    agentManager.setModelFromUi.mockResolvedValue({
      modelId: 'glm-5',
      name: 'GLM-5',
    });

    await (
      provider as unknown as {
        loadCurrentSessionMessages: (options?: {
          autoAuthenticate?: boolean;
        }) => Promise<boolean>;
      }
    ).loadCurrentSessionMessages();

    expect(agentManager.createNewSession).toHaveBeenCalledWith(
      '/workspace-root',
      { autoAuthenticate: true },
    );
    expect(agentManager.setModelFromUi).toHaveBeenCalledWith('glm-5');
  });
});

describe('Notification & dot indicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockConfigGet.mockImplementation((key: string, defaultValue?: unknown) => {
      if (key === 'dotIndicator') {
        return true;
      }
      if (key === 'notifications') {
        return true;
      }
      return defaultValue;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows orange dot and notification when a long task completes while panel is not active', async () => {
    const mockPanel = {
      active: false,
      visible: false,
      webview: { postMessage: vi.fn() },
      iconPath: undefined as unknown,
    };
    mockGetPanel.mockReturnValue(mockPanel as never);
    mockWindowState.focused = false;

    await setupAttachedProvider();

    // Simulate stream chunk to set agentStartTime
    streamChunkCallbackRef.current?.('chunk');

    // Advance time past 20s threshold
    vi.advanceTimersByTime(25_000);

    // Trigger endTurn
    endTurnCallbackRef.current?.('end_turn');

    // Orange dot should be set
    expect(mockPanel.iconPath).toEqual(
      expect.objectContaining({
        fsPath: expect.stringContaining('icon-orange.png'),
      }),
    );

    // Notification should be shown
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Qwen Code: Waiting for your input.',
      'Show',
    );
  });

  it('does not show notification for short tasks (< 20s)', async () => {
    const mockPanel = {
      active: false,
      visible: false,
      webview: { postMessage: vi.fn() },
      iconPath: undefined as unknown,
    };
    mockGetPanel.mockReturnValue(mockPanel as never);
    mockWindowState.focused = false;

    await setupAttachedProvider();

    streamChunkCallbackRef.current?.('chunk');
    vi.advanceTimersByTime(5_000); // only 5s
    endTurnCallbackRef.current?.('end_turn');

    // Orange dot should still appear (no duration requirement for dot)
    expect(mockPanel.iconPath).toEqual(
      expect.objectContaining({
        fsPath: expect.stringContaining('icon-orange.png'),
      }),
    );

    // But NO notification for short task
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it('does not show notification when user is watching the panel', async () => {
    const mockPanel = {
      active: true,
      visible: true,
      webview: { postMessage: vi.fn() },
      iconPath: undefined as unknown,
    };
    mockGetPanel.mockReturnValue(mockPanel as never);
    mockWindowState.focused = true;

    await setupAttachedProvider();

    streamChunkCallbackRef.current?.('chunk');
    vi.advanceTimersByTime(25_000);
    endTurnCallbackRef.current?.('end_turn');

    // No dot (panel is active)
    expect(mockPanel.iconPath).toBeUndefined();
    // No notification (user is watching)
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it('shows blue dot and notification for permission requests when panel is not active', async () => {
    const mockPanel = {
      active: false,
      visible: false,
      webview: { postMessage: vi.fn() },
      iconPath: undefined as unknown,
    };
    mockGetPanel.mockReturnValue(mockPanel as never);
    mockWindowState.focused = false;

    await setupAttachedProvider();

    // Trigger permission request — don't await, it blocks on user response
    void permissionRequestCallbackRef.current?.({
      toolCall: { title: 'Bash' },
      options: [],
    });

    // Blue dot
    expect(mockPanel.iconPath).toEqual(
      expect.objectContaining({
        fsPath: expect.stringContaining('icon-blue.png'),
      }),
    );

    // Notification with tool name
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Qwen Code: Needs your permission to use Bash.',
      'Show',
    );
  });

  it('blue dot takes priority over orange dot', async () => {
    const mockPanel = {
      active: false,
      visible: false,
      webview: { postMessage: vi.fn() },
      iconPath: undefined as unknown,
    };
    mockGetPanel.mockReturnValue(mockPanel as never);
    mockWindowState.focused = false;

    await setupAttachedProvider();

    // First: task completes, orange dot
    streamChunkCallbackRef.current?.('chunk');
    vi.advanceTimersByTime(25_000);
    endTurnCallbackRef.current?.('end_turn');
    expect(mockPanel.iconPath).toEqual(
      expect.objectContaining({
        fsPath: expect.stringContaining('icon-orange.png'),
      }),
    );

    // Then: permission request, should upgrade to blue
    void permissionRequestCallbackRef.current?.({
      toolCall: { title: 'Read' },
      options: [],
    });
    expect(mockPanel.iconPath).toEqual(
      expect.objectContaining({
        fsPath: expect.stringContaining('icon-blue.png'),
      }),
    );

    // Another endTurn should NOT downgrade back to orange
    endTurnCallbackRef.current?.('end_turn');
    expect(mockPanel.iconPath).toEqual(
      expect.objectContaining({
        fsPath: expect.stringContaining('icon-blue.png'),
      }),
    );
  });

  it('does not send duplicate idle notifications for multi-turn tasks', async () => {
    const mockPanel = {
      active: false,
      visible: false,
      webview: { postMessage: vi.fn() },
      iconPath: undefined as unknown,
    };
    mockGetPanel.mockReturnValue(mockPanel as never);
    mockWindowState.focused = false;

    await setupAttachedProvider();

    streamChunkCallbackRef.current?.('chunk');
    vi.advanceTimersByTime(25_000);

    // First endTurn (intermediate)
    endTurnCallbackRef.current?.('end_turn');
    expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);

    // Second endTurn (final) — should NOT fire another notification
    endTurnCallbackRef.current?.('end_turn');
    expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);
  });

  it('does not notify when notifications setting is disabled', async () => {
    mockConfigGet.mockImplementation((key: string, defaultValue?: unknown) => {
      if (key === 'notifications') {
        return false;
      }
      if (key === 'dotIndicator') {
        return true;
      }
      return defaultValue;
    });

    const mockPanel = {
      active: false,
      visible: false,
      webview: { postMessage: vi.fn() },
      iconPath: undefined as unknown,
    };
    mockGetPanel.mockReturnValue(mockPanel as never);
    mockWindowState.focused = false;

    await setupAttachedProvider();

    streamChunkCallbackRef.current?.('chunk');
    vi.advanceTimersByTime(25_000);
    endTurnCallbackRef.current?.('end_turn');

    // Dot should still appear
    expect(mockPanel.iconPath).toEqual(
      expect.objectContaining({
        fsPath: expect.stringContaining('icon-orange.png'),
      }),
    );
    // But no notification
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it('cancellation resets agentStartTime so the next short task does not trigger phantom notification', async () => {
    const mockPanel = {
      active: false,
      visible: false,
      webview: { postMessage: vi.fn() },
      iconPath: undefined as unknown,
    };
    mockGetPanel.mockReturnValue(mockPanel as never);
    mockWindowState.focused = false;

    const { messageHandler } = await setupAttachedProvider({
      captureMessageHandler: true,
    });

    // Start a task
    streamChunkCallbackRef.current?.('chunk');
    vi.advanceTimersByTime(30_000);

    // User sends a new message (resets timer)
    await messageHandler?.({ type: 'sendMessage', data: { text: 'hello' } });

    // Short task starts and completes quickly
    streamChunkCallbackRef.current?.('chunk2');
    vi.advanceTimersByTime(2_000);
    endTurnCallbackRef.current?.('end_turn');

    // Should NOT send notification (only 2s)
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
  });

  it('does not show dot when dotIndicator setting is disabled', async () => {
    mockConfigGet.mockImplementation((key: string, defaultValue?: unknown) => {
      if (key === 'dotIndicator') {
        return false;
      }
      if (key === 'notifications') {
        return true;
      }
      return defaultValue;
    });

    const mockPanel = {
      active: false,
      visible: false,
      webview: { postMessage: vi.fn() },
      iconPath: undefined as unknown,
    };
    mockGetPanel.mockReturnValue(mockPanel as never);
    mockWindowState.focused = false;

    await setupAttachedProvider();

    streamChunkCallbackRef.current?.('chunk');
    vi.advanceTimersByTime(25_000);
    endTurnCallbackRef.current?.('end_turn');

    // Dot should NOT appear (setting disabled)
    expect(mockPanel.iconPath).toBeUndefined();
    // But notification should still fire
    expect(mockShowInformationMessage).toHaveBeenCalled();
  });

  it('notifies when VS Code is focused but panel is not visible', async () => {
    const mockPanel = {
      active: false,
      visible: false,
      webview: { postMessage: vi.fn() },
      iconPath: undefined as unknown,
    };
    mockGetPanel.mockReturnValue(mockPanel as never);
    mockWindowState.focused = true; // VS Code focused

    await setupAttachedProvider();

    streamChunkCallbackRef.current?.('chunk');
    vi.advanceTimersByTime(25_000);
    endTurnCallbackRef.current?.('end_turn');

    // User is in VS Code but not looking at the panel — should notify
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Qwen Code: Waiting for your input.',
      'Show',
    );
  });

  it('notifies when VS Code is not focused but panel is visible', async () => {
    const mockPanel = {
      active: false,
      visible: true,
      webview: { postMessage: vi.fn() },
      iconPath: undefined as unknown,
    };
    mockGetPanel.mockReturnValue(mockPanel as never);
    mockWindowState.focused = false; // VS Code not focused

    await setupAttachedProvider();

    streamChunkCallbackRef.current?.('chunk');
    vi.advanceTimersByTime(25_000);
    endTurnCallbackRef.current?.('end_turn');

    // User left VS Code — should notify even though panel is visible
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Qwen Code: Waiting for your input.',
      'Show',
    );
  });

  it('shows blue dot and notification for askUserQuestion when panel is not active', async () => {
    const mockPanel = {
      active: false,
      visible: false,
      webview: { postMessage: vi.fn() },
      iconPath: undefined as unknown,
    };
    mockGetPanel.mockReturnValue(mockPanel as never);
    mockWindowState.focused = false;

    await setupAttachedProvider();

    // Trigger askUserQuestion — don't await, it blocks on user response
    void askUserQuestionCallbackRef.current?.({
      questions: [{ question: 'Which option?' }],
    });

    // Blue dot
    expect(mockPanel.iconPath).toEqual(
      expect.objectContaining({
        fsPath: expect.stringContaining('icon-blue.png'),
      }),
    );

    // Notification without tool name (generic message)
    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Qwen Code: Waiting for your input.',
      'Show',
    );
  });
});
