/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ChannelLoopMcpWorkerHost,
  isChannelLoopMcpControlMessage,
  isChannelLoopMcpRequestMessage,
  isChannelLoopMcpResultMessage,
  type ChannelLoopMcpIpcSend,
} from './channel-loop-mcp-ipc.js';

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

describe('ChannelLoopMcpWorkerHost', () => {
  it('installs the exact-session handler before registration is acknowledged', async () => {
    const sent: unknown[] = [];
    const handler = vi.fn(async (message: Record<string, unknown>) => ({
      jsonrpc: '2.0',
      id: message['id'],
      result: { tools: [] },
    }));
    const send: ChannelLoopMcpIpcSend = (message) => {
      sent.push(message);
      if (isChannelLoopMcpControlMessage(message)) {
        expect(
          host.handleMessage({
            type: 'channel_loop_mcp_message',
            id: 'request-1',
            sessionId: message.sessionId,
            payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
          }),
        ).toBe(true);
        host.handleMessage({
          type: 'channel_loop_mcp_control_result',
          id: message.id,
          ok: true,
        });
      }
      return true;
    };
    const host = new ChannelLoopMcpWorkerHost(send);

    await host.register('session-1', handler);
    await drainMicrotasks();

    expect(handler).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(sent).toContainEqual({
      type: 'channel_loop_mcp_result',
      id: 'request-1',
      ok: true,
      payload: { jsonrpc: '2.0', id: 1, result: { tools: [] } },
    });
  });

  it('rejects a request for a sibling session', async () => {
    const sent: unknown[] = [];
    const host = new ChannelLoopMcpWorkerHost((message) => {
      sent.push(message);
      return true;
    });

    expect(
      host.handleMessage({
        type: 'channel_loop_mcp_message',
        id: 'request-2',
        sessionId: 'session-2',
        payload: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      }),
    ).toBe(true);
    await drainMicrotasks();

    expect(sent).toContainEqual({
      type: 'channel_loop_mcp_result',
      id: 'request-2',
      ok: false,
      error: 'No channel loop MCP handler for this session.',
    });
  });

  it('returns a valid bounded error when a handler throws an empty error', async () => {
    const sent: unknown[] = [];
    const host = new ChannelLoopMcpWorkerHost((message) => {
      sent.push(message);
      if (isChannelLoopMcpControlMessage(message)) {
        host.handleMessage({
          type: 'channel_loop_mcp_control_result',
          id: message.id,
          ok: true,
        });
      }
      return true;
    });
    await host.register('session-1', async () => {
      throw new Error('');
    });

    host.handleMessage({
      type: 'channel_loop_mcp_message',
      id: 'request-empty-error',
      sessionId: 'session-1',
      payload: { jsonrpc: '2.0', id: 3, method: 'tools/call' },
    });
    await drainMicrotasks();

    const result = sent.find(
      (message) =>
        (message as { type?: string }).type === 'channel_loop_mcp_result',
    );
    expect(result).toEqual({
      type: 'channel_loop_mcp_result',
      id: 'request-empty-error',
      ok: false,
      error: 'Channel loop MCP request failed.',
    });
    expect(isChannelLoopMcpResultMessage(result)).toBe(true);
  });
});

describe('channel loop MCP IPC validation', () => {
  it('accepts bounded messages and rejects malformed payloads', () => {
    expect(
      isChannelLoopMcpRequestMessage({
        type: 'channel_loop_mcp_message',
        id: 'request',
        sessionId: 'session',
        payload: { jsonrpc: '2.0', method: 'ping' },
      }),
    ).toBe(true);
    expect(
      isChannelLoopMcpRequestMessage({
        type: 'channel_loop_mcp_message',
        id: 'request',
        sessionId: '',
        payload: { jsonrpc: '2.0' },
      }),
    ).toBe(false);
    expect(
      isChannelLoopMcpResultMessage({
        type: 'channel_loop_mcp_result',
        id: 'request',
        ok: true,
        payload: { jsonrpc: '2.0', id: 1, result: {} },
      }),
    ).toBe(true);
  });
});
