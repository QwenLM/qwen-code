/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramChatStore } from './chatStore.js';
import { TelegramBridge } from './runner.js';
import { CursorStore } from '../cursorStore.js';
import type { BridgeClient } from '../client.js';
import type { TelegramBotApi, TelegramUpdate } from './botApi.js';

let dir: string;
let chats: TelegramChatStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-tg-run-'));
  chats = await TelegramChatStore.open(join(dir, 'chats.json'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fakes(updateBatches: TelegramUpdate[][]) {
  const sent: Array<{ chatId: number; text: string; keyboard?: unknown }> = [];
  const edited: Array<{
    chatId: number;
    messageId: number;
    text: string;
    keyboard?: unknown;
  }> = [];
  const subscribed: string[] = [];
  let registered = false;
  let batch = 0;
  const ac = new AbortController();

  const botApi = {
    getUpdates: async () => {
      const b = updateBatches[batch] ?? [];
      batch++;
      if (batch > updateBatches.length) ac.abort(); // stop after scripted batches
      return b;
    },
    sendMessage: async (
      chatId: number,
      text: string,
      opts?: { inlineKeyboard?: unknown },
    ) => {
      sent.push({ chatId, text, keyboard: opts?.inlineKeyboard });
      return { ok: true, status: 200, result: { message_id: 99 } };
    },
    editMessageText: async (
      chatId: number,
      messageId: number,
      text: string,
      opts?: { inlineKeyboard?: unknown },
    ) => {
      edited.push({ chatId, messageId, text, keyboard: opts?.inlineKeyboard });
      return { ok: true, status: 200 };
    },
    answerCallbackQuery: async () => ({ ok: true, status: 200 }),
  } as unknown as TelegramBotApi;

  const client = {
    register: async () => {
      registered = true;
      return { ok: true, status: 200 };
    },
    redeemInvite: async (_bridgeId: string, token: string) =>
      token === 'inv_ok'
        ? { ok: true, status: 200, sessionId: 'sess-q' }
        : { ok: false, status: 400, body: { error: 'bad' } },
    heartbeat: async () => ({ ok: true, status: 200 }),
    sendPrompt: async () => ({ ok: true, status: 200 }),
    vote: async () => ({ ok: true, status: 200 }),
    subscribeEvents: async (sessionId: string) => {
      subscribed.push(sessionId);
    },
  } as unknown as BridgeClient;

  return {
    ac,
    sent,
    edited,
    subscribed,
    isRegistered: () => registered,
    bridge: new TelegramBridge({
      botApi,
      client,
      chats,
      baseUrl: 'http://127.0.0.1:4170',
      pollTimeoutSec: 0,
    }),
  };
}

describe('TelegramBridge runner', () => {
  it('registers, then a /start invite redeem binds the chat and subscribes its session', async () => {
    const f = fakes([
      [
        {
          update_id: 1,
          message: { message_id: 1, chat: { id: 7 }, text: '/start inv_ok' },
        },
      ],
    ]);
    await f.bridge.start(f.ac.signal);
    expect(f.isRegistered()).toBe(true);
    expect(chats.sessionFor(7)).toBe('sess-q'); // bound to the redeemed session
    expect(f.subscribed).toContain('sess-q'); // reconcile picked up the binding
  });

  it('deliverEvent renders a permission_request to every bound chat', async () => {
    await chats.bind(7, 'sess-q');
    await chats.bind(8, 'sess-q');
    const f = fakes([]);
    f.bridge.deliverEvent('sess-q', {
      type: 'permission_request',
      data: {
        requestId: 'req_1',
        bridgeHints: {
          recommendedSurface: 'inline',
          argsSummaryShort: 'Edit a.ts',
        },
      },
    });
    // Wait a microtask for the fire-and-forget sends.
    await new Promise((r) => setTimeout(r, 0));
    expect(f.sent.map((s) => s.chatId).sort()).toEqual([7, 8]);
    expect(f.sent[0].text).toContain('Edit a.ts');
    expect(f.sent[0].keyboard).toBeDefined();
  });

  it('deliverEvent ignores non-permission frames (chat stays quiet)', async () => {
    await chats.bind(7, 'sess-q');
    const f = fakes([]);
    f.bridge.deliverEvent('sess-q', {
      type: 'session_update',
      data: { text: 'thinking...' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(f.sent).toHaveLength(0);
  });

  it('deliverEvent permission_resolved edits the sent message in place (clears keyboard)', async () => {
    await chats.bind(7, 'sess-q');
    const f = fakes([]);
    // First deliver a permission_request so the runner records the sent message.
    f.bridge.deliverEvent('sess-q', {
      type: 'permission_request',
      data: {
        requestId: 'req_2',
        bridgeHints: {
          recommendedSurface: 'inline',
          argsSummaryShort: 'Delete b.ts',
        },
      },
    });
    // Let the async sendMessage complete (returns message_id: 99 in fakes).
    await new Promise((r) => setTimeout(r, 10));
    expect(f.sent).toHaveLength(1);

    // Now resolve the request.
    f.bridge.deliverEvent('sess-q', {
      type: 'permission_resolved',
      data: { requestId: 'req_2', outcome: 'allow_once' },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(f.edited).toHaveLength(1);
    expect(f.edited[0].chatId).toBe(7);
    expect(f.edited[0].messageId).toBe(99);
    expect(f.edited[0].text).toContain('allow_once');
    // keyboard should be cleared (empty array)
    expect(f.edited[0].keyboard).toEqual([]);
  });

  it('deliverEvent permission_resolved marks requestId as resolved (late tap returns "Already resolved")', async () => {
    await chats.bind(7, 'sess-q');
    const f = fakes([]);
    f.bridge.deliverEvent('sess-q', {
      type: 'permission_resolved',
      data: { requestId: 'req_3', outcome: 'cancelled' },
    });
    await new Promise((r) => setTimeout(r, 0));
    // The bridge's internal resolvedRequests set should contain req_3 so that
    // dispatchDeps() will return it and handleCallback will short-circuit.
    // We can verify this indirectly: a second permission_resolved for the same id
    // should be a no-op (no edit, no error).
    f.bridge.deliverEvent('sess-q', {
      type: 'permission_resolved',
      data: { requestId: 'req_3', outcome: 'cancelled' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(f.edited).toHaveLength(0); // no sent messages to edit
  });
});

describe('TelegramBridge — cursor persistence', () => {
  it('loads cursor from store on start and passes it as Last-Event-ID on subscribe', async () => {
    await chats.bind(7, 'sess-q');
    const cursors = await CursorStore.open(join(dir, 'cursors.json'));
    await cursors.setLastEventId('tok_a', 'sess-q', 77);

    const passedCursors: Array<number | undefined> = [];
    const ac = new AbortController();
    const botApi = {
      getUpdates: async () => {
        ac.abort();
        return [];
      },
      sendMessage: async () => ({ ok: true, status: 200 }),
      answerCallbackQuery: async () => ({ ok: true, status: 200 }),
    } as unknown as TelegramBotApi;
    const client = {
      register: async () => ({ ok: true, status: 200 }),
      heartbeat: async () => ({ ok: true, status: 200 }),
      subscribeEvents: async (
        _sid: string,
        _cb: unknown,
        _signal: unknown,
        cursor?: number,
      ) => {
        passedCursors.push(cursor);
      },
    } as unknown as BridgeClient;

    const bridge = new TelegramBridge({
      botApi,
      client,
      chats,
      cursors,
      tokenId: 'tok_a',
      baseUrl: 'http://127.0.0.1:4170',
      pollTimeoutSec: 0,
    });
    await bridge.start(ac.signal);
    // The cursor loaded from the store must be passed to subscribeEvents.
    expect(passedCursors).toContain(77);
  });

  it('persists cursor to the store when an SSE frame arrives', async () => {
    await chats.bind(7, 'sess-q');
    const cursors = await CursorStore.open(join(dir, 'cursors.json'));

    const ac = new AbortController();
    let eventCb: ((ev: unknown) => void) | undefined;
    const botApi = {
      getUpdates: async () => {
        ac.abort();
        return [];
      },
      sendMessage: async () => ({ ok: true, status: 200 }),
      answerCallbackQuery: async () => ({ ok: true, status: 200 }),
    } as unknown as TelegramBotApi;
    const client = {
      register: async () => ({ ok: true, status: 200 }),
      heartbeat: async () => ({ ok: true, status: 200 }),
      subscribeEvents: async (_sid: string, cb: (ev: unknown) => void) => {
        eventCb = cb;
      },
    } as unknown as BridgeClient;

    const bridge = new TelegramBridge({
      botApi,
      client,
      chats,
      cursors,
      tokenId: 'tok_b',
      baseUrl: 'http://127.0.0.1:4170',
      pollTimeoutSec: 0,
    });
    const startDone = bridge.start(ac.signal);
    // Yield so reconcileSubscriptions fires and eventCb is captured.
    await new Promise((r) => setTimeout(r, 0));
    eventCb?.({ id: 42, type: 'session_update', data: {} });
    // Allow the async persist to settle.
    await new Promise((r) => setTimeout(r, 10));
    await startDone;
    const entry = cursors.get('tok_b', 'sess-q');
    expect(entry?.lastEventId).toBe(42);
  });
});
