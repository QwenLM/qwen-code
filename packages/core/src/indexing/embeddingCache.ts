/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import { LruCache } from '../utils/LruCache.js';
import type { IMetadataStore } from './types.js';

/**
 * Configuration for EmbeddingCache.
 */
export interface EmbeddingCacheConfig {
  /** Maximum entries in memory cache. Default: 10000. */
  maxMemoryEntries: number;
  /** Whether to persist to SQLite. Default: true. */
  persistToSqlite: boolean;
}

/**
 * Default configuration.
 */
export const DEFAULT_EMBEDDING_CACHE_CONFIG: EmbeddingCacheConfig = {
  maxMemoryEntries: 10000,
  persistToSqlite: true,
};

/**
 * Two-level cache for embeddings.
 *
 * Level 1: In-memory LRU cache for fast access
 * Level 2: SQLite persistent storage via MetadataStore
 *
 * Cache key is computed as SHA-256 hash of content, ensuring
 * deduplication across files with identical content.
 */
export class EmbeddingCache {
  private memoryCache: LruCache<string, number[]>;
  private metadataStore: IMetadataStore | null;
  private config: EmbeddingCacheConfig;

  // Statistics
  private stats = {
    memoryHits: 0,
    sqliteHits: 0,
    misses: 0,
  };

  constructor(
    metadataStore: IMetadataStore | null = null,
    config: Partial<EmbeddingCacheConfig> = {},
  ) {
    this.config = { ...DEFAULT_EMBEDDING_CACHE_CONFIG, ...config };
    this.memoryCache = new LruCache<string, number[]>(
      this.config.maxMemoryEntries,
    );
    this.metadataStore = metadataStore;
  }

  /**
   * Get embedding from cache.
   *
   * @param content - The content to get embedding for
   * @returns The cached embedding or null if not found
   */
  get(content: string): number[] | null {
    const cacheKey = this.computeCacheKey(content);

    // Try memory cache first (L1)
    const memoryResult = this.memoryCache.get(cacheKey);
    if (memoryResult) {
      this.stats.memoryHits++;
      return memoryResult;
    }

    // Try SQLite cache (L2)
    if (this.metadataStore && this.config.persistToSqlite) {
      const sqliteResult = this.metadataStore.getEmbeddingCache(cacheKey);
      if (sqliteResult) {
        // Promote to memory cache
        this.memoryCache.set(cacheKey, sqliteResult);
        this.stats.sqliteHits++;
        return sqliteResult;
      }
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Get embedding by cache key directly.
   *
   * @param cacheKey - The cache key
   * @returns The cached embedding or null if not found
   */
  getByKey(cacheKey: string): number[] | null {
    // Try memory cache first (L1)
    const memoryResult = this.memoryCache.get(cacheKey);
    if (memoryResult) {
      this.stats.memoryHits++;
      return memoryResult;
    }

    // Try SQLite cache (L2)
    if (this.metadataStore && this.config.persistToSqlite) {
      const sqliteResult = this.metadataStore.getEmbeddingCache(cacheKey);
      if (sqliteResult) {
        // Promote to memory cache
        this.memoryCache.set(cacheKey, sqliteResult);
        this.stats.sqliteHits++;
        return sqliteResult;
      }
    }

    this.stats.misses++;
    return null;
  }

  /**
   * Set embedding in cache.
   *
   * @param content - The content
   * @param embedding - The embedding vector
   */
  set(content: string, embedding: number[]): void {
    const cacheKey = this.computeCacheKey(content);
    this.setByKey(cacheKey, embedding);
  }

  /**
   * Set embedding by cache key directly.
   *
   * @param cacheKey - The cache key
   * @param embedding - The embedding vector
   */
  setByKey(cacheKey: string, embedding: number[]): void {
    // Store in memory cache (L1)
    this.memoryCache.set(cacheKey, embedding);

    // Persist to SQLite (L2)
    if (this.metadataStore && this.config.persistToSqlite) {
      this.metadataStore.setEmbeddingCache(cacheKey, embedding);
    }
  }

  /**
   * Check if content has a cached embedding.
   *
   * @param content - The content to check
   * @returns True if cached
   */
  has(content: string): boolean {
    return this.get(content) !== null;
  }

  /**
   * Compute cache key for content.
   *
   * @param content - The content
   * @returns SHA-256 hash as cache key
   */
  computeCacheKey(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Get batch of embeddings for multiple contents.
   *
   * @param contents - Array of contents
   * @returns Map of content to embedding (only for cached entries)
   */
  getBatch(contents: string[]): Map<string, number[]> {
    const result = new Map<string, number[]>();

    for (const content of contents) {
      const embedding = this.get(content);
      if (embedding) {
        result.set(content, embedding);
      }
    }

    return result;
  }

  /**
   * Set batch of embeddings.
   *
   * @param entries - Array of [content, embedding] pairs
   */
  setBatch(entries: Array<[string, number[]]>): void {
    for (const [content, embedding] of entries) {
      this.set(content, embedding);
    }
  }

  /**
   * Clear all cached data.
   */
  clear(): void {
    this.memoryCache.clear();
    this.stats = { memoryHits: 0, sqliteHits: 0, misses: 0 };
  }

  /**
   * Get cache statistics.
   */
  getStats(): {
    memoryHits: number;
    sqliteHits: number;
    misses: number;
    hitRate: number;
  } {
    const total =
      this.stats.memoryHits + this.stats.sqliteHits + this.stats.misses;
    const hitRate =
      total > 0 ? (this.stats.memoryHits + this.stats.sqliteHits) / total : 0;

    return {
      ...this.stats,
      hitRate,
    };
  }

  /**
   * Preload embeddings from SQLite into memory cache.
   * Useful for warming up the cache on startup.
   *
   * @param cacheKeys - Array of cache keys to preload
   */
  preload(cacheKeys: string[]): void {
    if (!this.metadataStore || !this.config.persistToSqlite) {
      return;
    }

    for (const cacheKey of cacheKeys) {
      const embedding = this.metadataStore.getEmbeddingCache(cacheKey);
      if (embedding) {
        this.memoryCache.set(cacheKey, embedding);
      }
    }
  }
}
