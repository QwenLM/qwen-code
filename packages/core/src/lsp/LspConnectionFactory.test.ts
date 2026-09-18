/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { LspConnectionFactory } from './LspConnectionFactory.js';

type StubServer = Awaited<
  ReturnType<typeof LspConnectionFactory.createStdioConnection>
>;

/** Writes are spaced out so the pipe cannot coalesce them into a single read. */
const CHUNK_GAP_MS = 20;
/** Must stay below the 15s LSP request timeout so a dropped frame is visible. */
const FRAME_DEADLINE_MS = 3000;
const TEST_TIMEOUT_MS = 10000;

const stubServers: StubServer[] = [];

afterEach(() => {
  for (const server of stubServers.splice(0)) {
    server.connection.end();
    server.process?.kill();
  }
});

/** Frames a JSON-RPC body exactly the way a real LSP server does. */
function frame(body: string): Buffer {
  const payload = Buffer.from(body, 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, 'utf8'),
    payload,
  ]);
}

/**
 * `node -e` payload for a stub LSP server: it waits for the client's first
 * request, then writes `chunks` to stdout one write per chunk.
 */
function stubServerScript(chunks: Buffer[]): string {
  return [
    `const chunks = ${JSON.stringify(chunks.map((chunk) => Array.from(chunk)))};`,
    'let emitting = false;',
    'const emit = () => {',
    '  if (emitting) return;',
    '  emitting = true;',
    '  chunks.forEach((bytes, index) => {',
    `    setTimeout(() => process.stdout.write(Buffer.from(bytes)), index * ${CHUNK_GAP_MS});`,
    '  });',
    '};',
    "process.stdin.on('data', emit);",
  ].join('\n');
}

async function startStubServer(chunks: Buffer[]): Promise<StubServer> {
  const server = await LspConnectionFactory.createStdioConnection(
    process.execPath,
    ['-e', stubServerScript(chunks)],
  );
  stubServers.push(server);
  return server;
}

/**
 * Awaits a request, but fails with a framing-specific error instead of hanging
 * until the LSP request timeout when the response frame is never parsed.
 */
async function awaitFrame<T>(request: Promise<T>): Promise<T> {
  void request.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `response frame was never parsed within ${FRAME_DEADLINE_MS}ms`,
          ),
        ),
      FRAME_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const DOCUMENT_SYMBOLS = { symbols: [{ name: '标题甲' }] };
const SYMBOLS_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result: DOCUMENT_SYMBOLS,
});

describe('LspConnectionFactory', () => {
  it('captures stderr and exit code when stdio server closes during initialize', async () => {
    const connection = await LspConnectionFactory.createStdioConnection(
      process.execPath,
      [
        '-e',
        'process.stderr.write("clangd failed before initialize\\n"); process.exit(7);',
      ],
    );

    await expect(connection.connection.initialize({})).rejects.toThrow(
      'LSP connection closed',
    );

    if (!connection.processDiagnostics) {
      throw new Error('Expected process diagnostics for stdio connection');
    }
    const diagnostics = connection.processDiagnostics;

    expect(diagnostics.stderrTail).toContain('clangd failed before initialize');
    expect(diagnostics.exitCode).toBe(7);
    expect(diagnostics.exitSignal).toBeNull();
  });

  it('preserves UTF-8 characters split across stderr chunks', async () => {
    const connection = await LspConnectionFactory.createStdioConnection(
      process.execPath,
      [
        '-e',
        [
          'process.stderr.write(Buffer.from([0xe2]));',
          'setTimeout(() => {',
          'process.stderr.write(Buffer.from([0x98, 0x83, 0x0a]));',
          'process.exit(7);',
          '}, 10);',
        ].join(''),
      ],
    );

    await expect(connection.connection.initialize({})).rejects.toThrow(
      'LSP connection closed',
    );

    expect(connection.processDiagnostics?.stderrTail).toContain('☃');
  });

  describe('JSON-RPC framing', () => {
    it(
      'parses a response whose body contains non-ASCII characters',
      async () => {
        const server = await startStubServer([frame(SYMBOLS_BODY)]);

        const result = await awaitFrame(server.connection.initialize({}));

        expect(result).toEqual(DOCUMENT_SYMBOLS);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'parses a body whose multi-byte character is split across chunks',
      async () => {
        const bytes = frame(SYMBOLS_BODY);
        // Lead byte of the three-byte UTF-8 sequence for 标; the ASCII framing
        // around it contains no byte >= 0x80, so this is the body's first one.
        const leadByte = bytes.indexOf(0xe6);
        expect(leadByte).toBeGreaterThan(0);

        const server = await startStubServer([
          bytes.subarray(0, leadByte + 1),
          bytes.subarray(leadByte + 1),
        ]);

        const result = await awaitFrame(server.connection.initialize({}));

        expect(result).toEqual(DOCUMENT_SYMBOLS);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'parses several non-ASCII frames delivered in a single chunk',
      async () => {
        const notifications: unknown[] = [];
        const server = await startStubServer([
          Buffer.concat([
            frame(
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'window/logMessage',
                params: { type: 3, message: '日志：标题甲' },
              }),
            ),
            frame(SYMBOLS_BODY),
          ]),
        ]);
        server.connection.onNotification((notification) =>
          notifications.push(notification),
        );

        const result = await awaitFrame(server.connection.initialize({}));

        expect(result).toEqual(DOCUMENT_SYMBOLS);
        expect(notifications).toEqual([
          {
            jsonrpc: '2.0',
            method: 'window/logMessage',
            params: { type: 3, message: '日志：标题甲' },
          },
        ]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'parses an ASCII frame delivered as several partial chunks',
      async () => {
        const bytes = frame(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { symbols: [{ name: 'hello' }] },
          }),
        );
        const headerEnd = bytes.indexOf(Buffer.from('\r\n\r\n', 'utf8')) + 4;

        const server = await startStubServer([
          bytes.subarray(0, headerEnd - 3),
          bytes.subarray(headerEnd - 3, headerEnd + 5),
          bytes.subarray(headerEnd + 5),
        ]);

        const result = await awaitFrame(server.connection.initialize({}));

        expect(result).toEqual({ symbols: [{ name: 'hello' }] });
      },
      TEST_TIMEOUT_MS,
    );
  });
});
