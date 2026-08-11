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

const ENTRY = {
  degradedSha256: DEGRADED,
  extension: '.jpg',
  disclosure:
    '原 4096×3072/8.2MB → 1568×1176/0.9MB，质量 75，细节与文字锐度受损',
  mimeType: 'image/jpeg',
};

describe('computePolicyFingerprint', () => {
  it('is stable across key order and identical inputs', () => {
    const a = computePolicyFingerprint('omni_downsample_image', {
      maxDimension: 1568,
      quality: 75,
    });
    const b = computePolicyFingerprint('omni_downsample_image', {
      quality: 75,
      maxDimension: 1568,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores the per-invocation io params (inputPath/outputDir)', () => {
    const bare = computePolicyFingerprint('omni_downsample_image', {
      quality: 75,
    });
    const withIo = computePolicyFingerprint('omni_downsample_image', {
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
  const fp = computePolicyFingerprint('omni_downsample_image', {
    maxDimension: 1568,
    quality: 75,
  });

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
    const raw = JSON.parse(
      await fs.readFile(path.join(root, 'policy-cache.json'), 'utf8'),
    );
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.entries)).toEqual([`${ORIGINAL}|${fp}`]);
  });

  it('misses on a different fingerprint or original hash', async () => {
    await cache.put(ORIGINAL, fp, ENTRY);
    const otherFp = computePolicyFingerprint('omni_downsample_image', {
      maxDimension: 800,
    });
    await expect(cache.get(ORIGINAL, otherFp)).resolves.toBeNull();
    await expect(cache.get('c'.repeat(64), fp)).resolves.toBeNull();
  });

  it('re-put for the same key replaces the entry', async () => {
    await cache.put(ORIGINAL, fp, ENTRY);
    await cache.put(ORIGINAL, fp, {
      ...ENTRY,
      degradedSha256: 'd'.repeat(64),
    });
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
    const fp2 = computePolicyFingerprint('omni_downsample_image', {
      quality: 51,
    });
    await cache.put(ORIGINAL, fp2, ENTRY);
    const hit = await cache.get(ORIGINAL, fp2);
    expect(hit!.role).toBeUndefined();
  });

  it('removeByOriginalSha256 drops every policy result for the source', async () => {
    const fp2 = computePolicyFingerprint('omni_downsample_image', {
      quality: 50,
    });
    await cache.put(ORIGINAL, fp, ENTRY);
    await cache.put(ORIGINAL, fp2, ENTRY);
    await cache.put('c'.repeat(64), fp, ENTRY);

    await cache.removeByOriginalSha256(ORIGINAL);
    await expect(cache.get(ORIGINAL, fp)).resolves.toBeNull();
    await expect(cache.get(ORIGINAL, fp2)).resolves.toBeNull();
    await expect(cache.get('c'.repeat(64), fp)).resolves.not.toBeNull();
  });

  it('removeByDegradedSha256 drops every entry pointing at the derivative', async () => {
    await cache.put(ORIGINAL, fp, ENTRY);
    await cache.put('c'.repeat(64), fp, ENTRY);
    await cache.put('e'.repeat(64), fp, {
      ...ENTRY,
      degradedSha256: 'f'.repeat(64),
    });

    await cache.removeByDegradedSha256(DEGRADED);
    await expect(cache.get(ORIGINAL, fp)).resolves.toBeNull();
    await expect(cache.get('c'.repeat(64), fp)).resolves.toBeNull();
    await expect(cache.get('e'.repeat(64), fp)).resolves.not.toBeNull();
  });

  it('backs up a corrupt cache file and starts fresh (never fatal)', async () => {
    const filePath = path.join(root, 'policy-cache.json');
    await fs.writeFile(filePath, '{corrupt');
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
    expect(names.filter((n) => n.includes('.tmp-'))).toEqual([]);
    if (process.platform !== 'win32') {
      const stat = await fs.stat(path.join(root, 'policy-cache.json'));
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('serializes concurrent puts without losing entries', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        cache.put(ORIGINAL, computePolicyFingerprint('t', { i }), ENTRY),
      ),
    );
    const raw = JSON.parse(
      await fs.readFile(path.join(root, 'policy-cache.json'), 'utf8'),
    );
    expect(Object.keys(raw.entries)).toHaveLength(8);
  });

  describe('poisoned cache file (workspace-controlled input is shape-validated)', () => {
    /** Plant one raw entry as a hostile repo could ship it. */
    async function plantEntry(entry: Record<string, unknown>): Promise<void> {
      await fs.writeFile(
        path.join(root, 'policy-cache.json'),
        JSON.stringify({
          version: 1,
          entries: { [`${ORIGINAL}|${fp}`]: entry },
        }),
      );
    }

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
      ['empty mimeType', { ...ENTRY, mimeType: '' }],
      ['missing mimeType', { ...ENTRY, mimeType: undefined }],
      ['empty role', { ...ENTRY, role: '' }],
      ['non-string role', { ...ENTRY, role: 42 }],
    ])(
      'drops a malformed entry instead of serving it: %s',
      async (_label, entry) => {
        await plantEntry(entry as Record<string, unknown>);
        await expect(cache.get(ORIGINAL, fp)).resolves.toBeNull();
        // Self-heal: the malformed entry is deleted, so the next transcode's
        // put() rebuilds it from verified data.
        const raw = JSON.parse(
          await fs.readFile(path.join(root, 'policy-cache.json'), 'utf8'),
        );
        expect(raw.entries).toEqual({});
      },
    );

    it('still serves a planted entry when every field is well-formed', async () => {
      await plantEntry({ ...ENTRY, createdAt: new Date().toISOString() });
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
        await fs.writeFile(
          path.join(root, 'policy-cache.json'),
          JSON.stringify({
            version: 1,
            entries: { [`${ORIGINAL}|${fp}`]: value, other: ENTRY },
          }),
        );
        await expect(cache.get(ORIGINAL, fp)).resolves.toBeNull();
        await expect(
          cache.removeByDegradedSha256(ENTRY.degradedSha256),
        ).resolves.toBeUndefined();
      },
    );
  });
});
