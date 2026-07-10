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
import {
  handleUpdate,
  type DispatchDeps,
  type SentPermissionMessage,
} from './dispatch.js';
import type { WriteResult } from '../client.js';

interface SentMsg {
  chatId: number;
  text: string;
}
interface EditedMsg {
  chatId: number;
  messageId: number;
  text: string;
}
interface Ack {
  id: string;
  text?: string;
}

function fakeDeps(
  chats: TelegramChatStore,
  opts: {
    sentRequests?: Map<string, SentPermissionMessage[]>;
    resolvedRequests?: Set<string>;
  } = {},
) {
  const sent: SentMsg[] = [];
  const edited: EditedMsg[] = [];
  const acks: Ack[] = [];
  const prompts: Array<{
    sessionId: string;
    prompt: string;
    subActor: string;
  }> = [];
  const votes: Array<{ requestId: string; outcome: string; subActor: string }> =
    [];
  let promptResult: WriteResult = { ok: true, status: 200 };
  let voteResult: WriteResult = { ok: true, status: 200 };
  const redeems: Array<{ bridgeId: string; token: string }> = [];
  // By default a redeem of "inv_ok" → sess-x; anything else → the gateway error.
  let redeemResult: (WriteResult & { sessionId?: string }) | undefined;
  const deps: DispatchDeps = {
    chats,
    bridgeId: 'telegram',
    bans: new Set<string>(),
    sentRequests: opts.sentRequests,
    resolvedRequests: opts.resolvedRequests,
    bridge: {
      redeemInvite: async (bridgeId, token) => {
        redeems.push({ bridgeId, token });
        if (redeemResult) return redeemResult;
        return token === 'inv_ok'
          ? { ok: true, status: 200, sessionId: 'sess-x' }
          : {
              ok: false,
              status: 400,
              body: { error: 'Invalid or expired invite token' },
            };
      },
      sendPrompt: async (sessionId, prompt, subActor) => {
        prompts.push({ sessionId, prompt, subActor });
        return promptResult;
      },
      vote: async (_sessionId, requestId, outcome, subActor) => {
        votes.push({ requestId, outcome, subActor });
        return voteResult;
      },
    },
    tg: {
      sendMessage: async (chatId, text) => {
        sent.push({ chatId, text });
        return { ok: true, status: 200 };
      },
      editMessageText: async (chatId, messageId, text) => {
        edited.push({ chatId, messageId, text });
        return { ok: true, status: 200 };
      },
      answerCallbackQuery: async (id, text) => {
        acks.push({ id, text });
        return { ok: true, status: 200 };
      },
    },
  };
  return {
    deps,
    sent,
    edited,
    acks,
    prompts,
    votes,
    redeems,
    setPromptResult: (r: WriteResult) => (promptResult = r),
    setVoteResult: (r: WriteResult) => (voteResult = r),
    setRedeemResult: (r: WriteResult & { sessionId?: string }) =>
      (redeemResult = r),
  };
}

let dir: string;
let chats: TelegramChatStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-tg-chats-'));
  chats = await TelegramChatStore.open(join(dir, 'chats.json'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('TelegramChatStore', () => {
  it('binds, looks up, reverse-maps, and persists across reopen', async () => {
    await chats.bind(100, 'sess-a');
    await chats.bind(101, 'sess-a');
    await chats.bind(102, 'sess-b');
    expect(chats.sessionFor(100)).toBe('sess-a');
    expect(chats.chatsFor('sess-a').sort()).toEqual([100, 101]);
    expect(chats.boundSessions().sort()).toEqual(['sess-a', 'sess-b']);
    const reopened = await TelegramChatStore.open(join(dir, 'chats.json'));
    expect(reopened.sessionFor(102)).toBe('sess-b');
  });
});

describe('handleUpdate — messages', () => {
  it('/start <token> REDEEMS an invite and binds the returned session', async () => {
    const h = fakeDeps(chats);
    await handleUpdate(
      {
        update_id: 1,
        message: { message_id: 1, chat: { id: 5 }, text: '/start inv_ok' },
      },
      h.deps,
    );
    // redeemed via the bridge's id + the token; bound to the gateway's session
    expect(h.redeems).toEqual([{ bridgeId: 'telegram', token: 'inv_ok' }]);
    expect(chats.sessionFor(5)).toBe('sess-x');
    expect(h.sent[0].text).toContain('sess-x');
  });

  it('/start with a bad token relays the gateway error and binds NOTHING', async () => {
    const h = fakeDeps(chats);
    await handleUpdate(
      {
        update_id: 1,
        message: { message_id: 1, chat: { id: 5 }, text: '/start inv_bad' },
      },
      h.deps,
    );
    expect(chats.sessionFor(5)).toBeUndefined(); // no binding persisted
    expect(h.sent[0].text).toBe('Invalid or expired invite token');
  });

  it('/start with no token shows usage and does not redeem', async () => {
    const h = fakeDeps(chats);
    await handleUpdate(
      {
        update_id: 1,
        message: { message_id: 1, chat: { id: 5 }, text: '/start' },
      },
      h.deps,
    );
    expect(h.redeems).toHaveLength(0);
    expect(chats.sessionFor(5)).toBeUndefined();
    expect(h.sent[0].text).toContain('Usage');
  });

  it('a plain message in a bound chat becomes a prompt with the per-sender sub-actor', async () => {
    await chats.bind(5, 'sess-x');
    const h = fakeDeps(chats);
    await handleUpdate(
      {
        update_id: 2,
        message: {
          message_id: 2,
          chat: { id: 5 },
          from: { id: 67890 },
          text: 'run tests',
        },
      },
      h.deps,
    );
    expect(h.prompts[0]).toEqual({
      sessionId: 'sess-x',
      prompt: 'run tests',
      subActor: 'telegram:67890',
    });
  });

  it('an unbound chat is told to /start first (no prompt)', async () => {
    const h = fakeDeps(chats);
    await handleUpdate(
      {
        update_id: 3,
        message: {
          message_id: 3,
          chat: { id: 9 },
          from: { id: 1 },
          text: 'hi',
        },
      },
      h.deps,
    );
    expect(h.prompts).toHaveLength(0);
    expect(h.sent[0].text).toContain('/start');
  });

  it('a 429 from the gateway → a "slow down" reply with the retry window', async () => {
    await chats.bind(5, 'sess-x');
    const h = fakeDeps(chats);
    h.setPromptResult({ ok: false, status: 429, retryAfterSec: 9 });
    await handleUpdate(
      {
        update_id: 4,
        message: {
          message_id: 4,
          chat: { id: 5 },
          from: { id: 1 },
          text: 'spam',
        },
      },
      h.deps,
    );
    expect(h.sent[0].text).toContain('9 seconds');
  });

  it('a 403 sub_actor_banned caches the ban and drops subsequent prompts', async () => {
    await chats.bind(5, 'sess-x');
    const h = fakeDeps(chats);
    h.setPromptResult({ ok: false, status: 403 });
    const msg = (text: string) => ({
      update_id: 5,
      message: { message_id: 5, chat: { id: 5 }, from: { id: 42 }, text },
    });
    await handleUpdate(msg('first'), h.deps);
    expect(h.deps.bans.has('telegram:42')).toBe(true);
    await handleUpdate(msg('second'), h.deps);
    expect(h.prompts).toHaveLength(1); // the banned 2nd never reached the gateway
  });
});

describe('handleUpdate — callbacks', () => {
  it('an Approve tap votes allow_once and acks the query', async () => {
    await chats.bind(5, 'sess-x');
    const h = fakeDeps(chats);
    await handleUpdate(
      {
        update_id: 6,
        callback_query: {
          id: 'cbq1',
          from: { id: 67890 },
          message: { chat: { id: 5 } },
          data: 'vote:approve:req_z',
        },
      },
      h.deps,
    );
    expect(h.votes[0]).toEqual({
      requestId: 'req_z',
      outcome: 'allow_once',
      subActor: 'telegram:67890',
    });
    expect(h.acks[0]).toEqual({ id: 'cbq1', text: 'Approved' });
  });

  it('a foreign callback is acked and ignored (no vote)', async () => {
    const h = fakeDeps(chats);
    await handleUpdate(
      {
        update_id: 7,
        callback_query: { id: 'cbq2', from: { id: 1 }, data: 'other:thing' },
      },
      h.deps,
    );
    expect(h.votes).toHaveLength(0);
    expect(h.acks[0].id).toBe('cbq2');
  });

  it('a late tap on an already-resolved request acks "Already resolved" without voting', async () => {
    await chats.bind(5, 'sess-x');
    const resolvedRequests = new Set<string>(['req_done']);
    const h = fakeDeps(chats, { resolvedRequests });
    await handleUpdate(
      {
        update_id: 8,
        callback_query: {
          id: 'cbq3',
          from: { id: 67890 },
          message: { message_id: 42, chat: { id: 5 } },
          data: 'vote:approve:req_done',
        },
      },
      h.deps,
    );
    expect(h.votes).toHaveLength(0);
    expect(h.acks[0]).toEqual({ id: 'cbq3', text: 'Already resolved' });
  });
});
