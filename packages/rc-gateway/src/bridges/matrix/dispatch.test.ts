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
import {
  handleMessage,
  handleReaction,
  senderPowerLevel,
  ENCRYPTED_ROOM_NOTICE,
  DEEPLINK_REACTION_GUIDANCE,
  type MatrixDispatchDeps,
  type TrackedEvent,
} from './dispatch.js';
import type { WriteResult } from '../client.js';

let dir: string;
let rooms: MatrixRoomStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rc-mx-disp-'));
  rooms = await MatrixRoomStore.open(join(dir, 'rooms.json'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(over: Partial<MatrixDispatchDeps> = {}) {
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
  const sent: Array<{ roomId: string; body: string }> = [];
  let promptResult: WriteResult = { ok: true, status: 200 };
  let voteResult: WriteResult = { ok: true, status: 200 };
  const redeems: Array<{ bridgeId: string; token: string }> = [];
  let redeemResult: (WriteResult & { sessionId?: string }) | undefined;

  const base: MatrixDispatchDeps = {
    bridge: {
      redeemInvite: async (bridgeId, token) => {
        redeems.push({ bridgeId, token });
        if (redeemResult) return redeemResult;
        return token === 'inv_ok'
          ? { ok: true, status: 200, sessionId: 'sess_xyz' }
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
      sendMessage: async (roomId, content) => {
        sent.push({ roomId, body: (content as { body: string }).body });
        return { ok: true, status: 200, eventId: '$sent' };
      },
    },
    rooms,
    bridgeId: 'matrix',
    bans: new Set<string>(),
    encryptedRooms: new Set<string>(),
    tracked: new Map<string, TrackedEvent>(),
    commandPrefix: '!qwen',
    ...over,
  };
  return {
    deps: base,
    prompts,
    votes,
    sent,
    redeems,
    setPromptResult: (r: WriteResult) => (promptResult = r),
    setVoteResult: (r: WriteResult) => (voteResult = r),
    setRedeemResult: (r: WriteResult & { sessionId?: string }) =>
      (redeemResult = r),
  };
}

const msg = (over: Record<string, unknown> = {}) => ({
  roomId: '!abc:home.example.com',
  sender: '@alice:home.example.com',
  isBot: false,
  body: 'hi',
  powerLevel: 0,
  ...over,
});

describe('senderPowerLevel', () => {
  it('prefers users[sender], falls back to users_default, then 0', () => {
    expect(senderPowerLevel({ users: { '@a:h': 100 } }, '@a:h')).toBe(100);
    expect(senderPowerLevel({ users_default: 25 }, '@a:h')).toBe(25);
    expect(senderPowerLevel(undefined, '@a:h')).toBe(0);
    expect(senderPowerLevel({ users: {} }, '@a:h')).toBe(0);
  });
});

describe('matrix dispatch — message → prompt', () => {
  it('forwards a bound-room message with the MXID sub-actor', async () => {
    await rooms.bind('!abc:home.example.com', 'sess_xyz');
    const f = deps();
    await handleMessage(msg({ body: 'run the tests' }), f.deps);
    expect(f.prompts).toEqual([
      {
        sessionId: 'sess_xyz',
        prompt: 'run the tests',
        subActor: 'matrix:@alice:home.example.com',
      },
    ]);
  });

  it('signals a turn boundary on an accepted prompt, not on a banned 403', async () => {
    await rooms.bind('!abc:home.example.com', 'sess_xyz');
    const turns: string[] = [];
    const f = deps({ onTurnBoundary: (s) => turns.push(s) });
    await handleMessage(msg({ body: 'go' }), f.deps);
    expect(turns).toEqual(['sess_xyz']);

    f.setPromptResult({ ok: false, status: 403 });
    await handleMessage(
      msg({ body: 'x', sender: '@alice:home.example.com' }),
      f.deps,
    );
    expect(turns).toEqual(['sess_xyz']); // 403 → no boundary
  });

  it('ignores the bot’s own messages', async () => {
    await rooms.bind('!abc:home.example.com', 'sess_xyz');
    const f = deps();
    await handleMessage(msg({ isBot: true }), f.deps);
    expect(f.prompts).toHaveLength(0);
  });

  it('ignores messages in unbound rooms', async () => {
    const f = deps();
    await handleMessage(msg(), f.deps);
    expect(f.prompts).toHaveLength(0);
  });

  it('drops a banned sender; caches a 403', async () => {
    await rooms.bind('!abc:home.example.com', 'sess_xyz');
    const banned = deps({ bans: new Set(['matrix:@alice:home.example.com']) });
    await handleMessage(msg(), banned.deps);
    expect(banned.prompts).toHaveLength(0);

    const f = deps();
    f.setPromptResult({ ok: false, status: 403 });
    await handleMessage(msg(), f.deps);
    expect(f.deps.bans.has('matrix:@alice:home.example.com')).toBe(true);
  });

  it('posts a room "slow down" reply on a 429', async () => {
    await rooms.bind('!abc:home.example.com', 'sess_xyz');
    const f = deps();
    f.setPromptResult({ ok: false, status: 429, retryAfterSec: 9 });
    await handleMessage(msg(), f.deps);
    expect(f.sent[0].body).toContain('9 seconds');
  });
});

describe('matrix dispatch — !qwen commands + power-level gate', () => {
  it('attach REDEEMS an invite when the invoker is a moderator (power ≥ 50)', async () => {
    const f = deps();
    await handleMessage(
      msg({ body: '!qwen attach inv_ok', powerLevel: 50 }),
      f.deps,
    );
    expect(f.redeems).toEqual([{ bridgeId: 'matrix', token: 'inv_ok' }]);
    expect(rooms.sessionFor('!abc:home.example.com')).toBe('sess_xyz');
    expect(f.sent[0].body).toContain('Room bound to session');
    expect(f.sent[0].body).toContain('React 👍/👎');
  });

  it('attach with a bad token relays the gateway error and binds NOTHING', async () => {
    const f = deps();
    await handleMessage(
      msg({ body: '!qwen attach inv_bad', powerLevel: 50 }),
      f.deps,
    );
    expect(rooms.sessionFor('!abc:home.example.com')).toBeUndefined();
    expect(f.sent[0].body).toBe('Invalid or expired invite token');
  });

  it('rejects attach from a non-moderator (power < 50) — no redeem, no binding', async () => {
    const f = deps();
    await handleMessage(
      msg({
        body: '!qwen attach inv_ok',
        sender: '@guest:home.example.com',
        powerLevel: 0,
      }),
      f.deps,
    );
    expect(f.redeems).toHaveLength(0); // power gate runs BEFORE redeem
    expect(rooms.sessionFor('!abc:home.example.com')).toBeUndefined();
    expect(f.sent[0].body).toContain('power level ≥ 50');
  });

  it('refuses attach in an encrypted room — no redeem, no binding', async () => {
    const f = deps({ encryptedRooms: new Set(['!abc:home.example.com']) });
    await handleMessage(
      msg({ body: '!qwen attach inv_ok', powerLevel: 100 }),
      f.deps,
    );
    expect(f.redeems).toHaveLength(0); // encryption gate runs BEFORE redeem
    expect(rooms.sessionFor('!abc:home.example.com')).toBeUndefined();
    expect(f.sent[0].body).toBe(ENCRYPTED_ROOM_NOTICE);
  });

  it('detach unbinds for a moderator', async () => {
    await rooms.bind('!abc:home.example.com', 'sess_xyz');
    const f = deps();
    await handleMessage(msg({ body: '!qwen detach', powerLevel: 50 }), f.deps);
    expect(rooms.sessionFor('!abc:home.example.com')).toBeUndefined();
    expect(f.sent[0].body).toContain('unbound');
  });

  it('status reports the binding', async () => {
    await rooms.bind('!abc:home.example.com', 'sess_xyz');
    const f = deps();
    await handleMessage(msg({ body: '!qwen status' }), f.deps);
    expect(f.sent[0].body).toContain('sess_xyz');
  });

  it('a command is never forwarded as a prompt', async () => {
    await rooms.bind('!abc:home.example.com', 'sess_xyz');
    const f = deps();
    await handleMessage(msg({ body: '!qwen status', powerLevel: 50 }), f.deps);
    expect(f.prompts).toHaveLength(0);
  });
});

describe('matrix dispatch — reaction → vote', () => {
  const react = (over: Record<string, unknown> = {}) => ({
    roomId: '!abc:home.example.com',
    sender: '@alice:home.example.com',
    targetEventId: '$m_42',
    key: '\u{1F44D}',
    ...over,
  });

  it('casts approve for a 👍 on a tracked inline event with the MXID sub-actor', async () => {
    const tracked = new Map([
      [
        '$m_42',
        {
          requestId: 'req_xyz',
          sessionId: 'sess_xyz',
          surface: 'inline' as const,
        },
      ],
    ]);
    const f = deps({ tracked });
    await handleReaction(react(), f.deps);
    expect(f.votes).toEqual([
      {
        sessionId: 'sess_xyz',
        requestId: 'req_xyz',
        outcome: 'allow_once',
        subActor: 'matrix:@alice:home.example.com',
      },
    ]);
  });

  it('casts cancelled for a 👎', async () => {
    const tracked = new Map([
      [
        '$m_42',
        {
          requestId: 'req_xyz',
          sessionId: 'sess_xyz',
          surface: 'inline' as const,
        },
      ],
    ]);
    const f = deps({ tracked });
    await handleReaction(react({ key: '\u{1F44E}' }), f.deps);
    expect(f.votes[0].outcome).toBe('cancelled');
  });

  it('ignores a reaction on an untracked event', async () => {
    const f = deps();
    await handleReaction(react(), f.deps);
    expect(f.votes).toHaveLength(0);
  });

  it('ignores a non-thumb reaction', async () => {
    const tracked = new Map([
      [
        '$m_42',
        {
          requestId: 'req_xyz',
          sessionId: 'sess_xyz',
          surface: 'inline' as const,
        },
      ],
    ]);
    const f = deps({ tracked });
    await handleReaction(react({ key: '❤️' }), f.deps);
    expect(f.votes).toHaveLength(0);
  });

  it('drops a banned reactor without voting or redacting', async () => {
    const tracked = new Map([
      [
        '$m_42',
        {
          requestId: 'req_xyz',
          sessionId: 'sess_xyz',
          surface: 'inline' as const,
        },
      ],
    ]);
    const f = deps({
      tracked,
      bans: new Set(['matrix:@alice:home.example.com']),
    });
    await handleReaction(react(), f.deps);
    expect(f.votes).toHaveLength(0);
    expect(f.sent).toHaveLength(0); // not redacted
  });

  it('caches the ban on a daemon 403', async () => {
    const tracked = new Map([
      [
        '$m_42',
        {
          requestId: 'req_xyz',
          sessionId: 'sess_xyz',
          surface: 'inline' as const,
        },
      ],
    ]);
    const f = deps({ tracked });
    f.setVoteResult({ ok: false, status: 403 });
    await handleReaction(react(), f.deps);
    expect(f.deps.bans.has('matrix:@alice:home.example.com')).toBe(true);
  });

  it('deeplink reaction: replies with guidance instead of voting (once per requestId)', async () => {
    const tracked = new Map([
      [
        '$m_42',
        {
          requestId: 'req_xyz',
          sessionId: 'sess_xyz',
          surface: 'deeplink' as const,
        },
      ],
    ]);
    const guidanceSent = new Set<string>();
    const f = deps({ tracked, deeplinkGuidanceSent: guidanceSent });
    // First reaction → guidance sent.
    await handleReaction(react(), f.deps);
    expect(f.votes).toHaveLength(0); // no vote posted
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].body).toBe(DEEPLINK_REACTION_GUIDANCE);
    // Second reaction → guidance NOT sent again (once per requestId).
    await handleReaction(react({ key: '\u{1F44E}' }), f.deps);
    expect(f.sent).toHaveLength(1); // still only 1
    expect(f.votes).toHaveLength(0);
  });

  it('deeplink reaction: sends guidance without a deeplinkGuidanceSent set (ephemeral guard)', async () => {
    const tracked = new Map([
      [
        '$m_42',
        {
          requestId: 'req_xyz',
          sessionId: 'sess_xyz',
          surface: 'deeplink' as const,
        },
      ],
    ]);
    const f = deps({ tracked }); // no deeplinkGuidanceSent → local guard applies
    await handleReaction(react(), f.deps);
    expect(f.sent[0].body).toBe(DEEPLINK_REACTION_GUIDANCE);
    expect(f.votes).toHaveLength(0);
  });
});
