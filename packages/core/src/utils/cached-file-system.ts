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

  constructor(cacheTimeoutMs: number = 5000) {
    // 5 second default cache timeout
    this.cacheTimeoutMs = cacheTimeoutMs;
  }

  /**
   * Checks if an item is expired based on timestamp
   */
  private isExpired(timestamp: number): boolean {
    return Date.now() - timestamp >= this.cacheTimeoutMs;
  }

  /**
   * Gets file stats with caching to reduce fs calls.
   * @param filePath Path to the file or directory
   * @returns Stats object or null if file doesn't exist
   */
  async stat(filePath: string): Promise<Stats | null> {
    const cacheKey = path.resolve(filePath);
    const now = Date.now();

    const cached = this.fileStatCache.get(cacheKey);
    if (cached && !this.isExpired(cached.timestamp)) {
      return cached.stats;
    }

    // Clean expired entry if present
    if (cached) {
      this.fileStatCache.delete(cacheKey);
    }

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

    const cached = this.fileContentCache.get(cacheKey);
    if (cached && !this.isExpired(cached.timestamp)) {
      return cached.content;
    }

    // Clean expired entry if present
    if (cached) {
      this.fileContentCache.delete(cacheKey);
    }

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

    const cached = this.directoryCache.get(cacheKey);
    if (cached && !this.isExpired(cached.timestamp)) {
      return [...cached.entries]; // Return a copy to prevent external modifications
    }

    // Clean expired entry if present
    if (cached) {
      this.directoryCache.delete(cacheKey);
    }

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
}

// Create a global instance to share across the application
export const cachedFileSystem = new CachedFileSystem();
