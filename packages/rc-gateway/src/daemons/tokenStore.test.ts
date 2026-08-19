/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTokenStore, sanitizeKey } from './tokenStore.js';

describe('sanitizeKey', () => {
  it('keeps safe chars, replaces the rest, strips leading dots', () => {
    expect(sanitizeKey('work-1.x')).toBe('work-1.x');
    expect(sanitizeKey('a/b c')).toBe('a_b_c');
    expect(sanitizeKey('..\\evil')).toBe('_evil');
    expect(sanitizeKey('')).toBe('key');
    expect(sanitizeKey('...')).toBe('key');
  });
});

describe('FileTokenStore', () => {
  let dir: string;
  let store: FileTokenStore;
  let warns: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-tok-'));
    warns = [];
    store = new FileTokenStore(dir, (m) => warns.push(m));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a token and reports undefined for a missing key', async () => {
    await expect(store.get('nope')).resolves.toBeUndefined();
    await store.set('work', 'tok_abc');
    await expect(store.get('work')).resolves.toBe('tok_abc');
  });

  it('writes tokens at 0600 and the dir at 0700', async () => {
    await store.set('work', 'tok_abc');
    const file = join(dir, sanitizeKey('work') + '.tok');
    const fm = (await fs.stat(file)).mode & 0o777;
    const dm = (await fs.stat(dir)).mode & 0o777;
    expect(fm).toBe(0o600);
    expect(dm).toBe(0o700);
  });

  it('sanitises the key on disk', async () => {
    await store.set('a/b', 'x');
    const file = join(dir, 'a_b.tok');
    await expect(fs.access(file)).resolves.toBeUndefined();
  });

  it('warns once on first write, and delete is idempotent', async () => {
    await store.set('a', '1');
    await store.set('b', '2');
    expect(warns).toHaveLength(1);
    // Spec (Token storage): the one-time warning carries this literal so
    // scripts can detect the keyring-fallback mode.
    expect(warns[0]).toContain('os_keyring_unavailable_using_file_fallback');
    await store.delete('a');
    await store.delete('a'); // idempotent
    await expect(store.get('a')).resolves.toBeUndefined();
    await expect(store.get('b')).resolves.toBe('2');
  });
});
