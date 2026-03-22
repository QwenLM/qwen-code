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
  insightReadyCallbackRef,
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
  insightReadyCallbackRef: {
    current: undefined as
      | ((event: { sessionId: string; path: string }) => void)
      | undefined,
  },
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
    onInsightReady = vi.fn(
      (callback: (event: { sessionId: string; path: string }) => void) => {
        insightReadyCallbackRef.current = callback;
      },
    );
    onEndTurn = vi.fn();
    onToolCall = vi.fn();
    onPlan = vi.fn();
    onPermissionRequest = vi.fn();
    onAskUserQuestion = vi.fn();
    disconnect = vi.fn();
  },
}));

vi.mock('../../services/conversationStore.js', () => ({
  ConversationStore: class {
    constructor(_context: unknown) {}
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
    slashCommandNotificationCallbackRef.current = undefined;
    insightReadyCallbackRef.current = undefined;
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
          void handler;
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

  it('offers to open the generated insight report', async () => {
    mockShowInformationMessage.mockResolvedValueOnce('Open Report');

    const webview = {
      options: undefined as unknown,
      html: '',
      postMessage: vi.fn(),
      asWebviewUri: vi.fn((uri: { fsPath: string }) => ({
        toString: () => `webview:${uri.fsPath}`,
      })),
      onDidReceiveMessage: vi.fn(
        (
          handler: (message: { type: string; data?: unknown }) => Promise<void>,
        ) => {
          void handler;
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

    insightReadyCallbackRef.current?.({
      sessionId: 'session-1',
      path: '/tmp/insight-report.html',
    });

    await Promise.resolve();

    expect(mockShowInformationMessage).toHaveBeenCalledWith(
      'Insight report generated successfully.',
      'Open Report',
    );
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
