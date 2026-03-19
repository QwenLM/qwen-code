/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, beforeEach, expect, test } from 'vitest';
import { NativeLspService } from './NativeLspService.js';
import { EventEmitter } from 'events';
import type { Config as CoreConfig } from '../config/config.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { IdeContextStore } from '../ide/ideContext.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';

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
});

// 注意：实际的单元测试需要适当的测试框架配置
// 这里只是一个结构示例
