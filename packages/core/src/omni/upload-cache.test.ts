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
  // Restore permissions first so cleanup can proceed after chmod tests.
  await fs.chmod(root, 0o700).catch(() => {});
  await fs.chmod(path.join(root, 'upload-cache.json'), 0o600).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
});

const SHA = 'a'.repeat(64);

// chmod-based denial tests are meaningless on Windows and as root (root
// bypasses file permission bits).
const canDropPermissions =
  process.platform !== 'win32' &&
  (typeof process.getuid !== 'function' || process.getuid() !== 0);

async function listCorruptBackups(): Promise<string[]> {
  return (await fs.readdir(root)).filter((n) =>
    n.startsWith('upload-cache.json.corrupt-'),
  );
}

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

  it('replaces a symlink at the cache path instead of writing through it', async () => {
    // A link planted at the cache path (same-UID malware, dotfile
    // managers) must never redirect the save onto its target: the atomic
    // rename replaces the link itself, leaving the victim file untouched.
    // The target holds VALID cache JSON so the operation takes the normal
    // load→save path (invalid content would divert into corrupt-backup,
    // which renames the link away before any write).
    const victimContent = JSON.stringify({ version: 1, entries: {} });
    const victim = path.join(root, 'victim.txt');
    await fs.writeFile(victim, victimContent, { mode: 0o644 });
    const cachePath = path.join(root, 'upload-cache.json');
    await fs.symlink(victim, cachePath);

    const cache = new OmniUploadCache(root);
    await cache.put(SHA, 'm', 'oss://bucket/x');

    expect(await fs.readFile(victim, 'utf8')).toBe(victimContent);
    const st = await fs.lstat(cachePath);
    expect(st.isSymbolicLink()).toBe(false);
    expect(await cache.get(SHA, 'm')).toBe('oss://bucket/x');
  });

  it('keys by scope — a different scope is a miss, same scope hits', async () => {
    const cacheA = new OmniUploadCache(root, 47, 'scope-a');
    const cacheB = new OmniUploadCache(root, 47, 'scope-b');
    await cacheA.put(SHA, 'm', 'oss://bucket/a');
    expect(await cacheB.get(SHA, 'm')).toBeNull();
    // A separate instance with the SAME scope shares the entry.
    const cacheA2 = new OmniUploadCache(root, 47, 'scope-a');
    expect(await cacheA2.get(SHA, 'm')).toBe('oss://bucket/a');
  });

  it('expired entries are misses and are pruned lazily', async () => {
    const cache = new OmniUploadCache(root);
    await cache.put(SHA, 'm', 'oss://bucket/x');
    // Rewrite the file with an expired timestamp.
    const file = path.join(root, 'upload-cache.json');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.entries[`${SHA}|m|`].expiresAt = new Date(
      Date.now() - 1000,
    ).toISOString();
    await fs.writeFile(file, JSON.stringify(data));

    expect(await cache.get(SHA, 'm')).toBeNull();
    const after = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(after.entries[`${SHA}|m|`]).toBeUndefined(); // pruned
  });

  it('findSha256ByUrl reverse-maps a delivered URL to its object hash', async () => {
    const cache = new OmniUploadCache(root, 47, 'scope-a');
    await cache.put(SHA, 'm1', 'oss://bucket/key1');
    await cache.put('b'.repeat(64), 'm1', 'oss://bucket/key2');
    expect(await cache.findSha256ByUrl('oss://bucket/key1')).toBe(SHA);
    expect(await cache.findSha256ByUrl('oss://bucket/key2')).toBe(
      'b'.repeat(64),
    );
    expect(await cache.findSha256ByUrl('oss://bucket/unknown')).toBeNull();
    // Scope-agnostic like invalidateByUrl: the caller knows only the URL.
    const otherScope = new OmniUploadCache(root, 47, 'scope-b');
    expect(await otherScope.findSha256ByUrl('oss://bucket/key1')).toBe(SHA);
  });

  it('findSha256ByUrl still resolves expired entries (the URL was just sent)', async () => {
    const cache = new OmniUploadCache(root);
    await cache.put(SHA, 'm', 'oss://bucket/old');
    const file = path.join(root, 'upload-cache.json');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const entry of Object.values(data.entries) as Array<{
      expiresAt: string;
    }>) {
      entry.expiresAt = new Date(Date.now() - 1000).toISOString();
    }
    await fs.writeFile(file, JSON.stringify(data));
    expect(await cache.findSha256ByUrl('oss://bucket/old')).toBe(SHA);
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

  it('invalidateByUrl works even with ttlHours 0 (clears pre-disable entries)', async () => {
    // Entries persisted while the cache was enabled…
    const enabled = new OmniUploadCache(root);
    await enabled.put(SHA, 'm', 'oss://bucket/stale');
    // …must still be clearable after the user disables the cache: the
    // server-side invalidation cascade may run for ttl-0 users too.
    const disabled = new OmniUploadCache(root, 0);
    await disabled.invalidateByUrl('oss://bucket/stale');
    expect(await enabled.get(SHA, 'm')).toBeNull();
  });

  it('removeBySha256 cascades all models for the object', async () => {
    const cache = new OmniUploadCache(root);
    await cache.put(SHA, 'm1', 'oss://bucket/1');
    await cache.put(SHA, 'm2', 'oss://bucket/2');
    await cache.removeBySha256(SHA);
    expect(await cache.get(SHA, 'm1')).toBeNull();
    expect(await cache.get(SHA, 'm2')).toBeNull();
  });

  it('removeBySha256 cascades across scopes (corrupt object is corrupt everywhere)', async () => {
    const cacheA = new OmniUploadCache(root, 47, 'scope-a');
    const cacheB = new OmniUploadCache(root, 47, 'scope-b');
    await cacheA.put(SHA, 'm', 'oss://bucket/a');
    await cacheB.put(SHA, 'm', 'oss://bucket/b');
    await cacheA.removeBySha256(SHA);
    expect(await cacheA.get(SHA, 'm')).toBeNull();
    expect(await cacheB.get(SHA, 'm')).toBeNull();
  });

  it('backs up a corrupt cache file and starts fresh', async () => {
    const file = path.join(root, 'upload-cache.json');
    await fs.writeFile(file, 'not json at all {{{');
    const cache = new OmniUploadCache(root);
    expect(await cache.get(SHA, 'm')).toBeNull();
    await cache.put(SHA, 'm', 'oss://bucket/fresh');
    expect(await cache.get(SHA, 'm')).toBe('oss://bucket/fresh');
    expect(await listCorruptBackups()).not.toHaveLength(0);
  });

  it('treats entries: null as corrupt (backup + rebuild, no TypeError)', async () => {
    const file = path.join(root, 'upload-cache.json');
    await fs.writeFile(file, '{"version":1,"entries":null}');
    const cache = new OmniUploadCache(root);
    expect(await cache.get(SHA, 'm')).toBeNull();
    expect(await listCorruptBackups()).not.toHaveLength(0);
  });

  it('treats entries as array as corrupt (backup + rebuild)', async () => {
    const file = path.join(root, 'upload-cache.json');
    await fs.writeFile(file, '{"version":1,"entries":[]}');
    const cache = new OmniUploadCache(root);
    expect(await cache.get(SHA, 'm')).toBeNull();
    expect(await listCorruptBackups()).not.toHaveLength(0);
  });

  it('keeps at most 2 .corrupt-* backups', async () => {
    const file = path.join(root, 'upload-cache.json');
    const cache = new OmniUploadCache(root);
    for (let i = 0; i < 3; i++) {
      await fs.writeFile(file, `corrupt #${i} {{{`);
      expect(await cache.get(SHA, 'm')).toBeNull();
      // Backup names are Date.now()-stamped; keep them distinct.
      await new Promise((r) => setTimeout(r, 5));
    }
    const backups = await listCorruptBackups();
    expect(backups.length).toBeGreaterThan(0);
    expect(backups.length).toBeLessThanOrEqual(2);
  });

  it.runIf(canDropPermissions)(
    'a transient read failure must not wipe previously persisted entries',
    async () => {
      const cache = new OmniUploadCache(root);
      await cache.put(SHA, 'm', 'oss://bucket/precious');
      const file = path.join(root, 'upload-cache.json');
      const before = await fs.readFile(file, 'utf8');

      await fs.chmod(file, 0o000); // simulate EACCES on read
      // put must become a no-op (NOT "empty cache + save one entry").
      await cache.put('b'.repeat(64), 'm', 'oss://bucket/new');
      // get during the failure window is a miss, not a throw.
      expect(await cache.get(SHA, 'm')).toBeNull();
      await fs.chmod(file, 0o600);

      // Original entries survived untouched.
      expect(await fs.readFile(file, 'utf8')).toBe(before);
      expect(await cache.get(SHA, 'm')).toBe('oss://bucket/precious');
      expect(await cache.get('b'.repeat(64), 'm')).toBeNull();
    },
  );

  it('treats malformed expiresAt as expired (never immortal)', async () => {
    const cache = new OmniUploadCache(root);
    await cache.put(SHA, 'm', 'oss://bucket/x');
    const file = path.join(root, 'upload-cache.json');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.entries[`${SHA}|m|`].expiresAt = 'not-a-date';
    await fs.writeFile(file, JSON.stringify(data));
    expect(await cache.get(SHA, 'm')).toBeNull();
  });

  it('put() sweeps ALL expired entries, not just the written key', async () => {
    const cache = new OmniUploadCache(root);
    const deadSha = 'b'.repeat(64);
    const malformedSha = 'c'.repeat(64);
    const liveSha = 'd'.repeat(64);
    await cache.put(deadSha, 'm', 'oss://bucket/dead');
    await cache.put(malformedSha, 'm', 'oss://bucket/malformed');
    await cache.put(liveSha, 'm', 'oss://bucket/live');
    // Force-expire one entry and corrupt another's timestamp — neither
    // key is ever read again, so only a wholesale sweep can remove them.
    const file = path.join(root, 'upload-cache.json');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.entries[`${deadSha}|m|`].expiresAt = new Date(
      Date.now() - 1000,
    ).toISOString();
    data.entries[`${malformedSha}|m|`].expiresAt = 'not-a-date';
    await fs.writeFile(file, JSON.stringify(data));

    // A put of a DIFFERENT key must evict both stale entries.
    await cache.put(SHA, 'm', 'oss://bucket/fresh');

    const after = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(after.entries[`${deadSha}|m|`]).toBeUndefined();
    expect(after.entries[`${malformedSha}|m|`]).toBeUndefined();
    // Live neighbors and the fresh write survive.
    expect(after.entries[`${liveSha}|m|`]).toBeDefined();
    expect(after.entries[`${SHA}|m|`]).toBeDefined();
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

  it('serializes concurrent puts ACROSS instances on the same root', async () => {
    // Cache instances are constructed per delivery; the serializer must
    // live at file scope, not instance scope, or concurrent deliveries
    // would drop each other's entries via load-modify-save races.
    const cache1 = new OmniUploadCache(root);
    const cache2 = new OmniUploadCache(root);
    await Promise.all([
      cache1.put('a'.repeat(64), 'm', 'oss://bucket/a'),
      cache2.put('b'.repeat(64), 'm', 'oss://bucket/b'),
      cache1.put('c'.repeat(64), 'm', 'oss://bucket/c'),
      cache2.put('d'.repeat(64), 'm', 'oss://bucket/d'),
    ]);
    const check = new OmniUploadCache(root);
    expect(await check.get('a'.repeat(64), 'm')).toBe('oss://bucket/a');
    expect(await check.get('b'.repeat(64), 'm')).toBe('oss://bucket/b');
    expect(await check.get('c'.repeat(64), 'm')).toBe('oss://bucket/c');
    expect(await check.get('d'.repeat(64), 'm')).toBe('oss://bucket/d');
  });

  it('re-put of the same (sha, model, scope) refreshes the URL', async () => {
    const cache = new OmniUploadCache(root, 47, 's');
    await cache.put(SHA, 'm', 'oss://bucket/old');
    await cache.put(SHA, 'm', 'oss://bucket/new');
    expect(await cache.get(SHA, 'm')).toBe('oss://bucket/new');
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

  it('negative ttl also disables the cache', async () => {
    const cache = new OmniUploadCache(root, -5);
    expect(cache.enabled).toBe(false);
    await cache.put(SHA, 'm', 'oss://bucket/x');
    expect(await cache.get(SHA, 'm')).toBeNull();
  });

  it('clamps a configured ttl above 48h to 48h (server URL lifetime)', async () => {
    const cache = new OmniUploadCache(root, 168);
    expect(cache.enabled).toBe(true);
    await cache.put(SHA, 'm', 'oss://bucket/x');
    const data = JSON.parse(
      await fs.readFile(path.join(root, 'upload-cache.json'), 'utf8'),
    );
    const entry = data.entries[`${SHA}|m|`];
    const lifetimeMs =
      Date.parse(entry.expiresAt) - Date.parse(entry.uploadedAt);
    expect(lifetimeMs).toBe(48 * 3600_000);
  });

  it('writes atomically: no .tmp litter, 0600 file mode', async () => {
    const cache = new OmniUploadCache(root);
    await cache.put('a'.repeat(64), 'm', 'oss://bucket/a');
    await cache.put('b'.repeat(64), 'm', 'oss://bucket/b');
    await cache.put('c'.repeat(64), 'm', 'oss://bucket/c');
    const names = await fs.readdir(root);
    expect(names).toEqual(['upload-cache.json']);
    if (process.platform !== 'win32') {
      const st = await fs.stat(path.join(root, 'upload-cache.json'));
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  it.runIf(canDropPermissions)(
    'save failure leaves the previous file intact and no .tmp litter',
    async () => {
      const cache = new OmniUploadCache(root);
      await cache.put(SHA, 'm', 'oss://bucket/original');
      const file = path.join(root, 'upload-cache.json');
      const before = await fs.readFile(file, 'utf8');

      await fs.chmod(root, 0o500); // dir readable but not writable
      // Must resolve (best-effort persistence), not throw.
      await cache.put('b'.repeat(64), 'm', 'oss://bucket/lost');
      await fs.chmod(root, 0o700);

      // A direct write to filePath (skipping tmp+rename) would have
      // either partially clobbered or emptied the file; the previous
      // content must be byte-identical.
      expect(await fs.readFile(file, 'utf8')).toBe(before);
      const names = await fs.readdir(root);
      expect(names.filter((n) => n.includes('.tmp-'))).toEqual([]);
      expect(await cache.get(SHA, 'm')).toBe('oss://bucket/original');
    },
  );
});
