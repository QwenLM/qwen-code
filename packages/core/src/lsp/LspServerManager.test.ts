/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Config as CoreConfig } from '../config/config.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import { LspServerManager } from './LspServerManager.js';
import type { LspConnectionResult, LspServerConfig } from './types.js';

const debugLoggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: vi.fn(() => debugLoggerMock),
}));

const serverConfig: LspServerConfig = {
  name: 'clangd',
  languages: ['cpp'],
  command: 'clangd',
  args: [],
  transport: 'stdio',
  rootUri: 'file:///workspace',
  workspaceFolder: '/workspace',
};

type PathSafeManager = {
  isPathSafe(command: string, workspacePath: string, cwd?: string): boolean;
};

function createManager(workspaceRoot: string): PathSafeManager {
  return new LspServerManager(
    {} as CoreConfig,
    {} as WorkspaceContext,
    {} as FileDiscoveryService,
    {
      requireTrustedWorkspace: false,
      workspaceRoot,
    },
  ) as unknown as PathSafeManager;
}

describe('LspServerManager', () => {
  describe('isPathSafe', () => {
    it('allows bare commands resolved through PATH', () => {
      const workspaceRoot = path.resolve('/workspace/project');
      const manager = createManager(workspaceRoot);

      expect(manager.isPathSafe('clangd', workspaceRoot)).toBe(true);
    });

    it('allows explicit absolute command paths', () => {
      const workspaceRoot = path.resolve('/workspace/project');
      const absoluteCommand = path.join(
        path.parse(workspaceRoot).root,
        'usr',
        'bin',
        'clangd',
      );
      const manager = createManager(workspaceRoot);

      expect(manager.isPathSafe(absoluteCommand, workspaceRoot)).toBe(true);
    });

    it('allows relative paths that resolve inside the workspace', () => {
      const workspaceRoot = path.resolve('/workspace/project');
      const manager = createManager(workspaceRoot);

      expect(
        manager.isPathSafe('./tools/clangd', workspaceRoot, workspaceRoot),
      ).toBe(true);
    });

    it('blocks relative paths that escape the workspace', () => {
      const workspaceRoot = path.resolve('/workspace/project');
      const manager = createManager(workspaceRoot);

      expect(
        manager.isPathSafe('../bin/clangd', workspaceRoot, workspaceRoot),
      ).toBe(false);
    });

    it('blocks relative paths that use intermediate traversal to escape', () => {
      const workspaceRoot = path.resolve('/workspace/project');
      const manager = createManager(workspaceRoot);

      expect(
        manager.isPathSafe(
          './tools/../../../etc/passwd',
          workspaceRoot,
          workspaceRoot,
        ),
      ).toBe(false);
    });

    it('treats commands with forward slash but no path.sep on Windows as relative', () => {
      const workspaceRoot = path.resolve('/workspace/project');
      const manager = createManager(workspaceRoot);

      // A command like "subdir/server" is relative; if it resolves inside
      // the workspace it should be allowed.
      expect(
        manager.isPathSafe('tools/clangd', workspaceRoot, workspaceRoot),
      ).toBe(true);
    });
  });

  it('logs process diagnostics when startup fails after connection creation', async () => {
    const manager = new LspServerManager(
      {
        isTrustedFolder: vi.fn().mockReturnValue(true),
      } as unknown as CoreConfig,
      {} as WorkspaceContext,
      {} as FileDiscoveryService,
      {
        requireTrustedWorkspace: false,
        workspaceRoot: '/workspace',
      },
    );
    const processDiagnostics = {
      stderrTail: 'clangd: unknown argument\n',
      exitCode: 7,
      exitSignal: null,
    };
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    vi.spyOn(
      manager as unknown as {
        createLspConnection: (
          config: LspServerConfig,
        ) => Promise<LspConnectionResult>;
      },
      'createLspConnection',
    ).mockResolvedValue({
      connection: {},
      processDiagnostics,
    } as unknown as LspConnectionResult);
    vi.spyOn(
      manager as unknown as {
        initializeLspServer: () => Promise<void>;
      },
      'initializeLspServer',
    ).mockRejectedValue(new Error('initialize failed'));

    manager.setServerConfigs([serverConfig]);
    await manager.startAll();

    expect(debugLoggerMock.error).toHaveBeenCalledWith(
      'LSP server clangd process diagnostics:',
      processDiagnostics,
    );
    expect(debugLoggerMock.error).toHaveBeenCalledWith(
      'LSP server clangd failed to start:',
      expect.any(Error),
    );
  });
});
