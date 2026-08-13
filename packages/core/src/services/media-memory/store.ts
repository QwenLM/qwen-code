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
 * Drop malformed RECORD VALUES from an otherwise well-shaped document.
 *
 * The envelope check above only proves the four collections are objects.
 * A single non-object value inside one of them (a hand edit, a bad merge,
 * a truncated sync) would surface as raw TypeErrors from every read path
 * (`indexSnapshot` dereferences `version.parentVersionId`,
 * `findBindingBySha256` reads `version.sha256`, …). Those throws are
 * caught into "miss"/empty by the read wrappers — so ONE bad value turns
 * every recall in the project into a permanent blackout, while the
 * corrupt-backup self-heal never fires because the envelope is valid.
 *
 * Pruning individually costs only the pruned records (dangling references
 * to them already degrade gracefully — a missing version reads as an
 * `artifact_unavailable` gap) and keeps the never-fatal contract intact.
 * Same defense as the sibling `OmniJsonCacheFile.load()`.
 */
function pruneMalformedRecords(snapshot: MediaMemorySnapshot): void {
  const dropped: string[] = [];
  for (const collection of [
    'files',
    'versions',
    'executions',
    'entries',
  ] as const) {
    const records = snapshot[collection] as Record<string, unknown>;
    for (const [key, value] of Object.entries(records)) {
      if (!isPlainRecord(value)) {
        delete records[key];
        dropped.push(`${collection}/${key}`);
      }
    }
  }
  if (dropped.length > 0) {
    // Name the records: a silent prune would leave an operator debugging
    // "recall returns less than it should" with nothing to go on.
    debugLogger.debug(
      `dropped ${dropped.length} malformed memory record` +
        `${dropped.length === 1 ? '' : 's'}: ${dropped.join(', ')}`,
    );
  }
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
  private readonly omniRootDir: string;

  constructor(omniRootDir: string) {
    this.omniRootDir = omniRootDir;
    this.filePath = path.join(omniRootDir, MEDIA_MEMORY_FILE_NAME);
  }

  /**
   * Prefix (with trailing separator) under which the omni object store
   * keeps its content-addressed copies. A version whose `fileRef` starts
   * with this prefix anchors its only persistent bytes in the store —
   * the GC root collection matches on it.
   */
  omniObjectsPrefix(): string {
    return path.join(this.omniRootDir, 'objects') + path.sep;
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
        pruneMalformedRecords(parsed);
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
