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
import {
  handleMessage,
  handleSlashCommand,
  handleComponent,
  type DiscordDispatchDeps,
} from './dispatch.js';
import type { WriteResult } from '../client.js';
import type { DiscordRestResult } from './restApi.js';

let dir: string;
let channels: DiscordChannelStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-dc-disp-'));
  channels = await DiscordChannelStore.open(join(dir, 'channels.json'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(over: Partial<DiscordDispatchDeps> = {}) {
  const prompts: Array<{
    sessionId: string;
    prompt: string;
    subActor: string;
  }> = [];
  const votes: Array<{
    sessionId: string;
    requestId: string;
    outcome: string;
    subActor: string;
  }> = [];
  const sent: Array<{ channelId: string; text: string }> = [];
  const replies: string[] = [];
  const defers: string[] = [];
  const editedReplies: Array<{ token: string; text: string }> = [];

  let promptResult: WriteResult = { ok: true, status: 200 };
  let voteResult: WriteResult = { ok: true, status: 200 };
  let editReplyResult: DiscordRestResult = { ok: true, status: 200 };
  const redeems: Array<{ bridgeId: string; token: string }> = [];
  let redeemResult: (WriteResult & { sessionId?: string }) | undefined;

  const ok: DiscordRestResult = { ok: true, status: 200 };
  const base: DiscordDispatchDeps = {
    bridge: {
      redeemInvite: async (bridgeId, token) => {
        redeems.push({ bridgeId, token });
        if (redeemResult) return redeemResult;
        return token === 'inv_ok'
          ? { ok: true, status: 200, sessionId: 'sess_abc' }
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
      vote: async (sessionId, requestId, outcome, subActor) => {
        votes.push({ sessionId, requestId, outcome, subActor });
        return voteResult;
      },
    },
    rest: {
      createMessage: async (channelId, text) => {
        sent.push({ channelId, text });
        return ok;
      },
      replyEphemeral: async (_id, _tok, content) => {
        replies.push(content);
        return ok;
      },
      deferInteraction: async (id) => {
        defers.push(id);
        return ok;
      },
      editInteractionReply: async (token, text) => {
        editedReplies.push({ token, text });
        return editReplyResult;
      },
    },
    channels,
    bridgeId: 'discord',
    bans: new Set<string>(),
    ...over,
  };
  return {
    deps: base,
    prompts,
    votes,
    sent,
    replies,
    defers,
    editedReplies,
    redeems,
    setPromptResult: (r: WriteResult) => (promptResult = r),
    setVoteResult: (r: WriteResult) => (voteResult = r),
    setEditReplyResult: (r: DiscordRestResult) => (editReplyResult = r),
    setRedeemResult: (r: WriteResult & { sessionId?: string }) =>
      (redeemResult = r),
  };
}

describe('discord dispatch — chat message → prompt', () => {
  it('forwards a bound-channel message with a snowflake sub-actor', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps();
    await handleMessage(
      {
        channelId: 'chan_42',
        authorId: '111122223333',
        isBot: false,
        content: 'run the tests',
      },
      f.deps,
    );
    expect(f.prompts).toEqual([
      {
        sessionId: 'sess_abc',
        prompt: 'run the tests',
        subActor: 'discord:111122223333',
      },
    ]);
  });

  it('signals a turn boundary on an accepted prompt, but not on a banned 403', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const turns: string[] = [];
    const f = deps({ onTurnBoundary: (s) => turns.push(s) });
    await handleMessage(
      { channelId: 'chan_42', authorId: '1', isBot: false, content: 'go' },
      f.deps,
    );
    expect(turns).toEqual(['sess_abc']); // ok prompt → new turn

    f.setPromptResult({ ok: false, status: 403 });
    await handleMessage(
      { channelId: 'chan_42', authorId: '2', isBot: false, content: 'x' },
      f.deps,
    );
    expect(turns).toEqual(['sess_abc']); // 403 banned → no turn boundary
  });

  it('ignores the bot’s own messages (no echo loop)', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps();
    await handleMessage(
      { channelId: 'chan_42', authorId: 'bot', isBot: true, content: 'hi' },
      f.deps,
    );
    expect(f.prompts).toHaveLength(0);
  });

  it('ignores messages in unbound channels', async () => {
    const f = deps();
    await handleMessage(
      { channelId: 'nope', authorId: 'u1', isBot: false, content: 'hi' },
      f.deps,
    );
    expect(f.prompts).toHaveLength(0);
  });

  it('drops a locally-banned author', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps({ bans: new Set(['discord:111122223333']) });
    await handleMessage(
      {
        channelId: 'chan_42',
        authorId: '111122223333',
        isBot: false,
        content: 'x',
      },
      f.deps,
    );
    expect(f.prompts).toHaveLength(0);
  });

  it('caches the ban on a daemon 403', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps();
    f.setPromptResult({ ok: false, status: 403 });
    await handleMessage(
      {
        channelId: 'chan_42',
        authorId: '111122223333',
        isBot: false,
        content: 'x',
      },
      f.deps,
    );
    expect(f.deps.bans.has('discord:111122223333')).toBe(true);
  });

  it('posts a channel "slow down" notice on a 429', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps();
    f.setPromptResult({ ok: false, status: 429, retryAfterSec: 7 });
    await handleMessage(
      { channelId: 'chan_42', authorId: 'u1', isBot: false, content: 'x' },
      f.deps,
    );
    expect(f.sent[0].channelId).toBe('chan_42');
    expect(f.sent[0].text).toContain('7 seconds');
  });
});

describe('discord dispatch — slash commands', () => {
  const cmd = (name: 'attach' | 'detach' | 'status', arg?: string) => ({
    interactionId: 'int_1',
    interactionToken: 'tok',
    channelId: 'chan_42',
    guildId: 'g1',
    userId: 'u1',
    name,
    arg,
  });

  it('attach REDEEMS the invite token and binds the returned session', async () => {
    const f = deps();
    await handleSlashCommand(cmd('attach', 'inv_ok'), f.deps);
    expect(f.redeems).toEqual([{ bridgeId: 'discord', token: 'inv_ok' }]);
    expect(channels.sessionFor('chan_42')).toBe('sess_abc');
    expect(f.replies[0]).toContain('sess_abc');
  });

  it('attach with a bad token relays the gateway error and binds NOTHING', async () => {
    const f = deps();
    await handleSlashCommand(cmd('attach', 'inv_bad'), f.deps);
    expect(channels.sessionFor('chan_42')).toBeUndefined();
    expect(f.replies[0]).toBe('Invalid or expired invite token');
  });

  it('attach with no arg replies with usage and does not redeem', async () => {
    const f = deps();
    await handleSlashCommand(cmd('attach', '  '), f.deps);
    expect(f.redeems).toHaveLength(0);
    expect(channels.sessionFor('chan_42')).toBeUndefined();
    expect(f.replies[0]).toContain('Usage');
  });

  it('detach unbinds and confirms', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps();
    await handleSlashCommand(cmd('detach'), f.deps);
    expect(channels.sessionFor('chan_42')).toBeUndefined();
    expect(f.replies[0]).toContain('unbound');
  });

  it('status reports the current binding', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps();
    await handleSlashCommand(cmd('status'), f.deps);
    expect(f.replies[0]).toContain('sess_abc');
  });
});

describe('discord dispatch — button click → vote', () => {
  const comp = (customId: string, userId = '111122223333') => ({
    interactionId: 'int_1',
    interactionToken: 'tok',
    channelId: 'chan_42',
    userId,
    customId,
  });

  it('defers, votes with the snowflake sub-actor, and edits the reply', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps();
    await handleComponent(comp('vote:approve:req_xyz'), f.deps);
    expect(f.defers).toEqual(['int_1']); // acked first
    expect(f.votes).toEqual([
      {
        sessionId: 'sess_abc',
        requestId: 'req_xyz',
        outcome: 'allow_once',
        subActor: 'discord:111122223333',
      },
    ]);
    expect(f.editedReplies[0].text).toContain('approve');
  });

  it('maps deny to cancelled', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps();
    await handleComponent(comp('vote:deny:req_xyz'), f.deps);
    expect(f.votes[0].outcome).toBe('cancelled');
  });

  it('acks a banned clicker but does NOT relay the vote', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps({ bans: new Set(['discord:111122223333']) });
    await handleComponent(comp('vote:approve:req_xyz'), f.deps);
    expect(f.defers).toEqual(['int_1']); // still acked (Discord 3s rule)
    expect(f.votes).toHaveLength(0);
  });

  it('acks but ignores a foreign custom_id', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps();
    await handleComponent(comp('not:ours:x'), f.deps);
    expect(f.defers).toEqual(['int_1']);
    expect(f.votes).toHaveLength(0);
  });

  it('caches the ban and tells the clicker on a 403', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps();
    f.setVoteResult({ ok: false, status: 403 });
    await handleComponent(comp('vote:approve:req_xyz'), f.deps);
    expect(f.deps.bans.has('discord:111122223333')).toBe(true);
    expect(f.editedReplies[0].text).toContain('blocked');
  });

  it('>15-min fallback: sends a channel message mentioning the voter when editInteractionReply fails', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps();
    // Simulate an expired interaction token (Discord 401/404 after >15 min).
    f.setEditReplyResult({ ok: false, status: 401 });
    await handleComponent(comp('vote:approve:req_xyz'), f.deps);
    // No edited reply was recorded (editInteractionReply was called but failed).
    expect(f.editedReplies).toHaveLength(1);
    // A channel message was sent mentioning the voter instead.
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].channelId).toBe('chan_42');
    expect(f.sent[0].text).toContain('<@111122223333>');
    expect(f.sent[0].text).toContain('approve');
  });

  it('>15-min fallback: channel message mentions voter on vote failure too', async () => {
    await channels.bind('chan_42', 'g1', 'sess_abc');
    const f = deps();
    f.setVoteResult({ ok: false, status: 500 });
    f.setEditReplyResult({ ok: false, status: 401 });
    await handleComponent(comp('vote:approve:req_xyz'), f.deps);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].text).toContain('<@111122223333>');
    expect(f.sent[0].text).toContain('Vote failed');
  });
});
