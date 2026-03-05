/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, beforeEach, expect, test, vi } from 'vitest';
import { NativeLspService } from './NativeLspService.js';
import { EventEmitter } from 'events';
import type { Config as CoreConfig } from '../config/config.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { IdeContextStore } from '../ide/ideContext.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// 模拟依赖项
class MockConfig {
  rootPath = '/test/workspace';

  isTrustedFolder(): boolean {
    return true;
  }

  get(_key: string) {
    return undefined;
  }

  getProjectRoot(): string {
    return this.rootPath;
  }
}

class MockWorkspaceContext {
  rootPath = '/test/workspace';

  async fileExists(_path: string): Promise<boolean> {
    return _path.endsWith('.json') || _path.includes('package.json');
  }

  async readFile(_path: string): Promise<string> {
    if (_path.includes('.lsp.json')) {
      return JSON.stringify({
        typescript: {
          command: 'typescript-language-server',
          args: ['--stdio'],
          transport: 'stdio',
        },
      });
    }
    return '{}';
  }

  resolvePath(_path: string): string {
    return this.rootPath + '/' + _path;
  }

  isPathWithinWorkspace(_path: string): boolean {
    return true;
  }

  getDirectories(): string[] {
    return [this.rootPath];
  }
}

class MockFileDiscoveryService {
  async discoverFiles(_root: string, _options: unknown): Promise<string[]> {
    // 模拟发现一些文件
    return [
      '/test/workspace/src/index.ts',
      '/test/workspace/src/utils.ts',
      '/test/workspace/server.py',
      '/test/workspace/main.go',
    ];
  }

  shouldIgnoreFile(): boolean {
    return false;
  }
}

class MockIdeContextStore {
  // 模拟 IDE 上下文存储
}

describe('NativeLspService', () => {
  let lspService: NativeLspService;
  let mockConfig: MockConfig;
  let mockWorkspace: MockWorkspaceContext;
  let mockFileDiscovery: MockFileDiscoveryService;
  let mockIdeStore: MockIdeContextStore;
  let eventEmitter: EventEmitter;

  beforeEach(() => {
    mockConfig = new MockConfig();
    mockWorkspace = new MockWorkspaceContext();
    mockFileDiscovery = new MockFileDiscoveryService();
    mockIdeStore = new MockIdeContextStore();
    eventEmitter = new EventEmitter();

    lspService = new NativeLspService(
      mockConfig as unknown as CoreConfig,
      mockWorkspace as unknown as WorkspaceContext,
      eventEmitter,
      mockFileDiscovery as unknown as FileDiscoveryService,
      mockIdeStore as unknown as IdeContextStore,
    );
  });

  test('should initialize correctly', () => {
    expect(lspService).toBeDefined();
  });

  test('discoverAndPrepare should not invoke language detection', async () => {
    const service = new NativeLspService(
      mockConfig as unknown as CoreConfig,
      mockWorkspace as unknown as WorkspaceContext,
      eventEmitter,
      mockFileDiscovery as unknown as FileDiscoveryService,
      mockIdeStore as unknown as IdeContextStore,
    );

    const detectLanguages = vi.fn(async () => {
      throw new Error('detectLanguages should not be called');
    });
    (
      service as unknown as {
        languageDetector: { detectLanguages: () => Promise<string[]> };
      }
    ).languageDetector = { detectLanguages };

    await expect(service.discoverAndPrepare()).resolves.toBeUndefined();
    expect(detectLanguages).not.toHaveBeenCalled();
  });

  test('should prepare configs without language detection', async () => {
    await lspService.discoverAndPrepare();
    const status = lspService.getStatus();

    // 检查服务是否已准备就绪
    expect(status).toBeDefined();
  });

  test('should open document before hover requests', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-test-'));
    const filePath = path.join(tempDir, 'main.cpp');
    fs.writeFileSync(filePath, 'int main(){return 0;}\n', 'utf-8');
    const uri = pathToFileURL(filePath).toString();

    const events: string[] = [];
    const connection = {
      listen: vi.fn(),
      send: vi.fn((message: { method?: string }) => {
        events.push(`send:${message.method ?? 'unknown'}`);
      }),
      onNotification: vi.fn(),
      onRequest: vi.fn(),
      request: vi.fn(async (method: string) => {
        events.push(`request:${method}`);
        return null;
      }),
      initialize: vi.fn(async () => ({})),
      shutdown: vi.fn(async () => {}),
      end: vi.fn(),
    };

    const handle = {
      config: {
        name: 'clangd',
        languages: ['cpp'],
        command: 'clangd',
        args: [],
        transport: 'stdio',
      },
      status: 'READY',
      connection,
    };

    const serverManager = {
      getHandles: () => new Map([['clangd', handle]]),
      warmupTypescriptServer: vi.fn(),
    };

    (lspService as unknown as { serverManager: unknown }).serverManager =
      serverManager;

    vi.useFakeTimers();
    try {
      const promise1 = lspService.hover({
        uri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });
      await vi.runAllTimersAsync();
      await promise1;

      expect(connection.send).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'textDocument/didOpen',
          params: {
            textDocument: expect.objectContaining({
              uri,
              languageId: 'cpp',
            }),
          },
        }),
      );
      expect(connection.request).toHaveBeenCalledWith(
        'textDocument/hover',
        expect.any(Object),
      );
      expect(events[0]).toBe('send:textDocument/didOpen');

      const promise2 = lspService.hover({
        uri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });
      await vi.runAllTimersAsync();
      await promise2;

      expect(connection.send).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('should open a workspace file before workspace symbol search', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-symbol-'));
    const workspaceFile = path.join(tempDir, 'src', 'main.cpp');
    fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
    fs.writeFileSync(workspaceFile, 'int main(){return 0;}\n', 'utf-8');
    const workspaceUri = pathToFileURL(workspaceFile).toString();

    const events: string[] = [];
    let opened = false;
    const connection = {
      listen: vi.fn(),
      send: vi.fn((message: { method?: string }) => {
        events.push(`send:${message.method ?? 'unknown'}`);
        if (message.method === 'textDocument/didOpen') {
          opened = true;
        }
      }),
      onNotification: vi.fn(),
      onRequest: vi.fn(),
      request: vi.fn(async (method: string) => {
        events.push(`request:${method}`);
        if (method === 'workspace/symbol') {
          return opened
            ? [
                {
                  name: 'Calculator',
                  kind: 5,
                  location: {
                    uri: workspaceUri,
                    range: {
                      start: { line: 0, character: 0 },
                      end: { line: 0, character: 10 },
                    },
                  },
                },
              ]
            : [];
        }
        return null;
      }),
      initialize: vi.fn(async () => ({})),
      shutdown: vi.fn(async () => {}),
      end: vi.fn(),
    };

    const handle = {
      config: {
        name: 'clangd',
        languages: ['cpp'],
        command: 'clangd',
        args: [],
        transport: 'stdio',
      },
      status: 'READY',
      connection,
    };

    const serverManager = {
      getHandles: () => new Map([['clangd', handle]]),
      warmupTypescriptServer: vi.fn(),
      isTypescriptServer: () => false,
    };

    const tempConfig = new MockConfig();
    tempConfig.rootPath = tempDir;
    const tempWorkspace = new MockWorkspaceContext();
    tempWorkspace.rootPath = tempDir;
    const tempDiscovery = new MockFileDiscoveryService();
    const tempIdeStore = new MockIdeContextStore();
    const tempEmitter = new EventEmitter();

    const tempService = new NativeLspService(
      tempConfig as unknown as CoreConfig,
      tempWorkspace as unknown as WorkspaceContext,
      tempEmitter,
      tempDiscovery as unknown as FileDiscoveryService,
      tempIdeStore as unknown as IdeContextStore,
      { workspaceRoot: tempDir },
    );

    (tempService as unknown as { serverManager: unknown }).serverManager =
      serverManager;

    vi.useFakeTimers();
    try {
      const promise = tempService.workspaceSymbols('Calculator');
      await vi.runAllTimersAsync();
      const results = await promise;

      expect(connection.send).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'textDocument/didOpen',
        }),
      );
      expect(events[0]).toBe('send:textDocument/didOpen');
      expect(results.length).toBe(1);
    } finally {
      vi.useRealTimers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('should retry workspace symbols after warmup when initial result is empty', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-symbol-retry-'));
    const workspaceFile = path.join(tempDir, 'src', 'main.cpp');
    fs.mkdirSync(path.dirname(workspaceFile), { recursive: true });
    fs.writeFileSync(workspaceFile, 'int main(){return 0;}\n', 'utf-8');
    const workspaceUri = pathToFileURL(workspaceFile).toString();

    const events: string[] = [];
    let opened = false;
    let symbolCalls = 0;
    const connection = {
      listen: vi.fn(),
      send: vi.fn((message: { method?: string }) => {
        events.push(`send:${message.method ?? 'unknown'}`);
        if (message.method === 'textDocument/didOpen') {
          opened = true;
        }
      }),
      onNotification: vi.fn(),
      onRequest: vi.fn(),
      request: vi.fn(async (method: string) => {
        events.push(`request:${method}`);
        if (method === 'workspace/symbol') {
          symbolCalls += 1;
          if (!opened) {
            return [];
          }
          if (symbolCalls === 1) {
            return [];
          }
          return [
            {
              name: 'Calculator',
              kind: 5,
              location: {
                uri: workspaceUri,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 10 },
                },
              },
            },
          ];
        }
        return null;
      }),
      initialize: vi.fn(async () => ({})),
      shutdown: vi.fn(async () => {}),
      end: vi.fn(),
    };

    const handle = {
      config: {
        name: 'clangd',
        languages: ['cpp'],
        command: 'clangd',
        args: [],
        transport: 'stdio',
      },
      status: 'READY',
      connection,
    };

    const serverManager = {
      getHandles: () => new Map([['clangd', handle]]),
      warmupTypescriptServer: vi.fn(),
      isTypescriptServer: () => false,
    };

    const tempConfig = new MockConfig();
    tempConfig.rootPath = tempDir;
    const tempWorkspace = new MockWorkspaceContext();
    tempWorkspace.rootPath = tempDir;
    const tempDiscovery = new MockFileDiscoveryService();
    const tempIdeStore = new MockIdeContextStore();
    const tempEmitter = new EventEmitter();

    const tempService = new NativeLspService(
      tempConfig as unknown as CoreConfig,
      tempWorkspace as unknown as WorkspaceContext,
      tempEmitter,
      tempDiscovery as unknown as FileDiscoveryService,
      tempIdeStore as unknown as IdeContextStore,
      { workspaceRoot: tempDir },
    );

    (tempService as unknown as { serverManager: unknown }).serverManager =
      serverManager;

    vi.useFakeTimers();
    try {
      const promise = tempService.workspaceSymbols('Calculator');
      await vi.runAllTimersAsync();
      const results = await promise;

      expect(symbolCalls).toBe(2);
      expect(results.length).toBe(1);
      expect(events[0]).toBe('send:textDocument/didOpen');
    } finally {
      vi.useRealTimers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('should not retry workspace symbols when no warmup file is available', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-symbol-empty-'));

    let symbolCalls = 0;
    const connection = {
      listen: vi.fn(),
      send: vi.fn(),
      onNotification: vi.fn(),
      onRequest: vi.fn(),
      request: vi.fn(async (method: string) => {
        if (method === 'workspace/symbol') {
          symbolCalls += 1;
          return [];
        }
        return null;
      }),
      initialize: vi.fn(async () => ({})),
      shutdown: vi.fn(async () => {}),
      end: vi.fn(),
    };

    const handle = {
      config: {
        name: 'clangd',
        languages: ['cpp'],
        command: 'clangd',
        args: [],
        transport: 'stdio',
      },
      status: 'READY',
      connection,
    };

    const serverManager = {
      getHandles: () => new Map([['clangd', handle]]),
      warmupTypescriptServer: vi.fn(),
      isTypescriptServer: () => false,
    };

    const tempConfig = new MockConfig();
    tempConfig.rootPath = tempDir;
    const tempWorkspace = new MockWorkspaceContext();
    tempWorkspace.rootPath = tempDir;
    const tempDiscovery = new MockFileDiscoveryService();
    const tempIdeStore = new MockIdeContextStore();
    const tempEmitter = new EventEmitter();

    const tempService = new NativeLspService(
      tempConfig as unknown as CoreConfig,
      tempWorkspace as unknown as WorkspaceContext,
      tempEmitter,
      tempDiscovery as unknown as FileDiscoveryService,
      tempIdeStore as unknown as IdeContextStore,
      { workspaceRoot: tempDir },
    );

    (tempService as unknown as { serverManager: unknown }).serverManager =
      serverManager;

    vi.useFakeTimers();
    try {
      const promise = tempService.workspaceSymbols('Calculator');
      await vi.runAllTimersAsync();
      await promise;

      expect(symbolCalls).toBe(1);
    } finally {
      vi.useRealTimers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('should reopen documents after connection changes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-reopen-'));
    const filePath = path.join(tempDir, 'main.cpp');
    fs.writeFileSync(filePath, 'int main(){return 0;}\n', 'utf-8');
    const uri = pathToFileURL(filePath).toString();

    const connection1 = {
      listen: vi.fn(),
      send: vi.fn(),
      onNotification: vi.fn(),
      onRequest: vi.fn(),
      request: vi.fn(async () => null),
      initialize: vi.fn(async () => ({})),
      shutdown: vi.fn(async () => {}),
      end: vi.fn(),
    };
    const connection2 = {
      listen: vi.fn(),
      send: vi.fn(),
      onNotification: vi.fn(),
      onRequest: vi.fn(),
      request: vi.fn(async () => null),
      initialize: vi.fn(async () => ({})),
      shutdown: vi.fn(async () => {}),
      end: vi.fn(),
    };

    const handle = {
      config: {
        name: 'clangd',
        languages: ['cpp'],
        command: 'clangd',
        args: [],
        transport: 'stdio',
      },
      status: 'READY',
      connection: connection1,
    };

    const serverManager = {
      getHandles: () => new Map([['clangd', handle]]),
      warmupTypescriptServer: vi.fn(),
    };

    const tempConfig = new MockConfig();
    tempConfig.rootPath = tempDir;
    const tempWorkspace = new MockWorkspaceContext();
    tempWorkspace.rootPath = tempDir;
    const tempDiscovery = new MockFileDiscoveryService();
    const tempIdeStore = new MockIdeContextStore();
    const tempEmitter = new EventEmitter();

    const tempService = new NativeLspService(
      tempConfig as unknown as CoreConfig,
      tempWorkspace as unknown as WorkspaceContext,
      tempEmitter,
      tempDiscovery as unknown as FileDiscoveryService,
      tempIdeStore as unknown as IdeContextStore,
      { workspaceRoot: tempDir },
    );

    (tempService as unknown as { serverManager: unknown }).serverManager =
      serverManager;

    vi.useFakeTimers();
    try {
      const promise1 = tempService.hover({
        uri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });
      await vi.runAllTimersAsync();
      await promise1;

      expect(connection1.send).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'textDocument/didOpen' }),
      );

      handle.connection = connection2;

      const promise2 = tempService.hover({
        uri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });
      await vi.runAllTimersAsync();
      await promise2;

      expect(connection2.send).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'textDocument/didOpen' }),
      );
    } finally {
      vi.useRealTimers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  test('should delay after fresh document open then send request', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-delay-'));
    const filePath = path.join(tempDir, 'main.cpp');
    fs.writeFileSync(filePath, 'int main(){return 0;}\n', 'utf-8');
    const uri = pathToFileURL(filePath).toString();

    const timeline: Array<{ event: string; time: number }> = [];
    const connection = {
      listen: vi.fn(),
      send: vi.fn((message: { method?: string }) => {
        if (message.method === 'textDocument/didOpen') {
          timeline.push({ event: 'didOpen', time: Date.now() });
        }
      }),
      onNotification: vi.fn(),
      onRequest: vi.fn(),
      request: vi.fn(async (method: string) => {
        if (method === 'textDocument/definition') {
          timeline.push({ event: 'definition', time: Date.now() });
          return [
            {
              uri,
              range: {
                start: { line: 0, character: 4 },
                end: { line: 0, character: 8 },
              },
            },
          ];
        }
        return null;
      }),
      initialize: vi.fn(async () => ({})),
      shutdown: vi.fn(async () => {}),
      end: vi.fn(),
    };

    const handle = {
      config: {
        name: 'clangd',
        languages: ['cpp'],
        command: 'clangd',
        args: [],
        transport: 'stdio',
      },
      status: 'READY',
      connection,
    };

    const serverManager = {
      getHandles: () => new Map([['clangd', handle]]),
      warmupTypescriptServer: vi.fn(),
    };

    (lspService as unknown as { serverManager: unknown }).serverManager =
      serverManager;

    vi.useFakeTimers();
    try {
      const promise = lspService.definitions({
        uri,
        range: {
          start: { line: 0, character: 4 },
          end: { line: 0, character: 4 },
        },
      });
      await vi.runAllTimersAsync();
      const results = await promise;

      // Verify didOpen fires before the definition request
      expect(timeline.length).toBe(2);
      expect(timeline[0]!.event).toBe('didOpen');
      expect(timeline[1]!.event).toBe('definition');
      // The delay should have elapsed between the two events (200ms)
      expect(timeline[1]!.time - timeline[0]!.time).toBeGreaterThanOrEqual(200);
      expect(results.length).toBe(1);
    } finally {
      vi.useRealTimers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('should skip delay when document is already open', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-nodelay-'));
    const filePath = path.join(tempDir, 'main.cpp');
    fs.writeFileSync(filePath, 'int main(){return 0;}\n', 'utf-8');
    const uri = pathToFileURL(filePath).toString();

    let didOpenCount = 0;
    const connection = {
      listen: vi.fn(),
      send: vi.fn((message: { method?: string }) => {
        if (message.method === 'textDocument/didOpen') {
          didOpenCount += 1;
        }
      }),
      onNotification: vi.fn(),
      onRequest: vi.fn(),
      request: vi.fn(async () => null),
      initialize: vi.fn(async () => ({})),
      shutdown: vi.fn(async () => {}),
      end: vi.fn(),
    };

    const handle = {
      config: {
        name: 'clangd',
        languages: ['cpp'],
        command: 'clangd',
        args: [],
        transport: 'stdio',
      },
      status: 'READY',
      connection,
    };

    const serverManager = {
      getHandles: () => new Map([['clangd', handle]]),
      warmupTypescriptServer: vi.fn(),
    };

    (lspService as unknown as { serverManager: unknown }).serverManager =
      serverManager;

    vi.useFakeTimers();
    try {
      // First hover opens the document
      const promise1 = lspService.hover({
        uri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });
      await vi.runAllTimersAsync();
      await promise1;
      expect(didOpenCount).toBe(1);

      // Second hover should not re-open or delay
      const startTime = Date.now();
      const promise2 = lspService.hover({
        uri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });
      await vi.runAllTimersAsync();
      await promise2;
      const elapsed = Date.now() - startTime;

      expect(didOpenCount).toBe(1);
      // No delay should have been triggered (well under 200ms with fake timers)
      expect(elapsed).toBeLessThan(200);
    } finally {
      vi.useRealTimers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('should not send duplicate didOpen for warmup-opened URI on subsequent requests', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-warmup-track-'));
    const queryFilePath = path.join(tempDir, 'main.cpp');
    const warmupFilePath = path.join(tempDir, 'index.ts');
    fs.writeFileSync(queryFilePath, 'int main(){return 0;}\n', 'utf-8');
    fs.writeFileSync(warmupFilePath, 'export const x = 1;\n', 'utf-8');
    const queryUri = pathToFileURL(queryFilePath).toString();
    const warmupUri = pathToFileURL(warmupFilePath).toString();

    const didOpenUris: string[] = [];
    const connection = {
      listen: vi.fn(),
      send: vi.fn(
        (message: {
          method?: string;
          params?: { textDocument?: { uri?: string } };
        }) => {
          if (message.method === 'textDocument/didOpen') {
            didOpenUris.push(message.params?.textDocument?.uri ?? '');
          }
        },
      ),
      onNotification: vi.fn(),
      onRequest: vi.fn(),
      request: vi.fn(async () => null),
      initialize: vi.fn(async () => ({})),
      shutdown: vi.fn(async () => {}),
      end: vi.fn(),
    };

    const handle = {
      config: {
        name: 'typescript',
        languages: ['typescript'],
        command: 'typescript-language-server',
        args: ['--stdio'],
        transport: 'stdio',
      },
      status: 'READY',
      connection,
    };

    // First call: warmup returns warmupUri (different from queryUri)
    const serverManager = {
      getHandles: () => new Map([['typescript', handle]]),
      warmupTypescriptServer: vi.fn(async () => warmupUri),
    };

    (lspService as unknown as { serverManager: unknown }).serverManager =
      serverManager;

    vi.useFakeTimers();
    try {
      // First request: opens queryUri via ensureDocumentOpen, warmup returns warmupUri
      const promise1 = lspService.hover({
        uri: queryUri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });
      await vi.runAllTimersAsync();
      await promise1;

      // queryUri should have been opened via ensureDocumentOpen
      expect(didOpenUris).toContain(queryUri);
      const countAfterFirst = didOpenUris.length;

      // Second request: for warmupUri which was already tracked from warmup
      const promise2 = lspService.hover({
        uri: warmupUri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });
      await vi.runAllTimersAsync();
      await promise2;

      // warmupUri should NOT have been opened again via ensureDocumentOpen
      // because it was tracked from the warmup in the first call
      expect(didOpenUris.length).toBe(countAfterFirst);
    } finally {
      vi.useRealTimers();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
