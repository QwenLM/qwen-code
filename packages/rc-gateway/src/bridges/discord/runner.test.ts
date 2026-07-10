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
  const threadsMade: Array<{ channelId: string; messageId: string }> = [];
  let nextId = 1;
  let nextThread = 1;
  const subscribed: string[] = [];
  let registered: Record<string, unknown> | undefined;
  let startedHandlers: GatewayHandlers | undefined;
  const timers: Array<() => void> = [];

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
    createThread: async (channelId: string, messageId: string) => {
      threadsMade.push({ channelId, messageId });
      return { ok: true, status: 201, body: { id: `thread_${nextThread++}` } };
    },
    replyEphemeral: async () => ({ ok: true, status: 200 }),
    deferInteraction: async () => ({ ok: true, status: 200 }),
    editInteractionReply: async () => ({ ok: true, status: 200 }),
  } as unknown as DiscordRestApi;

  const client = {
    register: async (reg: Record<string, unknown>) => {
      registered = reg;
      return { ok: true, status: 200 };
    },
    redeemInvite: async (_bridgeId: string, token: string) =>
      token === 'inv_new'
        ? { ok: true, status: 200, sessionId: 'sess_new' }
        : { ok: false, status: 400, body: { error: 'bad' } },
    heartbeat: async () => ({ ok: true, status: 200 }),
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
    setTimer: (_ms, fn) => {
      timers.push(fn);
      return () => {
        const i = timers.indexOf(fn);
        if (i >= 0) timers.splice(i, 1);
      };
    },
  });

  return {
    bridge,
    created,
    edited,
    threadsMade,
    subscribed,
    isRegistered: () => !!registered,
    registration: () => registered,
    handlers: () => startedHandlers,
    fireTimers: () => {
      for (const fn of timers.splice(0)) fn();
    },
    drain: () => bridge['stream'].whenIdle(),
  };
}

describe('DiscordBridge runner', () => {
  it('registers and subscribes to already-bound sessions on start', async () => {
    await channels.bind('chan_1', 'g1', 'sess_q');
    const h = harness();
    await h.bridge.start(new AbortController().signal);
    expect(h.isRegistered()).toBe(true);
    expect(h.registration()).toMatchObject({
      id: 'discord',
      supportsActions: true,
      supportsMarkdown: 'limited',
      supportsThreads: true, // threads on long streams (built this cycle)
      supportsEdits: true,
      maxMessageChars: 2000,
    });
    expect(h.subscribed).toContain('sess_q');
  });

  it('an attach via the gateway subscribes the newly-bound session', async () => {
    const h = harness();
    await h.bridge.start(new AbortController().signal);
    expect(h.subscribed).toEqual([]); // nothing bound yet

    // Simulate /qwen attach <invite> arriving over the gateway.
    h.handlers()!.onSlash({
      interactionId: 'int_1',
      interactionToken: 'tok',
      channelId: 'chan_9',
      guildId: 'g1',
      userId: 'u1',
      name: 'attach',
      arg: 'inv_new',
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

  it('resumes from the last seen frame id on reconnect (Last-Event-ID)', async () => {
    await channels.bind('chan_1', 'g1', 'sess_q');
    const ac = new AbortController();
    const cursors: Array<number | undefined> = [];
    let call = 0;
    const h = harness({
      sleep: () => new Promise<void>((r) => setTimeout(r, 1)), // yield each cycle
    });
    (
      h.bridge as unknown as {
        cfg: {
          client: {
            subscribeEvents: (
              s: string,
              cb: (ev: { id?: number; type?: string }) => void,
              sig?: AbortSignal,
              last?: number,
            ) => Promise<void>;
          };
        };
      }
    ).cfg.client.subscribeEvents = async (_s, cb, _sig, last) => {
      cursors.push(last);
      call++;
      if (call === 1) cb({ id: 9, type: 'session_update' }); // a frame arrives
      if (call >= 2) ac.abort(); // stop after the reconnect
    };

    void h.bridge.start(ac.signal);
    await waitFor(() => call >= 2);
    expect(cursors[0]).toBeUndefined(); // first subscribe: no cursor
    expect(cursors[1]).toBe(9); // reconnect resumes from the last seen id
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

  it('ignores session_update frames with no agent text (channels stay quiet)', async () => {
    await channels.bind('chan_1', 'g1', 'sess_q');
    const h = harness();
    // a thought chunk / non-text frame → not rendered (deliberate scope)
    h.bridge.deliverEvent('sess_q', {
      type: 'session_update',
      data: { update: { sessionUpdate: 'agent_thought_chunk' } },
    });
    h.fireTimers();
    await h.drain();
    expect(h.created).toHaveLength(0);
  });
});

describe('DiscordBridge runner — session_update streaming', () => {
  const chunk = (text: string) => ({
    type: 'session_update' as const,
    data: {
      update: { sessionUpdate: 'agent_message_chunk', content: { text } },
    },
  });

  it('buffers agent_message_chunk text and flushes it as a channel message', async () => {
    await channels.bind('chan_1', 'g1', 'sess_q');
    const h = harness();
    h.bridge.deliverEvent('sess_q', chunk('Hello, working on it.\n\n')); // paragraph → flush
    await h.drain();
    expect(h.created).toHaveLength(1);
    expect(h.created[0].channelId).toBe('chan_1');
    expect(h.created[0].content).toContain('Hello, working on it.');
  });

  it('flushes on the idle timer when no hard trigger fires', async () => {
    await channels.bind('chan_1', 'g1', 'sess_q');
    const h = harness();
    h.bridge.deliverEvent('sess_q', chunk('a quiet partial line'));
    expect(h.created).toHaveLength(0); // buffered, no trigger yet
    h.fireTimers();
    await h.drain();
    expect(h.created).toHaveLength(1);
    expect(h.created[0].content).toBe('a quiet partial line');
  });

  it('opens a thread on the 7th message of a turn and redirects there', async () => {
    await channels.bind('chan_1', 'g1', 'sess_q');
    const h = harness();
    for (let i = 1; i <= 7; i++) {
      h.bridge.deliverEvent('sess_q', chunk(`message ${i}\n\n`));
      await h.drain();
    }
    expect(h.threadsMade).toHaveLength(1);
    expect(h.threadsMade[0].messageId).toBe('m_1'); // thread off the first message
    // the 7th message landed in the thread, not the channel
    expect(h.created[h.created.length - 1].channelId).toBe('thread_1');
  });

  it('a permission_resolved ends the turn — the next chunk goes to the channel', async () => {
    await channels.bind('chan_1', 'g1', 'sess_q');
    const h = harness();
    for (let i = 1; i <= 7; i++) {
      h.bridge.deliverEvent('sess_q', chunk(`message ${i}\n\n`));
      await h.drain();
    }
    expect(h.threadsMade).toHaveLength(1);
    h.bridge.deliverEvent('sess_q', {
      type: 'permission_resolved',
      data: { requestId: 'r', outcome: 'allow_once' },
    });
    h.bridge.deliverEvent('sess_q', chunk('new turn line\n\n'));
    await h.drain();
    // back in the channel (fresh turn), no new thread yet
    expect(h.created[h.created.length - 1].channelId).toBe('chan_1');
    expect(h.threadsMade).toHaveLength(1);
  });
});
