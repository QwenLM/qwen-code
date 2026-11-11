/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import readline from 'node:readline';

const pendingCalls = new Map();
const initializeDelayMs = Number.parseInt(
  process.env['MCP_TIMEOUT_FIXTURE_INITIALIZE_DELAY'] ?? '0',
  10,
);
const listDelayMs = Number.parseInt(
  process.env['MCP_TIMEOUT_FIXTURE_LIST_DELAY'] ?? '0',
  10,
);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);

  if (message.method === 'initialize') {
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'timeout-test', version: '1.0.0' },
        },
      });
    }, initializeDelayMs);
    return;
  }

  if (message.method === 'tools/list') {
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: [
            {
              name: 'slowTool',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        },
      });
    }, listDelayMs);
    return;
  }

  if (message.method === 'tools/call') {
    const timer = setTimeout(() => {
      pendingCalls.delete(message.id);
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: 'too late' }] },
      });
    }, 5_000);
    pendingCalls.set(message.id, timer);
    return;
  }

  if (message.method === 'notifications/cancelled') {
    const timer = pendingCalls.get(message.params?.requestId);
    if (timer) {
      clearTimeout(timer);
      pendingCalls.delete(message.params.requestId);
    }
  }
});

lines.on('close', () => {
  for (const timer of pendingCalls.values()) clearTimeout(timer);
});
