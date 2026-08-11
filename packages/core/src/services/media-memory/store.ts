/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { serializeFileOperation } from '../../omni/json-cache-file.js';
import { atomicWriteFile } from '../../utils/atomicFileWrite.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import type { MediaMemorySnapshot } from './types.js';

const debugLogger = createDebugLogger('omni:memory');

/** Keep at most this many `.corrupt-*` backups (newest wins) — same
 * hygiene bound as the omni JSON caches. */
const MAX_CORRUPT_BACKUPS = 2;

export const MEDIA_MEMORY_FILE_NAME = 'memory.json';

function emptySnapshot(): MediaMemorySnapshot {
  return {
    schemaVersion: 1,
    files: {},
    versions: {},
    executions: {},
    entries: {},
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * v1 JSON persistence for the media-memory graph: ONE document
 * (`.qwen/omni/memory.json`) holding every file/version/execution/entry
 * record. Deliberately the same discipline as omni's JSON entry caches
 * (S4 decision D2 — the backend is an internal detail; the collector and
 * recall service only ever see {@link MediaMemorySnapshot}):
 *
 * - per-file serialized load-modify-save (in-process), sharing the omni
 *   file-operation chain so two store instances on one file never race;
 * - atomic writes (tmp + rename, `noFollow`, 0600/0700 forced);
 * - corrupt documents backed up as `.corrupt-<ts>` and rebuilt empty —
 *   memory loss costs re-derivation, never a broken pipeline;
 * - unreadable-but-existing documents make the operation a no-op: a
 *   transient EACCES must never lead to a save that wipes the graph.
 *
 * Transaction semantics (M §12): one {@link transact} call is one atomic
 * commit — the mutator runs against the full snapshot in memory and the
 * document is rewritten in a single rename. Multi-record commits
 * (OmniPolicySucceeded: execution + versions + entries + edge updates)
 * therefore land all-or-nothing by construction.
 */
export class MediaMemoryStore {
  readonly filePath: string;

  constructor(omniRootDir: string) {
    this.filePath = path.join(omniRootDir, MEDIA_MEMORY_FILE_NAME);
  }

  /**
   * Run one serialized operation against the snapshot. `fn` returns the
   * operation result plus whether it mutated the snapshot (triggering an
   * atomic save). When the document exists but cannot be read,
   * `unreadableResult` is returned and nothing is saved.
   */
  async transact<R>(
    unreadableResult: R,
    fn: (
      snapshot: MediaMemorySnapshot,
    ) =>
      | { result: R; changed?: boolean }
      | Promise<{ result: R; changed?: boolean }>,
  ): Promise<R> {
    return serializeFileOperation(this.filePath, async () => {
      const snapshot = await this.load();
      if (!snapshot) return unreadableResult;
      const { result, changed } = await fn(snapshot);
      if (changed) await this.save(snapshot);
      return result;
    });
  }

  /** Read-only view over the snapshot (recall, queries). */
  async read<R>(
    unreadableResult: R,
    fn: (snapshot: MediaMemorySnapshot) => R | Promise<R>,
  ): Promise<R> {
    return this.transact(unreadableResult, async (snapshot) => ({
      result: await fn(snapshot),
    }));
  }

  private async load(): Promise<MediaMemorySnapshot | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return emptySnapshot();
      debugLogger.debug(
        `memory read failed, operation skipped: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as MediaMemorySnapshot;
      if (
        isPlainRecord(parsed) &&
        parsed.schemaVersion === 1 &&
        isPlainRecord(parsed.files) &&
        isPlainRecord(parsed.versions) &&
        isPlainRecord(parsed.executions) &&
        isPlainRecord(parsed.entries)
      ) {
        return parsed;
      }
      throw new Error('unexpected shape');
    } catch {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      await fs.rename(this.filePath, backup).catch(() => {});
      await this.pruneCorruptBackups();
      debugLogger.debug(`corrupt memory document backed up to ${backup}`);
      return emptySnapshot();
    }
  }

  private async pruneCorruptBackups(): Promise<void> {
    const dir = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.corrupt-`;
    try {
      const backups = (await fs.readdir(dir))
        .filter((n) => n.startsWith(prefix))
        .sort()
        .reverse();
      for (const name of backups.slice(MAX_CORRUPT_BACKUPS)) {
        await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
      }
    } catch {
      // Hygiene only; never let it affect the read path.
    }
  }

  private async save(snapshot: MediaMemorySnapshot): Promise<void> {
    // Unlike the caches, a memory commit that cannot persist must SURFACE:
    // the collector treats it as a collection failure (logged, delivery
    // unaffected) rather than silently reporting success.
    await fs.mkdir(path.dirname(this.filePath), {
      recursive: true,
      mode: 0o700,
    });
    await atomicWriteFile(this.filePath, JSON.stringify(snapshot, null, 1), {
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
  }
}
