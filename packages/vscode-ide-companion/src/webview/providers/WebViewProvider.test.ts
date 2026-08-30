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
  mockApplyProviderInstallPlanToFile,
  mockSnapshotSettingsForRollback,
  mockRestoreSettingsSnapshot,
  slashCommandNotificationCallbackRef,
  endTurnCallbackRef,
  streamChunkCallbackRef,
  transcriptUpdateCallbackRef,
  toolCallCallbackRef,
  permissionRequestCallbackRef,
  askUserQuestionCallbackRef,
  mockShowInformationMessage,
  mockWindowState,
  mockQwenAgentManagerInstances,
  mockClipboardWriteText,
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
  mockApplyProviderInstallPlanToFile: vi.fn().mockResolvedValue(undefined),
  mockSnapshotSettingsForRollback: vi.fn<() => Record<string, unknown> | null>(
    () => null,
  ),
  mockRestoreSettingsSnapshot: vi.fn(),
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
    current: undefined as
      | ((reason?: string, source?: string) => void)
      | undefined,
  },
  streamChunkCallbackRef: {
    current: undefined as ((chunk: string) => void) | undefined,
  },
  transcriptUpdateCallbackRef: {
    current: undefined as
      | ((notification: Record<string, unknown>) => void)
      | undefined,
  },
  toolCallCallbackRef: {
    current: undefined as
      | ((update: Record<string, unknown>) => void)
      | undefined,
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
  mockClipboardWriteText: vi.fn(),
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

const daemonMocks = vi.hoisted(() => {
  // Contract-faithful stand-in for QwenDaemonProcess: workspace switches
  // notify superseded listeners, exits notify exit listeners, and a disposed
  // subscription stops receiving either.
  class FakeQwenDaemonProcess {
    boundCwd: string | null = null;
    runtimeCount = 0;
    exitListeners = new Set<() => void>();
    supersededListeners = new Set<() => void>();

    async start(_cliEntryPath: string, workspaceCwd: string) {
      if (this.boundCwd !== null && this.boundCwd !== workspaceCwd) {
        for (const listener of [...this.supersededListeners]) listener();
      }
      this.boundCwd = workspaceCwd;
      this.runtimeCount += 1;
      return {
        baseUrl: `http://127.0.0.1:${4100 + this.runtimeCount}`,
        token: `token-${this.runtimeCount}`,
      };
    }

    addExitListener(listener: () => void) {
      this.exitListeners.add(listener);
      return {
        dispose: () => {
          this.exitListeners.delete(listener);
        },
      };
    }

    addSupersededListener(listener: () => void) {
      this.supersededListeners.add(listener);
      return {
        dispose: () => {
          this.supersededListeners.delete(listener);
        },
      };
    }

    dispose(): void {}
  }

  return {
    FakeQwenDaemonProcess,
    instances: [] as FakeQwenDaemonProcess[],
  };
});

vi.mock('../../services/qwenDaemonProcess.js', () => ({
  QwenDaemonProcess: class extends daemonMocks.FakeQwenDaemonProcess {
    constructor() {
      super();
      daemonMocks.instances.push(this);
    }
  },
}));

vi.mock('vscode', () => ({
  ExtensionMode: {
    Production: 1,
    Development: 2,
    Test: 3,
  },
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
    clipboard: {
      writeText: mockClipboardWriteText,
    },
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
  applyProviderInstallPlanToFile: mockApplyProviderInstallPlanToFile,
  snapshotSettingsForRollback: mockSnapshotSettingsForRollback,
  restoreSettingsSnapshot: mockRestoreSettingsSnapshot,
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
    onEndTurn = vi.fn((cb: (reason?: string, source?: string) => void) => {
      endTurnCallbackRef.current = cb;
    });
    onToolCall = vi.fn(
      (callback: (update: Record<string, unknown>) => void) => {
        toolCallCallbackRef.current = callback;
      },
    );
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
    onTranscriptUpdate = vi.fn(
      (callback: (notification: Record<string, unknown>) => void) => {
        transcriptUpdateCallbackRef.current = callback;
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
    addMessage = vi.fn().mockResolvedValue(undefined);
    getCurrentConversationId = vi.fn(() => null);
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
      dispose = vi.fn();
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

import * as vscode from 'vscode';
import { WebViewProvider, resolveQwenCliEntryPath } from './WebViewProvider.js';
import {
  truncatePanelTitle,
  MAX_PANEL_TITLE_LENGTH,
} from '../utils/panelTitleUtils.js';
import { logger } from '../../utils/logger.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const createConfigChangeEvent = (...affectedSections: string[]) => ({
  affectsConfiguration: (section: string) => affectedSections.includes(section),
});

type WebViewMessageHandler = (message: {
  type: string;
  data?: unknown;
}) => Promise<void>;

describe('resolveQwenCliEntryPath', () => {
  it('uses the source dev entry when the extension runs in development mode', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'qwen-vscode-dev-'));
    try {
      const extensionRoot = path.join(
        tempRoot,
        'packages',
        'vscode-ide-companion',
      );
      const devEntry = path.join(tempRoot, 'scripts', 'dev.js');
      mkdirSync(extensionRoot, { recursive: true });
      mkdirSync(path.dirname(devEntry), { recursive: true });
      writeFileSync(devEntry, '');

      expect(
        resolveQwenCliEntryPath({ fsPath: extensionRoot } as never, 2),
      ).toBe(devEntry);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses the bundled CLI outside development mode', () => {
    expect(
      resolveQwenCliEntryPath(
        { fsPath: '/extension-root' } as never,
        undefined,
      ),
    ).toBe('/extension-root/dist/qwen-cli/cli.js');
  });
});

/**
 * Create a mock webview + provider and attach them.
 * If `captureMessageHandler` is true, the `onDidReceiveMessage` handler is
 * captured and returned so the test can simulate messages from the webview.
 */
async function setupAttachedProvider(options?: {
  captureMessageHandler?: boolean;
  context?: unknown;
}) {
  let messageHandler: WebViewMessageHandler | undefined;
  const viewDisposeListeners: Array<() => void> = [];

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
    (options?.context ?? { subscriptions: [] }) as never,
    { fsPath: '/extension-root' } as never,
  );

  await provider.attachToView(
    {
      webview,
      visible: true,
      onDidChangeVisibility: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDispose: vi.fn((listener: () => void) => {
        viewDisposeListeners.push(listener);
        return { dispose: vi.fn() };
      }),
    } as never,
    'qwen-code.chatView.sidebar',
  );

  return {
    webview,
    postMessage,
    provider,
    messageHandler,
    viewDisposeListeners,
  };
}

beforeEach(() => {
  mockConfigChangeHandlers.length = 0;
  endTurnCallbackRef.current = undefined;
  streamChunkCallbackRef.current = undefined;
  transcriptUpdateCallbackRef.current = undefined;
  toolCallCallbackRef.current = undefined;
  permissionRequestCallbackRef.current = undefined;
  askUserQuestionCallbackRef.current = undefined;
  mockWindowState.focused = true;
  mockShowInformationMessage.mockReset();
  mockShowInformationMessage.mockReturnValue(Promise.resolve(undefined));
  mockClipboardWriteText.mockReset();
  mockClipboardWriteText.mockResolvedValue(undefined);
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

  it('reports clipboard copy success back to the requesting webview', async () => {
    const { messageHandler, postMessage } = await setupAttachedProvider({
      captureMessageHandler: true,
    });

    await messageHandler?.({
      type: 'copyToClipboard',
      data: { text: 'copy me', requestId: 'copy-1' },
    });

    expect(mockClipboardWriteText).toHaveBeenCalledWith('copy me');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'copyToClipboardResult',
      data: { requestId: 'copy-1', success: true },
    });
  });

  it('writes webview log messages through the extension host logger', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const { messageHandler } = await setupAttachedProvider({
      captureMessageHandler: true,
    });
    const message = `render failed\n${'x'.repeat(10_000)}`;

    await messageHandler?.({
      type: 'log',
      data: { level: 'error', message },
    });

    expect(error).toHaveBeenCalledWith(
      '[Webview]',
      `${message.slice(0, 10_000)}...[truncated]`.replace('\n', '\\n'),
    );
    error.mockRestore();
  });

  it('reports clipboard copy failures back to the requesting webview', async () => {
    mockClipboardWriteText.mockRejectedValueOnce(new Error('denied'));
    const { messageHandler, postMessage } = await setupAttachedProvider({
      captureMessageHandler: true,
    });

    await messageHandler?.({
      type: 'copyToClipboard',
      data: { text: 'copy me', requestId: 'copy-1' },
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'copyToClipboardResult',
      data: { requestId: 'copy-1', success: false, error: 'denied' },
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

  it('settles a matching pending permission when the tool call becomes terminal', async () => {
    const { postMessage } = await setupAttachedProvider();
    const agentManager = mockQwenAgentManagerInstances.at(-1);
    const permissionPromise = agentManager?.permissionRequestCallback?.({
      options: [
        { optionId: 'proceed_once', name: 'Yes', kind: 'allow_once' },
        { optionId: 'cancel', name: 'No', kind: 'reject_once' },
      ],
      toolCall: {
        toolCallId: 'tool-call-aborted',
        title: 'Run command',
        kind: 'execute',
        status: 'pending',
      },
    });

    toolCallCallbackRef.current?.({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tool-call-aborted',
      status: 'failed',
    });

    await expect(permissionPromise).resolves.toBe('cancel');
    expect(postMessage).toHaveBeenCalledWith({
      type: 'permissionResolved',
      data: { optionId: 'cancel' },
    });
  });

  it('rejects one workflow approval without cancelling the parent prompt', async () => {
    const { postMessage } = await setupAttachedProvider();
    const agentManager = mockQwenAgentManagerInstances.at(-1);
    const messageHandler = mockMessageHandlerInstances.at(-1);
    const permissionPromise = agentManager?.permissionRequestCallback?.({
      options: [
        { optionId: 'proceed_once', name: 'Yes', kind: 'allow_once' },
        { optionId: 'cancel', name: 'No', kind: 'reject_once' },
      ],
      toolCall: {
        toolCallId: 'workflow-approval-1',
        title: 'Run command',
        kind: 'execute',
        status: 'pending',
        _meta: { workflowApproval: true },
      },
    });

    messageHandler?.permissionHandler?.({
      type: 'permissionResponse',
      data: { optionId: 'cancel' },
    });

    await expect(permissionPromise).resolves.toBe('cancel');
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: 'toolCall',
        data: expect.objectContaining({
          type: 'tool_call_update',
          toolCallId: 'workflow-approval-1',
          status: 'failed',
        }),
      });
    });
    expect(agentManager?.cancelCurrentPrompt).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'streamEnd' }),
    );
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

describe('WebViewProvider transcript forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageHandlerInstances.length = 0;
    mockQwenAgentManagerInstances.length = 0;
    mockGetPanel.mockReturnValue(null);
  });

  it('forwards agent transcriptUpdate notifications to the webview', async () => {
    const { postMessage } = await setupAttachedProvider();

    // The subscription is registered in the provider constructor; without it
    // the webview never receives timeline frames and renders an empty
    // transcript while every other message flow keeps working.
    expect(transcriptUpdateCallbackRef.current).toBeDefined();

    const notification = {
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello transcript' },
      },
    };

    transcriptUpdateCallbackRef.current?.(notification);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'transcriptUpdate',
      data: notification,
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

  it('does not apply a discontinued initial model to the new session', async () => {
    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );
    provider.setInitialModelId('qwen3-coder-plus(qwen-oauth)');

    const agentManager = (
      provider as unknown as {
        agentManager: {
          createNewSession: ReturnType<typeof vi.fn>;
          setModelFromUi: ReturnType<typeof vi.fn>;
        };
      }
    ).agentManager;
    agentManager.createNewSession.mockResolvedValue('session-1');
    agentManager.setModelFromUi.mockResolvedValue({
      modelId: 'qwen3-coder-plus(qwen-oauth)',
      name: 'Qwen3 Coder Plus',
    });

    await (
      provider as unknown as {
        loadCurrentSessionMessages: (options?: {
          autoAuthenticate?: boolean;
        }) => Promise<boolean>;
      }
    ).loadCurrentSessionMessages();

    expect(agentManager.setModelFromUi).not.toHaveBeenCalled();
  });

  it('still applies a runtime snapshot id that wraps a discontinued model', async () => {
    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );
    provider.setInitialModelId(
      '$runtime|qwen-oauth|qwen3-coder-plus(qwen-oauth)',
    );

    const agentManager = (
      provider as unknown as {
        agentManager: {
          createNewSession: ReturnType<typeof vi.fn>;
          setModelFromUi: ReturnType<typeof vi.fn>;
        };
      }
    ).agentManager;
    agentManager.createNewSession.mockResolvedValue('session-1');
    agentManager.setModelFromUi.mockResolvedValue({
      modelId: '$runtime|qwen-oauth|qwen3-coder-plus(qwen-oauth)',
      name: 'Qwen3 Coder Plus',
    });

    await (
      provider as unknown as {
        loadCurrentSessionMessages: (options?: {
          autoAuthenticate?: boolean;
        }) => Promise<boolean>;
      }
    ).loadCurrentSessionMessages();

    expect(agentManager.setModelFromUi).toHaveBeenCalledWith(
      '$runtime|qwen-oauth|qwen3-coder-plus(qwen-oauth)',
    );
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

  it('does not show idle notification for background notification turns', async () => {
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
    endTurnCallbackRef.current?.('end_turn', 'background_notification');

    expect(mockPanel.webview.postMessage).toHaveBeenCalledWith({
      type: 'streamEnd',
      data: expect.objectContaining({
        reason: 'end_turn',
        source: 'background_notification',
      }),
    });
    expect(mockShowInformationMessage).not.toHaveBeenCalledWith(
      'Qwen Code: Waiting for your input.',
      'Show',
    );
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

describe('WebViewProvider.handleAuthInteractive credential rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSnapshotSettingsForRollback.mockReturnValue(null);
  });

  // Minimal real-ish provider config + inputs so the real buildInstallPlan
  // (core is not mocked beyond Storage) produces a valid plan.
  const providerConfig = {
    id: 'deepseek',
    label: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    envKey: 'DEEPSEEK_API_KEY',
    models: [{ id: 'deepseek-v4-flash' }],
    modelNamePrefix: 'DeepSeek',
  } as unknown as Parameters<WebViewProvider['handleAuthInteractive']>[0];
  const inputs = {
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-bad-key',
    modelIds: ['deepseek-v4-flash'],
  } as unknown as Parameters<WebViewProvider['handleAuthInteractive']>[1];

  function makeProvider() {
    const provider = new WebViewProvider(
      { subscriptions: [] } as never,
      { fsPath: '/extension-root' } as never,
    );
    // Avoid touching the real webview pipe.
    (
      provider as unknown as { sendMessageToWebView: () => void }
    ).sendMessageToWebView = vi.fn();
    return provider;
  }

  it('restores the snapshot when the reconnect leaves authState !== true', async () => {
    const snapshot = { env: { OPENAI_API_KEY: 'sk-old' } };
    mockSnapshotSettingsForRollback.mockReturnValue(snapshot);

    const provider = makeProvider();
    // doInitializeAgentConnection runs but the backend rejects the key, so
    // authState stays false.
    (
      provider as unknown as {
        doInitializeAgentConnection: () => Promise<void>;
        authState: boolean;
      }
    ).doInitializeAgentConnection = vi.fn(async () => {
      (provider as unknown as { authState: boolean }).authState = false;
    });

    await (
      provider as unknown as {
        handleAuthInteractive: (c: unknown, i: unknown) => Promise<void>;
      }
    ).handleAuthInteractive(providerConfig, inputs);

    expect(mockApplyProviderInstallPlanToFile).toHaveBeenCalledTimes(1);
    expect(mockRestoreSettingsSnapshot).toHaveBeenCalledWith(snapshot);
  });

  it('disconnects the agent after rolling back rejected credentials', async () => {
    mockSnapshotSettingsForRollback.mockReturnValue({
      env: { OPENAI_API_KEY: 'sk-old' },
    });

    const provider = makeProvider();
    const disconnect = vi.fn();
    (
      provider as unknown as {
        agentManager: { disconnect: () => void };
        agentInitialized: boolean;
      }
    ).agentManager = { disconnect } as never;
    (provider as unknown as { agentInitialized: boolean }).agentInitialized =
      true;
    (
      provider as unknown as {
        doInitializeAgentConnection: () => Promise<void>;
        authState: boolean;
      }
    ).doInitializeAgentConnection = vi.fn(async () => {
      // Reconnect happened (sets agentInitialized true) but auth rejected.
      (provider as unknown as { agentInitialized: boolean }).agentInitialized =
        true;
      (provider as unknown as { authState: boolean }).authState = false;
    });

    await (
      provider as unknown as {
        handleAuthInteractive: (c: unknown, i: unknown) => Promise<void>;
      }
    ).handleAuthInteractive(providerConfig, inputs);

    // Bad-key agent must be torn down so later actions don't hit it.
    expect(disconnect).toHaveBeenCalled();
    expect(
      (provider as unknown as { agentInitialized: boolean }).agentInitialized,
    ).toBe(false);
  });

  it('does NOT restore when the reconnect authenticates (authState === true)', async () => {
    mockSnapshotSettingsForRollback.mockReturnValue({
      env: { OPENAI_API_KEY: 'sk-old' },
    });

    const provider = makeProvider();
    (
      provider as unknown as {
        doInitializeAgentConnection: () => Promise<void>;
        authState: boolean;
      }
    ).doInitializeAgentConnection = vi.fn(async () => {
      (provider as unknown as { authState: boolean }).authState = true;
    });

    await (
      provider as unknown as {
        handleAuthInteractive: (c: unknown, i: unknown) => Promise<void>;
      }
    ).handleAuthInteractive(providerConfig, inputs);

    expect(mockRestoreSettingsSnapshot).not.toHaveBeenCalled();
  });

  it('swallows a rollback write failure so the authError message still sends', async () => {
    mockSnapshotSettingsForRollback.mockReturnValue({
      env: { OPENAI_API_KEY: 'sk-old' },
    });
    // restore itself throws (e.g. EPERM on Windows renameSync).
    mockRestoreSettingsSnapshot.mockImplementation(() => {
      throw new Error('EPERM: rename failed');
    });

    const provider = makeProvider();
    const sendToWebView = (
      provider as unknown as { sendMessageToWebView: ReturnType<typeof vi.fn> }
    ).sendMessageToWebView;
    (
      provider as unknown as {
        doInitializeAgentConnection: () => Promise<void>;
        authState: boolean;
      }
    ).doInitializeAgentConnection = vi.fn(async () => {
      (provider as unknown as { authState: boolean }).authState = false;
    });

    await expect(
      (
        provider as unknown as {
          handleAuthInteractive: (c: unknown, i: unknown) => Promise<void>;
        }
      ).handleAuthInteractive(providerConfig, inputs),
    ).resolves.toBeUndefined();

    // The rollback throw must not prevent the user-facing authError.
    expect(sendToWebView).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'authError' }),
    );
  });

  it('rolls back + disconnects + reports authError when doInitializeAgentConnection throws (outer catch)', async () => {
    // The outer catch handles unexpected exceptions (disk errors, partial
    // writes) — the path where rollback is most likely to also be needed.
    const snapshot = { env: { OPENAI_API_KEY: 'sk-old' } };
    mockSnapshotSettingsForRollback.mockReturnValue(snapshot);

    const provider = makeProvider();
    const sendToWebView = (
      provider as unknown as { sendMessageToWebView: ReturnType<typeof vi.fn> }
    ).sendMessageToWebView;
    const disconnect = vi.fn();
    (
      provider as unknown as { agentManager: { disconnect: () => void } }
    ).agentManager = { disconnect } as never;
    (
      provider as unknown as {
        doInitializeAgentConnection: () => Promise<void>;
      }
    ).doInitializeAgentConnection = vi.fn(async () => {
      // Partial init: agent process spawned (agentInitialized=true) then a
      // post-connect step throws.
      (provider as unknown as { agentInitialized: boolean }).agentInitialized =
        true;
      throw new Error('disk exploded mid-reconnect');
    });

    await expect(
      (
        provider as unknown as {
          handleAuthInteractive: (c: unknown, i: unknown) => Promise<void>;
        }
      ).handleAuthInteractive(providerConfig, inputs),
    ).resolves.toBeUndefined();

    // (1) snapshot restored, (2) the half-connected stale-credential agent is
    // torn down, (3) authError with "Configuration failed", (4) resolved
    // without throwing (asserted above).
    expect(mockRestoreSettingsSnapshot).toHaveBeenCalledWith(snapshot);
    expect(disconnect).toHaveBeenCalled();
    expect(
      (provider as unknown as { agentInitialized: boolean }).agentInitialized,
    ).toBe(false);
    expect(sendToWebView).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'authError',
        data: expect.objectContaining({
          message: expect.stringContaining('Configuration failed'),
        }),
      }),
    );
  });
});

describe('WebViewProvider web-shell daemon bootstrap', () => {
  function setWorkspaceFolders(folders: string[]): void {
    (
      vscode.workspace as unknown as {
        workspaceFolders: Array<{ uri: { fsPath: string } }>;
      }
    ).workspaceFolders = folders.map((fsPath) => ({ uri: { fsPath } }));
  }

  function createSharedContext(): unknown {
    return {
      subscriptions: [],
      workspaceState: {
        get: vi.fn(() => undefined),
        update: vi.fn(() => Promise.resolve()),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageHandlerInstances.length = 0;
    mockQwenAgentManagerInstances.length = 0;
    mockGetPanel.mockReturnValue(null);
    mockConfigGet.mockImplementation(
      (_key: string, defaultValue: unknown) => defaultValue,
    );
    daemonMocks.instances.length = 0;
    setWorkspaceFolders(['/workspace-a']);
    vi.spyOn(
      WebViewProvider.prototype as unknown as {
        initializeAgentConnection: () => Promise<void>;
      },
      'initializeAgentConnection',
    ).mockResolvedValue(undefined);
  });

  it('surfaces the failure to an attached webview when another host switches the shared daemon workspace', async () => {
    const context = createSharedContext();
    const first = await setupAttachedProvider({
      captureMessageHandler: true,
      context,
    });
    const second = await setupAttachedProvider({
      captureMessageHandler: true,
      context,
    });

    setWorkspaceFolders(['/workspace-a']);
    await first.messageHandler?.({ type: 'webShellReady' });
    expect(first.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'webShellBootstrap',
        data: expect.objectContaining({ workspaceCwd: '/workspace-a' }),
      }),
    );

    // A second host bootstrapping against another folder replaces the
    // daemon the first webview is streaming against.
    setWorkspaceFolders(['/workspace-b']);
    await second.messageHandler?.({ type: 'webShellReady' });

    expect(second.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'webShellBootstrap',
        data: expect.objectContaining({ workspaceCwd: '/workspace-b' }),
      }),
    );
    // The first webview must hear about the replacement — its baseUrl and
    // token are dead and nothing else tells it.
    expect(first.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'webShellBootstrapError' }),
    );
    // The host that triggered the switch must not be told its own daemon died.
    const secondErrors = second.postMessage.mock.calls.filter(
      ([message]) =>
        (message as { type?: string }).type === 'webShellBootstrapError',
    );
    expect(secondErrors).toHaveLength(0);
  });

  it('does not notify a host about a workspace switch it triggers itself', async () => {
    const context = createSharedContext();
    const host = await setupAttachedProvider({
      captureMessageHandler: true,
      context,
    });

    setWorkspaceFolders(['/workspace-a']);
    await host.messageHandler?.({ type: 'webShellReady' });
    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'webShellBootstrap',
        data: expect.objectContaining({ workspaceCwd: '/workspace-a' }),
      }),
    );

    // The same host re-bootstrapping against another folder (a webview
    // reload with a different active editor) replaces the daemon itself —
    // it must not be told its own daemon died.
    setWorkspaceFolders(['/workspace-b']);
    await host.messageHandler?.({ type: 'webShellReady' });

    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'webShellBootstrap',
        data: expect.objectContaining({ workspaceCwd: '/workspace-b' }),
      }),
    );
    const errors = host.postMessage.mock.calls.filter(
      ([message]) =>
        (message as { type?: string }).type === 'webShellBootstrapError',
    );
    expect(errors).toHaveLength(0);
  });

  it('keeps notifying live hosts after another host disposes', async () => {
    const context = createSharedContext();
    const first = await setupAttachedProvider({
      captureMessageHandler: true,
      context,
    });
    const second = await setupAttachedProvider({
      captureMessageHandler: true,
      context,
    });

    await first.messageHandler?.({ type: 'webShellReady' });
    await second.messageHandler?.({ type: 'webShellReady' });

    // A disposed host's subscription must not swallow the crash notice for
    // the hosts still alive.
    first.provider.dispose();
    const daemon = daemonMocks.instances[0];
    for (const listener of [...daemon.exitListeners]) listener();

    expect(second.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'webShellBootstrapError' }),
    );
    const firstErrors = first.postMessage.mock.calls.filter(
      ([message]) =>
        (message as { type?: string }).type === 'webShellBootstrapError',
    );
    expect(firstErrors).toHaveLength(0);
  });
});

describe('WebViewProvider web-shell permission bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMessageHandlerInstances.length = 0;
    mockQwenAgentManagerInstances.length = 0;
    mockGetPanel.mockReturnValue(null);
    mockConfigGet.mockImplementation(
      (_key: string, defaultValue: unknown) => defaultValue,
    );
    vi.spyOn(
      WebViewProvider.prototype as unknown as {
        initializeAgentConnection: () => Promise<void>;
      },
      'initializeAgentConnection',
    ).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function setupPendingWebShellPermission(requestId = 'req-1') {
    const setup = await setupAttachedProvider({
      captureMessageHandler: true,
    });
    await setup.messageHandler?.({
      type: 'webShellPermissionState',
      data: { pending: true, requestId },
    });
    return setup;
  }

  function decisionCalls(postMessage: ReturnType<typeof vi.fn>) {
    return postMessage.mock.calls.filter(
      ([message]) =>
        (message as { type?: string }).type === 'webShellPermissionDecision',
    );
  }

  it('routes accept to the request-owner webview', async () => {
    const { postMessage, provider } = await setupPendingWebShellPermission();
    const activePostMessage = vi.fn();
    mockGetPanel.mockReturnValue({
      webview: { postMessage: activePostMessage },
    } as never);

    provider.respondToPendingPermission('allow', {
      fromDiffEditor: true,
      permissionRequestId: 'req-1',
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'webShellPermissionDecision',
      data: { decision: 'allow', requestId: 'req-1' },
    });
    expect(decisionCalls(activePostMessage)).toHaveLength(0);
  });

  it('routes cancel as a reject decision', async () => {
    const { postMessage, provider } = await setupPendingWebShellPermission();

    provider.respondToPendingPermission('cancel', {
      fromDiffEditor: true,
      permissionRequestId: 'req-1',
    });

    expect(postMessage).toHaveBeenCalledWith({
      type: 'webShellPermissionDecision',
      data: { decision: 'reject', requestId: 'req-1' },
    });
  });

  it('does not vote when a diff command has no exact request id', async () => {
    const { postMessage, provider } = await setupPendingWebShellPermission();

    provider.respondToPendingPermission('allow', {
      fromDiffEditor: true,
    });

    expect(decisionCalls(postMessage)).toHaveLength(0);
  });

  it('falls back to the active webview while preserving the exact request id', async () => {
    const { postMessage, provider } = await setupPendingWebShellPermission();
    const activePostMessage = vi.fn();
    mockGetPanel.mockReturnValue({
      webview: { postMessage: activePostMessage },
    } as never);

    provider.respondToPendingPermission('allow', {
      fromDiffEditor: true,
      permissionRequestId: 'req-not-yet-mapped',
    });

    expect(decisionCalls(postMessage)).toHaveLength(0);
    expect(activePostMessage).toHaveBeenCalledWith({
      type: 'webShellPermissionDecision',
      data: { decision: 'allow', requestId: 'req-not-yet-mapped' },
    });
  });

  it('does not vote when the trigger is the original workspace file', async () => {
    const { postMessage, provider } = await setupPendingWebShellPermission();

    // qwen.diff.isVisible is also true on the user's own file while a diff
    // is open, so Ctrl+S there invokes qwen.diff.accept with a file: uri.
    // That must not resolve an approval the user may never have looked at.
    provider.respondToPendingPermission('allow', {
      fromDiffEditor: false,
      permissionRequestId: 'req-1',
    });
    provider.respondToPendingPermission('allow');

    expect(decisionCalls(postMessage)).toHaveLength(0);
  });

  it('uses the active webview before permission ownership state arrives', async () => {
    const setup = await setupAttachedProvider({ captureMessageHandler: true });

    setup.provider.respondToPendingPermission('allow', {
      fromDiffEditor: true,
      permissionRequestId: 'req-1',
    });

    expect(setup.postMessage).toHaveBeenCalledWith({
      type: 'webShellPermissionDecision',
      data: { decision: 'allow', requestId: 'req-1' },
    });
  });

  it('reports hasPendingPermission from the webview-pushed state', async () => {
    const setup = await setupAttachedProvider({ captureMessageHandler: true });

    // The extension command gate consults hasPendingPermission() before
    // asking the provider to vote; it must track the state the webview
    // pushes, not only the legacy ACP resolver.
    expect(setup.provider.hasPendingPermission()).toBe(false);

    await setup.messageHandler?.({
      type: 'webShellPermissionState',
      data: { pending: true, paths: [PENDING_DIFF_PATH] },
    });
    expect(setup.provider.hasPendingPermission()).toBe(true);

    await setup.messageHandler?.({
      type: 'webShellPermissionState',
      data: { pending: false, paths: [] },
    });
    expect(setup.provider.hasPendingPermission()).toBe(false);
  });

  it('clears the pending flag when the hosting view is disposed', async () => {
    const setup = await setupAttachedProvider({ captureMessageHandler: true });

    await setup.messageHandler?.({
      type: 'webShellPermissionState',
      data: { pending: true, paths: [PENDING_DIFF_PATH] },
    });
    expect(setup.provider.hasPendingPermission()).toBe(true);

    for (const listener of setup.viewDisposeListeners) listener();

    // Without a webview there is no route for the decision; leaving the
    // flag true would let a diff-editor accept find hasPendingPermission()
    // true, skip the vote, and close the diff while the daemon stays
    // blocked. The panel dispose path already resets it; the view-hosted
    // path must too.
    expect(setup.provider.hasPendingPermission()).toBe(false);
  });
});
