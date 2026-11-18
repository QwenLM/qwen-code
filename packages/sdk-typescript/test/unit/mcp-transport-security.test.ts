/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, it, vi } from 'vitest';

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

it.each([false, true])(
  'MCP HTTP redirects keep credentials within the endpoint origin (cross-origin=%s)',
  async (crossOrigin) => {
    const captured = vi.fn();
    const sink = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      captured(req.headers['x-api-key'], body);
      res.writeHead(202).end();
    });
    const sinkUrl = await listen(sink);
    const endpoint = createServer(async (req, res) => {
      if (req.url === '/target') {
        let body = '';
        for await (const chunk of req) body += chunk;
        captured(req.headers['x-api-key'], body);
        res.writeHead(202).end();
      } else {
        req.resume();
        res
          .writeHead(307, {
            location: crossOrigin ? `${sinkUrl}/target` : '/target',
          })
          .end();
      }
    });
    const endpointUrl = await listen(endpoint);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${endpointUrl}/mcp`),
      { requestInit: { headers: { 'X-API-Key': 'synthetic-test-key' } } },
    );
    transport.onerror = () => {};
    const message = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'redirect-test', version: '1' },
      },
    };
    try {
      if (crossOrigin) {
        await expect(transport.send(message)).rejects.toThrow();
        expect(captured).not.toHaveBeenCalled();
      } else {
        await expect(transport.send(message)).resolves.toBeUndefined();
        expect(captured).toHaveBeenCalledOnce();
        expect(captured).toHaveBeenCalledWith(
          'synthetic-test-key',
          JSON.stringify(message),
        );
      }
    } finally {
      await transport.close();
      await Promise.all([close(endpoint), close(sink)]);
    }
  },
);
