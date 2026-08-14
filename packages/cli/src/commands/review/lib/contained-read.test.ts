/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_LEDGER_BYTES,
  ContainedReadError,
  containedDir,
  containedRoot,
  listContainedDir,
  readContainedFile,
  readContainedFileOrNull,
} from './contained-read.js';

/**
 * POSIX-only facts: symlink refusal rides `O_NOFOLLOW` and FIFO refusal rides
 * `fstat` on a non-blocking descriptor. Windows has neither primitive, and the
 * module says so in prose rather than pretending otherwise.
 */
const isWindows = process.platform === 'win32';

describe('readContainedFile', () => {
  let root: string;

  beforeEach(() => {
    // realpath: on macOS `/tmp` is itself a symlink, and the component walk
    // under test refuses a linked ancestor — so a raw mkdtemp path would fail
    // the very check it is meant to exercise, for a reason that has nothing to
    // do with the fixture.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'contained-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the bytes and the metadata of the same descriptor', () => {
    const file = join(root, 'a.jsonl');
    writeFileSync(file, 'hello\nworld\n');
    // A distinctive mtime, so "came off this descriptor" is checkable rather
    // than coincidentally equal to now.
    const when = new Date('2020-01-02T03:04:05Z');
    utimesSync(file, when, when);

    const opened = readContainedFile(file, MAX_LEDGER_BYTES);

    expect(opened.content).toBe('hello\nworld\n');
    expect(opened.size).toBe(12);
    expect(opened.mtimeMs).toBe(when.getTime());
  });

  it.skipIf(isWindows)('refuses a symlink to a real file', () => {
    const real = join(root, 'real.jsonl');
    writeFileSync(real, 'evidence');
    const link = join(root, 'link.jsonl');
    symlinkSync(real, link);

    // The link resolves to a perfectly readable file; that is the point. The
    // read is refused because of what the NAME is, not what it points at.
    expect(() => readContainedFile(link, MAX_LEDGER_BYTES)).toThrow(
      ContainedReadError,
    );
    expect(readContainedFileOrNull(link, MAX_LEDGER_BYTES)).toBeNull();
    expect(readContainedFileOrNull(real, MAX_LEDGER_BYTES)?.content).toBe(
      'evidence',
    );
  });

  it.skipIf(isWindows)(
    'refuses a FIFO without blocking on it',
    () => {
      const fifo = join(root, 'run-sessions.json');
      execFileSync('mkfifo', [fifo]);

      // The assertion is as much the test TIMING OUT as the value: a blocking
      // open on a FIFO with no writer never returns, and this suite would hang
      // rather than fail. Non-blocking, it comes back at once and `fstat`
      // rejects the type.
      const started = Date.now();
      expect(readContainedFileOrNull(fifo, MAX_LEDGER_BYTES)).toBeNull();
      expect(Date.now() - started).toBeLessThan(2000);

      try {
        readContainedFile(fifo, MAX_LEDGER_BYTES);
        expect.unreachable('a FIFO must not read as a contained file');
      } catch (err) {
        expect((err as ContainedReadError).reason).toBe('not-regular');
      }
    },
    5000,
  );

  it('skips a stale file without reading its bytes', () => {
    const file = join(root, 'agent-old.jsonl');
    writeFileSync(file, 'records from an earlier review in this session');
    const old = new Date('2020-01-02T03:04:05Z');
    utimesSync(file, old, old);

    const opened = readContainedFile(file, MAX_LEDGER_BYTES, {
      minMtimeMs: old.getTime() + 1,
    });

    // Metadata yes, bytes no: the membership fence is answered off the same
    // descriptor, which is what keeps a never-pruned session directory cheap.
    expect(opened.stale).toBe(true);
    expect(opened.mtimeMs).toBe(old.getTime());
    expect(opened.content).toBe('');
    expect(opened.size).toBe(0);

    // At the boundary the file is in scope and IS read: `<` not `<=`.
    const fresh = readContainedFile(file, MAX_LEDGER_BYTES, {
      minMtimeMs: old.getTime(),
    });
    expect(fresh.stale).toBeUndefined();
    expect(fresh.content).toContain('earlier review');
  });

  it('skips a stale file even when it is over the byte ceiling', () => {
    // Order matters: the staleness test comes first, so a huge stale file
    // costs an fstat rather than a refusal the caller has to disclose.
    const file = join(root, 'agent-huge.jsonl');
    writeFileSync(file, 'x'.repeat(64));
    const old = new Date('2020-01-02T03:04:05Z');
    utimesSync(file, old, old);

    const opened = readContainedFile(file, 8, {
      minMtimeMs: old.getTime() + 1,
    });
    expect(opened.stale).toBe(true);
  });

  it('refuses a directory', () => {
    const dir = join(root, 'subagents');
    mkdirSync(dir);
    expect(readContainedFileOrNull(dir, MAX_LEDGER_BYTES)).toBeNull();
  });

  it('refuses a file over the byte ceiling, without reading it', () => {
    const file = join(root, 'big.json');
    writeFileSync(file, 'x'.repeat(64));

    try {
      readContainedFile(file, 32);
      expect.unreachable('the ceiling must refuse');
    } catch (err) {
      expect((err as ContainedReadError).reason).toBe('too-large');
    }
    // One byte under is fine: the bound is a ceiling, not an approximation.
    expect(readContainedFile(file, 64).size).toBe(64);
  });

  it('reports a missing file as an open failure, not as empty content', () => {
    try {
      readContainedFile(join(root, 'nope.json'), MAX_LEDGER_BYTES);
      expect.unreachable('absent must not read as empty');
    } catch (err) {
      expect((err as ContainedReadError).reason).toBe('open-failed');
    }
  });
});

describe('containedDir', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'contained-dir-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts a real nested directory and returns its identity', () => {
    const dir = join(root, 'subagents', 'S-1');
    mkdirSync(dir, { recursive: true });

    const res = containedDir(root, dir);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.identity.ino).toBeGreaterThan(0);
    }
  });

  it('separates a missing directory from an uncontained one', () => {
    // The distinction the resume path depends on: a session directory that
    // does not exist yet is the ordinary pre-launch state and callers absorb
    // it; a redirected one must never hide inside that tolerance.
    const res = containedDir(root, join(root, 'subagents', 'S-absent'));
    expect(res).toEqual({ ok: false, reason: 'missing' });
  });

  it.skipIf(isWindows)('refuses a symlinked ANCESTOR', () => {
    // The shape a final-component check misses: every `subagents/<id>` under
    // this link stats as an ordinary directory, so validating the leaf alone
    // passes while the whole subtree has been redirected.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'elsewhere-')));
    mkdirSync(join(outside, 'S-1'), { recursive: true });
    symlinkSync(outside, join(root, 'subagents'));

    try {
      expect(containedDir(root, join(root, 'subagents', 'S-1'))).toEqual({
        ok: false,
        reason: 'uncontained',
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(isWindows)('refuses a symlinked final component', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'elsewhere-')));
    mkdirSync(join(root, 'subagents'));
    symlinkSync(outside, join(root, 'subagents', 'S-1'));

    try {
      expect(containedDir(root, join(root, 'subagents', 'S-1'))).toEqual({
        ok: false,
        reason: 'uncontained',
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a path outside the root by shape', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'outside-')));
    try {
      expect(containedDir(root, outside)).toEqual({
        ok: false,
        reason: 'uncontained',
      });
      // ...including one that only leaves via `..`.
      expect(containedDir(root, join(root, '..'))).toEqual({
        ok: false,
        reason: 'uncontained',
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a file standing where a directory must be', () => {
    const notDir = join(root, 'subagents');
    writeFileSync(notDir, 'not a directory');
    expect(containedDir(root, join(notDir, 'S-1'))).toEqual({
      ok: false,
      reason: 'uncontained',
    });
  });
});

describe('listContainedDir', () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'contained-list-')));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists a validated directory', () => {
    const dir = join(root, 'S-1');
    mkdirSync(dir);
    writeFileSync(join(dir, 'agent-a.jsonl'), '');
    const res = containedDir(root, dir);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(listContainedDir(dir, res.identity)).toEqual(['agent-a.jsonl']);
  });

  it('discards the listing when the directory is no longer the same one', () => {
    const dir = join(root, 'S-1');
    mkdirSync(dir);
    writeFileSync(join(dir, 'agent-a.jsonl'), '');

    // A swap between the walk and the listing: `readdirSync` resolves the name
    // again, so the entries could come from a different directory than the one
    // that was validated. A different inode is the detection.
    const identity = { dev: 1, ino: -1 };
    expect(listContainedDir(dir, identity)).toEqual([]);
  });
});

describe('containedRoot', () => {
  it('refuses a linked or absent root', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'contained-root-')));
    try {
      const real = join(base, 'project');
      mkdirSync(real);
      expect(containedRoot(real)).toBe(real);
      expect(containedRoot(join(base, 'missing'))).toBeNull();

      if (!isWindows) {
        const link = join(base, 'linked-project');
        symlinkSync(real, link);
        // The whole tree hangs off this: a linked project dir means nothing
        // below it can be called contained evidence.
        expect(containedRoot(link)).toBeNull();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
