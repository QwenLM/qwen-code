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
const vscodeMock = vi.hoisted(() => {
  class Uri {
    fsPath: string;
    constructor(fsPath: string) {
      this.fsPath = fsPath;
    }
    static file(fsPath: string) {
      return new Uri(fsPath);
    }
  }

  return {
    Uri,
    workspace: {
      findFiles: vi.fn(),
      getWorkspaceFolder: vi.fn(),
      asRelativePath: vi.fn(),
      workspaceFolders: [],
    },
    window: {
      activeTextEditor: undefined,
      tabGroups: {
        all: [],
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

describe('FileMessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('filters ignored paths and includes request metadata in workspace files', async () => {
    const rootPath = '/workspace';
    const allowedPath = `${rootPath}/allowed.txt`;
    const ignoredPath = `${rootPath}/ignored.log`;

    const allowedUri = vscode.Uri.file(allowedPath);
    const ignoredUri = vscode.Uri.file(ignoredPath);

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
      data: { query: 'txt', requestId: 7 },
    });

    expect(vscodeMock.workspace.findFiles).toHaveBeenCalledWith(
      '**/*[tT][xX][tT]*',
      '**/{.git,node_modules}/**',
      50,
    );
    expect(shouldIgnoreFileMock).toHaveBeenCalledWith(ignoredPath, {
      respectGitIgnore: true,
      respectQwenIgnore: false,
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
    expect(payload.data.files).toHaveLength(1);
    expect(payload.data.files[0]?.path).toBe(allowedPath);
  });
});
