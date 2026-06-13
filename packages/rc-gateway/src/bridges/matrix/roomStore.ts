/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Crash-safe Matrix room ↔ session bindings (`add-matrix-bridge`): which daemon
 * session a Matrix room is bound to (via `!qwen attach <invite>`). Persisted to
 * `$QWEN_BRIDGE_STATE_DIR/rooms.json` (default
 * `~/.qwen/rc/bridges/matrix/rooms.json`) so bindings survive a restart. The
 * reverse lookup (session → rooms) drives where a session's permission_request
 * messages are sent. Load/save never throw (a corrupt/missing file fails open to
 * empty). Room ids are opaque strings (`!abcd:home.example.com`) — never coerced.
 */

/** A persisted room→session binding. */
export interface MatrixBinding {
  roomId: string;
  sessionId: string;
  /** ISO timestamp the binding was created (informational). */
  boundAt: string;
}

interface RoomsFile {
  version: 1;
  rooms: MatrixBinding[];
}

export class MatrixRoomStore {
  private readonly path: string;
  /** roomId → binding. */
  private readonly map = new Map<string, MatrixBinding>();

  private constructor(path: string) {
    this.path = path;
  }

  /** Open (and load) the store. Missing/corrupt file → empty. Never throws. */
  static async open(path: string): Promise<MatrixRoomStore> {
    const store = new MatrixRoomStore(path);
    try {
      const parsed = JSON.parse(
        await readFile(path, 'utf8'),
      ) as Partial<RoomsFile>;
      const rows = Array.isArray(parsed.rooms) ? parsed.rooms : [];
      for (const row of rows) {
        if (
          row &&
          typeof row.roomId === 'string' &&
          typeof row.sessionId === 'string'
        ) {
          store.map.set(row.roomId, {
            roomId: row.roomId,
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

  /** Bind a room to a session (overwriting any prior binding) and persist. */
  async bind(
    roomId: string,
    sessionId: string,
    boundAt = new Date().toISOString(),
  ): Promise<void> {
    this.map.set(roomId, { roomId, sessionId, boundAt });
    await this.persist();
  }

  /** Remove a room's binding and persist. Returns whether one existed. */
  async unbind(roomId: string): Promise<boolean> {
    const had = this.map.delete(roomId);
    if (had) await this.persist();
    return had;
  }

  /** The session a room is bound to, or undefined. */
  sessionFor(roomId: string): string | undefined {
    return this.map.get(roomId)?.sessionId;
  }

  /** Rooms bound to a session (where its events should be delivered). */
  roomsFor(sessionId: string): string[] {
    const out: string[] = [];
    for (const b of this.map.values())
      if (b.sessionId === sessionId) out.push(b.roomId);
    return out;
  }

  /** All distinct bound session ids (what the SSE loop subscribes to). */
  boundSessions(): string[] {
    return [...new Set([...this.map.values()].map((b) => b.sessionId))];
  }

  /** All bindings (for `!qwen status` and operator inspection). */
  all(): MatrixBinding[] {
    return [...this.map.values()];
  }

  private async persist(): Promise<void> {
    const data: RoomsFile = { version: 1, rooms: [...this.map.values()] };
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, JSON.stringify(data), { mode: 0o600 });
    } catch {
      // Best-effort persistence; an in-memory binding still works this session.
    }
  }
}
