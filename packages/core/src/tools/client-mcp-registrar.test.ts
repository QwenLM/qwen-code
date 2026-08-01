/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  ClientMcpRegistrar,
  type ClientMcpFrame,
} from './client-mcp-registrar.js';
import { SdkControlClientTransport } from './sdk-control-client-transport.js';

/**
 * Reverse-channel round-trip test (issue #5626, Phase 2).
 *
 * This drives the REAL agent-side stack — a `@modelcontextprotocol/sdk`
 * `Client` over `SdkControlClientTransport`, the same transport `McpClient`
 * uses for SDK-type MCP servers — through `ClientMcpRegistrar`. The "client-
 * hosted" MCP server is a canned `McpServer` connected to an in-memory
 * transport. The registrar's `sendFrame` relays the agent's JSON-RPC into the
 * canned server; the canned server's replies are routed back via
 * `resolveMessage`. No LLM, no subprocess, no WS — just the `mcp_message`
 * round-trip itself.
 */

/**
 * Minimal server-side transport mirroring `SdkControlServerTransport`: the
 * registrar delivers frames into `handleMessage`, and the MCP Server's
 * `send()` hands the reply back to the supplied sink.
 */
class InMemoryServerTransport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(private readonly sink: (message: JSONRPCMessage) => void) {}

  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.sink(message);
  }
  handleMessage(message: JSONRPCMessage): void {
    this.onmessage?.(message);
  }
}

/** Build a canned client-hosted MCP server exposing one echo tool. */
function buildCannedServer(
  sink: (message: JSONRPCMessage) => void,
): { transport: InMemoryServerTransport; ready: Promise<void> } {
  const server = new McpServer({
    name: 'chrome-tools',
    version: '0.0.1',
  });
  server.tool(
    'chrome_read_page',
    'Read the current page text',
    { selector: z.string().optional() },
    async ({ selector }) => ({
      content: [
        {
          type: 'text',
          text: `page-text-for:${selector ?? 'body'}`,
        },
      ],
    }),
  );
  const transport = new InMemoryServerTransport(sink);
  const ready = server.connect(transport);
  return { transport, ready };
}

describe('ClientMcpRegistrar reverse channel', () => {
  it('round-trips initialize / tools/list / tools/call through SdkControlClientTransport', async () => {
    // Correlate the JSON-RPC message id ↔ the registrar's frame id, exactly as
    // the real WS client echoes the frame id back on its reply. Requests carry
    // a JSON-RPC `id`; the matching response echoes it, so we map response
    // ids back to the frame id we recorded on the way out.
    const jsonrpcIdToFrameId = new Map<string | number, string>();

    // Built before the registrar so its sendFrame can target it directly.
    const canned = buildCannedServer((message: JSONRPCMessage) => {
      // Server reply → resolve the pending request keyed by the frame id we
      // recorded for this JSON-RPC id (mirrors the client echoing the id).
      const replyId = (message as { id?: string | number }).id;
      const frameId =
        replyId !== undefined ? jsonrpcIdToFrameId.get(replyId) : undefined;
      if (frameId !== undefined) {
        jsonrpcIdToFrameId.delete(replyId!);
        registrar.resolveMessage(frameId, message);
      }
    });
    const serverTransport = canned.transport;
    await canned.ready;

    // The registrar puts outbound agent→client frames on the "wire". The WS
    // hop is replaced by this in-memory relay into the canned MCP server.
    const registrar = new ClientMcpRegistrar({
      sendFrame: (frame: ClientMcpFrame) => {
        const payload = frame.payload as { id?: string | number };
        if (payload.id !== undefined) {
          jsonrpcIdToFrameId.set(payload.id, frame.id);
        }
        serverTransport.handleMessage(frame.payload);
      },
    });

    registrar.registerServer('chrome-tools');

    // The agent side: a real MCP Client over the SDK control transport, wired
    // to the registrar's sendSdkMcpMessage. This is exactly what McpClient
    // constructs for an isSdkMcpServerConfig server.
    const transport = new SdkControlClientTransport({
      serverName: 'chrome-tools',
      sendMcpMessage: registrar.sendSdkMcpMessage,
    });
    const client = new Client({ name: 'agent', version: '0.0.1' });

    // connect() performs the MCP `initialize` handshake over the channel.
    await client.connect(transport);

    // tools/list → the canned catalog.
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('chrome_read_page');

    // tools/call → the client-hosted executor result.
    const result = await client.callTool({
      name: 'chrome_read_page',
      arguments: { selector: '#main' },
    });
    expect(result.content).toEqual([
      { type: 'text', text: 'page-text-for:#main' },
    ]);

    expect(registrar.pendingCount()).toBe(0);
    await client.close();
    registrar.close();
  });

  it('rejects sends for unregistered servers', async () => {
    const registrar = new ClientMcpRegistrar({ sendFrame: () => {} });
    await expect(
      registrar.sendSdkMcpMessage('ghost', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      } as JSONRPCMessage),
    ).rejects.toThrow(/not registered/);
  });

  it('rejects pending requests on unregister', async () => {
    const registrar = new ClientMcpRegistrar({
      // Never resolve — simulate a silent client.
      sendFrame: () => {},
    });
    registrar.registerServer('chrome-tools');
    const inflight = registrar.sendSdkMcpMessage('chrome-tools', {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
    } as JSONRPCMessage);
    expect(registrar.pendingCount()).toBe(1);
    registrar.unregisterServer('chrome-tools');
    await expect(inflight).rejects.toThrow(/unregistered/);
    expect(registrar.pendingCount()).toBe(0);
  });

  it('rejects all pending on close', async () => {
    const registrar = new ClientMcpRegistrar({ sendFrame: () => {} });
    registrar.registerServer('a');
    registrar.registerServer('b');
    const p1 = registrar.sendSdkMcpMessage('a', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    } as JSONRPCMessage);
    const p2 = registrar.sendSdkMcpMessage('b', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    } as JSONRPCMessage);
    registrar.close('socket gone');
    await expect(p1).rejects.toThrow(/socket gone/);
    await expect(p2).rejects.toThrow(/socket gone/);
    expect(registrar.pendingCount()).toBe(0);
  });

  it('times out a silent client', async () => {
    const registrar = new ClientMcpRegistrar({
      sendFrame: () => {},
      messageTimeoutMs: 20,
    });
    registrar.registerServer('slow');
    await expect(
      registrar.sendSdkMcpMessage('slow', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      } as JSONRPCMessage),
    ).rejects.toThrow(/did not respond/);
  });
});
