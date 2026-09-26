/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AcpRelay,
  buildAcpUrl,
  buildRewarmUrl,
  type AcpRelayOptions,
  type RelaySocketHandlers,
} from './acp-relay.js';
import { DESKTOP_RELAY_SERVER_NAME } from './constants.js';

interface Harness {
  relay: AcpRelay;
  sent: Array<Record<string, unknown>>;
  handlers: () => RelaySocketHandlers;
  url: () => string;
  headers: () => Record<string, string>;
  closed: () => boolean;
  deliver: (frame: unknown) => Promise<void>;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(overrides: Partial<AcpRelayOptions> = {}): Harness {
  const sent: Array<Record<string, unknown>> = [];
  let handlers: RelaySocketHandlers | undefined;
  let url = '';
  let headers: Record<string, string> = {};
  let closed = false;
  const relay = new AcpRelay({
    daemonUrl: 'https://devbox.example:4170/',
    sessionId: 'session-1',
    token: 'secret',
    clientVersion: '0.0.0-test',
    rpc: { handle: async () => undefined },
    openSocket: (nextUrl, nextHeaders, nextHandlers) => {
      url = nextUrl;
      headers = nextHeaders;
      handlers = nextHandlers;
      return {
        send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
        close: () => {
          closed = true;
        },
      };
    },
    registerTimeoutMs: 60_000,
    ...overrides,
  });
  const requireHandlers = () => {
    if (!handlers) throw new Error('socket not opened');
    return handlers;
  };
  return {
    relay,
    sent,
    handlers: requireHandlers,
    url: () => url,
    headers: () => headers,
    closed: () => closed,
    deliver: async (frame) => {
      requireHandlers().message(JSON.stringify(frame));
      await flush();
    },
  };
}

async function connect(h: Harness): Promise<void> {
  h.handlers().open();
  await h.deliver({
    jsonrpc: '2.0',
    id: 'desktop-relay-acp-initialize',
    result: {},
  });
  await h.deliver({
    type: 'mcp_registered',
    server: DESKTOP_RELAY_SERVER_NAME,
    toolCount: 5,
  });
}

describe('buildAcpUrl / buildRewarmUrl', () => {
  it('keeps the base path and picks the route for the workspace', () => {
    expect(buildAcpUrl('https://host:4170/base')).toBe(
      'wss://host:4170/base/acp',
    );
    expect(buildAcpUrl('http://127.0.0.1:4170')).toBe(
      'ws://127.0.0.1:4170/acp',
    );
    expect(
      buildAcpUrl('http://127.0.0.1:4170', { kind: 'cwd', value: '/w/a b' }),
    ).toBe('ws://127.0.0.1:4170/workspaces/%2Fw%2Fa%20b/acp');
    expect(buildRewarmUrl('http://h:1/')).toBe(
      'http://h:1/workspace/acp/preheat',
    );
    expect(buildRewarmUrl('http://h:1/', { kind: 'id', value: 'w1' })).toBe(
      'http://h:1/workspaces/w1/runtime/ensure',
    );
  });
});

describe('AcpRelay', () => {
  it('initializes, registers for the session, and reports connected', async () => {
    const phases: string[] = [];
    const h = harness({ onPhase: (phase) => phases.push(phase) });
    void h.relay.run();
    expect(h.url()).toBe('wss://devbox.example:4170/acp');
    expect(h.headers()).toEqual({ authorization: 'Bearer secret' });

    h.handlers().open();
    expect(h.sent[0]).toMatchObject({
      id: 'desktop-relay-acp-initialize',
      method: 'initialize',
    });
    await h.deliver({
      jsonrpc: '2.0',
      id: 'desktop-relay-acp-initialize',
      result: {},
    });
    expect(h.sent[1]).toEqual({
      type: 'mcp_register',
      server: 'desktop-node-repl',
      sessionId: 'session-1',
    });
    await h.deliver({
      type: 'mcp_registered',
      server: DESKTOP_RELAY_SERVER_NAME,
    });
    expect(phases).toEqual(['connecting', 'registering', 'connected']);
  });

  it('answers mcp_message frames through the rpc handler', async () => {
    const handle = vi.fn(async (message: unknown) => ({
      jsonrpc: '2.0',
      id: (message as { id: number }).id,
      result: { ok: true },
    }));
    const h = harness({ rpc: { handle } });
    void h.relay.run();
    await connect(h);
    await h.deliver({
      type: 'mcp_message',
      id: 'corr-1',
      server: DESKTOP_RELAY_SERVER_NAME,
      payload: { jsonrpc: '2.0', id: 4, method: 'tools/list' },
    });
    expect(handle).toHaveBeenCalledWith({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
    });
    expect(h.sent.at(-1)).toEqual({
      type: 'mcp_message',
      id: 'corr-1',
      server: DESKTOP_RELAY_SERVER_NAME,
      payload: { jsonrpc: '2.0', id: 4, result: { ok: true } },
    });
  });

  it('settles the outer frame for a cancelled request but not a notification', async () => {
    const h = harness();
    void h.relay.run();
    await connect(h);
    await h.deliver({
      type: 'mcp_message',
      id: 'cancelled-call',
      server: DESKTOP_RELAY_SERVER_NAME,
      payload: { jsonrpc: '2.0', id: 4, method: 'tools/call' },
    });
    expect(h.sent.at(-1)).toMatchObject({
      type: 'mcp_message',
      id: 'cancelled-call',
      payload: { id: 4, error: { code: -32800 } },
    });
    const replies = h.sent.length;
    await h.deliver({
      type: 'mcp_message',
      id: 'cancellation-notification',
      server: DESKTOP_RELAY_SERVER_NAME,
      payload: {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 4 },
      },
    });
    expect(h.sent).toHaveLength(replies);
    h.relay.stop();
  });

  it('warms the runtime and retries a failed registration, then gives up', async () => {
    const rewarm = vi.fn(async () => undefined);
    const h = harness({ rewarm, maxRegisterAttempts: 2 });
    const ended = h.relay.run();
    h.handlers().open();
    await h.deliver({
      jsonrpc: '2.0',
      id: 'desktop-relay-acp-initialize',
      result: {},
    });

    await h.deliver({
      type: 'mcp_error',
      code: 'register_failed',
      message: 'No live ACP channel',
    });
    expect(rewarm).toHaveBeenCalledTimes(1);
    expect(h.sent.filter((f) => f['type'] === 'mcp_register')).toHaveLength(2);

    await h.deliver({
      type: 'mcp_error',
      code: 'register_failed',
      message: 'No live ACP channel',
    });
    await expect(ended).resolves.toEqual({
      reason: 'failed',
      code: 'register_failed',
      message: 'No live ACP channel after 2 attempt(s)',
    });
    expect(h.closed()).toBe(true);
  });

  it('fails when the daemon rejects ACP initialize', async () => {
    const h = harness();
    const ended = h.relay.run();
    h.handlers().open();
    await h.deliver({
      jsonrpc: '2.0',
      id: 'desktop-relay-acp-initialize',
      error: { code: -32000, message: 'nope' },
    });
    await expect(ended).resolves.toEqual({
      reason: 'failed',
      code: 'acp_initialize_failed',
      message: 'nope',
    });
  });

  it.each([1000, 1001, 1006])(
    'ends on close %s without reconnecting',
    async (code) => {
      const h = harness();
      const ended = h.relay.run();
      await connect(h);
      h.handlers().close(code, '');
      await expect(ended).resolves.toEqual(
        code === 1006
          ? {
              reason: 'failed',
              code: 'connection_failed',
              message: 'code 1006',
            }
          : { reason: 'closed', detail: `code ${code}` },
      );
    },
  );

  it('unregisters and closes on stop', async () => {
    const h = harness();
    const ended = h.relay.run();
    await connect(h);
    h.relay.stop();
    expect(h.sent.at(-1)).toEqual({
      type: 'mcp_unregister',
      server: DESKTOP_RELAY_SERVER_NAME,
    });
    await expect(ended).resolves.toEqual({ reason: 'stopped' });
    expect(h.closed()).toBe(true);
  });
});
