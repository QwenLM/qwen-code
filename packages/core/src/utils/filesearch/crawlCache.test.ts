/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  getCacheKey,
  read,
  write,
  clear,
  MAX_CACHE_ENTRIES,
} from './crawlCache.js';

describe('CrawlCache', () => {
  describe('getCacheKey', () => {
    it('should generate a consistent hash', () => {
      const key1 = getCacheKey('/foo', 'bar');
      const key2 = getCacheKey('/foo', 'bar');
      expect(key1).toBe(key2);
    });

    it('should generate a different hash for different directories', () => {
      const key1 = getCacheKey('/foo', 'bar');
      const key2 = getCacheKey('/bar', 'bar');
      expect(key1).not.toBe(key2);
    });

    it('should generate a different hash for different ignore content', () => {
      const key1 = getCacheKey('/foo', 'bar');
      const key2 = getCacheKey('/foo', 'baz');
      expect(key1).not.toBe(key2);
    });

    it('should generate a different hash for different maxDepth values', () => {
      const key1 = getCacheKey('/foo', 'bar', 1);
      const key2 = getCacheKey('/foo', 'bar', 2);
      const key3 = getCacheKey('/foo', 'bar', undefined);
      const key4 = getCacheKey('/foo', 'bar');
      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key2).not.toBe(key3);
      expect(key3).toBe(key4);
    });

    it('should generate a different hash for different gitignore modes', () => {
      const key1 = getCacheKey('/foo', 'bar', undefined, undefined, true);
      const key2 = getCacheKey('/foo', 'bar', undefined, undefined, false);
      expect(key1).not.toBe(key2);
    });
  });

  describe('in-memory cache operations', () => {
    beforeEach(() => {
      // Ensure a clean slate before each test
      clear();
    });

    afterEach(() => {
      // Restore real timers after each test that uses fake ones
      vi.useRealTimers();
    });

    it('should write and read data from the cache', () => {
      const key = 'test-key';
      const data = ['foo', 'bar'];
      write(key, data, 10000); // 10 second TTL
      const cachedData = read(key);
      expect(cachedData).toEqual(data);
    });

    it('should return undefined for a nonexistent key', () => {
      const cachedData = read('nonexistent-key');
      expect(cachedData).toBeUndefined();
    });

    it('should clear the cache', () => {
      const key = 'test-key';
      const data = ['foo', 'bar'];
      write(key, data, 10000);
      clear();
      const cachedData = read(key);
      expect(cachedData).toBeUndefined();
    });

    it('should automatically evict a cache entry after its TTL expires', async () => {
      vi.useFakeTimers();
      const key = 'ttl-key';
      const data = ['foo'];
      const ttl = 5000; // 5 seconds

      write(key, data, ttl);

      // Should exist immediately after writing
      expect(read(key)).toEqual(data);

      // Advance time just before expiration
      await vi.advanceTimersByTimeAsync(ttl - 1);
      expect(read(key)).toEqual(data);

      // Advance time past expiration
      await vi.advanceTimersByTimeAsync(1);
      expect(read(key)).toBeUndefined();
    });

    it('should reset the timer when an entry is updated', async () => {
      vi.useFakeTimers();
      const key = 'update-key';
      const initialData = ['initial'];
      const updatedData = ['updated'];
      const ttl = 5000; // 5 seconds

      // Write initial data
      write(key, initialData, ttl);

      // Advance time, but not enough to expire
      await vi.advanceTimersByTimeAsync(3000);
      expect(read(key)).toEqual(initialData);

      // Update the data, which should reset the timer
      write(key, updatedData, ttl);
      expect(read(key)).toEqual(updatedData);

      // Advance time again. If the timer wasn't reset, the total elapsed
      // time (3000 + 3000 = 6000) would cause an eviction.
      await vi.advanceTimersByTimeAsync(3000);
      expect(read(key)).toEqual(updatedData);

      // Advance past the new expiration time
      await vi.advanceTimersByTimeAsync(2001);
      expect(read(key)).toBeUndefined();
    });

    it('should enforce MAX_TOTAL_PATHS when updating an existing key with a large array', () => {
      // Helper to create an array of given length
      const makePaths = (n: number) =>
        Array.from({ length: n }, (_, i) => `path/${i}`);

      // Write key_A with a moderate number of paths
      const keyA = 'project-a';
      const keyB = 'project-b';
      const keyC = 'project-c';

      write(keyA, makePaths(1000), 60000);
      write(keyB, makePaths(20000), 60000);
      write(keyC, makePaths(20000), 60000);

      // Now update key_A with 60000 paths — this alone exceeds MAX_TOTAL_PATHS (50000)
      // Before the fix, !crawlCache.has(keyA) was false, so eviction was skipped.
      // After the fix, keyB and keyC should be evicted to make room.
      write(keyA, makePaths(60000), 60000);

      // Verify keyA's data is stored
      expect(read(keyA)).toBeDefined();
      expect(read(keyA)!.length).toBe(60000);

      // After eviction, keyB and keyC must be gone because keyA with 60000 paths
      // exceeds the MAX_TOTAL_PATHS limit (50000), triggering eviction of others.
      expect(read(keyB)).toBeUndefined();
      expect(read(keyC)).toBeUndefined();
    });

    it('should bump existing key to end of FIFO queue on update', () => {
      // When MAX_CACHE_ENTRIES is reached, the oldest (first inserted) entry is evicted.
      // Updating an existing key should move it to the end, preventing its eviction.

      // Fill cache to capacity with distinct keys
      for (let i = 0; i < MAX_CACHE_ENTRIES; i++) {
        write(`key-${i}`, [`path`], 60000);
      }
      // key-0 is the oldest entry
      expect(read('key-0')).toBeDefined();

      // Update key-0 — it should bump to the end of the queue
      write('key-0', [`updated-path`], 60000);

      // Now insert one more key, which should trigger eviction of the OLDEST entry.
      // After bump, key-1 is the oldest, not key-0.
      write(`key-new`, [`new-path`], 60000);

      // key-0 should survive because it was bumped to the end
      expect(read('key-0')).toBeDefined();
      expect(read('key-0')![0]).toBe('updated-path');

      // key-1 should be evicted (it became the oldest after key-0 was bumped)
      expect(read('key-1')).toBeUndefined();
    });

    it('should evict other entries when a new key exceeds MAX_TOTAL_PATHS', () => {
      // Exact scenario from reviewer comment #2: a new key whose array
      // alone exceeds MAX_TOTAL_PATHS should trigger eviction of others.
      const makePaths = (n: number) =>
        Array.from({ length: n }, (_, i) => `path/${i}`);

      const keyA = 'project-a';
      const keyB = 'project-b';
      const keyC = 'project-c';

      // Pre-populate with moderate entries
      write(keyA, makePaths(10000), 60000);
      write(keyB, makePaths(10000), 60000);
      write(keyC, makePaths(10000), 60000);

      // New key with 60000 paths — exceeds MAX_TOTAL_PATHS (50000) alone
      write('project-new', makePaths(60000), 60000);

      // New key should be stored, others evicted to make room
      expect(read('project-new')).toBeDefined();
      expect(read('project-new')!.length).toBe(60000);
      expect(read(keyA)).toBeUndefined();
      expect(read(keyB)).toBeUndefined();
      expect(read(keyC)).toBeUndefined();
    });
  });
});
