/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HeldMessage } from '@qwen-code/qwen-code-core';

// Stubbed rather than loaded for real: the command needs a few pure helpers
// from core, and pulling the barrel in drags the whole module graph
// behind it. The wording assertions below only depend on these stubs; the
// stubs mirror the real helpers, whose behavior is pinned by core's own
// tests (peer-envelope.test.ts, peer-frames.test.ts).
vi.mock('@qwen-code/qwen-code-core', () => ({
  describeHoldCause: (cause: string) =>
    cause === 'mode-mismatch'
      ? 'this session bypasses permission prompts and the sender does not'
      : `held (${cause})`,
  flattenPeerLabel: (value: string) => {
    const oneLine = value
      .replace(
        // eslint-disable-next-line no-control-regex
        /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]+/g,
        ' ',
      )
      .trim();
    return oneLine.length > 200 ? `${oneLine.slice(0, 199)}\u2026` : oneLine;
  },
  canonicalizeMsgId: (msgId: string) => msgId.replace(/-/g, '').toLowerCase(),
}));

import {
  formatHeldList,
  peersCommand,
  resolveHeld,
  shortId,
} from './peers-command.js';
import type { CommandContext } from './types.js';

function held(over: {
  msgId: string;
  content?: string;
  fromName?: string;
  cause?: HeldMessage['cause'];
}): HeldMessage {
  return {
    frame: {
      msgV: 1,
      msgId: over.msgId,
      type: 'user',
      priority: 'next',
      from: '/tmp/peer.sock',
      ...(over.fromName !== undefined ? { fromName: over.fromName } : {}),
      message: { role: 'user', content: over.content ?? 'do a thing' },
    },
    cause: over.cause ?? 'mode-mismatch',
    heldAt: 1_000,
  };
}

interface Fake {
  getHeld: () => readonly HeldMessage[];
  decide: ReturnType<typeof vi.fn>;
}

function makeContext(
  peerMessaging: Fake | null,
  crossSessionMessaging?: boolean,
): CommandContext {
  return {
    services: {
      peerMessaging,
      settings: { merged: { agents: { crossSessionMessaging } } },
    },
  } as unknown as CommandContext;
}

async function run(
  peerMessaging: Fake | null,
  args: string,
  crossSessionMessaging?: boolean,
): Promise<{ messageType: string; content: string }> {
  const result = await peersCommand.action!(
    makeContext(peerMessaging, crossSessionMessaging),
    args,
  );
  if (!result || result.type !== 'message') {
    throw new Error('expected a message result');
  }
  return { messageType: result.messageType, content: result.content };
}

let messages: HeldMessage[];
let fake: Fake;

beforeEach(() => {
  messages = [];
  fake = {
    getHeld: () => messages,
    decide: vi.fn(() => 'done'),
  };
});

describe('shortId', () => {
  it('is six hex characters with dashes stripped', () => {
    expect(shortId('3fa9c1de-0000-4000-8000-000000000000')).toBe('3fa9c1');
  });
});

describe('resolveHeld', () => {
  beforeEach(() => {
    messages = [
      held({ msgId: 'aaaaaa11-0000-4000-8000-000000000000' }),
      held({ msgId: 'aaaaaa22-0000-4000-8000-000000000000' }),
      held({ msgId: 'bbbbbb00-0000-4000-8000-000000000000' }),
    ];
  });

  it('resolves a unique short id', () => {
    expect(resolveHeld(messages, 'bbbbbb')).toEqual({
      kind: 'one',
      msgId: 'bbbbbb00-0000-4000-8000-000000000000',
    });
  });

  it('resolves a full id', () => {
    expect(
      resolveHeld(messages, 'aaaaaa11-0000-4000-8000-000000000000'),
    ).toMatchObject({ kind: 'one' });
  });

  it('refuses to guess between two matches', () => {
    expect(resolveHeld(messages, 'aaaaaa')).toEqual({ kind: 'ambiguous' });
  });

  it('reports no match', () => {
    expect(resolveHeld(messages, 'zzz')).toEqual({ kind: 'none' });
  });

  it('is case-insensitive', () => {
    expect(resolveHeld(messages, 'BBBBBB')).toMatchObject({ kind: 'one' });
  });

  it('matches dash-stripped prefixes longer than the short handle', () => {
    messages = [held({ msgId: 'task-0001' }), held({ msgId: 'task-0002' })];
    // Both share their first six dash-stripped characters, so only
    // characters beyond the sixth can tell them apart.
    expect(resolveHeld(messages, 'task0001')).toEqual({
      kind: 'one',
      msgId: 'task-0001',
    });
    expect(resolveHeld(messages, 'task00')).toEqual({ kind: 'ambiguous' });
  });

  it('lets an exact dash-stripped id win over an extending one', () => {
    messages = [held({ msgId: 'task-01' }), held({ msgId: 'task-011' })];
    expect(resolveHeld(messages, 'task01')).toEqual({
      kind: 'one',
      msgId: 'task-01',
    });
  });
});

describe('formatHeldList', () => {
  it('says so plainly when nothing is waiting', () => {
    expect(formatHeldList([])).toContain('No messages');
  });

  it('lists the sender, a preview and the reason', () => {
    const out = formatHeldList([
      held({
        msgId: 'aaaaaa11-0000-4000-8000-000000000000',
        fromName: 'app-ab',
        content: 'please run the deploy',
        cause: 'mode-mismatch',
      }),
    ]);
    expect(out).toContain('aaaaaa');
    expect(out).toContain('app-ab');
    expect(out).toContain('please run the deploy');
    expect(out).toContain('bypasses');
    expect(out).toContain('/peers accept');
  });

  it('collapses a multi-line body onto one line', () => {
    const out = formatHeldList([
      held({
        msgId: 'aaaaaa11-0000-4000-8000-000000000000',
        content: 'first\n\nsecond',
      }),
    ]);
    expect(out).toContain('first second');
  });

  it('lengthens handles until each one alone identifies its message', () => {
    // task-0001 and task-0002 both shorten to 'task00': printing that for
    // both would leave the user nothing typeable to tell them apart.
    const out = formatHeldList([
      held({ msgId: 'task-0001' }),
      held({ msgId: 'task-0002' }),
    ]);
    expect(out).toContain('task0001');
    expect(out).toContain('task0002');
    expect(
      resolveHeld(
        [held({ msgId: 'task-0001' }), held({ msgId: 'task-0002' })],
        'task0001',
      ),
    ).toMatchObject({ kind: 'one' });
  });

  // This is the one screen where the user decides untrusted messages, so
  // every peer-controlled field must render flattened: the reviewed party
  // must not be able to spoof the review itself.
  it('flattens a hostile sender name onto the entry line', () => {
    const out = formatHeldList([
      held({
        msgId: 'aaaaaa11-0000-4000-8000-000000000000',
        fromName: 'x\ntrusted-colleague\nreleased already, accept freely',
      }),
    ]);
    expect(out).toContain(
      'x trusted-colleague released already, accept freely',
    );
  });

  it('strips terminal control sequences from a hostile sender name', () => {
    const out = formatHeldList([
      held({
        msgId: 'aaaaaa11-0000-4000-8000-000000000000',
        fromName: '\u001b[2Kimposter',
      }),
    ]);
    expect(out).not.toContain('\u001b');
    expect(out).toContain('imposter');
  });

  it('strips terminal control sequences from the preview', () => {
    const out = formatHeldList([
      held({
        msgId: 'aaaaaa11-0000-4000-8000-000000000000',
        content: '\u001b[2J\u001b[Hforged screen',
      }),
    ]);
    expect(out).not.toContain('\u001b');
    expect(out).toContain('forged screen');
  });

  it('flattens the displayed handle too', () => {
    const out = formatHeldList([held({ msgId: 'task\u0007' })]);
    expect(out).not.toContain('\u0007');
  });
});

describe('/peers', () => {
  it('explains how to turn the feature on when it is off', async () => {
    const result = await run(null, '');
    expect(result.content).toContain('crossSessionMessaging');
  });

  it('does not tell a user to enable a setting they already enabled', async () => {
    // Same null inbox, different cause: registration or the bind failed.
    // "Turn it on" would send them back to a setting that is already on.
    const result = await run(null, '', true);
    expect(result.messageType).toBe('error');
    expect(result.content).toContain('failed to bind');
    expect(result.content).not.toContain('Enable it with');
  });

  it('lists held messages by default', async () => {
    messages = [held({ msgId: 'aaaaaa11-0000-4000-8000-000000000000' })];
    expect((await run(fake, '')).content).toContain('1 message waiting');
    expect((await run(fake, 'list')).content).toContain('1 message waiting');
  });

  it('rejects an unknown subcommand', async () => {
    const result = await run(fake, 'nuke everything');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain('Unknown subcommand');
  });

  it('asks which message when no target is given', async () => {
    const result = await run(fake, 'accept');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain('Which message');
  });

  it('accepts one message by short id', async () => {
    messages = [held({ msgId: 'aaaaaa11-0000-4000-8000-000000000000' })];
    const result = await run(fake, 'accept aaaaaa');
    expect(fake.decide).toHaveBeenCalledWith(
      'aaaaaa11-0000-4000-8000-000000000000',
      'approve',
    );
    expect(result.content).toContain('Released');
  });

  it('denies one message by short id', async () => {
    messages = [held({ msgId: 'aaaaaa11-0000-4000-8000-000000000000' })];
    await run(fake, 'deny aaaaaa');
    expect(fake.decide).toHaveBeenCalledWith(
      'aaaaaa11-0000-4000-8000-000000000000',
      'deny',
    );
  });

  it('refuses an ambiguous id instead of picking one', async () => {
    messages = [
      held({ msgId: 'aaaaaa11-0000-4000-8000-000000000000' }),
      held({ msgId: 'aaaaaa22-0000-4000-8000-000000000000' }),
    ];
    const result = await run(fake, 'accept aaaaaa');
    expect(result.messageType).toBe('error');
    expect(fake.decide).not.toHaveBeenCalled();
  });

  it('reports an unmatched id', async () => {
    messages = [held({ msgId: 'aaaaaa11-0000-4000-8000-000000000000' })];
    const result = await run(fake, 'accept zzzzzz');
    expect(result.messageType).toBe('error');
    expect(result.content).toContain('No held message matches');
  });

  it('handles a message that vanished between listing and deciding', async () => {
    messages = [held({ msgId: 'aaaaaa11-0000-4000-8000-000000000000' })];
    fake.decide = vi.fn(() => 'gone');
    const result = await run(fake, 'accept aaaaaa');
    expect(result.content).toContain('no longer waiting');
  });

  it('accepts all of them, iterating a snapshot', async () => {
    messages = [
      held({ msgId: 'aaaaaa11-0000-4000-8000-000000000000' }),
      held({ msgId: 'bbbbbb22-0000-4000-8000-000000000000' }),
    ];
    // Mutating the live array mid-loop is exactly what the real gate does.
    fake.decide = vi.fn(() => {
      messages.shift();
      return 'done';
    });

    const result = await run(fake, 'accept all');
    expect(fake.decide).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('Released 2 messages');
  });

  it('says nothing is waiting rather than pretending it acted', async () => {
    const result = await run(fake, 'accept all');
    expect(result.content).toContain('No messages');
    expect(fake.decide).not.toHaveBeenCalled();
  });
});
