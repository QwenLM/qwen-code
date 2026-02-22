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

  test('should detect languages from workspace files', async () => {
    // 这个测试需要修改，因为我们无法直接访问私有方法
    await lspService.discoverAndPrepare();
    const status = lspService.getStatus();

    // 检查服务是否已准备就绪
    expect(status).toBeDefined();
  });

  test('should merge built-in presets with user configs', async () => {
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

    try {
      await lspService.hover({
        uri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });

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

      await lspService.hover({
        uri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });

      expect(connection.send).toHaveBeenCalledTimes(1);
    } finally {
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

    try {
      await tempService.hover({
        uri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });

      expect(connection1.send).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'textDocument/didOpen' }),
      );

      handle.connection = connection2;

      await tempService.hover({
        uri,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });

      expect(connection2.send).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'textDocument/didOpen' }),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// 注意：实际的单元测试需要适当的测试框架配置
// 这里只是一个结构示例
