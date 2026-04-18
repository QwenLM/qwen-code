/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateImagePathResolver,
  mockGetGlobalTempDir,
  mockGetPanel,
  mockOnDidChangeActiveTextEditor,
  mockOnDidChangeTextEditorSelection,
  mockShowInformationMessage,
  mockOpenExternal,
  slashCommandNotificationCallbackRef,
} = vi.hoisted(() => ({
  mockCreateImagePathResolver: vi.fn(),
  mockGetGlobalTempDir: vi.fn(() => '/global-temp'),
  mockGetPanel: vi.fn<() => { webview: { postMessage: unknown } } | null>(
    () => null,
  ),
  mockOnDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  mockOnDidChangeTextEditorSelection: vi.fn(() => ({ dispose: vi.fn() })),
  mockShowInformationMessage: vi.fn(),
  mockOpenExternal: vi.fn(),
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
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  Storage: {
    getGlobalTempDir: mockGetGlobalTempDir,
  },
  parseInsightMessage: vi.fn((message: string) => {
    try {
      const parsed = JSON.parse(message) as {
        insight_progress?: {
          stage?: unknown;
          progress?: unknown;
          detail?: unknown;
        };
        insight_ready?: { path?: unknown };
      };

      if (parsed.insight_progress) {
        const { stage, progress, detail } = parsed.insight_progress;
        if (typeof stage === 'string' && typeof progress === 'number') {
          return {
            type: 'insight_progress',
            stage,
            progress,
            detail: typeof detail === 'string' ? detail : undefined,
          };
        }
      }

      if (parsed.insight_ready) {
        const { path } = parsed.insight_ready;
        if (typeof path === 'string') {
          return {
            type: 'insight_ready',
            path,
          };
        }
      }
    } catch {
      return null;
    }

    return null;
  }),
}));

vi.mock('vscode', () => ({
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
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/workspace-root' } }],
  },
  commands: {
    executeCommand: vi.fn(),
  },
}));

vi.mock('../../services/qwenAgentManager.js', () => ({
  QwenAgentManager: class {
    isConnected = false;
    currentSessionId = null;
    connect = vi.fn();
    createNewSession = vi.fn();
    setModelFromUi = vi.fn();
    onMessage = vi.fn();
    onStreamChunk = vi.fn();
    onThoughtChunk = vi.fn();
    onModeInfo = vi.fn();
    onModeChanged = vi.fn();
    onUsageUpdate = vi.fn();
    onModelInfo = vi.fn();
    onModelChanged = vi.fn();
    onAvailableCommands = vi.fn();
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
    onEndTurn = vi.fn();
    onToolCall = vi.fn();
    onPlan = vi.fn();
    onPermissionRequest = vi.fn();
    onAskUserQuestion = vi.fn();
    onDisconnected = vi.fn();
    disconnect = vi.fn();
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
    ) {}
    setLoginHandler = vi.fn();
    setPermissionHandler = vi.fn();
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

describe('WebViewProvider.attachToView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPanel.mockReturnValue(null);
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

  it('exposes a persistent insight report entry from slash-command ready markers without auto-opening it', async () => {
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
    expect(mockShowInformationMessage).not.toHaveBeenCalled();
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('reopens the latest insight report when requested from the webview', async () => {
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
