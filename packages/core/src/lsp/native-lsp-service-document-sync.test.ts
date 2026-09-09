/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeLspService } from './native-lsp-service.js';
import { NativeLspClient } from './NativeLspClient.js';
import { LspTool } from '../tools/lsp.js';
import type { LspServerManager } from './lsp-server-manager.js';
import type { Config } from '../config/config.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { IdeContextStore } from '../ide/ideContext.js';
import type {
  LspServerHandle,
  JsonRpcMessage,
  LspTextDocumentSync,
} from './types.js';

const logger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock('../utils/debugLogger.js', () => ({ createDebugLogger: () => logger }));

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
};

function createConnection() {
  let text = '';
  const events: string[] = [];
  return {
    events,
    listen: vi.fn(),
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    initialize: vi.fn(),
    shutdown: vi.fn(),
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
    request: vi.fn(async (method: string): Promise<unknown> => {
      events.push(method);
      return method === 'textDocument/hover' ? { contents: text } : [];
    }),
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
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-document-sync-'));
    file = path.join(directory, 'main.ts');
    uri = pathToFileURL(file).toString();
    fs.writeFileSync(file, 'old');
    service = new NativeLspService(
      {
        getProjectRoot: () => directory,
        isTrustedFolder: () => true,
      } as unknown as Config,
      { getDirectories: () => [directory] } as unknown as WorkspaceContext,
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
    await vi.runAllTimersAsync();
    return promise;
  }

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
  function query(method: (typeof queryMethods)[number]): Promise<unknown> {
    if (method === 'documentSymbols' || method === 'diagnostics')
      return service[method](uri);
    if (method === 'codeActions')
      return service.codeActions(uri, range, { diagnostics: [] });
    if (method === 'incomingCalls' || method === 'outgoingCalls') {
      return service[method]({
        name: 'fn',
        uri,
        range,
        selectionRange: range,
        rawKind: 12,
      });
    }
    return service[method]({ uri, range });
  }

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
          params: {
            textDocument: {
              uri,
              languageId: 'typescript',
              version: 1,
              text: 'old',
            },
          },
        },
        {
          jsonrpc: '2.0',
          method: 'textDocument/didChange',
          params: {
            textDocument: { uri, version: 2 },
            contentChanges: [{ text: 'new' }],
          },
        },
      ]);
      const changeIndex = connection.events.indexOf('textDocument/didChange');
      expect(connection.events[changeIndex + 1]).not.toMatch(/did/);
      fs.writeFileSync(file, 'third');
      await run(query(method));
      expect(connection.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: {
            textDocument: { uri, version: 3 },
            contentChanges: [{ text: 'third' }],
          },
        }),
      );
    },
  );

  it('refreshes hover after a same-size edit with identical restored mtime', async () => {
    const timestamp = new Date('2025-01-01T00:00:00Z');
    fs.utimesSync(file, timestamp, timestamp);
    const before = fs.statSync(file);
    expect(await run(service.hover({ uri, range }))).toMatchObject({
      contents: 'old',
    });
    fs.writeFileSync(file, 'new');
    fs.utimesSync(file, before.atime, before.mtime);
    const after = fs.statSync(file);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await run(service.hover({ uri, range }))).toMatchObject({
      contents: 'new',
    });
    expect(connection.events).toEqual([
      'textDocument/didOpen',
      'textDocument/hover',
      'textDocument/didChange',
      'textDocument/hover',
    ]);
  });

  it('refreshes hover after another process saves the target file', async () => {
    expect(await run(service.hover({ uri, range }))).toMatchObject({
      contents: 'old',
    });
    execFileSync(process.execPath, [
      '-e',
      "require('node:fs').writeFileSync(process.argv[1], 'process edit')",
      file,
    ]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('process edit');
    expect(await run(service.hover({ uri, range }))).toMatchObject({
      contents: 'process edit',
    });
    expect(connection.events).toEqual([
      'textDocument/didOpen',
      'textDocument/hover',
      'textDocument/didChange',
      'textDocument/hover',
    ]);
  });

  it.each([1, { openClose: true, change: 1 }])(
    'supports full sync %j without splitting the previous text',
    async (sync) => {
      handle.textDocumentSync = sync as LspTextDocumentSync | undefined;
      await run(service.hover({ uri, range }));
      fs.writeFileSync(file, '');
      const split = vi.spyOn(String.prototype, 'split');
      let splitCalls: unknown[][];
      try {
        await run(service.hover({ uri, range }));
        splitCalls = [...split.mock.calls];
      } finally {
        split.mockRestore();
      }
      expect(
        splitCalls.some(
          ([separator]) => String(separator) === '/\\r\\n|\\r|\\n/',
        ),
      ).toBe(false);
      expect(connection.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: {
            textDocument: { uri, version: 2 },
            contentChanges: [{ text: '' }],
          },
        }),
      );
    },
  );

  it.each([2, { openClose: true, change: 2 }])(
    'uses UTF-16 whole-document ranges for incremental sync %j',
    async (sync) => {
      handle.textDocumentSync = sync as LspTextDocumentSync | undefined;
      fs.writeFileSync(file, 'first\r\n😀x\rsecond\n😀');
      await run(service.hover({ uri, range }));
      fs.writeFileSync(file, 'replacement\r\n');
      await run(service.hover({ uri, range }));
      expect(connection.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: {
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
          },
        }),
      );
      fs.writeFileSync(file, '');
      await run(service.hover({ uri, range }));
      expect(connection.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: {
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
          },
        }),
      );
    },
  );

  it.each([
    0,
    undefined,
    {},
    { openClose: false, change: 0 },
    { openClose: true, change: 0 },
  ])('does not query changed text with unsupported sync %j', async (sync) => {
    handle.textDocumentSync = sync as LspTextDocumentSync | undefined;
    await run(service.hover({ uri, range }));
    const sends = connection.send.mock.calls.length;
    expect(sends).toBe(typeof sync === 'object' && sync?.openClose ? 1 : 0);
    connection.request.mockClear();
    await run(service.hover({ uri, range }));
    expect(connection.request).toHaveBeenCalledOnce();
    connection.request.mockClear();
    fs.writeFileSync(file, 'new');
    expect(await run(service.hover({ uri, range }))).toBeNull();
    expect(connection.request).not.toHaveBeenCalled();
    expect(connection.send).toHaveBeenCalledTimes(sends);
    expect(logger.warn).toHaveBeenLastCalledWith(
      'LSP textDocument/hover failed for test:',
      expect.objectContaining({
        message: `LSP server test cannot synchronize changed document ${uri}: textDocumentSync.change is None or absent`,
      }),
    );
  });

  it.each([{ change: 1 }, { openClose: false, change: 2 }])(
    'honors disabled openClose %j',
    async (sync) => {
      handle.textDocumentSync = sync as LspTextDocumentSync | undefined;
      await run(service.hover({ uri, range }));
      expect(connection.send).not.toHaveBeenCalled();
      fs.writeFileSync(file, 'new');
      await run(service.hover({ uri, range }));
      expect(connection.send).toHaveBeenCalledOnce();
      expect(connection.send.mock.calls[0]![0].method).toBe(
        'textDocument/didChange',
      );
    },
  );

  it('reopens current content with a fresh version after connection replacement', async () => {
    await run(service.hover({ uri, range }));
    fs.writeFileSync(file, 'new');
    await run(service.hover({ uri, range }));
    const replacement = createConnection();
    handle.connection = replacement;
    fs.writeFileSync(file, 'restarted');
    await run(service.hover({ uri, range }));
    expect(replacement.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri,
            languageId: 'typescript',
            version: 1,
            text: 'restarted',
          },
        },
      }),
    );
  });

  it('shares warmup state with queries, forced warmup and replacement connections', async () => {
    (service as unknown as { serverManager: LspServerManager }).serverManager =
      manager;
    handle.config.name = 'typescript';
    vi.spyOn(manager, 'getHandles').mockImplementation(
      () => new Map([['test', handle]]),
    );
    await run(service.workspaceSymbols('fn'));
    await run(service.hover({ uri, range }));
    expect(connection.send).toHaveBeenCalledOnce();
    fs.writeFileSync(file, 'warmup changed');
    connection.request.mockResolvedValueOnce({ message: 'No Project' });
    await run(service.workspaceSymbols('fn'));
    await run(service.hover({ uri, range }));
    expect(connection.send).toHaveBeenCalledTimes(2);
    expect(connection.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: 'warmup changed' }],
        },
      }),
    );
    handle.connection = createConnection();
    handle.warmedUp = false;
    fs.writeFileSync(file, 'restarted warmup');
    await run(service.workspaceSymbols('fn'));
    await run(service.hover({ uri, range }));
    expect(handle.connection.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri,
            languageId: 'typescript',
            version: 1,
            text: 'restarted warmup',
          },
        },
      }),
    );
  });

  it.each(queryMethods)(
    'preserves replayed snapshots when stale %s resumes after reload',
    async (method) => {
      // SAFETY: Access the service's real manager; only process startup is stubbed.
      (
        service as unknown as { serverManager: LspServerManager }
      ).serverManager = manager;
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
      vi.spyOn(
        manager as unknown as {
          startServer(name: string, target: LspServerHandle): Promise<void>;
        },
        'startServer',
      ).mockImplementation(async (_name, target) => {
        target.status = 'READY';
        target.textDocumentSync = 1;
        target.connection =
          manager.getHandles().get('typescript') === handle
            ? connection
            : replacement;
      });
      handle = manager.getHandles().get('typescript')!;
      await manager.startAll();
      const pending = query(method).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      expect(connection.send).toHaveBeenCalledOnce();
      expect(connection.request).not.toHaveBeenCalled();

      fs.writeFileSync(
        path.join(directory, '.lsp.json'),
        JSON.stringify({
          typescript: { command: 'typescript', settings: { changed: true } },
        }),
      );
      let onReplayed!: () => void;
      const replayed = new Promise<void>((resolve) => {
        onReplayed = resolve;
      });
      const send = replacement.send.getMockImplementation()!;
      replacement.send.mockImplementation((message) => {
        send(message);
        onReplayed();
      });
      const reload = service.reinitialize();
      await replayed;
      expect(handle.connection).toBeUndefined();
      expect(manager.getHandles().get('typescript')).not.toBe(handle);
      expect(replacement.send).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(150);
      const stale = await pending;
      await run(reload);
      await run(query(method));
      expect(replacement.send).toHaveBeenCalledOnce();
      fs.writeFileSync(file, 'after reload');
      await run(query(method));
      expect(replacement.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method: 'textDocument/didChange',
          params: {
            textDocument: { uri, version: 2 },
            contentChanges: [{ text: 'after reload' }],
          },
        }),
      );
      expect(connection.request).not.toHaveBeenCalled();
      if (method === 'diagnostics') {
        expect(stale.error).toEqual(
          new Error('LSP server typescript connection is no longer active'),
        );
      } else {
        expect(stale.error).toBeUndefined();
        expect(stale.result).toEqual(method === 'hover' ? null : []);
      }
    },
  );

  function queryDiagnosticsTool() {
    // SAFETY: The actual diagnostics tool path only needs these Config methods.
    const config = {
      getProjectRoot: () => directory,
      isLspEnabled: () => true,
      getLspClient: () => new NativeLspClient(service),
    } as unknown as Config;
    return new LspTool(config)
      .build({ operation: 'diagnostics', filePath: file })
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
        connection.send.mockImplementationOnce(() => {
          throw new Error('send failed');
        });
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
      (
        service as unknown as { serverManager: LspServerManager }
      ).serverManager = manager;
      vi.spyOn(manager, 'getHandles').mockReturnValue(
        new Map([
          ['test', handle],
          ['second', secondHandle],
        ]),
      );
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

  it('preserves the existing diagnostics request failure handling', async () => {
    const error = new Error('unsupported pull diagnostics');
    connection.request.mockRejectedValue(error);
    expect(await run(service.diagnostics(uri))).toEqual([]);
    expect(logger.warn).toHaveBeenLastCalledWith(
      'LSP textDocument/diagnostic failed for test:',
      error,
    );
  });

  it('does not issue a document request on an initial read failure', async () => {
    fs.unlinkSync(file);
    expect(await run(service.hover({ uri, range }))).toBeNull();
    expect(connection.send).not.toHaveBeenCalled();
    expect(connection.request).not.toHaveBeenCalled();
  });

  it('does not advance state when a change notification throws', async () => {
    await run(service.hover({ uri, range }));
    connection.request.mockClear();
    fs.writeFileSync(file, 'new');
    connection.send.mockImplementationOnce(() => {
      throw new Error('send failed');
    });
    expect(await run(service.hover({ uri, range }))).toBeNull();
    expect(connection.request).not.toHaveBeenCalled();
    expect(await run(service.hover({ uri, range }))).toMatchObject({
      contents: 'new',
    });
    expect(connection.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: 'new' }],
        },
      }),
    );
  });

  it.each(queryMethods)(
    'skips %s when disk reads fail and retries sync after recovery',
    async (method) => {
      await run(query(method));
      connection.request.mockClear();
      fs.unlinkSync(file);
      if (method === 'diagnostics') {
        await expect(query(method)).rejects.toThrow('ENOENT');
      } else {
        await run(query(method));
      }
      expect(connection.request).not.toHaveBeenCalled();
      fs.writeFileSync(file, 'recovered');
      await run(query(method));
      expect(connection.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: {
            textDocument: { uri, version: 2 },
            contentChanges: [{ text: 'recovered' }],
          },
        }),
      );
    },
  );
});
