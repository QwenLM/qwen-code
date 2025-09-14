/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A simple Least Recently Used (LRU) cache implementation.
 * @template K The type of the cache keys.
 * @template V The type of the cache values.
 */
export class LruCache<K, V> {
  private cache: Map<K, V>;
  private maxSize: number;

  /**
   * Creates a new LruCache.
   * @param maxSize The maximum number of items to store in the cache.
   */
  constructor(maxSize: number) {
    this.cache = new Map<K, V>();
    this.maxSize = maxSize;
  }

  /**
   * Retrieves an item from the cache.
   * If the item exists, it is marked as recently used.
   * @param key The key of the item to retrieve.
   * @returns The value of the item, or undefined if the item is not in the cache.
   */
  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value) {
      // Move to end to mark as recently used
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  /**
   * Adds an item to the cache.
   * If the cache is full, the least recently used item is removed.
   * @param key The key of the item to add.
   * @param value The value of the item to add.
   */
  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  /**
   * Clears all items from the cache.
   */
  clear(): void {
    this.cache.clear();
  }
}
