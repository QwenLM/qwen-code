/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';

/**
 * Cache for file system operations to reduce unnecessary I/O calls.
 */
export class CachedFileSystem {
  private readonly fileStatCache: Map<
    string,
    { stats: Stats; timestamp: number }
  > = new Map();
  private readonly fileContentCache: Map<
    string,
    { content: string; timestamp: number }
  > = new Map();
  private readonly directoryCache: Map<
    string,
    { entries: string[]; timestamp: number }
  > = new Map();
  private readonly cacheTimeoutMs: number;
  private readonly maxCacheSize: number;

  constructor(cacheTimeoutMs: number = 5000, maxCacheSize: number = 10000) {
    // 5 second default cache timeout, 10k max entries
    this.cacheTimeoutMs = cacheTimeoutMs;
    this.maxCacheSize = maxCacheSize;
  }

  /**
   * Checks if an item is expired based on timestamp
   */
  private isExpired(timestamp: number): boolean {
    return Date.now() - timestamp >= this.cacheTimeoutMs;
  }

  /**
   * Checks if any cache has exceeded its maximum size and prunes if needed
   */
  private enforceCacheSize(cache: Map<string, { timestamp: number }>): void {
    if (cache.size > this.maxCacheSize) {
      // Remove oldest entries first - more efficient implementation
      const entries = Array.from(cache.entries());
      // Sort by timestamp to get oldest entries first
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

      const toRemove = Math.floor(this.maxCacheSize / 10) || 1; // Remove at least 1 entry
      for (let i = 0; i < toRemove && i < entries.length; i++) {
        cache.delete(entries[i][0]);
      }
    }
  }

  /**
   * Gets file stats with caching to reduce fs calls.
   * @param filePath Path to the file or directory
   * @returns Stats object or null if file doesn't exist
   */
  async stat(filePath: string): Promise<Stats | null> {
    const cacheKey = path.resolve(filePath);
    const now = Date.now();

    // Clean expired entries when cache reaches certain size to avoid periodic cleaning
    if (this.fileStatCache.size > 0 && this.fileStatCache.size % 200 === 0) {
      this.cleanExpired(this.fileStatCache);
    }

    const cached = this.fileStatCache.get(cacheKey);
    if (cached) {
      if (this.isExpired(cached.timestamp)) {
        this.fileStatCache.delete(cacheKey);
      } else {
        return cached.stats;
      }
    }

    // Enforce cache size limit
    this.enforceCacheSize(this.fileStatCache);

    try {
      const stats = await fs.stat(filePath);
      this.fileStatCache.set(cacheKey, { stats, timestamp: now });
      return stats;
    } catch (error) {
      // Cache non-existence to avoid repeated checks
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.fileStatCache.set(cacheKey, {
          stats: null as unknown as Stats,
          timestamp: now,
        });
        return null;
      }
      throw error;
    }
  }

  /**
   * Checks if a file or directory exists with caching.
   * @param filePath Path to check
   * @returns Boolean indicating existence
   */
  async exists(filePath: string): Promise<boolean> {
    const stats = await this.stat(filePath);
    return stats !== null;
  }

  /**
   * Checks if the given path is a directory with caching.
   * @param filePath Path to check
   * @returns Boolean indicating if it's a directory
   */
  async isDirectory(filePath: string): Promise<boolean> {
    const stats = await this.stat(filePath);
    return stats !== null && stats.isDirectory();
  }

  /**
   * Checks if the given path is a file with caching.
   * @param filePath Path to check
   * @returns Boolean indicating if it's a file
   */
  async isFile(filePath: string): Promise<boolean> {
    const stats = await this.stat(filePath);
    return stats !== null && stats.isFile();
  }

  /**
   * Reads file content with caching to prevent repeated reads.
   * @param filePath Path to the file
   * @param encoding File encoding (default: 'utf-8')
   * @returns File content as string
   */
  async readFile(
    filePath: string,
    encoding: BufferEncoding = 'utf-8',
  ): Promise<string> {
    const cacheKey = path.resolve(filePath);
    const now = Date.now();

    // Clean expired entries when cache reaches certain size to avoid periodic cleaning
    if (
      this.fileContentCache.size > 0 &&
      this.fileContentCache.size % 200 === 0
    ) {
      this.cleanExpired(this.fileContentCache);
    }

    const cached = this.fileContentCache.get(cacheKey);
    if (cached) {
      if (this.isExpired(cached.timestamp)) {
        this.fileContentCache.delete(cacheKey);
      } else {
        return cached.content;
      }
    }

    // Enforce cache size limit
    this.enforceCacheSize(this.fileContentCache);

    const content = await fs.readFile(filePath, encoding);
    this.fileContentCache.set(cacheKey, { content, timestamp: now });
    return content;
  }

  /**
   * Reads directory contents with caching to reduce repeated scans.
   * @param dirPath Path to the directory
   * @returns Array of directory entries
   */
  async readDir(dirPath: string): Promise<string[]> {
    const cacheKey = path.resolve(dirPath);
    const now = Date.now();

    // Clean expired entries when cache reaches certain size to avoid periodic cleaning
    if (this.directoryCache.size > 0 && this.directoryCache.size % 200 === 0) {
      this.cleanExpired(this.directoryCache);
    }

    const cached = this.directoryCache.get(cacheKey);
    if (cached) {
      if (this.isExpired(cached.timestamp)) {
        this.directoryCache.delete(cacheKey);
      } else {
        return [...cached.entries]; // Return a copy to prevent external modifications
      }
    }

    // Enforce cache size limit
    this.enforceCacheSize(this.directoryCache);

    const entries = await fs.readdir(dirPath);
    this.directoryCache.set(cacheKey, { entries, timestamp: now });
    return entries;
  }

  /**
   * Clears all caches or a specific cache type.
   */
  clearCache(type?: 'stats' | 'content' | 'directories' | 'all'): void {
    if (type === 'stats' || type === undefined || type === 'all') {
      this.fileStatCache.clear();
    }
    if (type === 'content' || type === undefined || type === 'all') {
      this.fileContentCache.clear();
    }
    if (type === 'directories' || type === undefined || type === 'all') {
      this.directoryCache.clear();
    }
  }

  /**
   * Invalidates a specific path in all caches.
   * @param filePath Path to invalidate
   */
  invalidatePath(filePath: string): void {
    const resolvedPath = path.resolve(filePath);
    this.fileStatCache.delete(resolvedPath);
    this.fileContentCache.delete(resolvedPath);
    this.directoryCache.delete(resolvedPath);

    // Also invalidate parent directory cache
    const parentDir = path.dirname(resolvedPath);
    if (parentDir !== resolvedPath) {
      // Avoid infinite recursion if path is root
      this.directoryCache.delete(parentDir);
    }
  }

  /**
   * Cleans expired entries from cache
   */
  private cleanExpired(cache: Map<string, { timestamp: number }>): void {
    for (const [key, value] of cache.entries()) {
      if (this.isExpired(value.timestamp)) {
        cache.delete(key);
      }
    }
  }

  /**
   * Gets current cache statistics for debugging/monitoring.
   */
  getCacheStats(): { stats: number; content: number; directories: number } {
    // Clean expired entries before reporting stats
    this.cleanExpired(this.fileStatCache);
    this.cleanExpired(this.fileContentCache);
    this.cleanExpired(this.directoryCache);

    return {
      stats: this.fileStatCache.size,
      content: this.fileContentCache.size,
      directories: this.directoryCache.size,
    };
  }

  /**
   * Performs periodic maintenance on all caches efficiently
   */
  private performPeriodicMaintenance(): void {
    // Clean expired entries from all caches
    this.cleanExpired(this.fileStatCache);
    this.cleanExpired(this.fileContentCache);
    this.cleanExpired(this.directoryCache);

    // Enforce size limits if needed
    this.enforceCacheSize(this.fileStatCache);
    this.enforceCacheSize(this.fileContentCache);
    this.enforceCacheSize(this.directoryCache);
  }

  /**
   * Get total cache size across all types
   */
  getTotalCacheSize(): number {
    return (
      this.fileStatCache.size +
      this.fileContentCache.size +
      this.directoryCache.size
    );
  }

  /**
   * Clean up expired entries periodically based on access patterns
   * @param threshold Percentage of cache that should be valid (default: 80%)
   */
  ensureCacheHealth(threshold: number = 0.8): void {
    const totalSize = this.getTotalCacheSize();
    if (totalSize === 0) return;

    // Only perform maintenance if cache health is below threshold
    const { stats, content, directories } = this.getCacheStats();
    const validEntries = stats + content + directories;
    const cacheHealth = validEntries / totalSize;

    if (cacheHealth < threshold) {
      this.performPeriodicMaintenance();
    }
  }
}

// Create a global instance to share across the application
// Using default parameters (5s cache timeout, 10k max entries)
export const cachedFileSystem = new CachedFileSystem();
