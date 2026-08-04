/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createDebugLogger } from '../../utils/debugLogger.js';
import type { UploadCacheEntry } from './types.js';

const debugLogger = createDebugLogger('OMNI_UPLOAD_CACHE');

type CacheMap = Record<string, UploadCacheEntry>;

function cacheKey(sha256: string, model: string): string {
  return `${sha256}:${model}`;
}

/**
 * Persistent upload cache mapping (sha256, model) → oss:// URL entries.
 * Backed by a JSON file that survives process restarts.
 */
export class OmniUploadCache {
  private cache: CacheMap | undefined;
  private loadedAtMtimeMs: number | undefined;
  private loadedAtIno: number | undefined;

  constructor(private readonly filePath: string) {}

  private load(): CacheMap {
    if (this.cache !== undefined) return this.cache;
    let raw: string | undefined;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      // Only a missing file starts empty; a transient read failure must
      // not wipe the persisted cache (a later save would persist the loss).
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (raw === undefined) {
      this.cache = {};
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
      this.cache =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as CacheMap)
          : {};
    }
    this.recordLoadedStats();
    return this.cache;
  }

  private recordLoadedStats(): void {
    try {
      const stat = fs.statSync(this.filePath);
      this.loadedAtMtimeMs = stat.mtimeMs;
      this.loadedAtIno = stat.ino;
    } catch {
      this.loadedAtMtimeMs = undefined;
      this.loadedAtIno = undefined;
    }
  }

  private save(): void {
    const merged = this.mergeWithDisk();
    const dir = path.dirname(this.filePath);
    const tmpPath = path.join(
      dir,
      `.upload-cache-${randomBytes(4).toString('hex')}.tmp`,
    );
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), {
        mode: 0o600,
      });
      fs.renameSync(tmpPath, this.filePath);
      this.cache = merged;
      this.recordLoadedStats();
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      debugLogger.warn('Failed to persist upload cache:', err);
    }
  }

  // Another session may rewrite the file after load(); keep its entries
  // instead of clobbering them with our stale map. Our own keys win on
  // conflicts; concurrent deletes can still race — full serialization is
  // the lock strategy the design defers.
  private mergeWithDisk(): CacheMap {
    const ours = this.cache ?? {};
    try {
      const stat = fs.statSync(this.filePath);
      if (
        stat.mtimeMs === this.loadedAtMtimeMs &&
        stat.ino === this.loadedAtIno
      ) {
        return ours;
      }
      const parsed: unknown = JSON.parse(
        fs.readFileSync(this.filePath, 'utf8'),
      );
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        return ours;
      }
      return { ...(parsed as CacheMap), ...ours };
    } catch {
      return ours;
    }
  }

  get(sha256: string, model: string): UploadCacheEntry | undefined {
    const entry = this.load()[cacheKey(sha256, model)];
    if (!entry) return undefined;
    if (new Date(entry.expiresAt).getTime() <= Date.now()) {
      delete this.load()[cacheKey(sha256, model)];
      this.save();
      return undefined;
    }
    return entry;
  }

  set(sha256: string, model: string, entry: UploadCacheEntry): void {
    this.load()[cacheKey(sha256, model)] = entry;
    this.save();
  }

  /** Remove all entries for a given sha256 (called when an object is deleted). */
  invalidate(sha256: string): void {
    const map = this.load();
    const prefix = `${sha256}:`;
    let changed = false;
    for (const key of Object.keys(map)) {
      if (key.startsWith(prefix)) {
        delete map[key];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Batch-remove entries for multiple sha256 hashes with a single save. */
  invalidateMany(sha256s: string[]): void {
    if (sha256s.length === 0) return;
    const map = this.load();
    let changed = false;
    for (const sha256 of sha256s) {
      const prefix = `${sha256}:`;
      for (const key of Object.keys(map)) {
        if (key.startsWith(prefix)) {
          delete map[key];
          changed = true;
        }
      }
    }
    if (changed) this.save();
  }

  /** Remove expired entries. Called during startup recovery. */
  pruneExpired(): number {
    const map = this.load();
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of Object.entries(map)) {
      if (new Date(entry.expiresAt).getTime() <= now) {
        delete map[key];
        pruned++;
      }
    }
    if (pruned > 0) this.save();
    return pruned;
  }
}
