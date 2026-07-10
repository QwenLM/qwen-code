/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * The cursor state persisted for a single bridge session.
 * `lastEventId` is the highest SSE frame id seen on the subscription stream;
 * `lastDeliveredEventId` is the highest id actually delivered to the chat.
 * Both values are used for resume-cursor on reconnect.
 */
export interface CursorEntry {
  lastEventId: number;
  lastDeliveredEventId: number;
}

/**
 * Durable bridge cursor store (`add-cursor-persistence`): persists
 * `{ lastEventId, lastDeliveredEventId }` per bridge token (scoped by a
 * `tokenId`) + session id to a JSON file so SSE resume cursors survive
 * a bridge restart. Writes are atomic (write-temp + rename) so a crash during
 * flush cannot corrupt the existing cursor file.
 *
 * File layout: `{ "<tokenId>/<sessionId>": { lastEventId, lastDeliveredEventId } }`.
 *
 * In-memory; flush is explicit (called on every update). Missing/corrupt file
 * fails open to empty cursors (FAIL-OPEN: a restart lets a small replay window
 * close the gap rather than wedging the bridge). Never throws.
 */
export class CursorStore {
  private readonly path: string;
  /** Composite key `"<tokenId>/<sessionId>"` → CursorEntry. */
  private readonly map = new Map<string, CursorEntry>();

  private constructor(path: string) {
    this.path = path;
  }

  /** Open (and load) the store. Missing/corrupt file → empty. Never throws. */
  static async open(path: string): Promise<CursorStore> {
    const store = new CursorStore(path);
    try {
      const raw = JSON.parse(await readFile(path, 'utf8')) as Record<
        string,
        unknown
      >;
      for (const [key, val] of Object.entries(raw)) {
        if (
          val !== null &&
          typeof val === 'object' &&
          typeof (val as Record<string, unknown>)['lastEventId'] === 'number' &&
          typeof (val as Record<string, unknown>)['lastDeliveredEventId'] ===
            'number'
        ) {
          store.map.set(key, {
            lastEventId: (val as Record<string, unknown>)[
              'lastEventId'
            ] as number,
            lastDeliveredEventId: (val as Record<string, unknown>)[
              'lastDeliveredEventId'
            ] as number,
          });
        }
      }
    } catch {
      // ENOENT / parse error → start empty.
    }
    return store;
  }

  /** Composite key for a (tokenId, sessionId) pair. */
  private static key(tokenId: string, sessionId: string): string {
    return `${tokenId}/${sessionId}`;
  }

  /** Return the stored cursor for the given token+session, or undefined. */
  get(tokenId: string, sessionId: string): CursorEntry | undefined {
    return this.map.get(CursorStore.key(tokenId, sessionId));
  }

  /**
   * Update `lastEventId` for the given token+session and flush to disk.
   * If `lastDeliveredEventId` is not yet set it is initialised to the same value.
   */
  async setLastEventId(
    tokenId: string,
    sessionId: string,
    id: number,
  ): Promise<void> {
    const k = CursorStore.key(tokenId, sessionId);
    const prev = this.map.get(k);
    this.map.set(k, {
      lastEventId: id,
      lastDeliveredEventId: prev?.lastDeliveredEventId ?? id,
    });
    await this.persist();
  }

  /**
   * Update `lastDeliveredEventId` for the given token+session and flush.
   * If no entry exists yet it is created with both fields set to `id`.
   */
  async setLastDeliveredEventId(
    tokenId: string,
    sessionId: string,
    id: number,
  ): Promise<void> {
    const k = CursorStore.key(tokenId, sessionId);
    const prev = this.map.get(k);
    this.map.set(k, {
      lastEventId: prev?.lastEventId ?? id,
      lastDeliveredEventId: id,
    });
    await this.persist();
  }

  /** Remove the cursor for a token+session (e.g. on explicit unbind). */
  async delete(tokenId: string, sessionId: string): Promise<void> {
    this.map.delete(CursorStore.key(tokenId, sessionId));
    await this.persist();
  }

  /** Atomic write: temp file + rename so a crash cannot corrupt the cursor file. */
  private async persist(): Promise<void> {
    const obj: Record<string, CursorEntry> = {};
    for (const [k, v] of this.map) obj[k] = v;
    const json = JSON.stringify(obj);
    const dir = dirname(this.path);
    try {
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `.cursors-${randomBytes(6).toString('hex')}.tmp`);
      await writeFile(tmp, json, { mode: 0o600 });
      await rename(tmp, this.path);
    } catch {
      // Best-effort persistence; in-memory cursors still work this session.
    }
  }
}
