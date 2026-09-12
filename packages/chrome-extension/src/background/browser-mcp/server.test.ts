/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserMcpServer, type BrowserToolHandler } from './server.js';

describe('BrowserMcpServer', () => {
  let handler: BrowserToolHandler;
  let server: BrowserMcpServer;

  beforeEach(() => {
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '1.2.3' }) },
    });
    handler = {
      tools: [
        {
          name: 'take_snapshot',
          description: 'Read the page',
          inputSchema: { type: 'object' },
        },
      ],
      callTool: vi.fn(
        async (name): Promise<import('./server.js').BrowserToolResult> => ({
          content: [{ type: 'text', text: `called ${name}` }],
        }),
      ),
    };
    server = new BrowserMcpServer(handler);
  });

  it('completes the MCP initialize handshake', async () => {
    await expect(
      server.handleMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26' },
      }),
    ).resolves.toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'qwen-browser-tools', version: '1.2.3' },
      },
    });
  });

  it('lists and calls tools', async () => {
    const list = await server.handleMessage({
      jsonrpc: '2.0',
      id: 'list',
      method: 'tools/list',
    });
    expect(list).toMatchObject({
      result: { tools: [{ name: 'take_snapshot' }] },
    });

    const call = await server.handleMessage({
      jsonrpc: '2.0',
      id: 'call',
      method: 'tools/call',
      params: { name: 'take_snapshot', arguments: {} },
    });
    expect(handler.callTool).toHaveBeenCalledWith('take_snapshot', {});
    expect(call).toMatchObject({
      result: { content: [{ type: 'text', text: 'called take_snapshot' }] },
    });
  });

  it('returns protocol errors without throwing', async () => {
    await expect(server.handleMessage({ bad: true })).resolves.toMatchObject({
      error: { code: -32600 },
    });
    await expect(
      server.handleMessage({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 42 },
      }),
    ).resolves.toMatchObject({ error: { code: -32602 } });
  });

  it('does not answer notifications', async () => {
    await expect(
      server.handleMessage({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    ).resolves.toBeNull();
  });
});
