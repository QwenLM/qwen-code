/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QwenAgentManager } from '../../services/qwenAgentManager.js';
import type { ConversationStore } from '../../services/conversationStore.js';
import { FileMessageHandler } from './FileMessageHandler.js';
import * as vscode from 'vscode';

const shouldIgnoreFileMock = vi.hoisted(() => vi.fn());
const fileSearchMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  search: vi.fn(),
}));

const vscodeMock = vi.hoisted(() => {
  class Uri {
    fsPath: string;
    constructor(fsPath: string) {
      this.fsPath = fsPath;
    }
    static file(fsPath: string) {
      return new Uri(fsPath);
    }
    static joinPath(base: Uri, ...pathSegments: string[]) {
      return new Uri(`${base.fsPath}/${pathSegments.join('/')}`);
    }
  }

  return {
    Uri,
    ViewColumn: { One: 1, Two: 2, Three: 3, Beside: -2 },
    workspace: {
      findFiles: vi.fn(),
      getWorkspaceFolder: vi.fn(),
      asRelativePath: vi.fn(),
      openTextDocument: vi.fn(),
      workspaceFolders: [] as vscode.WorkspaceFolder[],
      createFileSystemWatcher: vi.fn(() => ({
        onDidCreate: vi.fn(),
        onDidDelete: vi.fn(),
        onDidChange: vi.fn(),
        dispose: vi.fn(),
      })),
      onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
    },
    window: {
      activeTextEditor: undefined,
      showTextDocument: vi.fn(),
      tabGroups: {
        all: [] as Array<{
          tabs: Array<{ input: unknown }>;
          viewColumn: number;
        }>,
      },
    },
  };
});

vi.mock('vscode', () => vscodeMock);
vi.mock(
  '@qwen-code/qwen-code-core/src/services/fileDiscoveryService.js',
  () => ({
    FileDiscoveryService: class {
      shouldIgnoreFile(filePath: string, options?: unknown) {
        return shouldIgnoreFileMock(filePath, options);
      }
    },
  }),
);
vi.mock('@qwen-code/qwen-code-core/src/utils/filesearch/fileSearch.js', () => ({
  FileSearchFactory: {
    create: () => fileSearchMock,
  },
}));
vi.mock('@qwen-code/qwen-code-core/src/utils/filesearch/crawlCache.js', () => ({
  clear: vi.fn(),
}));

const readonlyProviderMock = vi.hoisted(() => ({
  createUri: vi.fn(),
  setContent: vi.fn(),
  getInstance: vi.fn(),
}));
vi.mock('../../services/readonlyFileSystemProvider.js', () => ({
  ReadonlyFileSystemProvider: readonlyProviderMock,
}));

describe('FileMessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('searches files using fuzzy search when query is provided', async () => {
    const rootPath = '/workspace';

    vscodeMock.workspace.workspaceFolders = [
      { uri: vscode.Uri.file(rootPath), name: 'workspace', index: 0 },
    ];

    fileSearchMock.initialize.mockResolvedValue(undefined);
    fileSearchMock.search.mockResolvedValue([
      'src/test.txt',
      'docs/readme.txt',
    ]);

    const sendToWebView = vi.fn();
    const handler = new FileMessageHandler(
      {} as QwenAgentManager,
      {} as ConversationStore,
      null,
      sendToWebView,
    );

    await handler.handle({
      type: 'getWorkspaceFiles',
      data: { query: 'txt', requestId: 7 },
    });

    expect(fileSearchMock.search).toHaveBeenCalledWith('txt', {
      maxResults: 50,
    });

    expect(sendToWebView).toHaveBeenCalledTimes(1);
    const payload = sendToWebView.mock.calls[0]?.[0] as {
      type: string;
      data: {
        files: Array<{ path: string }>;
        query?: string;
        requestId?: number;
      };
    };

    expect(payload.type).toBe('workspaceFiles');
    expect(payload.data.requestId).toBe(7);
    expect(payload.data.query).toBe('txt');
    expect(payload.data.files).toHaveLength(2);
  });

  it('filters ignored paths in non-query mode', async () => {
    const rootPath = '/workspace';
    const allowedPath = `${rootPath}/allowed.txt`;
    const ignoredPath = `${rootPath}/ignored.log`;

    const allowedUri = vscode.Uri.file(allowedPath);
    const ignoredUri = vscode.Uri.file(ignoredPath);

    vscodeMock.workspace.workspaceFolders = [];
    vscodeMock.workspace.findFiles.mockResolvedValue([allowedUri, ignoredUri]);
    vscodeMock.workspace.getWorkspaceFolder.mockImplementation(() => ({
      uri: vscode.Uri.file(rootPath),
    }));
    vscodeMock.workspace.asRelativePath.mockImplementation((uri: vscode.Uri) =>
      uri.fsPath.replace(`${rootPath}/`, ''),
    );

    shouldIgnoreFileMock.mockImplementation((filePath: string) =>
      filePath.includes('ignored'),
    );

    const sendToWebView = vi.fn();
    const handler = new FileMessageHandler(
      {} as QwenAgentManager,
      {} as ConversationStore,
      null,
      sendToWebView,
    );

    await handler.handle({
      type: 'getWorkspaceFiles',
      data: { requestId: 7 },
    });

    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledWith(
      '**/*',
      '**/{.git,node_modules}/**',
      20,
    );
    expect(shouldIgnoreFileMock).toHaveBeenCalledWith(ignoredPath, {
      respectGitIgnore: true,
      respectQwenIgnore: false,
    });

    const payload = sendToWebView.mock.calls[
      sendToWebView.mock.calls.length - 1
    ]?.[0] as {
      type: string;
      data: {
        files: Array<{ path: string }>;
        query?: string;
        requestId?: number;
      };
    };

    expect(payload.type).toBe('workspaceFiles');
    expect(payload.data.requestId).toBe(7);
  });

  describe('createAndOpenTempFile viewColumn selection', () => {
    const chatViewType = 'mainThreadWebview-qwenCode.chat';

    beforeEach(() => {
      vi.clearAllMocks();
      readonlyProviderMock.getInstance.mockReturnValue(readonlyProviderMock);
      readonlyProviderMock.createUri.mockReturnValue(
        vscodeMock.Uri.file('/tmp/temp.txt'),
      );
      readonlyProviderMock.setContent.mockReturnValue(undefined);
      vscodeMock.workspace.openTextDocument.mockResolvedValue({
        uri: vscodeMock.Uri.file('/tmp/temp.txt'),
      });
      vscodeMock.window.showTextDocument.mockResolvedValue(undefined);
      // ensure the existing-tab search finds nothing
      vscodeMock.window.tabGroups.all = [];
    });

    function chatTab() {
      return { input: { viewType: chatViewType as unknown } };
    }

    function regularTab() {
      return { input: { viewType: 'default' as unknown } };
    }

    it('opens in left group when chat webview has a left neighbor', async () => {
      vscodeMock.window.tabGroups.all = [
        { tabs: [regularTab()], viewColumn: 1 },
        { tabs: [chatTab()], viewColumn: 2 },
      ];

      const sendToWebView = vi.fn();
      const handler = new FileMessageHandler(
        {} as QwenAgentManager,
        {} as ConversationStore,
        null,
        sendToWebView,
      );

      await handler.handle({
        type: 'createAndOpenTempFile' as never,
        data: { content: 'hello', fileName: 'test.txt' },
      });

      expect(vscodeMock.window.showTextDocument).toHaveBeenCalledTimes(1);
      const options = vscodeMock.window.showTextDocument.mock.calls[0]?.[1] as {
        viewColumn: number;
      };
      expect(options.viewColumn).toBe(1);
    });

    it('opens in right group when no left neighbor but right exists', async () => {
      vscodeMock.window.tabGroups.all = [
        { tabs: [chatTab()], viewColumn: 1 },
        { tabs: [regularTab()], viewColumn: 2 },
      ];

      const sendToWebView = vi.fn();
      const handler = new FileMessageHandler(
        {} as QwenAgentManager,
        {} as ConversationStore,
        null,
        sendToWebView,
      );

      await handler.handle({
        type: 'createAndOpenTempFile' as never,
        data: { content: 'hello', fileName: 'test.txt' },
      });

      expect(vscodeMock.window.showTextDocument).toHaveBeenCalledTimes(1);
      const options = vscodeMock.window.showTextDocument.mock.calls[0]?.[1] as {
        viewColumn: number;
      };
      expect(options.viewColumn).toBe(2);
    });

    it('falls back to ViewColumn.Beside when neither left nor right neighbor exists', async () => {
      vscodeMock.window.tabGroups.all = [{ tabs: [chatTab()], viewColumn: 1 }];

      const sendToWebView = vi.fn();
      const handler = new FileMessageHandler(
        {} as QwenAgentManager,
        {} as ConversationStore,
        null,
        sendToWebView,
      );

      await handler.handle({
        type: 'createAndOpenTempFile' as never,
        data: { content: 'hello', fileName: 'test.txt' },
      });

      expect(vscodeMock.window.showTextDocument).toHaveBeenCalledTimes(1);
      const options = vscodeMock.window.showTextDocument.mock.calls[0]?.[1] as {
        viewColumn: number;
      };
      expect(options.viewColumn).toBe(vscodeMock.ViewColumn.Beside);
    });
  });
});
