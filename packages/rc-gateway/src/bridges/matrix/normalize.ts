/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  senderPowerLevel,
  type NormalizedMatrixMessage,
  type NormalizedMatrixReaction,
} from './dispatch.js';

/**
 * Pure extraction of a Matrix `/sync` response into the dispatcher's
 * transport-agnostic shapes (`add-matrix-bridge`). Walks the (deeply nested,
 * loosely-typed) sync JSON and returns the actionable items: rooms to auto-join,
 * rooms detected as encrypted, normalized messages (with the sender's power level
 * resolved from tracked room state), and reactions. No I/O — exercised with plain
 * sync fixtures.
 *
 * Power levels are STATEFUL: `m.room.power_levels` state events update a per-room
 * map (passed in by the sync loop and mutated here) so a later message's power
 * level reflects the latest known state. State events are applied before timeline
 * messages within a sync.
 */

/** The slice of `m.room.power_levels` content the bridge reads. */
export interface PowerLevelsContent {
  users?: Record<string, number>;
  users_default?: number;
}

/** Per-room state the sync loop carries across syncs (mutated by extractSync). */
export interface RoomStateCtx {
  /** The bot's own MXID (to flag its own messages). */
  botUserId: string;
  /** roomId → latest known power_levels content. */
  powerLevels: Map<string, PowerLevelsContent>;
}

/** Everything actionable extracted from one `/sync`. */
export interface SyncExtract {
  nextBatch?: string;
  /** roomIds the bot was invited to (auto-join these). */
  invites: string[];
  /** roomIds observed to be encrypted this sync (caller dedupes + notices). */
  encryptedRooms: string[];
  messages: NormalizedMatrixMessage[];
  reactions: NormalizedMatrixReaction[];
}

type AnyEvent = {
  type?: string;
  sender?: string;
  state_key?: string;
  content?: Record<string, unknown>;
};

function eventsOf(node: unknown, key: 'timeline' | 'state'): AnyEvent[] {
  const section = (node as Record<string, unknown>)?.[key] as
    | { events?: unknown }
    | undefined;
  return Array.isArray(section?.events) ? (section!.events as AnyEvent[]) : [];
}

/** Extract actionable items from a `/sync` response, updating `ctx.powerLevels`. */
export function extractSync(sync: unknown, ctx: RoomStateCtx): SyncExtract {
  const s = (sync ?? {}) as Record<string, unknown>;
  const out: SyncExtract = {
    nextBatch:
      typeof s['next_batch'] === 'string' ? s['next_batch'] : undefined,
    invites: [],
    encryptedRooms: [],
    messages: [],
    reactions: [],
  };

  const rooms = (s['rooms'] ?? {}) as Record<string, unknown>;

  // Invites: a membership=invite event for the bot in invite_state.
  const invite = (rooms['invite'] ?? {}) as Record<string, unknown>;
  for (const [roomId, node] of Object.entries(invite)) {
    const events = (
      (node as Record<string, unknown>)?.['invite_state'] as
        | { events?: AnyEvent[] }
        | undefined
    )?.events;
    const invited = (Array.isArray(events) ? events : []).some(
      (e) =>
        e.type === 'm.room.member' &&
        e.state_key === ctx.botUserId &&
        e.content?.['membership'] === 'invite',
    );
    if (invited) out.invites.push(roomId);
  }

  // Joined rooms: state first (power_levels / encryption), then timeline.
  const join = (rooms['join'] ?? {}) as Record<string, unknown>;
  for (const [roomId, node] of Object.entries(join)) {
    let encrypted = false;
    const apply = (e: AnyEvent) => {
      if (e.type === 'm.room.power_levels' && e.content) {
        ctx.powerLevels.set(roomId, e.content as PowerLevelsContent);
      } else if (e.type === 'm.room.encryption') {
        encrypted = true;
      }
    };
    for (const e of eventsOf(node, 'state')) apply(e);

    for (const e of eventsOf(node, 'timeline')) {
      apply(e); // a power_levels/encryption event can also appear in the timeline
      if (e.type === 'm.room.encrypted') {
        encrypted = true; // a ciphertext message: the room IS encrypted
      } else if (e.type === 'm.room.message') {
        const body = e.content?.['body'];
        const sender = e.sender;
        if (
          e.content?.['msgtype'] === 'm.text' &&
          typeof body === 'string' &&
          typeof sender === 'string'
        ) {
          out.messages.push({
            roomId,
            sender,
            isBot: sender === ctx.botUserId,
            body,
            powerLevel: senderPowerLevel(ctx.powerLevels.get(roomId), sender),
          });
        }
      } else if (e.type === 'm.reaction') {
        const relates = e.content?.['m.relates_to'] as
          | { event_id?: unknown; key?: unknown }
          | undefined;
        const sender = e.sender;
        if (
          typeof sender === 'string' &&
          typeof relates?.event_id === 'string' &&
          typeof relates?.key === 'string'
        ) {
          out.reactions.push({
            roomId,
            sender,
            targetEventId: relates.event_id,
            key: relates.key,
          });
        }
      }
    }

    if (encrypted) out.encryptedRooms.push(roomId);
  }

  return out;
}
