/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateImagePathResolver,
  mockGetGlobalTempDir,
  mockOnDidChangeActiveTextEditor,
  mockOnDidChangeTextEditorSelection,
} = vi.hoisted(() => ({
  mockCreateImagePathResolver: vi.fn(),
  mockGetGlobalTempDir: vi.fn(() => '/global-temp'),
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
        return null;
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
    appendStreamContent = vi.fn();
    route = vi.fn();
  },
}));

vi.mock('./WebViewContent.js', () => ({
  WebViewContent: {
    generate: vi.fn(() => '<html />'),
  },
}));

vi.mock('../utils/imagePathResolver.js', () => ({
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
});
