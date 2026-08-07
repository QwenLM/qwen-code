/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('omni:upload-cache');

/** Per-cache-file operation serializer: cache instances are constructed
 * per delivery, and safe-tool batches run deliveries concurrently in one
 * process — unserialized load-modify-save would drop entries (worst case
 * one extra re-upload, but cheap to prevent). Module scope is deliberate:
 * two instances on the same root must share the chain. Cross-process
 * writes remain last-writer-wins (documented). */
const fileOps = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
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

/** Default oss:// URL validity horizon: 47h (official 48h minus margin). */
export const DEFAULT_UPLOAD_CACHE_TTL_HOURS = 47;

/** Hard ceiling for any configured TTL: the server-side URL dies at 48h,
 * so a longer local TTL would confidently serve dead URLs. */
const MAX_UPLOAD_CACHE_TTL_HOURS = 48;

/** Keep at most this many `.corrupt-*` backups (newest wins): a crash
 * loop over a corrupt file must not litter the directory without bound. */
const MAX_CORRUPT_BACKUPS = 2;

interface UploadCacheEntry {
  ossUrl: string;
  uploadedAt: string;
  expiresAt: string;
}

interface UploadCacheFile {
  version: 1;
  /** Key: `<sha256>|<model>|<scope>`. */
  entries: Record<string, UploadCacheEntry>;
}

/**
 * Persistent map from object identity to a still-valid DashScope temporary
 * URL: `(sha256, model, scope) → { ossUrl, uploadedAt, expiresAt }`
 * (storage design §8). Lives at `.qwen/omni/upload-cache.json`.
 *
 * Invariants:
 * - the cache file is the ONLY place an oss:// URL is persisted by omni —
 *   the URL is a delivery cache, never an identity;
 * - keys include the model: the docs declare uploads model-bound (looser
 *   in practice, but honored conservatively);
 * - keys include a caller-supplied scope: the pipeline passes a
 *   fingerprint of (baseUrl, apiKey), so entries never cross endpoints or
 *   credentials. `invalidateByUrl` scans by URL and is scope-agnostic by
 *   design — the pipeline only knows the URL the server rejected, not
 *   which scope minted it. Pre-scope 2-part keys simply never match again
 *   and age out via TTL;
 * - expired entries are misses; they are pruned on read and swept
 *   wholesale on every {@link put} (so never-read-again entries cannot
 *   accumulate forever);
 * - a corrupt cache file is backed up and rebuilt empty (never fatal),
 *   keeping at most the newest {@link MAX_CORRUPT_BACKUPS} backups;
 * - a cache file that exists but cannot be READ (EACCES, EMFILE, …) makes
 *   the current operation a no-op instead of an empty-file rebuild — a
 *   transient read failure must never lead to a save that wipes every
 *   previously persisted entry;
 * - writes are atomic (tmp + rename, 0600) and last-writer-wins across
 *   processes — acceptable for the experiment (worst case: a lost entry
 *   causes one extra re-upload).
 */
export class OmniUploadCache {
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly scope: string;

  constructor(
    omniRootDir: string,
    ttlHours = DEFAULT_UPLOAD_CACHE_TTL_HOURS,
    scope = '',
  ) {
    this.filePath = path.join(omniRootDir, 'upload-cache.json');
    // Positive TTLs are clamped to the 48h server URL lifetime — a
    // configured 168 must not outlive the URL. 0/negative still disables.
    this.ttlMs = Math.min(ttlHours, MAX_UPLOAD_CACHE_TTL_HOURS) * 3600_000;
    this.scope = scope;
  }

  /** TTL of 0 (or negative) disables the cache entirely. */
  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  /**
   * Load the cache file. Returns null when the file exists but could not
   * be read (EACCES, EMFILE, …): the caller must skip its operation for
   * this call — proceeding with an empty snapshot and later saving it
   * would overwrite N valid entries with one (self-inflicted cache wipe).
   * Only a genuinely missing file means empty-and-writable.
   */
  private async load(): Promise<UploadCacheFile | null> {
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
      debugLogger.debug(
        `upload cache read failed, operation skipped: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as UploadCacheFile;
      // `entries` must be a plain non-null object: `typeof null` and
      // `typeof []` are both 'object', and either shape would throw raw
      // TypeErrors from every accessor below (escaping the never-fatal
      // contract and skipping backup+rebuild).
      if (
        parsed?.version === 1 &&
        typeof parsed.entries === 'object' &&
        parsed.entries !== null &&
        !Array.isArray(parsed.entries)
      ) {
        return parsed;
      }
      throw new Error('unexpected shape');
    } catch {
      // Corrupt cache: preserve for inspection, start fresh. Losing the
      // cache only costs re-uploads — never fail the pipeline over it.
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      await fs.rename(this.filePath, backup).catch(() => {});
      await this.pruneCorruptBackups();
      debugLogger.debug(`corrupt upload cache backed up to ${backup}`);
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

  private async save(data: UploadCacheFile): Promise<void> {
    const tmp = `${this.filePath}.tmp-${randomBytes(4).toString('hex')}`;
    try {
      await fs.mkdir(path.dirname(this.filePath), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
      await fs.rename(tmp, this.filePath);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      // Cache persistence is best-effort by design.
      debugLogger.debug(
        `upload cache write failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private key(sha256: string, model: string): string {
    return `${sha256}|${model}|${this.scope}`;
  }

  /** Valid cached URL or null. Expired entries are pruned on read. */
  async get(sha256: string, model: string): Promise<string | null> {
    if (!this.enabled) return null;
    return serialize(this.filePath, () => this.getInner(sha256, model));
  }

  private async getInner(
    sha256: string,
    model: string,
  ): Promise<string | null> {
    const data = await this.load();
    if (!data) return null;
    const k = this.key(sha256, model);
    const entry = data.entries[k];
    if (!entry) return null;
    const expiresAtMs = Date.parse(entry.expiresAt);
    // Malformed timestamps (NaN) must expire, not live forever.
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      delete data.entries[k];
      await this.save(data);
      return null;
    }
    return entry.ossUrl;
  }

  async put(sha256: string, model: string, ossUrl: string): Promise<void> {
    if (!this.enabled) return;
    return serialize(this.filePath, async () => {
      const data = await this.load();
      if (!data) return;
      const now = Date.now();
      data.entries[this.key(sha256, model)] = {
        ossUrl,
        uploadedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.ttlMs).toISOString(),
      };
      // Wholesale sweep of expired entries: `get()` prunes only the key it
      // was asked about, so entries that are never read again would
      // otherwise accumulate forever — every load/save re-parses and
      // rewrites the whole table, monotonically slowing with dead history.
      // put() is the natural hook: it already holds the serialized write.
      for (const [k, v] of Object.entries(data.entries)) {
        const t = Date.parse(v.expiresAt);
        if (!Number.isFinite(t) || t <= now) delete data.entries[k];
      }
      await this.save(data);
    });
  }

  /**
   * Drop every entry pointing at a server-side-invalidated URL.
   *
   * Deliberately ignores the `enabled` flag: even for ttlHours-0 users
   * this must clear stale entries persisted before the cache was
   * disabled, and it serves the recovery cascade. The URL scan is
   * scope-agnostic on purpose — the caller only knows the rejected URL,
   * not which endpoint scope minted it.
   */
  async invalidateByUrl(ossUrl: string): Promise<void> {
    return serialize(this.filePath, async () => {
      const data = await this.load();
      if (!data) return;
      let changed = false;
      for (const [k, v] of Object.entries(data.entries)) {
        if (v.ossUrl === ossUrl) {
          delete data.entries[k];
          changed = true;
        }
      }
      if (changed) {
        debugLogger.debug(`invalidated upload cache entries for ${ossUrl}`);
        await this.save(data);
      }
    });
  }

  /**
   * Drop all entries for an object (GC/corruption cascade). Ignores the
   * `enabled` flag for the same reason as {@link invalidateByUrl}. The
   * prefix match spans models AND scopes — intended: a corrupt object is
   * corrupt for every endpoint.
   */
  async removeBySha256(sha256: string): Promise<void> {
    return serialize(this.filePath, async () => {
      const data = await this.load();
      if (!data) return;
      const prefix = `${sha256}|`;
      let changed = false;
      for (const k of Object.keys(data.entries)) {
        if (k.startsWith(prefix)) {
          delete data.entries[k];
          changed = true;
        }
      }
      if (changed) await this.save(data);
    });
  }
}
