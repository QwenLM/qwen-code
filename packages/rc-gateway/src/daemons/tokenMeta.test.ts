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
import {
  readTokenMeta,
  writeTokenMeta,
  deleteTokenMeta,
  metaPath,
  type TokenMeta,
} from './tokenMeta.js';

const META: TokenMeta = {
  tokenId: 'tok_abc123',
  scopes: ['owner'],
  label: 'work-a',
  addedAt: '2026-08-17T00:00:00.000Z',
};

describe('tokenMeta', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rc-meta-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips meta at 0600 in a 0700 dir, next to the .tok name', async () => {
    await writeTokenMeta(dir, 'work-a', META);
    const file = metaPath(dir, 'work-a');
    expect(file).toBe(join(dir, 'work-a.meta.json'));
    const fm = (await fs.stat(file)).mode & 0o777;
    const dm = (await fs.stat(dir)).mode & 0o777;
    expect(fm).toBe(0o600);
    expect(dm).toBe(0o700);
    await expect(readTokenMeta(dir, 'work-a')).resolves.toEqual(META);
  });

  it('sanitises the key on disk', async () => {
    await writeTokenMeta(dir, 'a/b', META);
    await expect(readTokenMeta(dir, 'a/b')).resolves.toEqual(META);
    await expect(
      fs.access(join(dir, 'a_b.meta.json')),
    ).resolves.toBeUndefined();
  });

  it('yields null for a missing key', async () => {
    await expect(readTokenMeta(dir, 'nope')).resolves.toBeNull();
  });

  it('yields null for corrupt or wrong-shaped meta', async () => {
    await fs.writeFile(metaPath(dir, 'x'), '{not json', { mode: 0o600 });
    await expect(readTokenMeta(dir, 'x')).resolves.toBeNull();
    await fs.writeFile(
      metaPath(dir, 'y'),
      JSON.stringify({ tokenId: 42, scopes: [] }),
      { mode: 0o600 },
    );
    await expect(readTokenMeta(dir, 'y')).resolves.toBeNull();
  });

  it('delete is idempotent', async () => {
    await writeTokenMeta(dir, 'k', META);
    await deleteTokenMeta(dir, 'k');
    await deleteTokenMeta(dir, 'k');
    await expect(readTokenMeta(dir, 'k')).resolves.toBeNull();
  });
});
