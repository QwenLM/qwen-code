/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_MCP_SERVER_NAME,
  registerBrowserMcp,
  routeBrowserMcpFrame,
} from './connection.js';
import { BrowserMcpServer } from './server.js';

describe('browser MCP WebSocket routing', () => {
  it('answers discovery requests before the registration ack arrives', async () => {
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '1.0.0' }) },
    });
    const server = new BrowserMcpServer({
      tools: [
        {
          name: 'take_snapshot',
          description: 'Read the page',
          inputSchema: { type: 'object' },
        },
      ],
      callTool: vi.fn(),
    });
    const send = vi.fn();

    registerBrowserMcp(send);
    await routeBrowserMcpFrame(
      server,
      {
        type: 'mcp_message',
        id: 'discovery-1',
        server: BROWSER_MCP_SERVER_NAME,
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      },
      send,
    );

    expect(send).toHaveBeenNthCalledWith(1, {
      type: 'mcp_register',
      server: BROWSER_MCP_SERVER_NAME,
    });
    expect(send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'mcp_message',
        id: 'discovery-1',
        payload: expect.objectContaining({
          result: {
            tools: [expect.objectContaining({ name: 'take_snapshot' })],
          },
        }),
      }),
    );
  });
});
