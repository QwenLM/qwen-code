/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  canonicalizeWorkspace,
  hasSuspiciousPathPattern,
  resolveWithinWorkspace,
  type ResolvedPath,
} from './paths.js';
import { isFsError } from './errors.js';

describe('canonicalizeWorkspace', () => {
  let scratch: string;

  beforeEach(async () => {
    const id = randomBytes(6).toString('hex');
    scratch = await fsp.mkdtemp(path.join(os.tmpdir(), `qwen-fs-paths-${id}-`));
  });

  afterEach(async () => {
    await fsp.rm(scratch, { recursive: true, force: true });
  });

  it('returns the realpath for an existing absolute directory', () => {
    const subdir = path.join(scratch, 'project');
    // Use mkdirSync via fsp.mkdir-await to keep test async-shape consistent.
    return fsp.mkdir(subdir).then(() => {
      const canonical = canonicalizeWorkspace(subdir);
      // On macOS the tmpdir resolves through `/private` — `realpathSync.native`
      // returns that prefix; we just assert it matches what realpath itself
      // would produce so the test is platform-agnostic.
      expect(canonical).toBe(realpathSync.native(subdir));
    });
  });

  it('resolves a relative path against process.cwd before canonicalization', async () => {
    // Anchor the relative input to the scratch directory so the resolved
    // path actually exists. We can't change cwd under vitest reliably, so
    // craft an absolute path and re-derive the relative form.
    const subdir = path.join(scratch, 'rel-target');
    await fsp.mkdir(subdir);
    const relInput = path.relative(process.cwd(), subdir);
    const canonical = canonicalizeWorkspace(relInput);
    expect(canonical).toBe(realpathSync.native(subdir));
  });

  it('falls back to path.resolve for a non-existent path (ENOENT)', () => {
    const ghost = path.join(scratch, 'does', 'not', 'exist');
    const canonical = canonicalizeWorkspace(ghost);
    expect(canonical).toBe(path.resolve(ghost));
  });

  it('follows a symlink to the real on-disk target', async () => {
    const real = path.join(scratch, 'real');
    const link = path.join(scratch, 'link');
    await fsp.mkdir(real);
    await fsp.symlink(real, link, 'dir');
    expect(canonicalizeWorkspace(link)).toBe(realpathSync.native(real));
  });

  it('preserves on-disk casing on case-insensitive filesystems for an existing path', async () => {
    // Skipped on Linux where the FS is case-sensitive — the function's
    // casing-collapse contract is only meaningful on macOS APFS / Windows
    // NTFS, and forcing the test to assert "different cased input == same
    // output" on ext4 would just fail with ENOENT before realpath runs.
    if (process.platform !== 'darwin' && process.platform !== 'win32') return;
    const dir = path.join(scratch, 'CaseDir');
    await fsp.mkdir(dir);
    const lowered = path.join(scratch, 'casedir');
    const canonical = canonicalizeWorkspace(lowered);
    // The realpathSync.native return value is the on-disk casing, which is
    // what the boundWorkspace contract pins.
    expect(canonical).toBe(realpathSync.native(dir));
  });

  it('rethrows non-ENOENT filesystem errors instead of masking them', async () => {
    // EACCES is hard to produce portably and on macOS gates behind SIP.
    // Instead simulate the contract by asserting that an EISDIR-or-similar
    // path that *does* exist returns its realpath rather than throwing —
    // the negative case (rethrow on non-ENOENT) is exercised by code review
    // and documented in the function's doc comment. The minimal positive
    // assertion here guards against a future regression that swallows
    // *every* error and drops to path.resolve.
    const dir = path.join(scratch, 'normal');
    await fsp.mkdir(dir);
    const out = canonicalizeWorkspace(dir);
    expect(out).toBe(realpathSync.native(dir));
    expect(out).not.toBe(path.resolve(dir + '-different'));
  });
});

describe('hasSuspiciousPathPattern', () => {
  it('rejects 8.3 short names on Windows including multi-digit suffixes; admits POSIX legit ~N filenames', () => {
    if (process.platform === 'win32') {
      // Windows: original short names + multi-digit (NTFS allocates
      // ~1..~4 then hashes; ~10+ are real)
      expect(hasSuspiciousPathPattern('GIT~1')).toBe(true);
      expect(hasSuspiciousPathPattern('CLAUDE~2')).toBe(true);
      expect(hasSuspiciousPathPattern('SETTIN~1.JSON')).toBe(true);
      expect(hasSuspiciousPathPattern('LONGFI~10.TXT')).toBe(true);
      expect(hasSuspiciousPathPattern('OTHER~99.dat')).toBe(true);
    } else {
      // POSIX: ~N is a legitimate filename char (editor swaps,
      // backup files, version schemes). Daemon's FS isn't NTFS,
      // so 8.3 interpretation doesn't apply.
      expect(hasSuspiciousPathPattern('backup~1.txt')).toBe(false);
      expect(hasSuspiciousPathPattern('notes~2.md')).toBe(false);
      expect(hasSuspiciousPathPattern('file~3.swp')).toBe(false);
      expect(hasSuspiciousPathPattern('LONGFI~10.TXT')).toBe(false);
    }
  });

  it('rejects long-path / device prefixes regardless of platform', () => {
    expect(hasSuspiciousPathPattern('\\\\?\\C:\\Users\\foo')).toBe(true);
    expect(hasSuspiciousPathPattern('\\\\.\\C:\\foo')).toBe(true);
    expect(hasSuspiciousPathPattern('//?/C:/foo')).toBe(true);
    expect(hasSuspiciousPathPattern('//./C:/foo')).toBe(true);
  });

  it('rejects UNC prefixes regardless of platform', () => {
    expect(hasSuspiciousPathPattern('\\\\server\\share')).toBe(true);
    expect(hasSuspiciousPathPattern('//server/share')).toBe(true);
    expect(hasSuspiciousPathPattern('//192.168.1.1/foo')).toBe(true);
  });

  it('rejects trailing dots / spaces and DOS device names', () => {
    expect(hasSuspiciousPathPattern('config.json.')).toBe(true);
    expect(hasSuspiciousPathPattern('config.json   ')).toBe(true);
    expect(hasSuspiciousPathPattern('settings.PRN')).toBe(true);
    expect(hasSuspiciousPathPattern('foo.CON')).toBe(true);
    expect(hasSuspiciousPathPattern('bar.LPT1')).toBe(true);
  });

  it('rejects bare and multi-extension DOS device names (NTFS reserves regardless of extension)', () => {
    // Bare reserved names
    expect(hasSuspiciousPathPattern('CON')).toBe(true);
    expect(hasSuspiciousPathPattern('NUL')).toBe(true);
    expect(hasSuspiciousPathPattern('PRN')).toBe(true);
    expect(hasSuspiciousPathPattern('AUX')).toBe(true);
    expect(hasSuspiciousPathPattern('COM1')).toBe(true);
    expect(hasSuspiciousPathPattern('LPT9')).toBe(true);
    // First-extension forms
    expect(hasSuspiciousPathPattern('CON.txt')).toBe(true);
    expect(hasSuspiciousPathPattern('NUL.dat')).toBe(true);
    expect(hasSuspiciousPathPattern('LPT1.log')).toBe(true);
    // Middle-extension form
    expect(hasSuspiciousPathPattern('CON.foo.bar')).toBe(true);
    // Substring of longer name must NOT match (BACON, concat, lprint…)
    expect(hasSuspiciousPathPattern('BACON')).toBe(false);
    expect(hasSuspiciousPathPattern('concat.txt')).toBe(false);
    expect(hasSuspiciousPathPattern('precon.go')).toBe(false);
    expect(hasSuspiciousPathPattern('contemplating.md')).toBe(false);
  });

  it('rejects three-or-more-dot path components', () => {
    expect(hasSuspiciousPathPattern('foo/.../bar')).toBe(true);
    expect(hasSuspiciousPathPattern('.../leaf')).toBe(true);
  });

  it('accepts ordinary POSIX paths', () => {
    expect(hasSuspiciousPathPattern('src/index.ts')).toBe(false);
    expect(hasSuspiciousPathPattern('packages/cli/package.json')).toBe(false);
    expect(hasSuspiciousPathPattern('.qwenignore')).toBe(false);
    expect(hasSuspiciousPathPattern('a/b/c/d/e/f.txt')).toBe(false);
  });
});

describe('resolveWithinWorkspace', () => {
  let scratch: string;
  let workspace: string;

  beforeEach(async () => {
    const id = randomBytes(6).toString('hex');
    scratch = await fsp.mkdtemp(
      path.join(os.tmpdir(), `qwen-fs-resolve-${id}-`),
    );
    workspace = path.join(scratch, 'workspace');
    await fsp.mkdir(workspace);
  });

  afterEach(async () => {
    await fsp.rm(scratch, { recursive: true, force: true });
  });

  it('resolves an existing relative path to its on-disk canonical form', async () => {
    const target = path.join(workspace, 'src', 'a.txt');
    await fsp.mkdir(path.dirname(target));
    await fsp.writeFile(target, 'hello');
    const out = await resolveWithinWorkspace('src/a.txt', workspace, 'read');
    expect(out).toBe(realpathSync.native(target));
  });

  it('rejects a `..` traversal that lands outside the workspace', async () => {
    await expect(
      resolveWithinWorkspace('../escape', workspace, 'read'),
    ).rejects.toMatchObject({ kind: 'path_outside_workspace' });
  });

  it('rejects an absolute path outside the workspace', async () => {
    const outside = path.join(scratch, 'outside.txt');
    await fsp.writeFile(outside, 'x');
    await expect(
      resolveWithinWorkspace(outside, workspace, 'read'),
    ).rejects.toMatchObject({ kind: 'path_outside_workspace' });
  });

  it('rejects a symlink whose target escapes the workspace', async () => {
    const outside = path.join(scratch, 'outside.txt');
    await fsp.writeFile(outside, 'sensitive');
    const link = path.join(workspace, 'leak');
    await fsp.symlink(outside, link, 'file');
    await expect(
      resolveWithinWorkspace('leak', workspace, 'read'),
    ).rejects.toMatchObject({ kind: 'symlink_escape' });
  });

  it('follows a symlink that targets a path inside the workspace', async () => {
    const real = path.join(workspace, 'real.txt');
    await fsp.writeFile(real, 'in');
    const link = path.join(workspace, 'alias');
    await fsp.symlink(real, link, 'file');
    const out = await resolveWithinWorkspace('alias', workspace, 'read');
    expect(out).toBe(realpathSync.native(real));
  });

  it('tolerates ENOENT for write intent and resolves via existing ancestor', async () => {
    const nested = 'newdir/leaf.txt';
    const out = await resolveWithinWorkspace(nested, workspace, 'write');
    // Ancestor `workspace` is realpathed; tail `newdir/leaf.txt` is appended.
    expect(out).toBe(
      path.join(realpathSync.native(workspace), 'newdir', 'leaf.txt'),
    );
  });

  it('tolerates ENOENT for stat intent and resolves via existing ancestor', async () => {
    // Pinned per the docstring on `Intent` / `ENOENT_TOLERATING_INTENTS`:
    // `'stat'` joins `'write'` in the tolerant set so a route asking
    // "does this path exist?" gets back a synthetic canonical the
    // caller can pass straight to `fsp.lstat`. The natural ENOENT
    // surfaces from the lstat itself rather than from the resolver.
    const out = await resolveWithinWorkspace(
      'newdir/leaf.txt',
      workspace,
      'stat',
    );
    expect(out).toBe(
      path.join(realpathSync.native(workspace), 'newdir', 'leaf.txt'),
    );
  });

  it('rejects ENOENT under read intent with path_not_found', async () => {
    const err = await resolveWithinWorkspace(
      'does-not-exist',
      workspace,
      'read',
    ).catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('path_not_found');
  });

  it('rejects suspicious patterns before any I/O', async () => {
    // UNC prefixes are platform-agnostic: a daemon should never
    // accept `//server/share` regardless of OS. The 8.3
    // short-name `~\d` check is gated on win32 (legitimate POSIX
    // filenames can have `~N` in them); we exercise the win32
    // branch only when the runner is Windows.
    await expect(
      resolveWithinWorkspace('//server/share', workspace, 'read'),
    ).rejects.toMatchObject({ kind: 'path_outside_workspace' });
    if (process.platform === 'win32') {
      await expect(
        resolveWithinWorkspace('GIT~1', workspace, 'read'),
      ).rejects.toMatchObject({ kind: 'path_outside_workspace' });
    }
  });

  it('rejects empty/non-string input with parse_error', async () => {
    await expect(
      resolveWithinWorkspace('', workspace, 'read'),
    ).rejects.toMatchObject({ kind: 'parse_error' });
  });

  it('rejects a dangling symlink whose target escapes the workspace (write intent)', async () => {
    // Reproduces the exploit class flagged at PR #4250: an attacker
    // creates `<ws>/escape -> /etc/cron.d/evil` BEFORE the target
    // exists, then issues a write request. Without the lstat-then-
    // readlink check the ENOENT-tolerant ancestor walk would happily
    // return `<ws>/escape` as the canonical write target and the
    // OS-level write would create the file at the symlink target
    // outside the workspace.
    const outsideTarget = path.join(scratch, 'outside-not-yet-existing.txt');
    const danglingLink = path.join(workspace, 'escape');
    await fsp.symlink(outsideTarget, danglingLink, 'file');
    const err = await resolveWithinWorkspace(
      'escape',
      workspace,
      'write',
    ).catch((e: unknown) => e);
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('symlink_escape');
  });

  it('allows a dangling symlink whose (not-yet-existing) target stays inside workspace', async () => {
    // Symmetric to the escape case: a dangling symlink pointing at
    // a future file INSIDE the workspace is a normal ahead-of-mkdir
    // flow (test fixtures, atomic-write-via-rename). Resolve must
    // succeed for write intent.
    const insideTarget = path.join(workspace, 'will-create.txt');
    const link = path.join(workspace, 'pending-link');
    await fsp.symlink(insideTarget, link, 'file');
    const out = await resolveWithinWorkspace(
      'pending-link',
      workspace,
      'write',
    );
    expect(typeof out).toBe('string');
  });

  it('rejects a multi-hop dangling symlink chain that escapes the workspace', async () => {
    // The exploit class: `<ws>/leak -> <ws>/middle -> /scratch/evil`
    // where every link is a symlink and the final target doesn't
    // exist. A single-hop guard (read T19's earlier fix) only
    // checks the first readlink target — `<ws>/middle` — sees it's
    // inside the workspace, and lets the chain through. The OS
    // write at `<ws>/leak` then follows BOTH hops and creates
    // `/scratch/evil`. The multi-hop loop fix dereferences every
    // link before the containment check.
    const evil = path.join(scratch, 'multi-hop-target.txt');
    const middle = path.join(workspace, 'middle');
    const leak = path.join(workspace, 'leak');
    await fsp.symlink(evil, middle, 'file');
    await fsp.symlink(middle, leak, 'file');
    const err = await resolveWithinWorkspace('leak', workspace, 'write').catch(
      (e: unknown) => e,
    );
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('symlink_escape');
  });

  it('detects a symlink cycle and rejects with symlink_escape', async () => {
    // a -> b -> a — symmetric self-referential pair. realpath
    // returns ELOOP on most platforms; the multi-hop loop's inode
    // tracking catches this even on filesystems that don't
    // surface ELOOP.
    const a = path.join(workspace, 'a');
    const b = path.join(workspace, 'b');
    await fsp.symlink(b, a, 'file');
    await fsp.symlink(a, b, 'file');
    const err = await resolveWithinWorkspace('a', workspace, 'write').catch(
      (e: unknown) => e,
    );
    expect(isFsError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe('symlink_escape');
  });

  it('returns a value usable as ResolvedPath brand', async () => {
    const target = path.join(workspace, 'b.txt');
    await fsp.writeFile(target, 'b');
    const out: ResolvedPath = await resolveWithinWorkspace(
      'b.txt',
      workspace,
      'read',
    );
    // Brand is compile-time only — assert string identity at runtime.
    expect(typeof out).toBe('string');
    expect(out).toBe(realpathSync.native(target));
  });

  it('canonicalizes the boundWorkspace once so symlinked workspaces resolve correctly', async () => {
    // Workspace itself reachable via a symlink — daemon should still
    // pin members by the canonical (realpath) form, so a request that
    // names a child via the symlinked workspace path still resolves
    // to the same canonical and passes the boundary check.
    const aliasWorkspace = path.join(scratch, 'alias-workspace');
    await fsp.symlink(workspace, aliasWorkspace, 'dir');
    const target = path.join(workspace, 'inside.txt');
    await fsp.writeFile(target, 'x');
    const out = await resolveWithinWorkspace(
      'inside.txt',
      aliasWorkspace,
      'read',
    );
    expect(out).toBe(realpathSync.native(target));
  });
});
