/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeLspService } from './native-lsp-service.js';
import { NativeLspClient } from './NativeLspClient.js';
import {
  LspConnectionFactory,
  LspJsonRpcError,
} from './LspConnectionFactory.js';
import { LspTool } from '../tools/lsp.js';
import type { LspServerManager } from './lsp-server-manager.js';
import type { Config } from '../config/config.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import type { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { IdeContextStore } from '../ide/ideContext.js';
import type { LspConnectionInterface, LspServerConfig } from './types.js';

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

let directory: string;
let service: NativeLspService;
let manager: LspServerManager;
const connections: LspConnectionInterface[] = [];
const fullPull = { interFileDependencies: false, workspaceDiagnostics: true };

beforeEach(() => {
  vi.useFakeTimers();
  directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'qwen-diagnostics-issues-'),
  );
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
  connections.length = 0;
  vi.spyOn(LspConnectionFactory, 'createSocketConnection').mockImplementation(
    async () =>
      ({
        connection: connections.shift()!,
      }) as Awaited<
        ReturnType<typeof LspConnectionFactory.createSocketConnection>
      >,
  );
});

afterEach(async () => {
  await manager.stopAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});

function connection(diagnosticProvider: unknown = fullPull) {
  return {
    listen: vi.fn(),
    send: vi.fn(),
    onNotification: vi.fn(),
    onRequest: vi.fn(),
    initialize: vi.fn(async () => ({
      capabilities: {
        textDocumentSync: 0,
        ...(diagnosticProvider === null ? {} : { diagnosticProvider }),
      },
    })),
    shutdown: vi.fn(async () => {}),
    end: vi.fn(),
    request: vi.fn(
      async (method: string): Promise<unknown> =>
        method === 'textDocument/diagnostic'
          ? { kind: 'full', items: [] }
          : { items: [] },
    ),
  };
}

async function start(
  rows: Array<{
    name?: string;
    language: string;
    connection: ReturnType<typeof connection>;
    mapping?: Record<string, string>;
    failed?: boolean;
  }>,
) {
  connections.push(...rows.map((row) => row.connection));
  manager.setServerConfigs(
    rows.map(
      (row, index): LspServerConfig => ({
        name: row.name ?? `server-${index}`,
        languages: [row.language],
        transport: 'socket',
        socket: { port: 12000 + index },
        rootUri: pathToFileURL(directory).toString(),
        extensionToLanguage: row.mapping,
      }),
    ),
  );
  await manager.startAll();
  for (const [index, row] of rows.entries()) {
    const handle = manager.getHandles().get(row.name ?? `server-${index}`)!;
    expect(handle.status).toBe('READY');
    if (row.failed) {
      handle.status = 'FAILED';
      handle.error = new Error('fixture unavailable');
    }
  }
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const result = await settled;
  if ('error' in result) throw result.error;
  return result.value;
}

async function document(fileName: string) {
  const filePath = path.join(directory, fileName);
  fs.writeFileSync(filePath, 'fixture');
  const tool = new LspTool({
    getProjectRoot: () => directory,
    isLspEnabled: () => true,
    getLspClient: () => new NativeLspClient(service),
  } as unknown as Config);
  return settle(
    tool
      .build({ operation: 'diagnostics', filePath })
      .execute(new AbortController().signal),
  );
}

describe('diagnostic ownership from explicit declarations', () => {
  it.each([
    'main.ps1',
    'main.unknown',
    'main.sql',
    'main.custom',
    'Dockerfile',
  ])(
    'characterization: preserves the documented unknown-extension fallback for %s',
    async (fileName) => {
      await start([{ language: 'python', connection: connection() }]);
      const result = await document(fileName);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('No diagnostics found');
    },
  );

  it.each(['main.custom', 'main.sql'])(
    'accepts an explicit owner despite a failed foreign sibling for %s',
    async (fileName) => {
      await start([
        {
          language: 'remote-lsp',
          mapping: { [path.extname(fileName)]: 'custom' },
          connection: connection(),
        },
        { language: 'python', connection: connection(), failed: true },
      ]);
      expect((await document(fileName)).error).toBeUndefined();
    },
  );

  it.each([
    'bicep',
    'cmake',
    'graphql',
    'less',
    'nim',
    'nix',
    'prisma',
    'scss',
    'sql',
    'toml',
  ])(
    'accepts self-naming %s ownership omitted from the attribution allowlist',
    async (language) => {
      const unsupported = connection();
      unsupported.request.mockRejectedValue(
        new LspJsonRpcError('Method not found', -32601),
      );
      await start([
        { language, connection: connection() },
        {
          language: 'remote-lsp',
          mapping: { [`.${language}`]: language },
          connection: unsupported,
        },
      ]);
      const result = await document(`schema.${language}`);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('No diagnostics found');
    },
  );

  it.each(['main.constructor', 'main.__proto__'])(
    'does not treat inherited mapping key %s as attributable',
    async (fileName) => {
      await start([
        { language: 'typescript', connection: connection() },
        {
          language: 'remote-lsp',
          mapping: { '.custom': 'custom' },
          connection: connection(),
        },
      ]);
      const result = await document(fileName);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('No diagnostics found');
    },
  );

  it.each([
    ['typescript', 'main.mts'],
    ['typescript', 'main.cts'],
    ['javascript', 'main.mjs'],
    ['javascript', 'main.cjs'],
    ['cpp', 'main.h'],
    ['cpp', 'main.hpp'],
    ['cpp', 'main.cc'],
    ['cpp', 'main.cxx'],
    ['cpp', 'main.cu'],
    ['c', 'main.h'],
    ['python', 'main.pyi'],
    ['objective-c', 'main.h'],
    ['objectivec', 'main.h'],
    ['swift', 'main.h'],
    ['javascriptreact', 'main.mjs'],
    ['javascriptreact', 'main.cjs'],
  ])(
    'keeps a failed %s owner as a veto for mapped %s',
    async (language, fileName) => {
      await start([
        { language, connection: connection(), failed: true },
        {
          language: 'remote-lsp',
          mapping: { [path.extname(fileName)]: 'custom' },
          connection: connection(),
        },
      ]);
      expect((await document(fileName)).error?.message).toContain('server-0');
    },
  );

  it.each([
    ['objective-c', 'main.h'],
    ['objectivec', 'main.h'],
    ['swift', 'main.h'],
    ['javascriptreact', 'main.mjs'],
    ['javascriptreact', 'main.cjs'],
  ])(
    'keeps a clean answer from the real %s owner for %s',
    async (language, fileName) => {
      await start([{ language, connection: connection() }]);
      const result = await document(fileName);
      expect(result.error).toBeUndefined();
      expect(result.llmContent).toContain('No diagnostics found');
    },
  );

  it('accepts the TypeScript owner despite a foreign .mts refusal', async () => {
    const unsupported = connection();
    unsupported.request.mockRejectedValue(
      new LspJsonRpcError('Method not found', -32601),
    );
    await start([
      { language: 'typescript', connection: connection() },
      {
        language: 'remote-lsp',
        mapping: { '.mts': 'custom-mts' },
        connection: unsupported,
      },
    ]);
    expect((await document('main.mts')).error).toBeUndefined();
  });

  it('matches ownership to an untrimmed mapping key', async () => {
    await start([
      {
        language: 'remote-lsp',
        mapping: { '. csv': 'custom' },
        connection: connection(),
      },
    ]);
    const result = await document('report. csv');
    expect(result.error).toBeUndefined();
    expect(result.llmContent).toContain('No diagnostics found');
  });

  it('accepts a dotless mapping key from the config loader', async () => {
    await start([
      {
        language: 'remote-lsp',
        mapping: { custom: 'custom' },
        connection: connection(),
      },
      { language: 'python', connection: connection(), failed: true },
    ]);
    expect((await document('main.custom')).error).toBeUndefined();
  });

  it('reports an answering foreign server as unattributed', async () => {
    await start([
      {
        language: 'remote-lsp',
        mapping: { '.custom': 'custom' },
        connection: connection(),
      },
    ]);
    expect((await document('main.ts')).error?.message).toContain(
      'could not be attributed',
    );
  });

  it('preserves the veto of an unnormalized language declaration', async () => {
    await start([
      { language: 'typescript', connection: connection() },
      { language: 'Python ', connection: connection(), failed: true },
    ]);
    expect((await document('main.ts')).error?.message).toContain('server-1');
  });

  it.each([' Python', 'Py thon', 'Python\t'])(
    'keeps malformed whitespace language declaration %j conservative',
    async (language) => {
      await start([
        { language: 'typescript', connection: connection() },
        { language, connection: connection(), failed: true },
      ]);
      expect((await document('main.ts')).error?.message).toContain('server-1');
    },
  );

  it('does not let a failed explicitly mapped server veto the TypeScript owner', async () => {
    await start([
      { language: 'typescript', connection: connection() },
      {
        language: 'remote-lsp',
        mapping: { '.custom': 'custom' },
        connection: connection(),
        failed: true,
      },
    ]);
    expect((await document('main.ts')).error).toBeUndefined();
  });

  it('does not normalize mapping keys or values beyond document synchronization', async () => {
    await start([
      {
        language: 'remote-lsp',
        mapping: { ' .CUSTOM ': ' TypeScript ' },
        connection: connection(),
      },
      { language: 'python', connection: connection(), failed: true },
    ]);
    expect((await document('main.custom')).error).toBeDefined();
    expect((await document('main.ts')).error).toBeDefined();
  });

  it.each([true, false])(
    'accounts for an explicit owner added during a pull (supports pull: %s)',
    async (supportsPull) => {
      const original = connection();
      const owner = connection();
      if (!supportsPull) {
        owner.request.mockRejectedValue(
          new LspJsonRpcError('Method not found', -32601),
        );
      }
      await start([{ language: 'remote-lsp', connection: original }]);
      const handles = new Map(manager.getHandles());
      vi.spyOn(manager, 'getHandles').mockReturnValue(handles);
      original.request.mockImplementationOnce(async () => {
        handles.set('late-owner', {
          config: {
            name: 'late-owner',
            languages: ['custom'],
            transport: 'socket',
            socket: { port: 12002 },
            rootUri: pathToFileURL(directory).toString(),
            extensionToLanguage: { '.custom': 'custom' },
          },
          status: 'READY',
          connection: owner,
          textDocumentSync: 0,
        });
        return { kind: 'full', items: [] };
      });
      const result = await document('main.custom');
      expect(owner.request).toHaveBeenCalledWith(
        'textDocument/diagnostic',
        expect.anything(),
      );
      if (supportsPull) {
        expect(result.error).toBeUndefined();
      } else {
        expect(result.error?.message).toContain('late-owner');
        expect(result.llmContent).not.toContain('No diagnostics found');
      }
    },
  );

  it('keeps an unknown failed server as a veto for an explicitly mapped file', async () => {
    await start([
      {
        language: 'remote-lsp',
        mapping: { '.custom': 'custom' },
        connection: connection(),
      },
      {
        name: 'unknown-server',
        language: 'unknown-server',
        connection: connection(),
        failed: true,
      },
    ]);
    expect((await document('main.custom')).error?.message).toContain(
      'unknown-server',
    );
  });

  it('does not infer custom ownership from an unrecognized language ID', async () => {
    await start([
      { name: 'custom', language: 'custom', connection: connection() },
      {
        language: 'remote-lsp',
        mapping: { '.custom': 'custom' },
        connection: connection(),
      },
    ]);
    // The explicit mapping makes this extension attributable, but the selected
    // server's language ID alone is not evidence that it owns the file.
    const filePath = path.join(directory, 'main.custom');
    fs.writeFileSync(filePath, 'fixture');
    await expect(
      settle(service.diagnostics(pathToFileURL(filePath).toString(), 'custom')),
    ).rejects.toThrow('could not be attributed');
  });

  it.each([
    ['typescript', 'main.go'],
    ['lua', 'main.ts'],
    ['javascript', 'main.ts'],
    ['remote-lsp', 'main.ts'],
  ])('control: refuses %s backing %s', async (language, fileName) => {
    await start([{ language, connection: connection() }]);
    expect((await document(fileName)).error).toBeDefined();
  });

  it('control: failed python does not veto a clean go owner', async () => {
    await start([
      { language: 'go', connection: connection() },
      { language: 'python', connection: connection(), failed: true },
    ]);
    expect((await document('main.go')).error).toBeUndefined();
  });
});
