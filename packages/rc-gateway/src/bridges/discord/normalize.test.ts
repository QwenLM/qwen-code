/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeMessage,
  normalizeChatInput,
  normalizeButton,
  QWEN_COMMAND,
  type RawChatInput,
} from './normalize.js';

describe('normalize — message', () => {
  it('reads channel/author/bot/content with the snowflake string intact', () => {
    const out = normalizeMessage({
      channelId: '1234567890123456789',
      author: { id: '111122223333444455', bot: false },
      content: 'run the tests',
    });
    expect(out).toEqual({
      channelId: '1234567890123456789',
      authorId: '111122223333444455',
      isBot: false,
      content: 'run the tests',
    });
  });

  it('carries the bot flag through', () => {
    const out = normalizeMessage({
      channelId: 'c',
      author: { id: 'b', bot: true },
      content: 'x',
    });
    expect(out.isBot).toBe(true);
  });
});

describe('normalize — chat-input slash command', () => {
  const make = (
    sub: string,
    session: string | null,
    commandName = 'qwen',
  ): RawChatInput => ({
    id: 'int_1',
    token: 'tok',
    channelId: 'chan_42',
    guildId: 'g1',
    commandName,
    user: { id: '111122223333' },
    options: {
      getSubcommand: () => sub,
      getString: () => session,
    },
  });

  it('normalizes /qwen attach with the session arg', () => {
    expect(normalizeChatInput(make('attach', 'sess_abc'))).toEqual({
      interactionId: 'int_1',
      interactionToken: 'tok',
      channelId: 'chan_42',
      guildId: 'g1',
      userId: '111122223333',
      name: 'attach',
      arg: 'sess_abc',
    });
  });

  it('normalizes /qwen detach (no arg)', () => {
    const out = normalizeChatInput(make('detach', null));
    expect(out?.name).toBe('detach');
    expect(out?.arg).toBeUndefined();
  });

  it('normalizes /qwen status', () => {
    expect(normalizeChatInput(make('status', null))?.name).toBe('status');
  });

  it('returns null for a foreign command name', () => {
    expect(normalizeChatInput(make('attach', 'x', 'other'))).toBeNull();
  });

  it('returns null for an unhandled subcommand', () => {
    expect(normalizeChatInput(make('explode', null))).toBeNull();
  });

  it('returns null when no subcommand is present (getSubcommand throws)', () => {
    const raw = make('attach', null);
    raw.options.getSubcommand = () => {
      throw new Error('no subcommand');
    };
    expect(normalizeChatInput(raw)).toBeNull();
  });

  it('defaults a missing guildId to empty string (DM-safe)', () => {
    const raw = make('status', null);
    raw.guildId = null;
    expect(normalizeChatInput(raw)?.guildId).toBe('');
  });

  it('defaults a missing attach session arg to empty string', () => {
    expect(normalizeChatInput(make('attach', null))?.arg).toBe('');
  });
});

describe('normalize — button', () => {
  it('reads the customId and the invoking user snowflake', () => {
    expect(
      normalizeButton({
        id: 'int_1',
        token: 'tok',
        channelId: 'chan_42',
        customId: 'vote:approve:req_xyz',
        user: { id: '111122223333' },
      }),
    ).toEqual({
      interactionId: 'int_1',
      interactionToken: 'tok',
      channelId: 'chan_42',
      userId: '111122223333',
      customId: 'vote:approve:req_xyz',
    });
  });
});

describe('normalize — slash command definition', () => {
  it('defines /qwen with attach(session)/detach/status subcommands', () => {
    expect(QWEN_COMMAND.name).toBe('qwen');
    const subs = QWEN_COMMAND.options.map((o) => o.name);
    expect(subs).toEqual(['attach', 'detach', 'status']);
    const attach = QWEN_COMMAND.options.find((o) => o.name === 'attach');
    expect(attach?.options?.[0].name).toBe('session');
    expect(attach?.options?.[0].required).toBe(true);
  });
});
