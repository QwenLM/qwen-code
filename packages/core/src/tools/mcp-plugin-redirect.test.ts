/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/client';
import { afterEach, expect, it, vi } from 'vitest';
import { MCPOAuthTokenStorage } from '../mcp/oauth-token-storage.js';
import { _setMcpFetchForTest, createTransport } from './mcp-client.js';

afterEach(() => {
  _setMcpFetchForTest(undefined);
  vi.restoreAllMocks();
});

it.each([true, false])(
  'keeps the Agent Plugin GET redirect policy in the actual transport (plugin=%s)',
  async (plugin) => {
    vi.spyOn(
      MCPOAuthTokenStorage.prototype,
      'getCredentials',
    ).mockResolvedValue(null);
    _setMcpFetchForTest(globalThis.fetch.bind(globalThis));
    const requests: string[] = [];
    const credentials: Array<string | undefined> = [];
    const errors: string[] = [];
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const server = createServer(async (req, res) => {
      requests.push(`${req.method} ${req.url}`);
      credentials.push(req.headers['x-api-key'] as string | undefined);
      if (req.method === 'GET') {
        if (req.url === '/mcp') {
          res.writeHead(307, { Location: '/redirect-target' }).end();
        } else {
          res.writeHead(405).end();
          settle();
        }
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      if (message.method === 'initialize') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              serverInfo: { name: 'redirect-test', version: '1' },
            },
          }),
        );
      } else res.writeHead(202).end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const client = new Client({ name: 'redirect-client', version: '1' });
    client.onerror = (error) => {
      errors.push(error.message);
      settle();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const transport = await createTransport(
        'plugin-redirect-regression',
        {
          httpUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
          headers: { 'X-Api-Key': 'synthetic-test-key' },
          ...(plugin ? { agentPluginV1: true } : {}),
        },
        false,
      );
      await client.connect(transport);
      await Promise.race([
        settled,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('GET did not settle')),
            5_000,
          );
        }),
      ]);
      expect(requests).toEqual([
        'POST /mcp',
        'POST /mcp',
        'GET /mcp',
        ...(plugin ? [] : ['GET /redirect-target']),
      ]);
      expect(credentials).toEqual(requests.map(() => 'synthetic-test-key'));
      if (plugin) expect(errors.join(' ')).toContain('not followed');
      else expect(errors).toEqual([]);
    } finally {
      clearTimeout(timer);
      await client.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  },
);
