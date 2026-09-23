/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  McpChildRelay,
  type ChildChannel,
  type JsonRpcMessage,
} from './mcp-child-relay.js';

class FakeChild implements ChildChannel {
  readonly sent: JsonRpcMessage[] = [];
  closed = false;
  private messageListener: ((message: unknown) => void) | undefined;
  private readonly exitListeners: Array<(reason: string) => void> = [];

  send(message: JsonRpcMessage): void {
    this.sent.push(message);
  }
  onMessage(listener: (message: unknown) => void): void {
    this.messageListener = listener;
  }
  onExit(listener: (reason: string) => void): void {
    this.exitListeners.push(listener);
  }
  close(): void {
    this.closed = true;
  }
  reply(message: unknown): void {
    this.messageListener?.(message);
  }
  exit(reason: string): void {
    for (const listener of this.exitListeners) listener(reason);
  }
  last(): JsonRpcMessage {
    const message = this.sent.at(-1);
    if (message === undefined) throw new Error('nothing sent');
    return message;
  }
}

describe('McpChildRelay', () => {
  it('forwards the first initialize and answers later ones from its result', async () => {
    const child = new FakeChild();
    const relay = new McpChildRelay(child);

    const first = relay.handle({ jsonrpc: '2.0', id: 0, method: 'initialize' });
    const forwarded = child.last();
    child.reply({
      jsonrpc: '2.0',
      id: forwarded.id,
      result: { serverInfo: { name: 'node-repl' } },
    });
    await expect(first).resolves.toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: { serverInfo: { name: 'node-repl' } },
    });

    await expect(
      relay.handle({ jsonrpc: '2.0', id: 7, method: 'initialize' }),
    ).resolves.toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { serverInfo: { name: 'node-repl' } },
    });
    expect(child.sent.filter((m) => m.method === 'initialize')).toHaveLength(1);
  });

  it('keeps colliding request ids from different clients apart', async () => {
    const child = new FakeChild();
    const relay = new McpChildRelay(child);

    const a = relay.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const b = relay.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
    const [toA, toB] = child.sent;
    expect(toA?.id).not.toBe(toB?.id);

    child.reply({ jsonrpc: '2.0', id: toB?.id, result: 'from call' });
    child.reply({ jsonrpc: '2.0', id: toA?.id, result: 'from list' });
    await expect(a).resolves.toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: 'from list',
    });
    await expect(b).resolves.toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: 'from call',
    });
  });

  it('forwards notifications/initialized once', async () => {
    const child = new FakeChild();
    const relay = new McpChildRelay(child);
    const note = { jsonrpc: '2.0', method: 'notifications/initialized' };
    await expect(relay.handle(note)).resolves.toBeUndefined();
    await relay.handle(note);
    expect(child.sent).toEqual([note]);
  });

  it('forwards a cancellation that names one pending request', async () => {
    const child = new FakeChild();
    const relay = new McpChildRelay(child);
    void relay.handle({ jsonrpc: '2.0', id: 'abc', method: 'tools/call' });
    const relayId = child.last().id;
    await relay.handle({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'abc', reason: 'user' },
    });
    expect(child.last()).toEqual({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: relayId, reason: 'user' },
    });
  });

  it('drops cancellations that match no request or several', async () => {
    const child = new FakeChild();
    const relay = new McpChildRelay(child);
    const cancel = (requestId: unknown) =>
      relay.handle({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId },
      });
    await cancel(0);
    void relay.handle({ jsonrpc: '2.0', id: 0, method: 'tools/call' });
    void relay.handle({ jsonrpc: '2.0', id: 0, method: 'tools/call' });
    await cancel(0);
    await cancel('0');
    expect(child.sent.map((message) => message.method)).toEqual([
      'tools/call',
      'tools/call',
    ]);
  });

  it('replaces a reply above the frame budget with an error', async () => {
    const child = new FakeChild();
    const relay = new McpChildRelay(child, 64);
    const pending = relay.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
    });
    child.reply({
      jsonrpc: '2.0',
      id: child.last().id,
      result: 'x'.repeat(200),
    });
    const reply = await pending;
    expect(reply?.id).toBe(3);
    expect(reply?.error).toMatchObject({ code: -32000 });
    expect(JSON.stringify(reply)).toContain('smaller screenshot');
  });

  it('fails pending and later requests once the child exits', async () => {
    const child = new FakeChild();
    const relay = new McpChildRelay(child);
    const pending = relay.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
    });
    child.exit('exit code 1');
    await expect(pending).resolves.toMatchObject({
      id: 5,
      error: { message: 'node_repl exited (exit code 1)' },
    });
    await expect(
      relay.handle({ jsonrpc: '2.0', id: 6, method: 'tools/list' }),
    ).resolves.toMatchObject({ id: 6, error: { code: -32000 } });
  });

  it('refuses requests the child starts and ignores its notifications', async () => {
    const child = new FakeChild();
    new McpChildRelay(child);
    child.reply({ jsonrpc: '2.0', id: 9, method: 'roots/list' });
    child.reply({ jsonrpc: '2.0', method: 'notifications/message' });
    expect(child.sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 9,
        error: {
          code: -32601,
          message: 'roots/list is not available over the desktop relay',
        },
      },
    ]);
  });
});
