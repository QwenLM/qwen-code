/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS,
  DEFAULT_LSP_WARMUP_DELAY_MS,
  DEFAULT_LSP_WORKSPACE_SYMBOL_WARMUP_DELAY_MS,
} from './constants.js';
import { sortJsonValue } from './sort-json-value.js';
import { LspJsonRpcError } from './LspConnectionFactory.js';
import { NativeLspService } from './native-lsp-service.js';
import { NativeLspClient } from './NativeLspClient.js';
import { LspTool, type LspToolParams } from '../tools/lsp.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { LspServerManager } from './lsp-server-manager.js';
import type { Config } from '../config/config.js';
import {
  WorkspaceContext,
  resolveWorkspacePath,
} from '../utils/workspaceContext.js';
import * as pathUtils from '../utils/paths.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { IdeContextStore } from '../ide/ideContext.js';
import type {
  LspCallHierarchyItem,
  LspServerHandle,
  JsonRpcMessage,
  LspTextDocumentSync,
} from './types.js';

const logger = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../utils/debugLogger.js', () => ({ createDebugLogger: () => logger }));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

vi.mock('node:crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:crypto')>()),
}));

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 3 },
};

function createConnection() {
  let text = '';
  const events: string[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  return {
    events,
    requests,
    listen: vi.fn(),
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    initialize: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    end: vi.fn(),
    send: vi.fn((message: JsonRpcMessage) => {
      events.push(message.method!);
      const params = message.params as {
        textDocument: { text?: string };
        contentChanges?: Array<{ text: string }>;
      };
      if (message.method === 'textDocument/didOpen') {
        text = params.textDocument.text!;
      } else if (message.method === 'textDocument/didChange') {
        text = params.contentChanges![0]!.text;
      }
    }),
    request: vi.fn(
      async (method: string, params: unknown): Promise<unknown> => {
        events.push(method);
        requests.push({ method, params });
        if (method === 'textDocument/prepareCallHierarchy') {
          return [
            {
              name: 'fn',
              kind: 12,
              uri: (params as { textDocument: { uri: string } }).textDocument
                .uri,
              range,
              selectionRange: range,
            },
          ];
        }
        // Diagnostics pulls answer a well-formed empty report by default: a
        // bare `[]` is an unusable report shape the service must reject, not
        // the clean answer most tests in this file want as their baseline.
        if (method === 'textDocument/diagnostic') {
          return { kind: 'full', items: [] };
        }
        if (method === 'workspace/diagnostic') {
          return { items: [] };
        }
        return method === 'textDocument/hover' ? { contents: text } : [];
      },
    ),
  };
}

describe('NativeLspService disk document synchronization', () => {
  let directory: string;
  let file: string;
  let uri: string;
  let service: NativeLspService;
  let connection: ReturnType<typeof createConnection>;
  let handle: LspServerHandle;
  let manager: LspServerManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    directory = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-document-sync-')),
    );
    file = path.join(directory, 'main.ts');
    uri = pathToFileURL(file).toString();
    fs.writeFileSync(file, 'old');
    service = new NativeLspService(
      {
        getProjectRoot: () => directory,
        isTrustedFolder: () => true,
      } as unknown as Config,
      new WorkspaceContext(directory),
      new EventEmitter(),
      { shouldIgnoreFile: () => false } as unknown as FileDiscoveryService,
      {} as IdeContextStore,
    );
    manager = (service as unknown as { serverManager: LspServerManager })
      .serverManager;
    connection = createConnection();
    handle = {
      config: {
        name: 'test',
        languages: ['typescript'],
        transport: 'stdio',
        rootUri: pathToFileURL(directory).toString(),
      },
      status: 'READY',
      connection,
      textDocumentSync: 1,
    };
    (service as unknown as { serverManager: unknown }).serverManager = {
      getHandles: () => new Map([['test', handle]]),
      warmupTypescriptServer: vi.fn(),
      isTypescriptServer: () => false,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function run<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    const result = await settled;
    if ('error' in result) throw result.error;
    return result.value;
  }

  it.each(['workspace', 'symbols', 'incomingCalls', 'outgoingCalls'] as const)(
    'reports unavailable explicit servers for %s',
    async (operation) => {
      const item = { name: 'fn', uri, range, selectionRange: range };
      const query =
        operation === 'workspace'
          ? service.workspaceDiagnostics('absent')
          : operation === 'symbols'
            ? service.workspaceSymbols('fn', 50, 'absent')
            : service[operation](item, 'absent');
      await expect(run<unknown>(query)).rejects.toThrow(
        operation === 'workspace'
          ? 'No LSP server named absent is configured or running'
          : 'absent is not configured',
      );
      expect(connection.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    'document',
    'workspace',
    'symbols',
    'incomingCalls',
    'outgoingCalls',
  ] as const)(
    'distinguishes configured but unready servers for %s',
    async (operation) => {
      handle.status = 'IN_PROGRESS';
      const item = { name: 'fn', uri, range, selectionRange: range };
      const query =
        operation === 'document'
          ? service.diagnostics(uri)
          : operation === 'workspace'
            ? service.workspaceDiagnostics()
            : operation === 'symbols'
              ? service.workspaceSymbols('fn')
              : service[operation](item, 'test');
      await expect(run<unknown>(query)).rejects.toThrow(
        operation === 'document' || operation === 'workspace'
          ? 'test is in progress'
          : operation.endsWith('Calls')
            ? 'test is not ready'
            : 'No LSP servers are ready',
      );
      expect(connection.request).not.toHaveBeenCalled();
    },
  );

  it.each(['EACCES', 'ELOOP', 'ESTALE', 'EIO'])(
    'rejects unresolved tracked-file scope with %s before querying diagnostics',
    async (code) => {
      useTypescriptManager();
      handle.warmedUp = true;
      await run(service.hover({ uri, range }));
      connection.request.mockClear();
      connection.request.mockResolvedValue({ items: [] });
      const realpath = fs.realpathSync;
      const resolve = vi
        .spyOn(fs, 'realpathSync')
        .mockImplementation((target) => {
          if (target === file) {
            throw Object.assign(new Error(code), { code, path: file });
          }
          return realpath(target);
        });
      try {
        await expect(run(service.workspaceDiagnostics())).rejects.toThrow(
          'Cannot resolve LSP document',
        );
        expect(connection.request).not.toHaveBeenCalled();
      } finally {
        resolve.mockRestore();
      }
    },
  );

  describe.each(['workspace/symbol', 'workspace/diagnostic'] as const)(
    '%s result filtering',
    (method) => {
      let outside: string;
      let outsideUri: string;

      beforeEach(() => {
        useTypescriptManager();
        handle.warmedUp = true;
        outside = `${directory}.ts`;
        fs.writeFileSync(outside, 'outside');
        outsideUri = pathToFileURL(outside).toString();
      });

      afterEach(() => {
        fs.rmSync(outside, { force: true });
      });

      const response = (targets: string[]) =>
        method === 'workspace/symbol'
          ? targets.map((target, index) => ({
              name: `fn${index}`,
              location: { uri: target, range },
            }))
          : {
              items: targets.map((target) => ({
                uri: target,
                items: [{ range, message: 'issue', severity: 1 }],
              })),
            };
      const query = (limit = 20) =>
        run<unknown[]>(
          method === 'workspace/symbol'
            ? service.workspaceSymbols('fn', limit)
            : service.workspaceDiagnostics(undefined, limit),
        );

      it.each(['EACCES', 'ELOOP', 'ESTALE', 'EIO'])(
        'rejects unresolved result scope with %s instead of reporting clean',
        async (code) => {
          const realpath = fs.realpathSync;
          let filtering = false;
          const resolve = vi
            .spyOn(fs, 'realpathSync')
            .mockImplementation((target) => {
              if (filtering && target === file) {
                throw Object.assign(new Error(code), { code, path: file });
              }
              return realpath(target);
            });
          connection.request.mockImplementation(async () => {
            filtering = true;
            return response([uri]);
          });
          try {
            await expect(query()).rejects.toThrow(code);
          } finally {
            resolve.mockRestore();
          }
        },
      );

      it('preserves delivered state when result scope cannot be resolved', async () => {
        await run(service.prepareCallHierarchy({ uri, range }));
        const state = service as unknown as {
          openedDocuments: Map<string, Map<string, unknown>>;
          documentLifecycles: Map<string, Map<string, unknown>>;
          callHierarchyGenerations: WeakMap<object, Map<string, number>>;
        };
        const opened = new Map(state.openedDocuments.get('test'));
        const lifecycles = new Map(state.documentLifecycles.get('test'));
        const generations = new Map(
          state.callHierarchyGenerations.get(connection),
        );
        expect(opened.size).toBe(1);
        const realpath = fs.realpathSync;
        let filtering = false;
        const resolve = vi
          .spyOn(fs, 'realpathSync')
          .mockImplementation((target) => {
            if (filtering && target === file) {
              throw Object.assign(new Error('EACCES'), {
                code: 'EACCES',
                path: file,
              });
            }
            return realpath(target);
          });
        connection.request.mockImplementation(async () => {
          filtering = true;
          return response([uri]);
        });
        try {
          await query().catch(() => undefined);
          expect(state.openedDocuments.get('test')).toEqual(opened);
          expect(state.documentLifecycles.get('test')).toEqual(lifecycles);
          expect(state.callHierarchyGenerations.get(connection)).toEqual(
            generations,
          );
        } finally {
          resolve.mockRestore();
        }
      });

      it('resolves duplicate URIs once per response, not across requests', async () => {
        connection.request.mockResolvedValue(
          response(Array<string>(500).fill(outsideUri)),
        );
        const realpath = vi.spyOn(fs, 'realpathSync');
        try {
          expect(await query()).toEqual([]);
          expect(realpath).toHaveBeenCalledExactlyOnceWith(outside);
          expect(await query()).toEqual([]);
          expect(realpath).toHaveBeenCalledTimes(2);
          expect(logger.warn).not.toHaveBeenCalled();
        } finally {
          realpath.mockRestore();
        }
      });

      it('rechecks a symlink retargeted outside on the next request', async () => {
        const alias = path.join(directory, 'alias.ts');
        fs.symlinkSync(file, alias);
        const aliasUri = pathToFileURL(alias).toString();
        connection.request.mockResolvedValue(response([aliasUri]));
        expect(await query()).toHaveLength(1);
        fs.unlinkSync(alias);
        fs.symlinkSync(outside, alias);
        expect(await query()).toEqual([]);
      });

      it('finishes an empty response exactly at the scan budget', async () => {
        connection.request.mockResolvedValue(
          response(Array<string>(1000).fill(outsideUri)),
        );
        expect(await query()).toEqual([]);
      });

      if (method === 'workspace/diagnostic') {
        it('returns a dirty tail after more than 1000 valid clean reports', async () => {
          const items = Array.from({ length: 1001 }, (_, index) => {
            const cleanFile = path.join(directory, `clean-${index}.ts`);
            fs.writeFileSync(cleanFile, '');
            return {
              uri: pathToFileURL(cleanFile).toString(),
              items: [],
            };
          });
          const diagnostic = { range, message: 'dirty tail', severity: 1 };
          connection.request.mockResolvedValue({
            items: [...items, { uri, items: [diagnostic] }],
          });
          expect(await query(50)).toMatchObject([
            { uri, diagnostics: [{ message: 'dirty tail' }] },
          ]);
          const result = await execute(lspTool(), {
            operation: 'workspaceDiagnostics',
          });
          expect(result.llmContent).toContain('1 issues in 1 files');
          expect(result.llmContent).toContain('dirty tail');
        });

        it('bounds clean reports separately and allows a higher explicit limit', async () => {
          const items = Array.from({ length: 100000 }, () => ({
            uri,
            items: [],
          }));
          connection.request.mockResolvedValue({ items });
          expect(await query()).toEqual([]);
          connection.request.mockResolvedValue({
            items: [...items, { uri, items: [] }],
          });
          await expect(query()).rejects.toThrow(
            'scan limit (100000) exceeded; increase limit above 100000',
          );
          expect(await query(100001)).toEqual([]);
        });

        it('shares the total clean-report budget across servers', async () => {
          const second = createConnection();
          useHandles([
            ['test', handle],
            ['second', { ...handle, connection: second }],
          ]);
          const items = Array.from({ length: 50000 }, () => ({
            uri,
            items: [],
          }));
          connection.request.mockResolvedValue({ items });
          second.request.mockResolvedValue({
            items: [...items, { uri, items: [] }],
          });
          await expect(query()).rejects.toThrow('scan limit (100000) exceeded');
          expect(second.request).toHaveBeenCalledOnce();
        });

        it('still charges out-of-scope clean reports to the result budget', async () => {
          connection.request.mockResolvedValue({
            items: Array.from({ length: 1001 }, () => ({
              uri: outsideUri,
              items: [],
            })),
          });
          await expect(query()).rejects.toThrow('scan limit (1000) exceeded');
        });
      }

      it('rejects a scan beyond budget instead of hiding a valid tail', async () => {
        connection.request.mockResolvedValue(
          response([...Array<string>(1000).fill(outsideUri), uri]),
        );
        const filter = vi.spyOn(
          service as unknown as {
            isCurrentWorkspaceDocument(target: string): boolean;
          },
          'isCurrentWorkspaceDocument',
        );
        await expect(query()).rejects.toThrow('scan limit (1000) exceeded');
        expect(filter).toHaveBeenCalledTimes(1000);
        expect(filter.mock.calls.map(([target]) => target)).not.toContain(uri);
      });

      it('rechecks the same URI in a later asynchronous server response', async () => {
        const alias = path.join(directory, 'alias.ts');
        fs.symlinkSync(outside, alias);
        const aliasUri = pathToFileURL(alias).toString();
        const second = createConnection();
        useHandles([
          ['test', handle],
          ['second', { ...handle, connection: second }],
        ]);
        connection.request.mockResolvedValue(response([aliasUri]));
        second.request.mockImplementation(async () => {
          fs.unlinkSync(alias);
          fs.symlinkSync(file, alias);
          return response([aliasUri]);
        });
        const realpath = vi.spyOn(fs, 'realpathSync');
        try {
          expect(await query()).toHaveLength(1);
          expect(
            realpath.mock.calls.filter(([target]) => target === alias),
          ).toHaveLength(2);
        } finally {
          realpath.mockRestore();
        }
      });

      it('shares the scan budget across servers', async () => {
        const second = createConnection();
        useHandles([
          ['test', handle],
          ['second', { ...handle, connection: second }],
        ]);
        const rejected = response(Array<string>(600).fill(outsideUri));
        connection.request.mockResolvedValue(rejected);
        second.request.mockResolvedValue(rejected);
        await expect(query()).rejects.toThrow('scan limit (1000) exceeded');
        expect(second.request).toHaveBeenCalledOnce();
      });

      it('stops at the output limit before an oversized tail', async () => {
        connection.request.mockResolvedValue(
          response([uri, ...Array<string>(1001).fill(outsideUri)]),
        );
        expect(await query(1)).toHaveLength(1);
      });

      it('allows a requested output limit larger than the default scan budget', async () => {
        connection.request.mockResolvedValue(
          response(Array<string>(1001).fill(uri)),
        );
        expect(await query(1001)).toHaveLength(1001);
      });

      it('reports budget exhaustion through the tool, not a clean result', async () => {
        connection.request.mockResolvedValue(
          response([...Array<string>(1000).fill(outsideUri), uri]),
        );
        const result = await execute(lspTool(), {
          operation:
            method === 'workspace/symbol'
              ? 'workspaceSymbol'
              : 'workspaceDiagnostics',
          query: 'fn',
          limit: 20,
        });
        for (const content of [result.llmContent, result.returnDisplay]) {
          expect(content).toContain('scan limit (1000) exceeded');
          if (method === 'workspace/diagnostic') {
            expect(content).toContain('increase limit above 1000');
            expect(content).not.toContain('narrow the query');
          }
          expect(content).not.toContain('No symbols found');
          expect(content).not.toContain('No diagnostics found');
        }
      });
    },
  );

  it('continues workspace symbol requests after a usable warmup send fails', async () => {
    failNextSend();
    await run(service.workspaceSymbols('fn'));
    expect(connection.request).toHaveBeenCalledExactlyOnceWith(
      'workspace/symbol',
      { query: 'fn' },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('warmup skipped'),
      expect.any(Error),
    );
  });

  it('rejects non-file document queries without opening or requesting', async () => {
    await expect(
      run(service.diagnostics('https://example.com/a.ts')),
    ).rejects.toThrow('not a file URI');
    expect(connection.send).not.toHaveBeenCalled();
    expect(connection.request).not.toHaveBeenCalled();
  });

  it.each(['file:/', 'FILE:///'])(
    'certifies and traverses hierarchy items with URI prefix %s',
    async (prefix) => {
      const target = uri.replace('file:///', prefix);
      const [item] = await run(
        service.prepareCallHierarchy({ uri: target, range }),
      );
      expect(item!.uri).toBe(uri);
      expect(item!.documentRevision).toBeDefined();
      expect(connection.send).toHaveBeenCalledWith(didOpen('old'));
      expect(connection.request).toHaveBeenCalledWith(
        'textDocument/prepareCallHierarchy',
        { textDocument: { uri }, position: range.start },
      );
      await expect(run(service.incomingCalls(item!))).resolves.toEqual([]);
      expect(connection.request).toHaveBeenCalledWith(
        'callHierarchy/incomingCalls',
        expect.anything(),
      );
    },
  );

  const AGAIN = 'prepare call hierarchy again';
  const againError = () => ({ message: expect.stringContaining(AGAIN) });
  const hover = (target = uri, server?: string) =>
    run(service.hover({ uri: target, range }, server));
  const prepare = (target = uri) =>
    run(service.prepareCallHierarchy({ uri: target, range }));
  const workspaceDiagnostics = () => run(service.workspaceDiagnostics());
  const caught = (promise: Promise<unknown>) =>
    promise.catch((error: unknown) => error);
  const openParams = (
    text: string,
    version = 1,
    target = uri,
    languageId = 'typescript',
  ) => ({ textDocument: { uri: target, languageId, version, text } });
  const changeParams = (text: string, version = 2, target = uri) => ({
    textDocument: { uri: target, version },
    contentChanges: [{ text }],
  });
  const withParams = (params: object) => expect.objectContaining({ params });
  const didOpen = (...args: Parameters<typeof openParams>) =>
    expect.objectContaining({
      method: 'textDocument/didOpen',
      params: openParams(...args),
    });
  const didChange = (...args: Parameters<typeof changeParams>) =>
    expect.objectContaining({
      method: 'textDocument/didChange',
      params: changeParams(...args),
    });
  const docUri = (message: JsonRpcMessage) =>
    (message.params as { textDocument: { uri: string } }).textDocument.uri;
  const openedUris = (target: ReturnType<typeof createConnection>) =>
    target.send.mock.calls
      .filter(([message]) => message.method === 'textDocument/didOpen')
      .map(([message]) => docUri(message));
  const openedDocuments = () =>
    (
      service as unknown as {
        openedDocuments: Map<string, Map<string, unknown>>;
      }
    ).openedDocuments;

  /** Writes `name` into the workspace and returns its path and URI. */
  function addFile(name: string, text: string) {
    const target = path.join(directory, name);
    fs.writeFileSync(target, text);
    return [target, pathToFileURL(target).toString()] as const;
  }

  function useRealManager() {
    // SAFETY: Replace the fixture manager with the real manager created by the service.
    (service as unknown as { serverManager: LspServerManager }).serverManager =
      manager;
  }

  /** Serves `entries` from the real manager's handle discovery. */
  function useHandles(entries: Array<[string, LspServerHandle]>) {
    useRealManager();
    vi.spyOn(manager, 'getHandles').mockReturnValue(new Map(entries));
  }

  /** Stubs process startup: each server starts READY, full sync, on `pick(name)`. */
  const stubReadyServers = (
    pick: (name: string) => ReturnType<typeof createConnection>,
  ) =>
    vi
      .spyOn(
        manager as unknown as {
          startServer(name: string, target: LspServerHandle): Promise<void>;
        },
        'startServer',
      )
      .mockImplementation(async (name, target) => {
        target.status = 'READY';
        target.textDocumentSync = 1;
        target.connection = pick(name);
      });
  const writeLspConfig = (servers: object) =>
    fs.writeFileSync(
      path.join(directory, '.lsp.json'),
      JSON.stringify(servers),
    );

  const spyDiscovery = () =>
    vi.spyOn(
      service as unknown as {
        findWorkspaceFileForServer(handle: LspServerHandle): string | undefined;
      },
      'findWorkspaceFileForServer',
    );

  const expectLastSent = (matcher: unknown, target = connection) =>
    expect(target.send).toHaveBeenLastCalledWith(matcher);
  const failNextSend = (message = 'send failed', target = connection) =>
    target.send.mockImplementationOnce(() => {
      throw new Error(message);
    });

  /** Swaps a fresh connection into the handle, as a server restart would. */
  function replaceConnection() {
    const replacement = createConnection();
    handle.connection = replacement;
    return replacement;
  }

  /** Tracks main.ts, then a new other.ts; returns other.ts's path and URI. */
  async function trackOther() {
    const created = addFile('other.ts', 'other');
    await hover();
    await hover(created[1]);
    return created;
  }

  function lspTool() {
    // SAFETY: The real LSP tool only needs these Config methods on these paths.
    return new LspTool({
      getProjectRoot: () => directory,
      isLspEnabled: () => true,
      getLspClient: () => new NativeLspClient(service),
      getWorkspaceContext: () =>
        (service as unknown as { workspaceContext: WorkspaceContext })
          .workspaceContext,
    } as unknown as Config);
  }
  const execute = (tool: LspTool, params: LspToolParams) =>
    run(tool.build(params).execute(new AbortController().signal));

  /** Parks the next request; the returned function settles it (rejects if `fail`). */
  function deferNextRequest(fail = false) {
    let respond!: (value: unknown) => void;
    connection.request.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          respond = fail ? () => reject(new Error('server rejected')) : resolve;
        }),
    );
    return (value: unknown) => respond(value);
  }

  /** Resolves on `target`'s next send, keeping its recording implementation. */
  function nextSend(target: ReturnType<typeof createConnection>) {
    const send = target.send.getMockImplementation()!;
    return new Promise<void>((resolve) => {
      target.send.mockImplementation((message) => {
        send(message);
        resolve();
      });
    });
  }

  describe.each(['diagnostics', 'workspaceDiagnostics'] as const)(
    '%s diagnostic report failures',
    (operation) => {
      const queryDiagnostics = (): Promise<unknown[]> =>
        operation === 'diagnostics'
          ? service.diagnostics(uri)
          : service.workspaceDiagnostics();

      it.each([
        undefined,
        [],
        {},
        { items: null },
        { items: 'invalid' },
        { error: { code: -32601, message: 'Method not found' } },
        { kind: 'unchanged', resultId: 'unknown' },
      ])(
        'rejects an invalid report %j instead of claiming clean',
        async (report) => {
          connection.request.mockResolvedValue(report);
          await expect(run(queryDiagnostics())).rejects.toThrow(
            'Invalid diagnostic report',
          );
        },
      );

      it.each(['Method not found', 'request timeout', 'connection closed'])(
        'shows %s as a tool failure instead of a clean result',
        async (message) => {
          connection.request.mockRejectedValue(new Error(message));
          const result = await execute(lspTool(), {
            operation,
            filePath: file,
          });
          for (const content of [result.llmContent, result.returnDisplay]) {
            expect(content).toContain('failed');
            expect(content).toContain('test');
            expect(content).toContain(message);
            expect(content).not.toContain('No diagnostics found');
          }
        },
      );

      it('accepts a successful empty report as clean', async () => {
        connection.request.mockResolvedValue({ kind: 'full', items: [] });
        expect(await run(queryDiagnostics())).toEqual([]);
      });

      it('does not certify a null response as clean', async () => {
        connection.request.mockResolvedValue(null);
        await expect(run(queryDiagnostics())).rejects.toThrow(
          'server returned no response',
        );
      });

      it('retains empty-message diagnostics beside real errors', async () => {
        const diagnostics = [
          { range, message: '', code: 'unnecessary', tags: [1] },
          { range, message: 'real error', severity: 1 },
        ];
        connection.request.mockResolvedValue({
          kind: 'full',
          items:
            operation === 'diagnostics'
              ? diagnostics
              : [{ uri, kind: 'full', items: diagnostics }],
        });
        const result = await run(queryDiagnostics());
        const retained =
          operation === 'diagnostics'
            ? result
            : (result[0] as { diagnostics: unknown[] }).diagnostics;
        expect(retained).toEqual([
          expect.objectContaining({
            message: '',
            code: 'unnecessary',
            tags: ['unnecessary'],
          }),
          expect.objectContaining({ message: 'real error', severity: 'error' }),
        ]);
      });

      it('preserves earlier diagnostics when a later server returns null', async () => {
        const other = createConnection();
        other.request.mockResolvedValue(null);
        useHandles([
          ['test', handle],
          ['other', { ...handle, connection: other }],
        ]);
        const diagnostic = { range, message: 'real error' };
        connection.request.mockResolvedValue({
          items:
            operation === 'diagnostics'
              ? [diagnostic]
              : [{ uri, items: [diagnostic] }],
        });
        const result = await run(queryDiagnostics());
        expect(result).toHaveLength(1);
        expect(JSON.stringify(result)).toContain('real error');
        expect(other.request).toHaveBeenCalled();
      });

      it('retains actual diagnostics when a later server pull fails', async () => {
        const other = createConnection();
        other.request.mockRejectedValue(new Error('Method not found'));
        useHandles([
          ['test', handle],
          [
            'other',
            {
              ...handle,
              config: { ...handle.config, name: 'other' },
              connection: other,
            },
          ],
        ]);
        connection.request.mockResolvedValue({
          kind: 'full',
          items:
            operation === 'diagnostics'
              ? [{ range, message: 'Value expected', severity: 1 }]
              : [
                  {
                    uri,
                    kind: 'full',
                    items: [{ range, message: 'Value expected', severity: 1 }],
                  },
                ],
        });
        const result = await run(queryDiagnostics());
        expect(result).toHaveLength(1);
        expect(JSON.stringify(result)).toContain('Value expected');
        expect(other.request).toHaveBeenCalled();
      });
    },
  );

  it.each([
    { kind: 'unchanged', resultId: 'unknown' },
    { kind: 'full' },
    { kind: 'full', items: null },
    { kind: 'full', items: [null] },
    { kind: 'full', items: [{ range }] },
    { kind: 'full', items: [{ range, message: 42 }] },
  ])('refuses an invalid in-scope workspace file report %j', async (report) => {
    connection.request.mockResolvedValue({
      items: [
        { uri, kind: 'full', items: [{ range, message: 'earlier error' }] },
        { uri, ...report },
      ],
    });
    const result = await execute(lspTool(), {
      operation: 'workspaceDiagnostics',
    });
    for (const content of [result.llmContent, result.returnDisplay]) {
      expect(content).toContain('Invalid diagnostic report');
      expect(content).toContain('test');
      expect(content).not.toContain('No diagnostics found');
      expect(content).not.toContain('earlier error');
    }
  });

  it('accepts a successful empty in-scope workspace file report', async () => {
    connection.request.mockResolvedValue({
      items: [{ uri, kind: 'full', items: [] }],
    });
    expect(await workspaceDiagnostics()).toEqual([]);
  });

  it.each([
    null,
    { message: 'missing range' },
    { range },
    { range, message: 42 },
  ])(
    'refuses malformed document diagnostics %j instead of silently dropping them',
    async (item) => {
      connection.request.mockResolvedValue({ kind: 'full', items: [item] });
      await expect(run(service.diagnostics(uri))).rejects.toThrow(
        'Invalid diagnostic report: malformed diagnostic',
      );
    },
  );

  const queryMethods = [
    'definitions',
    'references',
    'hover',
    'implementations',
    'prepareCallHierarchy',
    'documentSymbols',
    'diagnostics',
    'codeActions',
    'incomingCalls',
    'outgoingCalls',
  ] as const;
  async function query(
    method: (typeof queryMethods)[number],
    target = uri,
  ): Promise<unknown> {
    if (method === 'documentSymbols' || method === 'diagnostics')
      return service[method](target);
    if (method === 'codeActions')
      return service.codeActions(target, range, { diagnostics: [] });
    if (method === 'incomingCalls' || method === 'outgoingCalls') {
      const items = await service.prepareCallHierarchy({ uri: target, range });
      if (!items[0])
        throw new Error(`prepareCallHierarchy returned no item for ${method}`);
      return service[method](items[0]);
    }
    return service[method]({ uri: target, range });
  }

  it.each(queryMethods)(
    'shares one document lifecycle across URI spellings for %s',
    async (method) => {
      await run(query(method));
      fs.writeFileSync(file, 'changed');
      for (const target of [
        uri.replace('file:///', 'file:/'),
        uri.replace('file:', 'FILE:'),
        uri.replace('main.ts', '%6dain.ts'),
      ]) {
        await run(query(method, target));
      }
      const notifications = connection.send.mock.calls.map(([value]) => value);
      expect(
        notifications.filter(
          (value) => value.method === 'textDocument/didOpen',
        ),
      ).toEqual([didOpen('old')]);
      expect(
        notifications.filter(
          (value) => value.method === 'textDocument/didChange',
        ),
      ).toEqual([didChange('changed')]);
      for (const { params } of connection.requests) {
        const document = params as {
          textDocument?: { uri: string };
          item?: { uri: string };
        };
        expect(document.textDocument?.uri ?? document.item?.uri).toBe(uri);
      }
      const tracking = service as unknown as {
        openedDocuments: Map<string, Map<string, unknown>>;
        documentLifecycles: Map<string, Map<string, unknown>>;
      };
      expect([...tracking.openedDocuments.get('test')!.keys()]).toEqual([uri]);
      expect([...tracking.documentLifecycles.get('test')!.keys()]).toEqual([
        uri,
      ]);
      const replacement = replaceConnection();
      await run(query(method, uri.replace('file:', 'FILE:')));
      expect(
        replacement.send.mock.calls
          .filter(([value]) => value.method === 'textDocument/didOpen')
          .map(([value]) => value),
      ).toEqual([didOpen('changed')]);
    },
  );

  it.each(['incomingCalls', 'outgoingCalls'] as const)(
    'canonicalizes server-echoed hierarchy URIs before signing %s',
    async (method) => {
      const rawItem = {
        name: 'fn',
        kind: 12,
        uri: uri.replace('file:///', 'file:/'),
        range,
        selectionRange: range,
      };
      connection.request.mockResolvedValueOnce([rawItem]);
      const [item] = await prepare();
      expect(item!.uri).toBe(uri);
      expect(item!.documentRevision).toBeDefined();
      connection.request.mockResolvedValueOnce([
        method === 'incomingCalls'
          ? {
              from: { ...rawItem, uri: uri.replace('file:', 'FILE:') },
              fromRanges: [range],
            }
          : {
              to: { ...rawItem, uri: uri.replace('file:', 'FILE:') },
              fromRanges: [range],
            },
      ]);
      const nested =
        method === 'incomingCalls'
          ? (await run(service.incomingCalls(item!)))[0]!.from
          : (await run(service.outgoingCalls(item!)))[0]!.to;
      expect(nested.uri).toBe(uri);
      expect(nested.documentRevision).toBeDefined();
      connection.request.mockResolvedValueOnce([]);
      await expect(run<unknown>(service[method](nested))).resolves.toEqual([]);
    },
  );

  it('defers canonical state when scope is lost under an alternate spelling', async () => {
    useTypescriptManager();
    vi.spyOn(manager, 'warmupTypescriptServer').mockResolvedValue(undefined);
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-uri-scope-'));
    const targetFile = path.join(extra, 'extra.ts');
    const canonical = pathToFileURL(targetFile).toString();
    const alternate = canonical.replace('file:', 'FILE:');
    const workspace = (
      service as unknown as { workspaceContext: WorkspaceContext }
    ).workspaceContext;
    try {
      fs.writeFileSync(targetFile, 'extra');
      workspace.addDirectory(extra);
      const [item] = await prepare(canonical);
      workspace.removeDirectory(extra);
      connection.request.mockResolvedValueOnce([
        { name: 'fn', kind: 12, location: { uri: alternate, range } },
      ]);
      expect(await run(service.workspaceSymbols('fn'))).toEqual([]);
      const tracking = service as unknown as {
        openedDocuments: Map<string, Map<string, unknown>>;
        documentLifecycles: Map<
          string,
          Map<string, { pendingClose?: unknown }>
        >;
      };
      expect(tracking.openedDocuments.get('test')!.has(canonical)).toBe(false);
      expect(
        tracking.documentLifecycles.get('test')!.get(canonical)?.pendingClose,
      ).toBeDefined();
      workspace.addDirectory(extra);
      await expect(run(service.incomingCalls(item!))).rejects.toMatchObject(
        againError(),
      );
      await hover(alternate);
      expect(connection.send.mock.calls.map(([value]) => value)).toEqual([
        didOpen('extra', 1, canonical),
        {
          jsonrpc: '2.0',
          method: 'textDocument/didClose',
          params: { textDocument: { uri: canonical } },
        },
        didOpen('extra', 2, canonical),
      ]);
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });

  describe('file-scoped server routing', () => {
    beforeEach(() => {
      useHandles([['test', handle]]);
      vi.spyOn(manager, 'warmupTypescriptServer').mockResolvedValue(undefined);
    });

    it.each(queryMethods)(
      'does not send %s to an unrelated server',
      async (method) => {
        const foreign = createConnection();
        useHandles([
          [
            'python',
            {
              ...handle,
              config: {
                ...handle.config,
                name: 'python',
                languages: ['python'],
              },
              connection: foreign,
            },
          ],
          ['test', handle],
        ]);

        await run(query(method));

        expect(connection.request).toHaveBeenCalled();
        expect(foreign.send).not.toHaveBeenCalled();
        expect(foreign.request).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['ts', 'typescript'],
      ['py', 'python'],
      ['cpp', 'cpp'],
      ['json', 'json'],
      ['css', 'css'],
    ])('routes .%s diagnostics only to %s', async (extension, language) => {
      const [, target] = addFile(`sample.${extension}`, 'text');
      const servers = ['typescript', 'python', 'cpp', 'json', 'css'].map(
        (name, index) => {
          const extensions = ['ts', 'py', 'cpp', 'json', 'css'];
          const targetConnection = createConnection();
          return {
            name,
            connection: targetConnection,
            handle: {
              ...handle,
              config: {
                ...handle.config,
                name,
                languages: [name],
                extensionToLanguage: { [extensions[index]!]: name },
              },
              connection: targetConnection,
            },
          };
        },
      );
      useHandles(servers.map((server) => [server.name, server.handle]));

      await run(service.diagnostics(target));

      for (const server of servers) {
        if (server.name === language) {
          expect(server.connection.send).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'textDocument/didOpen' }),
          );
          expect(server.connection.request).toHaveBeenCalledWith(
            'textDocument/diagnostic',
            { textDocument: { uri: target } },
          );
        } else {
          expect(server.connection.send).not.toHaveBeenCalled();
          expect(server.connection.request).not.toHaveBeenCalled();
        }
      }
    });

    it.each([
      ['tsx', 'typescript'],
      ['mts', 'typescript'],
      ['cts', 'typescript'],
      ['jsx', 'javascript'],
      ['rs', 'rust'],
      ['cc', 'cpp'],
      ['hh', 'cpp'],
      ['hxx', 'cpp'],
      ['inl', 'cpp'],
      ['tpp', 'cpp'],
      ['pyi', 'python'],
      ['pyw', 'python'],
      ['fsi', 'fsharp'],
      ['fsx', 'fsharp'],
      ['h', 'cpp'],
      ['h', 'c'],
      ['yml', 'yaml'],
      ['go', 'go'],
      ['java', 'java'],
      ['sh', 'shellscript'],
      ['fs', 'fsharp'],
      ['TS', 'typescript'],
    ])(
      'infers .%s from language %s without an explicit mapping',
      async (extension, language) => {
        handle.config.languages = [language];
        const [, target] = addFile(`alias.${extension}`, 'text');

        await run(service.diagnostics(target));

        expect(connection.request).toHaveBeenCalledWith(
          'textDocument/diagnostic',
          { textDocument: { uri: target } },
        );
      },
    );

    it.each([
      ['hh', 'cpp'],
      ['hxx', 'cpp'],
      ['inl', 'cpp'],
      ['tpp', 'cpp'],
      ['pyi', 'python'],
      ['pyw', 'python'],
      ['fsi', 'fsharp'],
      ['fsx', 'fsharp'],
    ])(
      'does not infer .%s excluded by a %s mapping',
      async (extension, language) => {
        handle.config.languages = [language!];
        handle.config.extensionToLanguage = { other: language! };
        const [, target] = addFile(`sample.${extension}`, 'text');

        await expect(run(service.diagnostics(target))).rejects.toThrow(
          'No ready LSP server matches document',
        );
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['terraform', 'main.tf'],
      ['ruby', 'Gemfile'],
      ['ruby', 'Rakefile'],
      ['makefile', 'Makefile'],
      ['ruby', 'Podfile'],
      ['ruby', 'Vagrantfile'],
      ['plaintext', 'Procfile'],
      ['groovy', 'Jenkinsfile'],
      ['starlark', 'BUILD'],
      ['starlark', 'WORKSPACE'],
      ['just', 'justfile'],
      ['cmake', 'CMakeLists.txt'],
      ['protobuf', 'main.proto'],
      ['elixir', 'main.exs'],
      ['json', 'main.jsonc'],
      ['json', '.prettierrc'],
      ['json', '.eslintrc'],
      ['json', '.babelrc'],
      ['typescript', '.tsconfig'],
      ['json', '.editorconfig'],
      ['json', '.gitignore'],
      ['json', 'Dockerfile'],
      ['shellscript', 'main.zsh'],
      ['solidity', 'main.sol'],
      ['scss', 'main.scss'],
      ['kotlin', 'build.gradle.kts'],
      ['typescript-language-server', 'custom.ts'],
      ['constructor', 'custom.extension'],
      ['__proto__', 'custom.extension'],
      ['typescript', 'main.js'],
      ['typescript', 'main.jsx'],
      ['typescript', 'main.mjs'],
      ['typescript', 'main.cjs'],
    ])(
      'preserves scope-checked dispatch for %s / %s',
      async (language, name) => {
        handle.config.languages = [language];
        const [, target] = addFile(name, 'text');
        connection.request.mockResolvedValue({
          kind: 'full',
          items: [{ range, message: 'custom diagnostic' }],
        });

        expect(await run(service.diagnostics(target))).toMatchObject([
          { message: 'custom diagnostic' },
        ]);

        expect(connection.send).toHaveBeenCalledWith(
          didOpen('text', 1, target, language),
        );
        expect(connection.request).toHaveBeenCalledWith(
          'textDocument/diagnostic',
          { textDocument: { uri: target } },
        );
      },
    );

    it.each(['absent', 'empty', 'explicit'])(
      'keeps extensionless dispatch scope-checked with %s mapping',
      async (mapping) => {
        handle.config.languages = ['json'];
        handle.config.extensionToLanguage =
          mapping === 'absent'
            ? undefined
            : mapping === 'empty'
              ? {}
              : { json: 'json' };
        const [, target] = addFile('.prettierrc', '{}');

        if (mapping === 'explicit') {
          await expect(run(service.diagnostics(target))).rejects.toThrow(
            'No ready LSP server matches document',
          );
          expect(connection.send).not.toHaveBeenCalled();
          expect(connection.request).not.toHaveBeenCalled();
        } else {
          await run(service.diagnostics(target));
          expect(connection.send).toHaveBeenCalledWith(
            didOpen('{}', 1, target, 'json'),
          );
          expect(connection.request).toHaveBeenCalledWith(
            'textDocument/diagnostic',
            { textDocument: { uri: target } },
          );
        }

        const outside = pathToFileURL(
          path.join(path.dirname(directory), '.prettierrc'),
        ).toString();
        connection.send.mockClear();
        connection.request.mockClear();
        await expect(run(service.diagnostics(outside))).rejects.toThrow(
          'outside the current workspace directories',
        );
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      },
    );

    it.each(['missing', 'unready', 'disconnected'])(
      'reports an explicit %s server as unavailable, not a clean file',
      async (state) => {
        if (state === 'unready') handle.status = 'IN_PROGRESS';
        if (state === 'disconnected') handle.connection = undefined;
        const result = await execute(lspTool(), {
          operation: 'diagnostics',
          filePath: file,
          serverName: state === 'missing' ? 'missing' : 'test',
        });

        expect(result.llmContent).toContain(
          state === 'missing'
            ? 'No LSP server named missing is configured or running'
            : state === 'unready'
              ? 'test is in progress'
              : 'test has no active connection',
        );
        expect(result.llmContent).not.toContain('No diagnostics found');
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      },
    );

    it('does not infer Cython as ordinary Python', async () => {
      handle.config.languages = ['python'];
      const [, target] = addFile('sample.pyx', 'text');

      await expect(run(service.diagnostics(target))).rejects.toThrow(
        'No ready LSP server matches document',
      );
      expect(connection.send).not.toHaveBeenCalled();
      expect(connection.request).not.toHaveBeenCalled();
    });

    it.each([
      ['m', 'objective-c'],
      ['mm', 'objective-cpp'],
    ])(
      'routes .%s only to its %s LSP language',
      async (extension, language) => {
        const [, target] = addFile(`sample.${extension}`, 'text');
        const objc = createConnection();
        const objcpp = createConnection();
        useHandles([
          [
            'objc',
            {
              ...handle,
              config: { ...handle.config, languages: ['objective-c'] },
              connection: objc,
            },
          ],
          [
            'objcpp',
            {
              ...handle,
              config: { ...handle.config, languages: ['objective-cpp'] },
              connection: objcpp,
            },
          ],
        ]);

        await run(service.diagnostics(target));

        const selected = language === 'objective-c' ? objc : objcpp;
        const rejected = language === 'objective-c' ? objcpp : objc;
        expect(selected.send).toHaveBeenCalledWith(
          didOpen('text', 1, target, language),
        );
        expect(selected.request).toHaveBeenCalledWith(
          'textDocument/diagnostic',
          {
            textDocument: { uri: target },
          },
        );
        expect(rejected.send).not.toHaveBeenCalled();
        expect(rejected.request).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['m', 'objective-cpp'],
      ['mm', 'objective-c'],
    ])('honors an explicit .%s mapping to %s', async (extension, language) => {
      handle.config.languages = [language!];
      handle.config.extensionToLanguage = { [extension!]: language! };
      const [, target] = addFile(`sample.${extension}`, 'text');

      await run(service.diagnostics(target));

      expect(connection.send).toHaveBeenCalledWith(
        didOpen('text', 1, target, language),
      );
      expect(connection.request).toHaveBeenCalledWith(
        'textDocument/diagnostic',
        {
          textDocument: { uri: target },
        },
      );
    });

    it('preserves an explicit Objective-C server override for .mm', async () => {
      handle.config.languages = ['objective-c'];
      const [, target] = addFile('sample.mm', 'text');

      await run(service.diagnostics(target, 'test'));

      expect(connection.send).toHaveBeenCalledWith(
        didOpen('text', 1, target, 'objective-c'),
      );
      expect(connection.request).toHaveBeenCalledWith(
        'textDocument/diagnostic',
        {
          textDocument: { uri: target },
        },
      );
    });

    it.each([
      'clangd',
      path.join(path.sep, 'tools', 'clangd'),
      'clangd.exe',
      'clangd-18',
      'clangd-19.1',
      'clangd-18.exe',
      path.join(path.sep, 'tools', 'clangd-18'),
    ])(
      'routes C files with the documented cpp configuration and %s command',
      async (command) => {
        useRealManager();
        vi.mocked(manager.getHandles).mockRestore();
        writeLspConfig({
          cpp: {
            command,
            args: [
              '--background-index',
              '--clang-tidy',
              '--header-insertion=iwyu',
              '--completion-style=detailed',
            ],
          },
        });
        stubReadyServers(() => connection);
        await service.discoverAndPrepare();
        await service.start();
        const [, target] = addFile('sample.c', 'int main(void) { return 0; }');

        await run(service.diagnostics(target));

        expect(manager.getHandles().get(command)?.config.languages).toEqual([
          'cpp',
        ]);
        expect(connection.send).toHaveBeenCalledWith(
          didOpen('int main(void) { return 0; }', 1, target, 'cpp'),
        );
        expect(connection.request).toHaveBeenCalledWith(
          'textDocument/diagnostic',
          { textDocument: { uri: target } },
        );
      },
    );

    it('discovers C files for known clangd workspace-symbol warmup', async () => {
      fs.unlinkSync(file);
      const [, target] = addFile('sample.c', 'int main(void) { return 0; }');
      handle.config.languages = ['cpp'];
      handle.config.command = 'clangd';

      await run(service.workspaceSymbols('main'));

      expect(connection.send).toHaveBeenCalledWith(
        didOpen('int main(void) { return 0; }', 1, target, 'cpp'),
      );
      expect(connection.request).toHaveBeenCalledWith('workspace/symbol', {
        query: 'main',
      });
    });

    it.each(
      (['cpp', 'typescript'] as const).flatMap((language) =>
        [false, true].map((inside) => ({ language, inside })),
      ),
    )(
      'keeps $language symbol warmup inside its subroot, inside file $inside',
      async ({ language, inside }) => {
        const sub = path.join(directory, 'sub');
        fs.mkdirSync(sub);
        const extension = language === 'cpp' ? 'c' : 'ts';
        addFile(`outside.${extension}`, 'outside');
        const insideFile = path.join(sub, `inside.${extension}`);
        if (inside) fs.writeFileSync(insideFile, 'inside');
        handle.config.languages = [language];
        handle.config.command =
          language === 'cpp' ? 'clangd-18' : 'typescript-language-server';
        handle.config.workspaceFolder = sub;
        if (language === 'typescript') {
          vi.mocked(manager.warmupTypescriptServer).mockRestore();
          connection.request.mockImplementation(async (method) =>
            method === 'workspace/diagnostic'
              ? { items: [] }
              : { message: 'No Project' },
          );
        }

        await run(service.workspaceSymbols('main'));

        expect(openedUris(connection)).toEqual(
          inside ? [pathToFileURL(insideFile).toString()] : [],
        );
        expect([...(openedDocuments().get('test')?.keys() ?? [])]).toEqual(
          inside ? [pathToFileURL(insideFile).toString()] : [],
        );
        connection.send.mockClear();
        await workspaceDiagnostics();
        expect(connection.send).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['cpp', 'cxx'],
      ['cpp', 'hpp'],
      ['python', 'py'],
    ])(
      'discovers the sole .%s / .%s symbol warmup candidate',
      async (language, extension) => {
        fs.unlinkSync(file);
        handle.config.languages = [language];
        const [, target] = addFile(`sample.${extension}`, 'text');

        await run(service.workspaceSymbols('main'));

        expect(connection.send).toHaveBeenCalledWith(
          didOpen('text', 1, target, language),
        );
      },
    );

    it.each(['cpp-only-lsp', 'clangd-wrapper'])(
      'does not assume %s supports C because its language is cpp',
      async (command) => {
        handle.config.languages = ['cpp'];
        handle.config.command = command;
        const [, target] = addFile('sample.c', 'text');

        await expect(run(service.diagnostics(target))).rejects.toThrow(
          'No ready LSP server matches document',
        );

        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      },
    );

    it.each(['mts', 'cts', 'c'])(
      'does not widen an explicit mapping to include .%s',
      async (extension) => {
        handle.config.languages = [extension === 'c' ? 'cpp' : 'typescript'];
        handle.config.command =
          extension === 'c' ? 'clangd' : 'typescript-language-server';
        handle.config.extensionToLanguage =
          extension === 'c' ? { cpp: 'cpp' } : { ts: 'typescript' };
        const [, target] = addFile(`sample.${extension}`, 'text');

        await expect(run(service.diagnostics(target))).rejects.toThrow(
          'No ready LSP server matches document',
        );

        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      },
    );

    describe('current workspace directory scope', () => {
      let workspace: WorkspaceContext;
      let primary: string;
      let extra: string;
      let extraUri: string;

      beforeEach(() => {
        const parent = fs.realpathSync(directory);
        primary = path.join(parent, 'primary');
        extra = `${primary}-extra`;
        fs.mkdirSync(primary);
        fs.mkdirSync(extra);
        const targetFile = path.join(extra, 'source file.ts');
        fs.writeFileSync(targetFile, 'extra');
        extraUri = pathToFileURL(targetFile).toString();
        workspace = new WorkspaceContext(primary, [extra]);
        service = new NativeLspService(
          {
            getProjectRoot: () => primary,
            isTrustedFolder: () => true,
          } as unknown as Config,
          workspace,
          new EventEmitter(),
          { shouldIgnoreFile: () => false } as unknown as FileDiscoveryService,
          {} as IdeContextStore,
        );
        handle.config.rootUri = pathToFileURL(primary).toString();
        manager = (service as unknown as { serverManager: LspServerManager })
          .serverManager;
        useHandles([['test', handle]]);
      });

      it.each(['rootUri', 'workspaceFolder'])(
        'routes included directory files with a %s primary root',
        async (rootSource) => {
          if (rootSource === 'workspaceFolder')
            handle.config.workspaceFolder = primary;

          await run(service.diagnostics(extraUri));

          expect(connection.send).toHaveBeenCalledWith(
            didOpen('extra', 1, extraUri),
          );
          expect(connection.request).toHaveBeenCalledWith(
            'textDocument/diagnostic',
            { textDocument: { uri: extraUri } },
          );
        },
      );

      it.each([false, true])(
        'drops revoked tracked URIs and preserves survivors, connection replaced %s',
        async (replacement) => {
          const targetFile = path.join(primary, 'main.ts');
          fs.writeFileSync(targetFile, 'primary');
          const primaryUri = pathToFileURL(targetFile).toString();
          await run(service.diagnostics(extraUri));
          await run(service.diagnostics(primaryUri));
          workspace.removeDirectory(extra);
          fs.writeFileSync(path.join(extra, 'source file.ts'), 'revoked');
          const active = replacement ? replaceConnection() : connection;
          active.send.mockClear();
          const read = vi.spyOn(fs, 'readFileSync');
          try {
            await workspaceDiagnostics();
            expect(
              read.mock.calls.some(
                ([target]) => target === path.join(extra, 'source file.ts'),
              ),
            ).toBe(false);
            expect(
              active.send.mock.calls.some(
                ([message]) => docUri(message) === extraUri,
              ),
            ).toBe(false);
            expect(openedDocuments().get('test')?.has(extraUri)).toBe(false);
            if (replacement) expect(openedUris(active)).toEqual([primaryUri]);
            const replay = (
              service as unknown as { replayUris: Map<string, Set<string>> }
            ).replayUris;
            expect(replay.get('test')?.has(extraUri) ?? false).toBe(
              replacement,
            );
          } finally {
            read.mockRestore();
          }

          workspace.addDirectory(extra);
          active.send.mockClear();
          await run(service.diagnostics(extraUri));
          expect(openedUris(active)).toEqual([extraUri]);
          expectLastSent(
            didOpen('revoked', replacement ? 1 : 2, extraUri),
            active,
          );
          expect(
            active.send.mock.calls
              .filter(([message]) => message.method === 'textDocument/didClose')
              .map(([message]) => docUri(message)),
          ).toEqual(replacement ? [] : [extraUri]);
        },
      );

      it.each(
        ([1, 2] as const).flatMap((sync) =>
          ['removed', 'unresolvable'].flatMap((scope) =>
            ['hover', 'workspace'].map((recovery) => ({
              sync,
              scope,
              recovery,
            })),
          ),
        ),
      )(
        'balances same-connection sync $sync after $scope scope loss via $recovery',
        async ({ sync, scope, recovery }) => {
          handle.textDocumentSync = sync;
          const buffers = new Map<string, string>();
          const send = connection.send.getMockImplementation()!;
          connection.send.mockImplementation((message) => {
            const params = message.params as {
              textDocument: { uri: string; text?: string };
              contentChanges?: Array<{ text: string }>;
            };
            const target = params.textDocument.uri;
            if (message.method === 'textDocument/didOpen') {
              if (buffers.has(target)) return;
              buffers.set(target, params.textDocument.text!);
            } else if (message.method === 'textDocument/didClose') {
              buffers.delete(target);
            } else if (message.method === 'textDocument/didChange') {
              buffers.set(target, params.contentChanges![0]!.text);
            }
            send(message);
          });
          connection.request.mockImplementation(async (method, params) =>
            method === 'textDocument/hover'
              ? {
                  contents: buffers.get(
                    (params as { textDocument: { uri: string } }).textDocument
                      .uri,
                  ),
                }
              : { items: [] },
          );
          expect((await hover(extraUri))?.contents).toBe('extra');
          const parked = `${extra}-parked`;
          if (scope === 'removed') {
            workspace.removeDirectory(extra);
          } else {
            fs.renameSync(extra, parked);
            fs.writeFileSync(extra, 'not a directory');
          }
          connection.send.mockClear();
          const read = vi.spyOn(fs, 'readFileSync');
          try {
            if (scope === 'unresolvable') {
              await expect(workspaceDiagnostics()).rejects.toThrow(
                'Cannot resolve LSP document',
              );
              await expect(workspaceDiagnostics()).rejects.toThrow(
                'Cannot resolve LSP document',
              );
            } else {
              await workspaceDiagnostics();
              await workspaceDiagnostics();
            }
            expect(read).not.toHaveBeenCalled();
            expect(connection.send).not.toHaveBeenCalled();
            expect(openedDocuments().get('test')?.has(extraUri)).toBe(false);
          } finally {
            read.mockRestore();
          }
          if (scope === 'removed') {
            workspace.addDirectory(extra);
          } else {
            fs.unlinkSync(extra);
            fs.renameSync(parked, extra);
          }
          fs.writeFileSync(path.join(extra, 'source file.ts'), 'current');
          if (recovery === 'workspace') {
            await workspaceDiagnostics();
            expect(buffers.get(extraUri)).toBe('current');
          }

          expect((await hover(extraUri))?.contents).toBe('current');
          expect(buffers.get(extraUri)).toBe('current');
          expect(
            connection.send.mock.calls.map(([message]) => message),
          ).toEqual([
            {
              jsonrpc: '2.0',
              method: 'textDocument/didClose',
              params: { textDocument: { uri: extraUri } },
            },
            didOpen('current', 2, extraUri),
          ]);
        },
      );

      it.each([false, true])(
        'retains revoked replay across a connection swap, prior revoked sweep %s',
        async (priorSweep) => {
          await run(service.diagnostics(extraUri));
          workspace.removeDirectory(extra);
          if (priorSweep) await workspaceDiagnostics();
          const replacement = replaceConnection();
          await workspaceDiagnostics();
          expect(replacement.send).not.toHaveBeenCalled();

          workspace.addDirectory(extra);
          await workspaceDiagnostics();
          expect(replacement.send).toHaveBeenCalledExactlyOnceWith(
            didOpen('extra', 1, extraUri),
          );
        },
      );

      it.each(['workspace/diagnostic', 'workspace/symbol'] as const)(
        'does not surface revoked buffers in %s results',
        async (method) => {
          await run(service.diagnostics(extraUri));
          workspace.removeDirectory(extra);
          const healthyFile = path.join(primary, 'healthy.ts');
          fs.writeFileSync(healthyFile, 'healthy');
          const healthyUri = pathToFileURL(healthyFile).toString();
          connection.request.mockImplementation(async (requested) => {
            if (requested !== method) return [];
            const targets = [
              extraUri,
              'jdt://contents/Foo.class',
              'untitled:buffer',
              healthyUri,
              healthyFile,
              'file://[invalid',
              'https://[invalid',
              123,
            ];
            return method === 'workspace/diagnostic'
              ? {
                  items: targets.map((target) => ({
                    uri: target,
                    items: [{ range, message: 'diagnostic', severity: 1 }],
                  })),
                }
              : targets.map((target) => ({
                  name: 'fn',
                  kind: 12,
                  location: { uri: target, range },
                }));
          });

          const results =
            method === 'workspace/diagnostic'
              ? await workspaceDiagnostics()
              : await run(service.workspaceSymbols('fn'));
          expect(
            results.map((result) =>
              'uri' in result ? result.uri : result.location.uri,
            ),
          ).toEqual([
            'jdt://contents/Foo.class',
            'untitled:buffer',
            healthyUri,
          ]);
        },
      );

      it.each(
        ([1, undefined, 0, { openClose: false, change: 0 }] as const).flatMap(
          (sync) =>
            (
              [
                'workspace',
                'symbols',
                'diagnostics',
                'incomingCalls',
                'outgoingCalls',
              ] as const
            ).map((operation) => ({ sync, operation })),
        ),
      )(
        'does not revive hierarchy tokens after $operation scope loss with sync $sync',
        async ({ sync, operation }) => {
          handle.textDocumentSync = sync;
          const [previous] = await prepare(extraUri);
          workspace.removeDirectory(extra);
          if (operation === 'workspace') {
            connection.request.mockResolvedValueOnce({
              items: [
                {
                  uri: extraUri,
                  items: [{ range, message: 'revoked', severity: 1 }],
                },
              ],
            });
            expect(await workspaceDiagnostics()).toEqual([]);
          } else if (operation === 'symbols') {
            connection.request.mockResolvedValueOnce([
              { name: 'fn', location: { uri: extraUri, range } },
            ]);
            expect(await run(service.workspaceSymbols('fn'))).toEqual([]);
          } else if (operation === 'diagnostics') {
            await expect(run(service.diagnostics(extraUri))).rejects.toThrow(
              'outside the current workspace directories',
            );
          } else {
            await expect(service[operation](previous!)).rejects.toThrow(AGAIN);
          }
          workspace.addDirectory(extra);
          connection.request.mockClear();
          await expect(service.incomingCalls(previous!)).rejects.toThrow(AGAIN);
          expect(connection.request).not.toHaveBeenCalled();
          const [current] = await prepare(extraUri);

          expect(current!.documentRevision).not.toBe(
            previous!.documentRevision,
          );
          await expect(service.incomingCalls(previous!)).rejects.toThrow(AGAIN);
          await expect(run(service.incomingCalls(current!))).resolves.toEqual(
            [],
          );
        },
      );

      it.each([1, undefined, 0, { openClose: false, change: 0 }] as const)(
        'invalidates revoked hierarchy items on every owner with sync %j',
        async (sync) => {
          handle.textDocumentSync = sync;
          const second = createConnection();
          useHandles([
            ['test', handle],
            ['second', { ...handle, connection: second }],
          ]);
          const [firstItem] = await run(
            service.prepareCallHierarchy({ uri: extraUri, range }, 'test'),
          );
          const [secondItem] = await run(
            service.prepareCallHierarchy({ uri: extraUri, range }, 'second'),
          );
          workspace.removeDirectory(extra);
          connection.send.mockClear();
          second.send.mockClear();
          await expect(service.incomingCalls(firstItem!)).rejects.toThrow(
            AGAIN,
          );
          expect(openedDocuments().get('test')?.has(extraUri) ?? false).toBe(
            false,
          );
          expect(openedDocuments().get('second')?.has(extraUri) ?? false).toBe(
            false,
          );
          expect(connection.send).not.toHaveBeenCalled();
          expect(second.send).not.toHaveBeenCalled();
          workspace.addDirectory(extra);
          second.request.mockClear();
          await expect(service.incomingCalls(secondItem!)).rejects.toThrow(
            AGAIN,
          );
          expect(second.request).not.toHaveBeenCalled();
          const [current] = await run(
            service.prepareCallHierarchy({ uri: extraUri, range }, 'second'),
          );
          expect(current!.documentRevision).not.toBe(
            secondItem!.documentRevision,
          );
          await expect(run(service.incomingCalls(current!))).resolves.toEqual(
            [],
          );
          if (sync !== 1) expect(second.send).not.toHaveBeenCalled();
        },
      );

      it('keeps unrelated disk hierarchy items valid after another URI is revoked', async () => {
        handle.textDocumentSync = 0;
        const healthyFile = path.join(primary, 'main.ts');
        fs.writeFileSync(healthyFile, 'primary');
        const healthyUri = pathToFileURL(healthyFile).toString();
        const [revoked] = await prepare(extraUri);
        const [healthy] = await prepare(healthyUri);
        workspace.removeDirectory(extra);
        await expect(service.incomingCalls(revoked!)).rejects.toThrow(AGAIN);
        await expect(run(service.incomingCalls(healthy!))).resolves.toEqual([]);
        workspace.addDirectory(extra);
        await expect(run(service.outgoingCalls(healthy!))).resolves.toEqual([]);
        expect(connection.send).not.toHaveBeenCalled();
      });

      it('rejects a pending disk hierarchy response after observed revocation and regrant', async () => {
        handle.textDocumentSync = 0;
        const [item] = await prepare(extraUri);
        const respond = deferNextRequest();
        const pending = caught(service.incomingCalls(item!));
        await vi.runAllTimersAsync();
        workspace.removeDirectory(extra);
        await expect(service.outgoingCalls(item!)).rejects.toThrow(AGAIN);
        workspace.addDirectory(extra);
        respond([]);
        await expect(pending).resolves.toMatchObject(againError());
        expect(connection.send).not.toHaveBeenCalled();
      });

      it.each(['query', 'workspace'])(
        'discards an obsolete close after connection replacement via %s',
        async (recovery) => {
          await run(service.diagnostics(extraUri));
          workspace.removeDirectory(extra);
          await workspaceDiagnostics();
          const replacement = replaceConnection();
          workspace.addDirectory(extra);
          if (recovery === 'workspace') await workspaceDiagnostics();
          else await run(service.diagnostics(extraUri));

          expect(replacement.send).toHaveBeenCalledExactlyOnceWith(
            didOpen('extra', 1, extraUri),
          );
        },
      );

      it('defers a revoked pending close without stranding a healthy survivor', async () => {
        const targetFile = path.join(primary, 'main.ts');
        fs.writeFileSync(targetFile, 'primary');
        const primaryUri = pathToFileURL(targetFile).toString();
        await run(service.diagnostics(extraUri));
        await run(service.diagnostics(primaryUri));
        fs.unlinkSync(path.join(extra, 'source file.ts'));
        const send = connection.send.getMockImplementation()!;
        connection.send.mockImplementation((message) => {
          if (message.method === 'textDocument/didClose')
            throw new Error('close failed');
          send(message);
        });
        await expect(run(service.diagnostics(extraUri))).rejects.toThrow(
          'ENOENT',
        );
        workspace.removeDirectory(extra);
        fs.writeFileSync(targetFile, 'survivor');
        connection.send.mockClear();

        await workspaceDiagnostics();

        expect(connection.send).toHaveBeenCalledExactlyOnceWith({
          jsonrpc: '2.0',
          method: 'textDocument/didChange',
          params: {
            textDocument: { uri: primaryUri, version: 2 },
            contentChanges: [{ text: 'survivor' }],
          },
        });
        const lifecycles = (
          service as unknown as {
            documentLifecycles: Map<string, Map<string, unknown>>;
          }
        ).documentLifecycles;
        expect(lifecycles.get('test')?.get(extraUri)).toEqual({
          version: 1,
          readFailures: 1,
          pendingClose: { error: expect.any(Error) },
        });
        fs.writeFileSync(path.join(extra, 'source file.ts'), 'restored');
        workspace.addDirectory(extra);
        connection.send.mockClear();
        connection.request.mockClear();
        const read = vi.spyOn(fs, 'readFileSync');
        try {
          await expect(run(service.diagnostics(extraUri))).rejects.toThrow(
            'still cannot close',
          );
          expect(read).not.toHaveBeenCalled();
          expect(connection.request).not.toHaveBeenCalled();
          expect(openedUris(connection)).toEqual([]);
        } finally {
          read.mockRestore();
        }
        fs.writeFileSync(targetFile, 'next survivor');
        await expect(workspaceDiagnostics()).rejects.toThrow(
          'still cannot close',
        );
        expect(connection.send).toHaveBeenCalledWith(
          didChange('next survivor', 3, primaryUri),
        );
        connection.send.mockImplementation(send);
        connection.send.mockClear();
        await workspaceDiagnostics();
        expect(connection.send.mock.calls.map(([message]) => message)).toEqual([
          {
            jsonrpc: '2.0',
            method: 'textDocument/didClose',
            params: { textDocument: { uri: extraUri } },
          },
          didOpen('restored', 2, extraUri),
        ]);
      });

      it('warms an in-scope file after revocation without replacing the connection', async () => {
        const candidate = path.join(primary, 'main.ts');
        fs.writeFileSync(candidate, 'primary');
        await run(service.diagnostics(extraUri));
        workspace.removeDirectory(extra);
        connection.send.mockClear();
        await run(service.workspaceSymbols('main'));
        expect(connection.send).toHaveBeenCalledWith(
          didOpen('primary', 1, pathToFileURL(candidate).toString()),
        );
      });

      describe.each([
        'definitions',
        'references',
        'hover',
        'documentSymbols',
        'implementations',
        'prepareCallHierarchy',
        'diagnostics',
        'codeActions',
      ] as const)('%s scope across awaits', (operation) => {
        const query = () => {
          if (operation === 'documentSymbols' || operation === 'diagnostics') {
            return service[operation](extraUri);
          }
          if (operation === 'codeActions') {
            return service.codeActions(extraUri, range, { diagnostics: [] });
          }
          return service[operation]({ uri: extraUri, range });
        };
        const refusal =
          /current workspace directories|prepare call hierarchy again/;

        it('refuses a query revoked during warmup without reading or requesting', async () => {
          await run(service.diagnostics(extraUri));
          connection.send.mockClear();
          connection.request.mockClear();
          const read = vi.spyOn(fs, 'readFileSync');
          vi.spyOn(manager, 'warmupTypescriptServer').mockImplementation(
            async () => {
              workspace.removeDirectory(extra);
              read.mockClear();
            },
          );
          try {
            await expect(run<unknown>(query())).rejects.toThrow(refusal);
            expect(read).not.toHaveBeenCalled();
            expect(connection.send).not.toHaveBeenCalled();
            expect(connection.request).not.toHaveBeenCalled();
            expect(openedDocuments().get('test')?.has(extraUri)).toBe(false);
          } finally {
            read.mockRestore();
          }
        });

        it('refuses a query revoked during the didOpen indexing delay', async () => {
          setTimeout(() => workspace.removeDirectory(extra), 1);
          await expect(run<unknown>(query())).rejects.toThrow(refusal);
          expect(connection.send).toHaveBeenCalledExactlyOnceWith(
            didOpen('extra', 1, extraUri),
          );
          expect(connection.request).not.toHaveBeenCalled();
          expect(openedDocuments().get('test')?.has(extraUri)).toBe(false);
        });

        it.each([false, true])(
          'refuses a response revoked while the request awaits, peer fails %s',
          async (fails) => {
            connection.request.mockImplementation(async () => {
              workspace.removeDirectory(extra);
              if (fails) throw new Error('peer request failed');
              return [];
            });
            await expect(run<unknown>(query())).rejects.toThrow(refusal);
            expect(connection.request).toHaveBeenCalledTimes(1);
            expect(openedDocuments().get('test')?.has(extraUri)).toBe(false);
          },
        );

        if (
          operation !== 'diagnostics' &&
          operation !== 'codeActions' &&
          operation !== 'prepareCallHierarchy'
        ) {
          it('does not retry a query after scope is revoked during retry delay', async () => {
            connection.request.mockImplementation(async () => {
              setTimeout(() => workspace.removeDirectory(extra), 1);
              return [];
            });
            await expect(run<unknown>(query())).rejects.toThrow(refusal);
            expect(connection.request).toHaveBeenCalledTimes(1);
            expect(openedDocuments().get('test')?.has(extraUri)).toBe(false);
          });
        }
      });

      it('rejects hierarchy preparation when scope is revoked during warmup', async () => {
        vi.spyOn(manager, 'warmupTypescriptServer').mockImplementation(
          async () => {
            workspace.removeDirectory(extra);
          },
        );
        const read = vi.spyOn(fs, 'readFileSync');
        try {
          await expect(
            run(service.prepareCallHierarchy({ uri: extraUri, range })),
          ).rejects.toThrow(AGAIN);
          expect(
            read.mock.calls.filter(
              ([target]) => target === path.join(extra, 'source file.ts'),
            ),
          ).toHaveLength(1);
          expect(connection.send).not.toHaveBeenCalled();
          expect(connection.request).not.toHaveBeenCalled();
        } finally {
          read.mockRestore();
        }
      });

      it('does not replay revoked files during configuration reload', async () => {
        const targetFile = path.join(primary, 'main.ts');
        fs.writeFileSync(targetFile, 'primary');
        const primaryUri = pathToFileURL(targetFile).toString();
        await run(service.diagnostics(extraUri));
        await run(service.diagnostics(primaryUri));
        workspace.removeDirectory(extra);
        replaceConnection();
        await workspaceDiagnostics();
        const replacement = createConnection();
        vi.spyOn(manager, 'reconcileServerConfigs').mockImplementation(
          async () => {
            handle.connection = replacement;
            return {
              added: [],
              removed: [],
              restarted: ['test'],
              unchanged: [],
              failed: [],
            };
          },
        );

        await run(service.reinitialize());

        expect(openedUris(replacement)).toEqual([primaryUri]);
        expect(openedDocuments().get('test')?.has(extraUri)).toBe(false);
        expect(
          (
            service as unknown as { replayUris: Map<string, Set<string>> }
          ).replayUris.get('test'),
        ).toBeUndefined();
        workspace.addDirectory(extra);
        await workspaceDiagnostics();
        expect(openedUris(replacement)).toEqual([primaryUri]);
      });

      it.each(['incomingCalls', 'outgoingCalls'] as const)(
        'does not read a revoked hierarchy target before %s',
        async (method) => {
          const [item] = await prepare(extraUri);
          workspace.removeDirectory(extra);
          connection.request.mockClear();
          const read = vi.spyOn(fs, 'readFileSync');
          try {
            await expect(service[method](item!)).rejects.toThrow(AGAIN);
            expect(read).not.toHaveBeenCalled();
            expect(connection.request).not.toHaveBeenCalled();
          } finally {
            read.mockRestore();
          }
        },
      );

      it('explains an external navigation target and its follow-up refusal', async () => {
        const targetFile = path.join(primary, 'main.ts');
        fs.writeFileSync(targetFile, 'primary');
        workspace.removeDirectory(extra);
        connection.request.mockImplementation(async (method) =>
          method === 'textDocument/definition'
            ? [{ uri: extraUri, range }]
            : method === 'textDocument/hover'
              ? { contents: 'hover answer' }
              : [],
        );
        const tool = lspTool();
        const definitions = await execute(tool, {
          operation: 'goToDefinition',
          filePath: targetFile,
          line: 1,
        });
        expect(definitions.llmContent).toContain('outside workspace');
        expect(definitions.llmContent).toContain('/directory add');
        connection.request.mockClear();
        const refused = await execute(tool, {
          operation: 'hover',
          filePath: path.join(extra, 'source file.ts'),
          line: 1,
        });
        expect(refused.llmContent).toContain(
          'outside the current workspace directories',
        );
        expect(refused.llmContent).not.toContain(
          'No ready LSP server matches document',
        );
        expect(connection.request).not.toHaveBeenCalled();

        workspace.addDirectory(extra);
        const allowed = await execute(tool, {
          operation: 'hover',
          filePath: path.join(extra, 'source file.ts'),
          line: 1,
        });
        expect(allowed.llmContent).toContain('hover answer');
      });

      it('registers a raw root alias as a resolved directory', async () => {
        const alias = path.join(directory, 'primary-alias');
        fs.symlinkSync(primary, alias, 'junction');
        workspace = new WorkspaceContext(alias);
        (
          service as unknown as { workspaceContext: WorkspaceContext }
        ).workspaceContext = workspace;
        const targetFile = path.join(primary, 'main.ts');
        fs.writeFileSync(targetFile, 'primary');
        const target = pathToFileURL(targetFile).toString();

        await run(service.documentSymbols(target));

        expect(workspace.getDirectories()).toEqual([primary]);
        expect(connection.request).toHaveBeenCalledWith(
          'textDocument/documentSymbol',
          { textDocument: { uri: target } },
        );
      });

      it('resolves an included directory alias through WorkspaceContext', async () => {
        const alias = path.join(fs.realpathSync(directory), 'extra-alias');
        fs.symlinkSync(extra, alias, 'junction');
        const target = pathToFileURL(
          path.join(alias, 'source file.ts'),
        ).toString();

        await run(service.diagnostics(target));

        expect(connection.send).toHaveBeenCalledWith(
          didOpen('extra', 1, target),
        );
        expect(connection.request).toHaveBeenCalledWith(
          'textDocument/diagnostic',
          { textDocument: { uri: target } },
        );
      });

      it('honors runtime directory additions and removals even for an open document', async () => {
        expect(workspace.removeDirectory(extra)).toBe(true);
        await expect(run(service.diagnostics(extraUri))).rejects.toThrow(
          'outside the current workspace directories',
        );
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();

        workspace.addDirectory(extra);
        await run(service.diagnostics(extraUri));
        expect(connection.send).toHaveBeenCalledWith(
          didOpen('extra', 1, extraUri),
        );
        expect(connection.request).toHaveBeenCalledWith(
          'textDocument/diagnostic',
          { textDocument: { uri: extraUri } },
        );
        connection.send.mockClear();
        connection.request.mockClear();

        expect(workspace.removeDirectory(extra)).toBe(true);
        await expect(run(service.diagnostics(extraUri))).rejects.toThrow(
          'outside the current workspace directories',
        );
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      });

      it.each(['rootUri', 'workspaceFolder'] as const)(
        'does not widen an explicit %s subroot to other workspace directories',
        async (rootSource) => {
          const subroot = path.join(primary, 'sub');
          fs.mkdirSync(subroot);
          const targetFile = path.join(subroot, 'main.ts');
          fs.writeFileSync(targetFile, 'sub');
          const target = pathToFileURL(targetFile).toString();
          if (rootSource === 'rootUri')
            handle.config.rootUri = pathToFileURL(subroot).toString();
          else handle.config.workspaceFolder = subroot;

          await run(service.diagnostics(target));
          expect(connection.send).toHaveBeenCalledWith(
            didOpen('sub', 1, target),
          );
          connection.send.mockClear();
          connection.request.mockClear();

          for (const rejected of [
            extraUri,
            pathToFileURL(path.join(primary, 'main.ts')).toString(),
          ]) {
            await expect(run(service.diagnostics(rejected))).rejects.toThrow(
              "outside every ready LSP server's workspaceFolder",
            );
          }
          expect(connection.send).not.toHaveBeenCalled();
          expect(connection.request).not.toHaveBeenCalled();
        },
      );

      it('routes a subroot file through an alias and preserves the requested URI', async () => {
        const subroot = path.join(primary, 'sub');
        fs.mkdirSync(subroot);
        fs.writeFileSync(path.join(subroot, 'main.ts'), 'sub');
        const alias = path.join(primary, 'sub-alias');
        fs.symlinkSync(subroot, alias, 'junction');
        handle.config.workspaceFolder = subroot;
        const target = pathToFileURL(path.join(alias, 'main.ts')).toString();

        await run(service.diagnostics(target));

        expect(connection.send).toHaveBeenCalledWith(didOpen('sub', 1, target));
        expect(connection.request).toHaveBeenCalledWith(
          'textDocument/diagnostic',
          {
            textDocument: { uri: target },
          },
        );
      });

      it.each(['included', 'outside'])(
        'rejects a subroot symlink escaping to an %s root',
        async (destination) => {
          const subroot = path.join(primary, 'sub');
          fs.mkdirSync(subroot);
          const outside = path.join(fs.realpathSync(directory), 'outside');
          fs.mkdirSync(outside);
          fs.writeFileSync(path.join(outside, 'source file.ts'), 'outside');
          const alias = path.join(subroot, 'link');
          fs.symlinkSync(
            destination === 'included' ? extra : outside,
            alias,
            'junction',
          );
          handle.config.workspaceFolder = subroot;
          const target = pathToFileURL(
            path.join(alias, 'source file.ts'),
          ).toString();

          await expect(run(service.diagnostics(target))).rejects.toThrow(
            destination === 'included'
              ? "outside every ready LSP server's workspaceFolder"
              : 'outside the current workspace directories',
          );
          expect(connection.send).not.toHaveBeenCalled();
          expect(connection.request).not.toHaveBeenCalled();
        },
      );

      it('treats a root alias to primary as the full current workspace', async () => {
        const rootAlias = path.join(
          fs.realpathSync(directory),
          'primary-alias',
        );
        fs.symlinkSync(primary, rootAlias, 'junction');
        handle.config.workspaceFolder = rootAlias;

        await run(service.diagnostics(extraUri));

        expect(connection.send).toHaveBeenCalledWith(
          didOpen('extra', 1, extraUri),
        );
        expect(connection.request).toHaveBeenCalledWith(
          'textDocument/diagnostic',
          {
            textDocument: { uri: extraUri },
          },
        );
      });

      it('rejects an explicit root target no longer in the current workspace', async () => {
        handle.config.workspaceFolder = extra;
        expect(workspace.removeDirectory(extra)).toBe(true);

        await expect(run(service.diagnostics(extraUri))).rejects.toThrow(
          'outside the current workspace directories',
        );
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      });

      it('uses fresh document resolution after a cached alias is retargeted outside', async () => {
        const alias = path.join(primary, 'link');
        fs.symlinkSync(extra, alias, 'junction');
        const targetFile = path.join(alias, 'source file.ts');
        const target = pathToFileURL(targetFile).toString();
        expect(workspace.isPathWithinWorkspace(targetFile)).toBe(true);
        await run(service.diagnostics(target));
        expect(connection.request).toHaveBeenCalledWith(
          'textDocument/diagnostic',
          {
            textDocument: { uri: target },
          },
        );
        connection.send.mockClear();
        connection.request.mockClear();
        const outside = path.join(fs.realpathSync(directory), 'outside');
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(outside, 'source file.ts'), 'outside');
        fs.unlinkSync(alias);
        fs.symlinkSync(outside, alias, 'junction');
        expect(workspace.isPathWithinWorkspace(targetFile)).toBe(true);

        await expect(run(service.diagnostics(target))).rejects.toThrow(
          'outside the current workspace directories',
        );
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      });

      it('rejects an external cached alias replaced by an unregistered physical directory', async () => {
        const alias = path.join(fs.realpathSync(directory), 'cached-alias');
        fs.symlinkSync(extra, alias, 'junction');
        const targetFile = path.join(alias, 'source file.ts');
        const target = pathToFileURL(targetFile).toString();
        expect(workspace.isPathWithinWorkspace(targetFile)).toBe(true);
        await run(service.diagnostics(target));
        expect(connection.send).toHaveBeenCalledWith(
          didOpen('extra', 1, target),
        );
        expect(connection.request).toHaveBeenCalledWith(
          'textDocument/diagnostic',
          {
            textDocument: { uri: target },
          },
        );
        connection.send.mockClear();
        connection.request.mockClear();
        fs.unlinkSync(alias);
        fs.mkdirSync(alias);
        fs.writeFileSync(targetFile, 'outside replacement');
        expect(resolveWorkspacePath(targetFile)).toBe(targetFile);
        expect(workspace.isPathWithinWorkspace(targetFile)).toBe(true);
        expect(
          new WorkspaceContext(primary, [extra]).isPathWithinWorkspace(
            targetFile,
          ),
        ).toBe(false);

        await expect(run(service.diagnostics(target))).rejects.toThrow(
          'outside the current workspace directories',
        );
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      });

      it('refuses edits through a cached alias replaced outside the workspace', async () => {
        const alias = path.join(directory, 'write-alias');
        fs.symlinkSync(extra, alias, 'junction');
        const targetFile = path.join(alias, 'source file.ts');
        expect(workspace.isPathWithinWorkspace(targetFile)).toBe(true);
        fs.unlinkSync(alias);
        fs.mkdirSync(alias);
        fs.writeFileSync(targetFile, 'unchanged');

        expect(
          await service.applyWorkspaceEdit({
            changes: {
              [targetFile]: [{ range, newText: 'bad' }],
            },
          }),
        ).toBe(false);
        expect(fs.readFileSync(targetFile, 'utf-8')).toBe('unchanged');
      });

      it('preserves missing-file diagnostics errors for a valid subroot alias', async () => {
        const subroot = path.join(primary, 'sub');
        fs.mkdirSync(subroot);
        const alias = path.join(primary, 'sub-alias');
        fs.symlinkSync(subroot, alias, 'junction');
        handle.config.workspaceFolder = subroot;
        const target = pathToFileURL(path.join(alias, 'missing.ts')).toString();

        await expect(run(service.diagnostics(target))).rejects.toThrow(
          'ENOENT',
        );
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      });

      it('rejects an explicit server override outside workspace before reading', async () => {
        workspace.removeDirectory(extra);
        handle.config.workspaceFolder = extra;
        const read = vi.spyOn(fs, 'readFileSync');
        try {
          await expect(
            run(service.diagnostics(extraUri, 'test')),
          ).rejects.toThrow('outside the current workspace directories');
          expect(read).not.toHaveBeenCalled();
          expect(connection.send).not.toHaveBeenCalled();
          expect(connection.request).not.toHaveBeenCalled();
        } finally {
          read.mockRestore();
        }
      });

      it('rejects an unregistered sibling directory', async () => {
        const outside = `${extra}-other`;
        fs.mkdirSync(outside);
        const targetFile = path.join(outside, 'main.ts');
        fs.writeFileSync(targetFile, 'outside');

        await expect(
          run(service.diagnostics(pathToFileURL(targetFile).toString())),
        ).rejects.toThrow('outside the current workspace directories');
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      });

      it('still rejects an unrelated language in an included directory', async () => {
        handle.config.languages = ['python'];

        await expect(run(service.diagnostics(extraUri))).rejects.toThrow(
          'No ready LSP server matches document',
        );
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      });
    });

    it.each(['custom', '.custom'])(
      'honors explicit extension key %s',
      async (key) => {
        handle.config.extensionToLanguage = { [key]: 'typescript' };
        const [, target] = addFile('sample.custom', 'text');

        await run(service.diagnostics(target));

        expect(connection.request).toHaveBeenCalled();
      },
    );

    it('does not infer extensions excluded by an explicit mapping', async () => {
      handle.config.extensionToLanguage = { tsx: 'typescriptreact' };

      await expect(run(service.diagnostics(uri))).rejects.toThrow(
        'No ready LSP server matches document',
      );

      expect(connection.send).not.toHaveBeenCalled();
      expect(connection.request).not.toHaveBeenCalled();
    });

    it('falls back to languages when the mapping is empty', async () => {
      handle.config.extensionToLanguage = {};

      await run(service.diagnostics(uri));

      expect(connection.request).toHaveBeenCalled();
    });

    it('does not query a sole unrelated server or an unknown extension', async () => {
      handle.config.languages = ['python'];
      const [, unknown] = addFile('sample.unknown', 'text');

      for (const target of [uri, unknown]) {
        await expect(run(service.diagnostics(target))).rejects.toThrow(
          'No ready LSP server matches document',
        );
      }

      expect(connection.send).not.toHaveBeenCalled();
      expect(connection.request).not.toHaveBeenCalled();
    });

    it('reports unavailable diagnostics instead of a clean file when no server matches', async () => {
      handle.config.languages = ['python'];

      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: file,
      });

      expect(result.llmContent).toContain(
        'No ready LSP server matches document',
      );
      expect(result.llmContent).not.toContain('No diagnostics found');
      expect(connection.send).not.toHaveBeenCalled();
      expect(connection.request).not.toHaveBeenCalled();
    });

    it.each(['rootUri', 'workspaceFolder'] as const)(
      'respects %s and sibling root boundaries',
      async (rootSource) => {
        const root = path.join(directory, 'project');
        const siblingRoot = `${root}-other`;
        fs.mkdirSync(siblingRoot);
        const targetFile = path.join(siblingRoot, 'source file.ts');
        fs.writeFileSync(targetFile, 'text');
        const target = pathToFileURL(targetFile).toString();
        if (rootSource === 'rootUri')
          handle.config.rootUri = pathToFileURL(root).toString();
        else handle.config.workspaceFolder = root;
        const matching = createConnection();
        useHandles([
          ['test', handle],
          [
            'sibling',
            {
              ...handle,
              config: {
                ...handle.config,
                name: 'sibling',
                rootUri: pathToFileURL(siblingRoot).toString(),
                workspaceFolder: siblingRoot,
              },
              connection: matching,
            },
          ],
        ]);

        await run(service.diagnostics(target));

        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
        expect(matching.request).toHaveBeenCalledWith(
          'textDocument/diagnostic',
          { textDocument: { uri: target } },
        );
      },
    );

    it('preserves an explicit server override despite language and root mismatch', async () => {
      handle.config.languages = ['python'];
      handle.config.rootUri = pathToFileURL(
        path.join(directory, 'other'),
      ).toString();

      await expect(run(service.diagnostics(uri))).rejects.toThrow(
        'retry with serverName',
      );
      expect(connection.request).not.toHaveBeenCalled();
      await run(service.diagnostics(uri, 'test'));

      expect(connection.request).toHaveBeenCalled();
    });

    it.each(
      ['ELOOP', 'EACCES'].flatMap((code) =>
        [false, true].map((badFirst) => ({ code, badFirst })),
      ),
    )(
      'isolates a handle root with $code, bad handle first $badFirst',
      async ({ code, badFirst }) => {
        const badRoot = path.join(directory, 'bad-root');
        const badConnection = createConnection();
        const bad = {
          ...handle,
          config: { ...handle.config, workspaceFolder: badRoot },
          connection: badConnection,
        };
        const realpath = fs.realpathSync;
        const resolve = vi
          .spyOn(fs, 'realpathSync')
          .mockImplementation((target) => {
            if (target === badRoot) {
              throw Object.assign(new Error('unusable root'), {
                code,
                path: badRoot,
              });
            }
            return realpath(target);
          });
        try {
          const entries: Array<[string, LspServerHandle]> = [
            ['test', handle],
            ['bad', bad],
          ];
          useHandles(badFirst ? entries.reverse() : entries);
          await run(service.diagnostics(uri));
          expect(connection.request).toHaveBeenCalledOnce();
          expect(badConnection.send).not.toHaveBeenCalled();
          expect(badConnection.request).not.toHaveBeenCalled();
          expect(logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('unusable root'),
            expect.any(Error),
          );
        } finally {
          resolve.mockRestore();
        }
      },
    );

    it('names document resolution failures without reading or querying', async () => {
      const regular = path.join(directory, 'regular');
      fs.writeFileSync(regular, 'not a directory');
      const read = vi.spyOn(fs, 'readFileSync');
      try {
        for (const target of [
          pathToFileURL(path.join(regular, 'main.ts')).toString(),
          'file://[invalid',
        ]) {
          await expect(run(service.diagnostics(target))).rejects.toThrow(
            'Cannot resolve LSP document',
          );
        }
        expect(read).not.toHaveBeenCalled();
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    });

    it('reads workspace directories and primary root once for a multi-server routing filter', () => {
      const subroot = path.join(directory, 'subroot');
      fs.mkdirSync(subroot);
      useHandles([
        ['test', handle],
        ['second', { ...handle }],
        ['third', { ...handle }],
        [
          'subroot',
          { ...handle, config: { ...handle.config, workspaceFolder: subroot } },
        ],
      ]);
      const workspace = (
        service as unknown as { workspaceContext: WorkspaceContext }
      ).workspaceContext;
      const directories = vi.spyOn(workspace, 'getDirectories');
      const containment = vi.spyOn(pathUtils, 'isSubpaths');
      const realpath = vi.spyOn(fs, 'realpathSync');
      const router = service as unknown as {
        getReadyHandles(serverName?: string, target?: string): unknown[];
      };
      try {
        expect(router.getReadyHandles(undefined, uri)).toHaveLength(3);
        expect(directories).toHaveBeenCalledOnce();
        expect(containment).toHaveBeenCalledTimes(2);
        expect(
          realpath.mock.calls.filter(([target]) => target === directory),
        ).toHaveLength(1);
      } finally {
        directories.mockRestore();
        containment.mockRestore();
        realpath.mockRestore();
      }
    });

    it('keeps workspace diagnostics querying all ready servers', async () => {
      const other = createConnection();
      useHandles([
        ['test', handle],
        [
          'python',
          {
            ...handle,
            config: { ...handle.config, name: 'python', languages: ['python'] },
            connection: other,
          },
        ],
      ]);

      await workspaceDiagnostics();

      for (const target of [connection, other]) {
        expect(target.request).toHaveBeenCalledWith('workspace/diagnostic', {
          previousResultIds: [],
        });
      }
    });
  });

  it.each(queryMethods)(
    'synchronizes before %s and skips unchanged text',
    async (method) => {
      await run(query(method));
      fs.writeFileSync(file, 'new');
      await run(query(method));
      await run(query(method));
      expect(connection.send.mock.calls.map(([message]) => message)).toEqual([
        {
          jsonrpc: '2.0',
          method: 'textDocument/didOpen',
          params: openParams('old'),
        },
        {
          jsonrpc: '2.0',
          method: 'textDocument/didChange',
          params: changeParams('new'),
        },
      ]);
      const changeIndex = connection.events.indexOf('textDocument/didChange');
      expect(connection.events[changeIndex + 1]).not.toMatch(/did/);
      fs.writeFileSync(file, 'third');
      await run(query(method));
      expectLastSent(withParams(changeParams('third', 3)));
    },
  );

  it.each(
    (['incomingCalls', 'outgoingCalls'] as const).flatMap((method) =>
      [false, true].map((sibling) => ({ method, sibling })),
    ),
  )(
    'rejects a line-shifted prepared item before $method, sibling sync $sibling',
    async ({ method, sibling }) => {
      fs.writeFileSync(file, 'old');
      const [item] = await prepare();
      await run<unknown>(service[method](item!));
      fs.writeFileSync(file, 'inserted\nold');
      if (sibling) await hover();
      connection.request.mockClear();
      connection.send.mockClear();
      await expect(service[method](item!)).rejects.toThrow(AGAIN);
      expect(connection.request).not.toHaveBeenCalled();
      expect(connection.send).not.toHaveBeenCalled();
    },
  );

  it.each(['incomingCalls', 'outgoingCalls'] as const)(
    'roundtrips hierarchy JSON through the tool and reports stale %s as a failure',
    async (operation) => {
      const tool = lspTool();
      expect(tool.schema.parametersJsonSchema).toMatchObject({
        definitions: {
          LspCallHierarchyItem: {
            properties: { documentRevision: { type: 'string' } },
          },
        },
      });
      const data = {
        steps: [{ uri, name: 'fn' }, 'leaf'],
        detail: { label: 'fn', kind: 12 },
      };
      connection.request.mockResolvedValueOnce([
        { name: 'fn', kind: 12, uri, range, selectionRange: range, data },
      ]);
      const prepared = await execute(tool, {
        operation: 'prepareCallHierarchy',
        filePath: file,
        line: 1,
        character: 1,
      });
      const items = JSON.parse(
        String(prepared.llmContent).split('Call hierarchy items (JSON):\n')[1]!,
      ) as LspCallHierarchyItem[];
      const item = items[0]!;
      expect(item.documentRevision).toEqual(expect.any(String));
      const reordered: LspCallHierarchyItem = {
        ...item,
        range: {
          end: { character: range.end.character, line: range.end.line },
          start: { character: range.start.character, line: range.start.line },
        },
        selectionRange: { end: range.end, start: range.start },
        data: {
          detail: { kind: 12, label: 'fn' },
          steps: [{ name: 'fn', uri }, 'leaf'],
        },
      };
      expect(reordered).toEqual(item);
      expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(item));
      connection.request.mockResolvedValueOnce([
        {
          [operation === 'incomingCalls' ? 'from' : 'to']: {
            ...item,
            kind: 12,
          },
          fromRanges: [range],
        },
      ]);
      const result = await execute(tool, {
        operation,
        callHierarchyItem: reordered,
      });
      expect(result.llmContent).toContain('calls (JSON):');
      const calls = JSON.parse(
        String(result.llmContent).split('calls (JSON):\n')[1]!,
      ) as Array<{ from?: LspCallHierarchyItem; to?: LspCallHierarchyItem }>;
      const nested = (calls[0]!.from ?? calls[0]!.to)!;
      expect(nested.documentRevision).toEqual(expect.any(String));
      await run<unknown>(service[operation](nested));
      const wire = connection.request.mock.calls.find(
        ([method]) => method === `callHierarchy/${operation}`,
      )![1] as { item: Record<string, unknown> };
      expect(wire.item).not.toHaveProperty('documentRevision');
      const requestCount = connection.request.mock.calls.length;
      for (const altered of [
        { ...item, range: { ...range, start: { line: 0, character: 1 } } },
        { ...item, data: { ...data, detail: { ...data.detail, kind: 13 } } },
        { ...item, data: { ...data, steps: [...data.steps].reverse() } },
        { ...item, data: { ...data, ...JSON.parse('{"__proto__":{"x":1}}') } },
      ]) {
        const rejected = await execute(tool, {
          operation,
          callHierarchyItem: altered,
        });
        expect(rejected.llmContent).toContain(AGAIN);
      }
      expect(connection.request).toHaveBeenCalledTimes(requestCount);
      fs.writeFileSync(file, 'inserted\nold');
      const stale = await execute(tool, { operation, callHierarchyItem: item });
      expect(stale.llmContent).toContain('calls failed:');
      expect(stale.llmContent).toContain(AGAIN);
      expect(stale.llmContent).not.toContain('No incoming calls');
      expect(stale.llmContent).not.toContain('No outgoing calls');
    },
  );

  it.each(
    (['incomingCalls', 'outgoingCalls'] as const).flatMap((method) =>
      ['edit', 'delete', 'disconnect', 'request failure'].map((change) => ({
        method,
        change,
      })),
    ),
  )(
    'rejects in-flight $method responses after $change',
    async ({ method, change }) => {
      fs.writeFileSync(file, 'old');
      handle.connection = connection;
      const [item] = await prepare();
      const respond = deferNextRequest(change === 'request failure');
      const pending = caught(service[method](item!));
      await vi.runAllTimersAsync();
      if (change === 'edit' || change === 'request failure') {
        fs.writeFileSync(file, 'inserted\nold');
        await hover();
      } else if (change === 'delete') {
        fs.unlinkSync(file);
      } else {
        handle.connection = undefined;
      }
      respond([]);
      await expect(pending).resolves.toMatchObject(againError());
    },
  );

  it('rejects missing, altered and replacement-connection hierarchy provenance', async () => {
    const [item] = await prepare();
    await expect(
      service.incomingCalls({ ...item!, documentRevision: undefined }),
    ).rejects.toThrow(AGAIN);
    await expect(
      service.incomingCalls({ ...item!, name: 'another' }),
    ).rejects.toThrow(AGAIN);
    handle.connection = createConnection();
    await expect(service.incomingCalls(item!)).rejects.toThrow(AGAIN);
    expect(handle.connection.request).not.toHaveBeenCalled();
  });

  it('validates disk-reading hierarchy items without recording an opened buffer', async () => {
    handle.textDocumentSync = undefined;
    const [item] = await prepare();
    await run(service.incomingCalls(item!));
    fs.writeFileSync(file, 'inserted\nold');
    await expect(service.outgoingCalls(item!)).rejects.toThrow(AGAIN);
    expect(connection.send).not.toHaveBeenCalled();
  });

  it('leaves unobserved nested hierarchy items without reusable provenance', async () => {
    const [item] = await prepare();
    const secondUri = pathToFileURL(
      path.join(directory, 'other.ts'),
    ).toString();
    connection.request.mockResolvedValueOnce([
      { from: { ...item!, uri: secondUri, kind: 12 }, fromRanges: [range] },
    ]);
    const [call] = await run(service.incomingCalls(item!));
    expect(call!.from.documentRevision).toBeUndefined();
    await expect(service.incomingCalls(call!.from)).rejects.toThrow(AGAIN);
  });

  it.each(['edit', 'replacement'])(
    'does not certify a prepare response after concurrent %s',
    async (change) => {
      await hover();
      const respond = deferNextRequest();
      const pending = caught(service.prepareCallHierarchy({ uri, range }));
      await vi.runAllTimersAsync();
      if (change === 'edit') {
        fs.writeFileSync(file, 'inserted\nold');
        await hover();
      } else {
        handle.connection = createConnection();
      }
      respond([{ name: 'fn', uri, kind: 12, range, selectionRange: range }]);
      await expect(pending).resolves.toMatchObject(againError());
    },
  );

  it('does not certify a prepare response when the target drifts during the warmup await', async () => {
    useTypescriptManager();
    const pending = caught(service.prepareCallHierarchy({ uri, range }));
    await vi.advanceTimersByTimeAsync(0);
    fs.writeFileSync(file, 'inserted\nold');
    connection.request.mockClear();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject(againError());
    expect(connection.request).not.toHaveBeenCalled();
  });

  it.each(['empty result', 'request failure'])(
    'does not certify a prepare %s after a concurrent edit',
    async (change) => {
      // Sync the target first so an empty response is not retried: a preceding
      // hover makes shouldRetryAfterOpen false and reaches the post-response
      // checkpoint rather than the empty-result retry path.
      await hover();
      const respond = deferNextRequest(change === 'request failure');
      const pending = caught(service.prepareCallHierarchy({ uri, range }));
      await vi.runAllTimersAsync();
      fs.writeFileSync(file, 'inserted\nold');
      await hover();
      respond([]);
      await expect(pending).resolves.toMatchObject(againError());
    },
  );

  it('rejects a restored-but-closed root traversed directly with the original token', async () => {
    const [item] = await prepare();
    expect(item?.documentRevision).toEqual(expect.any(String));
    // Close main.ts via a read failure, then restore it byte-identical: the
    // lifecycle retains version 1 but the document is no longer open.
    fs.unlinkSync(file);
    await expect(workspaceDiagnostics()).rejects.toThrow('ENOENT');
    fs.writeFileSync(file, 'old');
    connection.request.mockClear();
    // Traversing directly with the original token (no hover, no re-prepare) must
    // reject: the "must still be open" clause is the sole discriminator that the
    // buffer the token was signed against no longer exists on this connection.
    await expect(service.incomingCalls(item!)).rejects.toThrow(AGAIN);
    expect(connection.request).not.toHaveBeenCalled();
  });

  const hoverResyncEvents = [
    'textDocument/didOpen',
    'textDocument/hover',
    'textDocument/didChange',
    'textDocument/hover',
  ];

  it('refreshes hover after a same-size edit with identical restored mtime', async () => {
    const timestamp = new Date('2025-01-01T00:00:00Z');
    fs.utimesSync(file, timestamp, timestamp);
    const before = fs.statSync(file);
    expect(await hover()).toMatchObject({ contents: 'old' });
    fs.writeFileSync(file, 'new');
    fs.utimesSync(file, before.atime, before.mtime);
    const after = fs.statSync(file);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await hover()).toMatchObject({ contents: 'new' });
    expect(connection.events).toEqual(hoverResyncEvents);
  });

  it('refreshes hover after another process saves the target file', async () => {
    expect(await hover()).toMatchObject({ contents: 'old' });
    execFileSync(process.execPath, [
      '-e',
      "require('node:fs').writeFileSync(process.argv[1], 'process edit')",
      file,
    ]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('process edit');
    expect(await hover()).toMatchObject({ contents: 'process edit' });
    expect(connection.events).toEqual(hoverResyncEvents);
  });

  it.each([1, { openClose: true, change: 1 }])(
    'supports full sync %j without splitting the previous text',
    async (sync) => {
      handle.textDocumentSync = sync as LspTextDocumentSync | undefined;
      await hover();
      fs.writeFileSync(file, '');
      const split = vi.spyOn(String.prototype, 'split');
      let splitCalls: unknown[][];
      try {
        await hover();
        splitCalls = [...split.mock.calls];
      } finally {
        split.mockRestore();
      }
      expect(
        splitCalls.some(
          ([separator]) => String(separator) === '/\\r\\n|\\r|\\n/',
        ),
      ).toBe(false);
      expectLastSent(withParams(changeParams('')));
    },
  );

  it.each([2, { openClose: true, change: 2 }])(
    'uses UTF-16 whole-document ranges for incremental sync %j',
    async (sync) => {
      handle.textDocumentSync = sync as LspTextDocumentSync | undefined;
      fs.writeFileSync(file, 'first\r\n😀x\rsecond\n😀');
      await hover();
      fs.writeFileSync(file, 'replacement\r\n');
      await hover();
      expectLastSent(
        withParams({
          textDocument: { uri, version: 2 },
          contentChanges: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 3, character: 2 },
              },
              text: 'replacement\r\n',
            },
          ],
        }),
      );
      fs.writeFileSync(file, '');
      await hover();
      expectLastSent(
        withParams({
          textDocument: { uri, version: 3 },
          contentChanges: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 1, character: 0 },
              },
              text: '',
            },
          ],
        }),
      );
    },
  );

  it.each([{ openClose: true, change: 0 }])(
    'does not query changed text with unsupported sync %j',
    async (sync) => {
      handle.textDocumentSync = sync as LspTextDocumentSync | undefined;
      await hover();
      const sends = connection.send.mock.calls.length;
      expect(sends).toBe(typeof sync === 'object' && sync?.openClose ? 1 : 0);
      connection.request.mockClear();
      await hover();
      expect(connection.request).toHaveBeenCalledOnce();
      connection.request.mockClear();
      fs.writeFileSync(file, 'new');
      expect(await hover()).toBeNull();
      expect(connection.request).not.toHaveBeenCalled();
      expect(connection.send).toHaveBeenCalledTimes(sends + 1);
      expect(logger.warn).toHaveBeenLastCalledWith(
        'LSP textDocument/hover failed for test:',
        expect.objectContaining({
          message: `LSP server test cannot synchronize changed document ${uri}: textDocumentSync.change is None or absent`,
        }),
      );
    },
  );

  it.each([{ change: 1 }, { openClose: false, change: 2 }])(
    'honors disabled openClose %j',
    async (sync) => {
      handle.textDocumentSync = sync as LspTextDocumentSync | undefined;
      await hover();
      expect(connection.send).not.toHaveBeenCalled();
      fs.writeFileSync(file, 'new');
      await hover();
      expect(connection.send).not.toHaveBeenCalled();
    },
  );

  it.each([
    0,
    undefined,
    {},
    { openClose: false, change: 0 },
    { change: 1 },
    { openClose: false, change: 2 },
  ])(
    'queries disk-reading servers after repeated edits with sync %j',
    async (sync) => {
      handle.textDocumentSync = sync as LspTextDocumentSync | undefined;
      connection.request.mockImplementation(async () => ({
        contents: fs.readFileSync(file, 'utf-8'),
      }));
      for (const text of ['old', 'new', 'new', 'third']) {
        fs.writeFileSync(file, text);
        expect(await hover()).toMatchObject({
          contents: text,
        });
      }
      expect(connection.request).toHaveBeenCalledTimes(4);
      expect(connection.send).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 0, { change: 1 }])(
    'consistently delays and retries workspace symbols without openClose %j',
    async (sync) => {
      handle.textDocumentSync = sync as LspTextDocumentSync | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        connection.request.mockClear();
        const before = Date.now();
        await run(service.workspaceSymbols('fn'));
        expect(connection.request).toHaveBeenCalledTimes(2);
        expect(Date.now() - before).toBe(
          2 * DEFAULT_LSP_WORKSPACE_SYMBOL_WARMUP_DELAY_MS,
        );
      }
      expect(connection.send).not.toHaveBeenCalled();
    },
  );

  it('does not delay or retry an empty query after didChange', async () => {
    connection.request.mockResolvedValue([]);
    await run(service.definitions({ uri, range }));
    connection.request.mockClear();
    fs.writeFileSync(file, 'new');
    const before = Date.now();
    await run(service.definitions({ uri, range }));
    expect(connection.request).toHaveBeenCalledOnce();
    expect(Date.now() - before).toBe(0);
    expectLastSent(withParams(changeParams('new')));
  });

  it('sends the requested hover URI and start position', async () => {
    await hover();
    expect(connection.requests).toEqual([
      {
        method: 'textDocument/hover',
        params: { textDocument: { uri }, position: range.start },
      },
    ]);
  });

  it('retries a failed second-document didOpen at version 1', async () => {
    await hover();
    const [, secondUri] = addFile('other.ts', 'second');
    failNextSend();
    connection.request.mockClear();
    expect(await hover(secondUri)).toBeNull();
    expect(connection.request).not.toHaveBeenCalled();
    connection.send.mockClear();
    expect(await hover(secondUri)).toMatchObject({ contents: 'second' });
    expect(connection.send).toHaveBeenCalledExactlyOnceWith(
      didOpen('second', 1, secondUri),
    );
  });

  it('keeps text and versions independent for two documents on one connection', async () => {
    const [secondFile, secondUri] = addFile('other.ts', 'B');
    await hover();
    await hover(secondUri);
    fs.writeFileSync(secondFile, 'B-two');
    await hover(secondUri);
    await hover();
    expect(connection.send).toHaveBeenCalledTimes(3);
    fs.writeFileSync(file, 'A-two');
    await hover();
    expect(
      connection.send.mock.calls.map(([message]) => [
        message.method,
        message.params,
      ]),
    ).toEqual([
      ['textDocument/didOpen', openParams('old')],
      ['textDocument/didOpen', openParams('B', 1, secondUri)],
      ['textDocument/didChange', changeParams('B-two', 2, secondUri)],
      ['textDocument/didChange', changeParams('A-two')],
    ]);
  });

  it('synchronizes tracked documents before workspace diagnostics', async () => {
    await hover();
    fs.writeFileSync(file, 'new');
    await workspaceDiagnostics();
    expect(connection.events).toEqual([
      'textDocument/didOpen',
      'textDocument/hover',
      'textDocument/didChange',
      'workspace/diagnostic',
    ]);
  });

  it('does not synchronize servers skipped by the workspace diagnostic result limit', async () => {
    const secondConnection = createConnection();
    const secondHandle = { ...handle, connection: secondConnection };
    // SAFETY: Replace only handle discovery with two READY fixtures.
    useHandles([
      ['test', handle],
      ['second', secondHandle],
    ]);
    await hover(uri, 'test');
    await hover(uri, 'second');
    fs.writeFileSync(file, 'changed');
    secondConnection.send.mockClear();
    secondConnection.request.mockClear();
    connection.request.mockResolvedValue({
      items: [
        {
          uri,
          kind: 'full',
          items: [{ range, message: 'error', severity: 1 }],
        },
      ],
    });
    expect(await run(service.workspaceDiagnostics(undefined, 1))).toHaveLength(
      1,
    );
    expect(secondConnection.send).not.toHaveBeenCalled();
    expect(secondConnection.request).not.toHaveBeenCalled();
  });

  function useTypescriptManager() {
    useRealManager();
    handle.config.name = 'typescript';
    vi.spyOn(manager, 'getHandles').mockImplementation(
      () => new Map([['test', handle]]),
    );
  }

  it('forces unchanged TypeScript warmup with a monotonic didChange before retry', async () => {
    useTypescriptManager();
    await run(service.workspaceSymbols('fn'));
    connection.request.mockImplementationOnce(async (method) => {
      connection.events.push(method);
      return { message: 'No Project' };
    });
    await run(service.workspaceSymbols('fn'));
    expect(connection.events).toEqual([
      'textDocument/didOpen',
      'workspace/symbol',
      'workspace/symbol',
      'textDocument/didChange',
      'workspace/symbol',
    ]);
    expectLastSent(withParams(changeParams('old')));
    expect(handle.warmedUp).toBe(true);
  });

  it('warns and latches a TypeScript warmup attempt without notification support', async () => {
    useTypescriptManager();
    handle.textDocumentSync = undefined;
    await run(service.workspaceSymbols('fn'));
    await run(service.workspaceSymbols('fn'));
    expect(handle.warmedUp).toBe(true);
    expect(connection.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(
        'typescript warm-up delivered no notification (textDocumentSync=undefined)',
      ),
    );
  });

  it.each([
    ['mts', 'typescript'],
    ['cts', 'typescript'],
    ['mjs', 'javascript'],
    ['cjs', 'javascript'],
  ])(
    'warms a .%s-only TypeScript workspace using %s',
    async (extension, languageId) => {
      fs.unlinkSync(file);
      const [, target] = addFile(`module.${extension}`, 'module');
      useTypescriptManager();

      await run(service.workspaceSymbols('module'));

      expect(connection.send).toHaveBeenCalledExactlyOnceWith(
        didOpen('module', 1, target, languageId),
      );
    },
  );

  it.each([{ '.jsx': 'custom-jsx' }, undefined])(
    'uses the mapped or built-in JSX warmup language ID for %j',
    async (mapping) => {
      fs.unlinkSync(file);
      const [, target] = addFile('component.jsx', 'component');
      handle.config.extensionToLanguage = mapping;
      useTypescriptManager();
      await run(service.workspaceSymbols('component'));
      expect(connection.send).toHaveBeenCalledExactlyOnceWith(
        didOpen(
          'component',
          1,
          target,
          mapping ? 'custom-jsx' : 'javascriptreact',
        ),
      );
    },
  );

  it('honors an explicit TypeScript warmup extension map and language ID', async () => {
    const [, target] = addFile('component.jsx', 'component');
    handle.config.extensionToLanguage = { jsx: 'custom-jsx' };
    useTypescriptManager();

    await run(service.workspaceSymbols('component'));

    expect(connection.send).toHaveBeenCalledExactlyOnceWith(
      didOpen('component', 1, target, 'custom-jsx'),
    );
  });

  it('preserves the extension-derived language ID in a TSX-only warmup', async () => {
    fs.unlinkSync(file);
    const [, tsxUri] = addFile('component.tsx', 'component');
    useTypescriptManager();
    await run(service.workspaceSymbols('fn'));
    expect(connection.send).toHaveBeenCalledExactlyOnceWith(
      didOpen('component', 1, tsxUri, 'typescriptreact'),
    );
  });

  it('reopens current content with a fresh version after connection replacement', async () => {
    await hover();
    fs.writeFileSync(file, 'new');
    await hover();
    const replacement = replaceConnection();
    fs.writeFileSync(file, 'restarted');
    await hover();
    expect(replacement.send).toHaveBeenCalledExactlyOnceWith(
      didOpen('restarted'),
    );
  });

  it('shares warmup state with queries, forced warmup and replacement connections', async () => {
    useTypescriptManager();
    await run(service.workspaceSymbols('fn'));
    await hover();
    expect(connection.send).toHaveBeenCalledOnce();
    fs.writeFileSync(file, 'warmup changed');
    connection.request.mockResolvedValueOnce({ message: 'No Project' });
    await run(service.workspaceSymbols('fn'));
    expect(connection.send).toHaveBeenCalledTimes(2);
    expect(connection.events.slice(-2)).toEqual([
      'textDocument/didChange',
      'workspace/symbol',
    ]);
    await hover();
    expect(connection.send).toHaveBeenCalledTimes(2);
    expectLastSent(didChange('warmup changed'));
    handle.connection = createConnection();
    handle.warmedUp = false;
    fs.writeFileSync(file, 'restarted warmup');
    await run(service.workspaceSymbols('fn'));
    await hover();
    expect(handle.connection.send).toHaveBeenCalledExactlyOnceWith(
      didOpen('restarted warmup'),
    );
  });

  it('retains the unchanged server snapshot when only its sibling reloads', async () => {
    // SAFETY: Use real discovery/reconciliation, stubbing only process startup.
    useRealManager();
    const configs = {
      first: { command: 'first' },
      second: { command: 'second' },
    };
    writeLspConfig(configs);
    const unchanged = createConnection();
    // SAFETY: Supply READY connections without launching processes.
    stubReadyServers((name) =>
      name === 'second' ? unchanged : createConnection(),
    );
    await service.discoverAndPrepare();
    await service.start();
    await hover(uri, 'first');
    await hover(uri, 'second');
    unchanged.send.mockClear();
    writeLspConfig({
      ...configs,
      first: { ...configs.first, settings: { changed: true } },
    });
    const result = await run(service.reinitialize());
    expect(result.reconcile).toMatchObject({
      restarted: ['first'],
      unchanged: ['second'],
    });
    expect(unchanged.send).not.toHaveBeenCalled();
    await hover(uri, 'second');
    expect(unchanged.send).not.toHaveBeenCalled();
    fs.writeFileSync(file, 'changed');
    await hover(uri, 'second');
    expect(unchanged.send).toHaveBeenCalledExactlyOnceWith(
      didChange('changed'),
    );
  });

  it.each(['warmup', 'reopen'])(
    'preserves replayed workspace snapshots after reload during %s',
    async (phase) => {
      useRealManager();
      writeLspConfig({ typescript: { command: 'typescript' } });
      const connections = [connection, createConnection()];
      stubReadyServers(() => connections.shift()!);
      await service.discoverAndPrepare();
      await service.start();
      await hover();
      const active = manager.getHandles().get('typescript')!;
      const replacement = connections[0]!;
      if (phase === 'warmup') active.warmedUp = false;
      else active.connection = createConnection();
      const obsolete = active.connection!;
      const pending = caught(service.workspaceDiagnostics());
      await vi.advanceTimersByTimeAsync(0);
      writeLspConfig({
        typescript: { command: 'typescript', settings: { changed: true } },
      });
      const replayed = nextSend(replacement);
      const reload = service.reinitialize();
      await replayed;
      await vi.runAllTimersAsync();
      await reload;
      expect(await pending).toBeInstanceOf(Error);
      expect(obsolete.request).not.toHaveBeenCalledWith(
        'workspace/diagnostic',
        expect.anything(),
      );
      expect(replacement.request).not.toHaveBeenCalled();
      await hover();
      expect(replacement.send).toHaveBeenCalledOnce();
    },
  );

  it.each(queryMethods)(
    'preserves replayed snapshots when stale %s resumes after reload',
    async (method) => {
      // SAFETY: Access the service's real manager; only process startup is stubbed.
      useRealManager();
      const config = {
        ...handle.config,
        name: 'typescript',
        command: 'typescript',
      };
      manager.setServerConfigs([config]);
      const replacement = createConnection();
      connection.shutdown.mockResolvedValue(undefined);
      // SAFETY: This private method only supplies READY connection fixtures;
      // real reconcile, stop, warmup, and service replay run unchanged.
      stubReadyServers(() =>
        manager.getHandles().get('typescript') === handle
          ? connection
          : replacement,
      );
      handle = manager.getHandles().get('typescript')!;
      await manager.startAll();
      const traversal =
        method === 'incomingCalls' || method === 'outgoingCalls';
      const [oldItem] = traversal ? await prepare() : [];
      if (traversal) {
        expect(oldItem?.documentRevision).toEqual(expect.any(String));
        connection.request.mockClear();
        handle.warmedUp = false;
      }
      const pending = (
        traversal ? service[method](oldItem!) : query(method)
      ).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      expect(connection.send).toHaveBeenCalledOnce();
      expect(connection.request).not.toHaveBeenCalled();

      writeLspConfig({
        typescript: { command: 'typescript', settings: { changed: true } },
      });
      const replayed = nextSend(replacement);
      const reload = service.reinitialize();
      await replayed;
      expect(handle.connection).toBeUndefined();
      expect(manager.getHandles().get('typescript')).not.toBe(handle);
      expect(replacement.send).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(DEFAULT_LSP_WARMUP_DELAY_MS);
      const stale = await pending;
      await run(reload);
      await run(query(method));
      expect(replacement.send).toHaveBeenCalledOnce();
      fs.writeFileSync(file, 'after reload');
      await run(query(method));
      expectLastSent(didChange('after reload'), replacement);
      expect(connection.request).not.toHaveBeenCalled();
      if (traversal) {
        expect(stale.error).toMatchObject(againError());
        await expect(service[method](oldItem!)).rejects.toThrow(AGAIN);
      } else if (method === 'prepareCallHierarchy') {
        expect(stale.error).toMatchObject(againError());
      } else if (method === 'diagnostics') {
        expect(stale.error).toEqual(
          new Error('LSP server typescript connection is no longer active'),
        );
      } else {
        expect(stale.error).toBeUndefined();
        expect(stale.result).toEqual(method === 'hover' ? null : []);
      }
    },
  );

  function queryDiagnosticsTool(
    operation: 'diagnostics' | 'workspaceDiagnostics' = 'diagnostics',
    serverName?: string,
  ) {
    return lspTool()
      .build({
        operation,
        ...(operation === 'diagnostics' ? { filePath: file } : {}),
        ...(serverName ? { serverName } : {}),
      })
      .execute(new AbortController().signal);
  }

  it.each(['unsupported change', 'read failure', 'notification failure'])(
    'reports diagnostics synchronization %s through the actual client and tool',
    async (failure) => {
      if (failure === 'unsupported change') {
        handle.textDocumentSync = { openClose: true, change: 0 };
      }
      connection.request.mockResolvedValue({ kind: 'full', items: [] });
      expect((await run(queryDiagnosticsTool())).llmContent).toMatch(
        /^No diagnostics found/,
      );
      connection.request.mockClear();
      fs.writeFileSync(file, 'new');
      let message: string;
      if (failure === 'read failure') {
        fs.unlinkSync(file);
        message = 'ENOENT';
      } else if (failure === 'notification failure') {
        failNextSend();
        message = 'send failed';
      } else {
        message = 'cannot synchronize changed document';
      }
      const result = await run(queryDiagnosticsTool());
      expect(result.llmContent).toMatch(/^LSP diagnostics failed:/);
      expect(result.llmContent).toContain(message);
      expect(result.returnDisplay).toBe(result.llmContent);
      expect(result.llmContent).not.toContain('No diagnostics found');
      expect(connection.request).not.toHaveBeenCalled();
    },
  );

  it.each(['EBUSY', 'ENOENT', 'unsupported change'])(
    'reopens a document after %s before reporting workspace diagnostics',
    async (failure) => {
      if (failure === 'unsupported change')
        handle.textDocumentSync = { openClose: true, change: 0 };
      let serverText: string | undefined;
      connection.send.mockImplementation((message) => {
        const document = (message.params as { textDocument: { text?: string } })
          .textDocument;
        if (message.method === 'textDocument/didOpen')
          serverText = document.text;
        if (message.method === 'textDocument/didClose') serverText = undefined;
        connection.events.push(message.method!);
      });
      connection.request.mockImplementation(async (method) => {
        connection.events.push(method);
        return method === 'workspace/diagnostic'
          ? {
              items:
                serverText === undefined
                  ? []
                  : [
                      {
                        uri,
                        kind: 'full',
                        items: [
                          {
                            range,
                            severity: 1,
                            message: `error in ${serverText}`,
                          },
                        ],
                      },
                    ],
            }
          : { contents: serverText };
      });
      await hover();
      const read = vi.spyOn(fs, 'readFileSync');
      if (failure === 'EBUSY')
        read.mockImplementationOnce(() => {
          throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
        });
      else if (failure === 'ENOENT') fs.unlinkSync(file);
      else fs.writeFileSync(file, 'new');
      try {
        const result = await run(queryDiagnosticsTool('workspaceDiagnostics'));
        expect(result.llmContent).toContain(
          'LSP workspace diagnostics failed:',
        );
        expect(result.llmContent).not.toContain('No diagnostics found');
      } finally {
        read.mockRestore();
      }
      expect(serverText).toBeUndefined();
      expectLastSent(
        expect.objectContaining({ method: 'textDocument/didClose' }),
      );
      fs.writeFileSync(file, 'new');
      connection.events.length = 0;
      const recovered = await run(queryDiagnosticsTool('workspaceDiagnostics'));
      expect(recovered.llmContent).toContain('error in new');
      expect(connection.events).toEqual([
        'textDocument/didOpen',
        'workspace/diagnostic',
      ]);
      expectLastSent(withParams(openParams('new', 2)));
    },
  );

  it.each([false, true])(
    'bounds consecutive read failures and preserves siblings after connection replacement: %s',
    async (replace) => {
      const [, otherUri] = await trackOther();
      const active = replace ? createConnection() : connection;
      handle.connection = active;
      fs.unlinkSync(file);
      await expect(run(service.diagnostics(uri))).rejects.toThrow('ENOENT');
      await expect(run(service.diagnostics(uri))).rejects.toThrow('ENOENT');
      await workspaceDiagnostics();
      expect(
        active.requests.some(({ method }) => method === 'workspace/diagnostic'),
      ).toBe(true);
      expect(active.send).toHaveBeenCalledWith(didOpen('other', 1, otherUri));
      fs.writeFileSync(file, 'restored');
      active.send.mockClear();
      await workspaceDiagnostics();
      expect(active.send).not.toHaveBeenCalled();
      await run(service.diagnostics(uri));
      expect(active.send).toHaveBeenCalledWith(
        didOpen('restored', replace ? 1 : 2),
      );
    },
  );

  it('does not track an unreadable first query', async () => {
    fs.unlinkSync(file);
    await expect(run(service.diagnostics(uri))).rejects.toThrow('ENOENT');
    await workspaceDiagnostics();
    expect(connection.send).not.toHaveBeenCalled();
  });

  it('resets read failures after a successful read even when the reopen send fails', async () => {
    await hover();
    fs.unlinkSync(file);
    await expect(run(service.diagnostics(uri))).rejects.toThrow('ENOENT');
    fs.writeFileSync(file, 'restored');
    failNextSend();
    await expect(run(service.diagnostics(uri))).rejects.toThrow('send failed');
    fs.unlinkSync(file);
    await expect(run(service.diagnostics(uri))).rejects.toThrow('ENOENT');
    fs.writeFileSync(file, 'restored');
    connection.send.mockClear();
    await workspaceDiagnostics();
    expect(connection.send).toHaveBeenCalledWith(didOpen('restored', 2));
  });

  it.each([
    { items: [] },
    { items: [{ range, severity: 1, message: 'first server diagnostic' }] },
  ])(
    'rejects partial diagnostics after an earlier server returned $items',
    async ({ items }) => {
      const secondConnection = createConnection();
      const secondHandle = {
        ...handle,
        connection: secondConnection,
        textDocumentSync: { openClose: true, change: 0 as const },
      };
      useHandles([
        ['test', handle],
        ['second', secondHandle],
      ]);
      connection.request.mockResolvedValue({ kind: 'full', items });
      secondConnection.request.mockResolvedValue({ kind: 'full', items: [] });
      await run(service.diagnostics(uri));
      connection.request.mockClear();
      secondConnection.request.mockClear();
      fs.writeFileSync(file, 'new');
      const result = await run(queryDiagnosticsTool());
      expect(connection.request).toHaveBeenCalledOnce();
      expect(secondConnection.request).not.toHaveBeenCalled();
      expect(result.llmContent).toMatch(/^LSP diagnostics failed:/);
      expect(result.llmContent).toContain(
        'LSP server second cannot synchronize',
      );
      expect(result.llmContent).not.toContain('first server diagnostic');
      expect(result.llmContent).not.toContain('No diagnostics found');
    },
  );

  describe.each([false, true])(
    'workspace diagnostics synchronization with earlier results: %s',
    (withEarlierResults) => {
      it.each(['deleted file', 'notification failure', 'unsupported change'])(
        'rejects %s through the actual client and tool',
        async (failure) => {
          if (failure === 'unsupported change') {
            handle.textDocumentSync = { openClose: true, change: 0 };
          }
          await hover();
          const earlierConnection = createConnection();
          useHandles([
            ['earlier', { ...handle, connection: earlierConnection }],
            ['test', handle],
          ]);
          earlierConnection.request.mockResolvedValue({
            items: withEarlierResults
              ? [
                  {
                    uri,
                    kind: 'full',
                    items: [
                      { range, severity: 1, message: 'earlier diagnostic' },
                    ],
                  },
                ]
              : [],
          });
          connection.request.mockClear();
          fs.writeFileSync(file, 'new');
          let message: string;
          if (failure === 'deleted file') {
            fs.unlinkSync(file);
            message = 'ENOENT';
          } else if (failure === 'notification failure') {
            connection.send.mockImplementation(() => {
              throw new Error('send failed');
            });
            message = 'send failed';
          } else {
            message = 'cannot synchronize changed document';
          }

          await expect(
            run(new NativeLspClient(service).workspaceDiagnostics()),
          ).rejects.toThrow(message);
          // Recreate the failure for the tool after checking recovery independently.
          if (failure !== 'notification failure') {
            if (failure === 'deleted file') fs.writeFileSync(file, 'new');
            await workspaceDiagnostics();
            expect(connection.request).toHaveBeenCalledOnce();
            if (failure === 'deleted file') fs.unlinkSync(file);
            else fs.writeFileSync(file, 'another edit');
            connection.request.mockClear();
          }
          const result = await run(
            queryDiagnosticsTool('workspaceDiagnostics'),
          );
          expect(result.llmContent).toMatch(
            /^LSP workspace diagnostics failed:/,
          );
          expect(result.llmContent).toContain(message);
          expect(result.returnDisplay).toBe(result.llmContent);
          expect(result.llmContent).not.toContain('No diagnostics found');
          expect(result.llmContent).not.toContain('earlier diagnostic');
          expect(connection.request).not.toHaveBeenCalled();
          expect(earlierConnection.request).toHaveBeenCalledTimes(
            failure === 'notification failure' ? 2 : 3,
          );
          if (withEarlierResults) {
            expect(earlierConnection.request).toHaveBeenCalledWith(
              'workspace/diagnostic',
              { previousResultIds: [] },
            );
          }
        },
      );
    },
  );

  it('rejects a failed workspace diagnostics pull instead of reporting clean', async () => {
    await hover();
    const error = new Error('unsupported workspace pull diagnostics');
    connection.request.mockRejectedValue(error);
    await expect(workspaceDiagnostics()).rejects.toThrow(
      'unsupported workspace pull diagnostics',
    );
    expect(logger.warn).toHaveBeenLastCalledWith(
      'LSP workspace/diagnostic failed for test:',
      error,
    );
  });

  it('rejects a failed diagnostics pull instead of reporting clean', async () => {
    const error = new Error('unsupported pull diagnostics');
    connection.request.mockRejectedValue(error);
    await expect(run(service.diagnostics(uri))).rejects.toThrow(
      'unsupported pull diagnostics',
    );
    expect(logger.warn).toHaveBeenLastCalledWith(
      'LSP textDocument/diagnostic failed for test:',
      error,
    );
  });

  it('does not issue a document request on an initial read failure', async () => {
    fs.unlinkSync(file);
    expect(await hover()).toBeNull();
    expect(connection.send).not.toHaveBeenCalled();
    expect(connection.request).not.toHaveBeenCalled();
  });

  it('does not advance state when a change notification throws', async () => {
    await hover();
    connection.request.mockClear();
    fs.writeFileSync(file, 'new');
    failNextSend();
    expect(await hover()).toBeNull();
    expect(connection.request).not.toHaveBeenCalled();
    expect(await hover()).toMatchObject({ contents: 'new' });
    expectLastSent(withParams(changeParams('new')));
  });

  it.each(queryMethods)(
    'skips %s when disk reads fail and retries sync after recovery',
    async (method) => {
      await run(query(method));
      const traversal =
        method === 'incomingCalls' || method === 'outgoingCalls';
      const [oldItem] = traversal ? await prepare() : [];
      connection.request.mockClear();
      fs.unlinkSync(file);
      if (traversal) {
        await expect(service[method](oldItem!)).rejects.toThrow(AGAIN);
        await expect(query(method)).rejects.toThrow();
      } else if (method === 'diagnostics') {
        await expect(query(method)).rejects.toThrow('ENOENT');
      } else {
        await run(query(method));
      }
      expect(connection.request).not.toHaveBeenCalled();
      fs.writeFileSync(file, 'recovered');
      await run(query(method));
      expectLastSent(withParams(openParams('recovered', 2)));
    },
  );
  it('preserves own __proto__ keys in canonical JSON', () => {
    const value = JSON.parse('{"__proto__":{"x":1},"kind":12}');
    expect(Object.hasOwn(sortJsonValue(value) as object, '__proto__')).toBe(
      true,
    );
    expect(JSON.stringify(sortJsonValue(value))).toBe(
      '{"__proto__":{"x":1},"kind":12}',
    );
  });

  it.each(['incomingCalls', 'outgoingCalls'] as const)(
    'signs previously delivered cross-file prepare for %s without a supplemental request',
    async (method) => {
      const [, secondUri] = addFile('decl.ts', 'declaration');
      await hover(secondUri);
      connection.send.mockClear();
      connection.request.mockClear();
      connection.request.mockImplementation(async (name) =>
        name === 'textDocument/prepareCallHierarchy'
          ? [
              {
                name: 'fn',
                kind: 12,
                uri: secondUri,
                range,
                selectionRange: range,
              },
            ]
          : [],
      );
      const [item] = await prepare();
      expect(item?.documentRevision).toEqual(expect.any(String));
      expect(connection.request.mock.calls).toEqual([
        [
          'textDocument/prepareCallHierarchy',
          { textDocument: { uri }, position: range.start },
        ],
      ]);
      // Certifying a result's own file is read-only: the query target's own open
      // is the only notification the signing path may produce.
      expect(
        connection.send.mock.calls.map(([message]) => [
          message.method,
          docUri(message),
        ]),
      ).toEqual([['textDocument/didOpen', uri]]);
      await run<unknown>(service[method](JSON.parse(JSON.stringify(item))));
      expect(connection.request).toHaveBeenLastCalledWith(
        `callHierarchy/${method}`,
        expect.any(Object),
      );
    },
  );

  it.each(['incomingCalls', 'outgoingCalls'] as const)(
    'leaves an unobserved cross-file response unsigned and guides %s recovery',
    async (method) => {
      const [, declUri] = addFile('decl.ts', '\n\nfunction current() {}');
      connection.request.mockImplementation(async (name, params) =>
        name === 'textDocument/prepareCallHierarchy'
          ? [
              {
                name:
                  (params as { textDocument: { uri: string } }).textDocument
                    .uri === declUri
                    ? 'current'
                    : 'old',
                kind: 12,
                uri: declUri,
                range,
                selectionRange: range,
              },
            ]
          : [],
      );
      const [item] = await prepare();
      expect(item?.documentRevision).toBeUndefined();
      expect(connection.send).toHaveBeenCalledOnce();
      expect(connection.send).toHaveBeenCalledWith(didOpen('old'));
      expect(connection.request).toHaveBeenCalledOnce();
      connection.request.mockClear();
      await expect(run<unknown>(service[method](item!))).rejects.toThrow(
        declUri,
      );
      expect(connection.request).not.toHaveBeenCalled();
      const [fresh] = await prepare(declUri);
      expect(fresh?.documentRevision).toEqual(expect.any(String));
      await run<unknown>(service[method](fresh!));
      expect(connection.request).toHaveBeenLastCalledWith(
        `callHierarchy/${method}`,
        expect.any(Object),
      );
    },
  );

  it('names the unobserved file for a delivered-then-closed cross-file item', async () => {
    const [decl, declUri] = addFile('decl.ts', 'declaration');
    // Track decl.ts, then make it unreadable so synchronization closes it while
    // retaining its lifecycle version, then restore it byte-identical.
    await hover(declUri);
    fs.unlinkSync(decl);
    await expect(workspaceDiagnostics()).rejects.toThrow('ENOENT');
    fs.writeFileSync(decl, 'declaration');
    // A prepare rooted at main.ts returns a cross-file item pointing at decl.ts.
    connection.request.mockImplementation(async (name) =>
      name === 'textDocument/prepareCallHierarchy'
        ? [{ name: 'fn', kind: 12, uri: declUri, range, selectionRange: range }]
        : [],
    );
    const [item] = await prepare();
    expect(item?.documentRevision).toBeUndefined();
    connection.request.mockClear();
    // The rejection must name decl.ts (the item's own file) so the model prepares
    // there; a generic stale error only re-syncs main.ts and reproduces the item.
    const error = await service.incomingCalls(item!).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(error?.message).toContain(declUri);
    expect(error?.message).toContain(AGAIN);
    expect(connection.request).not.toHaveBeenCalled();
    // Loop exit: preparing inside decl.ts re-opens it, so traversal then succeeds.
    const [fresh] = await prepare(declUri);
    expect(fresh?.documentRevision).toEqual(expect.any(String));
    await run(service.incomingCalls(fresh!));
  });

  it.each(
    (['incomingCalls', 'outgoingCalls'] as const).flatMap((method) =>
      ['drift', 'delete'].map((change) => ({ method, change })),
    ),
  )(
    'keeps healthy siblings and leaves $change nested $method items unsigned',
    async ({ method, change }) => {
      const [second, secondUri] = addFile('other.ts', 'other');
      await hover(secondUri);
      const [item] = await prepare();
      if (change === 'delete') fs.unlinkSync(second);
      else fs.writeFileSync(second, 'changed');
      const key = method === 'incomingCalls' ? 'from' : 'to';
      connection.request.mockResolvedValueOnce([
        { [key]: { ...item, kind: 12, uri: secondUri }, fromRanges: [range] },
        { [key]: { ...item, kind: 12 }, fromRanges: [range] },
      ]);
      const calls = (await run<unknown>(service[method](item!))) as Array<
        Record<string, LspCallHierarchyItem>
      >;
      expect(calls).toHaveLength(2);
      expect(calls[0]![key]!.documentRevision).toBeUndefined();
      expect(calls[1]![key]!.documentRevision).toEqual(expect.any(String));
    },
  );

  it.each(
    (['incomingCalls', 'outgoingCalls'] as const).flatMap((method) =>
      [0, 2].map((count) => ({ method, count })),
    ),
  )(
    'rejects $method routing with $count ready servers and accepts explicit routing',
    async ({ method, count }) => {
      const [item] = await prepare();
      const second = createConnection();
      useHandles(
        count === 0
          ? []
          : [
              ['test', handle],
              ['second', { ...handle, connection: second }],
            ],
      );
      connection.request.mockClear();
      await expect(
        service[method]({ ...item!, serverName: undefined }),
      ).rejects.toThrow(count === 0 ? 'No LSP servers are configured' : AGAIN);
      expect(connection.request).not.toHaveBeenCalled();
      expect(second.request).not.toHaveBeenCalled();
      if (count === 2) {
        await run<unknown>(service[method](item!, 'test'));
        expect(connection.request).toHaveBeenCalledOnce();
        expect(second.request).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['incomingCalls', 'outgoingCalls'] as const)(
    'gives non-retryable guidance for non-file %s',
    async (method) => {
      const item = {
        name: 'virtual',
        uri: 'jdt://contents/Foo.class',
        range,
        selectionRange: range,
      };
      await expect(service[method](item!)).rejects.toThrow(
        'cannot be traversed',
      );
      await expect(service[method](item!)).rejects.not.toThrow(AGAIN);
      expect(connection.send).not.toHaveBeenCalled();
      expect(connection.request).not.toHaveBeenCalled();
    },
  );

  it.each(
    (
      [
        'hover',
        'definitions',
        'implementations',
        'references',
        'documentSymbols',
        'prepareCallHierarchy',
        'diagnostics',
        'codeActions',
      ] as const
    ).flatMap((method) =>
      [undefined, 'test'].map((serverName) => ({ method, serverName })),
    ),
  )(
    'rejects non-file URIs for $method with server $serverName without reading or notifying',
    async ({ method, serverName }) => {
      const virtualUri = 'jdt://contents/Foo.java?=%2Fsrc';
      const read = vi.spyOn(fs, 'readFileSync');
      try {
        const query =
          method === 'diagnostics' || method === 'documentSymbols'
            ? service[method](virtualUri, serverName)
            : method === 'codeActions'
              ? service.codeActions(
                  virtualUri,
                  range,
                  { diagnostics: [] },
                  serverName,
                )
              : service[method]({ uri: virtualUri, range }, serverName);
        await expect(run<unknown>(query)).rejects.toThrow('not a file URI');
        expect(read).not.toHaveBeenCalled();
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    },
  );

  it.each([undefined, { change: 1 }, { openClose: false, change: 2 }])(
    'does not read discarded target text with sync %j',
    async (sync) => {
      handle.textDocumentSync = sync as LspTextDocumentSync;
      const read = vi.spyOn(fs, 'readFileSync');
      try {
        await hover();
        expect(read).not.toHaveBeenCalled();
        fs.unlinkSync(file);
        await hover();
        expect(connection.request).toHaveBeenCalledTimes(2);
        expect(read).not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
      }
    },
  );

  it.each([1, undefined])(
    'continues workspace symbols after optional warmup read failure with sync %j',
    async (sync) => {
      handle.textDocumentSync = sync as LspTextDocumentSync;
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(directory, 'missing'), file);
      connection.request.mockResolvedValue([]);
      const before = Date.now();
      expect(await run(service.workspaceSymbols('fn'))).toHaveLength(0);
      // A failed warmup must not enable the empty-result retry: one request and no
      // DEFAULT_LSP_WORKSPACE_SYMBOL_WARMUP_DELAY_MS spent on a document never delivered.
      expect(Date.now() - before).toBe(0);
      expect(connection.request).toHaveBeenCalledExactlyOnceWith(
        'workspace/symbol',
        { query: 'fn' },
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('workspace symbol warmup skipped'),
        expect.anything(),
      );
    },
  );

  it('caches successful disk-reading discovery but recovers removed candidates and replacement connections', async () => {
    handle.textDocumentSync = undefined;
    const discovery = spyDiscovery();
    await run(service.workspaceSymbols('fn'));
    await run(service.workspaceSymbols('fn'));
    expect(discovery).toHaveBeenCalledTimes(1);
    fs.unlinkSync(file);
    await run(service.workspaceSymbols('fn'));
    expect(discovery).toHaveBeenCalledTimes(2);
    fs.writeFileSync(file, 'restored');
    await run(service.workspaceSymbols('fn'));
    expect(discovery).toHaveBeenCalledTimes(3);
    handle.connection = createConnection();
    await run(service.workspaceSymbols('fn'));
    expect(discovery).toHaveBeenCalledTimes(4);
    expect(connection.send).not.toHaveBeenCalled();
  });

  it('takes the tracking-server warmed fast path and reopens after replacement', async () => {
    const discovery = spyDiscovery();
    let before = Date.now();
    await run(service.workspaceSymbols('fn'));
    expect(Date.now() - before).toBe(
      DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS +
        2 * DEFAULT_LSP_WORKSPACE_SYMBOL_WARMUP_DELAY_MS,
    );
    connection.request.mockClear();
    connection.send.mockClear();
    before = Date.now();
    await run(service.workspaceSymbols('fn'));
    expect(Date.now() - before).toBe(
      DEFAULT_LSP_WORKSPACE_SYMBOL_WARMUP_DELAY_MS,
    );
    expect(connection.request).toHaveBeenCalledTimes(2);
    expect(connection.send).not.toHaveBeenCalled();
    expect(discovery).toHaveBeenCalledTimes(1);
    const replacement = replaceConnection();
    await run(service.workspaceSymbols('fn'));
    expect(discovery).toHaveBeenCalledTimes(2);
    expect(replacement.send).toHaveBeenCalledOnce();
    expect(replacement.request).toHaveBeenCalledTimes(2);
  });

  it('reports a connection replaced during the symbol warmup delay as not warmed', async () => {
    const pending = service.workspaceSymbols('fn');
    // Advance past the open delay so the warmup delay is the pending await, then
    // replace the connection inside that window.
    await vi.advanceTimersByTimeAsync(DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS);
    const replacement = replaceConnection();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual([]);
    // The replacement received no document, so it must not be reported warm: the
    // empty-result retry is skipped and workspace/symbol is requested exactly once.
    expect(
      replacement.request.mock.calls.filter(
        ([method]) => method === 'workspace/symbol',
      ),
    ).toHaveLength(1);
  });

  it('rediscovers when a cached symbol warmup candidate stops being a file', async () => {
    // openClose:false leaves the warmup candidate untracked, so the warmed fast
    // path does not short-circuit and the cache is revalidated on the next call.
    handle.textDocumentSync = { change: 1 };
    const discovery = spyDiscovery();
    // Only main.ts exists, so the first discovery caches it deterministically
    // (readdir order is not alphabetical; a pre-seeded sibling could win).
    await run(service.workspaceSymbols('fn'));
    expect(discovery).toHaveBeenCalledTimes(1);
    // main.ts becomes a directory of the same name: accessSync(R_OK) still passes
    // for a readable directory, but it is no longer a usable file. other.ts gives
    // the re-run discovery a readable candidate to settle on.
    fs.rmSync(file);
    fs.mkdirSync(file);
    fs.writeFileSync(path.join(directory, 'other.ts'), 'other');
    discovery.mockClear();
    await run(service.workspaceSymbols('fn'));
    expect(discovery).toHaveBeenCalledTimes(1);
  });

  it('drops a cached symbol warmup candidate outside the current workspace roots', async () => {
    handle.textDocumentSync = { change: 1 };
    const discovery = spyDiscovery();
    await run(service.workspaceSymbols('fn'));
    expect(discovery).toHaveBeenCalledTimes(1);
    // A runtime directory removal does not replace the connection, so the WeakMap
    // entry survives and must be revalidated against the current roots.
    const secondRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-root-')),
    );
    fs.writeFileSync(path.join(secondRoot, 'other.ts'), 'other');
    (
      service as unknown as { workspaceContext: WorkspaceContext }
    ).workspaceContext = {
      getDirectories: () => [secondRoot],
    } as unknown as WorkspaceContext;
    discovery.mockClear();
    await run(service.workspaceSymbols('fn'));
    // main.ts is still a readable file but no longer under a workspace root, so
    // the stale entry is dropped and discovery re-runs inside the remaining root.
    expect(discovery).toHaveBeenCalledTimes(1);
    fs.rmSync(secondRoot, { recursive: true, force: true });
  });

  it.each([1, { openClose: true, change: 0 }])(
    'settles already-current TypeScript warmup without unsupported warning %j',
    async (sync) => {
      handle.textDocumentSync = sync as LspTextDocumentSync;
      await hover();
      useTypescriptManager();
      const before = Date.now();
      await run(service.workspaceSymbols('fn'));
      expect(Date.now() - before).toBe(DEFAULT_LSP_WARMUP_DELAY_MS);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(handle.warmedUp).toBe(true);
      expect(connection.send).toHaveBeenCalledOnce();
    },
  );

  it.each([{ openClose: true, change: 0 }, { openClose: true }])(
    'latches unsupported forced unchanged No Project warmup %j',
    async (sync) => {
      useTypescriptManager();
      handle.textDocumentSync = sync as LspTextDocumentSync;
      await run(service.workspaceSymbols('fn'));
      connection.request.mockResolvedValueOnce({ message: 'No Project' });
      await run(service.workspaceSymbols('fn'));
      expect(connection.request).toHaveBeenCalledTimes(3);
      expect(connection.send).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('warm-up delivered no notification'),
      );
      expect(handle.warmedUp).toBe(true);
    },
  );

  it('retries genuine TypeScript callback failures instead of latching them', async () => {
    useTypescriptManager();
    failNextSend();
    await run(service.workspaceSymbols('fn'));
    expect(handle.warmedUp).not.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'TypeScript server warm-up failed:',
      expect.any(Error),
    );
    await run(service.workspaceSymbols('fn'));
    expect(handle.warmedUp).toBe(true);
    expect(connection.send).toHaveBeenCalledTimes(2);
  });

  it.each(['read', 'unsupported'])(
    'closes %s failures and never revives old same-text hierarchy tokens',
    async (failure) => {
      if (failure === 'unsupported')
        handle.textDocumentSync = { openClose: true, change: 0 };
      const [item] = await prepare();
      if (failure === 'read') fs.unlinkSync(file);
      else fs.writeFileSync(file, 'changed');
      await expect(workspaceDiagnostics()).rejects.toThrow();
      expectLastSent({
        jsonrpc: '2.0',
        method: 'textDocument/didClose',
        params: { textDocument: { uri } },
      });
      fs.writeFileSync(file, 'old');
      const [fresh] = await prepare();
      expect(fresh?.documentRevision).not.toBe(item?.documentRevision);
      expectLastSent(didOpen('old', 2));
      await expect(service.incomingCalls(item!)).rejects.toThrow(AGAIN);
      await run(service.incomingCalls(fresh!));
    },
  );

  it.each(['recover', 'replace'])(
    'retries failed closes without duplicate opens then %s',
    async (action) => {
      const [item] = await prepare();
      fs.unlinkSync(file);
      const send = connection.send.getMockImplementation()!;
      connection.send.mockImplementation((message) => {
        if (message.method === 'textDocument/didClose')
          throw new Error('close failed');
        send(message);
      });
      await expect(workspaceDiagnostics()).rejects.toThrow('ENOENT');
      fs.writeFileSync(file, 'old');
      await expect(workspaceDiagnostics()).rejects.toThrow(
        /still cannot close/,
      );
      expect(await hover()).toBeNull();
      expect(
        connection.send.mock.calls.filter(
          ([message]) => message.method === 'textDocument/didOpen',
        ),
      ).toHaveLength(1);
      expect(openedDocuments().get('test')?.has(uri)).toBeFalsy();
      if (action === 'recover') connection.send.mockImplementation(send);
      else handle.connection = createConnection();
      await workspaceDiagnostics();
      await hover();
      await expect(service.incomingCalls(item!)).rejects.toThrow(AGAIN);
      if (action === 'replace')
        expect(handle.connection!.send).not.toHaveBeenCalledWith(
          expect.objectContaining({ method: 'textDocument/didClose' }),
        );
    },
  );

  it('settles all workspace reopened documents once but not ordinary changes', async () => {
    const [other] = await trackOther();
    const replacement = replaceConnection();
    const sentAt: number[] = [];
    const requestedAt: number[] = [];
    const send = replacement.send.getMockImplementation()!;
    replacement.send.mockImplementation((message) => {
      sentAt.push(Date.now());
      send(message);
    });
    replacement.request.mockImplementation(async () => {
      requestedAt.push(Date.now());
      return { items: [] };
    });
    const before = Date.now();
    await workspaceDiagnostics();
    expect(replacement.send).toHaveBeenCalledTimes(2);
    expect(Date.now() - before).toBe(DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS);
    expect(requestedAt[0]! - sentAt[1]!).toBe(
      DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS,
    );
    expect(replacement.request).toHaveBeenCalledOnce();
    fs.writeFileSync(file, 'new');
    fs.writeFileSync(other, 'new');
    const changed = Date.now();
    await workspaceDiagnostics();
    expect(Date.now() - changed).toBe(0);
    expect(replacement.send).toHaveBeenCalledTimes(4);
    expect(requestedAt[1]! - sentAt[3]!).toBe(0);
  });

  it('delivers workspace survivors before rejecting an unreadable tracked file', async () => {
    // Track main.ts first, then other.ts, so main.ts is the first-tracked URI.
    const [, otherUri] = await trackOther();
    fs.unlinkSync(file);
    const replacement = replaceConnection();
    await expect(workspaceDiagnostics()).rejects.toThrow('ENOENT');
    // The survivor must still reach the replacement connection even though the
    // first-tracked file aborted its own sync; without per-URI isolation the
    // throw strands every URI queued behind it and the sweep reports clean.
    expect(
      replacement.send.mock.calls.map(([message]) => [
        message.method,
        docUri(message),
      ]),
    ).toEqual([['textDocument/didOpen', otherUri]]);
    // A second sweep must still track the survivor rather than strand it.
    await expect(workspaceDiagnostics()).rejects.toThrow('ENOENT');
    await workspaceDiagnostics();
    expect(openedDocuments().get('test')?.has(otherUri)).toBe(true);
  });

  it('replays every tracked document after a TypeScript crash restart', async () => {
    useTypescriptManager();
    // Pin the warmup candidate so the assertion cannot be satisfied by the warmup
    // opening the file the durable replay set is also expected to re-deliver.
    vi.spyOn(
      manager as unknown as { findFirstTypescriptFile(): string | undefined },
      'findFirstTypescriptFile',
    ).mockReturnValue(file);
    const [, otherUri] = await trackOther();
    // Simulate an in-place crash restart: a new connection on the same handle and
    // a cleared warmup latch, without notifying the service.
    const replacement = replaceConnection();
    // An ordinary query after the restart parks the pre-swap URIs in the durable
    // set and re-opens only its own target; the sweep must replay the rest from there.
    await hover();
    handle.warmedUp = false;
    await workspaceDiagnostics();
    // The warmup's own connection-change reset must not wipe the tracked set: both
    // previously tracked URIs reach the replacement before workspace/diagnostic is issued.
    expect(new Set(openedUris(replacement))).toEqual(new Set([uri, otherUri]));
    expect(replacement.events.indexOf('workspace/diagnostic')).toBeGreaterThan(
      replacement.events.lastIndexOf('textDocument/didOpen'),
    );
  });

  it('replays tracked documents wiped by an earlier query on a replaced connection', async () => {
    const [, otherUri] = await trackOther();
    const replacement = replaceConnection();
    // An ordinary non-TypeScript workspaceSymbol query on the replaced connection
    // triggers the connection-change reset; the replay set must survive it so a
    // later workspaceDiagnostics still re-opens both documents.
    await run(service.workspaceSymbols('fn'));
    await workspaceDiagnostics();
    expect(new Set(openedUris(replacement))).toEqual(new Set([uri, otherUri]));
  });

  it('re-delivers a URI whose first send failed on a replaced connection', async () => {
    await trackOther();
    const replacement = replaceConnection();
    // The replacement connection's first didOpen throws once: the reset inside
    // workspaceDiagnostics must park the wiped URIs for the next sweep.
    failNextSend('write EPIPE', replacement);
    await expect(workspaceDiagnostics()).rejects.toThrow('write EPIPE');
    const afterFirst = replacement.send.mock.calls.length;
    await workspaceDiagnostics();
    expect(
      replacement.send.mock.calls
        .slice(afterFirst)
        .map(([message]) => [message.method, docUri(message)]),
    ).toEqual([['textDocument/didOpen', uri]]);
  });

  it('evicts a never-delivered unreadable URI so later sweeps resolve', async () => {
    const [, otherUri] = await trackOther();
    const replacement = replaceConnection();
    // An ordinary query parks both pre-swap URIs, then only its own target is
    // delivered; the unreadable one must be evicted instead of wedging every sweep.
    await hover(otherUri);
    fs.unlinkSync(file);
    await expect(workspaceDiagnostics()).rejects.toThrow('ENOENT');
    await expect(workspaceDiagnostics()).rejects.toThrow('ENOENT');
    await workspaceDiagnostics();
    expect(replacement.requests.map(({ method }) => method)).toContain(
      'workspace/diagnostic',
    );
  });

  it('rejects workspace connection replacement during reopen settling', async () => {
    await hover();
    const replacement = replaceConnection();
    const pending = caught(service.workspaceDiagnostics());
    await vi.advanceTimersByTimeAsync(0);
    expect(replacement.send).toHaveBeenCalledOnce();
    const third = createConnection();
    handle.connection = third;
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(Error);
    expect(replacement.request).not.toHaveBeenCalled();
    expect(third.request).not.toHaveBeenCalled();
  });

  it.each([1, undefined])(
    'bounds hierarchy reads per checkpoint not per result with sync %j',
    async (sync) => {
      handle.textDocumentSync = sync as LspTextDocumentSync;
      fs.writeFileSync(file, 'x'.repeat(300 * 1024));
      const [item] = await prepare();
      connection.request.mockResolvedValueOnce(
        Array.from({ length: 20 }, (_, index) => ({
          from: { ...item, name: `fn${index}`, kind: 12 },
          fromRanges: [range],
        })),
      );
      const read = vi.spyOn(fs, 'readFileSync');
      const hash = vi.spyOn(crypto, 'createHash');
      const hmac = vi.spyOn(crypto, 'createHmac');
      try {
        const calls = await run(service.incomingCalls(item!));
        expect(hash).toHaveBeenCalledTimes(sync === 1 ? 0 : 1);
        expect(hmac).toHaveBeenCalledTimes(23);
        expect(calls).toHaveLength(20);
        expect(
          calls.every((call) => typeof call.from.documentRevision === 'string'),
        ).toBe(true);
        expect(
          read.mock.calls.filter(([target]) => target === file),
        ).toHaveLength(3);
      } finally {
        read.mockRestore();
        hash.mockRestore();
        hmac.mockRestore();
      }
    },
  );
  it.each(['incomingCalls', 'outgoingCalls'] as const)(
    'fails loudly when the %s test helper cannot prepare',
    async (method) => {
      connection.request.mockResolvedValue([]);
      await expect(run(query(method))).rejects.toThrow(
        `prepareCallHierarchy returned no item for ${method}`,
      );
      expect(
        connection.request.mock.calls.every(
          ([name]) => name === 'textDocument/prepareCallHierarchy',
        ),
      ).toBe(true);
    },
  );

  it.each(['incomingCalls', 'outgoingCalls'] as const)(
    'invalidates in-flight %s on same-text close and reopen',
    async (method) => {
      const [item] = await prepare();
      const respond = deferNextRequest();
      const pending = caught(service[method](item!));
      await vi.runAllTimersAsync();
      fs.unlinkSync(file);
      await expect(workspaceDiagnostics()).rejects.toThrow('ENOENT');
      fs.writeFileSync(file, 'old');
      await hover();
      respond([]);
      expect(await pending).toMatchObject(againError());
    },
  );

  it.each(['incomingCalls', 'outgoingCalls'] as const)(
    'reobserves root across %s warmup awaits',
    async (method) => {
      const [item] = await prepare();
      useTypescriptManager();
      const pending = caught(service[method](item!));
      await vi.advanceTimersByTimeAsync(0);
      fs.writeFileSync(file, 'changed during warmup');
      connection.request.mockClear();
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject(againError());
      expect(connection.request).not.toHaveBeenCalled();
    },
  );

  it('does not certify unreadable cross-file prepare items or lose healthy siblings', async () => {
    const missing = pathToFileURL(
      path.join(directory, 'missing.ts'),
    ).toString();
    connection.request.mockResolvedValue([
      { name: 'missing', kind: 12, uri: missing, range, selectionRange: range },
      { name: 'root', kind: 12, uri, range, selectionRange: range },
    ]);
    const items = await prepare();
    expect(items).toHaveLength(2);
    expect(items[0]!.documentRevision).toBeUndefined();
    expect(items[1]!.documentRevision).toEqual(expect.any(String));
    expect(connection.request).toHaveBeenCalledOnce();
  });

  it('keeps other URI and server versions independent during close cleanup', async () => {
    const [other, otherUri] = addFile('other.ts', 'other');
    const second = createConnection();
    useHandles([
      ['test', handle],
      ['second', { ...handle, connection: second }],
    ]);
    await hover(uri, 'test');
    await hover(otherUri, 'test');
    await hover(otherUri, 'second');
    fs.unlinkSync(file);
    await expect(run(service.workspaceDiagnostics('test'))).rejects.toThrow(
      'ENOENT',
    );
    fs.writeFileSync(other, 'changed');
    await expect(workspaceDiagnostics()).rejects.toThrow('ENOENT');
    await workspaceDiagnostics();
    for (const target of [connection, second])
      expectLastSent(didChange('changed', 2, otherUri), target);
    expect(second.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'textDocument/didClose' }),
    );
  });
  it('retries a genuine forced No Project warmup failure without a warm latch', async () => {
    useTypescriptManager();
    await run(service.workspaceSymbols('fn'));
    connection.request.mockResolvedValueOnce({ message: 'No Project' });
    failNextSend('forced send failed');
    await run(service.workspaceSymbols('fn'));
    expect(handle.warmedUp).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      'TypeScript server warm-up failed:',
      expect.objectContaining({ message: 'forced send failed' }),
    );
    const before = Date.now();
    await run(service.workspaceSymbols('fn'));
    expect(Date.now() - before).toBe(DEFAULT_LSP_WARMUP_DELAY_MS);
    expect(handle.warmedUp).toBe(true);
  });

  describe('diagnostics failure visibility', () => {
    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'rejects at the service layer when every %s pull fails',
      async (operation) => {
        connection.request.mockRejectedValue(new Error('server exploded'));
        await expect(
          operation === 'diagnostics'
            ? run(service.diagnostics(uri))
            : run(service.workspaceDiagnostics()),
        ).rejects.toThrow('server exploded');
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'reports a rejected %s pull as a tool error, not a clean result',
      async (operation) => {
        connection.request.mockRejectedValue(new Error('server exploded'));
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error?.message).toContain('server exploded');
        expect(result.llmContent).not.toContain('No diagnostics found');
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'reports %s as a tool error when no server is ready',
      async (operation) => {
        // A FAILED handle whose admission path recorded no cause must render
        // as the bare state — the test must describe what the service
        // actually renders, not hand-set a cause production never recorded.
        handle.status = 'FAILED';
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        // The state word, not the tool's `LSP diagnostics failed:` prefix.
        expect(result.error?.message).toContain('test is failed');
        expect(result.llmContent).not.toContain('No diagnostics found');
        expect(connection.request).not.toHaveBeenCalled();
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'renders the cause the manager recorded for a failed server in %s',
      async (operation) => {
        // Mirrors what doStartServer records on the command-not-found
        // admission path (pinned in lsp-server-manager.test.ts).
        handle.status = 'FAILED';
        handle.error = new Error('command not found: test-server');
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error?.message).toContain('test is failed');
        expect(result.error?.message).toContain(
          'command not found: test-server',
        );
        expect(result.llmContent).not.toContain('No diagnostics found');
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'names a starting server as pending for %s instead of reporting clean',
      async (operation) => {
        handle.status = 'IN_PROGRESS';
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error?.message).toContain('in progress');
        expect(result.llmContent).not.toContain('No diagnostics found');
        expect(connection.request).not.toHaveBeenCalled();
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'still displays a successful empty %s report as clean',
      async (operation) => {
        connection.request.mockResolvedValue({ kind: 'full', items: [] });
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toBeUndefined();
        expect(result.llmContent).toMatch(/^No diagnostics found/);
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'keeps a valid %s diagnostic with an empty-string message',
      async (operation) => {
        const emptyMessageDiagnostic = { range, severity: 1, message: '' };
        mockDiagnosticsResponses(connection, [emptyMessageDiagnostic]);
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toBeUndefined();
        expect(result.llmContent).toContain('1 issues');
        expect(result.llmContent).not.toContain('No diagnostics found');
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'keeps partial %s results when another server fails',
      async (operation) => {
        const healthyConnection = createConnection();
        mockDiagnosticsResponses(healthyConnection, [
          { range, severity: 2, message: 'real warning' },
        ]);
        withServers([
          ['test', handle],
          [
            'healthy',
            {
              ...handle,
              config: { ...handle.config, name: 'healthy' },
              connection: healthyConnection,
            },
          ],
        ]);
        connection.request.mockRejectedValue(new Error('server exploded'));
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toBeUndefined();
        expect(result.llmContent).toContain('real warning');
      },
    );

    /** Swap in an explicit server map so a test can drive two servers. */
    function withServers(servers: Array<[string, LspServerHandle]>) {
      (service as unknown as { serverManager: unknown }).serverManager = {
        getHandles: () => new Map(servers),
        warmupTypescriptServer: vi.fn(),
        isTypescriptServer: () => false,
      };
    }

    /**
     * Answer every diagnostics pull on the connection with a report carrying
     * the given items (wrapped in a file entry for a workspace pull).
     */
    function mockDiagnosticsResponses(
      target: ReturnType<typeof createConnection>,
      items: unknown[] = [],
    ) {
      target.request.mockImplementation(async (method: string) =>
        method === 'workspace/diagnostic'
          ? { items: items.length ? [{ uri, kind: 'full', items }] : [] }
          : { kind: 'full', items },
      );
    }

    /** A READY server that answers every pull with a valid empty report. */
    function emptyReportHandle(name: string): LspServerHandle {
      const emptyConnection = createConnection();
      mockDiagnosticsResponses(emptyConnection);
      return {
        ...handle,
        config: { ...handle.config, name },
        connection: emptyConnection,
      };
    }

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'reports a failed %s pull when the surviving server retrieves nothing',
      async (operation) => {
        withServers([
          ['test', handle],
          ['healthy', emptyReportHandle('healthy')],
        ]);
        connection.request.mockRejectedValue(new Error('server exploded'));
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error?.message).toContain('server exploded');
        expect(result.llmContent).not.toContain('No diagnostics found');
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'names a server that was never queried when %s retrieves nothing',
      async (operation) => {
        mockDiagnosticsResponses(connection);
        const pendingHandle: LspServerHandle = {
          ...handle,
          config: { ...handle.config, name: 'pyright' },
          status: 'IN_PROGRESS',
          connection: undefined,
        };
        withServers([
          ['test', handle],
          ['pyright', pendingHandle],
        ]);
        const result = await run(queryDiagnosticsTool(operation));
        // The ready server was queried; the pending one is named, not dropped.
        expect(connection.request).toHaveBeenCalled();
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error?.message).toContain('pyright is in progress');
        expect(result.llmContent).not.toContain('No diagnostics found');
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'rejects %s when a connection answers with no response',
      async (operation) => {
        // `sendRequest` resolves `undefined` once disposed instead of
        // rejecting, and a JSON-RPC success can carry `result: null`; both
        // leave the handle looking READY and answerable.
        for (const response of [undefined, null]) {
          connection.request.mockResolvedValue(response);
          await expect(
            operation === 'diagnostics'
              ? run(service.diagnostics(uri))
              : run(service.workspaceDiagnostics()),
          ).rejects.toThrow('server returned no response');
        }
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'rejects %s when every reported item fails normalization',
      async (operation) => {
        // A severity-1 finding without a range cannot be normalized; dropping
        // it must not certify the file clean. The workspace twin drops a file
        // report that carries no uri.
        connection.request.mockImplementation(async (method: string) =>
          method === 'workspace/diagnostic'
            ? {
                items: [
                  {
                    kind: 'full',
                    items: [{ range, severity: 1, message: 'Type error' }],
                  },
                ],
              }
            : {
                kind: 'full',
                items: [{ severity: 1, message: 'Type error' }],
              },
        );
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error?.message).toContain('unusable');
        expect(result.llmContent).not.toContain('No diagnostics found');
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'caps a huge %s rejection message instead of flooding the tool result',
      async (operation) => {
        // Two failing servers: per-entry caps alone leave the aggregate
        // unbounded, so the join must shrink entries to a shared budget
        // without dropping a server name.
        const secondConnection = createConnection();
        secondConnection.request.mockRejectedValue(new Error('y'.repeat(5000)));
        withServers([
          ['test', handle],
          [
            'healthy',
            {
              ...handle,
              config: { ...handle.config, name: 'healthy' },
              connection: secondConnection,
            },
          ],
        ]);
        connection.request.mockRejectedValue(new Error('x'.repeat(5000)));
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        // getErrorMessage caps each entry's detail; the rendered message
        // must stay bounded even with the wrapper text around it.
        expect(result.error!.message.length).toBeLessThan(1100);
        expect(result.error!.message).toContain('test:');
        expect(result.error!.message).toContain('healthy:');
        expect(result.llmContent).not.toContain('x'.repeat(1001));
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'caps a huge cause in the %s rejection when no server is ready',
      async (operation) => {
        // A FAILED handle records its cause, and the render must bound it:
        // 8 KB of message cannot reach the tool result verbatim.
        handle.status = 'FAILED';
        handle.connection = undefined;
        handle.error = new Error('y'.repeat(8192));
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error!.message.length).toBeLessThan(1100);
        expect(result.llmContent).not.toContain('y'.repeat(1001));
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'keeps the %s rejection bounded when many servers fail at once',
      async (operation) => {
        // Thirty failing servers: per-entry caps leave a 30 KB join, so the
        // aggregate budget must divide what the separators leave — without
        // dropping a server name.
        const servers: Array<[string, LspServerHandle]> = [['test', handle]];
        connection.request.mockRejectedValue(new Error('x'.repeat(5000)));
        for (let i = 0; i < 29; i++) {
          const failing = createConnection();
          failing.request.mockRejectedValue(new Error('y'.repeat(5000)));
          servers.push([
            `extra-${i}`,
            {
              ...handle,
              config: { ...handle.config, name: `extra-${i}` },
              connection: failing,
            },
          ]);
        }
        withServers(servers);
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error!.message.length).toBeLessThan(1100);
        expect(result.error!.message).toContain('extra-28');
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'keeps the %s no-server-ready rejection bounded over many failed servers',
      async (operation) => {
        // Thirty FAILED handles each carrying an 8 KB cause: the skipped
        // join answers to the same aggregate budget as the failures join.
        withServers(
          Array.from({ length: 30 }, (_, i): [string, LspServerHandle] => [
            `down-${i}`,
            {
              ...handle,
              config: { ...handle.config, name: `down-${i}` },
              status: 'FAILED',
              connection: undefined,
              error: new Error('y'.repeat(8192)),
            },
          ]),
        );
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error!.message.length).toBeLessThan(1100);
        expect(result.error!.message).toContain('down-29');
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'caps a huge cause rendered for a failed server in %s',
      async (operation) => {
        // The skipped arm renders the recorded cause next to the failures
        // arm; an 8 KB message must not reach the tool result whole.
        mockDiagnosticsResponses(connection);
        const crashedHandle: LspServerHandle = {
          ...handle,
          config: { ...handle.config, name: 'crashed' },
          status: 'FAILED',
          connection: undefined,
          error: new Error('x'.repeat(8192)),
        };
        withServers([
          ['test', handle],
          ['crashed', crashedHandle],
        ]);
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error!.message.length).toBeLessThan(1100);
        expect(result.error!.message).toContain('crashed is failed');
        expect(result.llmContent).not.toContain('x'.repeat(201));
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'keeps the cause chain of a rejected %s pull',
      async (operation) => {
        connection.request.mockRejectedValue(
          new Error('outer', { cause: new Error('inner root cause') }),
        );
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error?.message).toContain('(cause: inner root cause)');
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'names every failing server when all %s pulls fail',
      async (operation) => {
        const secondConnection = createConnection();
        secondConnection.request.mockRejectedValue(
          new Error('second exploded'),
        );
        withServers([
          ['test', handle],
          [
            'healthy',
            {
              ...handle,
              config: { ...handle.config, name: 'healthy' },
              connection: secondConnection,
            },
          ],
        ]);
        connection.request.mockRejectedValue(new Error('first exploded'));
        await expect(
          operation === 'diagnostics'
            ? run(service.diagnostics(uri))
            : run(service.workspaceDiagnostics()),
        ).rejects.toThrow(/test: first exploded; healthy: second exploded/);
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'names every unreachable server when %s retrieves nothing',
      async (operation) => {
        mockDiagnosticsResponses(connection);
        const failedHandle: LspServerHandle = {
          ...handle,
          config: { ...handle.config, name: 'failedone' },
          status: 'FAILED',
          connection: undefined,
        };
        const pendingHandle: LspServerHandle = {
          ...handle,
          config: { ...handle.config, name: 'pendingtwo' },
          status: 'IN_PROGRESS',
          connection: undefined,
        };
        withServers([
          ['test', handle],
          ['failedone', failedHandle],
          ['pendingtwo', pendingHandle],
        ]);
        const result = await run(queryDiagnosticsTool(operation));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error?.message).toContain('failedone is failed');
        expect(result.error?.message).toContain('pendingtwo is in progress');
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'rejects a %s query naming a server that is not configured',
      async (operation) => {
        await expect(
          operation === 'diagnostics'
            ? run(service.diagnostics(uri, 'missing'))
            : run(service.workspaceDiagnostics('missing')),
        ).rejects.toThrow(
          'No LSP server named missing is configured or running',
        );
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'does not name other servers as skipped for a server-scoped %s query',
      async (operation) => {
        mockDiagnosticsResponses(connection);
        const pendingHandle: LspServerHandle = {
          ...handle,
          config: { ...handle.config, name: 'pyright' },
          status: 'IN_PROGRESS',
          connection: undefined,
        };
        withServers([
          ['test', handle],
          ['pyright', pendingHandle],
        ]);
        const result = await run(queryDiagnosticsTool(operation, 'test'));
        expect(result.error).toBeUndefined();
        expect(result.llmContent).toMatch(/^No diagnostics found/);
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'does not let a server that cannot own the file veto a clean %s answer',
      async (operation) => {
        mockDiagnosticsResponses(connection);
        const failedPythonHandle: LspServerHandle = {
          ...handle,
          config: {
            ...handle.config,
            name: 'pyright',
            languages: ['python'],
          },
          status: 'FAILED',
          connection: undefined,
          error: new Error('command not found: pyright-langserver'),
        };
        withServers([
          ['test', handle],
          ['pyright', failedPythonHandle],
        ]);
        const result = await run(queryDiagnosticsTool(operation));
        if (operation === 'diagnostics') {
          // pyright could never own main.ts, so the ready server's
          // authoritative empty report stands.
          expect(result.error).toBeUndefined();
          expect(result.llmContent).toMatch(/^No diagnostics found/);
        } else {
          // A workspace report would silently certify pyright's slice clean.
          expect(result.error).toMatchObject({
            type: ToolErrorType.EXECUTION_FAILED,
          });
          expect(result.error?.message).toContain('pyright is failed');
        }
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'asks a server that became ready during the %s query before deciding',
      async (operation) => {
        const lateConnection = createConnection();
        mockDiagnosticsResponses(lateConnection, [
          { range, severity: 1, message: 'late report' },
        ]);
        const lateHandle: LspServerHandle = {
          ...handle,
          config: { ...handle.config, name: 'late' },
          status: 'IN_PROGRESS',
          connection: undefined,
        };
        withServers([
          ['test', handle],
          ['late', lateHandle],
        ]);
        connection.request.mockImplementation(async (method: string) => {
          // The pending server finishes starting while the ready server
          // answers, so the pre-loop snapshot is stale by the decision point.
          lateHandle.status = 'READY';
          lateHandle.connection = lateConnection;
          return method === 'workspace/diagnostic'
            ? { items: [] }
            : { kind: 'full', items: [] };
        });
        const result = await run(queryDiagnosticsTool(operation));
        // The startup race must not discard that server's slice: it is asked
        // before the gate reads the unreachable list, so its report backs the
        // result instead of vetoing as a server that was never asked.
        expect(lateConnection.request).toHaveBeenCalledWith(
          operation === 'workspaceDiagnostics'
            ? 'workspace/diagnostic'
            : 'textDocument/diagnostic',
          expect.anything(),
        );
        expect(result.error).toBeUndefined();
        expect(result.llmContent).toContain('late report');
      },
    );

    it.each(['diagnostics', 'workspaceDiagnostics'] as const)(
      'rejects %s when a connection answers an unusable report shape',
      async (operation) => {
        // A non-null response that is not an object carrying an `items`
        // array answered nothing usable and must not be certified clean.
        for (const response of [
          {},
          [],
          { items: null },
          { kind: 'unchanged' },
          42,
          'a bare string',
        ]) {
          connection.request.mockResolvedValue(response);
          const result = await run(queryDiagnosticsTool(operation));
          expect(result.error).toMatchObject({
            type: ToolErrorType.EXECUTION_FAILED,
          });
          expect(result.error?.message).toContain(
            'server returned an unusable diagnostic report',
          );
          expect(result.llmContent).not.toContain('No diagnostics found');
        }
      },
    );

    it.each([
      {
        scenario: 'an extensionless file',
        file: 'Dockerfile',
        languages: ['dockerfile'],
      },
      {
        scenario: 'a language ID that is not the file extension',
        file: 'main.rs',
        languages: ['rust'],
      },
    ])(
      'lets a failed server veto a clean answer for $scenario',
      async ({ file: name, languages }) => {
        // Row one is an extensionless file: nothing can be attributed there,
        // so no relevance test can excuse the failed server. Row two's `rust`
        // alias row places `rs` and positively owns main.rs, so its failure is
        // a relevant one that must veto. Either way the ready server's empty
        // report must not stand alone.
        addFile(name, 'content');
        mockDiagnosticsResponses(connection);
        const failedHandle: LspServerHandle = {
          ...handle,
          config: { ...handle.config, name: 'failed', languages },
          status: 'FAILED',
          connection: undefined,
        };
        withServers([
          ['test', handle],
          ['failed', failedHandle],
        ]);
        const tool = lspTool();
        const result = await run(
          tool
            .build({
              operation: 'diagnostics',
              filePath: path.join(directory, name),
            })
            .execute(new AbortController().signal),
        );
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error?.message).toContain('failed is failed');
        expect(result.llmContent).not.toContain('No diagnostics found');
      },
    );

    it('lets a failed server veto a clean answer its partial extension mapping hid', async () => {
      // extensionToLanguage covering only .tsx must not hide the declared
      // `typescript` language, which still owns the queried .ts file.
      mockDiagnosticsResponses(connection);
      const failedHandle: LspServerHandle = {
        ...handle,
        config: {
          ...handle.config,
          name: 'failed',
          languages: ['typescript'],
          extensionToLanguage: { '.tsx': 'typescriptreact' },
        },
        status: 'FAILED',
        connection: undefined,
      };
      withServers([
        ['test', handle],
        ['failed', failedHandle],
      ]);
      const result = await run(queryDiagnosticsTool('diagnostics'));
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain('failed is failed');
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it("does not let an irrelevant server's failed pull veto a clean document answer", async () => {
      // A ready python server that rejects textDocument/diagnostic (e.g. it
      // never implemented pull diagnostics) says nothing about main.ts; the
      // typescript server's authoritative empty report stands.
      mockDiagnosticsResponses(connection);
      const failingConnection = createConnection();
      failingConnection.request.mockRejectedValue(
        new Error('method not found'),
      );
      withServers([
        ['test', handle],
        [
          'pyright',
          {
            ...handle,
            config: {
              ...handle.config,
              name: 'pyright',
              languages: ['python'],
            },
            connection: failingConnection,
          },
        ],
      ]);
      const result = await run(queryDiagnosticsTool('diagnostics'));
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toMatch(/^No diagnostics found/);
    });

    /** A READY server named `name`, serving `languages`, on connection `target`. */
    function serverOn(
      name: string,
      languages: string[],
      target: ReturnType<typeof createConnection>,
      extra?: Partial<LspServerHandle['config']>,
    ): LspServerHandle {
      return {
        ...handle,
        config: { ...handle.config, name, languages, ...extra },
        connection: target,
      };
    }

    /** A connection that refuses every request with JSON-RPC error `code`. */
    function refusingConnection(
      code: number,
      method = 'textDocument/diagnostic',
    ): ReturnType<typeof createConnection> {
      const target = createConnection();
      target.request.mockRejectedValue(
        new LspJsonRpcError(`Unhandled method ${method}`, code),
      );
      return target;
    }

    it('keeps a clean Go file a push-only TypeScript sibling answers -32601 for', async () => {
      // gopls serves textDocument/diagnostic without advertising it, while
      // typescript-language-server answers -32601. `.go` is placeable, and the
      // refusal lands in `unsupported`, which never vetoes a sibling's answer;
      // gopls's own answer then positively owns `.go`, so the clean file stays
      // clean instead of reading as a tool error naming a server that never
      // could have owned it.
      const [goPath] = addFile('main.go', 'package main\n');
      const gopls = createConnection();
      mockDiagnosticsResponses(gopls);
      withServers([
        ['go', serverOn('gopls', ['go'], gopls)],
        [
          'typescript',
          serverOn(
            'typescript-language-server',
            ['typescript'],
            refusingConnection(-32601),
          ),
        ],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: goPath,
      });
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toMatch(/^No diagnostics found/);
    });

    it('keeps a clean TypeScript file from the pull-capable of two TS servers', async () => {
      // Both servers declare `typescript`, so both really could own clean.ts
      // and no relevance test excuses either. Only the -32601 reply stops the
      // push-only server from vetoing its sibling's authoritative empty report.
      const [cleanPath] = addFile('clean.ts', 'export const value = 1;\n');
      const tsgo = createConnection();
      mockDiagnosticsResponses(tsgo);
      withServers([
        ['tsgo', serverOn('tsgo', ['typescript'], tsgo)],
        ['tsls', serverOn('tsls', ['typescript'], refusingConnection(-32601))],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: cleanPath,
      });
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toMatch(/^No diagnostics found/);
    });

    it('keeps a clean workspace report from the pull-capable of two servers', async () => {
      // `workspace/diagnostic` is optional, so a push-only server answers
      // -32601 for it; that refusal says nothing about the workspace and
      // cannot veto its sibling's authoritative empty report.
      const tsgo = createConnection();
      mockDiagnosticsResponses(tsgo);
      withServers([
        ['tsgo', serverOn('tsgo', ['typescript'], tsgo)],
        [
          'tsls',
          serverOn(
            'tsls',
            ['typescript'],
            refusingConnection(-32601, 'workspace/diagnostic'),
          ),
        ],
      ]);
      await expect(workspaceDiagnostics()).resolves.toEqual([]);
    });

    it('rejects a lone -32601 workspace refusal without an answering server', async () => {
      // An unsupported pull alone provides no evidence of a clean workspace.
      withServers([
        [
          'tsls',
          serverOn(
            'tsls',
            ['typescript'],
            refusingConnection(-32601, 'workspace/diagnostic'),
          ),
        ],
      ]);
      await expect(workspaceDiagnostics()).rejects.toThrow(
        'does not support pull diagnostics',
      );
    });

    it('lets a -32601 refusal from the rust owner veto a non-owner empty answer', async () => {
      // rust-analyzer declares `rust`, which serves `.rs` — the mapping must
      // know that, or the refusal reads as no-owner and the non-owner's empty
      // report certifies a broken file clean.
      const [rsPath] = addFile('main.rs', 'fn main() { let x: i32 = ""; }\n');
      const pyright = createConnection();
      mockDiagnosticsResponses(pyright);
      withServers([
        [
          'rust',
          serverOn('rust-analyzer', ['rust'], refusingConnection(-32601)),
        ],
        ['python', serverOn('pyright', ['python'], pyright)],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: rsPath,
      });
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain(
        'does not support pull diagnostics',
      );
    });

    it('keeps the refusal veto when a partial extensionToLanguage mapping exists', async () => {
      // The mapping lists only .ts/.tsx; its values still declare the
      // typescriptreact language, which owns .jsx — the refusal on App.jsx
      // must not be excused as irrelevant. (languages is empty, so only
      // the mapping can attribute anything.)
      const [jsxPath] = addFile('App.jsx', 'export const x = "";\n');
      const pyright = createConnection();
      mockDiagnosticsResponses(pyright);
      withServers([
        [
          'tsls',
          serverOn('tsls', [], refusingConnection(-32601), {
            extensionToLanguage: {
              '.ts': 'typescript',
              '.tsx': 'typescriptreact',
            },
          }),
        ],
        ['python', serverOn('pyright', ['python'], pyright)],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: jsxPath,
      });
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
    });

    it('does not widen a partial extensionToLanguage mapping for diagnostics', async () => {
      // The explicit routing set excludes .jsx even if a mapped language owns it.
      const [jsxPath] = addFile('App.jsx', 'export const x = "";\n');
      const tsls = createConnection();
      mockDiagnosticsResponses(tsls);
      withServers([
        [
          'tsls',
          serverOn('tsls', [], tsls, {
            extensionToLanguage: {
              '.ts': 'typescript',
              '.tsx': 'typescriptreact',
            },
          }),
        ],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: jsxPath,
      });
      expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
      expect(result.llmContent).toContain(
        'No ready LSP server matches document',
      );
      expect(tsls.request).not.toHaveBeenCalled();
    });

    it('does not blame a ready server excluded by its explicit mapping', async () => {
      // An excluded ready server is not an unasked owner; the other answer is unbacked.
      const [jsxPath] = addFile('App.jsx', 'export const x = "";\n');
      const remote = createConnection();
      mockDiagnosticsResponses(remote);
      const failing = createConnection();
      failing.request.mockRejectedValue(new Error('connection lost'));
      withServers([
        [
          'tsls',
          serverOn('tsls', [], failing, {
            extensionToLanguage: {
              '.ts': 'typescript',
              '.tsx': 'typescriptreact',
            },
          }),
        ],
        ['remote', serverOn('remote-lsp', ['remote-lsp'], remote)],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: jsxPath,
      });
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain('could not be attributed');
      expect(result.error?.message).not.toContain('tsls');
      expect(failing.request).not.toHaveBeenCalled();
      expect(remote.request).toHaveBeenCalled();
    });

    it('does not let a javascript-only answerer back a typescript refusal', async () => {
      // The JS/TS family widening is a relevance device only: a server
      // declaring `javascript` does not OWN `.ts`, so its empty report must
      // not back the typescript server's -32601 refusal on main.ts.
      const [tsPath] = addFile('main.ts', 'const x: number = "";\n');
      const jsTools = createConnection();
      mockDiagnosticsResponses(jsTools);
      withServers([
        ['js', serverOn('js-tools', ['javascript'], jsTools)],
        [
          'ts',
          serverOn(
            'typescript-language-server',
            ['typescript'],
            refusingConnection(-32601),
          ),
        ],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: tsPath,
      });
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain(
        'does not support pull diagnostics',
      );
    });

    it('lets a typescript answerer back a javascript refusal for a .jsx file', async () => {
      const [jsxPath] = addFile('main.jsx', 'const value = "";\n');
      const typescript = createConnection();
      mockDiagnosticsResponses(typescript);
      withServers([
        [
          'typescript',
          serverOn('typescript-language-server', ['typescript'], typescript),
        ],
        [
          'javascript',
          serverOn(
            'javascript-language-server',
            ['javascript'],
            refusingConnection(-32601),
          ),
        ],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: jsxPath,
      });
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toMatch(/^No diagnostics found/);
    });

    it.each([
      // pyright proves it cannot own `.go` (its `py` is attributable), so the
      // reason is coverage. kotlin's `kt` alias row makes its declaration
      // placeable too, and none of its extensions is `.ts`, so its answer is
      // irrelevant the same way and the reason is coverage as well — the
      // attribution wording is reserved for a declaration no table row can
      // place at all.
      ['pyright', 'python', 'main.go', 'no configured server covers'],
      ['kotlin', 'kotlin', 'main.ts', 'no configured server covers'],
    ] as const)(
      'refuses an empty answer with no attributable owner from %s',
      async (name, language, fileName, reason) => {
        const [targetPath] = addFile(fileName, 'const value = "";\n');
        const answerer = createConnection();
        mockDiagnosticsResponses(answerer);
        withServers([[name, serverOn(name, [language], answerer)]]);
        const result = await execute(lspTool(), {
          operation: 'diagnostics',
          filePath: targetPath,
        });
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error?.message).toContain(reason);
        expect(result.llmContent).not.toContain('No diagnostics found');
      },
    );

    it('lets an excused -32601 refusal veto when no answering server owns the file', async () => {
      // clangd is the only server that can own main.cpp and answers -32601;
      // pyright returns an empty report for a file it never declared. The
      // refusal excused out of `failures` must still veto when nothing that
      // could own the file answered — otherwise a broken file certifies
      // clean.
      const [cppPath] = addFile('main.cpp', 'int main() { return 1 }\n');
      const pyright = createConnection();
      mockDiagnosticsResponses(pyright);
      withServers([
        ['cpp', serverOn('clangd', ['cpp'], refusingConnection(-32601))],
        ['pyright', serverOn('pyright', ['python'], pyright)],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: cppPath,
      });
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain(
        'does not support pull diagnostics',
      );
    });

    it('lets an excused -32601 refusal veto when the answering sibling is keyed by server name', async () => {
      // The pyright entry is keyed by server name, so its derived extension
      // set is unattributable and it counts as relevant — but it declares
      // `pyright`, not `typescript`, so it is no owner of main.ts either.
      const [tsPath] = addFile('main.ts', 'const value: number = "";\n');
      const pyright = createConnection();
      mockDiagnosticsResponses(pyright);
      withServers([
        ['pyright', serverOn('pyright', ['pyright'], pyright)],
        [
          'typescript',
          serverOn(
            'typescript-language-server',
            ['typescript'],
            refusingConnection(-32601),
          ),
        ],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: tsPath,
      });
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
    });

    it('keeps a clean Rust file a TypeScript sibling answers -32601 for', async () => {
      // The owner test keys on the *answering* server's declaration and on the
      // table's ability to place the extension. `rust`'s alias row carries
      // `rs`, so rust-analyzer IS a countable owner of main.rs and its
      // authoritative empty report stands, while the push-only sibling's
      // `-32601` refusal is excused out of `failures` instead of vetoing.
      // `.rs` and `.yml` are placeable this way, through their alias rows;
      // `.mts` is not placeable at all, so it falls back to the relevance
      // ledger rather than to a hard refusal.
      const [rsPath] = addFile('main.rs', 'fn main() {}\n');
      const rustAnalyzer = createConnection();
      mockDiagnosticsResponses(rustAnalyzer);
      withServers([
        ['rust', serverOn('rust-analyzer', ['rust'], rustAnalyzer)],
        [
          'typescript',
          serverOn(
            'typescript-language-server',
            ['typescript'],
            refusingConnection(-32601),
          ),
        ],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: rsPath,
      });
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toMatch(/^No diagnostics found/);
    });

    it('still reports a real problem when a push-only sibling answers -32601', async () => {
      // Excusing the refusal must not blunt the answer that was retrieved.
      const [brokenPath] = addFile('broken.ts', 'const value: number = "";\n');
      const tsgo = createConnection();
      mockDiagnosticsResponses(tsgo, [
        { range, severity: 1, message: 'Type error' },
      ]);
      withServers([
        ['tsgo', serverOn('tsgo', ['typescript'], tsgo)],
        ['tsls', serverOn('tsls', ['typescript'], refusingConnection(-32601))],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: brokenPath,
      });
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('Type error');
    });

    it.each([-32600, -32603])(
      'still lets a %d reply veto a clean document answer',
      async (code) => {
        // -32601 is the only code that proves the method is not implemented.
        // An invalid request or an internal error means the server could own
        // the file and did not analyze it, so the veto stands.
        const tsgo = createConnection();
        mockDiagnosticsResponses(tsgo);
        withServers([
          ['tsgo', serverOn('tsgo', ['typescript'], tsgo)],
          ['tsls', serverOn('tsls', ['typescript'], refusingConnection(code))],
        ]);
        const result = await run(queryDiagnosticsTool('diagnostics'));
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error?.message).toContain(
          'Unhandled method textDocument/diagnostic',
        );
        expect(result.llmContent).not.toContain('No diagnostics found');
      },
    );

    it('names a lone push-only server instead of reporting the file clean', async () => {
      // Nothing else answered, so the refusal cannot be excused: an empty
      // result would certify a file no server analyzed. The wording says what
      // the server actually did rather than reporting an opaque failure.
      withServers([
        ['tsls', serverOn('tsls', ['typescript'], refusingConnection(-32601))],
      ]);
      const result = await run(queryDiagnosticsTool('diagnostics'));
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain(
        'tsls: does not support pull diagnostics',
      );
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it('names a push-only TypeScript server that refuses a JS-family file', async () => {
      // A `typescript` declaration answers for the JS family, so tsls was a
      // legitimate candidate for App.jsx and its refusal explains the empty
      // result. Without the family widening the refusal reads as no-owner and
      // the message claims no configured server covers a file tsls was asked
      // about.
      const [jsxPath] = addFile('App.jsx', 'export const x = "";\n');
      withServers([
        ['tsls', serverOn('tsls', ['typescript'], refusingConnection(-32601))],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: jsxPath,
      });
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain(
        'tsls: does not support pull diagnostics',
      );
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it('names a -32601 workspace refusal beside the failure that did veto', async () => {
      // A refusal is not a hard failure, but when the gate rejects for another
      // reason the refusal still has to appear: it explains why that server
      // said nothing, and dropping it would name only the sibling that
      // crashed.
      const dead = createConnection();
      dead.request.mockRejectedValue(new Error('crash on startup'));
      withServers([
        [
          'gopls',
          serverOn(
            'gopls',
            ['go'],
            refusingConnection(-32601, 'workspace/diagnostic'),
          ),
        ],
        ['pyright', serverOn('pyright', ['python'], dead)],
      ]);
      const result = await run(queryDiagnosticsTool('workspaceDiagnostics'));
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain('pyright: crash on startup');
      expect(result.error?.message).toContain(
        'gopls: does not support pull diagnostics',
      );
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it("lets an irrelevant server's failed pull veto an unbacked workspace report", async () => {
      // The workspace leg stays unqualified: with no queried file there is
      // no relevance test, so any failed pull vetoes an empty report.
      mockDiagnosticsResponses(connection);
      const failingConnection = createConnection();
      failingConnection.request.mockRejectedValue(
        new Error('method not found'),
      );
      withServers([
        ['test', handle],
        [
          'pyright',
          {
            ...handle,
            config: {
              ...handle.config,
              name: 'pyright',
              languages: ['python'],
            },
            connection: failingConnection,
          },
        ],
      ]);
      const result = await run(queryDiagnosticsTool('workspaceDiagnostics'));
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain('method not found');
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it('rejects workspaceDiagnostics when a clean sibling entry masks a dropped report', async () => {
      // One entry normalizes to an empty report while a uri-less sibling
      // carrying a severity-1 error is dropped: the clean entry must not
      // absorb the loss.
      connection.request.mockImplementation(async (method: string) =>
        method === 'workspace/diagnostic'
          ? {
              items: [
                { uri, kind: 'full', items: [] },
                {
                  kind: 'full',
                  items: [{ range, severity: 1, message: 'Type error' }],
                },
              ],
            }
          : { kind: 'full', items: [] },
      );
      const result = await run(queryDiagnosticsTool('workspaceDiagnostics'));
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain('unusable');
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it('rejects workspaceDiagnostics when every inner item fails normalization', async () => {
      // The file entry has a uri, so the outer entry survives, but its only
      // reported problem lacks a range and normalizes away.
      connection.request.mockImplementation(async (method: string) =>
        method === 'workspace/diagnostic'
          ? {
              items: [
                {
                  uri,
                  kind: 'full',
                  items: [{ severity: 1, message: 'Type error' }],
                },
              ],
            }
          : { kind: 'full', items: [] },
      );
      const result = await run(queryDiagnosticsTool('workspaceDiagnostics'));
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain('unusable');
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it('rejects a document query whose only server was excused and retrieved nothing', async () => {
      // The sole configured server declares python only, so the relevance
      // rule excuses its failed pull for main.ts — but nothing else was asked
      // and nothing answered, so the empty result would certify a file no
      // server analyzed. The rejection states the coverage fact rather than
      // blaming a server that could never own the file.
      const failingConnection = createConnection();
      failingConnection.request.mockRejectedValue(
        new Error('method not found'),
      );
      withServers([
        [
          'pyright',
          {
            ...handle,
            config: {
              ...handle.config,
              name: 'pyright',
              languages: ['python'],
            },
            connection: failingConnection,
          },
        ],
      ]);
      const result = await run(queryDiagnosticsTool('diagnostics'));
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain(
        'no configured server covers the queried file',
      );
      expect(result.error?.message).not.toContain('pyright');
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it('does not blame an irrelevant server whose pull resolved to nothing', async () => {
      // A disposed connection resolves `undefined` instead of rejecting; the
      // excused server's non-answer must not suppress the coverage fallback
      // either.
      const silentConnection = createConnection();
      silentConnection.request.mockResolvedValue(undefined);
      withServers([
        [
          'pyright',
          {
            ...handle,
            config: {
              ...handle.config,
              name: 'pyright',
              languages: ['python'],
            },
            connection: silentConnection,
          },
        ],
      ]);
      const result = await run(queryDiagnosticsTool('diagnostics'));
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain(
        'no configured server covers the queried file',
      );
      expect(result.error?.message).not.toContain('pyright');
    });

    it('keeps a clean answer from the only queried server that answered', async () => {
      // The queried server is READY, owns the JS/TS family, and returned an
      // authoritative empty report, so its answer is the backing the gate
      // requires: for a placeable extension the gate demands a positively
      // owning answerer, and this one provides it.
      const jsFile = path.join(directory, 'index.js');
      fs.writeFileSync(jsFile, 'const a = 1;\n');
      mockDiagnosticsResponses(connection);
      const result = await run(
        lspTool()
          .build({ operation: 'diagnostics', filePath: jsFile })
          .execute(new AbortController().signal),
      );
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toMatch(/^No diagnostics found/);
    });

    it('refuses a clean answer whose only backer could never own the file', async () => {
      // The sole configured server is READY and returns an authoritative empty
      // report, so nothing failed and nothing was skipped — but it declares
      // python only, so its report says nothing about main.ts.
      withServers([
        [
          'pyright',
          {
            ...emptyReportHandle('pyright'),
            config: {
              ...handle.config,
              name: 'pyright',
              languages: ['python'],
            },
          },
        ],
      ]);
      const result = await run(queryDiagnosticsTool('diagnostics'));
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain(
        'no configured server covers the queried file',
      );
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it('refuses a clean answer whose only backer is keyed by a language ID', async () => {
      // The `cpp` twin of the python-only refusal above. `cpp` is absent from
      // LANGUAGE_ID_TO_EXTENSIONS only because the ID already equals the
      // extension, so it is just as attributable: a lone clangd still cannot
      // certify main.ts clean.
      withServers([
        [
          'clangd',
          {
            ...emptyReportHandle('clangd'),
            config: { ...handle.config, name: 'clangd', languages: ['cpp'] },
          },
        ],
      ]);
      const result = await run(queryDiagnosticsTool('diagnostics'));
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain(
        'no configured server covers the queried file',
      );
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it.each([
      ['cpp', 'clangd', 'header.h'],
      ['typescript', 'tsls', 'main.mts'],
      ['dockerfile', 'docker-ls', 'Dockerfile'],
    ] as const)(
      'keeps a clean answer for an extension the tables cannot place (%s)',
      async (language, name, fileName) => {
        // `.h`, `.mts` and an extensionless name appear in no diagnostics
        // table, so no declaration can be shown to own them: ownership is
        // undecidable here and the answering server's authoritative empty
        // report must stand. Refusing would reject a documented working
        // configuration with a reason the same call's pull counter contradicts.
        const [targetPath] = addFile(fileName, 'export const value = 1;\n');
        const answerer = createConnection();
        mockDiagnosticsResponses(answerer);
        withServers([[name, serverOn(name, [language], answerer)]]);
        const result = await execute(lspTool(), {
          operation: 'diagnostics',
          filePath: targetPath,
        });
        expect(result.error).toBeUndefined();
        expect(result.llmContent).toMatch(/^No diagnostics found/);
      },
    );

    it('refuses a non-file diagnostic query before sending to the server', async () => {
      const virtualUri = 'jdt://contents/Foo.java?=%2Fsrc';
      mockDiagnosticsResponses(connection);
      await expect(run(service.diagnostics(virtualUri))).rejects.toThrow(
        'not a file URI',
      );
      expect(connection.send).not.toHaveBeenCalled();
      expect(connection.request).not.toHaveBeenCalled();
    });

    it('does not let a failed sibling veto a clean answer for a placeable extension', async () => {
      // `.go` is placeable through DIAGNOSTIC_LANGUAGE_IDS, so a downed python
      // server provably cannot own main.go and is excused from the veto list
      // rather than counted as unreachable; gopls's authoritative empty report
      // stands.
      const [goPath] = addFile('main.go', 'package main\n');
      const gopls = createConnection();
      mockDiagnosticsResponses(gopls);
      withServers([
        ['go', serverOn('gopls', ['go'], gopls)],
        [
          'pyright',
          {
            ...handle,
            config: {
              ...handle.config,
              name: 'pyright',
              languages: ['python'],
            },
            status: 'FAILED',
            connection: undefined,
            error: new Error('command not found: pyright'),
          },
        ],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: goPath,
      });
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toMatch(/^No diagnostics found/);
    });

    it.each([
      'python',
      'cpp',
      'java',
      'go',
      'javascript',
      'javascriptreact',
      'kotlin',
    ])(
      'does not let a downed %s sibling veto a clean answer it cannot own',
      async (languageId) => {
        // The ready server holds the `.ts` answer, and each downed sibling
        // provably cannot own it: `python` shows the excuse needs the queried
        // URI (drop the third argument to `unreachableDiagnosticServers` and
        // this row vetoes again), `cpp`, `java` and `go` are identity-mapped,
        // `javascript`/`javascriptreact` serve no `.ts` at all while the
        // family widening stays one-directional, and `kotlin` reaches `.kt`
        // only through an alias row.
        mockDiagnosticsResponses(connection);
        const failedSibling: LspServerHandle = {
          ...handle,
          config: {
            ...handle.config,
            name: languageId,
            languages: [languageId],
          },
          status: 'FAILED',
          connection: undefined,
          error: new Error(`command not found: ${languageId}`),
        };
        withServers([
          ['test', handle],
          [languageId, failedSibling],
        ]);
        const result = await run(queryDiagnosticsTool('diagnostics'));
        expect(result.error).toBeUndefined();
        expect(result.llmContent).toMatch(/^No diagnostics found/);
      },
    );

    it('does not let a downed rust sibling with an explicit mapping veto a clean answer it cannot own', async () => {
      // The `extensionToLanguage` twin of the identity-mapped cases above: the
      // mapping sends extension derivation down its keys branch, so `rust`
      // reaches the owner set only through its alias row. That row carries the
      // language ID as well as `.rs`, so the downed sibling is still provably
      // unable to own main.ts and the ready server's empty report stands.
      mockDiagnosticsResponses(connection);
      const failedSibling: LspServerHandle = {
        ...handle,
        config: {
          ...handle.config,
          name: 'rust',
          languages: ['rust'],
          extensionToLanguage: { '.rs': 'rust' },
        },
        status: 'FAILED',
        connection: undefined,
        error: new Error('command not found: rust-analyzer'),
      };
      withServers([
        ['test', handle],
        ['rust', failedSibling],
      ]);
      const result = await run(queryDiagnosticsTool('diagnostics'));
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toMatch(/^No diagnostics found/);
    });

    it('does not excuse a failed server whose config key is capitalized', async () => {
      // `.lsp.json` keys reach `languages` unnormalized. `"Python"` derives
      // no attributable extension, so the relevance rule fails CLOSED: the
      // downed server keeps its veto on the `.py` query and its failure is
      // named, instead of the sibling's empty report certifying the file.
      addFile('main.py', 'x = 1\n');
      mockDiagnosticsResponses(connection);
      const failingConnection = createConnection();
      failingConnection.request.mockRejectedValue(
        new Error('method not found'),
      );
      withServers([
        ['test', handle],
        [
          'pyright',
          {
            ...handle,
            config: {
              ...handle.config,
              name: 'pyright',
              languages: ['Python'],
            },
            connection: failingConnection,
          },
        ],
      ]);
      const result = await run(
        lspTool()
          .build({
            operation: 'diagnostics',
            filePath: path.join(directory, 'main.py'),
          })
          .execute(new AbortController().signal),
      );
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain('method not found');
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it('counts a capitalized TypeScript key as owning the .ts file it answered', async () => {
      // The case the lowercase normalization actually decides: `TypeScript`
      // must derive `ts` on the OWNER side exactly like `typescript` does, or
      // its authoritative empty report stops backing main.ts and the
      // sibling's -32601 refusal flips a clean file to a hard tool error.
      const [tsPath] = addFile('main.ts', 'const x: number = 1;\n');
      const answerer = createConnection();
      mockDiagnosticsResponses(answerer);
      withServers([
        [
          'TypeScript',
          serverOn('typescript-language-server', ['TypeScript'], answerer),
        ],
        ['ts', serverOn('tsls', ['typescript'], refusingConnection(-32601))],
      ]);
      const result = await execute(lspTool(), {
        operation: 'diagnostics',
        filePath: tsPath,
      });
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toMatch(/^No diagnostics found/);
    });

    it('does not excuse a downed typescript server from a .js query it serves', async () => {
      // `typescript-language-server` answers for `.js` as well, so a FAILED
      // `typescript` handle keeps its veto on an `index.js` query instead of
      // being excused by a `{ts,tsx}` declaration; the sibling's empty report
      // is no backing for a file the downed server owned.
      addFile('index.js', 'const a = 1;\n');
      const failedHandle: LspServerHandle = {
        ...handle,
        config: { ...handle.config, name: 'typescript' },
        status: 'FAILED',
        connection: undefined,
      };
      withServers([
        [
          'healthy',
          {
            ...emptyReportHandle('healthy'),
            config: { ...handle.config, name: 'healthy', languages: ['yaml'] },
          },
        ],
        ['typescript', failedHandle],
      ]);
      const result = await run(
        lspTool()
          .build({
            operation: 'diagnostics',
            filePath: path.join(directory, 'index.js'),
          })
          .execute(new AbortController().signal),
      );
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain('typescript is failed');
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it('does not blame a server that could never own the file when no server is ready', async () => {
      // Only a python server is configured and it is down; querying main.ts
      // must still fail hard, but must name the real state instead of
      // pointing at pyright.
      const failedPythonHandle: LspServerHandle = {
        ...handle,
        config: { ...handle.config, name: 'pyright', languages: ['python'] },
        status: 'FAILED',
        connection: undefined,
      };
      withServers([['pyright', failedPythonHandle]]);
      const result = await run(queryDiagnosticsTool('diagnostics'));
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain(
        'no configured server covers the queried file',
      );
      expect(result.error?.message).not.toContain('pyright');
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it('refuses a clean answer from a ready server keyed only by its server name', async () => {
      // `.lsp.json` keys reach `languages` unvalidated, so a `pyright` key
      // derives the guess `{'pyright'}`. That set proves nothing about
      // main.py, so its authoritative empty report cannot certify the file.
      addFile('main.py', 'x = 1\n');
      withServers([
        [
          'pyright',
          {
            ...emptyReportHandle('pyright'),
            config: {
              ...handle.config,
              name: 'pyright',
              languages: ['pyright'],
            },
          },
        ],
      ]);
      const result = await run(
        lspTool()
          .build({
            operation: 'diagnostics',
            filePath: path.join(directory, 'main.py'),
          })
          .execute(new AbortController().signal),
      );
      expect(result.error).toMatchObject({
        type: ToolErrorType.EXECUTION_FAILED,
      });
      expect(result.error?.message).toContain(
        'could not be attributed to the queried file',
      );
      expect(result.llmContent).not.toContain('No diagnostics found');
    });

    it.each(['pyright', 'remote-lsp'])(
      'names a downed %s server keyed by its server name',
      async (key) => {
        // The unattributed guess must not excuse the failed server from the
        // veto: it really could own main.py, so the sibling's empty report is
        // no backing and the recorded cause has to reach the user.
        addFile('main.py', 'x = 1\n');
        withServers([
          [
            'healthy',
            {
              ...emptyReportHandle('healthy'),
              config: {
                ...handle.config,
                name: 'healthy',
                languages: ['python'],
              },
            },
          ],
          [
            key,
            {
              ...handle,
              config: { ...handle.config, name: key, languages: [key] },
              status: 'FAILED',
              connection: undefined,
              error: new Error(`command not found: ${key}`),
            },
          ],
        ]);
        const result = await run(
          lspTool()
            .build({
              operation: 'diagnostics',
              filePath: path.join(directory, 'main.py'),
            })
            .execute(new AbortController().signal),
        );
        expect(result.error).toMatchObject({
          type: ToolErrorType.EXECUTION_FAILED,
        });
        expect(result.error?.message).toContain(`${key} is failed`);
        expect(result.llmContent).not.toContain('No diagnostics found');
      },
    );
  });
});
