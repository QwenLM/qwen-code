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
import {
  DEFAULT_LSP_WARMUP_DELAY_MS,
  DEFAULT_LSP_WORKSPACE_SYMBOL_WARMUP_DELAY_MS,
} from './constants.js';
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
  async function query(
    method: (typeof queryMethods)[number],
  ): Promise<unknown> {
    if (method === 'documentSymbols' || method === 'diagnostics')
      return service[method](uri);
    if (method === 'codeActions')
      return service.codeActions(uri, range, { diagnostics: [] });
    if (method === 'incomingCalls' || method === 'outgoingCalls') {
      const items = await service.prepareCallHierarchy({ uri, range });
      return items[0] ? service[method](items[0]) : [];
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

  it.each(['incomingCalls', 'outgoingCalls'] as const)(
    'rejects a line-shifted prepared item before %s, including sibling sync',
    async (method) => {
      for (const sibling of [false, true]) {
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
      }
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

  it.each(['incomingCalls', 'outgoingCalls'] as const)(
    'rejects in-flight %s responses after sync, deletion or connection removal',
    async (method) => {
      for (const change of [
        'edit',
        'delete',
        'disconnect',
        'request failure',
      ]) {
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
      }
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
      expect(connection.send).toHaveBeenCalledTimes(sends);
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

  it.each([0, undefined, {}, { openClose: false, change: 0 }])(
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
          if (withEarlierResults) {
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
              items: [
                {
                  uri,
                  kind: 'full',
                  items: [
                    { range, severity: 1, message: 'earlier diagnostic' },
                  ],
                },
              ],
            });
          }
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
            new NativeLspClient(service).workspaceDiagnostics(),
          ).rejects.toThrow(message);
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
            withEarlierResults ? 2 : 0,
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
