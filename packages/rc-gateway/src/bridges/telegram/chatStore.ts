/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Crash-safe Telegram chat ↔ session bindings (`add-telegram-bridge`): which
 * daemon session a Telegram chat is bound to (via `/start <invite token>`).
 * Persisted to `~/.qwen/rc/bridges/telegram/chats.json` so bindings survive a
 * restart. Reverse lookup (session → chats) drives where a session's
 * permission_request messages are sent. Load/save never throw (a corrupt/missing
 * file fails open to empty).
 */
export class TelegramChatStore {
  private readonly path: string;
  private readonly map = new Map<number, string>();

  private constructor(path: string) {
    this.path = path;
  }

  /** Open (and load) the store. Missing/corrupt file → empty. Never throws. */
  static async open(path: string): Promise<TelegramChatStore> {
    const store = new TelegramChatStore(path);
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<
        string,
        unknown
      >;
      for (const [chatId, sessionId] of Object.entries(raw)) {
        const n = Number(chatId);
        if (Number.isFinite(n) && typeof sessionId === 'string') {
          store.map.set(n, sessionId);
        }
      }
    } catch {
      // ENOENT / parse error → start empty.
    }
    return store;
  }

  /** Bind a chat to a session and persist. */
  async bind(chatId: number, sessionId: string): Promise<void> {
    this.map.set(chatId, sessionId);
    await this.persist();
  }

  /** The session a chat is bound to, or undefined. */
  sessionFor(chatId: number): string | undefined {
    return this.map.get(chatId);
  }

  /** Chats bound to a session (where its events should be delivered). */
  chatsFor(sessionId: string): number[] {
    const out: number[] = [];
    for (const [chatId, sid] of this.map)
      if (sid === sessionId) out.push(chatId);
    return out;
  }

  /** All distinct bound session ids (what the SSE loop subscribes to). */
  boundSessions(): string[] {
    return [...new Set(this.map.values())];
  }

  private async persist(): Promise<void> {
    const obj: Record<string, string> = {};
    for (const [chatId, sid] of this.map) obj[String(chatId)] = sid;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify(obj), { mode: 0o600 });
    } catch {
      // Best-effort persistence; an in-memory binding still works this session.
    }
  }
}
