// Copyright 2026 Qwen Team
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { PathOrFileDescriptor, WriteFileOptions } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanupReviewWorktreeLeases,
  recordReviewWorktreeLeaseMergeBase,
  restoreReviewWorktreeLeaseMergeBase,
  clearReviewWorktreeLease,
  clearReviewWorktreeLeaseIfOwned,
  createReviewWorktreeLease,
  isReviewLeaseFile,
  readReviewWorktreeLease,
  readReviewWorktreeLeaseAt,
  reviewLeaseHeldByAnotherSession,
  reviewLeasePath,
  type ReviewWorktreeLease,
} from './review-worktree-lease.js';

// Set from exactly one test: plants a foreign lease at the legacy path at
// the moment the new-path lease write happens — the "appears between the
// lease write and the mirror write" interleaving the mirror's EEXIST arm
// exists for, which no in-process fixture can otherwise produce because the
// acquisition sequence is synchronous.
const fsMockState = vi.hoisted(() => ({
  plantBeforeNewPathWrite: null as {
    newLeasePath: string;
    plantDir: string;
    plantPath: string;
    plantContents: string;
    plantMtime: Date;
  } | null,
  readdirFailureDir: null as string | null,
  // Set from exactly one test: the mirror's rename and tmp cleanup BOTH
  // fail — the shape the "never fatal" contract exists for.
  failMirrorRenameFrom: null as string | null,
  failRmOn: null as string | null,
}));

// The execFileSync wrapper: counts the finalizer's destructive git calls (one
// pass per lease is the R28-5 invariant) and fails a bounded number of
// `worktree` verbs so a partway-failed finalize can be staged. Everything
// else delegates — the fixtures are real repositories.
const execStub = vi.hoisted(() => ({
  worktreeRemoveCalls: [] as string[][],
  failWorktreeVerbs: 0,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: ((
      file: string,
      args: string[],
      options?: Parameters<typeof actual.execFileSync>[2],
    ) => {
      if (file === 'git' && Array.isArray(args) && args.includes('worktree')) {
        if (args.includes('remove')) execStub.worktreeRemoveCalls.push(args);
        if (execStub.failWorktreeVerbs > 0) {
          execStub.failWorktreeVerbs--;
          throw Object.assign(new Error('stubbed git failure'), {
            status: 1,
          });
        }
      }
      return actual.execFileSync(file, args, options as never);
    }) as typeof actual.execFileSync,
  };
});

// The mirror's warnings ride the safe stderr writer; spied here so a
// displacement or a skipped mirror is asserted LOUD, not merely non-fatal.
const stdioSpy = vi.hoisted(() => ({ writeStderrLineSafe: vi.fn() }));

vi.mock('../utils/stdioHelpers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/stdioHelpers.js')>()),
  writeStderrLineSafe: stdioSpy.writeStderrLineSafe,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (
      path: PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: WriteFileOptions,
    ) => {
      const plant = fsMockState.plantBeforeNewPathWrite;
      if (plant && String(path) === plant.newLeasePath) {
        fsMockState.plantBeforeNewPathWrite = null;
        actual.mkdirSync(plant.plantDir, { recursive: true });
        actual.writeFileSync(plant.plantPath, plant.plantContents);
        actual.utimesSync(plant.plantPath, plant.plantMtime, plant.plantMtime);
      }
      return actual.writeFileSync(path, data, options);
    },
    readdirSync: ((path: string) => {
      if (fsMockState.readdirFailureDir === path) {
        throw Object.assign(new Error('EACCES: permission denied'), {
          code: 'EACCES',
        });
      }
      return actual.readdirSync(path);
    }) as typeof actual.readdirSync,
    renameSync: ((oldPath: string, newPath: string) => {
      if (
        fsMockState.failMirrorRenameFrom !== null &&
        String(oldPath).startsWith(fsMockState.failMirrorRenameFrom)
      ) {
        throw Object.assign(new Error('EPERM: operation not permitted'), {
          code: 'EPERM',
        });
      }
      return actual.renameSync(oldPath, newPath);
    }) as typeof actual.renameSync,
    rmSync: ((
      path: Parameters<typeof actual.rmSync>[0],
      options?: Parameters<typeof actual.rmSync>[1],
    ) => {
      if (
        fsMockState.failRmOn !== null &&
        String(path).startsWith(fsMockState.failRmOn)
      ) {
        throw Object.assign(new Error('EBUSY: resource busy'), {
          code: 'EBUSY',
        });
      }
      return actual.rmSync(path, options);
    }) as typeof actual.rmSync,
  };
});

const roots: string[] = [];

function createRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'review-lease-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-qm', 'init']);
  return root;
}

afterEach(() => {
  fsMockState.plantBeforeNewPathWrite = null;
  fsMockState.readdirFailureDir = null;
  fsMockState.failMirrorRenameFrom = null;
  fsMockState.failRmOn = null;
  execStub.worktreeRemoveCalls.length = 0;
  execStub.failWorktreeVerbs = 0;
  stdioSpy.writeStderrLineSafe.mockClear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Write a lease at the pre-move path, optionally backdating its mtime. */
function writeLegacyLease(lease: ReviewWorktreeLease, mtime?: Date): string {
  const path = join(
    lease.repositoryRoot,
    '.qwen',
    'tmp',
    `qwen-review-lease-${lease.target}.json`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(lease)}\n`);
  if (mtime) utimesSync(path, mtime, mtime);
  return path;
}

describe('review worktree leases', () => {
  it('protects a worktree created after the lease is registered', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });

    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(false);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('');
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(false);
  });

  it('falls back to removing an unregistered worktree directory', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, 'marker'), 'remove');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(false);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('');
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(false);
  });

  it('keeps the lease when fallback pruning fails', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(worktree, { recursive: true });
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });
    renameSync(join(root, '.git'), join(root, '.git-hidden'));

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(false);
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(true);
  });

  it('removes only worktrees owned by the completed session', () => {
    const root = createRepository();
    const owned = join(root, '.qwen', 'tmp', 'review-pr-1');
    const other = join(root, '.qwen', 'tmp', 'review-pr-2');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-2']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      owned,
      'qwen-review/pr-1',
    ]);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      other,
      'qwen-review/pr-2',
    ]);

    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: owned,
      branch: 'qwen-review/pr-1',
    });
    createReviewWorktreeLease({
      sessionId: 'session-b',
      promptId: 'prompt-parent',
      target: 'pr-2',
      repositoryRoot: root,
      worktreePath: other,
      branch: 'qwen-review/pr-2',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(owned)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('');
    expect(
      readFileSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-2.json'),
        'utf8',
      ),
    ).toContain('session-b');
  });

  it('does not let a child prompt clean up its parent review lease', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-child',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(true);
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(true);
  });

  it('does not remove a path outside the review temp directory', () => {
    const root = createRepository();
    const outside = join(root, 'keep-me');
    mkdirSync(outside);
    writeFileSync(join(outside, 'marker'), 'keep');
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: outside,
      branch: 'qwen-review/pr-1',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(readFileSync(join(outside, 'marker'), 'utf8')).toBe('keep');
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(true);
  });

  it('ignores a lease whose branch does not match its PR target', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'keep-me']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'keep-me',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'keep-me',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(true);
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(true);
  });

  it('does not derive lease paths from invalid targets', () => {
    const root = createRepository();
    const marker = join(root, 'keep.json');
    writeFileSync(marker, 'keep');

    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: '../../../keep',
      repositoryRoot: root,
      worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });
    clearReviewWorktreeLease(root, '../../../keep');

    expect(readFileSync(marker, 'utf8')).toBe('keep');
    expect(existsSync(join(root, '.qwen', 'tmp'))).toBe(false);
  });

  it('lets explicit review cleanup disarm the finalizer', () => {
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });

    clearReviewWorktreeLease(root, 'pr-1');
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(false);
    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(true);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toContain('qwen-review/pr-1');
  });
});

describe('the move out of the mounted directory', () => {
  it('replaces the superseded legacy lease with the mirror, directory or not', () => {
    const root = createRepository();
    const legacy = (t: string) =>
      join(root, '.qwen', 'tmp', `qwen-review-lease-${t}.json`);
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(legacy('pr-2'), '{}');
    // The wedge shape: a DIRECTORY where the old lease file was. A
    // non-recursive remove throws EISDIR out of acquisition, and nothing
    // else removes it — the sweep skips the lease shape and `rm -f` cannot
    // remove a directory — so every review of that PR used to fail on this
    // machine.
    mkdirSync(legacy('pr-1'), { recursive: true });

    createReviewWorktreeLease({
      sessionId: 's',
      promptId: 'p',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });

    // The wedge directory is gone, replaced by this session's mirror so
    // pre-move builds can see the lock.
    const mirror = JSON.parse(readFileSync(legacy('pr-1'), 'utf8')) as {
      sessionId?: string;
    };
    expect(mirror.sessionId).toBe('s');
    // Scoped: another target's legacy lease is not this call's to touch.
    expect(readFileSync(legacy('pr-2'), 'utf8')).toBe('{}');
    // ...and the new one is written where nothing mounts.
    expect(
      existsSync(
        join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(true);
  });

  it('clears loudly, never fatally, when the legacy delete is wedged (R32-4)', () => {
    // The legacy name is the one entry the clear path touches inside the
    // directory reviewed code can write, and it is deleted AFTER the trusted
    // lease is already released. `force` swallows ENOENT only: a mode-500
    // directory planted at that name throws EACCES, and an open handle on
    // Windows throws the same. Thrown, it leaves `runCleanup` — pinned by
    // its own tests as never throwing — reporting failure over a release
    // that succeeded, with every retry re-throwing.
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-a',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });
    const trusted = reviewLeasePath(root, 'pr-1');
    const legacy = join(root, '.qwen', 'tmp', 'qwen-review-lease-pr-1.json');
    // The mirror the acquisition just wrote is what the wedge sits on. The
    // fs seam, not `chmod`: this suite runs as root in CI images, where mode
    // bits stop nothing.
    expect(existsSync(legacy)).toBe(true);
    fsMockState.failRmOn = legacy;

    expect(() => clearReviewWorktreeLease(root, 'pr-1')).not.toThrow();

    // The order the finding is about: the trusted lease was released first,
    // so a throw here would have stranded the release half-reported.
    expect(existsSync(trusted)).toBe(false);
    expect(existsSync(legacy)).toBe(true);
    const warnings = stdioSpy.writeStderrLineSafe.mock.calls.map(([m]) => m);
    expect(
      warnings.some((m) => m.includes(legacy) && m.includes('EBUSY')),
    ).toBe(true);
  });
});

describe('a pre-move lease file at the legacy path (R30-7)', () => {
  it('carries no gate authority, whatever its mtime: acquisition proceeds, replaces it, and warns', () => {
    // The honored-read window was bounded by a cutoff pinned to the move's
    // landing date, so it covered only locks written BEFORE that date — a
    // population frozen at release, while every old build acquiring after
    // it wrote a fresh-mtime lease the bound declined to honor anyway. What
    // the arm still did was hand the mount a denial of service: the legacy
    // path is the one directory reviewed code can write, `utimes`
    // backdating is a syscall away, and an honored plant naming a foreign
    // session wedged the target for every later run until a human deleted
    // it. So the file below is maximally backdated AND foreign — and it
    // still blocks nothing. It is replaced by this session's mirror (the
    // thing pre-move builds read), and the displacement is loud, because
    // the one honest way to produce that file is a crash-interrupted old
    // build whose state the next sweep now treats as stale.
    const root = createRepository();
    const worktreePath = join(root, '.qwen', 'tmp', 'review-pr-1');
    const legacy = writeLegacyLease(
      {
        sessionId: 'older-build-session',
        promptId: 'older-prompt',
        target: 'pr-1',
        repositoryRoot: root,
        worktreePath,
        branch: 'qwen-review/pr-1',
      },
      // Pre-move age buys nothing: no mtime grants mount-resident content
      // gate authority.
      new Date(0),
    );

    createReviewWorktreeLease({
      sessionId: 'newer-build-session',
      promptId: 'newer-prompt',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath,
      branch: 'qwen-review/pr-1',
    });

    // Acquisition proceeded and the new-path lease is this session's.
    expect(readReviewWorktreeLease(root, 'pr-1')?.sessionId).toBe(
      'newer-build-session',
    );
    // The foreign file was REPLACED by the mirror, not honored.
    const mirror = JSON.parse(
      readFileSync(legacy, 'utf8'),
    ) as ReviewWorktreeLease;
    expect(mirror.sessionId).toBe('newer-build-session');
    // ...loudly, naming the file and the session it displaced.
    const warnings = stdioSpy.writeStderrLineSafe.mock.calls.map(([m]) => m);
    expect(
      warnings.some(
        (m) => m.includes(legacy) && m.includes('older-build-session'),
      ),
    ).toBe(true);
  });

  it('neutralises the displaced session id before it reaches a terminal (R32-3)', () => {
    // The id is parsed out of a file in the one directory reviewed code can
    // write, and the warning interpolates it. Unneutralised, a newline in it
    // forges a second stderr line — a `::error::` workflow command of its
    // own under Actions — and a raw ESC is an SGR sequence that repaints the
    // rest of the operator's terminal.
    const root = createRepository();
    const worktreePath = join(root, '.qwen', 'tmp', 'review-pr-1');
    const legacy = writeLegacyLease({
      sessionId: 'older-build-session\n::error::forged\u001b[31m\u202ereversed',
      promptId: 'older-prompt',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath,
      branch: 'qwen-review/pr-1',
    });

    createReviewWorktreeLease({
      sessionId: 'newer-build-session',
      promptId: 'newer-prompt',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath,
      branch: 'qwen-review/pr-1',
    });

    const warnings = stdioSpy.writeStderrLineSafe.mock.calls.map(([m]) => m);
    const displacement = warnings.find((m: string) => m.includes(legacy));
    expect(displacement).toBeDefined();
    // Every dangerous class the id carried is gone...
    expect(displacement).not.toContain('\n');
    expect(displacement).not.toContain('\r');
    expect(displacement).not.toContain('\u001b');
    expect(displacement).not.toContain('\u202e');
    // ...and no forged line stands on its own.
    expect(displacement!.startsWith('::error::')).toBe(false);
    // ...while the warning still names the run it displaced, which is what
    // an operator recognises it by.
    expect(displacement).toContain('older-build-session');
  });

  it('bounds the displaced session id — a name, not a payload (R32-3)', () => {
    const root = createRepository();
    const worktreePath = join(root, '.qwen', 'tmp', 'review-pr-1');
    const legacy = writeLegacyLease({
      sessionId: 'x'.repeat(5_000),
      promptId: 'older-prompt',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath,
      branch: 'qwen-review/pr-1',
    });

    createReviewWorktreeLease({
      sessionId: 'newer-build-session',
      promptId: 'newer-prompt',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath,
      branch: 'qwen-review/pr-1',
    });

    const displacement = stdioSpy.writeStderrLineSafe.mock.calls
      .map(([m]) => m as string)
      .find((m: string) => m.includes(legacy));
    expect(displacement).toBeDefined();
    expect(/x{200,}/.test(displacement!)).toBe(false);
    expect(displacement).toContain('…');
  });

  it('is invisible to the gate read — the found-at answer is the new path or nothing', () => {
    // fetch-pr's refusal message names `holder.path`; letting a legacy file
    // answer here both wedges the target on mount-resident content and
    // points recovery at a file the new build never wrote.
    const root = createRepository();
    writeLegacyLease(
      {
        sessionId: 'session-a',
        promptId: 'prompt-a',
        target: 'pr-1',
        repositoryRoot: root,
        worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
        branch: 'qwen-review/pr-1',
      },
      new Date(0),
    );
    expect(readReviewWorktreeLeaseAt(root, 'pr-1')).toBeNull();
  });
});

describe('the one-release rollout window', () => {
  const acquire = (root: string) => ({
    sessionId: 'session-a',
    promptId: 'prompt-a',
    target: 'pr-1',
    repositoryRoot: root,
    worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
    branch: 'qwen-review/pr-1',
  });
  const legacyPathFor = (root: string) =>
    join(root, '.qwen', 'tmp', 'qwen-review-lease-pr-1.json');

  it('mirrors the lease at the legacy path for pre-move builds', () => {
    // A build from before the move reads ONLY `.qwen/tmp`; without the mirror
    // it passes its own gate over this live lease for the whole rollout
    // window, and its cleanStale force-removes this session's worktree and
    // deletes its branch mid-run — #9205 in the mirrored direction, and
    // unannounced, because this session's rollback clears only the new path.
    const root = createRepository();
    createReviewWorktreeLease(acquire(root));

    const mirror = JSON.parse(
      readFileSync(legacyPathFor(root), 'utf8'),
    ) as ReviewWorktreeLease;
    expect(mirror.sessionId).toBe('session-a');
    expect(mirror.promptId).toBe('prompt-a');
    expect(mirror.worktreePath).toBe(join(root, '.qwen', 'tmp', 'review-pr-1'));
  });

  it('the mirror is never fatal — not even when the rename AND the tmp cleanup both fail', () => {
    // Mount weather is not a verdict: the legacy path lives in the mounted
    // directory, so a rename failure there (a lock, EACCES) must not roll
    // back an acquisition that already won — and the tmp cleanup behind it
    // must not throw either, or the "never fatal" contract is broken one
    // failure deeper.
    const root = createRepository();
    const legacy = legacyPathFor(root);
    writeLegacyLease(acquire(root)); // something stands at the name
    fsMockState.failMirrorRenameFrom = legacy;
    fsMockState.failRmOn = legacy;

    expect(() => createReviewWorktreeLease(acquire(root))).not.toThrow();
    // The acquisition stands on the new path.
    expect(readReviewWorktreeLease(root, 'pr-1')?.sessionId).toBe('session-a');
    // And the skip was announced, not silent.
    expect(stdioSpy.writeStderrLineSafe).toHaveBeenCalledWith(
      expect.stringContaining('could not mirror'),
    );
  });

  it('displaces a foreign lease surfacing mid-acquisition — warned, never a back-out', () => {
    // A foreign lease landing at the legacy path between the new-path write
    // and the mirror used to back the whole acquisition out: the new-path
    // lease was released and the run failed, on the say-so of content
    // written INSIDE the mount — a plant could fail every acquisition of a
    // target forever. With the legacy path carrying no authority (R30-7)
    // the acquisition stands, the plant is replaced by this session's
    // mirror, and the displacement is warned about rather than silent.
    const root = createRepository();
    const legacy = legacyPathFor(root);
    fsMockState.plantBeforeNewPathWrite = {
      newLeasePath: reviewLeasePath(root, 'pr-1'),
      plantDir: dirname(legacy),
      plantPath: legacy,
      plantContents: `${JSON.stringify({
        sessionId: 'older-build-session',
        promptId: 'older-prompt',
        target: 'pr-1',
        repositoryRoot: root,
        worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
        branch: 'qwen-review/pr-1',
      })}\n`,
      plantMtime: new Date(0),
    };

    createReviewWorktreeLease(acquire(root));

    // The acquisition STANDS: the new-path lease was not released.
    expect(readReviewWorktreeLease(root, 'pr-1')?.sessionId).toBe('session-a');
    // The plant was replaced by this session's mirror, with a warning
    // naming the displaced session.
    const mirror = JSON.parse(
      readFileSync(legacy, 'utf8'),
    ) as ReviewWorktreeLease;
    expect(mirror.sessionId).toBe('session-a');
    const warnings = stdioSpy.writeStderrLineSafe.mock.calls.map(([m]) => m);
    expect(warnings.some((m) => m.includes('older-build-session'))).toBe(true);
  });

  it('refreshes this session’s own earlier mirror quietly', () => {
    // A re-fetch re-runs acquisition over its own mirror: nothing is
    // displaced, so nothing is announced — a warning on the routine path
    // would teach the operator to ignore the one that matters.
    const root = createRepository();
    createReviewWorktreeLease(acquire(root));
    stdioSpy.writeStderrLineSafe.mockClear();

    createReviewWorktreeLease(acquire(root));

    expect(readReviewWorktreeLease(root, 'pr-1')?.sessionId).toBe('session-a');
    expect(JSON.parse(readFileSync(legacyPathFor(root), 'utf8'))).toMatchObject(
      { sessionId: 'session-a' },
    );
    expect(stdioSpy.writeStderrLineSafe).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'treats a FIFO planted at the legacy lease path as no lease instead of hanging',
    { timeout: 10_000 },
    () => {
      // `readFileSync` blocks in open(2) on a FIFO with no timeout. The gate
      // read never consults the legacy path at all (R30-7) — a FIFO there
      // cannot hang it — but the acquisition mirror must still REMOVE the
      // wedge rather than merely step around it: nothing else ever would,
      // and a name the mirror cannot take is a name every later run trips
      // on. The removal is readLease's lstat guard, reached through the
      // mirror's EEXIST arm.
      const root = createRepository();
      const legacy = legacyPathFor(root);
      mkdirSync(dirname(legacy), { recursive: true });
      execFileSync('mkfifo', [legacy]);

      expect(readReviewWorktreeLease(root, 'pr-1')).toBeNull();
      // Untouched by the read: the legacy path is never consulted, so the
      // plant wields no authority AND no hang.
      expect(existsSync(legacy)).toBe(true);

      createReviewWorktreeLease(acquire(root));
      expect(readReviewWorktreeLease(root, 'pr-1')?.sessionId).toBe(
        'session-a',
      );
      // The mirror holds the name as a plain file — the FIFO is gone.
      expect(lstatSync(legacy).isFile()).toBe(true);
      expect(lstatSync(legacy).isFIFO()).toBe(false);
    },
  );

  it('clearReviewWorktreeLeaseIfOwned clears both paths of an owned lease, and no others', () => {
    // Ownership is proven on the NEW path alone: a legacy-only file is
    // mount-resident content and proves nothing, so it is left for the
    // workflow sweep rather than deleted on a matching session id read off
    // the writable surface.
    const root = createRepository();
    const legacy = legacyPathFor(root);
    createReviewWorktreeLease(acquire(root));
    expect(existsSync(legacy)).toBe(true);

    clearReviewWorktreeLeaseIfOwned(root, 'pr-1', {
      sessionId: 'session-a',
      promptId: 'prompt-a',
    });
    expect(readReviewWorktreeLease(root, 'pr-1')).toBeNull();
    expect(existsSync(legacy)).toBe(false);

    // Legacy-only: no new-path lease, nothing proven, nothing removed.
    const orphan = writeLegacyLease(
      {
        sessionId: 'session-a',
        promptId: 'prompt-a',
        target: 'pr-1',
        repositoryRoot: root,
        worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
        branch: 'qwen-review/pr-1',
      },
      new Date(0),
    );
    clearReviewWorktreeLeaseIfOwned(root, 'pr-1', {
      sessionId: 'session-a',
      promptId: 'prompt-a',
    });
    expect(existsSync(orphan)).toBe(true);
  });

  it("the finalizer sweep finalizes this session's own mirror at the pre-move path", () => {
    // The acquisition mirror is content-identical to the new-path lease, so
    // the sweep's twin check passes and the legacy copy is finalized
    // together with it — in ONE destructive pass (R28-5): an earlier shape
    // scanned both directories as independent actors and ran
    // `removeLeaseWorktree` twice per lease, the second pass operating on
    // the world the first had already destroyed.
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });
    const mirror = legacyPathFor(root);

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(mirror)).toBe(false);
    expect(existsSync(reviewLeasePath(root, 'pr-1'))).toBe(false);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('');
    // One verdict per target: a single `worktree remove` for the lease, not
    // one per scan leg.
    expect(execStub.worktreeRemoveCalls).toHaveLength(1);
  });

  it('keeps the lease AND the mirror together when the destructive pass fails partway (R28-5)', () => {
    // The wedge the two-leg sweep produced: leg one removed the tree and
    // then failed a follow-up (a prune losing an index.lock race, a killed
    // git call), leg two succeeded against the emptied world and deleted
    // the trusted lease — leaving the mirror twinless and uncollectable.
    // One pass, one verdict: a partway failure keeps both files so the next
    // sweep retries the same target whole.
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });
    const mirror = legacyPathFor(root);
    // Fail the remove AND the fallback prune: the tree is rmSync'd away but
    // the pass reports failure — the destructive-but-false shape.
    execStub.failWorktreeVerbs = 2;

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    // The tree is gone, the branch survives — and BOTH lease files are kept
    // together for the retry.
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(reviewLeasePath(root, 'pr-1'))).toBe(true);
    expect(existsSync(mirror)).toBe(true);

    // The retry finalizes the pair: neither file is left behind alone.
    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });
    expect(existsSync(reviewLeasePath(root, 'pr-1'))).toBe(false);
    expect(existsSync(mirror)).toBe(false);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('');
  });

  it('never even lists the mounted directory — the mirror is found by name, through the trusted lease', () => {
    // `.qwen/tmp` is the directory reviewed code owns: a chmod 000 (or a
    // stale handle) makes its readdirSync throw. The sweep reads only the
    // trusted directory and derives the twin by NAME, so the mounted side's
    // readability cannot decide what the finalizer reaches — an unreadable
    // `.qwen/tmp` used to degrade the legacy leg into skipping the mirror.
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });
    const mirror = legacyPathFor(root);
    fsMockState.readdirFailureDir = join(root, '.qwen', 'tmp');

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    // Worktree, branch, trusted lease AND mirror — all finalized; the
    // mounted directory's unreadability decided nothing.
    expect(existsSync(mirror)).toBe(false);
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(reviewLeasePath(root, 'pr-1'))).toBe(false);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-1'],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe('');
  });

  it("never acts on a planted legacy lease that copies the mirror's credentials", () => {
    // The mirror is READABLE inside the mounted directory, so reviewed code
    // can learn this session's sessionId/promptId from it and plant a lease
    // passing every ownership check — but naming a victim worktreePath.
    // Only content-equality with the new-path lease (outside the mount)
    // proves acquisition wrote a legacy lease, so the plant must be left
    // inert: the victim and its branch survive. The plant file itself is
    // left in place — ignoring it is enough, and acquisition overwrites it
    // with the real mirror if the target is ever genuinely taken.
    const root = createRepository();
    // The copy source: this session's genuine lease + mirror for pr-1.
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });
    // The victim: another review tree under the same temp dir.
    const victim = join(root, '.qwen', 'tmp', 'review-pr-2');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-2']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      victim,
      'qwen-review/pr-2',
    ]);
    const plant = writeLegacyLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-2',
      repositoryRoot: root,
      worktreePath: victim,
      branch: 'qwen-review/pr-2',
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(victim)).toBe(true);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-2'],
        { encoding: 'utf8' },
      ).trim(),
    ).toContain('qwen-review/pr-2');
    expect(existsSync(plant)).toBe(true);
  });

  it("never acts on a doctored TWIN of this session's own mirror (same target)", () => {
    // The shape the field comparisons exist for: the plant is at the SAME
    // target's legacy path, with every credential field copied from the
    // mirror — only `worktreePath` redirected at a victim tree. The twin
    // lookup then finds the genuine new-path lease, and only the per-field
    // equality declines to act: drop the worktreePath comparison and this
    // run removes the victim and deletes the genuine branch.
    const root = createRepository();
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });
    // The victim the doctored mirror points at instead.
    const victim = join(root, '.qwen', 'tmp', 'review-pr-2');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-2']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      victim,
      'qwen-review/pr-2',
    ]);
    const genuine = readReviewWorktreeLease(root, 'pr-1');
    const doctored = writeLegacyLease({
      ...genuine!,
      worktreePath: victim,
    });

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    // The genuine lease's own finalization is the fixture's background and
    // not the assertion: the doctored path is never acted on, so the victim
    // tree and its branch survive — with the worktreePath comparison
    // dropped (the mutation), this run removes them.
    expect(existsSync(victim)).toBe(true);
    expect(
      execFileSync(
        'git',
        ['-C', root, 'branch', '--list', 'qwen-review/pr-2'],
        { encoding: 'utf8' },
      ).trim(),
    ).toContain('qwen-review/pr-2');
    expect(existsSync(doctored)).toBe(true);
  });
});

describe('the acquisition mirror at the mounted legacy path', () => {
  const acquire = (root: string) => ({
    sessionId: 'session-a',
    promptId: 'prompt-a',
    target: 'pr-1',
    repositoryRoot: root,
    worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
    branch: 'qwen-review/pr-1',
  });
  const legacyPathFor = (root: string) =>
    join(root, '.qwen', 'tmp', 'qwen-review-lease-pr-1.json');

  it.skipIf(process.platform === 'win32')(
    'never writes through a symlink planted at the legacy path (R27-7)',
    () => {
      // The mirror's replacement write used to be a plain
      // `writeFileSync(legacy, …)` — `O_TRUNC` through whatever stands at
      // the path, so a planted link aimed a host-side write at a file
      // outside the mount. The write now rides a unique sibling plus
      // rename, which replaces the LINK and cannot reach its target.
      const root = createRepository();
      const legacy = legacyPathFor(root);
      mkdirSync(dirname(legacy), { recursive: true });
      const sentinel = join(root, 'sentinel.txt');
      writeFileSync(sentinel, 'ORIGINAL');
      symlinkSync(sentinel, legacy);

      createReviewWorktreeLease(acquire(root));

      expect(readFileSync(sentinel, 'utf8')).toBe('ORIGINAL');
      // The name now holds this session's mirror as a plain file: the link
      // itself was replaced.
      const stat = lstatSync(legacy);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isFile()).toBe(true);
      expect(JSON.parse(readFileSync(legacy, 'utf8'))).toMatchObject({
        sessionId: 'session-a',
      });
    },
  );

  it.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
    'skips the mirror with a warning when the planted symlink cannot be removed — never through it (R30-8)',
    () => {
      // The read-side guard's rmSync fails here (the parent is read-only),
      // and the wedge cannot be removed — but the lease JSON must still not
      // be written THROUGH the link. The acquisition itself stands: the
      // mirror is advisory, and a fatal one fails the whole review on
      // mount weather (R29-5).
      const root = createRepository();
      const legacy = legacyPathFor(root);
      mkdirSync(dirname(legacy), { recursive: true });
      const sentinel = join(root, 'sentinel.txt');
      writeFileSync(sentinel, 'ORIGINAL');
      symlinkSync(sentinel, legacy);
      chmodSync(dirname(legacy), 0o500);
      try {
        createReviewWorktreeLease(acquire(root));

        expect(readFileSync(sentinel, 'utf8')).toBe('ORIGINAL');
        expect(lstatSync(legacy).isSymbolicLink()).toBe(true);
        expect(existsSync(reviewLeasePath(root, 'pr-1'))).toBe(true);
        const warnings = stdioSpy.writeStderrLineSafe.mock.calls.map(
          ([m]) => m,
        );
        expect(warnings.some((m) => m.includes(legacy))).toBe(true);
      } finally {
        chmodSync(dirname(legacy), 0o755);
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
    'treats an un-removable DIRECTORY at the legacy name as a skipped mirror, not a failed acquisition (R29-5)',
    () => {
      // The wedge shape: a directory where the lease file was, in a parent
      // this process may not write — readLease's self-heal rmSync throws
      // EACCES, and the mirror's old plain write then threw EISDIR out of
      // acquisition AFTER the new-path lock was won, and the rollback's own
      // clear threw too. Mount weather must not abort an acquisition the
      // trusted path already decided.
      const root = createRepository();
      const legacy = legacyPathFor(root);
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, 'x'), 'x');
      chmodSync(dirname(legacy), 0o500);
      try {
        createReviewWorktreeLease(acquire(root));

        expect(existsSync(reviewLeasePath(root, 'pr-1'))).toBe(true);
        expect(readReviewWorktreeLease(root, 'pr-1')?.sessionId).toBe(
          'session-a',
        );
        const warnings = stdioSpy.writeStderrLineSafe.mock.calls.map(
          ([m]) => m,
        );
        expect(warnings.some((m) => m.includes(legacy))).toBe(true);
      } finally {
        chmodSync(dirname(legacy), 0o755);
      }
    },
  );

  it('heals a writable DIRECTORY at the legacy name by replacing it', () => {
    // The reachable wedge: readLease's guard removes the directory, and the
    // rename lands the mirror at the now-free name — the behavior the
    // 'replaces the superseded legacy lease' case pins from the other side.
    const root = createRepository();
    const legacy = legacyPathFor(root);
    mkdirSync(legacy, { recursive: true });

    createReviewWorktreeLease(acquire(root));

    expect(lstatSync(legacy).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(legacy, 'utf8'))).toMatchObject({
      sessionId: 'session-a',
    });
  });
});

describe('the nested review geometry (R27-6)', () => {
  it('re-roots the trusted lease directory outside an enclosing review temp dir', () => {
    // A review launched from inside another review's worktree has its
    // repositoryRoot INSIDE the outer mount: leases placed relative to it
    // would sit in the writable surface the move out of `.qwen/tmp` exists
    // to escape. The trusted state lands beside the OUTERMOST review temp
    // dir instead — which is also the right lock scope, since every nested
    // layer shares the outermost repository's common git dir.
    const outer = createRepository();
    const innerRoot = join(outer, '.qwen', 'tmp', 'review-pr-9');
    mkdirSync(innerRoot, { recursive: true });

    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-a',
      target: 'pr-1',
      repositoryRoot: innerRoot,
      worktreePath: join(innerRoot, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });

    expect(
      existsSync(
        join(outer, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          innerRoot,
          '.qwen',
          'review-leases',
          'qwen-review-lease-pr-1.json',
        ),
      ),
    ).toBe(false);
    // Reads resolve to the same re-rooted location...
    expect(readReviewWorktreeLease(innerRoot, 'pr-1')?.sessionId).toBe(
      'session-a',
    );
    // ...while the pre-move mirror still lands where pre-move builds read:
    // the inner root's own `.qwen/tmp` — advisory content, never authority.
    expect(
      existsSync(
        join(innerRoot, '.qwen', 'tmp', 'qwen-review-lease-pr-1.json'),
      ),
    ).toBe(true);
  });
});

describe('readReviewWorktreeLeaseAt', () => {
  const acquire = (root: string) => ({
    sessionId: 'session-a',
    promptId: 'prompt-a',
    target: 'pr-1',
    repositoryRoot: root,
    worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
    branch: 'qwen-review/pr-1',
  });

  it('names the new path for a lease acquired by this build', () => {
    const root = createRepository();
    createReviewWorktreeLease(acquire(root));
    const found = readReviewWorktreeLeaseAt(root, 'pr-1');
    expect(found?.lease.sessionId).toBe('session-a');
    expect(found?.path).toBe(reviewLeasePath(root, 'pr-1'));
  });

  it('answers nothing for a legacy-only file, however it is stamped (R30-7)', () => {
    // The pre-move path is never the found-at answer: a recovery
    // instruction naming it would point the operator at mount-resident
    // content this build treats as residue, not as the lock.
    const root = createRepository();
    writeLegacyLease(acquire(root), new Date(0));
    expect(readReviewWorktreeLeaseAt(root, 'pr-1')).toBeNull();
  });
});

describe('readReviewWorktreeLease', () => {
  it('returns the lease createReviewWorktreeLease wrote', () => {
    const root = createRepository();
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });

    const lease = readReviewWorktreeLease(root, 'pr-1');
    expect(lease?.sessionId).toBe('session-a');
    expect(lease?.promptId).toBe('prompt-parent');
    expect(lease?.worktreePath).toBe(join(root, '.qwen', 'tmp', 'review-pr-1'));
    expect(reviewLeasePath(root, 'pr-1')).toBe(
      join(root, '.qwen', 'review-leases', 'qwen-review-lease-pr-1.json'),
    );
  });

  it('returns null for a missing lease and for non-PR targets', () => {
    const root = createRepository();
    expect(readReviewWorktreeLease(root, 'pr-1')).toBeNull();
    expect(readReviewWorktreeLease(root, '../../evil')).toBeNull();
    expect(readReviewWorktreeLease(root, 'local')).toBeNull();
  });
});

describe('lease acquisition is atomic (#9205)', () => {
  const leaseParams = (
    root: string,
    over: Partial<Parameters<typeof createReviewWorktreeLease>[0]> = {},
  ) => ({
    sessionId: 'session-a',
    promptId: 'prompt-a',
    target: 'pr-1',
    repositoryRoot: root,
    worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
    branch: 'qwen-review/pr-1',
    ...over,
  });

  it('refuses to overwrite a lease another session acquired first', () => {
    // Two concurrent fetch-prs can both pass the gate's read; the second
    // writer must not clobber the winner's lease, or the loser's rollback
    // then deletes a lock it never owned.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root));

    expect(() =>
      createReviewWorktreeLease(
        leaseParams(root, { sessionId: 'session-b', promptId: 'prompt-b' }),
      ),
    ).toThrow(/session-a/);

    const lease = readReviewWorktreeLease(root, 'pr-1');
    expect(lease?.sessionId).toBe('session-a');
    expect(lease?.promptId).toBe('prompt-a');
  });

  it('lets the owning session refresh its own lease on a re-fetch', () => {
    // Ownership is per session, not per prompt: a drift restart rewrites
    // its own lease with the new prompt id.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root));
    createReviewWorktreeLease(leaseParams(root, { promptId: 'prompt-b' }));
    expect(readReviewWorktreeLease(root, 'pr-1')?.promptId).toBe('prompt-b');
  });

  it('carries the run identity in the lease CONTENT across same-session refreshes', () => {
    // The review pipeline keys the base-tree trust file's run identity on
    // this value: a resumed run re-acquires here, and a moved identity
    // rotates the trust state and discards the standing base tree.
    //
    // It lives in the content because the earlier carrier — the file's mtime,
    // restored through `utimesSync` on every refresh — could not survive its
    // own arithmetic: the restore floors sub-millisecond precision, so the
    // SECOND refresh of a run drifted past the trust store's 1 ms tolerance
    // and rotated a live run's state. Hence the loop: one refresh could not
    // see it.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root));
    const first = readReviewWorktreeLease(root, 'pr-1')?.identity;
    expect(typeof first).toBe('number');
    for (let i = 0; i < 8; i++) {
      createReviewWorktreeLease(leaseParams(root, { promptId: `prompt-${i}` }));
      const now = readReviewWorktreeLease(root, 'pr-1');
      expect(now?.promptId).toBe(`prompt-${i}`);
      expect(now?.identity).toBe(first); // exactly, not within a tolerance
    }
  });

  it("mints a FRESH identity on the heal arm, never the standing file's", () => {
    // The heal arm rewrites a lease that did not parse, so the standing
    // file's owner, session and target were never verified. The mtime
    // carrier donated that file's timestamp to this run regardless, which
    // made an unrelated earlier run's base-tree trust state ADOPTED instead
    // of rotated — its pinned merge base and its recorded trees inherited by
    // a run that had nothing to do with it. A fresh mint rotates, which
    // loses a base tree rather than trusting one.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root));
    const path = reviewLeasePath(root, 'pr-1');
    const before = readReviewWorktreeLease(root, 'pr-1')?.identity;
    writeFileSync(path, '{ torn'); // the crash window: not parseable
    createReviewWorktreeLease(leaseParams(root, { promptId: 'prompt-b' }));
    const after = readReviewWorktreeLease(root, 'pr-1');
    expect(after?.promptId).toBe('prompt-b');
    expect(after?.identity).not.toBe(before);
  });

  it('records the merge base even when the base fetch FAILED (R3-5)', () => {
    // The anchor has to belong to the capture that owns the plan. Skipping
    // the record on a failed base fetch left a PREVIOUS round's value
    // standing in the lease — and the anchor then AUTHENTICATED a plan the
    // mount had rewritten back to that stale sha, so the run reused and
    // certified a base tree at a commit that was not this round's base at
    // all. Whether a stale fetch makes the sha untrustworthy is
    // `base-tree`'s to judge, from the ruling recorded beside the anchor (see
    // the R5-7 case); it is not a reason to leave the anchor pointing at
    // someone else's round.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root));
    recordReviewWorktreeLeaseMergeBase(root, 'pr-1', 'a'.repeat(40));
    const first = readReviewWorktreeLease(root, 'pr-1')?.identity;

    // Round 2 re-captures after a rebase; its base fetch fails, and it
    // resolves a different (possibly stale) sha. The lease must follow it.
    createReviewWorktreeLease(leaseParams(root, { promptId: 'prompt-b' }));
    recordReviewWorktreeLeaseMergeBase(root, 'pr-1', 'b'.repeat(40));

    const after = readReviewWorktreeLease(root, 'pr-1');
    expect(after?.mergeBaseSha).toBe('b'.repeat(40));
    // A MOVED base rotates, and the rotation survives the refresh having
    // dropped the anchor — see the R4-9 case for why it is dropped.
    expect(after?.identity).not.toBe(first);
  });

  it('reclaims the base-tree trust state from the FINALIZER too (R3-9)', () => {
    // A session that ends through `cleanupReviewWorktreeLeases` never passes
    // through `clearReviewWorktreeLease`, so the reclaim on that path alone
    // left a ~9 MB file per plan path behind forever.
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      '--detach',
      worktree,
      'HEAD',
    ]);
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-a',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: worktree,
      branch: 'qwen-review/pr-1',
    });
    const trustDir = join(root, '.qwen', 'review-leases', 'base-tree', 'pr-1');
    mkdirSync(trustDir, { recursive: true });
    writeFileSync(join(trustDir, 'deadbeefdeadbeef.json'), '{"identity":1}');

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-a',
      repositoryRoot: root,
    });

    expect(readReviewWorktreeLease(root, 'pr-1')).toBeNull(); // it finalized
    expect(existsSync(trustDir)).toBe(false);
  });

  it("refuses to write the merge base over ANOTHER session's lease (R3-11)", () => {
    // A capture that lost the acquisition race, or one still running after an
    // operator handed the target to a new session, would otherwise write its
    // merge base — and a fresh identity — over the lease the live review is
    // keyed on, rotating that review's trust state and sweeping the base tree
    // it is mid-A/B in.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root)); // session-a holds it
    const before = readReviewWorktreeLease(root, 'pr-1');

    recordReviewWorktreeLeaseMergeBase(root, 'pr-1', 'f'.repeat(40), 'other');

    const after = readReviewWorktreeLease(root, 'pr-1');
    expect(after?.mergeBaseSha).toBeUndefined();
    expect(after?.identity).toBe(before?.identity);

    // The owner's own write lands.
    recordReviewWorktreeLeaseMergeBase(
      root,
      'pr-1',
      'f'.repeat(40),
      before!.sessionId,
    );
    expect(readReviewWorktreeLease(root, 'pr-1')?.mergeBaseSha).toBe(
      'f'.repeat(40),
    );
  });

  it('never leaves a torn lease for the lock-free reader (R3-10)', () => {
    // `base-tree`'s `runIdentity` reads this file with no lock on every ask,
    // and every reader treats a torn lease as NO lease — which makes that ask
    // refuse and costs the review its A/B for that shard. Every writer here
    // publishes by rename, so a reader sees the old file or the new one.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root));
    const path = reviewLeasePath(root, 'pr-1');
    const seen: Array<string | undefined> = [];
    // The refresh and the merge-base write are the two in-place writers this
    // diff adds a lock-free reader to; read between every one of them.
    for (let i = 0; i < 6; i++) {
      createReviewWorktreeLease(leaseParams(root, { promptId: `p-${i}` }));
      seen.push(readReviewWorktreeLease(root, 'pr-1')?.promptId);
      recordReviewWorktreeLeaseMergeBase(
        root,
        'pr-1',
        `${i}`.repeat(40),
        'session-a',
      );
      seen.push(readReviewWorktreeLease(root, 'pr-1')?.promptId);
    }
    // Never a torn read, and never a leftover tmp file for a sweep to meet.
    expect(seen.every((v) => typeof v === 'string')).toBe(true);
    expect(
      readdirSync(dirname(path)).filter((f) => f.endsWith('.tmp')),
    ).toEqual([]);

    // The mechanism, measured rather than inferred: publishing by RENAME
    // replaces the directory entry, so the inode moves. A truncate in place
    // keeps it — and keeps the window where a lock-free reader sees a file
    // that is neither the old content nor the new. A single-threaded test
    // cannot catch that window directly, so it pins the property that makes
    // the window impossible.
    const inodeBefore = lstatSync(path).ino;
    createReviewWorktreeLease(leaseParams(root, { promptId: 'after' }));
    expect(lstatSync(path).ino).not.toBe(inodeBefore);
    expect(readReviewWorktreeLease(root, 'pr-1')?.promptId).toBe('after');
  });

  it('mints a fresh identity only when the merge base MOVES, across refreshes (R4-9)', () => {
    // The refresh used to carry the previous capture's `mergeBaseSha`
    // forward, so a round whose own record write failed inherited a stale
    // host-side anchor that `base-tree` then read as this capture's fact —
    // and both invariants (`fetch-pr`'s "the anchor belongs to the capture
    // that owns the plan" and `base-tree`'s "a missing anchor refuses") held
    // only for round 1.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root));
    recordReviewWorktreeLeaseMergeBase(
      root,
      'pr-1',
      'a'.repeat(40),
      'session-a',
    );
    const n1 = readReviewWorktreeLease(root, 'pr-1')?.identity;

    // Round 2 acquires. The anchor is DROPPED — a capture that records
    // nothing has none, which refuses — while the identity stands.
    createReviewWorktreeLease(leaseParams(root, { promptId: 'prompt-b' }));
    const afterRefresh = readReviewWorktreeLease(root, 'pr-1');
    expect(afterRefresh?.mergeBaseSha).toBeUndefined();
    expect(afterRefresh?.identity).toBe(n1);

    // Round 2 records the SAME base: no move, so no rotation, and the
    // standing base tree is still reused.
    recordReviewWorktreeLeaseMergeBase(
      root,
      'pr-1',
      'a'.repeat(40),
      'session-a',
    );
    expect(readReviewWorktreeLease(root, 'pr-1')?.identity).toBe(n1);
    expect(readReviewWorktreeLease(root, 'pr-1')?.mergeBaseSha).toBe(
      'a'.repeat(40),
    );

    // Round 3 acquires and records a MOVED base — a genuine rebase. The
    // rotation survives the dropped anchor because the previous value is
    // remembered in a field that is not the anchor.
    createReviewWorktreeLease(leaseParams(root, { promptId: 'prompt-c' }));
    recordReviewWorktreeLeaseMergeBase(
      root,
      'pr-1',
      'b'.repeat(40),
      'session-a',
    );
    const moved = readReviewWorktreeLease(root, 'pr-1');
    expect(moved?.mergeBaseSha).toBe('b'.repeat(40));
    expect(moved?.identity).not.toBe(n1);
  });

  it('restores the anchor on a RESUMED capture from the host-side prior (R5-2)', () => {
    // `fetch-pr --resume` re-acquires the lease — whose refresh drops the
    // anchor — and returns before the resolution that records one, because a
    // continuation does not recapture. Every resumed review then had no
    // anchor, and `base-tree` refused for the rest of it.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root));
    recordReviewWorktreeLeaseMergeBase(
      root,
      'pr-1',
      'a'.repeat(40),
      'session-a',
      { stale: true },
    );
    const n1 = readReviewWorktreeLease(root, 'pr-1')?.identity;
    createReviewWorktreeLease(leaseParams(root, { promptId: 'prompt-b' }));
    expect(readReviewWorktreeLease(root, 'pr-1')?.mergeBaseSha).toBeUndefined();

    // Only this session's lease.
    restoreReviewWorktreeLeaseMergeBase(root, 'pr-1', 'session-other');
    restoreReviewWorktreeLeaseMergeBase(root, 'pr-1', undefined);
    expect(readReviewWorktreeLease(root, 'pr-1')?.mergeBaseSha).toBeUndefined();

    restoreReviewWorktreeLeaseMergeBase(root, 'pr-1', 'session-a');
    const restored = readReviewWorktreeLease(root, 'pr-1');
    expect(restored?.mergeBaseSha).toBe('a'.repeat(40));
    // The staleness ruling comes back WITH it, and nothing moved.
    expect(restored?.mergeBaseStale).toBe(true);
    expect(restored?.identity).toBe(n1);

    // Never over an anchor that already stands.
    writeFileSync(
      reviewLeasePath(root, 'pr-1'),
      JSON.stringify({ ...restored, mergeBaseSha: 'c'.repeat(40) }),
    );
    restoreReviewWorktreeLeaseMergeBase(root, 'pr-1', 'session-a');
    expect(readReviewWorktreeLease(root, 'pr-1')?.mergeBaseSha).toBe(
      'c'.repeat(40),
    );

    // Never inventing one where no capture recorded any.
    const fresh = createRepository();
    createReviewWorktreeLease(leaseParams(fresh));
    restoreReviewWorktreeLeaseMergeBase(fresh, 'pr-1', 'session-a');
    const untouched = readReviewWorktreeLease(fresh, 'pr-1');
    expect(untouched?.mergeBaseSha).toBeUndefined();
    expect(untouched?.mergeBaseStale).toBeUndefined();
  });

  it('carries the staleness ruling host-side WITH the merge base (R5-7)', () => {
    // The anchor covered the sha while the capture's own judgement that the
    // sha may be STALE stayed in the plan, inside the mount — so the reviewed
    // code flipped it and the anchor authenticated a stale base as fresh.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root));
    recordReviewWorktreeLeaseMergeBase(
      root,
      'pr-1',
      'a'.repeat(40),
      'session-a',
      { stale: true },
    );
    const n1 = readReviewWorktreeLease(root, 'pr-1')?.identity;
    expect(readReviewWorktreeLease(root, 'pr-1')?.mergeBaseStale).toBe(true);

    // A capture at the same sha whose base fetch now succeeds clears it: a
    // changed ruling is a change, and it moves no identity.
    recordReviewWorktreeLeaseMergeBase(
      root,
      'pr-1',
      'a'.repeat(40),
      'session-a',
      { stale: false },
    );
    expect(readReviewWorktreeLease(root, 'pr-1')?.mergeBaseStale).toBe(false);
    expect(readReviewWorktreeLease(root, 'pr-1')?.identity).toBe(n1);

    // A refresh drops it with the anchor, into the prior pair.
    createReviewWorktreeLease(leaseParams(root, { promptId: 'prompt-b' }));
    const refreshed = readReviewWorktreeLease(root, 'pr-1');
    expect(refreshed?.mergeBaseSha).toBeUndefined();
    expect(refreshed?.mergeBaseStale).toBeUndefined();
    expect(refreshed?.priorMergeBaseSha).toBe('a'.repeat(40));
    expect(refreshed?.priorMergeBaseStale).toBe(false);

    // And a ruling that is not a boolean is no lease at all.
    writeFileSync(
      reviewLeasePath(root, 'pr-1'),
      JSON.stringify({ ...refreshed, mergeBaseStale: 'false' }),
    );
    expect(readReviewWorktreeLease(root, 'pr-1')).toBeNull();
  });

  it('restores only the prior of the capture being resumed (R5-2)', () => {
    // A capture that acquired after the anchor was recorded and never recorded
    // its own — no merge base resolved, or the write failed — left the prior
    // naming the round BEFORE it. A later `--resume` restored that, and a plan
    // rewritten back to it was authenticated.
    const root = createRepository();
    const lease = () => readReviewWorktreeLease(root, 'pr-1');
    const resume = (promptId: string) => {
      createReviewWorktreeLease(leaseParams(root, { promptId }));
      restoreReviewWorktreeLeaseMergeBase(root, 'pr-1', 'session-a');
    };
    createReviewWorktreeLease(leaseParams(root));
    recordReviewWorktreeLeaseMergeBase(
      root,
      'pr-1',
      'a'.repeat(40),
      'session-a',
    );
    expect(lease()?.priorMergeBaseCurrent).toBe(true);

    // Round N acquires — the acquisition snapshots and clears the flag in its
    // one atomic write, so there is no separate write to fail — and records
    // nothing.
    createReviewWorktreeLease(leaseParams(root, { promptId: 'prompt-b' }));
    expect(lease()?.priorMergeBaseCurrent).toBeUndefined();
    expect(lease()?.priorMergeBaseResumable).toBe(true);

    // A later resume restores nothing: its acquisition saw a prior that no
    // capture since had recorded.
    resume('prompt-c');
    expect(lease()?.priorMergeBaseResumable).toBe(false);
    expect(lease()?.mergeBaseSha).toBeUndefined();

    // A capture records again; resuming it restores — and so does resuming the
    // resumed capture, because a restore makes the prior current again.
    recordReviewWorktreeLeaseMergeBase(
      root,
      'pr-1',
      'a'.repeat(40),
      'session-a',
    );
    resume('prompt-d');
    expect(lease()?.mergeBaseSha).toBe('a'.repeat(40));
    resume('prompt-e');
    expect(lease()?.mergeBaseSha).toBe('a'.repeat(40));

    // And a flag that is not a boolean is no lease at all, for either field.
    const standing = lease();
    for (const field of ['priorMergeBaseCurrent', 'priorMergeBaseResumable']) {
      writeFileSync(
        reviewLeasePath(root, 'pr-1'),
        JSON.stringify({ ...standing, [field]: 'yes' }),
      );
      expect(readReviewWorktreeLease(root, 'pr-1')).toBeNull();
    }
  });

  it('reclaims the base-tree trust state for the target it clears, and only that one', () => {
    // The trust file is keyed by the PLAN's path — a digest no other module
    // can reconstruct — so nothing outside this ever deleted it, and a real
    // built tree's per-file inventory measures ~9 MB. One per plan path per
    // review, kept forever. The lease directory is where it lives and this
    // is the call that ends a review's hold on the target, so the reclaim
    // belongs here; the per-target directory is what makes it precise.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root));
    const mine = join(root, '.qwen', 'review-leases', 'base-tree', 'pr-1');
    const other = join(root, '.qwen', 'review-leases', 'base-tree', 'pr-2');
    for (const dir of [mine, other]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'deadbeefdeadbeef.json'), '{"identity":1}');
    }

    clearReviewWorktreeLease(root, 'pr-1');

    expect(existsSync(mine)).toBe(false);
    // A concurrent review of another PR in the same repository keeps its own.
    expect(existsSync(join(other, 'deadbeefdeadbeef.json'))).toBe(true);
  });

  it('records the merge base host-side, and rotates the identity only when it MOVES', () => {
    // `base-tree` pins the base it certifies against, and its only source
    // used to be the plan — which lives inside the directory the sandbox
    // mounts read-write, and which the build/test phase gives the reviewed
    // code a chance to rewrite BEFORE the run's first base-tree ask. This is
    // the host-side anchor that ask compares against.
    const root = createRepository();
    createReviewWorktreeLease(leaseParams(root));
    const minted = readReviewWorktreeLease(root, 'pr-1')?.identity;
    expect(readReviewWorktreeLease(root, 'pr-1')?.mergeBaseSha).toBeUndefined();

    // The first recording is this capture's own fact: nothing to disagree
    // with, so the identity stands and a standing base tree is still reused.
    recordReviewWorktreeLeaseMergeBase(root, 'pr-1', 'a'.repeat(40));
    expect(readReviewWorktreeLease(root, 'pr-1')?.mergeBaseSha).toBe(
      'a'.repeat(40),
    );
    expect(readReviewWorktreeLease(root, 'pr-1')?.identity).toBe(minted);

    // Re-recording the SAME base changes nothing at all.
    recordReviewWorktreeLeaseMergeBase(root, 'pr-1', 'a'.repeat(40));
    expect(readReviewWorktreeLease(root, 'pr-1')?.identity).toBe(minted);

    // A MOVED base is a genuine rebase arriving through a fresh capture: the
    // trust state must rotate rather than report a conflict between its pin
    // and the new plan and then decline for the rest of the session.
    recordReviewWorktreeLeaseMergeBase(root, 'pr-1', 'b'.repeat(40));
    const moved = readReviewWorktreeLease(root, 'pr-1');
    expect(moved?.mergeBaseSha).toBe('b'.repeat(40));
    expect(moved?.identity).not.toBe(minted);

    // Never fatal, and never inventing a lease: an absent one is left absent.
    const other = createRepository();
    expect(() =>
      recordReviewWorktreeLeaseMergeBase(other, 'pr-9', 'c'.repeat(40)),
    ).not.toThrow();
    expect(readReviewWorktreeLease(other, 'pr-9')).toBeNull();
  });

  it('heals an unreadable lease file instead of wedging on it', () => {
    // Every reader treats a torn/unparseable lease as no lease, so the
    // writer rewriting it is self-heal, not clobber.
    const root = createRepository();
    mkdirSync(join(root, '.qwen', 'tmp'), { recursive: true });
    mkdirSync(join(root, '.qwen', 'review-leases'), { recursive: true });
    writeFileSync(reviewLeasePath(root, 'pr-1'), '{"truncated');
    createReviewWorktreeLease(leaseParams(root));
    expect(readReviewWorktreeLease(root, 'pr-1')?.sessionId).toBe('session-a');
  });
});

describe('clearReviewWorktreeLeaseIfOwned', () => {
  it('removes the lease only when the caller wrote it', () => {
    // The manual-recovery shape: a session that acquired while a stuck run
    // was being recovered must survive that stuck run's failure rollback.
    const root = createRepository();
    createReviewWorktreeLease({
      sessionId: 'session-a',
      promptId: 'prompt-a',
      target: 'pr-1',
      repositoryRoot: root,
      worktreePath: join(root, '.qwen', 'tmp', 'review-pr-1'),
      branch: 'qwen-review/pr-1',
    });

    clearReviewWorktreeLeaseIfOwned(root, 'pr-1', {
      sessionId: 'session-b',
      promptId: 'prompt-b',
    });
    expect(readReviewWorktreeLease(root, 'pr-1')).not.toBeNull();

    clearReviewWorktreeLeaseIfOwned(root, 'pr-1', {
      sessionId: 'session-a',
      promptId: 'prompt-a',
    });
    expect(readReviewWorktreeLease(root, 'pr-1')).toBeNull();
  });
});

describe('isReviewLeaseFile', () => {
  it('accepts exactly the filenames the lease writer can produce', () => {
    expect(isReviewLeaseFile('qwen-review-lease-pr-1.json')).toBe(true);
    expect(isReviewLeaseFile('qwen-review-lease-pr-99999.json')).toBe(true);
  });

  it('rejects near-misses the cleanup sweep must not skip', () => {
    // A file-review target named `lease` flattens to the bare prefix; its
    // side files must stay sweepable, and nothing else is a lease.
    expect(isReviewLeaseFile('qwen-review-lease-diff.txt')).toBe(false);
    expect(isReviewLeaseFile('qwen-review-lease-.json')).toBe(false);
    expect(isReviewLeaseFile('qwen-review-lease-local.json')).toBe(false);
    expect(isReviewLeaseFile('qwen-review-lease-pr-1.json.bak')).toBe(false);
    expect(isReviewLeaseFile('xqwen-review-lease-pr-1.json')).toBe(false);
  });
});

describe('cleanupReviewWorktreeLeases scan', () => {
  it('skips files outside the writer target grammar even with lease content', () => {
    // The scan shares its lease shape with the writer (isReviewLeaseFile):
    // a hand-shaped file the writer could never produce is not swept, so the
    // finalizer's destructive path cannot ride a non-lease name.
    const root = createRepository();
    const worktree = join(root, '.qwen', 'tmp', 'review-pr-1');
    execFileSync('git', ['-C', root, 'branch', 'qwen-review/pr-1']);
    execFileSync('git', [
      '-C',
      root,
      'worktree',
      'add',
      '-q',
      worktree,
      'qwen-review/pr-1',
    ]);
    const stray = join(
      root,
      '.qwen',
      'review-leases',
      'qwen-review-lease-local.json',
    );
    mkdirSync(dirname(stray), { recursive: true });
    writeFileSync(
      stray,
      JSON.stringify({
        sessionId: 'session-a',
        promptId: 'prompt-parent',
        target: 'pr-1',
        repositoryRoot: root,
        worktreePath: worktree,
        branch: 'qwen-review/pr-1',
      }),
    );

    cleanupReviewWorktreeLeases({
      sessionId: 'session-a',
      promptId: 'prompt-parent',
      repositoryRoot: root,
    });

    expect(existsSync(worktree)).toBe(true);
    expect(existsSync(stray)).toBe(true);
  });
});

describe('reviewLeaseHeldByAnotherSession', () => {
  const lease: ReviewWorktreeLease = {
    sessionId: 'session-a',
    promptId: 'prompt-parent',
    target: 'pr-1',
    repositoryRoot: '/repo',
    worktreePath: '/repo/.qwen/tmp/review-pr-1',
    branch: 'qwen-review/pr-1',
  };
  let savedSessionId: string | undefined;

  beforeEach(() => {
    savedSessionId = process.env['QWEN_CODE_SESSION_ID'];
  });

  afterEach(() => {
    if (savedSessionId === undefined) {
      delete process.env['QWEN_CODE_SESSION_ID'];
    } else {
      process.env['QWEN_CODE_SESSION_ID'] = savedSessionId;
    }
  });

  it('returns false when there is no lease', () => {
    delete process.env['QWEN_CODE_SESSION_ID'];
    expect(reviewLeaseHeldByAnotherSession(null)).toBe(false);
  });

  it('lets the owning session pass regardless of prompt', () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'session-a';
    expect(reviewLeaseHeldByAnotherSession(lease)).toBe(false);
    // One session reviews a PR across several prompts (rounds, drift
    // restarts); a later prompt of the holder must not be locked out.
    expect(
      reviewLeaseHeldByAnotherSession({
        ...lease,
        promptId: 'prompt-later',
      }),
    ).toBe(false);
  });

  it('blocks another session', () => {
    process.env['QWEN_CODE_SESSION_ID'] = 'session-b';
    expect(reviewLeaseHeldByAnotherSession(lease)).toBe(true);
  });

  it('blocks a process that has no session id to prove ownership', () => {
    delete process.env['QWEN_CODE_SESSION_ID'];
    expect(reviewLeaseHeldByAnotherSession(lease)).toBe(true);
  });
});
