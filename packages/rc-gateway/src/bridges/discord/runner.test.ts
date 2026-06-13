/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordChannelStore } from './channelStore.js';
import { DiscordBridge, type GatewayHandlers } from './runner.js';
import type { BridgeClient } from '../client.js';
import type { DiscordRestApi } from './restApi.js';

/** Poll until `predicate` is true (deterministic vs a fixed timeout). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let dir: string;
let channels: DiscordChannelStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-dc-run-'));
  channels = await DiscordChannelStore.open(join(dir, 'channels.json'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function harness(
  opts: { sleep?: (ms: number, s: AbortSignal) => Promise<void> } = {},
) {
  const created: Array<{
    channelId: string;
    content: string;
    components: unknown;
  }> = [];
  const edited: Array<{
    channelId: string;
    messageId: string;
    content: string;
    components: unknown;
  }> = [];
  let nextId = 1;
  const subscribed: string[] = [];
  let registered = false;
  let startedHandlers: GatewayHandlers | undefined;

  const rest = {
    createMessage: async (
      channelId: string,
      content: string,
      components: unknown,
    ) => {
      created.push({ channelId, content, components });
      return { ok: true, status: 200, body: { id: `m_${nextId++}` } };
    },
    editMessage: async (
      channelId: string,
      messageId: string,
      content: string,
      components: unknown,
    ) => {
      edited.push({ channelId, messageId, content, components });
      return { ok: true, status: 200 };
    },
    replyEphemeral: async () => ({ ok: true, status: 200 }),
    deferInteraction: async () => ({ ok: true, status: 200 }),
    editInteractionReply: async () => ({ ok: true, status: 200 }),
  } as unknown as DiscordRestApi;

  const client = {
    register: async () => {
      registered = true;
      return { ok: true, status: 200 };
    },
    subscribeEvents: async (sessionId: string) => {
      subscribed.push(sessionId);
    },
  } as unknown as BridgeClient;

  const bridge = new DiscordBridge({
    client,
    rest,
    channels,
    baseUrl: 'http://127.0.0.1:4170',
    makeGateway: (handlers) => {
      startedHandlers = handlers;
      return { start: async () => {} };
    },
    // By default park after the first subscribe (the fake stream resolves
    // immediately, so without this the reconnect loop would spin). The reconnect
    // test overrides this to exercise re-subscription.
    sleep: opts.sleep ?? (() => new Promise<void>(() => {})),
  });

  return {
    bridge,
    created,
    edited,
    subscribed,
    isRegistered: () => registered,
    handlers: () => startedHandlers,
  };
}

describe('DiscordBridge runner', () => {
  it('registers and subscribes to already-bound sessions on start', async () => {
    await channels.bind('chan_1', 'g1', 'sess_q');
    const h = harness();
    await h.bridge.start(new AbortController().signal);
    expect(h.isRegistered()).toBe(true);
    expect(h.subscribed).toContain('sess_q');
  });

  it('an attach via the gateway subscribes the newly-bound session', async () => {
    const h = harness();
    await h.bridge.start(new AbortController().signal);
    expect(h.subscribed).toEqual([]); // nothing bound yet

    // Simulate /qwen attach arriving over the gateway.
    h.handlers()!.onSlash({
      interactionId: 'int_1',
      interactionToken: 'tok',
      channelId: 'chan_9',
      guildId: 'g1',
      userId: 'u1',
      name: 'attach',
      arg: 'sess_new',
    });
    await waitFor(() => h.subscribed.includes('sess_new'));
    expect(channels.sessionFor('chan_9')).toBe('sess_new');
    expect(h.subscribed).toContain('sess_new');
  });

  it('re-subscribes after the SSE stream ends (self-heals on disconnect)', async () => {
    await channels.bind('chan_1', 'g1', 'sess_q');
    const ac = new AbortController();
    let subscribeCount = 0;
    // The fake stream resolves immediately (a "disconnect"); count re-subscribes
    // and abort after a few to prove the loop reconnects rather than dying once.
    const h = harness({
      sleep: async () => {
        if (subscribeCount >= 3) ac.abort();
      },
    });
    // Replace subscribeEvents to count attempts for this test.
    (
      h.bridge as unknown as { cfg: { client: { subscribeEvents: unknown } } }
    ).cfg.client.subscribeEvents = async () => {
      subscribeCount++;
    };

    void h.bridge.start(ac.signal);
    // The loop re-subscribes each cycle (not a single attempt) until abort.
    await waitFor(() => subscribeCount >= 3);
    expect(subscribeCount).toBeGreaterThanOrEqual(3);
    expect(ac.signal.aborted).toBe(true);
  });

  it('deliverEvent renders a permission_request to every bound channel', async () => {
    await channels.bind('chan_1', 'g1', 'sess_q');
    await channels.bind('chan_2', 'g1', 'sess_q');
    const h = harness();
    h.bridge.deliverEvent('sess_q', {
      type: 'permission_request',
      data: {
        requestId: 'req_1',
        bridgeHints: {
          recommendedSurface: 'inline',
          argsSummaryShort: 'Edit a.ts',
        },
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.created.map((c) => c.channelId).sort()).toEqual([
      'chan_1',
      'chan_2',
    ]);
    expect(h.created[0].content).toContain('Edit a.ts');
  });

  it('permission_resolved edits the rendered message, disabling buttons', async () => {
    await channels.bind('chan_1', 'g1', 'sess_q');
    const h = harness();
    h.bridge.deliverEvent('sess_q', {
      type: 'permission_request',
      data: {
        requestId: 'req_1',
        bridgeHints: {
          recommendedSurface: 'inline',
          argsSummaryShort: 'Edit a.ts',
        },
      },
    });
    await new Promise((r) => setTimeout(r, 0));

    h.bridge.deliverEvent('sess_q', {
      type: 'permission_resolved',
      data: { requestId: 'req_1', outcome: 'allow_once' },
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(h.edited).toHaveLength(1);
    expect(h.edited[0].messageId).toBe('m_1');
    expect(h.edited[0].content).toContain('Resolved: allow_once');
    const rows = h.edited[0].components as Array<{
      components: Array<{ disabled?: boolean }>;
    }>;
    expect(rows[0].components.every((b) => b.disabled === true)).toBe(true);
  });

  it('ignores a resolve for an unknown request (no edit)', async () => {
    const h = harness();
    h.bridge.deliverEvent('sess_q', {
      type: 'permission_resolved',
      data: { requestId: 'never_seen' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.edited).toHaveLength(0);
  });

  it('ignores non-permission frames (channels stay quiet)', async () => {
    await channels.bind('chan_1', 'g1', 'sess_q');
    const h = harness();
    h.bridge.deliverEvent('sess_q', {
      type: 'session_update',
      data: { text: 'thinking...' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.created).toHaveLength(0);
  });
});
