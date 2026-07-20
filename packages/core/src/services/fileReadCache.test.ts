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

    it('preserves earlier lastReadWasFull on a subsequent partial read (sticky-on-true)', () => {
      // Prior-read enforcement asks "has the model seen these
      // bytes (or fully authored them)?" — once a full read has
      // happened, a follow-up offset/limit read should not revoke
      // the model's right to mutate the file. Pre-fix this was
      // the cause of the `WriteFile(create) → ReadFile(offset/limit)
      // → Edit` regression flagged by the maintainer review.
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: true });
      cache.recordRead('/x/foo.ts', stats, { full: false, cacheable: true });
      const result = cache.check(stats);
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        expect(result.entry.lastReadWasFull).toBe(true);
      }
    });

    it('does NOT preserve lastReadWasFull when a drifted (mutated) fingerprint arrives', () => {
      // Maintainer-review regression: T0 full read at fingerprint
      // X → T1 external write advances on-disk to Y → T2 partial
      // read records at Y. Sticky-on-true used to silently keep
      // lastReadWasFull=true from T0 even though it described
      // different bytes; a follow-up Edit then ran against bytes
      // the model only saw the first 10 lines of.
      const cache = new FileReadCache();
      cache.recordRead('/x/foo.ts', makeStats({ mtimeMs: 1000, size: 100 }), {
        full: true,
        cacheable: true,
      });
      // Drift: external write advances mtime+size.
      cache.recordRead('/x/foo.ts', makeStats({ mtimeMs: 2000, size: 200 }), {
        full: false,
        cacheable: true,
      });
      const result = cache.check(makeStats({ mtimeMs: 2000, size: 200 }));
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        // Reset to this read's actual shape, not sticky-on-true
        // from the prior full read of different bytes.
        expect(result.entry.lastReadWasFull).toBe(false);
      }
    });

    it('preserves earlier lastReadCacheable on a subsequent non-cacheable read', () => {
      // Symmetric to lastReadWasFull. A model that once read a
      // file as text and later read it as a structured payload
      // (image, PDF, etc. — though uncommon in practice for a
      // single inode) keeps the right to edit the bytes it saw
      // as text.
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: true });
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: false });
      const result = cache.check(stats);
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        expect(result.entry.lastReadCacheable).toBe(true);
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

    it('seeds read metadata when recording a write on a brand-new entry', () => {
      // The model authored the bytes it just wrote — for the purposes
      // of prior-read enforcement on the *next* Edit, that counts as
      // having seen the full text content. Without this seeding a
      // create→edit→edit chain would reject the second edit because
      // lastReadWasFull / lastReadCacheable would still be unset on
      // the entry recordWrite created.
      const cache = new FileReadCache();
      const entry = cache.recordWrite('/x/foo.ts', makeStats());
      expect(entry.lastReadAt).toBeDefined();
      expect(entry.lastReadAt).toBe(entry.lastWriteAt);
      expect(entry.lastReadWasFull).toBe(true);
      expect(entry.lastReadCacheable).toBe(true);
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

    it('refreshes lastReadAt to match the write — the author saw all bytes', () => {
      // recordWrite always re-stamps the read metadata: the model
      // authored the bytes it just wrote, so for prior-read
      // enforcement purposes it now counts as having seen the full
      // current content, regardless of whatever partial / ranged /
      // non-cacheable read happened earlier in the session.
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: true });
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
      // Reproduction for the gap reviewer flagged: ReadFile(limit=10)
      // → WriteFile(full) → Edit. Pre-fix, the partial read's
      // lastReadWasFull=false persisted through the write and the
      // Edit would be rejected with EDIT_REQUIRES_PRIOR_READ.
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: false, cacheable: true });
      const partialEntry = cache.check(stats);
      expect(partialEntry.state).toBe('fresh');
      if (partialEntry.state === 'fresh') {
        expect(partialEntry.entry.lastReadWasFull).toBe(false);
      }
      cache.recordWrite('/x/foo.ts', makeStats({ mtimeMs: 2000 }));
      const afterWrite = cache.check(makeStats({ mtimeMs: 2000 }));
      expect(afterWrite.state).toBe('fresh');
      if (afterWrite.state === 'fresh') {
        expect(afterWrite.entry.lastReadWasFull).toBe(true);
        expect(afterWrite.entry.lastReadCacheable).toBe(true);
      }
    });

    it('can record structured writes as non-cacheable', () => {
      const cache = new FileReadCache();
      const entry = cache.recordWrite('/x/notebook.ipynb', makeStats(), {
        cacheable: false,
      });

      expect(entry.lastReadWasFull).toBe(true);
      expect(entry.lastReadCacheable).toBe(false);
      expect(entry.lastReadAt).toBe(entry.lastWriteAt);
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

    it('records lastWriteAt === lastReadAt after Read → Write', () => {
      // recordWrite refreshes the read metadata to the write time
      // because the model authored the bytes it just wrote and now
      // counts as having seen them. ReadFile's file_unchanged
      // fast-path therefore checks `lastReadAt > lastWriteAt`
      // (strictly greater): equal timestamps mean "the last
      // operation was a write" and a follow-up Read should re-emit
      // the bytes rather than serve a placeholder.
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
        expect(lastReadAt).toBe(lastWriteAt);
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

  describe('readResidentInHistory / markReadEvictedFromHistory (issue #4239)', () => {
    it('a fresh recordRead is resident in history', () => {
      const cache = new FileReadCache();
      const stats = makeStats();
      const entry = cache.recordRead('/x/foo.ts', stats, {
        full: true,
        cacheable: true,
      });
      expect(entry.readResidentInHistory).toBe(true);
    });

    it('a fresh recordWrite is resident in history', () => {
      const cache = new FileReadCache();
      const entry = cache.recordWrite('/x/foo.ts', makeStats());
      expect(entry.readResidentInHistory).toBe(true);
    });

    it('markReadEvictedFromHistory disarms only the fast-path, preserving read-before-write state', () => {
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: true });

      expect(cache.markReadEvictedFromHistory(stats)).toBe(true);

      const result = cache.check(stats);
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        // Fast-path disarmed...
        expect(result.entry.readResidentInHistory).toBe(false);
        // ...but everything read-before-write depends on is intact.
        expect(result.entry.lastReadAt).toBeDefined();
        expect(result.entry.lastReadWasFull).toBe(true);
        expect(result.entry.lastReadCacheable).toBe(true);
      }
    });

    it('returns false (caller must fall back to clear) when there is no entry for the stats', () => {
      const cache = new FileReadCache();
      // No entry, or stats resolved to a different inode than recorded
      // — the caller treats this like an unstattable path.
      expect(cache.markReadEvictedFromHistory(makeStats())).toBe(false);
      expect(cache.check(makeStats()).state).toBe('unknown');

      // Entry exists under inode A; a stat for inode B must not match.
      cache.recordRead('/x/foo.ts', makeStats({ ino: 1 }), {
        full: true,
        cacheable: true,
      });
      expect(cache.markReadEvictedFromHistory(makeStats({ ino: 2 }))).toBe(
        false,
      );
    });

    it('invalidates a stale resident entry by its last observed path', () => {
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: true });

      expect(cache.invalidateByPath('/x/foo.ts')).toBe(true);
      expect(cache.check(stats).state).toBe('unknown');
    });

    it('invalidates by a relative path that resolves to the recorded path', () => {
      const cache = new FileReadCache();
      const stats = makeStats();
      const relative = path.join('x', 'foo.ts');
      cache.recordRead(path.resolve(relative), stats, {
        full: true,
        cacheable: true,
      });

      expect(cache.invalidateByPath(relative)).toBe(true);
      expect(cache.check(stats).state).toBe('unknown');
    });

    it('returns false when no entry was recorded for the path', () => {
      const cache = new FileReadCache();
      cache.recordRead('/x/foo.ts', makeStats(), {
        full: true,
        cacheable: true,
      });

      expect(cache.invalidateByPath('/x/other.ts')).toBe(false);
      expect(cache.size()).toBe(1);
    });

    it('a subsequent real read re-arms the fast-path (resident again)', () => {
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: true });
      cache.markReadEvictedFromHistory(stats);

      // The model voluntarily re-read the file: its bytes are back in
      // history, so the fast-path is honest again.
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: true });

      const result = cache.check(stats);
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        expect(result.entry.readResidentInHistory).toBe(true);
      }
    });

    it('a subsequent write re-arms the fast-path (resident again)', () => {
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: true });
      cache.markReadEvictedFromHistory(stats);

      cache.recordWrite('/x/foo.ts', makeStats({ mtimeMs: 2000 }));

      const result = cache.check(makeStats({ mtimeMs: 2000 }));
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        expect(result.entry.readResidentInHistory).toBe(true);
      }
    });

    it('a PARTIAL read does NOT re-arm an evicted full read', () => {
      // Regression for the Codex P2: after microcompaction blanks a
      // full read, a later partial read of the unchanged file used to
      // unconditionally re-arm readResidentInHistory while
      // lastReadWasFull stayed sticky-true — so a follow-up full Read
      // would get a file_unchanged placeholder pointing at bytes no
      // longer in history (only a slice is resident).
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: true });
      cache.markReadEvictedFromHistory(stats);

      // Same unchanged bytes, but only a slice read this time.
      cache.recordRead('/x/foo.ts', stats, { full: false, cacheable: true });

      const result = cache.check(stats);
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        // Still disarmed — the full bytes are NOT back in history.
        expect(result.entry.readResidentInHistory).toBe(false);
        // lastReadWasFull stays sticky-true (read-rights preserved).
        expect(result.entry.lastReadWasFull).toBe(true);
      }
    });

    it('a partial read leaves a still-resident full read armed', () => {
      const cache = new FileReadCache();
      const stats = makeStats();
      cache.recordRead('/x/foo.ts', stats, { full: true, cacheable: true });
      // No eviction — the full read is still in history.
      cache.recordRead('/x/foo.ts', stats, { full: false, cacheable: true });

      const result = cache.check(stats);
      expect(result.state).toBe('fresh');
      if (result.state === 'fresh') {
        expect(result.entry.readResidentInHistory).toBe(true);
      }
    });
  });

  describe('eviction', () => {
    it('evicts the oldest entry when the cache exceeds MAX_ENTRIES', () => {
      // Fill cache to capacity (MAX_ENTRIES = 4096).
      const cache = new FileReadCache();
      for (let i = 0; i < 4096; i++) {
        cache.recordRead(`/x/file-${i}.ts`, makeStats({ ino: i }), {
          full: true,
          cacheable: true,
        });
      }
      expect(cache.size()).toBe(4096);

      // The 4097th write triggers eviction of the oldest (ino=0).
      cache.recordWrite('/x/file-new.ts', makeStats({ ino: 4096 }));
      expect(cache.size()).toBeLessThanOrEqual(4096);
      expect(cache.check(makeStats({ ino: 0 })).state).toBe('unknown');
      expect(cache.check(makeStats({ ino: 4096 })).state).toBe('fresh');
    });

    it('keeps size at MAX_ENTRIES after multiple overflows', () => {
      const cache = new FileReadCache();
      // Add MAX_ENTRIES + 100 distinct inodes.
      for (let i = 0; i < 4196; i++) {
        cache.recordRead(`/x/file-${i}.ts`, makeStats({ ino: i }), {
          full: true,
          cacheable: true,
        });
      }
      expect(cache.size()).toBeLessThanOrEqual(4096);
    });

    it('should have bumped entries survive eviction', () => {
      const cache = new FileReadCache();
      // Fill to capacity.
      for (let i = 0; i < 4096; i++) {
        cache.recordRead(`/x/file-${i}.ts`, makeStats({ ino: i }), {
          full: true,
          cacheable: true,
        });
      }

      // Frequently update ino=0 — after bump lands this moves it to the
      // back of the eviction queue.
      for (let i = 0; i < 10; i++) {
        cache.recordRead('/x/file-0.ts', makeStats({ ino: 0 }), {
          full: true,
          cacheable: true,
        });
      }

      // Add 50 new entries — they push the *least* recently bumped out.
      for (let i = 4096; i < 4146; i++) {
        cache.recordRead(`/x/file-${i}.ts`, makeStats({ ino: i }), {
          full: true,
          cacheable: true,
        });
      }

      expect(cache.size()).toBeLessThanOrEqual(4096);
      expect(cache.check(makeStats({ ino: 0 })).state).not.toBe('unknown');
    });
  });

  describe('evictNotAccessedSince', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('evicts entries with lastReadAt before the cutoff', () => {
      const cache = new FileReadCache();
      const now = 2_000_000_000;
      const old = now - 100 * 60_000; // 100 minutes ago
      const recent = now - 5 * 60_000; // 5 minutes ago

      const oldStats = makeStats({ ino: 1 });
      const recentStats = makeStats({ ino: 2 });

      vi.useFakeTimers();
      vi.setSystemTime(old);
      cache.recordRead('/x/old.ts', oldStats, { full: true, cacheable: true });

      vi.setSystemTime(recent);
      cache.recordRead('/x/recent.ts', recentStats, {
        full: true,
        cacheable: true,
      });

      // Now set time to "now" and evict entries older than 30 minutes
      vi.setSystemTime(now);

      const evicted = cache.evictNotAccessedSince(30);
      expect(evicted).toBe(1);
      expect(cache.check(oldStats).state).toBe('unknown');
      expect(cache.check(recentStats).state).toBe('fresh');
    });

    it('evicts entries that were only written, never read', () => {
      const cache = new FileReadCache();
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
      const cache = new FileReadCache();
      vi.useFakeTimers();

      const now = Date.now();
      vi.setSystemTime(now);

      cache.recordRead('/x/recent.ts', makeStats({ ino: 1 }), {
        full: true,
        cacheable: true,
      });

      const evicted = cache.evictNotAccessedSince(30);
      expect(evicted).toBe(0);
      expect(cache.size()).toBe(1);
    });

    it('returns correct eviction count', () => {
      const cache = new FileReadCache();
      vi.useFakeTimers();

      const now = Date.now();
      vi.setSystemTime(now);

      // 3 recent entries
      for (let i = 0; i < 3; i++) {
        cache.recordRead(`/x/recent-${i}.ts`, makeStats({ ino: i }), {
          full: true,
          cacheable: true,
        });
      }

      // Jump 120 minutes back, add 2 old entries
      vi.setSystemTime(now - 120 * 60_000);
      for (let i = 10; i < 12; i++) {
        cache.recordRead(`/x/old-${i}.ts`, makeStats({ ino: i }), {
          full: true,
          cacheable: true,
        });
      }

      // Back to now
      vi.setSystemTime(now);

      const evicted = cache.evictNotAccessedSince(60);
      expect(evicted).toBe(2);
      expect(cache.size()).toBe(3);
    });

    it('returns 0 for empty cache', () => {
      const cache = new FileReadCache();
      expect(cache.evictNotAccessedSince(30)).toBe(0);
    });

    it('does not evict entries for sub-minute windows', () => {
      const cache = new FileReadCache();
      cache.recordRead('/x/recent.ts', makeStats({ ino: 1 }), {
        full: true,
        cacheable: true,
      });

      expect(cache.evictNotAccessedSince(0)).toBe(0);
      expect(cache.evictNotAccessedSince(-30)).toBe(0);
      expect(cache.evictNotAccessedSince(0.0000001)).toBe(0);
      expect(cache.size()).toBe(1);
    });
  });
});
