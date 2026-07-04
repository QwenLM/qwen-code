/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config as CoreConfig } from '../config/config.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import { LspServerManager } from './LspServerManager.js';
import { LspConnectionFactory } from './LspConnectionFactory.js';
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

function pathToRootUri(rootPath: string): string {
  return pathToFileURL(rootPath).toString();
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
        failed: [],
      });
      expect(privateView.startServer).toHaveBeenCalledOnce();
      expect(manager.getHandles().get('clangd')?.status).toBe('READY');
      expect(debugLoggerMock.info).toHaveBeenCalledWith(
        'Reconciling LSP server configs: desired=clangd',
      );
      expect(debugLoggerMock.info).toHaveBeenCalledWith(
        'LSP reconcile result: added=clangd, removed=<none>, restarted=<none>, unchanged=<none>, failed=<none>',
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
        'LSP reconcile result: added=<none>, removed=clangd, restarted=<none>, unchanged=<none>, failed=<none>',
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
        'LSP reconcile result: added=<none>, removed=<none>, restarted=clangd, unchanged=pyright, failed=<none>',
      );
    });

    it('reports added server startup failures without caching the failed hash', async () => {
      const { manager, privateView } = createReconcileManager();
      vi.mocked(privateView.startServer)
        .mockImplementationOnce(async (_name, handle) => {
          (handle as { status: string }).status = 'FAILED';
        })
        .mockImplementationOnce(async (_name, handle) => {
          (handle as { status: string }).status = 'READY';
        });

      const first = await manager.reconcileServerConfigs([serverConfig]);
      const second = await manager.reconcileServerConfigs([serverConfig]);

      expect(first).toMatchObject({
        added: [],
        failed: ['clangd'],
        unchanged: [],
      });
      expect(second).toMatchObject({
        added: [],
        restarted: ['clangd'],
        failed: [],
        unchanged: [],
      });
      expect(privateView.startServer).toHaveBeenCalledTimes(2);
    });

    it('reports restarted server startup failures without caching the failed hash', async () => {
      const { manager, privateView } = createReconcileManager();
      manager.setServerConfigs([serverConfig]);
      vi.mocked(privateView.startServer)
        .mockImplementationOnce(async (_name, handle) => {
          (handle as { status: string }).status = 'FAILED';
        })
        .mockImplementationOnce(async (_name, handle) => {
          (handle as { status: string }).status = 'READY';
        });
      const changedConfig = { ...serverConfig, args: ['--log=verbose'] };

      const first = await manager.reconcileServerConfigs([changedConfig]);
      const second = await manager.reconcileServerConfigs([changedConfig]);

      expect(first).toMatchObject({
        restarted: [],
        failed: ['clangd'],
        unchanged: [],
      });
      expect(second).toMatchObject({
        restarted: ['clangd'],
        failed: [],
        unchanged: [],
      });
      expect(privateView.startServer).toHaveBeenCalledTimes(2);
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

    it('waits for a server startup before removing it', async () => {
      const { manager, privateView } = createReconcileManager();
      manager.setServerConfigs([serverConfig]);
      const handle = manager.getHandles().get('clangd');
      expect(handle).toBeDefined();
      let resolveStartup!: () => void;
      handle!.startingPromise = new Promise<void>((resolve) => {
        resolveStartup = resolve;
      });

      const reconcile = manager.reconcileServerConfigs([]);
      await Promise.resolve();
      expect(privateView.stopServer).not.toHaveBeenCalled();

      resolveStartup();
      await reconcile;

      expect(privateView.stopServer).toHaveBeenCalledOnce();
      expect(manager.getHandles().has('clangd')).toBe(false);
    });

    it('waits for a server startup before restarting it', async () => {
      const { manager, privateView } = createReconcileManager();
      manager.setServerConfigs([serverConfig]);
      const handle = manager.getHandles().get('clangd');
      expect(handle).toBeDefined();
      let resolveStartup!: () => void;
      handle!.startingPromise = new Promise<void>((resolve) => {
        resolveStartup = resolve;
      });

      const reconcile = manager.reconcileServerConfigs([
        { ...serverConfig, args: ['--log=verbose'] },
      ]);
      await Promise.resolve();
      expect(privateView.stopServer).not.toHaveBeenCalled();

      resolveStartup();
      await reconcile;

      expect(privateView.stopServer).toHaveBeenCalledOnce();
      expect(privateView.startServer).toHaveBeenCalledOnce();
    });

    it('stopAll waits for an active reconcile before clearing handles', async () => {
      const { manager, privateView } = createReconcileManager();
      let resolveStart!: () => void;
      vi.mocked(privateView.startServer).mockImplementation(
        async (_name, handle) => {
          await new Promise<void>((resolve) => {
            resolveStart = resolve;
          });
          (handle as { status: string }).status = 'READY';
        },
      );

      const reconcile = manager.reconcileServerConfigs([serverConfig]);
      await Promise.resolve();
      const stopAll = manager.stopAll();
      await Promise.resolve();

      expect(manager.getHandles().has('clangd')).toBe(true);
      resolveStart();
      await Promise.all([reconcile, stopAll]);

      expect(privateView.stopServer).toHaveBeenCalledOnce();
      expect(manager.getHandles().size).toBe(0);
    });

    it('serializes stopAll with later reconcile calls', async () => {
      const { manager, privateView } = createReconcileManager();
      const order: string[] = [];
      manager.setServerConfigs([serverConfig]);
      vi.mocked(privateView.stopServer).mockImplementation(
        async (_name, handle) => {
          order.push('stop');
          await new Promise((resolve) => setTimeout(resolve, 10));
          (handle as { status: string }).status = 'NOT_STARTED';
        },
      );
      vi.mocked(privateView.startServer).mockImplementation(
        async (_name, handle) => {
          order.push('start');
          (handle as { status: string }).status = 'READY';
        },
      );

      await Promise.all([
        manager.stopAll(),
        manager.reconcileServerConfigs([{ ...serverConfig, command: 'next' }]),
      ]);

      expect(order).toEqual(['stop', 'start']);
      expect(manager.getHandles().get('clangd')?.config.command).toBe('next');
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
    expect(manager.getHandles().get('clangd')?.processDiagnostics).toBe(
      processDiagnostics,
    );
    expect(debugLoggerMock.error).toHaveBeenCalledWith(
      'LSP server clangd process diagnostics:',
      processDiagnostics,
    );
    expect(debugLoggerMock.error).toHaveBeenCalledWith(
      'LSP server clangd failed to start:',
      expect.any(Error),
    );
  });

  it('logs when workspace trust check blocks startup', async () => {
    const manager = createTrustedManager();
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(false);

    manager.setServerConfigs([serverConfig]);
    await manager.startAll();

    expect(manager.getHandles().get('clangd')?.status).toBe('FAILED');
    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      'Workspace trust check failed, not starting LSP server clangd',
    );
  });

  it('does not probe command existence for unsafe command paths', async () => {
    const manager = createTrustedManager();
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    const isPathSafe = vi
      .spyOn(
        manager as unknown as {
          isPathSafe: () => boolean;
        },
        'isPathSafe',
      )
      .mockReturnValue(false);
    const commandExists = vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    );

    manager.setServerConfigs([
      { ...serverConfig, command: '../../outside/payload' },
    ]);
    await manager.startAll();

    expect(isPathSafe).toHaveBeenCalledOnce();
    expect(commandExists).not.toHaveBeenCalled();
    expect(manager.getHandles().get('clangd')?.status).toBe('FAILED');
    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      'LSP server clangd command path is unsafe: ../../outside/payload',
    );
  });

  it('retries the same config after initial command lookup failure', async () => {
    const manager = createTrustedManager();
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    )
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.spyOn(
      manager as unknown as {
        createLspConnection: (
          config: LspServerConfig,
        ) => Promise<LspConnectionResult>;
      },
      'createLspConnection',
    ).mockResolvedValue({
      connection: createMockConnection(),
      process: createMockProcess() as unknown as ChildProcess,
    } as unknown as LspConnectionResult);
    vi.spyOn(
      manager as unknown as {
        initializeLspServer: () => Promise<void>;
      },
      'initializeLspServer',
    ).mockResolvedValue(undefined);

    manager.setServerConfigs([serverConfig]);
    await manager.startAll();
    const result = await manager.reconcileServerConfigs([serverConfig]);

    expect(result.restarted).toEqual(['clangd']);
    expect(manager.getHandles().get('clangd')?.status).toBe('READY');
  });

  it('passes LSP config env through command probe filtering', async () => {
    const manager = createTrustedManager();
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    const commandExists = vi
      .spyOn(
        manager as unknown as {
          commandExists: (
            command: string,
            env?: Record<string, string>,
            cwd?: string,
          ) => Promise<boolean>;
        },
        'commandExists',
      )
      .mockResolvedValue(false);

    manager.setServerConfigs([
      {
        ...serverConfig,
        env: { PATH: '/tmp/fake-bin', SAFE_VALUE: '1' },
      },
    ]);
    await manager.startAll();

    expect(commandExists).toHaveBeenCalledWith(
      'clangd',
      { PATH: '/tmp/fake-bin', SAFE_VALUE: '1' },
      '/workspace',
    );
  });

  it('retries the same config after a crash restart failure', async () => {
    const manager = createTrustedManager();
    let exitHandler: ((code: number | null) => void) | undefined;
    const process = createMockProcess();
    process.once = vi.fn(
      (event: string, handler: (code: number | null) => void) => {
        if (event === 'exit') {
          exitHandler = handler;
        }
        return process;
      },
    );
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    )
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.spyOn(
      manager as unknown as {
        createLspConnection: (
          config: LspServerConfig,
        ) => Promise<LspConnectionResult>;
      },
      'createLspConnection',
    ).mockResolvedValue({
      connection: createMockConnection(),
      process: process as unknown as ChildProcess,
    } as unknown as LspConnectionResult);
    vi.spyOn(
      manager as unknown as {
        initializeLspServer: () => Promise<void>;
      },
      'initializeLspServer',
    ).mockResolvedValue(undefined);
    const config = { ...serverConfig, restartOnCrash: true };

    manager.setServerConfigs([config]);
    await manager.startAll();
    expect(exitHandler).toBeDefined();

    exitHandler?.(1);
    const result = await manager.reconcileServerConfigs([config]);

    expect(result.restarted).toEqual(['clangd']);
    expect(manager.getHandles().get('clangd')?.status).toBe('READY');
  });

  it('does not restart a crashed server while stopping all servers', async () => {
    const manager = createTrustedManager();
    let exitHandler: ((code: number | null) => void) | undefined;
    const process = createMockProcess();
    process.once = vi.fn(
      (event: string, handler: (code: number | null) => void) => {
        if (event === 'exit') {
          exitHandler = handler;
        }
        return process;
      },
    );
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    ).mockResolvedValue(true);
    const createLspConnection = vi
      .spyOn(
        manager as unknown as {
          createLspConnection: (
            config: LspServerConfig,
          ) => Promise<LspConnectionResult>;
        },
        'createLspConnection',
      )
      .mockResolvedValue({
        connection: createMockConnection(),
        process: process as unknown as ChildProcess,
      } as unknown as LspConnectionResult);
    vi.spyOn(
      manager as unknown as {
        initializeLspServer: () => Promise<void>;
      },
      'initializeLspServer',
    ).mockResolvedValue(undefined);
    const config = { ...serverConfig, restartOnCrash: true };

    manager.setServerConfigs([config]);
    await manager.startAll();
    expect(exitHandler).toBeDefined();

    exitHandler?.(1);
    await manager.stopAll();

    expect(createLspConnection).toHaveBeenCalledOnce();
    expect(manager.getHandles().size).toBe(0);
  });

  it('does not restart a crashed stale handle', async () => {
    const manager = createTrustedManager();
    let exitHandler: ((code: number | null) => void) | undefined;
    const process = createMockProcess();
    process.once = vi.fn(
      (event: string, handler: (code: number | null) => void) => {
        if (event === 'exit') {
          exitHandler = handler;
        }
        return process;
      },
    );
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    ).mockResolvedValue(true);
    const createLspConnection = vi
      .spyOn(
        manager as unknown as {
          createLspConnection: (
            config: LspServerConfig,
          ) => Promise<LspConnectionResult>;
        },
        'createLspConnection',
      )
      .mockResolvedValue({
        connection: createMockConnection(),
        process: process as unknown as ChildProcess,
      } as unknown as LspConnectionResult);
    vi.spyOn(
      manager as unknown as {
        initializeLspServer: () => Promise<void>;
      },
      'initializeLspServer',
    ).mockResolvedValue(undefined);
    const config = { ...serverConfig, restartOnCrash: true };

    manager.setServerConfigs([config]);
    await manager.startAll();
    expect(exitHandler).toBeDefined();

    exitHandler?.(1);
    manager.clearServerHandles();
    await Promise.resolve();

    expect(createLspConnection).toHaveBeenCalledOnce();
  });

  it('does not restart a crashed handle already being stopped', async () => {
    const manager = createTrustedManager();
    let exitHandler: ((code: number | null) => void) | undefined;
    const process = createMockProcess();
    process.once = vi.fn(
      (event: string, handler: (code: number | null) => void) => {
        if (event === 'exit') {
          exitHandler = handler;
        }
        return process;
      },
    );
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    ).mockResolvedValue(true);
    const createLspConnection = vi
      .spyOn(
        manager as unknown as {
          createLspConnection: (
            config: LspServerConfig,
          ) => Promise<LspConnectionResult>;
        },
        'createLspConnection',
      )
      .mockResolvedValue({
        connection: createMockConnection(),
        process: process as unknown as ChildProcess,
      } as unknown as LspConnectionResult);
    vi.spyOn(
      manager as unknown as {
        initializeLspServer: () => Promise<void>;
      },
      'initializeLspServer',
    ).mockResolvedValue(undefined);
    const config = { ...serverConfig, restartOnCrash: true };

    manager.setServerConfigs([config]);
    await manager.startAll();
    const handle = manager.getHandles().get('clangd');
    expect(exitHandler).toBeDefined();
    expect(handle).toBeDefined();

    exitHandler?.(1);
    handle!.stopRequested = true;
    await Promise.resolve();

    expect(createLspConnection).toHaveBeenCalledOnce();
  });

  it('retries the same config after a crash without restartOnCrash', async () => {
    const manager = createTrustedManager();
    let exitHandler: ((code: number | null) => void) | undefined;
    const process = createMockProcess();
    process.once = vi.fn(
      (event: string, handler: (code: number | null) => void) => {
        if (event === 'exit') {
          exitHandler = handler;
        }
        return process;
      },
    );
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    ).mockResolvedValue(true);
    const createLspConnection = vi
      .spyOn(
        manager as unknown as {
          createLspConnection: (
            config: LspServerConfig,
          ) => Promise<LspConnectionResult>;
        },
        'createLspConnection',
      )
      .mockResolvedValue({
        connection: createMockConnection(),
        process: process as unknown as ChildProcess,
      } as unknown as LspConnectionResult);
    vi.spyOn(
      manager as unknown as {
        initializeLspServer: () => Promise<void>;
      },
      'initializeLspServer',
    ).mockResolvedValue(undefined);

    manager.setServerConfigs([serverConfig]);
    await manager.startAll();
    expect(exitHandler).toBeDefined();

    exitHandler?.(1);
    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      'LSP server clangd exited but restartOnCrash is disabled',
    );
    const result = await manager.reconcileServerConfigs([serverConfig]);

    expect(result.restarted).toEqual(['clangd']);
    expect(createLspConnection).toHaveBeenCalledTimes(2);
    expect(manager.getHandles().get('clangd')?.status).toBe('READY');
  });

  it('logs when a crashed server has zero restart attempts configured', async () => {
    const manager = createTrustedManager();
    let exitHandler: ((code: number | null) => void) | undefined;
    const process = createMockProcess();
    process.once = vi.fn(
      (event: string, handler: (code: number | null) => void) => {
        if (event === 'exit') {
          exitHandler = handler;
        }
        return process;
      },
    );
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        createLspConnection: (
          config: LspServerConfig,
        ) => Promise<LspConnectionResult>;
      },
      'createLspConnection',
    ).mockResolvedValue({
      connection: createMockConnection(),
      process: process as unknown as ChildProcess,
    } as unknown as LspConnectionResult);
    vi.spyOn(
      manager as unknown as {
        initializeLspServer: () => Promise<void>;
      },
      'initializeLspServer',
    ).mockResolvedValue(undefined);
    const config = { ...serverConfig, restartOnCrash: true, maxRestarts: 0 };

    manager.setServerConfigs([config]);
    await manager.startAll();
    expect(exitHandler).toBeDefined();

    exitHandler?.(1);

    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      'LSP server clangd exited but maxRestarts is 0',
    );
    expect(manager.getHandles().get('clangd')?.status).toBe('FAILED');
  });

  it('retries the same config after crash restart attempts are exhausted', async () => {
    const manager = createTrustedManager();
    let exitHandler: ((code: number | null) => void) | undefined;
    const process = createMockProcess();
    process.once = vi.fn(
      (event: string, handler: (code: number | null) => void) => {
        if (event === 'exit') {
          exitHandler = handler;
        }
        return process;
      },
    );
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    ).mockResolvedValue(true);
    const createLspConnection = vi
      .spyOn(
        manager as unknown as {
          createLspConnection: (
            config: LspServerConfig,
          ) => Promise<LspConnectionResult>;
        },
        'createLspConnection',
      )
      .mockResolvedValue({
        connection: createMockConnection(),
        process: process as unknown as ChildProcess,
      } as unknown as LspConnectionResult);
    vi.spyOn(
      manager as unknown as {
        initializeLspServer: () => Promise<void>;
      },
      'initializeLspServer',
    ).mockResolvedValue(undefined);
    const config = { ...serverConfig, restartOnCrash: true, maxRestarts: 1 };

    manager.setServerConfigs([config]);
    await manager.startAll();
    const handle = manager.getHandles().get('clangd');
    expect(exitHandler).toBeDefined();
    expect(handle).toBeDefined();
    handle!.restartAttempts = 1;

    exitHandler?.(1);
    const result = await manager.reconcileServerConfigs([config]);

    expect(result.restarted).toEqual(['clangd']);
    expect(createLspConnection).toHaveBeenCalledTimes(2);
    expect(manager.getHandles().get('clangd')?.status).toBe('READY');
  });

  it('filters security-sensitive LSP environment overrides', () => {
    const manager = createTrustedManager();
    const env = (
      manager as unknown as {
        buildProcessEnv(env: Record<string, string>): NodeJS.ProcessEnv;
      }
    ).buildProcessEnv({
      PATH: '/tmp/fake-bin',
      NODE_OPTIONS: '--require /tmp/hook.js',
      node_options: '--require /tmp/lowercase-hook.js',
      Ld_PreLoad: '/tmp/preload.so',
      SAFE_VALUE: '1',
    });

    expect(env['PATH']).toBe('/tmp/fake-bin');
    expect(env['NODE_OPTIONS']).toBe(process.env['NODE_OPTIONS']);
    expect(env['node_options']).toBeUndefined();
    expect(env['Ld_PreLoad']).toBeUndefined();
    expect(env['SAFE_VALUE']).toBe('1');
  });

  it('does not use LSP config PATH when probing command existence', () => {
    const manager = createTrustedManager();
    const env = (
      manager as unknown as {
        buildCommandProbeEnv(env: Record<string, string>): NodeJS.ProcessEnv;
      }
    ).buildCommandProbeEnv({
      PATH: '/tmp/fake-bin',
      Path: '/tmp/fake-bin-windows',
      JAVA_HOME: '/opt/java',
      NODE_OPTIONS: '--require /tmp/hook.js',
      SAFE_VALUE: '1',
    });

    expect(env['PATH']).not.toBe('/tmp/fake-bin');
    expect(env['Path']).not.toBe('/tmp/fake-bin-windows');
    expect(env['JAVA_HOME']).toBe('/opt/java');
    expect(env['NODE_OPTIONS']).toBe(process.env['NODE_OPTIONS']);
    expect(env['SAFE_VALUE']).toBe('1');
  });

  it('ignores reset errors while queueing a crash restart', async () => {
    const manager = createTrustedManager();
    let exitHandler: ((code: number | null) => void) | undefined;
    const process = createMockProcess({
      kill: vi.fn(() => {
        throw new Error('kill failed');
      }),
    });
    process.once = vi.fn(
      (event: string, handler: (code: number | null) => void) => {
        if (event === 'exit') {
          exitHandler = handler;
        }
        return process;
      },
    );
    const connection = createMockConnection({
      end: vi.fn(() => {
        throw new Error('end failed');
      }),
    });
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        createLspConnection: (
          config: LspServerConfig,
        ) => Promise<LspConnectionResult>;
      },
      'createLspConnection',
    )
      .mockResolvedValueOnce({
        connection,
        process: process as unknown as ChildProcess,
      } as unknown as LspConnectionResult)
      .mockResolvedValueOnce({
        connection: createMockConnection(),
        process: createMockProcess() as unknown as ChildProcess,
      } as unknown as LspConnectionResult);
    vi.spyOn(
      manager as unknown as {
        initializeLspServer: () => Promise<void>;
      },
      'initializeLspServer',
    ).mockResolvedValue(undefined);

    manager.setServerConfigs([{ ...serverConfig, restartOnCrash: true }]);
    await manager.startAll();
    exitHandler?.(1);
    await manager.reconcileServerConfigs([
      { ...serverConfig, restartOnCrash: true },
    ]);

    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      'Error closing LSP connection during reset:',
      expect.any(Error),
    );
    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      'Error killing LSP process during reset:',
      expect.any(Error),
    );
    expect(manager.getHandles().get('clangd')?.status).toBe('READY');
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

  it('cancels an in-flight socket startup retry when stopped', async () => {
    const manager = createTrustedManager();
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    ).mockResolvedValue(true);
    vi.spyOn(LspConnectionFactory, 'createSocketConnection').mockReturnValue(
      new Promise(() => {}),
    );
    manager.setServerConfigs([
      {
        ...serverConfig,
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10000);'],
        transport: 'tcp',
        socket: { host: '127.0.0.1', port: 65534 },
        workspaceFolder: process.cwd(),
        rootUri: pathToRootUri(process.cwd()),
        startupTimeout: 30_000,
      },
    ]);

    const startAll = manager.startAll();
    await vi.waitFor(() => {
      expect(LspConnectionFactory.createSocketConnection).toHaveBeenCalled();
    });

    const stopped = await Promise.race([
      manager.stopAll().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    await startAll;

    expect(stopped).toBe(true);
    expect(manager.getHandles().size).toBe(0);
  });

  it('cancels socket command spawn wait when startup is aborted', async () => {
    const manager = createTrustedManager();
    const controller = new AbortController();
    const childProcess = {
      exitCode: null,
      kill: vi.fn(),
      once: vi.fn(
        (_event: string, _handler: (...args: unknown[]) => void) =>
          childProcess,
      ),
      off: vi.fn(
        (_event: string, _handler: (...args: unknown[]) => void) =>
          childProcess,
      ),
    };
    const privateView = manager as unknown as {
      waitForSocketProcessSpawn(
        process: ChildProcess,
        signal: AbortSignal,
      ): Promise<void>;
    };

    const wait = privateView.waitForSocketProcessSpawn(
      childProcess as unknown as ChildProcess,
      controller.signal,
    );
    controller.abort();

    await expect(wait).rejects.toThrow('LSP server startup cancelled');
    expect(childProcess.kill).toHaveBeenCalledOnce();
    expect(childProcess.off).toHaveBeenCalledWith(
      'spawn',
      expect.any(Function),
    );
    expect(childProcess.off).toHaveBeenCalledWith(
      'error',
      expect.any(Function),
    );
  });

  it('fails socket startup early when the child exits before connect', async () => {
    const manager = createTrustedManager();
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    ).mockResolvedValue(true);
    vi.spyOn(LspConnectionFactory, 'createSocketConnection').mockReturnValue(
      new Promise(() => {}),
    );
    manager.setServerConfigs([
      {
        ...serverConfig,
        command: process.execPath,
        args: [
          '-e',
          'process.stderr.write("socket startup failed\\n"); process.exit(7);',
        ],
        transport: 'tcp',
        socket: { host: '127.0.0.1', port: 65533 },
        workspaceFolder: process.cwd(),
        rootUri: pathToRootUri(process.cwd()),
        startupTimeout: 30_000,
      },
    ]);

    await manager.startAll();

    const handle = manager.getHandles().get('clangd');
    expect(handle?.status).toBe('FAILED');
    expect(handle?.error?.message).toContain(
      'LSP server exited before socket connection was ready',
    );
    expect(handle?.processDiagnostics).toMatchObject({
      stderrTail: 'socket startup failed\n',
      exitCode: 7,
      exitSignal: null,
    });
  });

  it('registers the restart handler before protocol initialization completes', async () => {
    const manager = createTrustedManager();
    let exitHandler: ((code: number | null) => void) | undefined;
    const process = createMockProcess();
    process.once = vi.fn(
      (event: string, handler: (code: number | null) => void) => {
        if (event === 'exit') {
          exitHandler = handler;
        }
        return process;
      },
    );
    vi.spyOn(
      manager as unknown as {
        checkWorkspaceTrust: () => Promise<boolean>;
      },
      'checkWorkspaceTrust',
    ).mockResolvedValue(true);
    vi.spyOn(
      manager as unknown as {
        isPathSafe: () => boolean;
      },
      'isPathSafe',
    ).mockReturnValue(true);
    vi.spyOn(
      manager as unknown as {
        commandExists: () => Promise<boolean>;
      },
      'commandExists',
    ).mockResolvedValue(true);
    const createLspConnection = vi
      .spyOn(
        manager as unknown as {
          createLspConnection: (
            config: LspServerConfig,
          ) => Promise<LspConnectionResult>;
        },
        'createLspConnection',
      )
      .mockResolvedValue({
        connection: createMockConnection(),
        process: process as unknown as ChildProcess,
      } as unknown as LspConnectionResult);
    let resolveInitialize!: () => void;
    vi.spyOn(
      manager as unknown as {
        initializeLspServer: () => Promise<void>;
      },
      'initializeLspServer',
    ).mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInitialize = resolve;
      }),
    );

    manager.setServerConfigs([{ ...serverConfig, restartOnCrash: true }]);
    const startAll = manager.startAll();
    await vi.waitFor(() => {
      expect(exitHandler).toBeDefined();
    });
    exitHandler?.(1);
    resolveInitialize();
    await startAll;

    expect(process.once).toHaveBeenCalledWith('exit', expect.any(Function));
    await vi.waitFor(() => {
      expect(createLspConnection).toHaveBeenCalledTimes(2);
    });
  });

  it('logs and continues when killing an owned process throws', async () => {
    const manager = createTrustedManager();
    const connection = createMockConnection();
    const killError = new Error('kill failed');
    const process = createMockProcess({
      kill: vi.fn(() => {
        throw killError;
      }),
    });
    manager.setServerConfigs([serverConfig]);
    const handle = manager.getHandles().get('clangd');
    expect(handle).toBeDefined();
    handle!.connection = connection;
    handle!.process = process as unknown as ChildProcess;
    handle!.status = 'READY';

    await expect(manager.stopAll()).resolves.toBeUndefined();

    expect(process.kill).toHaveBeenCalledOnce();
    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      'Error killing LSP server clangd process:',
      killError,
    );
    expect(manager.getHandles().size).toBe(0);
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

  it('unrefs the shutdown timeout', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(
      (handler, timeout, ...args) => {
        shutdownTimer = originalSetTimeout(handler, timeout, ...args);
        return shutdownTimer;
      },
    );
    const manager = createTrustedManager();
    const connection = createMockConnection();
    manager.setServerConfigs([{ ...serverConfig, shutdownTimeout: 30_000 }]);
    const handle = manager.getHandles().get('clangd');
    expect(handle).toBeDefined();
    handle!.connection = connection;
    handle!.status = 'READY';

    await manager.stopAll();

    expect(shutdownTimer).toBeDefined();
    expect(shutdownTimer?.hasRef()).toBe(false);
  });

  it('ends the connection when shutdown timeout fires', async () => {
    vi.useFakeTimers();
    const manager = createTrustedManager();
    const connection = createMockConnection({
      shutdown: vi.fn(() => new Promise<void>(() => {})),
    });
    manager.setServerConfigs([{ ...serverConfig, shutdownTimeout: 30_000 }]);
    const handle = manager.getHandles().get('clangd');
    expect(handle).toBeDefined();
    handle!.connection = connection;
    handle!.status = 'READY';

    const stopAll = manager.stopAll();
    await vi.advanceTimersByTimeAsync(30_000);
    await stopAll;

    expect(connection.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the default shutdown timeout when none is configured', async () => {
    vi.useFakeTimers();
    const manager = createTrustedManager();
    const connection = createMockConnection({
      shutdown: vi.fn(() => new Promise<void>(() => {})),
    });
    manager.setServerConfigs([serverConfig]);
    const handle = manager.getHandles().get('clangd');
    expect(handle).toBeDefined();
    handle!.connection = connection;
    handle!.status = 'READY';

    const stopAll = manager.stopAll();
    await vi.advanceTimersByTimeAsync(5000);
    await stopAll;

    expect(connection.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for an in-flight startup before releasing server resources', async () => {
    const manager = createTrustedManager();
    const connection = createMockConnection();
    const process = createMockProcess();
    manager.setServerConfigs([serverConfig]);
    const handle = manager.getHandles().get('clangd');
    expect(handle).toBeDefined();
    let resolveStartup!: () => void;
    handle!.startingPromise = new Promise<void>((resolve) => {
      resolveStartup = () => {
        handle!.connection = connection;
        handle!.process = process as unknown as ChildProcess;
        resolve();
      };
    });

    const stopAll = manager.stopAll();
    await Promise.resolve();
    expect(connection.end).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();

    resolveStartup();
    await stopAll;

    expect(connection.shutdown).toHaveBeenCalledOnce();
    expect(connection.end).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledOnce();
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

function createMockProcess(
  overrides: {
    exitCode?: number | null;
    kill?: ReturnType<typeof vi.fn>;
    once?: ReturnType<typeof vi.fn>;
  } = {},
): {
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
} {
  return {
    exitCode: overrides.exitCode ?? null,
    kill: overrides.kill ?? vi.fn(),
    once: overrides.once ?? vi.fn(),
  };
}
