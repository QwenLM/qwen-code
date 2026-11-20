/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  JSONRPCMessage,
  JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/client';
import { createMcpClient, registerMcpClientHandlers } from './mcp-client.js';

/**
 * Scripted server-side transport: answers the initialize handshake, records
 * what the client declared, then pushes one server-initiated
 * `elicitation/create` request and captures the client's reply. Implements
 * the SDK Transport interface the same way the production stdio/http
 * transports do — start/send/close plus the onmessage callback.
 */
class ScriptedElicitationTransport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  private started = false;
  /** initialize request the client sent, for capability assertions. */
  initializeRequest: JSONRPCRequest | undefined;
  /** responses the client sent to server-initiated requests. */
  readonly replies: JSONRPCMessage[] = [];

  async start(): Promise<void> {
    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started) throw new Error('transport not started');
    if ('method' in message && message.method === 'initialize') {
      this.initializeRequest = message as JSONRPCRequest;
      this.onmessage?.({
        jsonrpc: '2.0',
        id: (message as JSONRPCRequest).id,
        result: {
          protocolVersion: message.params?.['protocolVersion'],
          capabilities: {},
          serverInfo: { name: 'scripted', version: '0.0.0' },
        },
      } as JSONRPCMessage);
      return;
    }
    if ('method' in message && message.method === 'notifications/initialized') {
      // Handshake complete: the server asks the user for structured input
      // mid-interaction, exactly the flow the capability advertises.
      queueMicrotask(() => {
        this.onmessage?.({
          jsonrpc: '2.0',
          id: 77,
          method: 'elicitation/create',
          params: {
            message: 'Which ticket should I file against?',
            mode: 'form',
            requestedSchema: {
              type: 'object',
              properties: {},
            },
          },
        } as JSONRPCMessage);
      });
      return;
    }
    // Anything without a method is a RESPONSE to a server-initiated
    // request — the elicitation reply we want to capture.
    if (!('method' in message)) {
      this.replies.push(message);
    }
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}

describe('MCP elicitation (#17316)', () => {
  it('declares the elicitation capability in the initialize handshake', async () => {
    const client = createMcpClient(
      'elicitation-test',
      { url: 'http://localhost:3000/mcp' },
      { declareElicitation: true },
    );
    const transport = new ScriptedElicitationTransport();
    await client.connect(transport as unknown as Transport);
    try {
      const capabilities = (
        transport.initializeRequest?.params as {
          capabilities?: { elicitation?: unknown };
        }
      )?.capabilities;
      // The declaration is what makes a server's elicitation request
      // protocol-legal in the first place.
      expect(capabilities?.elicitation).toBeDefined();
    } finally {
      await client.close();
    }
  });

  it('declines a server-initiated elicitation/create over a real transport', async () => {
    const client = createMcpClient(
      'elicitation-test',
      { url: 'http://localhost:3000/mcp' },
      { declareElicitation: true },
    );
    // The production registration the connect path uses — not a re-derived
    // copy: if it breaks, this test observes the breakage.
    registerMcpClientHandlers(client, 'elicitation-test');
    const transport = new ScriptedElicitationTransport();
    await client.connect(transport as unknown as Transport);
    try {
      const deadline = Date.now() + 5_000;
      while (transport.replies.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const reply = transport.replies[0] as {
        id?: number | string;
        result?: { action?: string };
      };
      expect(reply?.id).toBe(77);
      // Protocol-correct refusal, not a timeout: the server sees decline
      // and can surface its own tool error.
      expect(reply?.result?.action).toBe('decline');
    } finally {
      await client.close();
    }
  });
});
