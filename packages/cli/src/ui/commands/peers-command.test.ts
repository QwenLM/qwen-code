/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { HeldMessage } from '@qwen-code/qwen-code-core';

// Stubbed rather than loaded for real: the command needs one pure helper
// from core, and pulling the barrel in drags the whole module graph
// behind it. The wording assertions below only depend on this stub.
vi.mock('@qwen-code/qwen-code-core', () => ({
  describeHoldCause: (cause: string) =>
    cause === 'mode-mismatch'
      ? 'this session bypasses permission prompts and the sender does not'
      : `held (${cause})`,
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

function makeContext(peerMessaging: Fake | null): CommandContext {
  return {
    services: { peerMessaging },
  } as unknown as CommandContext;
}

async function run(
  peerMessaging: Fake | null,
  args: string,
): Promise<{ messageType: string; content: string }> {
  const result = await peersCommand.action!(makeContext(peerMessaging), args);
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
  // The first dash has to land inside the first six characters, otherwise
  // the fixture passes with or without the strip and cannot detect its
  // removal — and `parsePeerFrame` accepts any non-empty msgId, so a
  // wire-supplied non-UUID would then desync the displayed handle from
  // `resolveHeld`'s shortId branch.
  it('is six hex characters with dashes stripped', () => {
    expect(shortId('abc-def0-0000-4000-8000-000000000000')).toBe('abcdef');
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

  it('matches a mixed-case short id after removing dashes', () => {
    messages = [held({ msgId: 'DE-ADBE-FF00-0000-0000-000000000000' })];
    expect(resolveHeld(messages, 'deadbe')).toEqual({
      kind: 'one',
      msgId: 'DE-ADBE-FF00-0000-0000-000000000000',
    });
  });

  it('resolves the same sanitized handle shown to the user', () => {
    messages = [held({ msgId: 'ab\u0007cdef-0000' })];
    expect(shortId(messages[0]!.frame.msgId)).toBe('abcdef');
    expect(resolveHeld(messages, 'abcdef')).toEqual({
      kind: 'one',
      msgId: 'ab\u0007cdef-0000',
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

  // This list is where accept/deny is decided, and both the body and the
  // sender label are wire-supplied. Bidi overrides survive whitespace
  // collapsing untouched, so a peer could visually reorder its own preview
  // and spoof what the user approves.
  it('strips bidi controls from the body and the sender label', () => {
    const out = formatHeldList([
      held({
        msgId: 'aaaaaa11-0000-4000-8000-000000000000',
        fromName: 'app\u202Eba-',
        content: 'delete \u2066nothing\u2069 important',
      }),
    ]);
    expect(out).not.toMatch(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/);
    expect(out).toContain('delete nothing important');
    expect(out).toContain('appba-');
  });

  it('sanitizes the wire-supplied short id', () => {
    const out = formatHeldList([
      held({ msgId: '\u001b]xyz1', content: 'review me' }),
    ]);
    expect(out).not.toContain('\u001b');
    expect(out).toContain('xyz1');
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
});

describe('/peers', () => {
  it('explains how to turn the feature on when it is off', async () => {
    const result = await run(null, '');
    expect(result.content).toContain('crossSessionMessaging');
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

  it('decides an exact all handle before treating all as the bulk keyword', async () => {
    messages = [
      held({ msgId: 'all' }),
      held({ msgId: 'bbbbbb22-0000-4000-8000-000000000000' }),
    ];

    const result = await run(fake, 'accept all');
    expect(fake.decide).toHaveBeenCalledTimes(1);
    expect(fake.decide).toHaveBeenCalledWith('all', 'approve');
    expect(result.content).toContain('Released to this session');
  });

  it('says nothing is waiting rather than pretending it acted', async () => {
    const result = await run(fake, 'accept all');
    expect(result.content).toContain('No messages');
    expect(fake.decide).not.toHaveBeenCalled();
  });
});
