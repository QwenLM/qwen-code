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
} = vi.hoisted(() => ({
  mockCreateImagePathResolver: vi.fn(),
  mockGetGlobalTempDir: vi.fn(() => '/global-temp'),
  mockGetPanel: vi.fn<() => { webview: { postMessage: unknown } } | null>(
    () => null,
  ),
  mockOnDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  mockOnDidChangeTextEditorSelection: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  Storage: {
    getGlobalTempDir: mockGetGlobalTempDir,
  },
}));

vi.mock('vscode', () => ({
  Uri: {
    joinPath: vi.fn((base: { fsPath?: string }, ...parts: string[]) => ({
      fsPath: `${base.fsPath ?? ''}/${parts.join('/')}`.replace(/\/+/g, '/'),
    })),
    file: vi.fn((filePath: string) => ({ fsPath: filePath })),
  },
  window: {
    onDidChangeActiveTextEditor: mockOnDidChangeActiveTextEditor,
    onDidChangeTextEditorSelection: mockOnDidChangeTextEditorSelection,
    activeTextEditor: undefined,
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

describe('WebViewProvider.attachToView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPanel.mockReturnValue(null);
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
