/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * General purpose cache with TTL (Time To Live) support
 */
export class GeneralCache<T> {
  private readonly cache = new Map<string, { value: T; expiry: number }>();

  constructor(
    private readonly defaultTtlMs: number = 5 * 60 * 1000, // 5 minutes default
  ) {}

  /**
   * Get a value from the cache
   * @param key Cache key
   * @returns Value if found and not expired, undefined otherwise
   */
  get(key: string): T | undefined {
    const item = this.cache.get(key);
    if (!item) {
      return undefined;
    }

    if (Date.now() > item.expiry) {
      // Remove expired item
      this.cache.delete(key);
      return undefined;
    }

    return item.value;
  }

  /**
   * Set a value in the cache
   * @param key Cache key
   * @param value Value to cache
   * @param ttlMs Time to live in milliseconds (optional, uses default if not provided)
   */
  set(key: string, value: T, ttlMs?: number): void {
    const expiry = Date.now() + (ttlMs ?? this.defaultTtlMs);
    this.cache.set(key, { value, expiry });
  }

  /**
   * Check if a key exists in the cache and is not expired
   * @param key Cache key
   * @returns True if key exists and is not expired, false otherwise
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Delete a key from the cache
   * @param key Cache key to delete
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries from the cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the number of entries in the cache
   */
  size(): number {
    // Clean up expired entries while counting
    let count = 0;
    for (const [key, item] of this.cache.entries()) {
      if (Date.now() > item.expiry) {
        this.cache.delete(key);
      } else {
        count++;
      }
    }
    return count;
  }

  /**
   * Get cache stats
   */
  getStats(): { size: number; entries: number } {
    const now = Date.now();
    let validEntries = 0;

    for (const item of this.cache.values()) {
      if (now <= item.expiry) {
        validEntries++;
      }
    }

    return { size: this.cache.size, entries: validEntries };
  }
}

/**
 * Memoize decorator for caching function results
 */
export function memoize(_ttlMs: number = 5 * 60 * 1000): MethodDecorator {
  const ttlMs = _ttlMs;
  const cache = new GeneralCache<unknown>();

  return function (
    target: unknown,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = function (...args: unknown[]) {
      // Create a key from the method name and arguments
      const key = `${String(propertyKey)}:${JSON.stringify(args)}`;

      // Check if result is already cached
      const cached = cache.get(key);
      if (cached !== undefined) {
        return cached;
      }

      // Call the original method and cache the result
      const result = originalMethod.apply(this, args);

      // If it's a promise, cache the resolved value
      if (result instanceof Promise) {
        return result.then((resolvedResult) => {
          cache.set(key, resolvedResult, ttlMs);
          return resolvedResult;
        });
      }

      // Cache synchronous result
      cache.set(key, result, ttlMs);
      return result;
    };

    return descriptor;
  };
}

// Global cache instances
export const globalCache = new GeneralCache();
export const modelInfoCache = new GeneralCache();
export const fileHashCache = new GeneralCache();
