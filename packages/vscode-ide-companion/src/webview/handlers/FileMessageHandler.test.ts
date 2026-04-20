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
  dispose: vi.fn(),
}));
const crawlCacheClearMock = vi.hoisted(() => vi.fn());

const watcherCallbacks = vi.hoisted(() => ({
  onDidCreate: [] as Array<() => void>,
  onDidDelete: [] as Array<() => void>,
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

  class RelativePattern {
    base: unknown;
    pattern: string;
    constructor(base: unknown, pattern: string) {
      this.base = base;
      this.pattern = pattern;
    }
  }

  return {
    Uri,
    RelativePattern,
    workspace: {
      findFiles: vi.fn(),
      getWorkspaceFolder: vi.fn(),
      asRelativePath: vi.fn(),
      workspaceFolders: [] as vscode.WorkspaceFolder[],
      createFileSystemWatcher: vi.fn(() => ({
        onDidCreate: vi.fn((cb: () => void) =>
          watcherCallbacks.onDidCreate.push(cb),
        ),
        onDidDelete: vi.fn((cb: () => void) =>
          watcherCallbacks.onDidDelete.push(cb),
        ),
        onDidChange: vi.fn(),
        dispose: vi.fn(),
      })),
      onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
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
vi.mock('@qwen-code/qwen-code-core/src/utils/filesearch/fileSearch.js', () => ({
  FileSearchFactory: {
    create: () => fileSearchMock,
  },
}));
vi.mock('@qwen-code/qwen-code-core/src/utils/filesearch/crawlCache.js', () => ({
  clear: crawlCacheClearMock,
}));

describe('FileMessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    watcherCallbacks.onDidCreate.length = 0;
    watcherCallbacks.onDidDelete.length = 0;
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

  it('disposes stale index when clearFileSearchCache fires during in-flight initialize()', async () => {
    // Regression: the cache-invalidation path previously left the in-flight
    // `initialize()` alive. When that promise resolved after
    // clearFileSearchCache, the finally-path still stored the (now stale)
    // search under the same rootPath, and a subsequent getWorkspaceFiles
    // call would happily search against the outdated index.
    const rootPath = '/workspace';
    vscodeMock.workspace.workspaceFolders = [
      { uri: vscode.Uri.file(rootPath), name: 'workspace', index: 0 },
    ];

    // Deferred initialize: the race only matters while initialize() is
    // pending. Resolving it by hand lets the test interleave the watcher
    // callback deterministically.
    let resolveInit!: () => void;
    fileSearchMock.initialize.mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveInit = res;
        }),
    );
    fileSearchMock.search.mockResolvedValue([]);

    const sendToWebView = vi.fn();
    const handler = new FileMessageHandler(
      {} as QwenAgentManager,
      {} as ConversationStore,
      null,
      sendToWebView,
    );
    // Attach watchers so the clear callback exists.
    handler.setupFileWatchers();
    expect(watcherCallbacks.onDidCreate.length).toBeGreaterThan(0);

    // Kick off a query that triggers getOrCreateFileSearch; awaiting this
    // promise deadlocks until initialize() resolves, so we must invalidate
    // the cache mid-flight before releasing init.
    const inflight = handler.handle({
      type: 'getWorkspaceFiles',
      data: { query: 'foo', requestId: 1 },
    });

    // Let the handler schedule its await initialize() before we invalidate.
    await Promise.resolve();

    // File-system watcher fires — clearFileSearchCache removes the entry
    // from fileSearchInitializing while the init is still pending.
    for (const cb of watcherCallbacks.onDidCreate) {
      cb();
    }

    // Now let initialize() resolve; the race-guard inside the init promise
    // should detect the invalidation and dispose the search rather than
    // re-caching it.
    resolveInit();
    await inflight;

    expect(fileSearchMock.dispose).toHaveBeenCalled();
    // The stale search must never have been asked to run the query —
    // getOrCreateFileSearch returned null and the caller skipped.
    expect(fileSearchMock.search).not.toHaveBeenCalled();
  });
});
