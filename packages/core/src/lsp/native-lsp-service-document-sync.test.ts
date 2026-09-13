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
import { NativeLspService } from './native-lsp-service.js';
import { NativeLspClient } from './NativeLspClient.js';
import { LspTool } from '../tools/lsp.js';
import type { LspServerManager } from './lsp-server-manager.js';
import type { Config } from '../config/config.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { IdeContextStore } from '../ide/ideContext.js';
import type {
  LspCallHierarchyItem,
  LspServerHandle,
  JsonRpcMessage,
  LspTextDocumentSync,
} from './types.js';

const logger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
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
    const settled = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await vi.runAllTimersAsync();
    const result = await settled;
    if ('error' in result) throw result.error;
    return result.value;
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
  async function query(
    method: (typeof queryMethods)[number],
  ): Promise<unknown> {
    if (method === 'documentSymbols' || method === 'diagnostics')
      return service[method](uri);
    if (method === 'codeActions')
      return service.codeActions(uri, range, { diagnostics: [] });
    if (method === 'incomingCalls' || method === 'outgoingCalls') {
      const items = await service.prepareCallHierarchy({ uri, range });
      if (!items[0])
        throw new Error(`prepareCallHierarchy returned no item for ${method}`);
      return service[method](items[0]);
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

  it.each(
    (['incomingCalls', 'outgoingCalls'] as const).flatMap((method) =>
      [false, true].map((sibling) => ({ method, sibling })),
    ),
  )(
    'rejects a line-shifted prepared item before $method, sibling sync $sibling',
    async ({ method, sibling }) => {
      fs.writeFileSync(file, 'old');
      const [item] = await run(service.prepareCallHierarchy({ uri, range }));
      await run<unknown>(service[method](item!));
      fs.writeFileSync(file, 'inserted\nold');
      if (sibling) await run(service.hover({ uri, range }));
      connection.request.mockClear();
      connection.send.mockClear();
      await expect(service[method](item!)).rejects.toThrow(
        'prepare call hierarchy again',
      );
      expect(connection.request).not.toHaveBeenCalled();
      expect(connection.send).not.toHaveBeenCalled();
    },
  );

  it.each(['incomingCalls', 'outgoingCalls'] as const)(
    'roundtrips hierarchy JSON through the tool and reports stale %s as a failure',
    async (operation) => {
      // SAFETY: The real LSP tool only needs these Config methods on this path.
      const tool = new LspTool({
        getProjectRoot: () => directory,
        isLspEnabled: () => true,
        getLspClient: () => new NativeLspClient(service),
      } as unknown as Config);
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
      const prepared = await run(
        tool
          .build({
            operation: 'prepareCallHierarchy',
            filePath: file,
            line: 1,
            character: 1,
          })
          .execute(new AbortController().signal),
      );
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
      const result = await run(
        tool
          .build({ operation, callHierarchyItem: reordered })
          .execute(new AbortController().signal),
      );
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
        const rejected = await run(
          tool
            .build({ operation, callHierarchyItem: altered })
            .execute(new AbortController().signal),
        );
        expect(rejected.llmContent).toContain('prepare call hierarchy again');
      }
      expect(connection.request).toHaveBeenCalledTimes(requestCount);
      fs.writeFileSync(file, 'inserted\nold');
      const stale = await run(
        tool
          .build({ operation, callHierarchyItem: item })
          .execute(new AbortController().signal),
      );
      expect(stale.llmContent).toContain('calls failed:');
      expect(stale.llmContent).toContain('prepare call hierarchy again');
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
      const [item] = await run(service.prepareCallHierarchy({ uri, range }));
      let respond!: (value: unknown) => void;
      connection.request.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            respond =
              change === 'request failure'
                ? () => reject(new Error('server rejected'))
                : resolve;
          }),
      );
      const pending = service[method](item!).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      if (change === 'edit' || change === 'request failure') {
        fs.writeFileSync(file, 'inserted\nold');
        await run(service.hover({ uri, range }));
      } else if (change === 'delete') {
        fs.unlinkSync(file);
      } else {
        handle.connection = undefined;
      }
      respond([]);
      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining('prepare call hierarchy again'),
      });
    },
  );

  it('rejects missing, altered and replacement-connection hierarchy provenance', async () => {
    const [item] = await run(service.prepareCallHierarchy({ uri, range }));
    await expect(
      service.incomingCalls({ ...item!, documentRevision: undefined }),
    ).rejects.toThrow('prepare call hierarchy again');
    await expect(
      service.incomingCalls({ ...item!, name: 'another' }),
    ).rejects.toThrow('prepare call hierarchy again');
    handle.connection = createConnection();
    await expect(service.incomingCalls(item!)).rejects.toThrow(
      'prepare call hierarchy again',
    );
    expect(handle.connection.request).not.toHaveBeenCalled();
  });

  it('validates disk-reading hierarchy items without recording an opened buffer', async () => {
    handle.textDocumentSync = undefined;
    const [item] = await run(service.prepareCallHierarchy({ uri, range }));
    await run(service.incomingCalls(item!));
    fs.writeFileSync(file, 'inserted\nold');
    await expect(service.outgoingCalls(item!)).rejects.toThrow(
      'prepare call hierarchy again',
    );
    expect(connection.send).not.toHaveBeenCalled();
  });

  it('leaves unobserved nested hierarchy items without reusable provenance', async () => {
    const [item] = await run(service.prepareCallHierarchy({ uri, range }));
    const secondUri = pathToFileURL(
      path.join(directory, 'other.ts'),
    ).toString();
    connection.request.mockResolvedValueOnce([
      { from: { ...item!, uri: secondUri, kind: 12 }, fromRanges: [range] },
    ]);
    const [call] = await run(service.incomingCalls(item!));
    expect(call!.from.documentRevision).toBeUndefined();
    await expect(service.incomingCalls(call!.from)).rejects.toThrow(
      'prepare call hierarchy again',
    );
  });

  it.each(['edit', 'replacement'])(
    'does not certify a prepare response after concurrent %s',
    async (change) => {
      await run(service.hover({ uri, range }));
      let respond!: (value: unknown) => void;
      connection.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      );
      const pending = service
        .prepareCallHierarchy({ uri, range })
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      if (change === 'edit') {
        fs.writeFileSync(file, 'inserted\nold');
        await run(service.hover({ uri, range }));
      } else {
        handle.connection = createConnection();
      }
      respond([{ name: 'fn', uri, kind: 12, range, selectionRange: range }]);
      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining('prepare call hierarchy again'),
      });
    },
  );

  it('does not certify a prepare response when the target drifts during the warmup await', async () => {
    useTypescriptManager();
    const pending = service
      .prepareCallHierarchy({ uri, range })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    fs.writeFileSync(file, 'inserted\nold');
    connection.request.mockClear();
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      message: expect.stringContaining('prepare call hierarchy again'),
    });
    expect(connection.request).not.toHaveBeenCalled();
  });

  it.each(['empty result', 'request failure'])(
    'does not certify a prepare %s after a concurrent edit',
    async (change) => {
      // Sync the target first so an empty response is not retried: a preceding
      // hover makes shouldRetryAfterOpen false and reaches the post-response
      // checkpoint rather than the empty-result retry path.
      await run(service.hover({ uri, range }));
      let respond!: (value: unknown) => void;
      connection.request.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            respond =
              change === 'request failure'
                ? () => reject(new Error('server rejected'))
                : resolve;
          }),
      );
      const pending = service
        .prepareCallHierarchy({ uri, range })
        .catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      fs.writeFileSync(file, 'inserted\nold');
      await run(service.hover({ uri, range }));
      respond([]);
      await expect(pending).resolves.toMatchObject({
        message: expect.stringContaining('prepare call hierarchy again'),
      });
    },
  );

  it('rejects a restored-but-closed root traversed directly with the original token', async () => {
    const [item] = await run(service.prepareCallHierarchy({ uri, range }));
    expect(item?.documentRevision).toEqual(expect.any(String));
    // Close main.ts via a read failure, then restore it byte-identical: the
    // lifecycle retains version 1 but the document is no longer open.
    fs.unlinkSync(file);
    await expect(run(service.workspaceDiagnostics())).rejects.toThrow('ENOENT');
    fs.writeFileSync(file, 'old');
    connection.request.mockClear();
    // Traversing directly with the original token (no hover, no re-prepare) must
    // reject: the "must still be open" clause is the sole discriminator that the
    // buffer the token was signed against no longer exists on this connection.
    await expect(service.incomingCalls(item!)).rejects.toThrow(
      'prepare call hierarchy again',
    );
    expect(connection.request).not.toHaveBeenCalled();
  });

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

  it.each([{ openClose: true, change: 0 }])(
    'does not query changed text with unsupported sync %j',
    async (sync) => {
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
      await run(service.hover({ uri, range }));
      expect(connection.send).not.toHaveBeenCalled();
      fs.writeFileSync(file, 'new');
      await run(service.hover({ uri, range }));
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
        expect(await run(service.hover({ uri, range }))).toMatchObject({
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
    expect(connection.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: 'new' }],
        },
      }),
    );
  });

  it('sends the requested hover URI and start position', async () => {
    await run(service.hover({ uri, range }));
    expect(connection.requests).toEqual([
      {
        method: 'textDocument/hover',
        params: { textDocument: { uri }, position: range.start },
      },
    ]);
  });

  it('retries a failed second-document didOpen at version 1', async () => {
    await run(service.hover({ uri, range }));
    const secondFile = path.join(directory, 'other.ts');
    const secondUri = pathToFileURL(secondFile).toString();
    fs.writeFileSync(secondFile, 'second');
    connection.send.mockImplementationOnce(() => {
      throw new Error('send failed');
    });
    connection.request.mockClear();
    expect(await run(service.hover({ uri: secondUri, range }))).toBeNull();
    expect(connection.request).not.toHaveBeenCalled();
    connection.send.mockClear();
    expect(await run(service.hover({ uri: secondUri, range }))).toMatchObject({
      contents: 'second',
    });
    expect(connection.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: secondUri,
            version: 1,
            text: 'second',
            languageId: 'typescript',
          },
        },
      }),
    );
  });

  it('keeps text and versions independent for two documents on one connection', async () => {
    const secondFile = path.join(directory, 'other.ts');
    const secondUri = pathToFileURL(secondFile).toString();
    fs.writeFileSync(secondFile, 'B');
    await run(service.hover({ uri, range }));
    await run(service.hover({ uri: secondUri, range }));
    fs.writeFileSync(secondFile, 'B-two');
    await run(service.hover({ uri: secondUri, range }));
    await run(service.hover({ uri, range }));
    expect(connection.send).toHaveBeenCalledTimes(3);
    fs.writeFileSync(file, 'A-two');
    await run(service.hover({ uri, range }));
    expect(
      connection.send.mock.calls.map(([message]) => [
        message.method,
        message.params,
      ]),
    ).toEqual([
      [
        'textDocument/didOpen',
        {
          textDocument: {
            uri,
            version: 1,
            text: 'old',
            languageId: 'typescript',
          },
        },
      ],
      [
        'textDocument/didOpen',
        {
          textDocument: {
            uri: secondUri,
            version: 1,
            text: 'B',
            languageId: 'typescript',
          },
        },
      ],
      [
        'textDocument/didChange',
        {
          textDocument: { uri: secondUri, version: 2 },
          contentChanges: [{ text: 'B-two' }],
        },
      ],
      [
        'textDocument/didChange',
        {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: 'A-two' }],
        },
      ],
    ]);
  });

  it('synchronizes tracked documents before workspace diagnostics', async () => {
    await run(service.hover({ uri, range }));
    fs.writeFileSync(file, 'new');
    await run(service.workspaceDiagnostics());
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
    (service as unknown as { serverManager: LspServerManager }).serverManager =
      manager;
    vi.spyOn(manager, 'getHandles').mockReturnValue(
      new Map([
        ['test', handle],
        ['second', secondHandle],
      ]),
    );
    await run(service.hover({ uri, range }, 'test'));
    await run(service.hover({ uri, range }, 'second'));
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
    // SAFETY: Replace the fixture manager with the real manager created by the service.
    (service as unknown as { serverManager: LspServerManager }).serverManager =
      manager;
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
    expect(connection.send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: 'old' }],
        },
      }),
    );
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

  it('preserves the extension-derived language ID in a TSX-only warmup', async () => {
    fs.unlinkSync(file);
    const tsxFile = path.join(directory, 'component.tsx');
    fs.writeFileSync(tsxFile, 'component');
    useTypescriptManager();
    await run(service.workspaceSymbols('fn'));
    expect(connection.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: pathToFileURL(tsxFile).toString(),
            version: 1,
            text: 'component',
            languageId: 'typescriptreact',
          },
        },
      }),
    );
  });

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
    expect(connection.send).toHaveBeenCalledTimes(2);
    expect(connection.events.slice(-2)).toEqual([
      'textDocument/didChange',
      'workspace/symbol',
    ]);
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

  it('retains the unchanged server snapshot when only its sibling reloads', async () => {
    // SAFETY: Use real discovery/reconciliation, stubbing only process startup.
    (service as unknown as { serverManager: LspServerManager }).serverManager =
      manager;
    const configPath = path.join(directory, '.lsp.json');
    const configs = {
      first: { command: 'first' },
      second: { command: 'second' },
    };
    fs.writeFileSync(configPath, JSON.stringify(configs));
    const unchanged = createConnection();
    // SAFETY: Supply READY connections without launching processes.
    vi.spyOn(
      manager as unknown as {
        startServer(name: string, target: LspServerHandle): Promise<void>;
      },
      'startServer',
    ).mockImplementation(async (name, target) => {
      target.status = 'READY';
      target.textDocumentSync = 1;
      target.connection = name === 'second' ? unchanged : createConnection();
    });
    await service.discoverAndPrepare();
    await service.start();
    await run(service.hover({ uri, range }, 'first'));
    await run(service.hover({ uri, range }, 'second'));
    unchanged.send.mockClear();
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ...configs,
        first: { ...configs.first, settings: { changed: true } },
      }),
    );
    const result = await run(service.reinitialize());
    expect(result.reconcile).toMatchObject({
      restarted: ['first'],
      unchanged: ['second'],
    });
    expect(unchanged.send).not.toHaveBeenCalled();
    await run(service.hover({ uri, range }, 'second'));
    expect(unchanged.send).not.toHaveBeenCalled();
    fs.writeFileSync(file, 'changed');
    await run(service.hover({ uri, range }, 'second'));
    expect(unchanged.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: 'textDocument/didChange',
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: 'changed' }],
        },
      }),
    );
  });

  it.each(['warmup', 'reopen'])(
    'preserves replayed workspace snapshots after reload during %s',
    async (phase) => {
      (
        service as unknown as { serverManager: LspServerManager }
      ).serverManager = manager;
      const configPath = path.join(directory, '.lsp.json');
      fs.writeFileSync(
        configPath,
        JSON.stringify({ typescript: { command: 'typescript' } }),
      );
      const connections = [connection, createConnection()];
      vi.spyOn(
        manager as unknown as {
          startServer(name: string, target: LspServerHandle): Promise<void>;
        },
        'startServer',
      ).mockImplementation(async (_name, target) => {
        target.status = 'READY';
        target.textDocumentSync = 1;
        target.connection = connections.shift()!;
      });
      await service.discoverAndPrepare();
      await service.start();
      await run(service.hover({ uri, range }));
      const active = manager.getHandles().get('typescript')!;
      const replacement = connections[0]!;
      if (phase === 'warmup') active.warmedUp = false;
      else active.connection = createConnection();
      const obsolete = active.connection!;
      const pending = service
        .workspaceDiagnostics()
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      fs.writeFileSync(
        configPath,
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
      await vi.runAllTimersAsync();
      await reload;
      expect(await pending).toBeInstanceOf(Error);
      expect(obsolete.request).not.toHaveBeenCalledWith(
        'workspace/diagnostic',
        expect.anything(),
      );
      expect(replacement.request).not.toHaveBeenCalled();
      await run(service.hover({ uri, range }));
      expect(replacement.send).toHaveBeenCalledOnce();
    },
  );

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
      const traversal =
        method === 'incomingCalls' || method === 'outgoingCalls';
      const [oldItem] = traversal
        ? await run(service.prepareCallHierarchy({ uri, range }))
        : [];
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

      await vi.advanceTimersByTimeAsync(DEFAULT_LSP_WARMUP_DELAY_MS);
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
      if (traversal) {
        expect(stale.error).toMatchObject({
          message: expect.stringContaining('prepare call hierarchy again'),
        });
        await expect(service[method](oldItem!)).rejects.toThrow(
          'prepare call hierarchy again',
        );
      } else if (method === 'prepareCallHierarchy') {
        expect(stale.error).toMatchObject({
          message: expect.stringContaining('prepare call hierarchy again'),
        });
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
  ) {
    // SAFETY: The actual diagnostics tool path only needs these Config methods.
    const config = {
      getProjectRoot: () => directory,
      isLspEnabled: () => true,
      getLspClient: () => new NativeLspClient(service),
    } as unknown as Config;
    return new LspTool(config)
      .build({
        operation,
        ...(operation === 'diagnostics' ? { filePath: file } : {}),
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
      await run(service.hover({ uri, range }));
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
      expect(connection.send).toHaveBeenLastCalledWith(
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
      expect(connection.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          params: {
            textDocument: {
              uri,
              languageId: 'typescript',
              version: 2,
              text: 'new',
            },
          },
        }),
      );
    },
  );

  it.each([false, true])(
    'bounds consecutive read failures and preserves siblings after connection replacement: %s',
    async (replace) => {
      const other = path.join(directory, 'other.ts');
      const otherUri = pathToFileURL(other).toString();
      fs.writeFileSync(other, 'other');
      await run(service.hover({ uri, range }));
      await run(service.hover({ uri: otherUri, range }));
      const active = replace ? createConnection() : connection;
      handle.connection = active;
      fs.unlinkSync(file);
      await expect(run(service.diagnostics(uri))).rejects.toThrow('ENOENT');
      await expect(run(service.diagnostics(uri))).rejects.toThrow('ENOENT');
      await run(service.workspaceDiagnostics());
      expect(
        active.requests.some(({ method }) => method === 'workspace/diagnostic'),
      ).toBe(true);
      expect(active.send).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'textDocument/didOpen',
          params: {
            textDocument: {
              uri: otherUri,
              languageId: 'typescript',
              version: 1,
              text: 'other',
            },
          },
        }),
      );
      fs.writeFileSync(file, 'restored');
      active.send.mockClear();
      await run(service.workspaceDiagnostics());
      expect(active.send).not.toHaveBeenCalled();
      await run(service.diagnostics(uri));
      expect(active.send).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'textDocument/didOpen',
          params: {
            textDocument: {
              uri,
              languageId: 'typescript',
              version: replace ? 1 : 2,
              text: 'restored',
            },
          },
        }),
      );
    },
  );

  it('does not track an unreadable first query', async () => {
    fs.unlinkSync(file);
    await expect(run(service.diagnostics(uri))).rejects.toThrow('ENOENT');
    await run(service.workspaceDiagnostics());
    expect(connection.send).not.toHaveBeenCalled();
  });

  it('resets read failures after a successful read even when the reopen send fails', async () => {
    await run(service.hover({ uri, range }));
    fs.unlinkSync(file);
    await expect(run(service.diagnostics(uri))).rejects.toThrow('ENOENT');
    fs.writeFileSync(file, 'restored');
    connection.send.mockImplementationOnce(() => {
      throw new Error('send failed');
    });
    await expect(run(service.diagnostics(uri))).rejects.toThrow('send failed');
    fs.unlinkSync(file);
    await expect(run(service.diagnostics(uri))).rejects.toThrow('ENOENT');
    fs.writeFileSync(file, 'restored');
    connection.send.mockClear();
    await run(service.workspaceDiagnostics());
    expect(connection.send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri,
            languageId: 'typescript',
            version: 2,
            text: 'restored',
          },
        },
      }),
    );
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

  describe.each([false, true])(
    'workspace diagnostics synchronization with earlier results: %s',
    (withEarlierResults) => {
      it.each(['deleted file', 'notification failure', 'unsupported change'])(
        'rejects %s through the actual client and tool',
        async (failure) => {
          if (failure === 'unsupported change') {
            handle.textDocumentSync = { openClose: true, change: 0 };
          }
          await run(service.hover({ uri, range }));
          const earlierConnection = createConnection();
          (
            service as unknown as { serverManager: LspServerManager }
          ).serverManager = manager;
          vi.spyOn(manager, 'getHandles').mockReturnValue(
            new Map([
              ['earlier', { ...handle, connection: earlierConnection }],
              ['test', handle],
            ]),
          );
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
            await run(service.workspaceDiagnostics());
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

  it('preserves the existing workspace diagnostics request failure handling', async () => {
    await run(service.hover({ uri, range }));
    const error = new Error('unsupported workspace pull diagnostics');
    connection.request.mockRejectedValue(error);
    expect(await run(service.workspaceDiagnostics())).toEqual([]);
    expect(logger.warn).toHaveBeenLastCalledWith(
      'LSP workspace/diagnostic failed for test:',
      error,
    );
  });

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
      const traversal =
        method === 'incomingCalls' || method === 'outgoingCalls';
      const [oldItem] = traversal
        ? await run(service.prepareCallHierarchy({ uri, range }))
        : [];
      connection.request.mockClear();
      fs.unlinkSync(file);
      if (traversal) {
        await expect(service[method](oldItem!)).rejects.toThrow(
          'prepare call hierarchy again',
        );
        await expect(query(method)).rejects.toThrow();
      } else if (method === 'diagnostics') {
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
            textDocument: {
              uri,
              version: 2,
              text: 'recovered',
              languageId: 'typescript',
            },
          },
        }),
      );
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
      const second = path.join(directory, 'decl.ts');
      fs.writeFileSync(second, 'declaration');
      const secondUri = pathToFileURL(second).toString();
      await run(service.hover({ uri: secondUri, range }));
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
      const [item] = await run(service.prepareCallHierarchy({ uri, range }));
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
          (message.params as { textDocument: { uri: string } }).textDocument
            .uri,
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
      const decl = path.join(directory, 'decl.ts');
      const declUri = pathToFileURL(decl).toString();
      fs.writeFileSync(decl, '\n\nfunction current() {}');
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
      const [item] = await run(service.prepareCallHierarchy({ uri, range }));
      expect(item?.documentRevision).toBeUndefined();
      expect(connection.send).toHaveBeenCalledOnce();
      expect(connection.send).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'textDocument/didOpen',
          params: {
            textDocument: {
              uri,
              languageId: 'typescript',
              text: 'old',
              version: 1,
            },
          },
        }),
      );
      expect(connection.request).toHaveBeenCalledOnce();
      connection.request.mockClear();
      await expect(run<unknown>(service[method](item!))).rejects.toThrow(
        declUri,
      );
      expect(connection.request).not.toHaveBeenCalled();
      const [fresh] = await run(
        service.prepareCallHierarchy({ uri: declUri, range }),
      );
      expect(fresh?.documentRevision).toEqual(expect.any(String));
      await run<unknown>(service[method](fresh!));
      expect(connection.request).toHaveBeenLastCalledWith(
        `callHierarchy/${method}`,
        expect.any(Object),
      );
    },
  );

  it('names the unobserved file for a delivered-then-closed cross-file item', async () => {
    const decl = path.join(directory, 'decl.ts');
    fs.writeFileSync(decl, 'declaration');
    const declUri = pathToFileURL(decl).toString();
    // Track decl.ts, then make it unreadable so synchronization closes it while
    // retaining its lifecycle version, then restore it byte-identical.
    await run(service.hover({ uri: declUri, range }));
    fs.unlinkSync(decl);
    await expect(run(service.workspaceDiagnostics())).rejects.toThrow('ENOENT');
    fs.writeFileSync(decl, 'declaration');
    // A prepare rooted at main.ts returns a cross-file item pointing at decl.ts.
    connection.request.mockImplementation(async (name) =>
      name === 'textDocument/prepareCallHierarchy'
        ? [{ name: 'fn', kind: 12, uri: declUri, range, selectionRange: range }]
        : [],
    );
    const [item] = await run(service.prepareCallHierarchy({ uri, range }));
    expect(item?.documentRevision).toBeUndefined();
    connection.request.mockClear();
    // The rejection must name decl.ts (the item's own file) so the model prepares
    // there; a generic stale error only re-syncs main.ts and reproduces the item.
    const error = await service.incomingCalls(item!).then(
      () => undefined,
      (cause: unknown) => cause as Error,
    );
    expect(error?.message).toContain(declUri);
    expect(error?.message).toContain('prepare call hierarchy again');
    expect(connection.request).not.toHaveBeenCalled();
    // Loop exit: preparing inside decl.ts re-opens it, so traversal then succeeds.
    const [fresh] = await run(
      service.prepareCallHierarchy({ uri: declUri, range }),
    );
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
      const second = path.join(directory, 'other.ts');
      const secondUri = pathToFileURL(second).toString();
      fs.writeFileSync(second, 'other');
      await run(service.hover({ uri: secondUri, range }));
      const [item] = await run(service.prepareCallHierarchy({ uri, range }));
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
      const [item] = await run(service.prepareCallHierarchy({ uri, range }));
      (
        service as unknown as { serverManager: LspServerManager }
      ).serverManager = manager;
      const second = createConnection();
      vi.spyOn(manager, 'getHandles').mockReturnValue(
        new Map(
          count === 0
            ? []
            : [
                ['test', handle],
                ['second', { ...handle, connection: second }],
              ],
        ),
      );
      connection.request.mockClear();
      await expect(
        service[method]({ ...item!, serverName: undefined }),
      ).rejects.toThrow('prepare call hierarchy again');
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
      const [item] = await run(
        service.prepareCallHierarchy({
          uri: 'jdt://contents/Foo.class',
          range,
        }),
      );
      expect(item?.documentRevision).toBeUndefined();
      await expect(service[method](item!)).rejects.toThrow(
        'cannot be traversed',
      );
      await expect(service[method](item!)).rejects.not.toThrow(
        'prepare call hierarchy again',
      );
      expect(connection.send).not.toHaveBeenCalled();
      expect(connection.request).toHaveBeenCalledOnce();
    },
  );

  it.each(['hover', 'references', 'diagnostics'] as const)(
    'passes non-file URIs to %s without reading or notifying',
    async (method) => {
      const virtualUri = 'jdt://contents/Foo.java?=%2Fsrc';
      const read = vi.spyOn(fs, 'readFileSync');
      try {
        await run<unknown>(
          method === 'diagnostics'
            ? service.diagnostics(virtualUri)
            : service[method]({ uri: virtualUri, range }),
        );
        expect(read).not.toHaveBeenCalled();
        expect(connection.send).not.toHaveBeenCalled();
        expect(connection.request).toHaveBeenCalledWith(
          `textDocument/${method === 'diagnostics' ? 'diagnostic' : method}`,
          expect.objectContaining({ textDocument: { uri: virtualUri } }),
        );
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
        await run(service.hover({ uri, range }));
        expect(read).not.toHaveBeenCalled();
        fs.unlinkSync(file);
        await run(service.hover({ uri, range }));
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
    const discovery = vi.spyOn(
      service as unknown as {
        findWorkspaceFileForServer(handle: LspServerHandle): string | undefined;
      },
      'findWorkspaceFileForServer',
    );
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
    const discovery = vi.spyOn(
      service as unknown as {
        findWorkspaceFileForServer(handle: LspServerHandle): string | undefined;
      },
      'findWorkspaceFileForServer',
    );
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
    const replacement = createConnection();
    handle.connection = replacement;
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
    const replacement = createConnection();
    handle.connection = replacement;
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
    const discovery = vi.spyOn(
      service as unknown as {
        findWorkspaceFileForServer(handle: LspServerHandle): string | undefined;
      },
      'findWorkspaceFileForServer',
    );
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
    const discovery = vi.spyOn(
      service as unknown as {
        findWorkspaceFileForServer(handle: LspServerHandle): string | undefined;
      },
      'findWorkspaceFileForServer',
    );
    await run(service.workspaceSymbols('fn'));
    expect(discovery).toHaveBeenCalledTimes(1);
    // A runtime directory removal does not replace the connection, so the WeakMap
    // entry survives and must be revalidated against the current roots.
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-root-'));
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
      await run(service.hover({ uri, range }));
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
    connection.send.mockImplementationOnce(() => {
      throw new Error('send failed');
    });
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
      const [item] = await run(service.prepareCallHierarchy({ uri, range }));
      if (failure === 'read') fs.unlinkSync(file);
      else fs.writeFileSync(file, 'changed');
      await expect(run(service.workspaceDiagnostics())).rejects.toThrow();
      expect(connection.send).toHaveBeenLastCalledWith({
        jsonrpc: '2.0',
        method: 'textDocument/didClose',
        params: { textDocument: { uri } },
      });
      fs.writeFileSync(file, 'old');
      const [fresh] = await run(service.prepareCallHierarchy({ uri, range }));
      expect(fresh?.documentRevision).not.toBe(item?.documentRevision);
      expect(connection.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method: 'textDocument/didOpen',
          params: {
            textDocument: {
              uri,
              text: 'old',
              languageId: 'typescript',
              version: 2,
            },
          },
        }),
      );
      await expect(service.incomingCalls(item!)).rejects.toThrow(
        'prepare call hierarchy again',
      );
      await run(service.incomingCalls(fresh!));
    },
  );

  it.each(['recover', 'replace'])(
    'retries failed closes without duplicate opens then %s',
    async (action) => {
      const [item] = await run(service.prepareCallHierarchy({ uri, range }));
      fs.unlinkSync(file);
      const send = connection.send.getMockImplementation()!;
      connection.send.mockImplementation((message) => {
        if (message.method === 'textDocument/didClose')
          throw new Error('close failed');
        send(message);
      });
      await expect(run(service.workspaceDiagnostics())).rejects.toThrow(
        'ENOENT',
      );
      fs.writeFileSync(file, 'old');
      await expect(run(service.workspaceDiagnostics())).rejects.toThrow(
        /still cannot close/,
      );
      expect(await run(service.hover({ uri, range }))).toBeNull();
      expect(
        connection.send.mock.calls.filter(
          ([message]) => message.method === 'textDocument/didOpen',
        ),
      ).toHaveLength(1);
      const internals = service as unknown as {
        openedDocuments: Map<string, Map<string, unknown>>;
      };
      expect(internals.openedDocuments.get('test')?.has(uri)).toBeFalsy();
      if (action === 'recover') connection.send.mockImplementation(send);
      else handle.connection = createConnection();
      await run(service.workspaceDiagnostics());
      await run(service.hover({ uri, range }));
      await expect(service.incomingCalls(item!)).rejects.toThrow(
        'prepare call hierarchy again',
      );
      if (action === 'replace')
        expect(handle.connection!.send).not.toHaveBeenCalledWith(
          expect.objectContaining({ method: 'textDocument/didClose' }),
        );
    },
  );

  it('settles all workspace reopened documents once but not ordinary changes', async () => {
    const other = path.join(directory, 'other.ts');
    fs.writeFileSync(other, 'other');
    const otherUri = pathToFileURL(other).toString();
    await run(service.hover({ uri, range }));
    await run(service.hover({ uri: otherUri, range }));
    const replacement = createConnection();
    handle.connection = replacement;
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
    await run(service.workspaceDiagnostics());
    expect(replacement.send).toHaveBeenCalledTimes(2);
    expect(Date.now() - before).toBe(DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS);
    expect(requestedAt[0]! - sentAt[1]!).toBe(
      DEFAULT_LSP_DOCUMENT_OPEN_DELAY_MS,
    );
    expect(replacement.request).toHaveBeenCalledOnce();
    fs.writeFileSync(file, 'new');
    fs.writeFileSync(other, 'new');
    const changed = Date.now();
    await run(service.workspaceDiagnostics());
    expect(Date.now() - changed).toBe(0);
    expect(replacement.send).toHaveBeenCalledTimes(4);
    expect(requestedAt[1]! - sentAt[3]!).toBe(0);
  });

  it('delivers workspace survivors before rejecting an unreadable tracked file', async () => {
    const other = path.join(directory, 'other.ts');
    fs.writeFileSync(other, 'other');
    const otherUri = pathToFileURL(other).toString();
    // Track main.ts first, then other.ts, so main.ts is the first-tracked URI.
    await run(service.hover({ uri, range }));
    await run(service.hover({ uri: otherUri, range }));
    fs.unlinkSync(file);
    const replacement = createConnection();
    handle.connection = replacement;
    await expect(run(service.workspaceDiagnostics())).rejects.toThrow('ENOENT');
    // The survivor must still reach the replacement connection even though the
    // first-tracked file aborted its own sync; without per-URI isolation the
    // throw strands every URI queued behind it and the sweep reports clean.
    expect(
      replacement.send.mock.calls.map(([message]) => [
        message.method,
        (message.params as { textDocument: { uri: string } }).textDocument.uri,
      ]),
    ).toEqual([['textDocument/didOpen', otherUri]]);
    // A second sweep must still track the survivor rather than strand it.
    await expect(run(service.workspaceDiagnostics())).rejects.toThrow('ENOENT');
    await run(service.workspaceDiagnostics());
    const internals = service as unknown as {
      openedDocuments: Map<string, Map<string, unknown>>;
    };
    expect(internals.openedDocuments.get('test')?.has(otherUri)).toBe(true);
  });

  it('replays every tracked document after a TypeScript crash restart', async () => {
    useTypescriptManager();
    const other = path.join(directory, 'other.ts');
    fs.writeFileSync(other, 'other');
    const otherUri = pathToFileURL(other).toString();
    // Pin the warmup candidate so the assertion cannot be satisfied by the warmup
    // opening the file the durable replay set is also expected to re-deliver.
    vi.spyOn(
      manager as unknown as { findFirstTypescriptFile(): string | undefined },
      'findFirstTypescriptFile',
    ).mockReturnValue(file);
    await run(service.hover({ uri, range }));
    await run(service.hover({ uri: otherUri, range }));
    // Simulate an in-place crash restart: a new connection on the same handle and
    // a cleared warmup latch, without notifying the service.
    const replacement = createConnection();
    handle.connection = replacement;
    // An ordinary query after the restart parks the pre-swap URIs in the durable
    // set and re-opens only its own target; the sweep must replay the rest from there.
    await run(service.hover({ uri, range }));
    handle.warmedUp = false;
    await run(service.workspaceDiagnostics());
    // The warmup's own connection-change reset must not wipe the tracked set: both
    // previously tracked URIs reach the replacement before workspace/diagnostic is issued.
    const openedUris = replacement.send.mock.calls
      .filter(([message]) => message.method === 'textDocument/didOpen')
      .map(
        ([message]) =>
          (message.params as { textDocument: { uri: string } }).textDocument
            .uri,
      );
    expect(new Set(openedUris)).toEqual(new Set([uri, otherUri]));
    expect(replacement.events.indexOf('workspace/diagnostic')).toBeGreaterThan(
      replacement.events.lastIndexOf('textDocument/didOpen'),
    );
  });

  it('replays tracked documents wiped by an earlier query on a replaced connection', async () => {
    const other = path.join(directory, 'other.ts');
    fs.writeFileSync(other, 'other');
    const otherUri = pathToFileURL(other).toString();
    await run(service.hover({ uri, range }));
    await run(service.hover({ uri: otherUri, range }));
    const replacement = createConnection();
    handle.connection = replacement;
    // An ordinary non-TypeScript workspaceSymbol query on the replaced connection
    // triggers the connection-change reset; the replay set must survive it so a
    // later workspaceDiagnostics still re-opens both documents.
    await run(service.workspaceSymbols('fn'));
    await run(service.workspaceDiagnostics());
    const openedUris = replacement.send.mock.calls
      .filter(([message]) => message.method === 'textDocument/didOpen')
      .map(
        ([message]) =>
          (message.params as { textDocument: { uri: string } }).textDocument
            .uri,
      );
    expect(new Set(openedUris)).toEqual(new Set([uri, otherUri]));
  });

  it('re-delivers a URI whose first send failed on a replaced connection', async () => {
    const other = path.join(directory, 'other.ts');
    fs.writeFileSync(other, 'other');
    const otherUri = pathToFileURL(other).toString();
    await run(service.hover({ uri, range }));
    await run(service.hover({ uri: otherUri, range }));
    const replacement = createConnection();
    handle.connection = replacement;
    // The replacement connection's first didOpen throws once: the reset inside
    // workspaceDiagnostics must park the wiped URIs for the next sweep.
    replacement.send.mockImplementationOnce(() => {
      throw new Error('write EPIPE');
    });
    await expect(run(service.workspaceDiagnostics())).rejects.toThrow(
      'write EPIPE',
    );
    const afterFirst = replacement.send.mock.calls.length;
    await run(service.workspaceDiagnostics());
    expect(
      replacement.send.mock.calls
        .slice(afterFirst)
        .map(([message]) => [
          message.method,
          (message.params as { textDocument: { uri: string } }).textDocument
            .uri,
        ]),
    ).toEqual([['textDocument/didOpen', uri]]);
  });

  it('evicts a never-delivered unreadable URI so later sweeps resolve', async () => {
    const other = path.join(directory, 'other.ts');
    fs.writeFileSync(other, 'other');
    const otherUri = pathToFileURL(other).toString();
    await run(service.hover({ uri, range }));
    await run(service.hover({ uri: otherUri, range }));
    const replacement = createConnection();
    handle.connection = replacement;
    // An ordinary query parks both pre-swap URIs, then only its own target is
    // delivered; the unreadable one must be evicted instead of wedging every sweep.
    await run(service.hover({ uri: otherUri, range }));
    fs.unlinkSync(file);
    await expect(run(service.workspaceDiagnostics())).rejects.toThrow('ENOENT');
    await expect(run(service.workspaceDiagnostics())).rejects.toThrow('ENOENT');
    await run(service.workspaceDiagnostics());
    expect(replacement.requests.map(({ method }) => method)).toContain(
      'workspace/diagnostic',
    );
  });

  it('rejects workspace connection replacement during reopen settling', async () => {
    await run(service.hover({ uri, range }));
    const replacement = createConnection();
    handle.connection = replacement;
    const pending = service
      .workspaceDiagnostics()
      .catch((error: unknown) => error);
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
      const [item] = await run(service.prepareCallHierarchy({ uri, range }));
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
      const [item] = await run(service.prepareCallHierarchy({ uri, range }));
      let respond!: (value: unknown) => void;
      connection.request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            respond = resolve;
          }),
      );
      const pending = service[method](item!).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      fs.unlinkSync(file);
      await expect(run(service.workspaceDiagnostics())).rejects.toThrow(
        'ENOENT',
      );
      fs.writeFileSync(file, 'old');
      await run(service.hover({ uri, range }));
      respond([]);
      expect(await pending).toMatchObject({
        message: expect.stringContaining('prepare call hierarchy again'),
      });
    },
  );

  it.each(['incomingCalls', 'outgoingCalls'] as const)(
    'reobserves root across %s warmup awaits',
    async (method) => {
      const [item] = await run(service.prepareCallHierarchy({ uri, range }));
      useTypescriptManager();
      const pending = service[method](item!).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      fs.writeFileSync(file, 'changed during warmup');
      connection.request.mockClear();
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({
        message: expect.stringContaining('prepare call hierarchy again'),
      });
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
    const items = await run(service.prepareCallHierarchy({ uri, range }));
    expect(items).toHaveLength(2);
    expect(items[0]!.documentRevision).toBeUndefined();
    expect(items[1]!.documentRevision).toEqual(expect.any(String));
    expect(connection.request).toHaveBeenCalledOnce();
  });

  it('keeps other URI and server versions independent during close cleanup', async () => {
    const other = path.join(directory, 'other.ts');
    fs.writeFileSync(other, 'other');
    const otherUri = pathToFileURL(other).toString();
    const second = createConnection();
    (service as unknown as { serverManager: LspServerManager }).serverManager =
      manager;
    vi.spyOn(manager, 'getHandles').mockReturnValue(
      new Map([
        ['test', handle],
        ['second', { ...handle, connection: second }],
      ]),
    );
    await run(service.hover({ uri, range }, 'test'));
    await run(service.hover({ uri: otherUri, range }, 'test'));
    await run(service.hover({ uri: otherUri, range }, 'second'));
    fs.unlinkSync(file);
    await expect(run(service.workspaceDiagnostics('test'))).rejects.toThrow(
      'ENOENT',
    );
    fs.writeFileSync(other, 'changed');
    await expect(run(service.workspaceDiagnostics())).rejects.toThrow('ENOENT');
    await run(service.workspaceDiagnostics());
    for (const target of [connection, second])
      expect(target.send).toHaveBeenLastCalledWith(
        expect.objectContaining({
          method: 'textDocument/didChange',
          params: {
            textDocument: { uri: otherUri, version: 2 },
            contentChanges: [{ text: 'changed' }],
          },
        }),
      );
    expect(second.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'textDocument/didClose' }),
    );
  });
  it('retries a genuine forced No Project warmup failure without a warm latch', async () => {
    useTypescriptManager();
    await run(service.workspaceSymbols('fn'));
    connection.request.mockResolvedValueOnce({ message: 'No Project' });
    connection.send.mockImplementationOnce(() => {
      throw new Error('forced send failed');
    });
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
});
