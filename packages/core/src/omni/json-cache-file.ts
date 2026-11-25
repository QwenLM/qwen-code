/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { createDebugLogger, type DebugLogger } from '../utils/debugLogger.js';

/** Per-cache-file operation serializer: cache instances are constructed
 * per use site, and safe-tool batches run deliveries concurrently in one
 * process — unserialized load-modify-save would drop entries. Module
 * scope is deliberate: two instances on the same file must share the
 * chain. Cross-process writes remain last-writer-wins (documented).
 * Exported for other omni-owned JSON documents with the same
 * load-modify-save discipline (media-memory store). */
const fileOps = new Map<string, Promise<unknown>>();

export function serializeFileOperation<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = fileOps.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(
    () => {},
    () => {},
  );
  fileOps.set(key, settled);
  void settled.then(() => {
    // Drop the tail once it settles — otherwise the map grows with every
    // distinct cache file touched over the process lifetime. Only delete
    // when OUR promise is still the tail: a later op may have chained on.
    if (fileOps.get(key) === settled) fileOps.delete(key);
  });
  return run;
}

/** Keep at most this many `.corrupt-*` backups (newest wins): a crash
 * loop over a corrupt file must not litter the directory without bound. */
const MAX_CORRUPT_BACKUPS = 2;

interface CacheFileShape<TEntry> {
  version: 1;
  entries: Record<string, TEntry>;
}

/**
 * Shared mechanics for omni's persistent JSON entry caches
 * (`upload-cache.json`, `policy-cache.json`): one flat
 * `{ version: 1, entries: {} }` file with
 *
 * - per-file serialized load-modify-save (in-process),
 * - atomic writes via `atomicWriteFile` (tmp + rename, `noFollow`; 0600
 *   forced on every save, 0700 dir),
 * - corrupt files backed up as `.corrupt-<ts>` (newest
 *   {@link MAX_CORRUPT_BACKUPS} kept) and rebuilt empty — never fatal,
 * - unreadable-but-existing files (EACCES, EMFILE, …) making the current
 *   operation a no-op instead of an empty rebuild: a transient read
 *   failure must never lead to a save that wipes every persisted entry.
 *
 * Entry semantics (keys, TTLs, invalidation) stay in the owning cache.
 */
export class OmniJsonCacheFile<TEntry> {
  private readonly debugLogger: DebugLogger;

  constructor(
    readonly filePath: string,
    debugChannel: string,
  ) {
    this.debugLogger = createDebugLogger(debugChannel);
  }

  /**
   * Run one serialized operation against the entry map. `fn` returns the
   * operation result plus whether it changed the map (triggering an
   * atomic save). When the file exists but cannot be read,
   * `unreadableResult` is returned and nothing is saved.
   */
  async access<R>(
    unreadableResult: R,
    fn: (
      entries: Record<string, TEntry>,
    ) =>
      | { result: R; changed?: boolean }
      | Promise<{ result: R; changed?: boolean }>,
  ): Promise<R> {
    return serializeFileOperation(this.filePath, async () => {
      const data = await this.load();
      if (!data) return unreadableResult;
      const { result, changed } = await fn(data.entries);
      if (changed) await this.save(data);
      return result;
    });
  }

  /**
   * Load the cache file. Returns null when the file exists but could not
   * be read (EACCES, EMFILE, …): the caller must skip its operation for
   * this call — proceeding with an empty snapshot and later saving it
   * would overwrite N valid entries with one (self-inflicted cache wipe).
   * Only a genuinely missing file means empty-and-writable.
   */
  private async load(): Promise<CacheFileShape<TEntry> | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT: no cache file yet (POSIX and Windows). ENOTDIR: a parent
      // path component is a plain file — POSIX raises ENOTDIR where
      // Windows reports ENOENT for the same condition.
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { version: 1, entries: {} };
      }
      this.debugLogger.debug(
        `cache read failed, operation skipped: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as CacheFileShape<TEntry>;
      // `entries` must be a plain non-null object: `typeof null` and
      // `typeof []` are both 'object', and either shape would throw raw
      // TypeErrors from every accessor (escaping the never-fatal contract
      // and skipping backup+rebuild).
      if (
        parsed?.version === 1 &&
        typeof parsed.entries === 'object' &&
        parsed.entries !== null &&
        !Array.isArray(parsed.entries)
      ) {
        // Entry VALUES must be plain non-null non-array objects too: the
        // file is edited/shipped by hand (workspace caches), and a value
        // like `null` or `"x"` would surface as raw TypeErrors from the
        // owning cache's field accessors (`v.expiresAt`,
        // `v.degradedSha256`, …) — escaping the never-fatal contract.
        // Malformed values are pruned individually (cheap re-work for
        // just those keys) instead of condemning the whole file.
        let pruned = 0;
        for (const [k, v] of Object.entries(parsed.entries)) {
          if (typeof v !== 'object' || v === null || Array.isArray(v)) {
            delete parsed.entries[k];
            pruned++;
          }
        }
        if (pruned > 0) {
          this.debugLogger.debug(
            `dropped ${pruned} malformed cache entr${pruned === 1 ? 'y' : 'ies'} from ${this.filePath}`,
          );
        }
        return parsed;
      }
      throw new Error('unexpected shape');
    } catch {
      // Corrupt cache: preserve for inspection, start fresh. Losing a
      // cache only costs re-work — never fail the pipeline over it.
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      await fs.rename(this.filePath, backup).catch(() => {});
      await this.pruneCorruptBackups();
      this.debugLogger.debug(`corrupt cache backed up to ${backup}`);
      return { version: 1, entries: {} };
    }
  }

  /** Best-effort: keep only the newest {@link MAX_CORRUPT_BACKUPS}. */
  private async pruneCorruptBackups(): Promise<void> {
    const dir = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.corrupt-`;
    try {
      const backups = (await fs.readdir(dir))
        .filter((n) => n.startsWith(prefix))
        // Millisecond timestamps are fixed-width for centuries, so the
        // lexicographic sort is chronological; newest first.
        .sort()
        .reverse();
      for (const name of backups.slice(MAX_CORRUPT_BACKUPS)) {
        await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
      }
    } catch {
      // Pruning is hygiene; never let it affect the read path.
    }
  }

  private async save(data: CacheFileShape<TEntry>): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), {
        recursive: true,
        mode: 0o700,
      });
      await atomicWriteFile(this.filePath, JSON.stringify(data, null, 1), {
        mode: 0o600,
        forceMode: true,
        // Rename-replacement semantics: a symlink planted at the cache
        // path is REPLACED by the rename, never written through — without
        // this the default symlink resolution would redirect the write
        // (and the 0600 chmod) onto the link's target.
        noFollow: true,
      });
    } catch (err) {
      // Cache persistence is best-effort by design.
      this.debugLogger.debug(
        `cache write failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
