/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, beforeEach, afterEach, expect, test, vi } from 'vitest';
import { NativeLspService } from './native-lsp-service.js';
import { EventEmitter } from 'events';
import type { Config as CoreConfig } from '../config/config.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { IdeContextStore } from '../ide/ideContext.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import type { NativeLspServiceOptions } from './types.js';
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

const TS = 'typescript-language-server';
const PY = 'pyright-langserver';
const TS_TEXT = 'const value = 1;\n';
const CPP_TEXT = 'int main(){return 0;}\n';
const JAVA_TEXT = 'public class Main { }\n';

type Fn = ReturnType<typeof vi.fn>;
type Reconcile = Record<
  'added' | 'removed' | 'restarted' | 'unchanged' | 'failed',
  string[]
>;
type Internals = {
  serverManager: unknown;
  openedDocuments: Map<string, Map<string, { text: string; version: number }>>;
  lastConnections: Map<string, unknown>;
  replayUris: Map<string, Set<string>>;
};

const internalsOf = (service: NativeLspService) =>
  service as unknown as Internals;
const reconcile = (result: Partial<Reconcile> = {}): Reconcile => ({
  added: [],
  removed: [],
  restarted: [],
  unchanged: [],
  failed: [],
  ...result,
});
const openOld = (internals: Internals, server: string, uri: string) =>
  internals.openedDocuments.set(
    server,
    new Map([[uri, { text: 'old', version: 1 }]]),
  );
const zeroRange = () => ({
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function inTempDir(
  prefix: string,
  fn: (dir: string) => Promise<void>,
  fakeTimers = false,
) {
  if (fakeTimers) vi.useFakeTimers();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    if (fakeTimers) vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const inTempDirWithFakeTimers = (
  prefix: string,
  fn: (dir: string) => Promise<void>,
) => inTempDir(prefix, fn, true);

/** Runs pending fake timers, then settles the already-started operation. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

const hover = (service: NativeLspService, uri: string) =>
  settle(service.hover({ uri, range: zeroRange() }));

function writeLspJson(
  dir: string,
  config: unknown = { typescript: { command: TS } },
) {
  fs.writeFileSync(
    path.join(dir, '.lsp.json'),
    typeof config === 'string' ? config : JSON.stringify(config),
  );
}

function writeDoc(dir: string, name: string, text: string) {
  const filePath = path.join(dir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf-8');
  return pathToFileURL(filePath).toString();
}

function configAt(rootPath?: string, trusted = true) {
  const config = new MockConfig();
  if (rootPath !== undefined) config.rootPath = rootPath;
  if (!trusted) vi.spyOn(config, 'isTrustedFolder').mockReturnValue(false);
  return config;
}

const makeConnection = (
  overrides: Partial<Record<'send' | 'request', Fn>> = {},
) => ({
  listen: vi.fn(),
  send: vi.fn() as Fn,
  onNotification: vi.fn(),
  onRequest: vi.fn(),
  request: vi.fn(async () => null) as Fn,
  initialize: vi.fn(async () => ({})),
  shutdown: vi.fn(async () => {}),
  end: vi.fn(),
  ...overrides,
});
type Connection = ReturnType<typeof makeConnection>;

const makeHandle = (
  connection: Connection,
  name = 'clangd',
  languages = ['cpp'],
  command = name,
  args: string[] = [],
) => ({
  config: { name, languages, command, args, transport: 'stdio' },
  status: 'READY',
  textDocumentSync: 1,
  connection,
});

/** Server manager for query tests; `isTypescriptServer` is omitted unless given. */
const managerFor = (
  key: string,
  handle: unknown,
  isTypescriptServer?: boolean,
  warmupTypescriptServer: Fn = vi.fn(),
) => ({
  getHandles: () => new Map([[key, handle]]),
  warmupTypescriptServer,
  ...(isTypescriptServer === undefined
    ? {}
    : { isTypescriptServer: () => isTypescriptServer }),
});

/** A service rooted at `dir` with its own workspace, emitter and discovery. */
function workspaceService(dir: string, serverManager: unknown) {
  const workspace = new MockWorkspaceContext();
  workspace.rootPath = dir;
  const service = new NativeLspService(
    configAt(dir) as unknown as CoreConfig,
    workspace as unknown as WorkspaceContext,
    new EventEmitter(),
    new MockFileDiscoveryService() as unknown as FileDiscoveryService,
    new MockIdeContextStore() as unknown as IdeContextStore,
    { workspaceRoot: dir },
  );
  internalsOf(service).serverManager = serverManager;
  return service;
}

function expectDidOpen(
  connection: Connection,
  uri: string,
  languageId: string,
  text?: string,
) {
  expect(connection.send).toHaveBeenCalledWith(
    expect.objectContaining({
      method: 'textDocument/didOpen',
      params: {
        textDocument: expect.objectContaining({
          uri,
          languageId,
          ...(text === undefined ? {} : { text }),
        }),
      },
    }),
  );
}

/** Connection logging `send:<method>` / `request:<method>` into `events`. */
const loggingConnection = (
  events: string[],
  answer: (method: string) => unknown = () => null,
) =>
  makeConnection({
    send: vi.fn((message: { method?: string }) => {
      events.push(`send:${message.method ?? 'unknown'}`);
    }),
    request: vi.fn(async (method: string) => {
      events.push(`request:${method}`);
      return answer(method);
    }),
  });

const calculatorSymbol = (uri: string) => ({
  name: 'Calculator',
  kind: 5,
  location: {
    uri,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 10 },
    },
  },
});

describe('NativeLspService', () => {
  let lspService: NativeLspService;
  let mockConfig: MockConfig;
  let mockWorkspace: MockWorkspaceContext;
  let mockFileDiscovery: MockFileDiscoveryService;
  let mockIdeStore: MockIdeContextStore;
  let eventEmitter: EventEmitter;

  const newService = (
    config: MockConfig = mockConfig,
    options?: NativeLspServiceOptions,
  ) =>
    new NativeLspService(
      config as unknown as CoreConfig,
      mockWorkspace as unknown as WorkspaceContext,
      eventEmitter,
      mockFileDiscovery as unknown as FileDiscoveryService,
      mockIdeStore as unknown as IdeContextStore,
      options,
    );

  /** Service rooted at `dir` whose server manager is `{ reconcileServerConfigs, ...extra }`. */
  function reconcilingService(
    dir: string,
    reconcileServerConfigs: unknown,
    extra: object = {},
  ) {
    const service = newService(configAt(dir), { workspaceRoot: dir });
    internalsOf(service).serverManager = { reconcileServerConfigs, ...extra };
    return service;
  }

  /** One ready TypeScript server plus a TS file on disk, for replay tests. */
  function setupTsReplay(
    dir: string,
    file = 'main.ts',
    reconcileServerConfigs: unknown = vi.fn(async () =>
      reconcile({ restarted: [TS] }),
    ),
    extra: object = {},
  ) {
    const uri = writeDoc(dir, file, TS_TEXT);
    writeLspJson(dir);
    const connection = makeConnection();
    const handle = makeHandle(connection, TS, ['typescript']);
    const service = reconcilingService(dir, reconcileServerConfigs, {
      getHandles: () => new Map([[TS, handle]]),
      ...extra,
    });
    return { service, connection, uri, internals: internalsOf(service) };
  }

  function untrustedService(dir: string) {
    writeLspJson(dir, {
      trusted: {
        command: 'trusted-language-server',
        languages: ['typescript'],
        trustRequired: true,
      },
      untrusted: {
        command: 'untrusted-language-server',
        languages: ['javascript'],
        trustRequired: false,
      },
    });
    return newService(configAt(dir, false), {
      requireTrustedWorkspace: false,
      workspaceRoot: dir,
    });
  }

  beforeEach(() => {
    mockConfig = new MockConfig();
    mockWorkspace = new MockWorkspaceContext();
    mockFileDiscovery = new MockFileDiscoveryService();
    mockIdeStore = new MockIdeContextStore();
    eventEmitter = new EventEmitter();

    lspService = newService();
  });

  test('should initialize correctly', () => {
    expect(lspService).toBeDefined();
  });

  test('discoverAndPrepare should not invoke language detection', async () => {
    const service = newService();

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

  test('reinitialize reconciles valid .lsp.json configs', () =>
    inTempDir('lsp-reinit-', async (dir) => {
      writeLspJson(dir, { typescript: { command: TS, args: ['--stdio'] } });
      const reconcileServerConfigs = vi.fn(async () =>
        reconcile({ added: [TS] }),
      );

      const result = await reconcilingService(
        dir,
        reconcileServerConfigs,
      ).reinitialize();

      expect(reconcileServerConfigs).toHaveBeenCalledWith([
        expect.objectContaining({ name: TS, languages: ['typescript'] }),
      ]);
      expect(result.reconcile.added).toEqual([TS]);
      expect(result.skipped).toEqual([]);
    }));

  test('reinitialize preserves runtime state on invalid .lsp.json', () =>
    inTempDir('lsp-invalid-', async (dir) => {
      writeLspJson(dir, '{');
      const reconcileServerConfigs = vi.fn();
      const service = reconcilingService(dir, reconcileServerConfigs);

      await expect(service.reinitialize()).rejects.toThrow();
      expect(reconcileServerConfigs).not.toHaveBeenCalled();
    }));

  test('reinitialize preserves runtime state on invalid server entries', () =>
    inTempDir('lsp-invalid-', async (dir) => {
      writeLspJson(dir, { typescript: { transport: 'stdio' } });
      const reconcileServerConfigs = vi.fn();
      const service = reconcilingService(dir, reconcileServerConfigs);

      await expect(service.reinitialize()).rejects.toThrow(
        'Invalid LSP server config',
      );
      expect(reconcileServerConfigs).not.toHaveBeenCalled();
    }));

  test('reinitialize queue continues after a failed reload', () =>
    inTempDir('lsp-queue-error-', async (dir) => {
      writeLspJson(dir, '{');
      const reconcileServerConfigs = vi.fn(async () =>
        reconcile({ added: [TS] }),
      );
      const service = reconcilingService(dir, reconcileServerConfigs);

      await expect(service.reinitialize()).rejects.toThrow();
      expect(reconcileServerConfigs).not.toHaveBeenCalled();

      writeLspJson(dir);
      const result = await service.reinitialize();

      expect(reconcileServerConfigs).toHaveBeenCalledOnce();
      expect(result.reconcile.added).toEqual([TS]);
    }));

  test('reinitialize replays open documents after restarting servers', () =>
    inTempDirWithFakeTimers('lsp-replay-', async (dir) => {
      const { service, connection, uri, internals } = setupTsReplay(dir);
      openOld(internals, TS, uri);

      await settle(service.reinitialize());

      expectDidOpen(connection, uri, 'typescript', TS_TEXT);
      expect(vi.getTimerCount()).toBe(0);
    }));

  test('replays URIs that were only parked when a server reloads', () =>
    inTempDirWithFakeTimers('lsp-parked-', async (dir) => {
      const secondUri = writeDoc(dir, 'second.ts', 'const other = 2;\n');
      const { service, connection, uri, internals } = setupTsReplay(dir);
      openOld(internals, TS, uri);
      internals.replayUris.set(TS, new Set([secondUri]));

      await settle(service.reinitialize());

      const openedUris = connection.send.mock.calls
        .filter(([message]) => message.method === 'textDocument/didOpen')
        .map(
          ([message]) =>
            (message.params as { textDocument: { uri: string } }).textDocument
              .uri,
        );
      expect(new Set(openedUris)).toEqual(new Set([uri, secondUri]));
      // The reload snapshot consumed the durable set.
      expect(internals.replayUris.has(TS)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    }));

  test('reinitialize continues replaying documents after one server send fails', () =>
    inTempDirWithFakeTimers('lsp-replay-', async (dir) => {
      const firstUri = writeDoc(dir, 'first.ts', TS_TEXT);
      const secondUri = writeDoc(dir, 'second.py', 'value = 1\n');
      writeLspJson(dir, {
        typescript: { command: TS },
        python: { command: PY },
      });
      const firstConnection = makeConnection({
        send: vi.fn(() => {
          throw new Error('broken pipe');
        }),
      });
      const secondConnection = makeConnection();
      const handles = new Map([
        [TS, makeHandle(firstConnection, TS, ['typescript'])],
        [PY, makeHandle(secondConnection, PY, ['python'])],
      ]);
      const service = reconcilingService(
        dir,
        vi.fn(async () => reconcile({ restarted: [TS, PY] })),
        { getHandles: () => handles },
      );
      const internals = internalsOf(service);
      openOld(internals, TS, firstUri);
      openOld(internals, PY, secondUri);

      await expect(settle(service.reinitialize())).resolves.toBeDefined();

      expect(firstConnection.send).toHaveBeenCalledOnce();
      expect(internals.lastConnections.get(TS)).toBe(firstConnection);
      expect(internals.openedDocuments.has(TS)).toBe(false);
      expect(internals.lastConnections.get(PY)).toBe(secondConnection);
      expectDidOpen(secondConnection, secondUri, 'python', 'value = 1\n');
    }));

  test('reinitialize preserves open documents for failed servers until a later restart succeeds', () =>
    inTempDirWithFakeTimers('lsp-failed-', async (dir) => {
      const { service, connection, uri, internals } = setupTsReplay(
        dir,
        'index.ts',
        vi
          .fn()
          .mockResolvedValueOnce(reconcile({ failed: [TS] }))
          .mockResolvedValueOnce(reconcile({ restarted: [TS] })),
      );
      openOld(internals, TS, uri);

      await service.reinitialize();
      expect(internals.openedDocuments.get(TS)).toEqual(
        new Map([[uri, { text: 'old', version: 1 }]]),
      );

      await settle(service.reinitialize());

      expectDidOpen(connection, uri, 'typescript', TS_TEXT);
    }));

  test('reinitialize serializes the full snapshot reconcile and replay flow', () =>
    inTempDir('lsp-queue-', async (dir) => {
      writeLspJson(dir);
      const firstReconcile = deferred<Reconcile>();
      const reconcileServerConfigs = vi
        .fn()
        .mockReturnValueOnce(firstReconcile.promise)
        .mockResolvedValueOnce(reconcile({ unchanged: [TS] }));
      const service = reconcilingService(dir, reconcileServerConfigs);

      const first = service.reinitialize();
      await vi.waitFor(() => {
        expect(reconcileServerConfigs).toHaveBeenCalledOnce();
      });
      const second = service.reinitialize();
      await Promise.resolve();

      expect(reconcileServerConfigs).toHaveBeenCalledOnce();

      firstReconcile.resolve(reconcile({ added: [TS] }));
      await first;
      await vi.waitFor(() => {
        expect(reconcileServerConfigs).toHaveBeenCalledTimes(2);
      });
      await second;
    }));

  test('reinitialize snapshots documents opened while reconcile is pending', () =>
    inTempDirWithFakeTimers('lsp-snapshot-', async (dir) => {
      const pending = deferred<Reconcile>();
      const reconcileServerConfigs = vi.fn(() => pending.promise);
      const { service, connection, uri, internals } = setupTsReplay(
        dir,
        'index.ts',
        reconcileServerConfigs,
      );

      const reinitialize = service.reinitialize();
      await vi.waitFor(() => {
        expect(reconcileServerConfigs).toHaveBeenCalledOnce();
      });
      openOld(internals, TS, uri);
      pending.resolve(reconcile({ restarted: [TS] }));
      await settle(reinitialize);

      expectDidOpen(connection, uri, 'typescript', TS_TEXT);
    }));

  test('stop cancels an in-flight reinitialize replay delay', () =>
    inTempDirWithFakeTimers('lsp-stop-', async (dir) => {
      const stopAll = vi.fn(async () => {});
      const { service, connection, uri, internals } = setupTsReplay(
        dir,
        'index.ts',
        undefined,
        { stopAll },
      );
      openOld(internals, TS, uri);
      internals.lastConnections.set(TS, connection);

      const reinitialize = service.reinitialize();
      await vi.waitFor(() => {
        expect(connection.send).toHaveBeenCalledOnce();
      });
      await service.stop();

      await expect(reinitialize).rejects.toThrow('LSP reinitialize cancelled');
      expect(stopAll).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      expect(internals.openedDocuments.size).toBe(0);
      expect(internals.lastConnections.size).toBe(0);
    }));

  test('stop cancels queued reinitialize calls before they start', () =>
    inTempDir('lsp-stop-queue-', async (dir) => {
      writeLspJson(dir);
      const firstReconcile = deferred<Reconcile>();
      const reconcileServerConfigs = vi.fn(() => firstReconcile.promise);
      const stopAll = vi.fn(async () => {});
      const service = reconcilingService(dir, reconcileServerConfigs, {
        stopAll,
      });

      const first = service.reinitialize();
      await vi.waitFor(() => {
        expect(reconcileServerConfigs).toHaveBeenCalledOnce();
      });
      const second = service.reinitialize();
      await service.stop();

      firstReconcile.resolve(reconcile({ added: [TS] }));

      await expect(first).rejects.toThrow('LSP reinitialize cancelled');
      await expect(second).rejects.toThrow('LSP reinitialize cancelled');
      expect(reconcileServerConfigs).toHaveBeenCalledOnce();
      expect(stopAll).toHaveBeenCalledOnce();
    }));

  test('reinitialize stops all servers when trusted workspace is required but unavailable', async () => {
    const service = newService(configAt(undefined, false), {
      requireTrustedWorkspace: true,
    });
    const stopAll = vi.fn(async () => {});
    const internals = internalsOf(service);
    internals.serverManager = {
      getHandles: () => new Map([['tsserver', {}]]),
      stopAll,
    };
    openOld(internals, 'tsserver', 'file:///a.ts');
    internals.lastConnections.set('tsserver', {});

    const result = await service.reinitialize();

    expect(stopAll).toHaveBeenCalledOnce();
    expect(result.reconcile.removed).toEqual(['tsserver']);
    expect(internals.openedDocuments.has('tsserver')).toBe(false);
    expect(internals.lastConnections.has('tsserver')).toBe(false);
  });

  test('reinitialize skips all user-configured servers in untrusted workspaces', () =>
    inTempDir('lsp-untrusted-', async (dir) => {
      const service = untrustedService(dir);
      const reconcileServerConfigs = vi.fn(async () => reconcile());
      internalsOf(service).serverManager = { reconcileServerConfigs };

      const result = await service.reinitialize();

      expect(reconcileServerConfigs).toHaveBeenCalledWith([]);
      expect(result.skipped).toEqual([
        { name: 'trusted-language-server', reason: 'server_trust_required' },
        { name: 'untrusted-language-server', reason: 'server_trust_required' },
      ]);
    }));

  test('discoverAndPrepare skips trust-required servers in untrusted workspaces', () =>
    inTempDir('lsp-discover-', async (dir) => {
      const service = untrustedService(dir);

      await service.discoverAndPrepare();

      const handles = Array.from(
        (
          service as unknown as {
            serverManager: { getHandles: () => Map<string, unknown> };
          }
        ).serverManager
          .getHandles()
          .keys(),
      );
      expect(handles).toEqual([]);
    }));

  test('stop clears document tracking caches', async () => {
    const stopAll = vi.fn(async () => {});
    const internals = internalsOf(lspService);
    internals.serverManager = { stopAll };
    openOld(internals, 'tsserver', 'file:///a.ts');
    internals.lastConnections.set('tsserver', {});

    await lspService.stop();

    expect(stopAll).toHaveBeenCalledOnce();
    expect(internals.openedDocuments.size).toBe(0);
    expect(internals.lastConnections.size).toBe(0);
  });

  test('should expose a detailed status snapshot for configured servers', () => {
    internalsOf(lspService).serverManager = {
      getHandles: () =>
        new Map([
          [
            'clangd',
            {
              config: {
                name: 'clangd',
                languages: ['c', 'cpp'],
                command: 'clangd',
                args: ['--background-index'],
                transport: 'stdio',
                rootUri: 'file:///test/workspace',
                workspaceFolder: '/test/workspace',
              },
              status: 'READY',
              textDocumentSync: 1,
              process: { pid: 12345 },
              warmedUp: true,
              restartAttempts: 1,
              processDiagnostics: {
                stderrTail: 'clangd: unknown argument\n',
                exitCode: 7,
                exitSignal: null,
              },
            },
          ],
          [
            'pyright',
            {
              config: {
                name: 'pyright',
                languages: ['python'],
                command: 'pyright-langserver',
                args: ['--stdio'],
                transport: 'stdio',
                rootUri: 'file:///test/workspace',
                workspaceFolder: '/test/workspace',
              },
              status: 'FAILED',
              error: new Error('startup failed'),
            },
          ],
        ]),
    };

    const snapshot = lspService.getStatusSnapshot();

    expect(snapshot).toEqual({
      enabled: true,
      configuredServers: 2,
      readyServers: 1,
      failedServers: 1,
      inProgressServers: 0,
      notStartedServers: 0,
      servers: [
        {
          name: 'clangd',
          status: 'READY',
          languages: ['c', 'cpp'],
          transport: 'stdio',
          command: 'clangd',
          args: ['--background-index'],
          rootUri: 'file:///test/workspace',
          workspaceFolder: '/test/workspace',
          pid: 12345,
          warmedUp: true,
          restartAttempts: 1,
          stderrTail: 'clangd: unknown argument\n',
          exitCode: 7,
          exitSignal: null,
        },
        {
          name: 'pyright',
          status: 'FAILED',
          languages: ['python'],
          transport: 'stdio',
          command: 'pyright-langserver',
          args: ['--stdio'],
          rootUri: 'file:///test/workspace',
          workspaceFolder: '/test/workspace',
          error: 'startup failed',
        },
      ],
    });
  });

  test('should open document before hover requests', () =>
    inTempDirWithFakeTimers('lsp-test-', async (dir) => {
      const uri = writeDoc(dir, 'main.cpp', CPP_TEXT);
      const events: string[] = [];
      const connection = loggingConnection(events);
      internalsOf(lspService).serverManager = managerFor(
        'clangd',
        makeHandle(connection),
      );

      await hover(lspService, uri);

      expectDidOpen(connection, uri, 'cpp');
      expect(connection.request).toHaveBeenCalledWith(
        'textDocument/hover',
        expect.any(Object),
      );
      expect(events[0]).toBe('send:textDocument/didOpen');

      await hover(lspService, uri);

      expect(connection.send).toHaveBeenCalledTimes(1);
    }));

  test('should open a workspace file before workspace symbol search', () =>
    inTempDirWithFakeTimers('lsp-symbol-', async (dir) => {
      const workspaceUri = writeDoc(dir, 'src/main.cpp', CPP_TEXT);
      const events: string[] = [];
      const opened = () => events.includes('send:textDocument/didOpen');
      const connection = loggingConnection(events, (method) => {
        if (method !== 'workspace/symbol') return null;
        return opened() ? [calculatorSymbol(workspaceUri)] : [];
      });
      const service = workspaceService(
        dir,
        managerFor('clangd', makeHandle(connection), false),
      );

      const results = await settle(service.workspaceSymbols('Calculator'));

      expect(connection.send).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'textDocument/didOpen' }),
      );
      expect(events[0]).toBe('send:textDocument/didOpen');
      expect(results.length).toBe(1);
    }));

  test('should retry workspace symbols after warmup when initial result is empty', () =>
    inTempDirWithFakeTimers('lsp-symbol-retry-', async (dir) => {
      const workspaceUri = writeDoc(dir, 'src/main.cpp', CPP_TEXT);
      const events: string[] = [];
      let symbolCalls = 0;
      const connection = loggingConnection(events, (method) => {
        if (method !== 'workspace/symbol') return null;
        symbolCalls += 1;
        if (!events.includes('send:textDocument/didOpen')) return [];
        return symbolCalls === 1 ? [] : [calculatorSymbol(workspaceUri)];
      });
      const service = workspaceService(
        dir,
        managerFor('clangd', makeHandle(connection), false),
      );

      const results = await settle(service.workspaceSymbols('Calculator'));

      expect(symbolCalls).toBe(2);
      expect(results.length).toBe(1);
      expect(events[0]).toBe('send:textDocument/didOpen');
    }));

  test('should not retry workspace symbols when no warmup file is available', () =>
    inTempDirWithFakeTimers('lsp-symbol-empty-', async (dir) => {
      let symbolCalls = 0;
      const connection = makeConnection({
        request: vi.fn(async (method: string) => {
          if (method !== 'workspace/symbol') return null;
          symbolCalls += 1;
          return [];
        }),
      });
      const service = workspaceService(
        dir,
        managerFor('clangd', makeHandle(connection), false),
      );

      await settle(service.workspaceSymbols('Calculator'));

      expect(symbolCalls).toBe(1);
    }));

  test('should reopen documents after connection changes', () =>
    inTempDirWithFakeTimers('lsp-reopen-', async (dir) => {
      const uri = writeDoc(dir, 'main.cpp', CPP_TEXT);
      const connection1 = makeConnection();
      const connection2 = makeConnection();
      const handle = makeHandle(connection1);
      const service = workspaceService(dir, managerFor('clangd', handle));

      await hover(service, uri);

      expect(connection1.send).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'textDocument/didOpen' }),
      );

      handle.connection = connection2;
      await hover(service, uri);

      expect(connection2.send).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'textDocument/didOpen' }),
      );
    }));

  test('should delay after fresh document open then send request', () =>
    inTempDirWithFakeTimers('lsp-delay-', async (dir) => {
      const uri = writeDoc(dir, 'main.cpp', CPP_TEXT);
      const timeline: Array<{ event: string; time: number }> = [];
      const connection = makeConnection({
        send: vi.fn((message: { method?: string }) => {
          if (message.method === 'textDocument/didOpen') {
            timeline.push({ event: 'didOpen', time: Date.now() });
          }
        }),
        request: vi.fn(async (method: string) => {
          if (method !== 'textDocument/definition') return null;
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
        }),
      });
      internalsOf(lspService).serverManager = managerFor(
        'clangd',
        makeHandle(connection),
      );

      const results = await settle(
        lspService.definitions({
          uri,
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 4 },
          },
        }),
      );

      // didOpen fires before the definition request, 200ms apart.
      expect(timeline.length).toBe(2);
      expect(timeline[0]!.event).toBe('didOpen');
      expect(timeline[1]!.event).toBe('definition');
      expect(timeline[1]!.time - timeline[0]!.time).toBeGreaterThanOrEqual(200);
      expect(results.length).toBe(1);
    }));

  test('should skip delay when document is already open', () =>
    inTempDirWithFakeTimers('lsp-nodelay-', async (dir) => {
      const uri = writeDoc(dir, 'main.cpp', CPP_TEXT);
      let didOpenCount = 0;
      const connection = makeConnection({
        send: vi.fn((message: { method?: string }) => {
          if (message.method === 'textDocument/didOpen') didOpenCount += 1;
        }),
      });
      internalsOf(lspService).serverManager = managerFor(
        'clangd',
        makeHandle(connection),
      );

      await hover(lspService, uri); // opens the document
      expect(didOpenCount).toBe(1);

      // Second hover should neither re-open nor delay.
      const startTime = Date.now();
      await hover(lspService, uri);
      const elapsed = Date.now() - startTime;

      expect(didOpenCount).toBe(1);
      // Well under 200ms with fake timers.
      expect(elapsed).toBeLessThan(200);
    }));

  test('should not send duplicate didOpen for warmup-opened URI on subsequent requests', () =>
    inTempDirWithFakeTimers('lsp-warmup-track-', async (dir) => {
      const queryUri = writeDoc(dir, 'main.cpp', CPP_TEXT);
      const warmupUri = writeDoc(dir, 'index.ts', 'export const x = 1;\n');
      const didOpenUris: string[] = [];
      const connection = makeConnection({
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
      });
      // Warmup delegates its open through the service-owned synchronization.
      internalsOf(lspService).serverManager = managerFor(
        'typescript',
        makeHandle(connection, 'typescript', ['typescript'], TS, ['--stdio']),
        undefined,
        vi.fn(async (_handle, synchronizeDocument) => {
          synchronizeDocument(warmupUri, 'typescript');
        }),
      );

      // First request opens queryUri via ensureDocumentSynchronized; warmup opens warmupUri.
      await hover(lspService, queryUri);

      expect(didOpenUris).toContain(queryUri);
      const countAfterFirst = didOpenUris.length;

      // warmupUri was tracked by the first call's warmup, so it is not reopened.
      await hover(lspService, warmupUri);

      expect(didOpenUris.length).toBe(countAfterFirst);
    }));

  test('should retry document operations for slow servers after fresh didOpen', () =>
    inTempDirWithFakeTimers('lsp-retry-doc-', async (dir) => {
      const uri = writeDoc(dir, 'Main.java', JAVA_TEXT);
      let requestCount = 0;
      const connection = makeConnection({
        request: vi.fn(async (method: string) => {
          if (method !== 'textDocument/documentSymbol') return null;
          requestCount += 1;
          // First call returns empty (server still indexing), second returns data
          if (requestCount === 1) return [];
          return [
            {
              name: 'Main',
              kind: 5,
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 21 },
              },
              selectionRange: {
                start: { line: 0, character: 13 },
                end: { line: 0, character: 17 },
              },
            },
          ];
        }),
      });
      const service = workspaceService(
        dir,
        managerFor('jdtls', makeHandle(connection, 'jdtls', ['java']), false),
      );

      const results = await settle(service.documentSymbols(uri));

      // Should have retried: 2 requests total
      expect(requestCount).toBe(2);
      expect(results.length).toBe(1);
      expect(results[0]?.name).toBe('Main');
    }));

  test('should NOT retry document operations for TypeScript servers', () =>
    inTempDirWithFakeTimers('lsp-no-retry-ts-', async (dir) => {
      const uri = writeDoc(dir, 'index.ts', 'export const x = 1;\n');
      let requestCount = 0;
      const connection = makeConnection({
        request: vi.fn(async (method: string) => {
          if (method !== 'textDocument/documentSymbol') return null;
          requestCount += 1;
          return [];
        }),
      });
      internalsOf(lspService).serverManager = managerFor(
        'typescript',
        makeHandle(connection, TS, ['typescript'], TS, ['--stdio']),
        true,
      );

      await settle(lspService.documentSymbols(uri));

      // Should NOT have retried: only 1 request
      expect(requestCount).toBe(1);
    }));

  test('should NOT retry when document was already open', () =>
    inTempDirWithFakeTimers('lsp-no-retry-open-', async (dir) => {
      const uri = writeDoc(dir, 'Main.java', JAVA_TEXT);
      let requestCount = 0;
      const connection = makeConnection({
        request: vi.fn(async (method: string) => {
          if (
            method === 'textDocument/hover' ||
            method === 'textDocument/documentSymbol'
          ) {
            requestCount += 1;
          }
          return null;
        }),
      });
      const service = workspaceService(
        dir,
        managerFor('jdtls', makeHandle(connection, 'jdtls', ['java']), false),
      );

      // First call opens the document (retry is allowed on this call)
      await hover(service, uri);
      requestCount = 0;

      // Document already open: no retry even though the result is empty.
      await settle(service.documentSymbols(uri));

      expect(requestCount).toBe(1);
    }));

  // PR #4333 review fold-in: covers applyTextEdits' two error branches (the
  // only-ENOENT read guard and the W_OK access check), reached through a
  // typed cast so the private method need not be public just for tests.
  describe('applyTextEdits — error branches', () => {
    let tmpDir: string;
    const noChmod = process.platform === 'win32' || process.getuid?.() === 0;

    const applyEdit = (filePath: string, newText: string) =>
      (
        lspService as unknown as {
          applyTextEdits: (uri: string, edits: unknown[]) => Promise<void>;
        }
      ).applyTextEdits(pathToFileURL(filePath).toString(), [
        { range: zeroRange(), newText },
      ]);

    /** Writes a file with `mode`, edits it, restores 0o644; returns the error code and final text. */
    async function editProtected(
      name: string,
      content: string,
      mode: number,
      newText: string,
    ) {
      const filePath = path.join(tmpDir, name);
      fs.writeFileSync(filePath, content);
      fs.chmodSync(filePath, mode);
      let code: string | undefined;
      try {
        await applyEdit(filePath, newText);
      } catch (err) {
        code = (err as NodeJS.ErrnoException | undefined)?.code;
      }
      fs.chmodSync(filePath, 0o644);
      return { code, text: fs.readFileSync(filePath, 'utf-8') };
    }

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-edits-error-'));
      // Override the workspace mock so any path inside tmpDir is in-scope.
      (
        mockWorkspace as unknown as {
          isPathWithinWorkspace: (p: string) => boolean;
        }
      ).isPathWithinWorkspace = (p: string) => p.startsWith(tmpDir);
    });

    afterEach(() => {
      try {
        // Restore perms before rm so cleanup can traverse 0o000 / 0o444 files.
        for (const f of fs.readdirSync(tmpDir)) {
          try {
            fs.chmodSync(path.join(tmpDir, f), 0o644);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test.skipIf(noChmod)(
      'read failure on chmod 0000 file propagates EACCES (does not silently become empty content)',
      async () => {
        const { code, text } = await editProtected(
          'unreadable.txt',
          'original content',
          0o000,
          'INJECTED ',
        );
        expect(code).toBe('EACCES');
        // Unchanged: a read failure must not take the pre-fix "treat as
        // empty, overwrite with edits" path.
        expect(text).toBe('original content');
      },
    );

    test.skipIf(noChmod)(
      'chmod 0444 read-only file is rejected before write (W_OK check)',
      async () => {
        const { code, text } = await editProtected(
          'readonly.txt',
          'do not modify me',
          0o444,
          'BAD ',
        );
        expect(code).toMatch(/^E(ACCES|PERM)$/);
        // Unchanged: the atomic rename did NOT bypass perms.
        expect(text).toBe('do not modify me');
      },
    );

    test('nonexistent file is accepted (LSP can create via edits)', async () => {
      const filePath = path.join(tmpDir, 'new-file.txt');
      await applyEdit(filePath, 'created via edit');
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('created via edit');
    });
  });
});
