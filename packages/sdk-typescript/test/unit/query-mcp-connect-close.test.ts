/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { Query } from '../../src/query/Query.js';
import type { Transport } from '../../src/transport/Transport.js';
import { Stream } from '../../src/utils/Stream.js';

class ReadyTransport implements Transport {
  private readonly messages = new Stream<unknown>();
  isReady = true;
  exitError = null;

  write(line: string): void {
    const request = JSON.parse(line) as { request_id: string };
    this.messages.enqueue({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.request_id,
        response: {},
      },
    });
  }

  async *readMessages(): AsyncGenerator<unknown> {
    yield* this.messages;
  }

  async close(): Promise<void> {
    this.messages.done();
  }

  async waitForExit(): Promise<void> {}
  endInput(): void {}
}

describe('SDK MCP connections during query shutdown', () => {
  it.each(['close', 'abort'] as const)(
    'closes a connection that completes after %s',
    async (shutdown) => {
      const server = new McpServer({ name: 'delayed', version: '1.0.0' });
      const connect = server.connect.bind(server);
      let release!: () => void;
      const connecting = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(server, 'connect').mockImplementation(async (transport) => {
        await connecting;
        await connect(transport);
      });
      const abortController = new AbortController();
      const query = new Query(new ReadyTransport(), {
        abortController,
        mcpServers: {
          delayed: { type: 'sdk', name: 'delayed', instance: server },
        },
      });

      try {
        if (shutdown === 'abort') abortController.abort();
        await query.close();
        release();
        await expect(query.initialized).rejects.toThrow('Query is closed');
        expect(server.isConnected()).toBe(false);
      } finally {
        release();
        await query.close();
        await server.close();
      }
    },
  );

  it('keeps a successful server connected until its query closes', async () => {
    const server = new McpServer({ name: 'ready', version: '1.0.0' });
    const query = new Query(new ReadyTransport(), {
      mcpServers: { ready: { type: 'sdk', name: 'ready', instance: server } },
    });
    try {
      await query.initialized;
      expect(server.isConnected()).toBe(true);
      await query.close();
      expect(server.isConnected()).toBe(false);
    } finally {
      await query.close();
      await server.close();
    }
  });
});
