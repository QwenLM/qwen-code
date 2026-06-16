/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  extractSync,
  type RoomStateCtx,
  type PowerLevelsContent,
} from './normalize.js';

function ctx(over: Partial<RoomStateCtx> = {}): RoomStateCtx {
  return {
    botUserId: '@qwenbot:home.example.com',
    powerLevels: new Map<string, PowerLevelsContent>(),
    ...over,
  };
}

describe('extractSync — invites', () => {
  it('collects rooms the bot was invited to', () => {
    const sync = {
      next_batch: 's2',
      rooms: {
        invite: {
          '!room:h': {
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
    };
    const out = extractSync(sync, ctx());
    expect(out.nextBatch).toBe('s2');
    expect(out.invites).toEqual(['!room:h']);
  });

  it('ignores invites for other users', () => {
    const sync = {
      rooms: {
        invite: {
          '!room:h': {
            invite_state: {
              events: [
                {
                  type: 'm.room.member',
                  state_key: '@someone-else:h',
                  content: { membership: 'invite' },
                },
              ],
            },
          },
        },
      },
    };
    expect(extractSync(sync, ctx()).invites).toEqual([]);
  });
});

describe('extractSync — messages + power levels', () => {
  it('extracts a text message and resolves the sender power level from state', () => {
    const sync = {
      rooms: {
        join: {
          '!r:h': {
            state: {
              events: [
                {
                  type: 'm.room.power_levels',
                  content: { users: { '@alice:h': 50 }, users_default: 0 },
                },
              ],
            },
            timeline: {
              events: [
                {
                  type: 'm.room.message',
                  sender: '@alice:h',
                  content: { msgtype: 'm.text', body: '!qwen attach sess' },
                },
                {
                  type: 'm.room.message',
                  sender: '@guest:h',
                  content: { msgtype: 'm.text', body: 'hello' },
                },
              ],
            },
          },
        },
      },
    };
    const out = extractSync(sync, ctx());
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toMatchObject({
      sender: '@alice:h',
      body: '!qwen attach sess',
      powerLevel: 50,
      isBot: false,
    });
    expect(out.messages[1]).toMatchObject({
      sender: '@guest:h',
      powerLevel: 0, // users_default
    });
  });

  it('flags the bot’s own message as isBot', () => {
    const sync = {
      rooms: {
        join: {
          '!r:h': {
            timeline: {
              events: [
                {
                  type: 'm.room.message',
                  sender: '@qwenbot:home.example.com',
                  content: { msgtype: 'm.text', body: 'I am the bot' },
                },
              ],
            },
          },
        },
      },
    };
    expect(extractSync(sync, ctx()).messages[0].isBot).toBe(true);
  });

  it('persists power_levels across syncs via the ctx map', () => {
    const c = ctx();
    extractSync(
      {
        rooms: {
          join: {
            '!r:h': {
              state: {
                events: [
                  {
                    type: 'm.room.power_levels',
                    content: { users: { '@alice:h': 100 } },
                  },
                ],
              },
            },
          },
        },
      },
      c,
    );
    // A later sync with no power_levels event still sees @alice as 100.
    const out = extractSync(
      {
        rooms: {
          join: {
            '!r:h': {
              timeline: {
                events: [
                  {
                    type: 'm.room.message',
                    sender: '@alice:h',
                    content: { msgtype: 'm.text', body: 'hi' },
                  },
                ],
              },
            },
          },
        },
      },
      c,
    );
    expect(out.messages[0].powerLevel).toBe(100);
  });

  it('ignores non-text msgtypes', () => {
    const sync = {
      rooms: {
        join: {
          '!r:h': {
            timeline: {
              events: [
                {
                  type: 'm.room.message',
                  sender: '@alice:h',
                  content: { msgtype: 'm.image', body: 'pic.png' },
                },
              ],
            },
          },
        },
      },
    };
    expect(extractSync(sync, ctx()).messages).toEqual([]);
  });
});

describe('extractSync — reactions', () => {
  it('extracts a reaction with its target event and key', () => {
    const sync = {
      rooms: {
        join: {
          '!r:h': {
            timeline: {
              events: [
                {
                  type: 'm.reaction',
                  sender: '@alice:h',
                  content: {
                    'm.relates_to': {
                      rel_type: 'm.annotation',
                      event_id: '$m_42',
                      key: '\u{1F44D}',
                    },
                  },
                },
              ],
            },
          },
        },
      },
    };
    const out = extractSync(sync, ctx());
    expect(out.reactions).toEqual([
      {
        roomId: '!r:h',
        sender: '@alice:h',
        targetEventId: '$m_42',
        key: '\u{1F44D}',
      },
    ]);
  });
});

describe('extractSync — encryption detection', () => {
  it('flags a room with an m.room.encryption state event', () => {
    const sync = {
      rooms: {
        join: {
          '!enc:h': {
            state: {
              events: [
                {
                  type: 'm.room.encryption',
                  content: { algorithm: 'm.megolm.v1.aes-sha2' },
                },
              ],
            },
          },
        },
      },
    };
    expect(extractSync(sync, ctx()).encryptedRooms).toEqual(['!enc:h']);
  });

  it('flags a room emitting m.room.encrypted ciphertext (and yields no plaintext message)', () => {
    const sync = {
      rooms: {
        join: {
          '!enc:h': {
            timeline: {
              events: [
                {
                  type: 'm.room.encrypted',
                  sender: '@alice:h',
                  content: { ciphertext: 'xxx' },
                },
              ],
            },
          },
        },
      },
    };
    const out = extractSync(sync, ctx());
    expect(out.encryptedRooms).toEqual(['!enc:h']);
    expect(out.messages).toEqual([]);
  });
});

describe('extractSync — robustness', () => {
  it('handles an empty / malformed sync without throwing', () => {
    expect(extractSync(undefined, ctx())).toMatchObject({
      invites: [],
      messages: [],
      reactions: [],
      encryptedRooms: [],
    });
    expect(extractSync({ rooms: 'nope' }, ctx()).messages).toEqual([]);
  });
});
