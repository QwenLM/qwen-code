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
 * one extra re-upload, but cheap to prevent). Cross-process writes remain
 * last-writer-wins (documented). */
const fileOps = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileOps.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  fileOps.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

/** Default oss:// URL validity horizon: 47h (official 48h minus margin). */
export const DEFAULT_UPLOAD_CACHE_TTL_HOURS = 47;

interface UploadCacheEntry {
  ossUrl: string;
  uploadedAt: string;
  expiresAt: string;
}

interface UploadCacheFile {
  version: 1;
  /** Key: `<sha256>|<model>`. */
  entries: Record<string, UploadCacheEntry>;
}

/**
 * Persistent map from object identity to a still-valid DashScope temporary
 * URL: `(sha256, model) → { ossUrl, uploadedAt, expiresAt }` (storage
 * design §8). Lives at `.qwen/omni/upload-cache.json`.
 *
 * Invariants:
 * - the cache file is the ONLY place an oss:// URL is persisted by omni —
 *   the URL is a delivery cache, never an identity;
 * - keys include the model: the docs declare uploads model-bound (looser
 *   in practice, but honored conservatively);
 * - expired entries are misses and are lazily pruned;
 * - a corrupt cache file is backed up and rebuilt empty (never fatal);
 * - writes are atomic (tmp + rename, 0600) and last-writer-wins across
 *   processes — acceptable for the experiment (worst case: a lost entry
 *   causes one extra re-upload).
 */
export class OmniUploadCache {
  private readonly filePath: string;
  private readonly ttlMs: number;

  constructor(omniRootDir: string, ttlHours = DEFAULT_UPLOAD_CACHE_TTL_HOURS) {
    this.filePath = path.join(omniRootDir, 'upload-cache.json');
    this.ttlMs = ttlHours * 3600_000;
  }

  /** TTL of 0 (or negative) disables the cache entirely. */
  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  private async load(): Promise<UploadCacheFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return { version: 1, entries: {} };
    }
    try {
      const parsed = JSON.parse(raw) as UploadCacheFile;
      if (parsed?.version === 1 && typeof parsed.entries === 'object') {
        return parsed;
      }
      throw new Error('unexpected shape');
    } catch {
      // Corrupt cache: preserve for inspection, start fresh. Losing the
      // cache only costs re-uploads — never fail the pipeline over it.
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      await fs.rename(this.filePath, backup).catch(() => {});
      debugLogger.debug(`corrupt upload cache backed up to ${backup}`);
      return { version: 1, entries: {} };
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
    return `${sha256}|${model}`;
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
      const now = Date.now();
      data.entries[this.key(sha256, model)] = {
        ossUrl,
        uploadedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.ttlMs).toISOString(),
      };
      await this.save(data);
    });
  }

  /** Drop every entry pointing at a server-side-invalidated URL. */
  async invalidateByUrl(ossUrl: string): Promise<void> {
    return serialize(this.filePath, async () => {
      const data = await this.load();
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

  /** Drop all entries for an object (GC/corruption cascade). */
  async removeBySha256(sha256: string): Promise<void> {
    return serialize(this.filePath, async () => {
      const data = await this.load();
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
