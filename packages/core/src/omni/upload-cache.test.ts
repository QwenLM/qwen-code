/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OmniUploadCache } from './upload-cache.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-ucache-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const SHA = 'a'.repeat(64);

describe('OmniUploadCache', () => {
  it('round-trips an entry and persists across instances', async () => {
    const cache = new OmniUploadCache(root);
    await cache.put(SHA, 'qwen3.5-omni-plus', 'oss://bucket/key1');
    expect(await cache.get(SHA, 'qwen3.5-omni-plus')).toBe('oss://bucket/key1');
    // Fresh instance reads the same file (cross-restart survival).
    const cache2 = new OmniUploadCache(root);
    expect(await cache2.get(SHA, 'qwen3.5-omni-plus')).toBe(
      'oss://bucket/key1',
    );
  });

  it('keys by model — a different model is a miss', async () => {
    const cache = new OmniUploadCache(root);
    await cache.put(SHA, 'model-a', 'oss://bucket/a');
    expect(await cache.get(SHA, 'model-b')).toBeNull();
  });

  it('expired entries are misses and are pruned lazily', async () => {
    const cache = new OmniUploadCache(root);
    await cache.put(SHA, 'm', 'oss://bucket/x');
    // Rewrite the file with an expired timestamp.
    const file = path.join(root, 'upload-cache.json');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.entries[`${SHA}|m`].expiresAt = new Date(
      Date.now() - 1000,
    ).toISOString();
    await fs.writeFile(file, JSON.stringify(data));

    expect(await cache.get(SHA, 'm')).toBeNull();
    const after = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(after.entries[`${SHA}|m`]).toBeUndefined(); // pruned
  });

  it('invalidateByUrl drops every entry with that URL', async () => {
    const cache = new OmniUploadCache(root);
    await cache.put(SHA, 'm1', 'oss://bucket/shared');
    await cache.put(SHA, 'm2', 'oss://bucket/shared');
    await cache.put('b'.repeat(64), 'm1', 'oss://bucket/other');
    await cache.invalidateByUrl('oss://bucket/shared');
    expect(await cache.get(SHA, 'm1')).toBeNull();
    expect(await cache.get(SHA, 'm2')).toBeNull();
    expect(await cache.get('b'.repeat(64), 'm1')).toBe('oss://bucket/other');
  });

  it('removeBySha256 cascades all models for the object', async () => {
    const cache = new OmniUploadCache(root);
    await cache.put(SHA, 'm1', 'oss://bucket/1');
    await cache.put(SHA, 'm2', 'oss://bucket/2');
    await cache.removeBySha256(SHA);
    expect(await cache.get(SHA, 'm1')).toBeNull();
    expect(await cache.get(SHA, 'm2')).toBeNull();
  });

  it('backs up a corrupt cache file and starts fresh', async () => {
    const file = path.join(root, 'upload-cache.json');
    await fs.writeFile(file, 'not json at all {{{');
    const cache = new OmniUploadCache(root);
    expect(await cache.get(SHA, 'm')).toBeNull();
    await cache.put(SHA, 'm', 'oss://bucket/fresh');
    expect(await cache.get(SHA, 'm')).toBe('oss://bucket/fresh');
    const names = await fs.readdir(root);
    expect(names.some((n) => n.startsWith('upload-cache.json.corrupt-'))).toBe(
      true,
    );
  });

  it('treats malformed expiresAt as expired (never immortal)', async () => {
    const cache = new OmniUploadCache(root);
    await cache.put(SHA, 'm', 'oss://bucket/x');
    const file = path.join(root, 'upload-cache.json');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.entries[`${SHA}|m`].expiresAt = 'not-a-date';
    await fs.writeFile(file, JSON.stringify(data));
    expect(await cache.get(SHA, 'm')).toBeNull();
  });

  it('serializes concurrent puts without losing entries', async () => {
    const cache = new OmniUploadCache(root);
    await Promise.all([
      cache.put('a'.repeat(64), 'm', 'oss://bucket/a'),
      cache.put('b'.repeat(64), 'm', 'oss://bucket/b'),
      cache.put('c'.repeat(64), 'm', 'oss://bucket/c'),
    ]);
    expect(await cache.get('a'.repeat(64), 'm')).toBe('oss://bucket/a');
    expect(await cache.get('b'.repeat(64), 'm')).toBe('oss://bucket/b');
    expect(await cache.get('c'.repeat(64), 'm')).toBe('oss://bucket/c');
  });

  it('ttl 0 disables the cache entirely', async () => {
    const cache = new OmniUploadCache(root, 0);
    expect(cache.enabled).toBe(false);
    await cache.put(SHA, 'm', 'oss://bucket/x');
    expect(await cache.get(SHA, 'm')).toBeNull();
    await expect(
      fs.access(path.join(root, 'upload-cache.json')),
    ).rejects.toThrow(); // nothing written
  });
});
