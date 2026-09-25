/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Buffer } from 'node:buffer';
import process from 'node:process';

let buffer = Buffer.alloc(0);
const mode = process.argv[2];

function reply(id, payload) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, ...payload });
  process.stdout.write(
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function receive(message) {
  if (message.method === 'exit') process.exit(0);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    reply(message.id, { result: { capabilities: { textDocumentSync: 1 } } });
    return;
  }
  if (message.method.endsWith('/diagnostic')) {
    if (mode === 'failure') {
      reply(message.id, {
        error: { code: -32603, message: 'controlled diagnostic failure' },
      });
      return;
    }
    const items =
      mode === 'diagnostics'
        ? [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              severity: 1,
              message: 'controlled diagnostic issue',
            },
          ]
        : [];
    const result =
      message.method === 'textDocument/diagnostic'
        ? { kind: 'full', items }
        : {
            items: [
              {
                uri: pathToFileURL(join(process.cwd(), 'main.ts')).href,
                kind: 'full',
                items,
              },
            ],
          };
    reply(message.id, { result });
    return;
  }
  reply(message.id, { result: null });
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const length = Number(
      /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())?.[1],
    );
    if (!length || buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length);
    buffer = buffer.subarray(end + 4 + length);
    receive(JSON.parse(body.toString()));
  }
});
