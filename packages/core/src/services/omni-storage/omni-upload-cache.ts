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

  constructor(private readonly filePath: string) {}

  private load(): CacheMap {
    if (this.cache !== undefined) return this.cache;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      this.cache =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as CacheMap)
          : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      const tmpPath = path.join(
        dir,
        `.upload-cache-${randomBytes(4).toString('hex')}.tmp`,
      );
      fs.writeFileSync(tmpPath, JSON.stringify(this.cache ?? {}, null, 2), {
        mode: 0o600,
      });
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      debugLogger.warn('Failed to persist upload cache:', err);
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
