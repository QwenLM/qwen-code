/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Stats } from 'node:fs';

/**
 * Session-scoped cache that tracks which files the model has Read or
 * written in the current conversation, plus the (mtime, size) snapshot at
 * the time of that operation. It exists so that Edit / WriteFile can
 * verify the model is editing a file it has actually seen, and so that
 * repeated full Reads of an unchanged file can be short-circuited.
 *
 * This is a pure in-memory data structure. Callers are responsible for
 * `fs.stat`-ing the file and passing the resulting Stats in — the cache
 * never touches the filesystem itself, which keeps it trivially testable
 * and avoids double-stat overhead at the call sites (Read / Edit /
 * WriteFile already stat for their own reasons).
 *
 * Identity: entries are keyed by `${dev}:${ino}`, not by path. This is
 * deliberate: it makes symlinks, hardlinks, and case-variant paths on
 * case-insensitive filesystems all collapse onto the same entry, which
 * is what we want — the cache is reasoning about *files*, not strings.
 *
 * Platform note: on Windows, `Stats.ino` is documented as not guaranteed
 * unique (Node returns it from `_BY_HANDLE_FILE_INFORMATION.nFileIndex`,
 * which can collide across volumes and ReFS). Callers that target
 * Windows should consider falling back to a path-based key; the POSIX
 * platforms qwen-code primarily runs on (macOS / Linux) are unaffected.
 *
 * Lifecycle: one instance is created per `Config` via the field
 * initializer, so any code that constructs its own Config — notably
 * subagents — automatically gets an independent cache. The cache itself
 * does not enforce isolation; it relies on the Config-per-session
 * invariant maintained by the surrounding code.
 */

/** A single tracked file. Mutated in place by {@link FileReadCache}. */
export interface FileReadEntry {
  /** `${stats.dev}:${stats.ino}` — the canonical identity. */
  readonly inodeKey: string;
  /**
   * Last absolute path we observed pointing at this inode. Diagnostic
   * only — it is *not* used for lookup, since multiple paths can resolve
   * to the same inode (symlinks, case variants).
   */
  realPath: string;
  /** mtime in ms at the time of the most recent record(). */
  mtimeMs: number;
  /** Size in bytes at the time of the most recent record(). */
  sizeBytes: number;
  /** ms epoch of the last successful Read. Undefined if never read. */
  lastReadAt?: number;
  /** ms epoch of the last successful write. Undefined if never written. */
  lastWriteAt?: number;
  /**
   * True iff the most recent Read consumed the whole file (no offset /
   * limit / pages). Used by the Read fast-path to decide whether a
   * follow-up "no-args" Read can return a `file_unchanged` placeholder
   * instead of re-emitting the full content. Range-scoped Reads never
   * trigger the placeholder, since the model may legitimately ask for a
   * different range next time.
   */
  lastReadWasFull: boolean;
  /**
   * True iff the content the most recent Read produced is one we are
   * willing to substitute with a `file_unchanged` placeholder. Plain
   * text reads set this to true; binary, image, audio, video, PDF, and
   * notebook reads set it to false, because the model will likely need
   * the structured / multi-modal payload again rather than a stub. The
   * cache itself does not interpret this flag — it is a hint produced
   * and consumed by the Read tool.
   */
  lastReadCacheable: boolean;
}

/** Result of {@link FileReadCache.check}. */
export type FileReadCheckResult =
  | { state: 'fresh'; entry: FileReadEntry }
  | { state: 'stale'; entry: FileReadEntry }
  | { state: 'unknown' };

export class FileReadCache {
  private readonly byInode = new Map<string, FileReadEntry>();

  /** Build the canonical key for a file from its Stats. */
  static inodeKey(stats: Stats): string {
    return `${stats.dev}:${stats.ino}`;
  }

  /**
   * Record a successful Read of `absPath`.
   *
   *  - `full`      — the Read covered the entire file (no offset / limit
   *    / pages). Only full Reads enable the `file_unchanged` fast-path
   *    on subsequent reads.
   *  - `cacheable` — the produced content is suitable for substitution
   *    with a `file_unchanged` placeholder. Set true for plain text,
   *    false for binary / image / audio / video / PDF / notebook.
   *
   * The `lastReadWasFull` and `lastReadCacheable` flags are
   * **sticky-on-true** when the recorded fingerprint matches the
   * existing entry's `(mtimeMs, sizeBytes)`. That preserves the
   * model's read-rights across `Read full → Read partial` and
   * `WriteFile(create) → Read partial → Edit` sequences against
   * the same bytes.
   *
   * When the fingerprint drifts — i.e. the file was mutated between
   * the prior record and this one — the flags are **reset** to
   * exactly what this read produced. Sticky-on-true across drift
   * would let a `Read full @X → external write → Read partial @Y →
   * Edit` sequence pass enforcement against bytes the model only
   * saw the first 10 lines of, exactly the regression flagged in
   * the maintainer review.
   *
   * The fast-path `file_unchanged` check still gates on the
   * incoming request's own `isFullRead` (in `read-file.ts`), so a
   * partial read does not get a placeholder it shouldn't.
   */
  recordRead(
    absPath: string,
    stats: Stats,
    opts: { full: boolean; cacheable: boolean },
  ): FileReadEntry {
    const key = FileReadCache.inodeKey(stats);
    const existing = this.byInode.get(key);
    const sameFingerprint =
      existing !== undefined &&
      existing.mtimeMs === stats.mtimeMs &&
      existing.sizeBytes === stats.size;
    const entry = this.upsert(absPath, stats);
    entry.lastReadAt = Date.now();
    if (sameFingerprint) {
      // Same bytes the entry already described — sticky-on-true
      // preserves prior `true` flags from full reads or writes.
      if (opts.full) {
        entry.lastReadWasFull = true;
      }
      if (opts.cacheable) {
        entry.lastReadCacheable = true;
      }
    } else {
      // Drift detected (or fresh entry): the prior flags described
      // different bytes. Reset to what this read actually produced.
      entry.lastReadWasFull = opts.full;
      entry.lastReadCacheable = opts.cacheable;
    }
    return entry;
  }

  /**
   * Record a successful write (Edit, WriteFile, or any other tool that
   * mutates the file's bytes). After a write the on-disk mtime/size will
   * differ from any prior Read snapshot, so we refresh the cached
   * fingerprint to the post-write Stats; otherwise the next Edit would
   * see its own write as a "stale" external change.
   *
   * Read metadata is **always** refreshed alongside the write, not
   * just for brand-new entries: the model authored the entire current
   * content, so for prior-read enforcement purposes it has now "seen"
   * all bytes — regardless of whether the prior recordRead happened
   * to be partial (`lastReadWasFull=false`) or non-cacheable
   * (`lastReadCacheable=false`). Without this, a sequence such as
   * `ReadFile(limit=10)` → `WriteFile` (full content) → `Edit` would
   * be rejected on the Edit because `lastReadWasFull=false` from the
   * earlier partial read would persist through the write.
   */
  recordWrite(absPath: string, stats: Stats): FileReadEntry {
    const entry = this.upsert(absPath, stats);
    const now = Date.now();
    entry.lastWriteAt = now;
    entry.lastReadAt = now;
    entry.lastReadWasFull = true;
    entry.lastReadCacheable = true;
    return entry;
  }

  /**
   * Compare the cached fingerprint against `stats` for the same inode.
   *
   *  - `unknown` — no entry. The file has never been Read or written in
   *    this session.
   *  - `stale`   — entry exists but mtime or size differs. The file has
   *    been changed by something outside our control (or by us, before
   *    this stats call was taken).
   *  - `fresh`   — entry exists and mtime + size match. Safe to assume
   *    the bytes are what we last saw.
   *
   * Note: mtime + size is a best-effort fingerprint, not a hash. A file
   * rewritten with identical mtime *and* identical size will read as
   * `fresh`. In practice the Edit path catches this via the
   * `0 occurrences` failure mode, which prompts the model to re-read.
   */
  check(stats: Stats): FileReadCheckResult {
    const entry = this.byInode.get(FileReadCache.inodeKey(stats));
    if (!entry) return { state: 'unknown' };
    if (entry.mtimeMs !== stats.mtimeMs || entry.sizeBytes !== stats.size) {
      return { state: 'stale', entry };
    }
    return { state: 'fresh', entry };
  }

  /** Remove the entry for the given Stats, if any. */
  invalidate(stats: Stats): void {
    this.byInode.delete(FileReadCache.inodeKey(stats));
  }

  /** Drop every entry. Used by tests and on Config shutdown. */
  clear(): void {
    this.byInode.clear();
  }

  /** Number of tracked entries. Diagnostic / test use only. */
  size(): number {
    return this.byInode.size;
  }

  private upsert(absPath: string, stats: Stats): FileReadEntry {
    const key = FileReadCache.inodeKey(stats);
    const existing = this.byInode.get(key);
    if (existing) {
      existing.realPath = absPath;
      existing.mtimeMs = stats.mtimeMs;
      existing.sizeBytes = stats.size;
      return existing;
    }
    const entry: FileReadEntry = {
      inodeKey: key,
      realPath: absPath,
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
      lastReadWasFull: false,
      lastReadCacheable: false,
    };
    this.byInode.set(key, entry);
    return entry;
  }
}
