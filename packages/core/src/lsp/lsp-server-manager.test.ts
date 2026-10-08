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
import { LspServerManager } from './lsp-server-manager.js';
import { LspConnectionFactory } from './LspConnectionFactory.js';
import type {
  LspServerHandle,
  LspConnectionInterface,
  LspConnectionResult,
  LspServerConfig,
  LspTextDocumentSync,
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

/** Private members the cases stub or call directly. */
type ManagerPrivates = {
  checkWorkspaceTrust: () => Promise<boolean>;
  isPathSafe: () => boolean;
  commandExists: (
    command: string,
    env?: Record<string, string>,
    cwd?: string,
  ) => Promise<boolean>;
  createLspConnection: (
    config: LspServerConfig,
  ) => Promise<LspConnectionResult>;
  initializeLspServer: () => Promise<void>;
  findFirstTypescriptFile(): string | undefined;
  buildProcessEnv(env: Record<string, string>): NodeJS.ProcessEnv;
  buildCommandProbeEnv(env: Record<string, string>): NodeJS.ProcessEnv;
  waitForSocketProcessSpawn(
    process: ChildProcess,
    signal: AbortSignal,
  ): Promise<void>;
  raceStartupAbort<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    cleanupAfterAbort?: (value: T) => void,
  ): Promise<T>;
};

const privates = (manager: LspServerManager) =>
  manager as unknown as ManagerPrivates;

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

/** A start/stop stub that just moves the handle to `status`. */
const setStatus =
  (status: string) => async (_name: string, handle: unknown) => {
    (handle as { status: string }).status = status;
  };

function createReconcileManager(): {
  manager: LspServerManager;
  privateView: ReconcilePrivateView;
} {
  const manager = createTrustedManager();
  const privateView = manager as unknown as ReconcilePrivateView;
  vi.spyOn(privateView, 'startServer').mockImplementation(setStatus('READY'));
  vi.spyOn(privateView, 'stopServer').mockImplementation(
    setStatus('NOT_STARTED'),
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

function spyPrivate<K extends keyof ManagerPrivates>(
  manager: LspServerManager,
  name: K,
) {
  return vi.spyOn(privates(manager), name);
}

/**
 * Opens the trust and path-safety gates; command lookup answers `lookups`
 * in order when given (then falls through to the real probe), else true.
 */
function openGates(manager: LspServerManager, lookups?: boolean[]) {
  spyPrivate(manager, 'checkWorkspaceTrust').mockResolvedValue(true);
  spyPrivate(manager, 'isPathSafe').mockReturnValue(true);
  const commandExists = spyPrivate(manager, 'commandExists');
  if (!lookups) return commandExists.mockResolvedValue(true);
  for (const found of lookups) commandExists.mockResolvedValueOnce(found);
  return commandExists;
}

/** Every connection attempt hands back `result`; initialize resolves. */
function stubConnection(manager: LspServerManager, result: object) {
  return {
    createLspConnection: spyPrivate(
      manager,
      'createLspConnection',
    ).mockResolvedValue(result as unknown as LspConnectionResult),
    initializeLspServer: spyPrivate(
      manager,
      'initializeLspServer',
    ).mockResolvedValue(undefined),
  };
}

/** A mock process that records the 'exit' handler startup installs. */
function crashableProcess(
  overrides: Parameters<typeof createMockProcess>[0] = {},
) {
  const crash: { exit?: (code: number | null) => void } = {};
  const process = createMockProcess(overrides);
  process.once = vi.fn(
    (event: string, handler: (code: number | null) => void) => {
      if (event === 'exit') {
        crash.exit = handler;
      }
      return process;
    },
  );
  return { process, crash };
}

/** A trusted manager with open gates whose connections carry a crashable process. */
function crashingManager(lookups?: boolean[]) {
  const manager = createTrustedManager();
  const { process, crash } = crashableProcess();
  openGates(manager, lookups);
  const spies = stubConnection(manager, {
    connection: createMockConnection(),
    process,
  });
  return { manager, crash, ...spies };
}

/** Registers `config` and returns clangd's (asserted) handle. */
function registerHandle(
  manager: LspServerManager,
  config: LspServerConfig = serverConfig,
): LspServerHandle {
  manager.setServerConfigs([config]);
  const handle = manager.getHandles().get('clangd');
  expect(handle).toBeDefined();
  return handle!;
}

/** Registers `config` with its handle READY on `connection` (and `process`). */
function readyHandle(
  manager: LspServerManager,
  config: LspServerConfig,
  connection: LspConnectionInterface,
  process?: ReturnType<typeof createMockProcess>,
): LspServerHandle {
  const handle = registerHandle(manager, config);
  handle.connection = connection;
  if (process) handle.process = process as unknown as ChildProcess;
  handle.status = 'READY';
  return handle;
}

const tsHandle = (extra: Partial<LspServerHandle>): LspServerHandle => ({
  config: { ...serverConfig, name: 'typescript' },
  status: 'READY',
  ...extra,
});

/** A tcp server config that spawns node with `args` for a port nothing serves. */
const socketChildConfig = (args: string[], port: number): LspServerConfig => ({
  ...serverConfig,
  command: process.execPath,
  args,
  transport: 'tcp',
  socket: { host: '127.0.0.1', port },
  workspaceFolder: process.cwd(),
  rootUri: pathToRootUri(process.cwd()),
  startupTimeout: 30_000,
});

/** Whether stopAll settles within a second. */
const stopsPromptly = (manager: LspServerManager) =>
  Promise.race([
    manager.stopAll().then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
  ]);

describe('LspServerManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('contains TypeScript warmup callback failures without marking the handle warm', async () => {
    const manager = createTrustedManager();
    const warmupFile = path.resolve('main.ts');
    // SAFETY: Stub discovery only; the real warmup callback and catch execute.
    spyPrivate(manager, 'findFirstTypescriptFile').mockReturnValue(warmupFile);
    const handle = tsHandle({
      connection: {
        request: vi.fn(),
        send: vi.fn(),
      } as unknown as LspConnectionInterface,
    });
    const synchronize = vi.fn(() => {
      throw new Error('sync failed');
    });
    await expect(
      manager.warmupTypescriptServer(handle, synchronize),
    ).resolves.toBeUndefined();
    expect(synchronize).toHaveBeenCalledExactlyOnceWith(
      pathToFileURL(warmupFile).toString(),
      'typescript',
    );
    expect(handle.warmedUp).toBeFalsy();
    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      'TypeScript server warm-up failed:',
      expect.objectContaining({ message: 'sync failed' }),
    );
  });

  it('does not latch a replacement connection after an obsolete warmup delay', async () => {
    vi.useFakeTimers();
    const manager = createTrustedManager();
    spyPrivate(manager, 'findFirstTypescriptFile').mockReturnValue(
      path.resolve('main.ts'),
    );
    const handle = tsHandle({
      textDocumentSync: 1,
      connection: createMockConnection(),
    });
    const pending = manager.warmupTypescriptServer(handle, () => true);
    handle.connection = createMockConnection();
    await vi.runAllTimersAsync();
    await pending;
    expect(handle.warmedUp).not.toBe(true);
  });

  it('keeps an established latch when a forced warmup finds no TypeScript file', async () => {
    const manager = createTrustedManager();
    const discovery = spyPrivate(
      manager,
      'findFirstTypescriptFile',
    ).mockReturnValue(undefined);
    const handle = tsHandle({
      warmedUp: true,
      connection: createMockConnection(),
    });
    const synchronize = vi.fn(() => true);
    // A forced attempt that never reaches delivery (no TypeScript file found)
    // must not destroy the established latch: the unlock sits below the guard.
    await manager.warmupTypescriptServer(handle, synchronize, true);
    expect(handle.warmedUp).toBe(true);
    expect(synchronize).not.toHaveBeenCalled();
    // A later ordinary query stays short-circuited by the intact latch, so the
    // unbounded per-query discovery glob is not re-run.
    discovery.mockClear();
    await manager.warmupTypescriptServer(handle, synchronize);
    expect(discovery).not.toHaveBeenCalled();
    expect(handle.warmedUp).toBe(true);
  });

  it('latches a warmup that delivered no notification when textDocumentSync is absent', async () => {
    vi.useFakeTimers();
    const manager = createTrustedManager();
    spyPrivate(manager, 'findFirstTypescriptFile').mockReturnValue(
      path.resolve('main.ts'),
    );
    const handle = tsHandle({ connection: createMockConnection() });
    // textDocumentSync omitted: resolveTextDocumentSync must yield openClose:false
    // so a no-notification delivery latches warm instead of awaiting the delay.
    const pending = manager.warmupTypescriptServer(handle, () => false);
    // The no-notification branch must return before awaiting the warmup delay:
    // flushing timers first would mask a hoisted setTimeout.
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    await pending;
    expect(handle.warmedUp).toBe(true);
    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining('delivered no notification'),
    );
  });

  it.each<LspTextDocumentSync | undefined>([
    0,
    1,
    2,
    undefined,
    { openClose: true, change: 2 },
    { openClose: false, change: 0 },
  ])(
    'retains textDocumentSync %j without advertising dynamic registration',
    async (textDocumentSync) => {
      const manager = createTrustedManager();
      const connection = createMockConnection({
        initialize: vi.fn(async () => ({ capabilities: { textDocumentSync } })),
      });
      const createSocket = vi
        .spyOn(LspConnectionFactory, 'createSocketConnection')
        .mockResolvedValue({ connection } as Awaited<
          ReturnType<typeof LspConnectionFactory.createSocketConnection>
        >);
      try {
        manager.setServerConfigs([
          {
            ...serverConfig,
            command: undefined,
            transport: 'socket',
            socket: { port: 1234 },
          },
        ]);
        await manager.startAll();
        expect(manager.getHandles().get('clangd')).toMatchObject({
          status: 'READY',
          textDocumentSync,
        });
        expect(connection.initialize).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            capabilities: {
              textDocument: {
                completion: { dynamicRegistration: false },
                hover: { dynamicRegistration: false },
                definition: { dynamicRegistration: false },
                references: { dynamicRegistration: false },
                documentSymbol: { dynamicRegistration: false },
                codeAction: { dynamicRegistration: false },
              },
              workspace: { workspaceFolders: true },
            },
          }),
        );
        expect(connection.send).toHaveBeenCalledWith(
          expect.objectContaining({ method: 'initialized' }),
        );
      } finally {
        await manager.stopAll();
        createSocket.mockRestore();
      }
    },
  );

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

    /** The first start fails and the second succeeds. */
    const failThenStart = (privateView: ReconcilePrivateView) =>
      vi
        .mocked(privateView.startServer)
        .mockImplementationOnce(setStatus('FAILED'))
        .mockImplementationOnce(setStatus('READY'));

    it('reports added server startup failures without caching the failed hash', async () => {
      const { manager, privateView } = createReconcileManager();
      failThenStart(privateView);

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
      failThenStart(privateView);
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

    /**
     * Leaves clangd mid-startup, reconciles towards `desired`, and checks
     * the startup is aborted and awaited before clangd is stopped.
     */
    async function reconcileMidStartup(desired: LspServerConfig[]) {
      const { manager, privateView } = createReconcileManager();
      const handle = registerHandle(manager);
      let resolveStartup!: () => void;
      handle.startingPromise = new Promise<void>((resolve) => {
        resolveStartup = resolve;
      });
      handle.startupAbortController = new AbortController();
      const abortSpy = vi.spyOn(handle.startupAbortController, 'abort');

      const reconcile = manager.reconcileServerConfigs(desired);
      await Promise.resolve();
      expect(abortSpy).toHaveBeenCalledOnce();
      expect(privateView.stopServer).not.toHaveBeenCalled();

      resolveStartup();
      await reconcile;

      expect(privateView.stopServer).toHaveBeenCalledOnce();
      return { manager, privateView };
    }

    it('aborts a server startup before removing it', async () => {
      const { manager } = await reconcileMidStartup([]);
      expect(manager.getHandles().has('clangd')).toBe(false);
    });

    it('aborts a server startup before restarting it', async () => {
      const { privateView } = await reconcileMidStartup([
        { ...serverConfig, args: ['--log=verbose'] },
      ]);
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
    const workspaceRoot = path.resolve('/workspace/project');

    it.each([
      ['allows bare commands resolved through PATH', 'clangd', false, true],
      [
        'allows explicit absolute command paths',
        path.join(path.parse(workspaceRoot).root, 'usr', 'bin', 'clangd'),
        false,
        true,
      ],
      [
        'allows relative paths that resolve inside the workspace',
        './tools/clangd',
        true,
        true,
      ],
      [
        'blocks relative paths that escape the workspace',
        '../bin/clangd',
        true,
        false,
      ],
      [
        'blocks relative paths that use intermediate traversal to escape',
        './tools/../../../etc/passwd',
        true,
        false,
      ],
      // A command like "subdir/server" is relative; if it resolves inside
      // the workspace it should be allowed.
      [
        'treats commands with forward slash but no path.sep on Windows as relative',
        'tools/clangd',
        true,
        true,
      ],
    ])('%s', (_title, command, withCwd, safe) => {
      const manager = createManager(workspaceRoot);
      const cwd = withCwd ? workspaceRoot : undefined;
      expect(manager.isPathSafe(command, workspaceRoot, cwd)).toBe(safe);
    });
  });

  it('logs process diagnostics when startup fails after connection creation', async () => {
    const manager = createTrustedManager();
    const processDiagnostics = {
      stderrTail: 'clangd: unknown argument\n',
      exitCode: 7,
      exitSignal: null,
    };
    openGates(manager);
    const connection = createMockConnection();
    const process = createMockProcess();
    stubConnection(manager, {
      connection,
      process,
      processDiagnostics,
    }).initializeLspServer.mockRejectedValue(new Error('initialize failed'));

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
    spyPrivate(manager, 'checkWorkspaceTrust').mockResolvedValue(false);

    manager.setServerConfigs([serverConfig]);
    await manager.startAll();

    expect(manager.getHandles().get('clangd')?.status).toBe('FAILED');
    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      'Workspace trust check failed, not starting LSP server clangd',
    );
  });

  it('does not probe command existence for unsafe command paths', async () => {
    const manager = createTrustedManager();
    spyPrivate(manager, 'checkWorkspaceTrust').mockResolvedValue(true);
    const isPathSafe = spyPrivate(manager, 'isPathSafe').mockReturnValue(false);
    const commandExists = spyPrivate(manager, 'commandExists');

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
    openGates(manager, [false, true]);
    stubConnection(manager, {
      connection: createMockConnection(),
      process: createMockProcess(),
    });

    manager.setServerConfigs([serverConfig]);
    await manager.startAll();
    const result = await manager.reconcileServerConfigs([serverConfig]);

    expect(result.restarted).toEqual(['clangd']);
    expect(manager.getHandles().get('clangd')?.status).toBe('READY');
  });

  it('passes LSP config env through command probe filtering', async () => {
    const manager = createTrustedManager();
    const commandExists = openGates(manager).mockResolvedValue(false);

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
    const { manager, crash } = crashingManager([true, false, true]);
    const config = { ...serverConfig, restartOnCrash: true };

    manager.setServerConfigs([config]);
    await manager.startAll();
    expect(crash.exit).toBeDefined();

    crash.exit?.(1);
    const result = await manager.reconcileServerConfigs([config]);

    expect(result.restarted).toEqual(['clangd']);
    expect(manager.getHandles().get('clangd')?.status).toBe('READY');
  });

  it('does not restart a crashed server while stopping all servers', async () => {
    const { manager, crash, createLspConnection } = crashingManager();
    const config = { ...serverConfig, restartOnCrash: true };

    manager.setServerConfigs([config]);
    await manager.startAll();
    expect(crash.exit).toBeDefined();

    crash.exit?.(1);
    await manager.stopAll();

    expect(createLspConnection).toHaveBeenCalledOnce();
    expect(manager.getHandles().size).toBe(0);
  });

  it('does not restart a crashed stale handle', async () => {
    const { manager, crash, createLspConnection } = crashingManager();
    const config = { ...serverConfig, restartOnCrash: true };

    manager.setServerConfigs([config]);
    await manager.startAll();
    expect(crash.exit).toBeDefined();

    crash.exit?.(1);
    manager.clearServerHandles();
    await Promise.resolve();

    expect(createLspConnection).toHaveBeenCalledOnce();
  });

  it('does not restart a crashed handle already being stopped', async () => {
    const { manager, crash, createLspConnection } = crashingManager();
    const config = { ...serverConfig, restartOnCrash: true };

    manager.setServerConfigs([config]);
    await manager.startAll();
    const handle = manager.getHandles().get('clangd');
    expect(crash.exit).toBeDefined();
    expect(handle).toBeDefined();

    crash.exit?.(1);
    handle!.stopRequested = true;
    await Promise.resolve();

    expect(createLspConnection).toHaveBeenCalledOnce();
  });

  it('retries the same config after a crash without restartOnCrash', async () => {
    const { manager, crash, createLspConnection } = crashingManager();

    manager.setServerConfigs([serverConfig]);
    await manager.startAll();
    expect(crash.exit).toBeDefined();

    crash.exit?.(1);
    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      'LSP server clangd exited but restartOnCrash is disabled',
    );
    const result = await manager.reconcileServerConfigs([serverConfig]);

    expect(result.restarted).toEqual(['clangd']);
    expect(createLspConnection).toHaveBeenCalledTimes(2);
    expect(manager.getHandles().get('clangd')?.status).toBe('READY');
  });

  it('logs when a crashed server has zero restart attempts configured', async () => {
    const { manager, crash } = crashingManager();
    const config = { ...serverConfig, restartOnCrash: true, maxRestarts: 0 };

    manager.setServerConfigs([config]);
    await manager.startAll();
    expect(crash.exit).toBeDefined();

    crash.exit?.(1);

    expect(debugLoggerMock.warn).toHaveBeenCalledWith(
      'LSP server clangd exited but maxRestarts is 0',
    );
    expect(manager.getHandles().get('clangd')?.status).toBe('FAILED');
  });

  it('retries the same config after crash restart attempts are exhausted', async () => {
    const { manager, crash, createLspConnection } = crashingManager();
    const config = { ...serverConfig, restartOnCrash: true, maxRestarts: 1 };

    manager.setServerConfigs([config]);
    await manager.startAll();
    const handle = manager.getHandles().get('clangd');
    expect(crash.exit).toBeDefined();
    expect(handle).toBeDefined();
    handle!.restartAttempts = 1;

    crash.exit?.(1);
    const result = await manager.reconcileServerConfigs([config]);

    expect(result.restarted).toEqual(['clangd']);
    expect(createLspConnection).toHaveBeenCalledTimes(2);
    expect(manager.getHandles().get('clangd')?.status).toBe('READY');
  });

  it('filters security-sensitive LSP environment overrides', () => {
    const manager = createTrustedManager();
    const env = privates(manager).buildProcessEnv({
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
    const env = privates(manager).buildCommandProbeEnv({
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
    const { process, crash } = crashableProcess({
      kill: vi.fn(() => {
        throw new Error('kill failed');
      }),
    });
    const connection = createMockConnection({
      end: vi.fn(() => {
        throw new Error('end failed');
      }),
    });
    openGates(manager);
    spyPrivate(manager, 'createLspConnection')
      .mockResolvedValueOnce({
        connection,
        process: process as unknown as ChildProcess,
      } as unknown as LspConnectionResult)
      .mockResolvedValueOnce({
        connection: createMockConnection(),
        process: createMockProcess() as unknown as ChildProcess,
      } as unknown as LspConnectionResult);
    spyPrivate(manager, 'initializeLspServer').mockResolvedValue(undefined);

    manager.setServerConfigs([{ ...serverConfig, restartOnCrash: true }]);
    await manager.startAll();
    crash.exit?.(1);
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
    readyHandle(manager, socketConfig, connection, process);

    await manager.stopAll();

    expect(connection.shutdown).toHaveBeenCalledOnce();
    expect(connection.end).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it('cancels an in-flight socket startup retry when stopped', async () => {
    const manager = createTrustedManager();
    openGates(manager);
    vi.spyOn(LspConnectionFactory, 'createSocketConnection').mockReturnValue(
      new Promise(() => {}),
    );
    manager.setServerConfigs([
      socketChildConfig(['-e', 'setTimeout(() => {}, 10000);'], 65534),
    ]);

    const startAll = manager.startAll();
    await vi.waitFor(() => {
      expect(LspConnectionFactory.createSocketConnection).toHaveBeenCalled();
    });

    const stopped = await stopsPromptly(manager);
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
    const privateView = privates(manager);

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

  it('cleans up a socket connection that resolves after startup abort wins', async () => {
    const manager = createTrustedManager();
    const controller = new AbortController();
    const connection = { connection: { end: vi.fn() } };
    let resolveConnection!: (value: typeof connection) => void;
    const privateView = privates(manager);
    const connectionPromise = new Promise<typeof connection>((resolve) => {
      resolveConnection = resolve;
    });

    const wait = privateView.raceStartupAbort(
      connectionPromise,
      controller.signal,
      (value) => value.connection.end(),
    );
    controller.abort();
    await expect(wait).rejects.toThrow('LSP server startup cancelled');

    resolveConnection(connection);
    await Promise.resolve();

    expect(connection.connection.end).toHaveBeenCalledOnce();
  });

  it('observes a startup promise that rejects after abort wins', async () => {
    const manager = createTrustedManager();
    const controller = new AbortController();
    let rejectStartup!: (error: Error) => void;
    const privateView = privates(manager);
    const startupPromise = new Promise<void>((_resolve, reject) => {
      rejectStartup = reject;
    });

    const wait = privateView.raceStartupAbort(
      startupPromise,
      controller.signal,
    );
    controller.abort();
    await expect(wait).rejects.toThrow('LSP server startup cancelled');

    rejectStartup(new Error('late socket failure'));
    await Promise.resolve();
  });

  it('cancels a startup that is waiting for protocol initialization', async () => {
    const manager = createTrustedManager();
    openGates(manager);
    stubConnection(manager, {
      connection: createMockConnection(),
      process: createMockProcess(),
    }).initializeLspServer.mockReturnValue(new Promise<void>(() => {}));

    manager.setServerConfigs([serverConfig]);
    const startAll = manager.startAll();
    await vi.waitFor(() => {
      expect(manager.getHandles().get('clangd')?.status).toBe('IN_PROGRESS');
    });

    const stopped = await stopsPromptly(manager);
    await startAll;

    expect(stopped).toBe(true);
    expect(manager.getHandles().size).toBe(0);
  });

  it('fails socket startup early when the child exits before connect', async () => {
    const manager = createTrustedManager();
    openGates(manager);
    vi.spyOn(LspConnectionFactory, 'createSocketConnection').mockReturnValue(
      new Promise(() => {}),
    );
    manager.setServerConfigs([
      socketChildConfig(
        [
          '-e',
          'process.stderr.write("socket startup failed\\n"); process.exit(7);',
        ],
        65533,
      ),
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

  it('does not crash-restart a server that exits during protocol initialization', async () => {
    const { manager, crash, createLspConnection, initializeLspServer } =
      crashingManager();
    let resolveInitialize!: () => void;
    initializeLspServer.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInitialize = resolve;
      }),
    );

    manager.setServerConfigs([{ ...serverConfig, restartOnCrash: true }]);
    const startAll = manager.startAll();
    await vi.waitFor(() => {
      expect(crash.exit).toBeDefined();
    });
    crash.exit?.(1);
    resolveInitialize();
    await startAll;

    expect(createLspConnection).toHaveBeenCalledOnce();
    expect(manager.getHandles().get('clangd')?.status).toBe('FAILED');
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
    readyHandle(manager, serverConfig, connection, process);

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
    readyHandle(
      manager,
      { ...serverConfig, shutdownTimeout: 30_000 },
      connection,
    );

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
    readyHandle(
      manager,
      { ...serverConfig, shutdownTimeout: 30_000 },
      createMockConnection(),
    );

    await manager.stopAll();

    expect(shutdownTimer).toBeDefined();
    expect(shutdownTimer?.hasRef()).toBe(false);
  });

  it('unrefs and clears command probe timeout when the command errors first', async () => {
    const manager = createTrustedManager();
    const timer = {
      unref: vi.fn(),
    } as unknown as ReturnType<typeof setTimeout>;
    vi.spyOn(globalThis, 'setTimeout').mockReturnValue(timer);
    const clearTimeout = vi
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(() => undefined);
    const commandExists = privates(manager).commandExists(
      '__qwen_lsp_missing_command__',
    );

    await expect(commandExists).resolves.toBe(false);
    expect(timer.unref).toHaveBeenCalledOnce();
    expect(clearTimeout).toHaveBeenCalledWith(timer);
  });

  /** A connection whose shutdown never settles, so only the timeout ends it. */
  const hangingShutdown = () =>
    createMockConnection({
      shutdown: vi.fn(() => new Promise<void>(() => {})),
    });

  it('ends the connection when shutdown timeout fires', async () => {
    vi.useFakeTimers();
    const manager = createTrustedManager();
    const connection = hangingShutdown();
    readyHandle(
      manager,
      { ...serverConfig, shutdownTimeout: 30_000 },
      connection,
    );

    const stopAll = manager.stopAll();
    await vi.advanceTimersByTimeAsync(30_000);
    await stopAll;

    expect(connection.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the default shutdown timeout when none is configured', async () => {
    vi.useFakeTimers();
    const manager = createTrustedManager();
    const connection = hangingShutdown();
    readyHandle(manager, serverConfig, connection);

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
    const handle = registerHandle(manager);
    let resolveStartup!: () => void;
    handle.startingPromise = new Promise<void>((resolve) => {
      resolveStartup = () => {
        handle.connection = connection;
        handle.process = process as unknown as ChildProcess;
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
    off?: ReturnType<typeof vi.fn>;
  } = {},
): {
  exitCode: number | null;
  kill: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
} {
  return {
    exitCode: overrides.exitCode ?? null,
    kill: overrides.kill ?? vi.fn(),
    once: overrides.once ?? vi.fn(),
    off: overrides.off ?? vi.fn(),
  };
}
