/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stats } from 'node:fs';
import { FileReadCache } from './fileReadCache.js';

/**
 * Build a Stats-shaped object with the fields the cache actually reads.
 * Avoids hitting the filesystem in the bulk of unit tests.
 */
function makeStats(overrides: Partial<Stats> = {}): Stats {
  const base = {
    dev: 1,
    ino: 100,
    mtimeMs: 1_000_000,
    size: 42,
  };
  return { ...base, ...overrides } as Stats;
}

describe('FileReadCache', () => {
  describe('inodeKey', () => {
    it('combines dev and ino into a stable string', () => {
      expect(FileReadCache.inodeKey(makeStats({ dev: 7, ino: 99 }))).toBe(
        '7:99',
      );
    });

    it('treats different (dev, ino) as different keys', () => {
      const a = FileReadCache.inodeKey(makeStats({ dev: 1, ino: 2 }));
      const b = FileReadCache.inodeKey(makeStats({ dev: 2, ino: 1 }));
      expect(a).not.toBe(b);
    });
  });

  describe('check', () => {
    it('returns unknown for a never-seen file', () => {
      const cache = new FileReadCache();
      expect(cache.check(makeStats()).state).toBe('unknown');
    });

    it('returns fresh after a recordRead with matching stats', () => {
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: true });
      expect(cache.check(stats).state).toBe('fresh');
    });

    it('returns stale when mtime differs', () => {
      const cache = new FileReadCache();
      cache.recordRead('/x/foo.ts', makeStats({ mtimeMs: 1000 }), {
        full: true,
        cacheable: true,
      });
      const result = cache.check(makeStats({ mtimeMs: 2000 }));
      expect(result.state).toBe('stale');
    });

    it('returns stale when size differs', () => {
      const cache = new FileReadCache();
      cache.recordRead('/x/foo.ts', makeStats({ size: 100 }), {
        full: true,
        cacheable: true,
      });
      const result = cache.check(makeStats({ size: 200 }));
      expect(result.state).toBe('stale');
    });

    it('returns unknown — not stale — when only the inode differs', () => {
      // rm + recreate scenario: same path, brand-new inode. The cache is
      // keyed by inode, so the new file is genuinely a stranger. Edit /
      // WriteFile callers will treat this as "must read first", which is
      // the safer semantics than "stale" (which implies "you knew an
      // earlier version of this exact file").
      const cache = new FileReadCache();
      cache.recordRead('/x/foo.ts', makeStats({ ino: 100 }), {
        full: true,
        cacheable: true,
      });
      expect(cache.check(makeStats({ ino: 200 })).state).toBe('unknown');
    });

    it('attaches the entry on fresh and stale results', () => {
      const cache = new FileReadCache();
      cache.recordRead('/x/foo.ts', makeStats(), {
        full: true,
        cacheable: true,
      });
      const fresh = cache.check(makeStats());
      expect(fresh.state).toBe('fresh');
      if (fresh.state === 'fresh') {
        expect(fresh.entry.realPath).toBe('/x/foo.ts');
      }

      const stale = cache.check(makeStats({ size: 999 }));
      expect(stale.state).toBe('stale');
      if (stale.state === 'stale') {
        expect(stale.entry.realPath).toBe('/x/foo.ts');
      }
    });
  });

  describe('recordRead', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-29T00:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('sets lastReadAt to the current time', () => {
      const cache = new FileReadCache();
      const entry = cache.recordRead('/x/foo.ts', makeStats(), {
        full: true,
        cacheable: true,
      });
      expect(entry.lastReadAt).toBe(Date.now());
    });

    it('preserves full vs ranged read distinction', () => {
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: false, cacheable: true });
      const result = cache.check(stats);
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        expect(result.entry.lastReadWasFull).toBe(false);
      }
    });

    it('overwrites earlier lastReadWasFull on subsequent reads', () => {
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: true });
      cache.recordRead('/x/foo.ts', stats, { full: false, cacheable: true });
      const result = cache.check(stats);
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        expect(result.entry.lastReadWasFull).toBe(false);
      }
    });

    it('does not set lastWriteAt', () => {
      const cache = new FileReadCache();
      const entry = cache.recordRead('/x/foo.ts', makeStats(), {
        full: true,
        cacheable: true,
      });
      expect(entry.lastWriteAt).toBeUndefined();
    });

    it('records cacheable=false for non-text reads (image / pdf / notebook)', () => {
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/img.png', stats, { full: true, cacheable: false });
      const result = cache.check(stats);
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        expect(result.entry.lastReadCacheable).toBe(false);
      }
    });

    it('flips cacheable to true on a subsequent text read of the same inode', () => {
      // Pathological-but-possible: file was first read as PDF base64, then
      // its bytes were rewritten to plain text and re-Read (the rewrite
      // path goes through stale → fresh via a new recordRead). Verify the
      // cacheable flag tracks the most recent Read, not a previous one.
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/file', stats, { full: true, cacheable: false });
      cache.recordRead('/x/file', stats, { full: true, cacheable: true });
      const result = cache.check(stats);
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        expect(result.entry.lastReadCacheable).toBe(true);
      }
    });

    it('updates realPath when the same inode is recorded under a different path', () => {
      // e.g. the file was first read via a symlink, then via its real path.
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/symlink.ts', stats, { full: true, cacheable: true });
      cache.recordRead('/x/real.ts', stats, { full: true, cacheable: true });
      const result = cache.check(stats);
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        expect(result.entry.realPath).toBe('/x/real.ts');
      }
    });
  });

  describe('recordWrite', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-29T00:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('sets lastWriteAt to the current time', () => {
      const cache = new FileReadCache();
      const entry = cache.recordWrite('/x/foo.ts', makeStats());
      expect(entry.lastWriteAt).toBe(Date.now());
    });

    it('does not set lastReadAt or flip lastReadWasFull', () => {
      const cache = new FileReadCache();
      const entry = cache.recordWrite('/x/foo.ts', makeStats());
      expect(entry.lastReadAt).toBeUndefined();
      expect(entry.lastReadWasFull).toBe(false);
    });

    it('refreshes mtime+size so a follow-up Edit sees fresh', () => {
      // Without this refresh the second Edit in a chain would see the
      // post-write mtime as "stale" against the pre-write fingerprint,
      // and reject its own caller's previous edit. Regression guard.
      const cache = new FileReadCache();
      cache.recordRead('/x/foo.ts', makeStats({ mtimeMs: 1000, size: 10 }), {
        full: true,
        cacheable: true,
      });
      cache.recordWrite('/x/foo.ts', makeStats({ mtimeMs: 2000, size: 20 }));
      expect(cache.check(makeStats({ mtimeMs: 2000, size: 20 })).state).toBe(
        'fresh',
      );
    });

    it('preserves lastReadAt set by an earlier recordRead', () => {
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: true });
      const readTime = Date.now();
      vi.advanceTimersByTime(5_000);
      const entry = cache.recordWrite(
        '/x/foo.ts',
        makeStats({ mtimeMs: 9999 }),
      );
      expect(entry.lastReadAt).toBe(readTime);
      expect(entry.lastWriteAt).toBeGreaterThan(readTime);
    });
  });

  describe('read-then-write-then-read ordering', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-29T00:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('records lastWriteAt > lastReadAt after Read → Write', () => {
      // PR2 will use this ordering to decide whether a Read can return a
      // file_unchanged placeholder. Verifying the timestamps move
      // monotonically here gives that downstream logic a stable contract.
      const cache = new FileReadCache();
      cache.recordRead('/x/foo.ts', makeStats({ mtimeMs: 1000 }), {
        full: true,
        cacheable: true,
      });
      vi.advanceTimersByTime(1);
      cache.recordWrite('/x/foo.ts', makeStats({ mtimeMs: 2000 }));
      const result = cache.check(makeStats({ mtimeMs: 2000 }));
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        const { lastReadAt, lastWriteAt } = result.entry;
        expect(lastReadAt).toBeDefined();
        expect(lastWriteAt).toBeDefined();
        expect(lastWriteAt!).toBeGreaterThan(lastReadAt!);
      }
    });

    it('records lastReadAt > lastWriteAt after Read → Write → Read', () => {
      const cache = new FileReadCache();
      cache.recordRead('/x/foo.ts', makeStats({ mtimeMs: 1000 }), {
        full: true,
        cacheable: true,
      });
      vi.advanceTimersByTime(1);
      cache.recordWrite('/x/foo.ts', makeStats({ mtimeMs: 2000 }));
      vi.advanceTimersByTime(1);
      cache.recordRead('/x/foo.ts', makeStats({ mtimeMs: 2000 }), {
        full: true,
        cacheable: true,
      });
      const result = cache.check(makeStats({ mtimeMs: 2000 }));
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        const { lastReadAt, lastWriteAt } = result.entry;
        expect(lastReadAt!).toBeGreaterThan(lastWriteAt!);
      }
    });
  });

  describe('isolation between files', () => {
    it('keeps unrelated entries independent', () => {
      const cache = new FileReadCache();
      const a = makeStats({ ino: 1 });
      const b = makeStats({ ino: 2 });
      cache.recordRead('/x/a.ts', a, { full: true, cacheable: true });
      expect(cache.check(b).state).toBe('unknown');
      cache.recordRead('/x/b.ts', b, { full: true, cacheable: true });
      expect(cache.check(a).state).toBe('fresh');
      expect(cache.check(b).state).toBe('fresh');
    });

    it('treats same ino across different devs as separate files', () => {
      const cache = new FileReadCache();
      cache.recordRead('/x/a', makeStats({ dev: 1, ino: 5 }), {
        full: true,
        cacheable: true,
      });
      expect(cache.check(makeStats({ dev: 2, ino: 5 })).state).toBe('unknown');
    });
  });

  describe('invalidate / clear / size', () => {
    it('size reflects the count of tracked entries', () => {
      const cache = new FileReadCache();
      expect(cache.size()).toBe(0);
      cache.recordRead('/x/a', makeStats({ ino: 1 }), {
        full: true,
        cacheable: true,
      });
      cache.recordRead('/x/b', makeStats({ ino: 2 }), {
        full: true,
        cacheable: true,
      });
      expect(cache.size()).toBe(2);
    });

    it('invalidate removes the entry for the given Stats', () => {
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/a', stats, { full: true, cacheable: true });
      cache.invalidate(stats);
      expect(cache.check(stats).state).toBe('unknown');
      expect(cache.size()).toBe(0);
    });

    it('invalidate is a no-op for entries that were never recorded', () => {
      const cache = new FileReadCache();
      expect(() => cache.invalidate(makeStats())).not.toThrow();
      expect(cache.size()).toBe(0);
    });

    it('clear drops every entry', () => {
      const cache = new FileReadCache();
      cache.recordRead('/x/a', makeStats({ ino: 1 }), {
        full: true,
        cacheable: true,
      });
      cache.recordRead('/x/b', makeStats({ ino: 2 }), {
        full: true,
        cacheable: true,
      });
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.check(makeStats({ ino: 1 })).state).toBe('unknown');
    });
  });

  describe('with real filesystem stats', () => {
    // One end-to-end check that dev+ino keying actually works against
    // node:fs.statSync. The bulk of the suite uses synthetic Stats; this
    // is a sanity guard against accidentally relying on a field that
    // isn't populated on real platforms.
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frc-'));
    });
    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('treats two paths sharing one inode (hardlink) as the same entry', () => {
      const original = path.join(tmpDir, 'original.txt');
      const link = path.join(tmpDir, 'link.txt');
      fs.writeFileSync(original, 'hello');
      fs.linkSync(original, link);

      const cache = new FileReadCache();
      cache.recordRead(original, fs.statSync(original), {
        full: true,
        cacheable: true,
      });
      // Same inode reached via a different path — must hit the same entry.
      expect(cache.check(fs.statSync(link)).state).toBe('fresh');
    });

    it('detects external modification as stale', () => {
      const file = path.join(tmpDir, 'mut.txt');
      fs.writeFileSync(file, 'one');
      const cache = new FileReadCache();
      cache.recordRead(file, fs.statSync(file), {
        full: true,
        cacheable: true,
      });

      // Bump mtime explicitly; on some filesystems a same-second rewrite
      // would not change mtime, which would mask the test.
      const future = new Date(Date.now() + 60_000);
      fs.writeFileSync(file, 'one-plus-more');
      fs.utimesSync(file, future, future);

      expect(cache.check(fs.statSync(file)).state).toBe('stale');
    });
  });
});
