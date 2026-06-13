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
      return { ok: true, status: 200 };
    },
    answerCallbackQuery: async () => ({ ok: true, status: 200 }),
  } as unknown as TelegramBotApi;

  const client = {
    register: async () => {
      registered = true;
      return { ok: true, status: 200 };
    },
    sendPrompt: async () => ({ ok: true, status: 200 }),
    vote: async () => ({ ok: true, status: 200 }),
    subscribeEvents: async (sessionId: string) => {
      subscribed.push(sessionId);
    },
  } as unknown as BridgeClient;

  return {
    ac,
    sent,
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
  it('registers, then a /start update binds the chat and subscribes its session', async () => {
    const f = fakes([
      [
        {
          update_id: 1,
          message: { message_id: 1, chat: { id: 7 }, text: '/start sess-q' },
        },
      ],
    ]);
    await f.bridge.start(f.ac.signal);
    expect(f.isRegistered()).toBe(true);
    expect(chats.sessionFor(7)).toBe('sess-q');
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
});
