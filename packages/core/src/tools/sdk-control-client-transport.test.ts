/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { SdkControlClientTransport } from './sdk-control-client-transport.js';

describe('SdkControlClientTransport cancellation', () => {
  it.each(['response', 'error'] as const)(
    'keeps the MCP client usable after a cancelled call finishes with %s',
    async (completion) => {
      let finishCall: (() => void) | undefined;
      let started: (() => void) | undefined;
      const callStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const transport = new SdkControlClientTransport({
        serverName: 'desktop-node-repl',
        sendMcpMessage: async (_server, message): Promise<JSONRPCMessage> => {
          if (
            'method' in message &&
            message.method === 'tools/call' &&
            'id' in message
          ) {
            return new Promise((resolve, reject) => {
              finishCall = () =>
                completion === 'error'
                  ? reject(new Error('late control-plane timeout'))
                  : resolve({
                      jsonrpc: '2.0',
                      id: message.id,
                      error: { code: -32800, message: 'Request cancelled' },
                    });
              started?.();
            });
          }
          if (
            'method' in message &&
            message.method === 'notifications/cancelled'
          )
            finishCall?.();
          if ('id' in message && 'method' in message) {
            return {
              jsonrpc: '2.0',
              id: message.id,
              result:
                message.method === 'initialize'
                  ? {
                      protocolVersion: '2025-06-18',
                      capabilities: { tools: {} },
                      serverInfo: { name: 'desktop', version: '1' },
                    }
                  : { tools: [] },
            };
          }
          return { jsonrpc: '2.0', id: 0, result: {} };
        },
      });
      const client = new Client({ name: 'acceptance', version: '1' });
      const onerror = vi.fn();
      client.onerror = onerror;
      try {
        await client.connect(transport);
        const controller = new AbortController();
        const call = client.callTool(
          { name: 'node_repl', arguments: {} },
          undefined,
          { signal: controller.signal },
        );
        const cancelled = call.catch((error: unknown) => error);
        await callStarted;
        controller.abort();
        expect(await cancelled).toBeInstanceOf(Error);
        expect(await client.listTools()).toEqual({ tools: [] });
        expect(onerror).not.toHaveBeenCalled();
      } finally {
        await client.close();
      }
    },
  );
});
