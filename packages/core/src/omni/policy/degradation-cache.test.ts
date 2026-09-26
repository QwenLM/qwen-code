/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computePolicyFingerprint,
  OmniDegradationCache,
} from './degradation-cache.js';

const ORIGINAL = 'a'.repeat(64);
const DEGRADED = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);

const ENTRY = {
  degradedSha256: DEGRADED,
  extension: '.jpg',
  disclosure:
    '原 4096×3072/8.2MB → 1568×1176/0.9MB，质量 75，细节与文字锐度受损',
  mimeType: 'image/jpeg',
};

/** Fingerprint of an omni_downsample_image invocation with `args`. */
const downsampleFp = (args: Record<string, unknown>) =>
  computePolicyFingerprint('omni_downsample_image', args);

describe('computePolicyFingerprint', () => {
  it('is stable across key order and identical inputs', () => {
    const a = downsampleFp({ maxDimension: 1568, quality: 75 });
    const b = downsampleFp({ quality: 75, maxDimension: 1568 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores the per-invocation io params (inputPath/outputDir)', () => {
    const bare = downsampleFp({ quality: 75 });
    const withIo = downsampleFp({
      quality: 75,
      inputPath: '/tmp/a/in.png',
      outputDir: '/tmp/staging/deadbeef',
    });
    expect(withIo).toBe(bare);
  });

  it('ignores undefined values (absent tunable == undefined tunable)', () => {
    expect(
      computePolicyFingerprint('t', { quality: 75, maxDimension: undefined }),
    ).toBe(computePolicyFingerprint('t', { quality: 75 }));
  });

  it.each([
    ['tool name', ['other_tool', { quality: 75 }, undefined]],
    ['argument value', ['t', { quality: 80 }, undefined]],
    ['argument set', ['t', { quality: 75, maxDimension: 800 }, undefined]],
    ['tool version', ['t', { quality: 75 }, '2']],
  ] as Array<[string, [string, Record<string, unknown>, string | undefined]]>)(
    'changes when the %s changes',
    (_label, [tool, args, version]) => {
      const base = computePolicyFingerprint('t', { quality: 75 });
      expect(computePolicyFingerprint(tool, args, version)).not.toBe(base);
    },
  );

  it('sorts keys recursively in nested arguments', () => {
    expect(
      computePolicyFingerprint('t', { opts: { b: 2, a: [1, { d: 4, c: 3 }] } }),
    ).toBe(
      computePolicyFingerprint('t', { opts: { a: [1, { c: 3, d: 4 }], b: 2 } }),
    );
  });
});

describe('OmniDegradationCache', () => {
  let root: string;
  let cache: OmniDegradationCache;
  const fp = downsampleFp({ maxDimension: 1568, quality: 75 });
  const cacheFile = () => path.join(root, 'policy-cache.json');
  const readCacheFile = async () =>
    JSON.parse(await fs.readFile(cacheFile(), 'utf8'));

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'omni-degcache-'));
    cache = new OmniDegradationCache(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('round-trips an entry and persists across instances', async () => {
    await expect(cache.get(ORIGINAL, fp)).resolves.toBeNull();
    await cache.put(ORIGINAL, fp, ENTRY);
    const hit = await cache.get(ORIGINAL, fp);
    expect(hit).toMatchObject(ENTRY);
    expect(Date.parse(hit!.createdAt)).not.toBeNaN();

    const second = new OmniDegradationCache(root);
    await expect(second.get(ORIGINAL, fp)).resolves.toMatchObject(ENTRY);
  });

  it('writes to policy-cache.json under the omni root', async () => {
    await cache.put(ORIGINAL, fp, ENTRY);
    const raw = await readCacheFile();
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.entries)).toEqual([`${ORIGINAL}|${fp}`]);
  });

  it('misses on a different fingerprint or original hash', async () => {
    await cache.put(ORIGINAL, fp, ENTRY);
    const otherFp = downsampleFp({ maxDimension: 800 });
    await expect(cache.get(ORIGINAL, otherFp)).resolves.toBeNull();
    await expect(cache.get(OTHER, fp)).resolves.toBeNull();
  });

  it('re-put for the same key replaces the entry', async () => {
    await cache.put(ORIGINAL, fp, ENTRY);
    await cache.put(ORIGINAL, fp, { ...ENTRY, degradedSha256: 'd'.repeat(64) });
    await expect(cache.get(ORIGINAL, fp)).resolves.toMatchObject({
      degradedSha256: 'd'.repeat(64),
    });
  });

  it('round-trips the optional artifact role (a hit must not strip it)', async () => {
    await cache.put(ORIGINAL, fp, { ...ENTRY, role: 'thumbnail' });
    await expect(cache.get(ORIGINAL, fp)).resolves.toMatchObject({
      ...ENTRY,
      role: 'thumbnail',
    });
    // And an entry without a role stays role-less.
    const fp2 = downsampleFp({ quality: 51 });
    await cache.put(ORIGINAL, fp2, ENTRY);
    const hit = await cache.get(ORIGINAL, fp2);
    expect(hit!.role).toBeUndefined();
  });

  it('removeByOriginalSha256 drops every policy result for the source', async () => {
    const fp2 = downsampleFp({ quality: 50 });
    await cache.put(ORIGINAL, fp, ENTRY);
    await cache.put(ORIGINAL, fp2, ENTRY);
    await cache.put(OTHER, fp, ENTRY);

    await cache.removeByOriginalSha256(ORIGINAL);
    await expect(cache.get(ORIGINAL, fp)).resolves.toBeNull();
    await expect(cache.get(ORIGINAL, fp2)).resolves.toBeNull();
    await expect(cache.get(OTHER, fp)).resolves.not.toBeNull();
  });

  it('removeByDegradedSha256 drops every entry pointing at the derivative', async () => {
    await cache.put(ORIGINAL, fp, ENTRY);
    await cache.put(OTHER, fp, ENTRY);
    await cache.put('e'.repeat(64), fp, {
      ...ENTRY,
      degradedSha256: 'f'.repeat(64),
    });

    await cache.removeByDegradedSha256(DEGRADED);
    await expect(cache.get(ORIGINAL, fp)).resolves.toBeNull();
    await expect(cache.get(OTHER, fp)).resolves.toBeNull();
    await expect(cache.get('e'.repeat(64), fp)).resolves.not.toBeNull();
  });

  it('backs up a corrupt cache file and starts fresh (never fatal)', async () => {
    await fs.writeFile(cacheFile(), '{corrupt');
    await expect(cache.get(ORIGINAL, fp)).resolves.toBeNull();
    const names = await fs.readdir(root);
    expect(names.some((n) => n.startsWith('policy-cache.json.corrupt-'))).toBe(
      true,
    );
    // And the cache is usable again.
    await cache.put(ORIGINAL, fp, ENTRY);
    await expect(cache.get(ORIGINAL, fp)).resolves.toMatchObject(ENTRY);
  });

  it('writes atomically: no .tmp litter, 0600 file mode', async () => {
    await cache.put(ORIGINAL, fp, ENTRY);
    const names = await fs.readdir(root);
    expect(names.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') {
      const stat = await fs.stat(cacheFile());
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('serializes concurrent puts without losing entries', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        cache.put(ORIGINAL, computePolicyFingerprint('t', { i }), ENTRY),
      ),
    );
    const raw = await readCacheFile();
    expect(Object.keys(raw.entries)).toHaveLength(8);
  });

  describe('poisoned cache file (workspace-controlled input is shape-validated)', () => {
    /** Plant raw entries (`value` under the test key) as a hostile repo
     * could ship them. */
    const plantEntries = (
      value: unknown,
      others: Record<string, unknown> = {},
    ) =>
      fs.writeFile(
        cacheFile(),
        JSON.stringify({
          version: 1,
          entries: { [`${ORIGINAL}|${fp}`]: value, ...others },
        }),
      );

    it.each([
      [
        'traversal in degradedSha256',
        { ...ENTRY, degradedSha256: '../../../../etc/passwd' },
      ],
      [
        'uppercase hex degradedSha256',
        { ...ENTRY, degradedSha256: 'A'.repeat(64) },
      ],
      ['short degradedSha256', { ...ENTRY, degradedSha256: 'ab12' }],
      [
        'traversal in extension',
        { ...ENTRY, extension: '/../../../../tmp/evil' },
      ],
      ['multi-dot extension', { ...ENTRY, extension: '.jpg/../x' }],
      ['dotless extension', { ...ENTRY, extension: 'jpg' }],
      ['non-string extension', { ...ENTRY, extension: 42 }],
      ['empty disclosure (D8 invariant)', { ...ENTRY, disclosure: '' }],
      ['missing disclosure', { ...ENTRY, disclosure: undefined }],
      [
        'oversized disclosure (prompt-stuffing channel)',
        { ...ENTRY, disclosure: 'x'.repeat(4096) },
      ],
      ['empty mimeType', { ...ENTRY, mimeType: '' }],
      ['missing mimeType', { ...ENTRY, mimeType: undefined }],
      ['empty role', { ...ENTRY, role: '' }],
      ['non-string role', { ...ENTRY, role: 42 }],
    ])(
      'drops a malformed entry instead of serving it: %s',
      async (_label, entry) => {
        await plantEntries(entry);
        await expect(cache.get(ORIGINAL, fp)).resolves.toBeNull();
        // Self-heal: the malformed entry is deleted, so the next transcode's
        // put() rebuilds it from verified data.
        expect((await readCacheFile()).entries).toEqual({});
      },
    );

    it('still serves a planted entry when every field is well-formed', async () => {
      await plantEntries({ ...ENTRY, createdAt: new Date().toISOString() });
      await expect(cache.get(ORIGINAL, fp)).resolves.toMatchObject(ENTRY);
    });

    it.each([
      ['null', null],
      ['string', 'x'],
      ['number', 42],
      ['array', [1, 2]],
    ])(
      'drops a non-object entry VALUE at load instead of throwing: %s',
      async (_label, value) => {
        // Value-level shape is validated at load (shared cache-file layer):
        // a crafted value like `null` must not surface as TypeErrors from
        // field accessors — including scans like removeByDegradedSha256
        // that touch EVERY entry, not just the requested key.
        await plantEntries(value, { other: ENTRY });
        await expect(cache.get(ORIGINAL, fp)).resolves.toBeNull();
        await expect(
          cache.removeByDegradedSha256(ENTRY.degradedSha256),
        ).resolves.toBeUndefined();
      },
    );
  });
});
