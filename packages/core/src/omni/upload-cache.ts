/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';
import { OmniJsonCacheFile } from './json-cache-file.js';

const debugLogger = createDebugLogger('omni:upload-cache');

/** Default oss:// URL validity horizon: 47h (official 48h minus margin). */
export const DEFAULT_UPLOAD_CACHE_TTL_HOURS = 47;

/** Hard ceiling for any configured TTL: the server-side URL dies at 48h,
 * so a longer local TTL would confidently serve dead URLs. */
const MAX_UPLOAD_CACHE_TTL_HOURS = 48;

interface UploadCacheEntry {
  ossUrl: string;
  uploadedAt: string;
  expiresAt: string;
}

/**
 * Persistent map from object identity to a still-valid DashScope temporary
 * URL: `(sha256, model, scope) → { ossUrl, uploadedAt, expiresAt }`
 * (storage design §8). Lives at `.qwen/omni/upload-cache.json`.
 *
 * File mechanics (serialized ops, atomic writes, corrupt backup+rebuild,
 * unreadable-file no-op) live in {@link OmniJsonCacheFile}. Entry
 * invariants:
 *
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
 * - writes are last-writer-wins across processes — acceptable for the
 *   experiment (worst case: a lost entry causes one extra re-upload).
 */
export class OmniUploadCache {
  private readonly file: OmniJsonCacheFile<UploadCacheEntry>;
  private readonly ttlMs: number;
  private readonly scope: string;

  constructor(
    omniRootDir: string,
    ttlHours = DEFAULT_UPLOAD_CACHE_TTL_HOURS,
    scope = '',
  ) {
    this.file = new OmniJsonCacheFile(
      path.join(omniRootDir, 'upload-cache.json'),
      'omni:upload-cache',
    );
    // Positive TTLs are clamped to the 48h server URL lifetime — a
    // configured 168 must not outlive the URL. 0/negative still disables.
    this.ttlMs = Math.min(ttlHours, MAX_UPLOAD_CACHE_TTL_HOURS) * 3600_000;
    this.scope = scope;
  }

  /** TTL of 0 (or negative) disables the cache entirely. */
  get enabled(): boolean {
    return this.ttlMs > 0;
  }

  private key(sha256: string, model: string): string {
    return `${sha256}|${model}|${this.scope}`;
  }

  /** Valid cached URL or null. Expired entries are pruned on read. */
  async get(sha256: string, model: string): Promise<string | null> {
    if (!this.enabled) return null;
    return this.file.access<string | null>(null, (entries) => {
      const k = this.key(sha256, model);
      const entry = entries[k];
      if (!entry) return { result: null };
      const expiresAtMs = Date.parse(entry.expiresAt);
      // Malformed timestamps (NaN) must expire, not live forever.
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
        delete entries[k];
        return { result: null, changed: true };
      }
      return { result: entry.ossUrl };
    });
  }

  async put(sha256: string, model: string, ossUrl: string): Promise<void> {
    if (!this.enabled) return;
    return this.file.access(undefined, (entries) => {
      const now = Date.now();
      entries[this.key(sha256, model)] = {
        ossUrl,
        uploadedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.ttlMs).toISOString(),
      };
      // Wholesale sweep of expired entries: `get()` prunes only the key it
      // was asked about, so entries that are never read again would
      // otherwise accumulate forever — every load/save re-parses and
      // rewrites the whole table, monotonically slowing with dead history.
      // put() is the natural hook: it already holds the serialized write.
      for (const [k, v] of Object.entries(entries)) {
        const t = Date.parse(v.expiresAt);
        if (!Number.isFinite(t) || t <= now) delete entries[k];
      }
      return { result: undefined, changed: true };
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
    return this.file.access(undefined, (entries) => {
      let changed = false;
      for (const [k, v] of Object.entries(entries)) {
        if (v.ossUrl === ossUrl) {
          delete entries[k];
          changed = true;
        }
      }
      if (changed) {
        debugLogger.debug(`invalidated upload cache entries for ${ossUrl}`);
      }
      return { result: undefined, changed };
    });
  }

  /**
   * Drop all entries for an object (GC/corruption cascade). Ignores the
   * `enabled` flag for the same reason as {@link invalidateByUrl}. The
   * prefix match spans models AND scopes — intended: a corrupt object is
   * corrupt for every endpoint.
   */
  async removeBySha256(sha256: string): Promise<void> {
    return this.file.access(undefined, (entries) => {
      const prefix = `${sha256}|`;
      let changed = false;
      for (const k of Object.keys(entries)) {
        if (k.startsWith(prefix)) {
          delete entries[k];
          changed = true;
        }
      }
      return { result: undefined, changed };
    });
  }
}
