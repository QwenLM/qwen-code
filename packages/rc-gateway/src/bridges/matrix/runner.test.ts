/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MatrixRoomStore } from './roomStore.js';
import { MatrixBridge, MATRIX_INVITE_AUTOJOIN_CAP } from './runner.js';
import { ENCRYPTED_ROOM_NOTICE } from './dispatch.js';
import { initialMatrixHealthState, type MatrixHealthState } from './health.js';
import type { BridgeClient } from '../client.js';
import type { MatrixInbound } from './runner.js';

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
let rooms: MatrixRoomStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-mx-run-'));
  rooms = await MatrixRoomStore.open(join(dir, 'rooms.json'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function harness(
  batches: unknown[],
  opts: {
    park?: boolean;
    runInbound?: (signal: AbortSignal) => Promise<void>;
    health?: MatrixHealthState;
  } = {},
) {
  const sent: Array<{ roomId: string; content: unknown }> = [];
  const joined: string[] = [];
  const prompts: string[] = [];
  let syncCalls = 0;
  const votes: Array<{
    sessionId: string;
    requestId: string;
    outcome: string;
    subActor: string;
  }> = [];
  let nextEvt = 1;
  const ac = new AbortController();
  let i = 0;

  const rest = {
    sendMessage: async (roomId: string, content: unknown) => {
      sent.push({ roomId, content });
      return { ok: true, status: 200, eventId: `$evt_${nextEvt++}` };
    },
    joinRoom: async (roomId: string) => {
      joined.push(roomId);
      return { ok: true, status: 200 };
    },
  } as unknown as MatrixInbound;

  const subscribed: string[] = [];
  const timers: Array<() => void> = [];
  let registered: Record<string, unknown> | undefined;
  const client = {
    register: async (reg: Record<string, unknown>) => {
      registered = reg;
      return { ok: true, status: 200 };
    },
    heartbeat: async () => ({ ok: true, status: 200 }),
    sendPrompt: async (_s: string, prompt: string) => {
      prompts.push(prompt);
      return { ok: true, status: 200 };
    },
    redeemInvite: async () => ({
      ok: true,
      status: 200,
      sessionId: 'sess_new',
    }),
    vote: async (
      sessionId: string,
      requestId: string,
      outcome: string,
      subActor: string,
    ) => {
      votes.push({ sessionId, requestId, outcome, subActor });
      return { ok: true, status: 200 };
    },
    subscribeEvents: async (sessionId: string) => {
      subscribed.push(sessionId);
    },
  } as unknown as BridgeClient;

  const bridge = new MatrixBridge({
    client,
    rest,
    rooms,
    botUserId: '@qwenbot:home.example.com',
    baseUrl: 'http://127.0.0.1:4170',
    syncOnce: async () => {
      syncCalls++;
      if (i >= batches.length) {
        // `park`: keep the sync loop alive (signal stays live) instead of
        // aborting, so tests can drive dispatch seams against a running bridge.
        if (opts.park) return new Promise<unknown>(() => {});
        ac.abort();
        return {};
      }
      return batches[i++];
    },
    ...(opts.runInbound ? { runInbound: opts.runInbound } : {}),
    ...(opts.health ? { health: opts.health } : {}),
    sleep: () => new Promise<void>(() => {}), // park SSE reconnect after 1 subscribe
    setTimer: (_ms, fn) => {
      timers.push(fn);
      return () => {
        const idx = timers.indexOf(fn);
        if (idx >= 0) timers.splice(idx, 1);
      };
    },
  });

  return {
    bridge,
    ac,
    sent,
    joined,
    prompts,
    votes,
    subscribed,
    syncCalls: () => syncCalls,
    registered: () => registered,
    fireTimers: () => {
      for (const fn of timers.splice(0)) fn();
    },
    drainStream: () => bridge['stream'].whenIdle(),
  };
}

const textMsg = (roomId: string, sender: string, body: string) => ({
  rooms: {
    join: {
      [roomId]: {
        timeline: {
          events: [
            {
              type: 'm.room.message',
              sender,
              content: { msgtype: 'm.text', body },
            },
          ],
        },
      },
    },
  },
});

describe('MatrixBridge runner — sync loop', () => {
  it('registers accurate capabilities (full markdown via formatted_body, threads)', async () => {
    const h = harness([]);
    await h.bridge.start(h.ac.signal);
    expect(h.registered()).toMatchObject({
      id: 'matrix',
      supportsActions: false, // reactions, not buttons
      supportsMarkdown: 'full', // streamed prose sent as HTML formatted_body
      supportsThreads: true, // m.thread relation on long streams
      supportsEdits: true, // m.replace on resolve
    });
  });

  it('runs the injected inbound transport instead of the fetch syncLoop (E2EE subsume)', async () => {
    // When the crypto adapter owns /sync (E2EE on), the runner MUST NOT also run
    // its fetch sync loop — two syncs on one device race for the to-device megolm
    // keys. A provided runInbound replaces syncLoop entirely.
    let ranInbound = false;
    const h = harness(
      [{ next_batch: 's1', ...textMsg('!r:h', '@a:h', 'hi') }],
      {
        runInbound: async () => {
          ranInbound = true;
        },
      },
    );
    await h.bridge.start(h.ac.signal);
    expect(ranInbound).toBe(true);
    expect(h.syncCalls()).toBe(0); // the fetch sync was never invoked
  });

  it('updates health state: registered + daemonReachable on start, homeserverReachable on a good sync', async () => {
    // park after the one good batch so the loop stays live (the abort sentinel
    // would otherwise be an empty sync that honestly flips homeserverReachable off).
    const health = initialMatrixHealthState();
    const h = harness([{ next_batch: 's1' }], { health, park: true });
    void h.bridge.start(h.ac.signal);
    await waitFor(() => health.homeserverReachable);
    expect(health.registeredId).toBe('matrix');
    expect(health.daemonReachable).toBe(true);
    expect(health.homeserverReachable).toBe(true);
    h.ac.abort();
  });

  it('skips replaying timeline history on the initial sync', async () => {
    await rooms.bind('!r:h', 'sess_q');
    const h = harness([
      // initial sync (since=undefined) carries a message — must NOT be replayed.
      { next_batch: 's1', ...textMsg('!r:h', '@alice:h', 'old history') },
    ]);
    await h.bridge.start(h.ac.signal);
    expect(h.prompts).toEqual([]);
  });

  it('dispatches a message from a non-initial sync as a prompt', async () => {
    await rooms.bind('!r:h', 'sess_q');
    const h = harness([
      { next_batch: 's1' }, // initial (skipped)
      { next_batch: 's2', ...textMsg('!r:h', '@alice:h', 'run the tests') },
    ]);
    await h.bridge.start(h.ac.signal);
    expect(h.prompts).toEqual(['run the tests']);
  });

  it('auto-joins an invited room (even on the initial sync)', async () => {
    const h = harness([
      {
        next_batch: 's1',
        rooms: {
          invite: {
            '!new:h': {
              invite_state: {
                events: [
                  {
                    type: 'm.room.member',
                    state_key: '@qwenbot:home.example.com',
                    content: { membership: 'invite' },
                  },
                ],
              },
            },
          },
        },
      },
    ]);
    await h.bridge.start(h.ac.signal);
    expect(h.joined).toEqual(['!new:h']);
  });

  /** Builds a `/sync` invite payload for the given room ids (bot MXID matches `harness`). */
  function inviteBatch(roomIds: string[], next_batch: string) {
    const invite: Record<string, unknown> = {};
    for (const roomId of roomIds) {
      invite[roomId] = {
        invite_state: {
          events: [
            {
              type: 'm.room.member',
              state_key: '@qwenbot:home.example.com',
              content: { membership: 'invite' },
            },
          ],
        },
      };
    }
    return { next_batch, rooms: { invite } };
  }

  it('rate-limits invite auto-join: a burst beyond the cap only joins up to the cap, excess declined', async () => {
    const roomIds = Array.from(
      { length: MATRIX_INVITE_AUTOJOIN_CAP + 5 },
      (_, i) => `!flood${i}:h`,
    );
    const h = harness([inviteBatch(roomIds, 's1')]);
    await h.bridge.start(h.ac.signal);
    // Exactly the first CAP invites are joined, in order; the excess 5 are declined.
    expect(h.joined).toEqual(roomIds.slice(0, MATRIX_INVITE_AUTOJOIN_CAP));
  });

  it('a single invite under the cap still joins (binding path intact)', async () => {
    const h = harness([inviteBatch(['!solo:h'], 's1')]);
    await h.bridge.start(h.ac.signal);
    expect(h.joined).toEqual(['!solo:h']);
  });

  it('posts the encryption notice exactly once for an encrypted room', async () => {
    const enc = {
      rooms: {
        join: {
          '!enc:h': {
            state: { events: [{ type: 'm.room.encryption', content: {} }] },
          },
        },
      },
    };
    const h = harness([
      { next_batch: 's1', ...enc },
      { next_batch: 's2', ...enc }, // still encrypted; must NOT re-notice
    ]);
    await h.bridge.start(h.ac.signal);
    const notices = h.sent.filter(
      (s) => (s.content as { body?: string }).body === ENCRYPTED_ROOM_NOTICE,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].roomId).toBe('!enc:h');
  });

  it('backs off between failed syncs instead of busy-spinning', async () => {
    // No bound rooms → the SSE loop subscribes nothing, so `sleep` is called
    // ONLY by the sync loop's backoff. syncOnce resolves {} forever (no
    // next_batch, no abort) — the failure mode the cli wrapper never throws on.
    const ac = new AbortController();
    let syncCalls = 0;
    let sleepCalls = 0;
    const client = {
      register: async () => ({ ok: true, status: 200 }),
      subscribeEvents: async () => {},
    } as unknown as BridgeClient;
    const rest = {
      sendMessage: async () => ({ ok: true, status: 200, eventId: '$x' }),
      joinRoom: async () => ({ ok: true, status: 200 }),
    } as unknown as MatrixInbound;
    const bridge = new MatrixBridge({
      client,
      rest,
      rooms,
      botUserId: '@qwenbot:home.example.com',
      baseUrl: 'http://x',
      syncOnce: async () => {
        syncCalls++;
        return {}; // never advances (no next_batch), never aborts
      },
      sleep: async () => {
        sleepCalls++;
        if (sleepCalls >= 3) ac.abort();
      },
    });
    await bridge.start(ac.signal);
    // It slept between each failed sync (didn't spin), and looped >1 time.
    expect(sleepCalls).toBeGreaterThanOrEqual(3);
    expect(syncCalls).toBeGreaterThanOrEqual(3);
  });

  it('subscribes to already-bound sessions on start', async () => {
    await rooms.bind('!r:h', 'sess_q');
    const h = harness([]);
    await h.bridge.start(h.ac.signal);
    await waitFor(() => h.subscribed.includes('sess_q'));
    expect(h.subscribed).toContain('sess_q');
  });
});

describe('MatrixBridge runner — outbound delivery', () => {
  it('renders a permission_request to every bound room', async () => {
    await rooms.bind('!r1:h', 'sess_q');
    await rooms.bind('!r2:h', 'sess_q');
    const h = harness([]);
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
    expect(h.sent.map((s) => s.roomId).sort()).toEqual(['!r1:h', '!r2:h']);
    expect((h.sent[0].content as { body: string }).body).toContain('Edit a.ts');
  });

  it('edits via m.replace on permission_resolved', async () => {
    await rooms.bind('!r1:h', 'sess_q');
    const h = harness([]);
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

    const edit = h.sent[h.sent.length - 1].content as Record<string, unknown>;
    expect(edit['m.relates_to']).toMatchObject({ rel_type: 'm.replace' });
    expect((edit['m.new_content'] as { body: string }).body).toContain(
      'Resolved: allow_once',
    );
  });

  it('ignores a session_update with no agent text (rooms stay quiet)', async () => {
    await rooms.bind('!r1:h', 'sess_q');
    const h = harness([]);
    h.bridge.deliverEvent('sess_q', {
      type: 'session_update',
      data: { update: { sessionUpdate: 'agent_thought_chunk' } },
    });
    h.fireTimers();
    await h.drainStream();
    expect(h.sent).toEqual([]);
  });
});

describe('MatrixBridge runner — session_update streaming', () => {
  const chunk = (text: string) => ({
    type: 'session_update' as const,
    data: {
      update: { sessionUpdate: 'agent_message_chunk', content: { text } },
    },
  });

  it('streams agent text as m.text with an HTML formatted_body', async () => {
    await rooms.bind('!r1:h', 'sess_q');
    const h = harness([]);
    h.bridge.deliverEvent('sess_q', chunk('**bold** and `code`\n\n'));
    await h.drainStream();
    expect(h.sent).toHaveLength(1);
    const content = h.sent[0].content as Record<string, unknown>;
    expect(content.msgtype).toBe('m.text');
    expect(content.format).toBe('org.matrix.custom.html');
    expect(content.formatted_body).toBe(
      '<strong>bold</strong> and <code>code</code><br><br>',
    );
    expect(content.body).toContain('**bold**'); // plaintext keeps the markdown
  });

  it('relates the 7th message of a turn into an m.thread off the first', async () => {
    await rooms.bind('!r1:h', 'sess_q');
    const h = harness([]);
    for (let n = 1; n <= 7; n++) {
      h.bridge.deliverEvent('sess_q', chunk(`line ${n}\n\n`));
      await h.drainStream();
    }
    const first = h.sent[0].content as Record<string, unknown>;
    const seventh = h.sent[6].content as Record<string, unknown>;
    expect(first['m.relates_to']).toBeUndefined();
    expect(seventh['m.relates_to']).toMatchObject({
      rel_type: 'm.thread',
      event_id: '$evt_1', // the first message's event id
    });
  });
});

describe('MatrixBridge.dispatchDecryptedMessage (E2EE routing seam)', () => {
  it('routes a decrypted prompt into a bound session, like the plain path', async () => {
    await rooms.bind('!enc:h', 'sess_e2ee');
    const h = harness([]); // no sync batches; we drive dispatch directly
    await h.bridge.dispatchDecryptedMessage({
      roomId: '!enc:h',
      sender: '@alice:h',
      body: 'decrypted prompt',
    });
    expect(h.prompts).toEqual(['decrypted prompt']);
  });

  it('does NOT relay the bot’s own decrypted message (no echo loop)', async () => {
    await rooms.bind('!enc:h', 'sess_e2ee');
    const h = harness([]);
    await h.bridge.dispatchDecryptedMessage({
      roomId: '!enc:h',
      sender: '@qwenbot:home.example.com', // the bot itself
      body: 'echo',
    });
    expect(h.prompts).toEqual([]);
  });

  it('ignores a decrypted message in an unbound room', async () => {
    const h = harness([]); // no binding for !enc:h
    await h.bridge.dispatchDecryptedMessage({
      roomId: '!enc:h',
      sender: '@alice:h',
      body: 'nowhere',
    });
    expect(h.prompts).toEqual([]);
  });

  it('picks up a session newly bound by a decrypted-path !qwen attach', async () => {
    // The crypto path has no per-batch reconcile (no fetch syncLoop), so
    // dispatchDecryptedMessage must reconcile subscriptions after a successful
    // attach — else the freshly-bound session never gets its SSE echo loop.
    const h = harness([], { park: true });
    void h.bridge.start(h.ac.signal);
    // A moderator (power ≥ 50) attaches in a fresh (unbound) encrypted room.
    await h.bridge.dispatchDecryptedMessage(
      { roomId: '!fresh:h', sender: '@mod:h', body: '!qwen attach tok123' },
      50,
    );
    await waitFor(() => h.subscribed.includes('sess_new'));
    expect(h.subscribed).toContain('sess_new');
    h.ac.abort();
  });
});

describe('MatrixBridge.dispatchReaction (E2EE vote routing seam)', () => {
  it('routes a 👍 on a tracked permission_request into an allow_once vote', async () => {
    await rooms.bind('!enc:h', 'sess_e2ee');
    const h = harness([]);
    // Render a permission_request so its sent event id is tracked for votes.
    h.bridge.deliverEvent('sess_e2ee', {
      type: 'permission_request',
      data: {
        requestId: 'req1',
        bridgeHints: {
          argsSummaryShort: 'run ls',
          recommendedSurface: 'inline',
        },
      },
    } as never);
    await waitFor(() => h.sent.length === 1);
    const eventId = (h.sent[0].content as { body: string }) && '$evt_1';

    await h.bridge.dispatchReaction({
      roomId: '!enc:h',
      sender: '@alice:h',
      targetEventId: eventId,
      key: '👍',
    });
    expect(h.votes).toEqual([
      {
        sessionId: 'sess_e2ee',
        requestId: 'req1',
        outcome: 'allow_once',
        subActor: 'matrix:@alice:h',
      },
    ]);
  });

  it('ignores a reaction on an untracked event (no vote)', async () => {
    await rooms.bind('!enc:h', 'sess_e2ee');
    const h = harness([]);
    await h.bridge.dispatchReaction({
      roomId: '!enc:h',
      sender: '@alice:h',
      targetEventId: '$never-tracked',
      key: '👍',
    });
    expect(h.votes).toEqual([]);
  });
});
