/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config as CoreConfig } from '../config/config.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import { LspServerManager } from './LspServerManager.js';
import type {
  LspConnectionInterface,
  LspConnectionResult,
  LspServerConfig,
} from './types.js';

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

type ReconcilePrivateView = {
  startServer(name: string, handle: unknown): Promise<void>;
  stopServer(name: string, handle: unknown): Promise<void>;
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

function createReconcileManager(): {
  manager: LspServerManager;
  privateView: ReconcilePrivateView;
} {
  const manager = createTrustedManager();
  const privateView = manager as unknown as ReconcilePrivateView;
  vi.spyOn(privateView, 'startServer').mockImplementation(
    async (_name, handle) => {
      (handle as { status: string }).status = 'READY';
    },
  );
  vi.spyOn(privateView, 'stopServer').mockImplementation(
    async (_name, handle) => {
      (handle as { status: string }).status = 'NOT_STARTED';
    },
  );
  return { manager, privateView };
}

function createTrustedManager(): LspServerManager {
  return new LspServerManager(
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
}

describe('LspServerManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('reconcileServerConfigs', () => {
    it('starts added servers', async () => {
      const { manager, privateView } = createReconcileManager();

      const result = await manager.reconcileServerConfigs([serverConfig]);

      expect(result).toEqual({
        added: ['clangd'],
        removed: [],
        restarted: [],
        unchanged: [],
      });
      expect(privateView.startServer).toHaveBeenCalledOnce();
      expect(manager.getHandles().get('clangd')?.status).toBe('READY');
      expect(debugLoggerMock.info).toHaveBeenCalledWith(
        'Reconciling LSP server configs: desired=clangd',
      );
      expect(debugLoggerMock.info).toHaveBeenCalledWith(
        'LSP reconcile result: added=clangd, removed=<none>, restarted=<none>, unchanged=<none>',
      );
    });

    it('removes missing servers', async () => {
      const { manager, privateView } = createReconcileManager();
      manager.setServerConfigs([serverConfig]);

      const result = await manager.reconcileServerConfigs([]);

      expect(result.removed).toEqual(['clangd']);
      expect(privateView.stopServer).toHaveBeenCalledOnce();
      expect(manager.getHandles().has('clangd')).toBe(false);
      expect(debugLoggerMock.info).toHaveBeenCalledWith(
        'LSP reconcile result: added=<none>, removed=clangd, restarted=<none>, unchanged=<none>',
      );
    });

    it('restarts changed servers and preserves unchanged handles', async () => {
      const { manager, privateView } = createReconcileManager();
      const otherConfig = {
        ...serverConfig,
        name: 'pyright',
        languages: ['python'],
        command: 'pyright-langserver',
      };
      manager.setServerConfigs([serverConfig, otherConfig]);
      const originalOtherHandle = manager.getHandles().get('pyright');

      const result = await manager.reconcileServerConfigs([
        { ...serverConfig, args: ['--log=verbose'] },
        otherConfig,
      ]);

      expect(result.restarted).toEqual(['clangd']);
      expect(result.unchanged).toEqual(['pyright']);
      expect(privateView.stopServer).toHaveBeenCalledOnce();
      expect(privateView.startServer).toHaveBeenCalledOnce();
      expect(manager.getHandles().get('pyright')).toBe(originalOtherHandle);
      expect(debugLoggerMock.info).toHaveBeenCalledWith(
        'LSP reconcile result: added=<none>, removed=<none>, restarted=clangd, unchanged=pyright',
      );
    });

    it('serializes concurrent reconcile calls', async () => {
      const { manager, privateView } = createReconcileManager();
      const order: string[] = [];
      vi.mocked(privateView.startServer).mockImplementation(
        async (name, handle) => {
          order.push(`start:${name}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
          (handle as { status: string }).status = 'READY';
        },
      );

      await Promise.all([
        manager.reconcileServerConfigs([serverConfig]),
        manager.reconcileServerConfigs([
          { ...serverConfig, command: 'clangd-next' },
        ]),
      ]);

      expect(order).toEqual(['start:clangd', 'start:clangd']);
      expect(manager.getHandles().get('clangd')?.config.command).toBe(
        'clangd-next',
      );
    });
  });

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
    const connection = createMockConnection();
    const process = createMockProcess();
    vi.spyOn(
      manager as unknown as {
        createLspConnection: (
          config: LspServerConfig,
        ) => Promise<LspConnectionResult>;
      },
      'createLspConnection',
    ).mockResolvedValue({
      connection,
      process,
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

    expect(connection.end).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledOnce();
    expect(manager.getHandles().get('clangd')?.connection).toBeUndefined();
    expect(manager.getHandles().get('clangd')?.process).toBeUndefined();
    expect(debugLoggerMock.error).toHaveBeenCalledWith(
      'LSP server clangd process diagnostics:',
      processDiagnostics,
    );
    expect(debugLoggerMock.error).toHaveBeenCalledWith(
      'LSP server clangd failed to start:',
      expect.any(Error),
    );
  });

  it('kills owned process after graceful shutdown for socket transports', async () => {
    const manager = createTrustedManager();
    const connection = createMockConnection();
    const process = createMockProcess();
    const socketConfig: LspServerConfig = {
      ...serverConfig,
      transport: 'tcp',
      socket: { host: '127.0.0.1', port: 9876 },
    };
    manager.setServerConfigs([socketConfig]);
    const handle = manager.getHandles().get('clangd');
    expect(handle).toBeDefined();
    handle!.connection = connection;
    handle!.process = process as unknown as ChildProcess;
    handle!.status = 'READY';

    await manager.stopAll();

    expect(connection.shutdown).toHaveBeenCalledOnce();
    expect(connection.end).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it('clears shutdown timeout when shutdown completes first', async () => {
    vi.useFakeTimers();
    const manager = createTrustedManager();
    const connection = createMockConnection();
    manager.setServerConfigs([{ ...serverConfig, shutdownTimeout: 30_000 }]);
    const handle = manager.getHandles().get('clangd');
    expect(handle).toBeDefined();
    handle!.connection = connection;
    handle!.status = 'READY';

    await manager.stopAll();

    expect(connection.shutdown).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function createMockConnection(
  overrides: Partial<LspConnectionInterface> = {},
): LspConnectionInterface {
  return {
    listen: vi.fn(),
    send: vi.fn(),
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    request: vi.fn(),
    initialize: vi.fn(),
    shutdown: vi.fn(async () => {}),
    end: vi.fn(),
    ...overrides,
  };
}

function createMockProcess(): {
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
} {
  return {
    exitCode: null,
    kill: vi.fn(),
  };
}
