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
import { FileReadCache, type FileReadEntry } from './fileReadCache.js';

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

/** Fake timers pinned to a fixed instant for the enclosing describe. */
function useFixedClock() {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
}

describe('FileReadCache', () => {
  let cache: FileReadCache;
  beforeEach(() => {
    cache = new FileReadCache();
  });
  const read = (
    absPath: string,
    stats: Stats,
    opts = { full: true, cacheable: true },
  ) => cache.recordRead(absPath, stats, opts);
  // Full reads of `/x/<prefix>-<i>.ts` at ino i for i in [from, to].
  const readRange = (prefix: string, from: number, to: number) => {
    for (let i = from; i <= to; i++) {
      read(`/x/${prefix}-${i}.ts`, makeStats({ ino: i }));
    }
  };
  // Asserts `stats` checks as `state` and returns the attached entry.
  function entryWhen(state: 'fresh' | 'stale', stats: Stats): FileReadEntry {
    const result = cache.check(stats);
    expect(result.state).toBe(state);
    return (result as { entry: FileReadEntry }).entry;
  }
  const fresh = (stats: Stats) => entryWhen('fresh', stats);

  it('drops local entries without advancing history invalidation generation', () => {
    const stats = makeStats();
    read('/file', stats);
    const generation = cache.getClearGeneration();
    cache.dropEntries();
    expect(cache.check(stats).state).toBe('unknown');
    expect(cache.getClearGeneration()).toBe(generation);
    cache.clear();
    expect(cache.getClearGeneration()).toBe(generation + 1);
  });

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

    it('treats ino 0 as unverifiable identity', () => {
      expect(FileReadCache.hasVerifiableIdentity(makeStats({ ino: 0 }))).toBe(
        false,
      );
      expect(FileReadCache.hasVerifiableIdentity(makeStats({ ino: 1 }))).toBe(
        true,
      );
    });

    it('treats a bigint ino 0 as unverifiable identity', () => {
      // `stat(..., { bigint: true })` is used elsewhere in the repo, and
      // `0n !== 0` is true, so the check must not be a raw `!==`.
      const bigintStats = makeStats({
        ino: 0n as unknown as number,
      });
      expect(FileReadCache.hasVerifiableIdentity(bigintStats)).toBe(false);
    });
  });

  describe('check', () => {
    it('returns unknown for a never-seen file', () => {
      expect(cache.check(makeStats()).state).toBe('unknown');
    });

    it('returns fresh after a recordRead with matching stats', () => {
      const stats = makeStats();
      read('/x/foo.ts', stats);
      expect(cache.check(stats).state).toBe('fresh');
    });

    it('returns stale when mtime differs', () => {
      read('/x/foo.ts', makeStats({ mtimeMs: 1000 }));
      expect(cache.check(makeStats({ mtimeMs: 2000 })).state).toBe('stale');
    });

    it('returns stale when size differs', () => {
      read('/x/foo.ts', makeStats({ size: 100 }));
      expect(cache.check(makeStats({ size: 200 })).state).toBe('stale');
    });

    it('returns unknown — not stale — when only the inode differs', () => {
      // rm + recreate: same path, brand-new inode. The cache is keyed by
      // inode, so the new file is a stranger; Edit / WriteFile callers treat
      // this as "must read first", safer than "stale" (which implies "you
      // knew an earlier version of this exact file").
      read('/x/foo.ts', makeStats({ ino: 100 }));
      expect(cache.check(makeStats({ ino: 200 })).state).toBe('unknown');
    });

    it('returns unverifiable for ino 0 even after a read was recorded', () => {
      const stats = makeStats({ dev: 7, ino: 0 });
      const entry = read('/x/foo.ts', stats);

      expect(entry.inodeKey).toBe('7:0');
      expect(cache.size()).toBe(0);
      expect(cache.check(stats).state).toBe('unverifiable');
    });

    it('attaches the entry on fresh and stale results', () => {
      read('/x/foo.ts', makeStats());
      expect(fresh(makeStats()).realPath).toBe('/x/foo.ts');
      expect(entryWhen('stale', makeStats({ size: 999 })).realPath).toBe(
        '/x/foo.ts',
      );
    });
  });

  describe('recordRead', () => {
    useFixedClock();

    it('sets lastReadAt to the current time', () => {
      expect(read('/x/foo.ts', makeStats()).lastReadAt).toBe(Date.now());
    });

    it('does not let ino 0 reads collide across paths', () => {
      const first = makeStats({ dev: 9, ino: 0, size: 10 });
      const second = makeStats({ dev: 9, ino: 0, size: 20 });

      read('/x/a.ts', first);
      read('/x/b.ts', second);

      expect(cache.size()).toBe(0);
      expect(cache.check(first).state).toBe('unverifiable');
      expect(cache.check(second).state).toBe('unverifiable');
    });

    it('returns a detached entry for an ino 0 read', () => {
      const stats = makeStats({ dev: 9, ino: 0 });
      read('/x/a.ts', stats).readResidentInHistory = true;

      expect(cache.size()).toBe(0);
      expect(cache.check(stats).state).toBe('unverifiable');
    });

    it('preserves full vs ranged read distinction', () => {
      const stats = makeStats();
      read('/x/foo.ts', stats, { full: false, cacheable: true });
      expect(fresh(stats).lastReadWasFull).toBe(false);
    });

    it('preserves earlier lastReadWasFull on a subsequent partial read (sticky-on-true)', () => {
      // Prior-read enforcement asks "has the model seen these bytes (or
      // fully authored them)?"; after a full read, an offset/limit read must
      // not revoke the right to mutate. Pre-fix this caused the
      // `WriteFile(create) → ReadFile(offset/limit) → Edit` regression
      // flagged by the maintainer review.
      const stats = makeStats();
      read('/x/foo.ts', stats);
      read('/x/foo.ts', stats, { full: false, cacheable: true });
      expect(fresh(stats).lastReadWasFull).toBe(true);
    });

    it('does NOT preserve lastReadWasFull when a drifted (mutated) fingerprint arrives', () => {
      // Maintainer-review regression: T0 full read at fingerprint X → T1
      // external write advances on-disk to Y → T2 partial read at Y.
      // Sticky-on-true kept lastReadWasFull=true from T0 though it described
      // different bytes, so a follow-up Edit ran against bytes the model had
      // only seen the first 10 lines of.
      read('/x/foo.ts', makeStats({ mtimeMs: 1000, size: 100 }));
      // Drift: external write advances mtime+size.
      read('/x/foo.ts', makeStats({ mtimeMs: 2000, size: 200 }), {
        full: false,
        cacheable: true,
      });
      // Reset to this read's actual shape, not sticky-on-true from the
      // prior full read of different bytes.
      expect(
        fresh(makeStats({ mtimeMs: 2000, size: 200 })).lastReadWasFull,
      ).toBe(false);
    });

    it('preserves earlier lastReadCacheable on a subsequent non-cacheable read', () => {
      // Symmetric to lastReadWasFull: a model that read a file as text and
      // later as a structured payload (image, PDF, etc.; uncommon for one
      // inode) keeps the right to edit the bytes it saw as text.
      const stats = makeStats();
      read('/x/foo.ts', stats);
      read('/x/foo.ts', stats, { full: true, cacheable: false });
      expect(fresh(stats).lastReadCacheable).toBe(true);
    });

    it('does not set lastWriteAt', () => {
      expect(read('/x/foo.ts', makeStats()).lastWriteAt).toBeUndefined();
    });

    it('records cacheable=false for non-text reads (image / pdf / notebook)', () => {
      const stats = makeStats();
      read('/x/img.png', stats, { full: true, cacheable: false });
      expect(fresh(stats).lastReadCacheable).toBe(false);
    });

    it('flips cacheable to true on a subsequent text read of the same inode', () => {
      // Pathological-but-possible: first read as PDF base64, then rewritten
      // to plain text and re-Read (stale → fresh via a new recordRead). The
      // cacheable flag must track the most recent Read.
      const stats = makeStats();
      read('/x/file', stats, { full: true, cacheable: false });
      read('/x/file', stats);
      expect(fresh(stats).lastReadCacheable).toBe(true);
    });

    it('updates realPath when the same inode is recorded under a different path', () => {
      // e.g. the file was first read via a symlink, then via its real path.
      const stats = makeStats();
      read('/x/symlink.ts', stats);
      read('/x/real.ts', stats);
      expect(fresh(stats).realPath).toBe('/x/real.ts');
    });
  });

  describe('recordWrite', () => {
    useFixedClock();

    it('sets lastWriteAt to the current time', () => {
      const entry = cache.recordWrite('/x/foo.ts', makeStats());
      expect(entry.lastWriteAt).toBe(Date.now());
    });

    it('does not cache writes with ino 0', () => {
      const stats = makeStats({ dev: 7, ino: 0 });

      const entry = cache.recordWrite('/x/foo.ts', stats);

      expect(entry.lastWriteAt).toBe(Date.now());
      expect(cache.size()).toBe(0);
      expect(cache.check(stats).state).toBe('unverifiable');
    });

    it('seeds read metadata when recording a write on a brand-new entry', () => {
      // The model authored the bytes it just wrote, which counts as having
      // seen the full text for the *next* Edit's prior-read check. Without
      // this, a create→edit→edit chain would reject the second edit because
      // lastReadWasFull / lastReadCacheable were unset on the new entry.
      const entry = cache.recordWrite('/x/foo.ts', makeStats());
      expect(entry.lastReadAt).toBeDefined();
      expect(entry.lastReadAt).toBe(entry.lastWriteAt);
      expect(entry.lastReadWasFull).toBe(true);
      expect(entry.lastReadCacheable).toBe(true);
    });

    it('refreshes mtime+size so a follow-up Edit sees fresh', () => {
      // Regression guard: without the refresh, the second Edit in a chain
      // sees the post-write mtime as "stale" against the pre-write
      // fingerprint and rejects its own caller's previous edit.
      read('/x/foo.ts', makeStats({ mtimeMs: 1000, size: 10 }));
      cache.recordWrite('/x/foo.ts', makeStats({ mtimeMs: 2000, size: 20 }));
      expect(cache.check(makeStats({ mtimeMs: 2000, size: 20 })).state).toBe(
        'fresh',
      );
    });

    it('refreshes lastReadAt to match the write — the author saw all bytes', () => {
      // recordWrite always re-stamps the read metadata: the model authored
      // the bytes, so it has seen the full current content regardless of any
      // earlier partial / ranged / non-cacheable read.
      read('/x/foo.ts', makeStats());
      const readTime = Date.now();
      vi.advanceTimersByTime(5_000);
      const entry = cache.recordWrite(
        '/x/foo.ts',
        makeStats({ mtimeMs: 9999 }),
      );
      expect(entry.lastWriteAt).toBeGreaterThan(readTime);
      expect(entry.lastReadAt).toBe(entry.lastWriteAt);
    });

    it('upgrades lastReadWasFull / lastReadCacheable after a full write', () => {
      // Reviewer-flagged gap: ReadFile(limit=10) → WriteFile(full) → Edit.
      // Pre-fix the partial read's lastReadWasFull=false survived the write
      // and the Edit was rejected with EDIT_REQUIRES_PRIOR_READ.
      const stats = makeStats();
      read('/x/foo.ts', stats, { full: false, cacheable: true });
      expect(fresh(stats).lastReadWasFull).toBe(false);
      cache.recordWrite('/x/foo.ts', makeStats({ mtimeMs: 2000 }));
      const afterWrite = fresh(makeStats({ mtimeMs: 2000 }));
      expect(afterWrite.lastReadWasFull).toBe(true);
      expect(afterWrite.lastReadCacheable).toBe(true);
    });

    it('can record structured writes as non-cacheable', () => {
      const entry = cache.recordWrite('/x/notebook.ipynb', makeStats(), {
        cacheable: false,
      });

      expect(entry.lastReadWasFull).toBe(true);
      expect(entry.lastReadCacheable).toBe(false);
      expect(entry.lastReadAt).toBe(entry.lastWriteAt);
    });
  });

  describe('read-then-write-then-read ordering', () => {
    useFixedClock();

    it('records lastWriteAt === lastReadAt after Read → Write', () => {
      // recordWrite refreshes the read metadata to the write time (the model
      // authored the bytes). ReadFile's file_unchanged fast-path therefore
      // checks `lastReadAt > lastWriteAt` strictly: equal timestamps mean
      // "the last operation was a write", so a follow-up Read re-emits the
      // bytes rather than serving a placeholder.
      read('/x/foo.ts', makeStats({ mtimeMs: 1000 }));
      vi.advanceTimersByTime(1);
      cache.recordWrite('/x/foo.ts', makeStats({ mtimeMs: 2000 }));
      const { lastReadAt, lastWriteAt } = fresh(makeStats({ mtimeMs: 2000 }));
      expect(lastReadAt).toBeDefined();
      expect(lastWriteAt).toBeDefined();
      expect(lastReadAt).toBe(lastWriteAt);
    });

    it('records lastReadAt > lastWriteAt after Read → Write → Read', () => {
      read('/x/foo.ts', makeStats({ mtimeMs: 1000 }));
      vi.advanceTimersByTime(1);
      cache.recordWrite('/x/foo.ts', makeStats({ mtimeMs: 2000 }));
      vi.advanceTimersByTime(1);
      read('/x/foo.ts', makeStats({ mtimeMs: 2000 }));
      const { lastReadAt, lastWriteAt } = fresh(makeStats({ mtimeMs: 2000 }));
      expect(lastReadAt!).toBeGreaterThan(lastWriteAt!);
    });
  });

  describe('isolation between files', () => {
    it('keeps unrelated entries independent', () => {
      const a = makeStats({ ino: 1 });
      const b = makeStats({ ino: 2 });
      read('/x/a.ts', a);
      expect(cache.check(b).state).toBe('unknown');
      read('/x/b.ts', b);
      expect(cache.check(a).state).toBe('fresh');
      expect(cache.check(b).state).toBe('fresh');
    });

    it('treats same ino across different devs as separate files', () => {
      read('/x/a', makeStats({ dev: 1, ino: 5 }));
      expect(cache.check(makeStats({ dev: 2, ino: 5 })).state).toBe('unknown');
    });
  });

  describe('invalidate / clear / size', () => {
    it('size reflects the count of tracked entries', () => {
      expect(cache.size()).toBe(0);
      read('/x/a', makeStats({ ino: 1 }));
      read('/x/b', makeStats({ ino: 2 }));
      expect(cache.size()).toBe(2);
    });

    it('invalidate removes the entry for the given Stats', () => {
      const stats = makeStats();
      read('/x/a', stats);
      cache.invalidate(stats);
      expect(cache.check(stats).state).toBe('unknown');
      expect(cache.size()).toBe(0);
    });

    it('invalidate is a no-op for entries that were never recorded', () => {
      expect(() => cache.invalidate(makeStats())).not.toThrow();
      expect(cache.size()).toBe(0);
    });

    it('clear drops every entry', () => {
      read('/x/a', makeStats({ ino: 1 }));
      read('/x/b', makeStats({ ino: 2 }));
      cache.clear();
      expect(cache.size()).toBe(0);
      expect(cache.check(makeStats({ ino: 1 })).state).toBe('unknown');
    });
  });

  describe('with real filesystem stats', () => {
    // One end-to-end check that dev+ino keying works against
    // node:fs.statSync: the rest of the suite uses synthetic Stats, so this
    // guards against relying on a field real platforms don't populate.
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

      read(original, fs.statSync(original));
      // Same inode reached via a different path — must hit the same entry.
      expect(cache.check(fs.statSync(link)).state).toBe('fresh');
    });

    it('detects external modification as stale', () => {
      const file = path.join(tmpDir, 'mut.txt');
      fs.writeFileSync(file, 'one');
      read(file, fs.statSync(file));

      // Bump mtime explicitly; on some filesystems a same-second rewrite
      // would not change mtime, which would mask the test.
      const future = new Date(Date.now() + 60_000);
      fs.writeFileSync(file, 'one-plus-more');
      fs.utimesSync(file, future, future);

      expect(cache.check(fs.statSync(file)).state).toBe('stale');
    });
  });

  describe('readResidentInHistory / markReadEvictedFromHistory (issue #4239)', () => {
    it('a fresh recordRead is resident in history', () => {
      expect(read('/x/foo.ts', makeStats()).readResidentInHistory).toBe(true);
    });

    it('a fresh recordWrite is resident in history', () => {
      const entry = cache.recordWrite('/x/foo.ts', makeStats());
      expect(entry.readResidentInHistory).toBe(true);
    });

    it('markReadEvictedFromHistory disarms only the fast-path, preserving read-before-write state', () => {
      const stats = makeStats();
      read('/x/foo.ts', stats);

      expect(cache.markReadEvictedFromHistory(stats)).toBe(true);

      const entry = fresh(stats);
      // Fast-path disarmed...
      expect(entry.readResidentInHistory).toBe(false);
      // ...but everything read-before-write depends on is intact.
      expect(entry.lastReadAt).toBeDefined();
      expect(entry.lastReadWasFull).toBe(true);
      expect(entry.lastReadCacheable).toBe(true);
    });

    it('returns false (caller must fall back to clear) when there is no entry for the stats', () => {
      // No entry, or stats resolved to a different inode than recorded
      // — the caller treats this like an unstattable path.
      expect(cache.markReadEvictedFromHistory(makeStats())).toBe(false);
      expect(cache.check(makeStats()).state).toBe('unknown');

      // Entry exists under inode A; a stat for inode B must not match.
      read('/x/foo.ts', makeStats({ ino: 1 }));
      expect(cache.markReadEvictedFromHistory(makeStats({ ino: 2 }))).toBe(
        false,
      );
    });

    it('invalidates a stale resident entry by its last observed path', () => {
      const stats = makeStats();
      read('/x/foo.ts', stats);

      expect(cache.invalidateByPath('/x/foo.ts')).toBe(true);
      expect(cache.check(stats).state).toBe('unknown');
    });

    it('invalidates by a relative path that resolves to the recorded path', () => {
      const stats = makeStats();
      const relative = path.join('x', 'foo.ts');
      read(path.resolve(relative), stats);

      expect(cache.invalidateByPath(relative)).toBe(true);
      expect(cache.check(stats).state).toBe('unknown');
    });

    it('returns false when no entry was recorded for the path', () => {
      read('/x/foo.ts', makeStats());

      expect(cache.invalidateByPath('/x/other.ts')).toBe(false);
      expect(cache.size()).toBe(1);
    });

    it('a subsequent real read re-arms the fast-path (resident again)', () => {
      const stats = makeStats();
      read('/x/foo.ts', stats);
      cache.markReadEvictedFromHistory(stats);

      // The model voluntarily re-read the file: its bytes are back in
      // history, so the fast-path is honest again.
      read('/x/foo.ts', stats);
      expect(fresh(stats).readResidentInHistory).toBe(true);
    });

    it('a subsequent write re-arms the fast-path (resident again)', () => {
      const stats = makeStats();
      read('/x/foo.ts', stats);
      cache.markReadEvictedFromHistory(stats);

      cache.recordWrite('/x/foo.ts', makeStats({ mtimeMs: 2000 }));
      expect(fresh(makeStats({ mtimeMs: 2000 })).readResidentInHistory).toBe(
        true,
      );
    });

    it('a PARTIAL read does NOT re-arm an evicted full read', () => {
      // Regression for the Codex P2: after microcompaction blanks a full
      // read, a later partial read of the unchanged file used to re-arm
      // readResidentInHistory while lastReadWasFull stayed sticky-true, so a
      // follow-up full Read got a file_unchanged placeholder pointing at
      // bytes no longer in history (only a slice is resident).
      const stats = makeStats();
      read('/x/foo.ts', stats);
      cache.markReadEvictedFromHistory(stats);

      // Same unchanged bytes, but only a slice read this time.
      read('/x/foo.ts', stats, { full: false, cacheable: true });

      const entry = fresh(stats);
      // Still disarmed — the full bytes are NOT back in history.
      expect(entry.readResidentInHistory).toBe(false);
      // lastReadWasFull stays sticky-true (read-rights preserved).
      expect(entry.lastReadWasFull).toBe(true);
    });

    it('a partial read leaves a still-resident full read armed', () => {
      const stats = makeStats();
      read('/x/foo.ts', stats);
      // No eviction — the full read is still in history.
      read('/x/foo.ts', stats, { full: false, cacheable: true });
      expect(fresh(stats).readResidentInHistory).toBe(true);
    });
  });

  describe('eviction', () => {
    it('evicts the oldest entry when the cache exceeds MAX_ENTRIES', () => {
      // Fill cache to capacity (MAX_ENTRIES = 4096).
      readRange('file', 1, 4096);
      expect(cache.size()).toBe(4096);

      // The 4097th write triggers eviction of the oldest (ino=1).
      cache.recordWrite('/x/file-new.ts', makeStats({ ino: 4097 }));
      expect(cache.size()).toBeLessThanOrEqual(4096);
      expect(cache.check(makeStats({ ino: 1 })).state).toBe('unknown');
      expect(cache.check(makeStats({ ino: 4097 })).state).toBe('fresh');
    });

    it('keeps size at MAX_ENTRIES after multiple overflows', () => {
      // Add MAX_ENTRIES + 100 distinct inodes.
      readRange('file', 1, 4196);
      expect(cache.size()).toBeLessThanOrEqual(4096);
    });

    it('should have bumped entries survive eviction', () => {
      // Fill to capacity.
      readRange('file', 1, 4096);

      // Frequently update ino=1 — after bump lands this moves it to the
      // back of the eviction queue.
      for (let i = 0; i < 10; i++) read('/x/file-1.ts', makeStats({ ino: 1 }));

      // Add 50 new entries — they push the *least* recently bumped out.
      readRange('file', 4096, 4145);

      expect(cache.size()).toBeLessThanOrEqual(4096);
      expect(cache.check(makeStats({ ino: 1 })).state).not.toBe('unknown');
    });
  });

  describe('evictNotAccessedSince', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('evicts entries with lastReadAt before the cutoff', () => {
      const now = 2_000_000_000;
      const old = now - 100 * 60_000; // 100 minutes ago
      const recent = now - 5 * 60_000; // 5 minutes ago

      const oldStats = makeStats({ ino: 1 });
      const recentStats = makeStats({ ino: 2 });

      vi.useFakeTimers();
      vi.setSystemTime(old);
      read('/x/old.ts', oldStats);

      vi.setSystemTime(recent);
      read('/x/recent.ts', recentStats);

      // Now set time to "now" and evict entries older than 30 minutes
      vi.setSystemTime(now);

      const evicted = cache.evictNotAccessedSince(30);
      expect(evicted).toBe(1);
      expect(cache.check(oldStats).state).toBe('unknown');
      expect(cache.check(recentStats).state).toBe('fresh');
    });

    it('evicts entries that were only written, never read', () => {
      vi.useFakeTimers();

      const pastWrite = 1000; // some fixed timestamp in the past
      vi.setSystemTime(pastWrite);
      cache.recordWrite('/x/old-write.ts', makeStats({ ino: 2 }));

      // Advance time by 120 minutes
      vi.setSystemTime(pastWrite + 120 * 60_000);

      const evicted = cache.evictNotAccessedSince(60);
      expect(evicted).toBe(1);
      expect(cache.size()).toBe(0);
    });

    it('preserves recently accessed entries', () => {
      vi.useFakeTimers();

      const now = Date.now();
      vi.setSystemTime(now);

      read('/x/recent.ts', makeStats({ ino: 1 }));

      const evicted = cache.evictNotAccessedSince(30);
      expect(evicted).toBe(0);
      expect(cache.size()).toBe(1);
    });

    it('returns correct eviction count', () => {
      vi.useFakeTimers();

      const now = Date.now();
      vi.setSystemTime(now);

      // 3 recent entries
      readRange('recent', 1, 3);

      // Jump 120 minutes back, add 2 old entries
      vi.setSystemTime(now - 120 * 60_000);
      readRange('old', 10, 11);

      // Back to now
      vi.setSystemTime(now);

      const evicted = cache.evictNotAccessedSince(60);
      expect(evicted).toBe(2);
      expect(cache.size()).toBe(3);
    });

    it('returns 0 for empty cache', () => {
      expect(cache.evictNotAccessedSince(30)).toBe(0);
    });

    it('does not evict entries for sub-minute windows', () => {
      read('/x/recent.ts', makeStats({ ino: 1 }));

      expect(cache.evictNotAccessedSince(0)).toBe(0);
      expect(cache.evictNotAccessedSince(-30)).toBe(0);
      expect(cache.evictNotAccessedSince(0.0000001)).toBe(0);
      expect(cache.size()).toBe(1);
    });
  });
});
