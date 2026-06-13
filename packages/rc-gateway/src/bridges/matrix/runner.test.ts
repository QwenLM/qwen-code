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
import { MatrixBridge } from './runner.js';
import { ENCRYPTED_ROOM_NOTICE } from './dispatch.js';
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

function harness(batches: unknown[]) {
  const sent: Array<{ roomId: string; content: unknown }> = [];
  const joined: string[] = [];
  const prompts: string[] = [];
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
  const client = {
    register: async () => ({ ok: true, status: 200 }),
    sendPrompt: async (_s: string, prompt: string) => {
      prompts.push(prompt);
      return { ok: true, status: 200 };
    },
    vote: async () => ({ ok: true, status: 200 }),
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
      if (i >= batches.length) {
        ac.abort();
        return {};
      }
      return batches[i++];
    },
    sleep: () => new Promise<void>(() => {}), // park SSE reconnect after 1 subscribe
  });

  return { bridge, ac, sent, joined, prompts, subscribed };
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
  it('skips replaying timeline history on the initial sync', async () => {
    await rooms.bind('!r:h', 'sess_q');
    const h = harness([
      // initial sync (since=undefined) carries a message — must NOT be replayed.
      { next_batch: 's1', ...textMsg('!r:h', '@evan:h', 'old history') },
    ]);
    await h.bridge.start(h.ac.signal);
    expect(h.prompts).toEqual([]);
  });

  it('dispatches a message from a non-initial sync as a prompt', async () => {
    await rooms.bind('!r:h', 'sess_q');
    const h = harness([
      { next_batch: 's1' }, // initial (skipped)
      { next_batch: 's2', ...textMsg('!r:h', '@evan:h', 'run the tests') },
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

  it('ignores non-permission frames', async () => {
    await rooms.bind('!r1:h', 'sess_q');
    const h = harness([]);
    h.bridge.deliverEvent('sess_q', {
      type: 'session_update',
      data: { text: 'x' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.sent).toEqual([]);
  });
});
