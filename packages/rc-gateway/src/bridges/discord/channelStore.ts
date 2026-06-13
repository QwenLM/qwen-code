/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Crash-safe Discord channel ↔ session bindings (`add-discord-bridge`): which
 * daemon session a Discord channel is bound to (via `/qwen attach <invite>`).
 * Persisted to `$QWEN_BRIDGE_STATE_DIR/channels.json` (default
 * `~/.qwen/rc/bridges/discord/channels.json`) so bindings survive a restart.
 * The reverse lookup (session → channels) drives where a session's
 * permission_request messages are sent. Load/save never throw (a corrupt/missing
 * file fails open to empty).
 *
 * Unlike the Telegram chat store, EVERY id stays a STRING: Discord channel and
 * guild ids are 64-bit snowflakes (17–19 digits) that round past 2^53 if coerced
 * to a number, so this store never calls `Number()`. The on-disk shape is the
 * versioned `{version, channels[]}` form from the design.
 */

/** A persisted channel→session binding. */
export interface DiscordBinding {
  channelId: string;
  guildId: string;
  sessionId: string;
  /** ISO timestamp the binding was created (informational). */
  boundAt: string;
}

interface ChannelsFile {
  version: 1;
  channels: DiscordBinding[];
}

export class DiscordChannelStore {
  private readonly path: string;
  /** channelId (snowflake string) → binding. */
  private readonly map = new Map<string, DiscordBinding>();

  private constructor(path: string) {
    this.path = path;
  }

  /** Open (and load) the store. Missing/corrupt file → empty. Never throws. */
  static async open(path: string): Promise<DiscordChannelStore> {
    const store = new DiscordChannelStore(path);
    try {
      const parsed = JSON.parse(
        await readFile(path, 'utf8'),
      ) as Partial<ChannelsFile>;
      const rows = Array.isArray(parsed.channels) ? parsed.channels : [];
      for (const row of rows) {
        if (
          row &&
          typeof row.channelId === 'string' &&
          typeof row.sessionId === 'string'
        ) {
          store.map.set(row.channelId, {
            channelId: row.channelId,
            guildId: typeof row.guildId === 'string' ? row.guildId : '',
            sessionId: row.sessionId,
            boundAt: typeof row.boundAt === 'string' ? row.boundAt : '',
          });
        }
      }
    } catch {
      // ENOENT / parse error → start empty.
    }
    return store;
  }

  /** Bind a channel to a session (overwriting any prior binding) and persist. */
  async bind(
    channelId: string,
    guildId: string,
    sessionId: string,
    boundAt = new Date().toISOString(),
  ): Promise<void> {
    this.map.set(channelId, { channelId, guildId, sessionId, boundAt });
    await this.persist();
  }

  /** Remove a channel's binding and persist. Returns whether one existed. */
  async unbind(channelId: string): Promise<boolean> {
    const had = this.map.delete(channelId);
    if (had) await this.persist();
    return had;
  }

  /** The full binding for a channel, or undefined. */
  getByChannel(channelId: string): DiscordBinding | undefined {
    return this.map.get(channelId);
  }

  /** The session a channel is bound to, or undefined. */
  sessionFor(channelId: string): string | undefined {
    return this.map.get(channelId)?.sessionId;
  }

  /** Channels bound to a session (where its events should be delivered). */
  channelsFor(sessionId: string): string[] {
    const out: string[] = [];
    for (const b of this.map.values())
      if (b.sessionId === sessionId) out.push(b.channelId);
    return out;
  }

  /** All distinct bound session ids (what the SSE loop subscribes to). */
  boundSessions(): string[] {
    return [...new Set([...this.map.values()].map((b) => b.sessionId))];
  }

  /** All bindings (for `/qwen status` and operator inspection). */
  all(): DiscordBinding[] {
    return [...this.map.values()];
  }

  private async persist(): Promise<void> {
    const data: ChannelsFile = { version: 1, channels: [...this.map.values()] };
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify(data), { mode: 0o600 });
    } catch {
      // Best-effort persistence; an in-memory binding still works this session.
    }
  }
}
