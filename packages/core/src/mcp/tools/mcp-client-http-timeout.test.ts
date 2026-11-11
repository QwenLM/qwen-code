/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTransport } from '../connector/connectMcpServer.js';
import { McpClientContext } from '../mcpClientContext.js';
import {
  _resetProxyForTesting,
  updateGlobalFetchTimeouts,
} from '../../utils/fetch.js';

const EMPTY_CONTEXT = new McpClientContext({
  sanitizationConfig: {
    enableEnvironmentVariableRedaction: true,
    allowedEnvironmentVariables: [],
    blockedEnvironmentVariables: [],
  },
  emitDiagnostic: vi.fn(),
  isTrustedFolder: () => true,
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<{
  id?: string | number;
  method?: string;
}> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function writeJson(
  res: http.ServerResponse,
  payload: unknown,
): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

describe('MCP HTTP transport fetch timeout', () => {
  afterEach(() => {
    updateGlobalFetchTimeouts(300_000);
    _resetProxyForTesting();
  });

  it('does not inherit the shorter global undici headers timeout for long tool calls', async () => {
    updateGlobalFetchTimeouts(25);

    const seenMethods: string[] = [];
    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(405).end();
        return;
      }

      const message = await readJsonBody(req);
      if (message.id === undefined || message.id === null) {
        res.writeHead(202).end();
        return;
      }

      seenMethods.push(message.method ?? '');

      if (message.method === 'initialize') {
        writeJson(res, {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'slow-mcp-test', version: '1.0.0' },
          },
        });
        return;
      }

      if (message.method === 'tools/list') {
        writeJson(res, {
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
        return;
      }

      if (message.method === 'tools/call') {
        setTimeout(() => {
          writeJson(res, {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              content: [{ type: 'text', text: 'done after delayed headers' }],
            },
          });
        }, 80);
        return;
      }

      writeJson(res, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      });
    });

    const port = await listen(server);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = await createTransport(
      'slow-http-server',
      { url: `http://127.0.0.1:${port}/mcp`, type: 'http' },
      false,
      EMPTY_CONTEXT,
    );

    try {
      await client.connect(transport, { timeout: 1_000 });
      const result = await client.callTool(
        { name: 'slowTool', arguments: {} },
        undefined,
        { timeout: 5_000 },
      );

      expect(result.content).toEqual([
        { type: 'text', text: 'done after delayed headers' },
      ]);
      expect(seenMethods).toContain('tools/call');
    } finally {
      await client.close().catch(() => undefined);
      await closeServer(server);
    }
  });
});
