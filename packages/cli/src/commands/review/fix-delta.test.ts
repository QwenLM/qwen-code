/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Against a REAL git repo, like `scratch-tree`'s suite: what this command
// promises is a property of git state — the user's index untouched, the stash
// untouched, the hunks exactly the edits between two moments — and none of it
// is exercised by mocking `execFileSync`.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: vi.fn(),
  writeStderrLine: vi.fn(),
}));
// The temp-dir pin below needs os.tmpdir() to answer inside the worktree.
// Setting TMPDIR cannot do that in this suite: isolateHostGitConfig's
// dispose replaces process.env with a plain object, after which assignments
// no longer reach the environ os.tmpdir() reads.
const tmpdirOverride = vi.hoisted(() => ({
  value: undefined as string | undefined,
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  // `default` has to carry the stub too: Node builtins are CJS, so Vite's
  // interop can resolve a named import through the default export.
  const tmpdir = () => tmpdirOverride.value ?? actual.tmpdir();
  return { ...actual, default: { ...actual, tmpdir }, tmpdir };
});
// The locale pin and the kill-shape ruling are properties of the ENV and
// the RESULT SHAPE a `git add` child receives, which no fixture can make
// observable from outside — record the spawnSync calls instead, delegating
// every call to the real implementation.
const spawnRecord = vi.hoisted(() => ({
  calls: [] as Array<{
    args: readonly string[];
    env: Record<string, string> | undefined;
  }>,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawnSync = ((...call: Parameters<typeof actual.spawnSync>) => {
    spawnRecord.calls.push({
      args: call[1] ?? [],
      env: call[2]?.env as Record<string, string> | undefined,
    });
    return actual.spawnSync(...call);
  }) as typeof actual.spawnSync;
  return { ...actual, default: { ...actual, spawnSync }, spawnSync };
});
// The DT_UNKNOWN witness needs a dirent stream every predicate refuses —
// no filesystem constructible on the CI hosts reports unknown types (NFS
// without d_type, sshfs/FUSE do) — so wrap the real readdirSync behind a
// switch the test flips, exactly like the child_process record above.
const readdirHook = vi.hoisted(() => ({
  unknownDirents: false,
}));
// …and the inode witness: FAT/exFAT and some SMB mounts answer `ino === 0`
// for every entry, which no CI host can mount, so the stat stream is
// wrapped behind the same kind of switch.
const statHook = vi.hoisted(() => ({
  zeroInodes: false,
}));
// …and the canonicalisation witness: a link chain whose resolved form
// cannot materialise (past the platform limit) — realpathSync.native
// throws ENAMETOOLONG while statSync resolves fine. No CI host mounts
// such a filesystem, so the resolution is wrapped behind the same kind
// of switch, keyed on a path pattern the test plants.
const realpathHook = vi.hoisted(() => ({
  failOn: null as RegExp | null,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const hooked = (path: unknown, opts?: unknown): unknown => {
    const s = Buffer.isBuffer(path) ? path.toString('latin1') : String(path);
    if (realpathHook.failOn !== null && realpathHook.failOn.test(s)) {
      const err = new Error('ENAMETOOLONG: name too long');
      (err as NodeJS.ErrnoException).code = 'ENAMETOOLONG';
      throw err;
    }
    return (actual.realpathSync.native as (...a: unknown[]) => unknown)(
      path,
      opts,
    );
  };
  const realpathSync = Object.assign(
    (...args: Parameters<typeof actual.realpathSync>) =>
      actual.realpathSync(...args),
    { native: hooked },
  ) as typeof actual.realpathSync;
  const readdirSync = ((...args: Parameters<typeof actual.readdirSync>) => {
    const entries = actual.readdirSync(...args);
    const opts = args[1];
    const withTypes =
      typeof opts === 'object' &&
      opts !== null &&
      'withFileTypes' in opts &&
      opts.withFileTypes === true;
    if (!readdirHook.unknownDirents || !Array.isArray(entries) || !withTypes) {
      return entries;
    }
    // DT_UNKNOWN: every predicate a real Dirent carries answers false.
    return entries.map((e) => ({
      name: (e as { name: unknown }).name,
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isCharacterDevice: () => false,
      isBlockDevice: () => false,
    }));
  }) as typeof actual.readdirSync;
  const statSync = ((...args: Parameters<typeof actual.statSync>) => {
    const st = actual.statSync(...args);
    if (!statHook.zeroInodes || st === undefined) return st;
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
      ino: 0,
    });
  }) as typeof actual.statSync;
  return {
    ...actual,
    default: { ...actual, readdirSync, statSync, realpathSync },
    readdirSync,
    statSync,
    realpathSync,
  };
});
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Mock } from 'vitest';
import yargs from 'yargs';
import {
  IGNORED_WALK_BUDGET,
  IGNORED_WALK_RUN_CAP,
  setWalkBudgetsForTest,
  assertCompleteCapture,
  capturePathspecBytes,
  fixDeltaCommand,
  runFixDelta,
  snapshotWorkingTree,
  type FixSnapshot,
} from './fix-delta.js';
import { isolateHostGitConfig } from './lib/test-utils.js';

describe('fix-delta', () => {
  let repo: string;
  // The command's own outputs live OUTSIDE the fixture repo, so the
  // index/stash invariance test measures the command and not its files;
  // the side-file exclusion test plants review side files in the repo itself.
  let out: string;
  let gitIsolation: ReturnType<typeof isolateHostGitConfig>;
  let cwdBefore: string;
  const gitAt = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const git = (...args: string[]) => gitAt(repo, ...args);
  const snapshotFile = () => join(out, 'fix-snapshot.json');
  const hunksFile = () => join(out, 'fix-hunks.diff');
  const stderr = () =>
    (writeStderrLine as unknown as Mock).mock.calls.map((c) => c[0] as string);
  /**
   * The fingerprint `--snapshot` prints for a record — the SHA-256 of the
   * file's bytes. The flow carries it from the snapshot's stderr line to
   * `--since`; the suite reads it off the file it just wrote, which is the
   * same value while nothing has rewritten the file.
   */
  const fingerprintOf = (file: string) =>
    createHash('sha256').update(readFileSync(file)).digest('hex');
  /** `--since`, the way the flow invokes it: with the record's fingerprint. */
  const runSince = (
    since = snapshotFile(),
    outFile = hunksFile(),
    reviewWorktrees: readonly string[] = [],
  ) =>
    runFixDelta({
      snapshot: false,
      since,
      fingerprint: fingerprintOf(since),
      reviewWorktrees,
      out: outFile,
    });
  /** `--snapshot` naming the review worktrees THIS flow created. */
  const runSnapshot = (reviewWorktrees: readonly string[] = []) =>
    runFixDelta({
      snapshot: true,
      since: undefined,
      reviewWorktrees,
      out: snapshotFile(),
    });

  /** A scratch repository to add as a submodule: one committed file. */
  function makeSubmoduleSource(): string {
    const subSrc = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-subsrc-')),
    );
    gitAt(subSrc, 'init', '-q', '-b', 'main');
    gitAt(subSrc, 'config', 'user.email', 't@t.t');
    gitAt(subSrc, 'config', 'user.name', 't');
    writeFileSync(join(subSrc, 'f.txt'), 'before\n');
    gitAt(subSrc, 'add', '-A');
    gitAt(subSrc, 'commit', '-qm', 'init');
    return subSrc;
  }

  /** `makeSubmoduleSource`, plus added AND committed at `name` in the fixture. */
  function plantCommittedSubmodule(name = 'sub'): string {
    const subSrc = makeSubmoduleSource();
    git(
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      subSrc,
      name,
    );
    gitAt(join(repo, name), 'config', 'user.email', 't@t.t');
    gitAt(join(repo, name), 'config', 'user.name', 't');
    git('add', '-A');
    git('commit', '-qm', 'add submodule');
    return subSrc;
  }

  /** Init + commit inside a nested repo whose NAME spawn args cannot
   * carry (invalid UTF-8): the shell's stdin is the one byte-exact
   * channel, as in the non-UTF-8 test above. */
  function initNestedRepoSh(abs: Buffer): void {
    execFileSync('/bin/sh', [], {
      input: Buffer.concat([
        Buffer.from("set -e\ncd -- '"),
        abs,
        Buffer.from(
          "'\n" +
            'git init -q -b main\n' +
            'git config user.email t@t.t\n' +
            'git config user.name t\n' +
            'printf before > f.txt\n' +
            'git add -A\n' +
            'git commit -qm init\n',
        ),
      ]),
    });
  }

  /** Byte-exact overwrite under a name spawn args cannot carry. */
  function overwriteSh(absFile: Buffer, content: string): void {
    execFileSync('/bin/sh', [], {
      input: Buffer.concat([
        Buffer.from("set -e\nprintf %s '"),
        Buffer.from(content),
        Buffer.from("' > '"),
        absFile,
        Buffer.from("'\n"),
      ]),
    });
  }

  beforeEach(() => {
    gitIsolation = isolateHostGitConfig();
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-fix-delta-')));
    out = mkdtempSync(join(tmpdir(), 'qwen-fix-delta-out-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 1;\n');
    writeFileSync(join(repo, 'gone.ts'), 'export const gone = true;\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    git('add', '-A');
    git('commit', '-qm', 'head');
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    cwdBefore = process.cwd();
    process.chdir(repo);
    (writeStderrLine as unknown as Mock).mockClear();
    spawnRecord.calls = [];
  });

  afterEach(() => {
    process.chdir(cwdBefore);
    // A `git add` of the 11k-file tree can detach an auto-gc that is still
    // writing loose objects when the teardown starts; retry the removal.
    rmSync(repo, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    });
    rmSync(out, { recursive: true, force: true });
    gitIsolation.dispose();
    tmpdirOverride.value = undefined;
    readdirHook.unknownDirents = false;
    statHook.zeroInodes = false;
    realpathHook.failOn = null;
    setWalkBudgetsForTest({
      perWalk: IGNORED_WALK_BUDGET,
      perRun: IGNORED_WALK_RUN_CAP,
    });
  });

  it('diffs exactly the edits made between the snapshot and now — on top of the reviewed change', () => {
    // The local review's own uncommitted change: present at snapshot time, so
    // it must NOT be in the hunks — the audit is about the fix, not the diff.
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(realpathSync(snap.root)).toBe(repo);
    expect(snap.tree).toMatch(/^[0-9a-f]{40,64}$/);

    // The fix: a modification, a new untracked test file, a deletion, and a
    // new file whose non-ASCII name renders QUOTED in git's patch output —
    // the summary takes its names from git's structured listing, so the file
    // is counted and named, not dropped by an anchored header regex.
    writeFileSync(
      join(repo, 'a.ts'),
      'export const x = 2;\nexport const bound = LIMIT;\n',
    );
    writeFileSync(join(repo, 'a.test.ts'), 'test("bound", () => {});\n');
    rmSync(join(repo, 'gone.ts'));
    writeFileSync(join(repo, '文.ts'), 'export const v = 1;\n');
    runSince();
    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).toContain('+export const bound = LIMIT;');
    expect(hunks).not.toContain('-export const x = 1;'); // the reviewed change
    expect(hunks).toContain('diff --git a/a.test.ts b/a.test.ts');
    expect(hunks).toContain('+test("bound", () => {});');
    expect(hunks).toContain('diff --git a/gone.ts b/gone.ts');
    expect(hunks).toContain('deleted file mode');
    // …and the non-ASCII name arrives RAW in the hunks headers too: under
    // the default `core.quotePath=true` git C-quotes it there while the
    // summary above prints the raw name — two spellings of one file for
    // the audit to correlate. The capture pins `core.quotePath=false`.
    expect(hunks).toContain('diff --git a/文.ts b/文.ts');
    expect(stderr().at(-1)).toMatch(
      /^fix-delta: 4 file\(s\) changed since the snapshot — a\.test\.ts, a\.ts, gone\.ts, 文\.ts$/,
    );
  });

  it('counts a rename once, under its new name', () => {
    // `filesBetweenTrees`/`patchBetweenTrees` pass `-M` and promise a rename
    // counted once, under its new name — without `-M` the summary would name
    // two changed files and a phantom deletion.
    writeFileSync(join(repo, 'old-name.ts'), 'export const r = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'add old-name');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    git('mv', 'old-name.ts', 'new-name.ts');
    runSince();
    expect(stderr().at(-1)).toBe(
      'fix-delta: 1 file(s) changed since the snapshot — new-name.ts',
    );
    expect(readFileSync(hunksFile(), 'utf8')).toContain(
      'rename to new-name.ts',
    );
  });

  it('names the submodule blind spot instead of claiming nothing was applied', () => {
    // A fix that lands inside a submodule without being committed there moves
    // no gitlink — the superproject tree, which is all a snapshot records, is
    // byte-identical. The command must name that blind spot, not print the
    // all-clear and steer the orchestrator at a correct ledger.
    const subSrc = plantCommittedSubmodule();
    try {
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      // The fix lands inside the submodule, uncommitted there.
      writeFileSync(join(repo, 'sub', 'f.txt'), 'after — the fix\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const last = stderr().at(-1) ?? '';
      expect(last).toContain('submodule');
      // `/\bsub\b/`, not `toContain('sub')`: any message containing
      // 'submodule' already contains 'sub', so the weaker form cannot pin
      // that the warning names WHICH submodule is the blind spot.
      expect(last).toMatch(/\bsub\b/);
      expect(last).not.toContain('the tree is unchanged since the snapshot');
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('names the blind spot for a submodule staged in the index but not in HEAD', () => {
    // `git submodule add` stages the gitlink without committing it; the
    // HEAD-side mode of that interim state prints 000000, and the probe must
    // match it exactly like the committed shape.
    const subSrc = makeSubmoduleSource();
    try {
      git(
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        subSrc,
        'sub',
      );
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      // The fix lands inside the submodule, uncommitted there.
      writeFileSync(join(repo, 'sub', 'f.txt'), 'after — the fix\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const last = stderr().at(-1) ?? '';
      expect(last).toMatch(/\bsub\b/);
      expect(last).toContain('cannot see');
      expect(last).not.toContain('the tree is unchanged since the snapshot');
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('discloses the blind spot beside a non-empty diff too', () => {
    // A fix editing both a regular file and the inside of a submodule must
    // not let the hunks silently under-report the edit set: the probe runs
    // regardless of diff emptiness.
    const subSrc = plantCommittedSubmodule();
    try {
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      writeFileSync(join(repo, 'a.ts'), 'export const x = 42;\n');
      writeFileSync(join(repo, 'sub', 'f.txt'), 'after — the fix\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toContain(
        '+export const x = 42;',
      );
      const lines = stderr();
      expect(lines.at(-2)).toBe(
        'fix-delta: 1 file(s) changed since the snapshot — a.ts',
      );
      expect(lines.at(-1)).toMatch(/\bsub\b/);
      expect(lines.at(-1)).toContain('cannot see');
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('does not blame dirt a submodule already held at snapshot time', () => {
    // Pre-existing dirt and fix dirt are structurally indistinguishable; the
    // snapshot records the baseline, and only NEW dirt names a blind spot —
    // a no-op fix in a repository with a dirty submodule must still hear
    // the all-clear.
    const subSrc = plantCommittedSubmodule();
    try {
      writeFileSync(join(repo, 'sub', 'f.txt'), 'pre-existing dirt\n');
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(lines.at(-1)).toContain(
        'the tree is unchanged since the snapshot',
      );
      expect(lines.at(-1)).not.toContain('cannot see');
      // …and the pre-existing dirt is still disclosed, and named, as such.
      expect(
        lines.some((l) => l.includes('pre-existing') && /\bsub\b/.test(l)),
      ).toBe(true);
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('discloses pre-existing dirt beside a non-empty diff too', () => {
    // The note's closing sentence — "Edits inside them since remain
    // invisible" — must not become unreachable whenever the hunks file is
    // non-empty: the auditor trusts the hunks as the complete edit set.
    const subSrc = plantCommittedSubmodule();
    try {
      writeFileSync(join(repo, 'sub', 'f.txt'), 'pre-existing dirt\n');
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      writeFileSync(join(repo, 'a.ts'), 'export const x = 42;\n');
      writeFileSync(join(repo, 'sub', 'f.txt'), 'edited inside after\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toContain(
        '+export const x = 42;',
      );
      const lines = stderr();
      expect(lines.at(-2)).toBe(
        'fix-delta: 1 file(s) changed since the snapshot — a.ts',
      );
      expect(lines.at(-1)).toContain('pre-existing');
      expect(lines.at(-1)).toMatch(/\bsub\b/);
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('names pre-existing dirt beside a fresh blind spot', () => {
    // The fresh-dirt warning must not swallow the pre-existing note: the
    // orchestrator reads only this stderr, so a submodule dirty at snapshot
    // time that the fix also edited must be named beside the new one.
    const srcA = plantCommittedSubmodule('subA');
    const srcB = plantCommittedSubmodule('subB');
    try {
      writeFileSync(join(repo, 'subA', 'f.txt'), 'pre-existing dirt\n');
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      writeFileSync(join(repo, 'subB', 'new-file.txt'), 'untracked inside\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(
        lines.some((l) => l.includes('pre-existing') && /\bsubA\b/.test(l)),
      ).toBe(true);
      expect(
        lines.some((l) => l.includes('cannot see') && /\bsubB\b/.test(l)),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    } finally {
      rmSync(srcA, { recursive: true, force: true });
      rmSync(srcB, { recursive: true, force: true });
    }
  });

  it('names a submodule whose snapshot-time dirt is gone now', () => {
    // Dirt at snapshot time that is CLEAN now necessarily changed on disk
    // between the two states — yet the gitlink never moves, a clean
    // submodule emits no status entry, and the trees stay byte-identical.
    const subSrc = plantCommittedSubmodule();
    try {
      writeFileSync(join(repo, 'sub', 'f.txt'), 'dirt at snapshot time\n');
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      // The fix restores the committed content.
      writeFileSync(join(repo, 'sub', 'f.txt'), 'before\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(
        lines.some((l) => l.includes('gone now') && /\bsub\b/.test(l)),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('discloses a cleaned submodule beside a non-empty diff too', () => {
    // A fix that edits a regular file AND restores a submodule dirty at
    // snapshot time: the invisible content change must be disclosed on the
    // non-empty path as well — the auditor trusts the hunks as the complete
    // edit set there.
    const subSrc = plantCommittedSubmodule();
    try {
      writeFileSync(join(repo, 'sub', 'f.txt'), 'dirt at snapshot time\n');
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      writeFileSync(join(repo, 'a.ts'), 'export const x = 42;\n');
      // The fix restores the committed content inside the submodule.
      writeFileSync(join(repo, 'sub', 'f.txt'), 'before\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toContain(
        '+export const x = 42;',
      );
      const lines = stderr();
      expect(
        lines.some((l) => l.includes('gone now') && /\bsub\b/.test(l)),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('never reports a submodule whose only change is new commits', () => {
    // A new-commits flag means the gitlink moved — the edit IS visible in
    // the tree comparison, so reporting "invisible edits" would steer the
    // orchestrator away from a correct ledger.
    const subSrc = plantCommittedSubmodule();
    const sub = join(repo, 'sub');
    try {
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      // Advance the submodule HEAD AFTER the snapshot: the moved gitlink is
      // a visible change, reported as the one changed file it is.
      writeFileSync(join(sub, 'f.txt'), 'advanced\n');
      gitAt(sub, 'add', '-A');
      gitAt(sub, 'commit', '-qm', 'advance');
      runSince();
      expect(stderr().at(-1)).toBe(
        'fix-delta: 1 file(s) changed since the snapshot — sub',
      );
      expect(stderr().some((l) => l.includes('cannot see'))).toBe(false);

      // The same shape with the move already recorded — snapshot taken after
      // the commit inside: nothing applied, nothing invisible.
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      runSince();
      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      expect(stderr().at(-1)).toContain(
        'the tree is unchanged since the snapshot',
      );
      expect(stderr().some((l) => l.includes('cannot see'))).toBe(false);
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('names an untracked embedded repo the snapshot records as a gitlink', () => {
    // `? emb/` is the only untracked shape that survives
    // `showUntrackedFiles=all` unexpanded, and `add -A` records its gitlink
    // all the same — an edit inside leaves both trees byte-identical.
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    const emb = join(repo, 'emb');
    mkdirSync(emb);
    gitAt(emb, 'init', '-q', '-b', 'main');
    gitAt(emb, 'config', 'user.email', 't@t.t');
    gitAt(emb, 'config', 'user.name', 't');
    writeFileSync(join(emb, 'f.txt'), 'committed inside\n');
    gitAt(emb, 'add', '-A');
    gitAt(emb, 'commit', '-qm', 'init');
    writeFileSync(join(emb, 'f.txt'), 'the fix — uncommitted inside\n');
    runSince();

    const lines = stderr();
    expect(
      lines.some((l) => /\bemb\b/.test(l) && l.includes('cannot see')),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(false);
  });

  it('names a nested repo whose name needs C-quoting under default core.quotePath', () => {
    // Default `core.quotePath` renders the `? ` entry of a non-ASCII name
    // C-quoted — no '/', no resolvable path — so parsing the rendered line
    // skipped the repository silently and printed the false all-clear beside
    // an edit that landed inside. `-z` reads the raw name.
    const nd = join(repo, '文dir');
    mkdirSync(nd);
    gitAt(nd, 'init', '-q', '-b', 'main');
    gitAt(nd, 'config', 'user.email', 't@t.t');
    gitAt(nd, 'config', 'user.name', 't');
    writeFileSync(join(nd, 'f.txt'), 'inside\n');
    gitAt(nd, 'add', '-A');
    gitAt(nd, 'commit', '-qm', 'init');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(nd, 'f.txt'), 'the fix — uncommitted inside\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some((l) => l.includes('文dir') && l.includes('cannot see')),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(false);
  });

  it('does not stamp a clean untracked nested repo as pre-existing dirt', () => {
    // A `?` entry carries no dirt flag: a pre-existing nested repo with
    // fully committed interior is CLEAN at snapshot time. Stamping it dirty
    // prints a false pre-existing note on a no-op run, and filters a fix's
    // real interior edit out of the baseline into a false all-clear.
    const emb = join(repo, 'emb');
    mkdirSync(emb);
    gitAt(emb, 'init', '-q', '-b', 'main');
    gitAt(emb, 'config', 'user.email', 't@t.t');
    gitAt(emb, 'config', 'user.name', 't');
    writeFileSync(join(emb, 'f.txt'), 'committed inside\n');
    gitAt(emb, 'add', '-A');
    gitAt(emb, 'commit', '-qm', 'init');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });

    // (a) No edits: no false pre-existing note beside the all-clear — and
    // the all-clear is HEDGED to what the capture can see: edits inside
    // gitignored paths are outside the model, and the bare claim beside
    // them is the defect this pins.
    runSince();
    expect(
      stderr().some((l) =>
        l.includes('the tree is unchanged since the snapshot'),
      ),
    ).toBe(true);
    expect(stderr().some((l) => l.includes('gitignored'))).toBe(true);
    expect(stderr().some((l) => l.includes('pre-existing'))).toBe(false);

    // (b) A fix editing inside the nested repo, uncommitted there.
    (writeStderrLine as unknown as Mock).mockClear();
    writeFileSync(join(emb, 'f.txt'), 'the fix — uncommitted inside\n');
    runSince();
    const lines = stderr();
    expect(
      lines.some((l) => /\bemb\b/.test(l) && l.includes('cannot see')),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(false);
  });

  it('names a staged-deleted gitlink whose checkout still holds the content', () => {
    // `git rm --cached sub` prints `1 D. S...` — no dirt flags for git to
    // compute — but the checkout reappears as `? sub/`, and edits inside are
    // invisible: both snapshots record the same gitlink.
    const subSrc = plantCommittedSubmodule();
    try {
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      git('rm', '--cached', '-q', 'sub');
      writeFileSync(join(repo, 'sub', 'f.txt'), 'after — the fix\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const last = stderr().at(-1) ?? '';
      expect(last).toMatch(/\bsub\b/);
      expect(last).toContain('cannot see');
      expect(last).not.toContain('the tree is unchanged since the snapshot');
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('names a renamed gitlink that also holds an interior write', () => {
    // A staged gitlink rename prints a type-`2` line — the M/U flag proves
    // git sees invisible content, and `^1 ` can never match it.
    const subSrc = plantCommittedSubmodule();
    try {
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      git('mv', 'sub', 'sub2');
      writeFileSync(join(repo, 'sub2', 'f.txt'), 'after — the fix\n');
      runSince();

      const lines = stderr();
      expect(
        lines.some((l) => /\bsub2\b/.test(l) && l.includes('cannot see')),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('names an unmerged gitlink that also holds an interior write', () => {
    // A mid-merge submodule conflict prints a `u` entry — unmatchable by any
    // `1 `-anchored parse — while the snapshot survives the unmerged index.
    const subSrc = plantCommittedSubmodule();
    const sub = join(repo, 'sub');
    try {
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      // Force a submodule conflict: two branches move the gitlink to
      // divergent commits.
      const orig = git('rev-parse', 'HEAD:sub');
      git('checkout', '-qb', 'b1');
      writeFileSync(join(sub, 'f.txt'), 'v1\n');
      gitAt(sub, 'add', '-A');
      gitAt(sub, 'commit', '-qm', 'v1');
      git('add', 'sub');
      git('commit', '-qm', 'sub v1');
      git('checkout', '-q', 'main');
      gitAt(sub, 'checkout', '-q', orig);
      git('checkout', '-qb', 'b2');
      writeFileSync(join(sub, 'f.txt'), 'v2\n');
      gitAt(sub, 'add', '-A');
      gitAt(sub, 'commit', '-qm', 'v2');
      git('add', 'sub');
      git('commit', '-qm', 'sub v2');
      expect(() => git('merge', 'b1')).toThrow();
      writeFileSync(join(sub, 'f.txt'), 'after — the fix\n');
      runSince();

      const lines = stderr();
      expect(
        lines.some((l) => /\bsub\b/.test(l) && l.includes('cannot see')),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it("keeps the user's index byte-identical even against a stale stat cache", () => {
    // A bare `git status` opportunistically rewrites .git/index to refresh a
    // stale stat cache — a write this command promises never to make. BOTH
    // modes run a status (the snapshot records the submodule baseline), so
    // the bytes are captured before EITHER mode, over an unchanged tree.
    // Touch a tracked file's mtime without touching its content, so the
    // cache entry is stale when the probes run.
    const file = join(repo, 'a.ts');
    const st = statSync(file);
    utimesSync(file, st.atime, new Date(st.mtimeMs + 5000));
    const indexBefore = readFileSync(join(repo, '.git', 'index'));
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    runSince();
    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    expect(readFileSync(join(repo, '.git', 'index')).equals(indexBefore)).toBe(
      true,
    );
  });

  it('sees untracked-only submodule dirt when the user hides untracked files', () => {
    // `status.showUntrackedFiles=no` is git's documented performance setting
    // for large repos; the submodule's untracked flag is computed by a run
    // inside the submodule reading that config, so the probe overrides it.
    const subSrc = plantCommittedSubmodule();
    try {
      writeFileSync(
        join(gitIsolation.home, '.gitconfig'),
        '[status]\n\tshowUntrackedFiles = no\n',
      );
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      writeFileSync(join(repo, 'sub', 'new-file.txt'), 'untracked inside\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const last = stderr().at(-1) ?? '';
      expect(last).toMatch(/\bsub\b/);
      expect(last).toContain('cannot see');
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it("leaves the user's index and stash exactly as they were", () => {
    // A staged hunk and an unstaged one, on purpose: the snapshot must read
    // the WORKING TREE without adding to, or resetting, what the user staged.
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    git('add', 'a.ts');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 3;\n');
    // A planted stash makes the stash-stack invariance assertion below
    // non-vacuous: a snapshot that disturbed the stack can no longer pass.
    writeFileSync(join(repo, 'stashee.ts'), 'planted\n');
    git('stash', 'push', '-u', '-m', 'planted', '--', 'stashee.ts');
    writeFileSync(join(repo, 'untracked.ts'), 'x\n');
    const statusBefore = git('status', '--porcelain', '--untracked-files=all');
    const stashBefore = git('stash', 'list');
    expect(stashBefore).not.toBe('');
    const indexBefore = git('write-tree');

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(repo, 'untracked.ts'), 'y\n');
    // A git-ignored file created between the states must stay out of the
    // hunks — the property `add -A` is relied on for.
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'x\n');
    runSince();

    expect(git('status', '--porcelain', '--untracked-files=all')).toBe(
      statusBefore,
    );
    expect(git('stash', 'list')).toBe(stashBefore);
    expect(git('write-tree')).toBe(indexBefore);
    // …and the working-tree read saw the UNSTAGED content, not the staged one.
    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).toContain('-x\n+y');
    expect(hunks).not.toContain('x = 2');
    expect(hunks).not.toContain('node_modules');
  });

  it("excludes the review's own side files, which change between the two states", () => {
    // The real layout: the snapshot and the hunks are themselves review side
    // files under .qwen/tmp, written between the two states — excluded by
    // the review's own NAME families, at any depth, including the prompt
    // record dirs and the worktree family.
    const snapshot = join(
      repo,
      '.qwen',
      'tmp',
      'qwen-review-local-fix-snapshot.json',
    );
    const hunksOut = join(
      repo,
      '.qwen',
      'tmp',
      'qwen-review-local-fix-hunks.diff',
    );
    runFixDelta({ snapshot: true, since: undefined, out: snapshot });
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'qwen-review-local-ledger.json'),
      '[]\n',
    );
    mkdirSync(join(repo, '.qwen', 'tmp', 'qwen-review-local-prompts', 'sub'), {
      recursive: true,
    });
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'qwen-review-local-prompts', 'sub', 'p.md'),
      'x\n',
    );
    mkdirSync(join(repo, '.qwen', 'tmp', 'review-pr-9'), { recursive: true });
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'review-pr-9', 'side.json'),
      '{}\n',
    );
    // …and a review run from a subdirectory writes them under that
    // subdirectory: the exclusion matches at any depth.
    mkdirSync(join(repo, 'sub', '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      join(repo, 'sub', '.qwen', 'tmp', 'qwen-review-local-nested.json'),
      '{}\n',
    );
    writeFileSync(join(repo, '.qwen', 'settings.json'), '{}\n');
    writeFileSync(join(repo, '.qwen', 'tmp', 'user-notes.txt'), 'mine\n');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 9;\n');
    runSince(snapshot, hunksOut);
    const hunks = readFileSync(hunksOut, 'utf8');
    expect(hunks).toContain('a/a.ts');
    expect(hunks).not.toContain('qwen-review-local-ledger.json');
    expect(hunks).not.toContain('p.md');
    expect(hunks).not.toContain('review-pr-9');
    expect(hunks).not.toContain('qwen-review-local-nested.json');
    expect(hunks).not.toContain('fix-snapshot.json');
    // Only the review's own names are excluded — a fix that touched a real
    // `.qwen/` file, or user content under `.qwen/tmp`, is still an edit.
    expect(hunks).toContain('a/.qwen/settings.json');
    expect(hunks).toContain('user-notes.txt');
  });

  it('runs from a subdirectory cwd without losing the rest of the tree', () => {
    // A review runs from a subdirectory too: root resolution is
    // cwd-dependent, and every inner call carries `-C root` — dropping it
    // from any of them scopes the call to the subdirectory alone and the
    // rest of the tree falls out of the snapshot.
    const subdir = join(repo, 'subdir');
    mkdirSync(subdir);
    process.chdir(subdir);
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(realpathSync(snap.root)).toBe(repo);
    writeFileSync(join(repo, 'a.ts'), 'export const x = 9;\n');
    writeFileSync(join(subdir, 'b.ts'), 'export const b = 1;\n');
    // A review run from the subdirectory writes its side files there.
    mkdirSync(join(subdir, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(
      join(subdir, '.qwen', 'tmp', 'qwen-review-local-side.json'),
      '{}\n',
    );
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).toContain('+export const x = 9;');
    expect(hunks).toContain('diff --git a/subdir/b.ts b/subdir/b.ts');
    expect(hunks).not.toContain('qwen-review-local-side.json');
    expect(stderr().at(-1)).toBe(
      'fix-delta: 2 file(s) changed since the snapshot — a.ts, subdir/b.ts',
    );
  });

  it('snapshots a sparse-checkout repository whose cone excludes the side files', () => {
    // Sparse checkout is git's standard large-repo configuration; the side
    // files then sit OUTSIDE the cone, and without `--sparse` the snapshot
    // dies on a raw `add -A` failure after the fix already landed.
    mkdirSync(join(repo, 'cone'));
    mkdirSync(join(repo, 'outcone'));
    writeFileSync(join(repo, 'cone', 'in.ts'), 'in\n');
    writeFileSync(join(repo, 'outcone', 'out.ts'), 'out\n');
    git('add', '-A');
    git('commit', '-qm', 'cone fixtures');
    git('sparse-checkout', 'set', 'cone');
    const snapshot = join(
      repo,
      '.qwen',
      'tmp',
      'qwen-review-local-fix-snapshot.json',
    );
    const hunksOut = join(
      repo,
      '.qwen',
      'tmp',
      'qwen-review-local-fix-hunks.diff',
    );
    runFixDelta({ snapshot: true, since: undefined, out: snapshot });
    writeFileSync(join(repo, 'cone', 'in.ts'), 'in — the fix\n');
    runSince(snapshot, hunksOut);

    const hunks = readFileSync(hunksOut, 'utf8');
    expect(hunks).toContain('+in — the fix');
    // Out-of-cone tracked entries drop identically from both trees: no
    // phantom deletion.
    expect(hunks).not.toContain('outcone/out.ts');
  });

  it('writes an empty diff and says so when nothing changed', () => {
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    runSince();
    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    expect(stderr().at(-1)).toContain(
      'the tree is unchanged since the snapshot',
    );
  });

  it('snapshots an unborn repository from an empty tree', () => {
    const fresh = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-unborn-')),
    );
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: fresh });
      writeFileSync(join(fresh, 'a.ts'), 'a\n');
      const tree = snapshotWorkingTree(fresh);
      expect(
        execFileSync('git', ['ls-tree', '--name-only', tree], {
          cwd: fresh,
          encoding: 'utf8',
        }).trim(),
      ).toBe('a.ts');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('does not capture its own scratch index when the temp dir is inside the worktree', () => {
    // os.tmpdir() honours TMPDIR; a hermetic sandbox pointing it into the
    // worktree made `add -A` record the scratch directory itself — the
    // command's own temp files reported as fix edits.
    const hostile = join(repo, 'tmp');
    mkdirSync(hostile);
    tmpdirOverride.value = hostile;
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(repo, 'a.ts'), 'export const x = 5;\n');
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).toContain('+export const x = 5;');
    expect(hunks).not.toContain('qwen-fix-delta-');
    expect(stderr().at(-1)).toBe(
      'fix-delta: 1 file(s) changed since the snapshot — a.ts',
    );
  });

  it('does not capture a git directory that sits inside the worktree', () => {
    // `git init --separate-git-dir` (or a `.git` file redirecting into the
    // tree) makes the git dir ordinary capturable content: between the two
    // states `write-tree` creates new loose objects in it, so without an
    // exclusion the hunks drown in `.realgit/**` churn while the command
    // still exits 0 — no signal for the audit to distrust the edit set.
    const wt = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-sepgd-')),
    );
    const cwdHere = process.cwd();
    try {
      gitAt(
        wt,
        'init',
        '-q',
        '-b',
        'main',
        '--separate-git-dir',
        join(wt, '.realgit'),
      );
      gitAt(wt, 'config', 'user.email', 't@t.t');
      gitAt(wt, 'config', 'user.name', 't');
      writeFileSync(join(wt, 'a.ts'), 'export const x = 1;\n');
      // Add a.ts ALONE: the in-worktree git dir stays UNTRACKED, which is
      // the shape the capture-side exclusion exists for — an `add -A` here
      // would commit `.realgit` into HEAD, and `read-tree HEAD` would then
      // seed it into every snapshot tree whether the capture excludes it or
      // not.
      gitAt(wt, 'add', 'a.ts');
      gitAt(wt, 'commit', '-qm', 'head');
      process.chdir(wt);
      const snap = join(out, 'sepgd-snapshot.json');
      const hunks = join(out, 'sepgd-hunks.diff');
      runFixDelta({ snapshot: true, since: undefined, out: snap });
      // Capture-side witness: the snapshot TREE itself must not record the
      // git dir. Every assertion below reads outputs of the comparison-side
      // calls, which apply their own exclusion — so they would stay green
      // while the capture re-hashed the whole object database into the
      // throwaway trees on every snapshot.
      const snapTree = (JSON.parse(readFileSync(snap, 'utf8')) as FixSnapshot)
        .tree;
      expect(
        gitAt(wt, 'ls-tree', '--name-only', snapTree).trim().split('\n'),
      ).not.toContain('.realgit');
      writeFileSync(join(wt, 'a.ts'), 'export const x = 2;\n');
      runSince(snap, hunks);

      const h = readFileSync(hunks, 'utf8');
      expect(h).toContain('+export const x = 2;');
      expect(h).not.toContain('qwen-fix-delta-');
      expect(h).not.toContain('.realgit/');
      expect(stderr().at(-1)).toBe(
        'fix-delta: 1 file(s) changed since the snapshot — a.ts',
      );
    } finally {
      process.chdir(cwdHere);
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('keeps an edit visible when the in-worktree git dir name is a glob pattern', () => {
    // The git-dir exclusion is `literal`: a name like `g[ab]d` is raw path
    // text, and the default wildcard matching would read it as a glob that
    // matches the merely-similar tracked file `gbd` — dropping the fix's
    // edit from capture and comparison beside the false all-clear.
    const wt = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-globgd-')),
    );
    const cwdHere = process.cwd();
    try {
      gitAt(wt, 'init', '-q', '-b', 'main', '--separate-git-dir=g[ab]d', '.');
      gitAt(wt, 'config', 'user.email', 't@t.t');
      gitAt(wt, 'config', 'user.name', 't');
      writeFileSync(join(wt, 'gbd'), 'v1\n');
      gitAt(wt, 'add', 'gbd');
      gitAt(wt, 'commit', '-qm', 'head');
      process.chdir(wt);
      const snap = join(out, 'globgd-snapshot.json');
      const hunks = join(out, 'globgd-hunks.diff');
      runFixDelta({ snapshot: true, since: undefined, out: snap });
      writeFileSync(join(wt, 'gbd'), 'v2\n');
      runSince(snap, hunks);

      expect(readFileSync(hunks, 'utf8')).toContain('+v2');
      expect(stderr().at(-1)).toBe(
        'fix-delta: 1 file(s) changed since the snapshot — gbd',
      );
    } finally {
      process.chdir(cwdHere);
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('excludes an in-worktree git dir nested two components below the root', () => {
    // The git-dir exclusion embeds a `path.relative` output in a
    // `:(exclude,literal)` pathspec, and pathspec matching is `/`-based on
    // every platform. A git dir two or more components below the root —
    // where the relative path HAS a separator in it — must reach the
    // pathspec in git's separator or the exclusion matches nothing: the
    // whole git dir enters the capture, and the loose objects `write-tree`
    // creates between the states flood the hunks.
    const wt = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-nestgd-')),
    );
    const cwdHere = process.cwd();
    try {
      mkdirSync(join(wt, 'sub'));
      gitAt(
        wt,
        'init',
        '-q',
        '-b',
        'main',
        '--separate-git-dir',
        join(wt, 'sub', 'gd'),
      );
      gitAt(wt, 'config', 'user.email', 't@t.t');
      gitAt(wt, 'config', 'user.name', 't');
      writeFileSync(join(wt, 'a.ts'), 'export const x = 1;\n');
      // Add a.ts ALONE, like the root-level fixture: the in-worktree git
      // dir stays UNTRACKED, which is the shape the exclusion exists for.
      gitAt(wt, 'add', 'a.ts');
      gitAt(wt, 'commit', '-qm', 'head');
      process.chdir(wt);
      // The pathspec itself — the byte form the capture carries: git's
      // separator is the only one it may carry.
      const specs = capturePathspecBytes(wt).toString('latin1').split('\0');
      expect(specs).toContain(':(exclude,literal)sub/gd');
      for (const spec of specs) {
        expect(spec.includes('\\')).toBe(false);
      }
      const snap = join(out, 'nestgd-snapshot.json');
      const hunks = join(out, 'nestgd-hunks.diff');
      runFixDelta({ snapshot: true, since: undefined, out: snap });
      const snapTree = (JSON.parse(readFileSync(snap, 'utf8')) as FixSnapshot)
        .tree;
      expect(
        gitAt(wt, 'ls-tree', '--name-only', snapTree).trim().split('\n'),
      ).not.toContain('sub');
      writeFileSync(join(wt, 'a.ts'), 'export const x = 2;\n');
      runSince(snap, hunks);

      const h = readFileSync(hunks, 'utf8');
      expect(h).toContain('+export const x = 2;');
      expect(h).not.toContain('qwen-fix-delta-');
      expect(h).not.toContain('sub/gd/');
      expect(stderr().at(-1)).toBe(
        'fix-delta: 1 file(s) changed since the snapshot — a.ts',
      );
    } finally {
      process.chdir(cwdHere);
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'does not read a backslash-sibling git dir as in-tree on POSIX',
    () => {
      // `git init --separate-git-dir '<wt>\packages'` puts the git dir at
      // a SIBLING of the worktree whose name begins with the worktree's
      // name plus a backslash — POSIX-legal, while `\` is git's separator
      // spelling on win32 only. Byte arithmetic that accepts 0x5c as the
      // boundary on every platform answered "the in-tree git dir is
      // packages" for it, and the exclusion dropped the real in-tree
      // `packages/` from the capture pathspec and the probe alike.
      const base = realpathSync(
        mkdtempSync(join(tmpdir(), 'qwen-fix-delta-bsgd-')),
      );
      const wt = join(base, 'repo');
      const gd = join(base, 'repo\\packages');
      const cwdHere = process.cwd();
      try {
        gitAt(base, 'init', '-q', '-b', 'main', '--separate-git-dir', gd, wt);
        gitAt(wt, 'config', 'user.email', 't@t.t');
        gitAt(wt, 'config', 'user.name', 't');
        writeFileSync(join(wt, 'a.ts'), 'export const x = 1;\n');
        gitAt(wt, 'add', 'a.ts');
        gitAt(wt, 'commit', '-qm', 'head');
        // The git dir resolves OUTSIDE the worktree: the capture's
        // pathspec must carry no `packages` exclusion for it.
        const specs = capturePathspecBytes(wt).toString('latin1').split('\0');
        expect(specs.some((s) => s.includes('packages'))).toBe(false);
        // …and the probe must still see the nested repository the in-tree
        // `packages/` holds.
        const nested = join(wt, 'packages', 'nested');
        mkdirSync(nested, { recursive: true });
        gitAt(nested, 'init', '-q', '-b', 'main');
        gitAt(nested, 'config', 'user.email', 't@t.t');
        gitAt(nested, 'config', 'user.name', 't');
        writeFileSync(join(nested, 'f.txt'), 'v1\n');
        gitAt(nested, 'add', '-A');
        gitAt(nested, 'commit', '-qm', 'init');
        process.chdir(wt);
        const snap = join(out, 'bsgd-snapshot.json');
        const hunks = join(out, 'bsgd-hunks.diff');
        runFixDelta({ snapshot: true, since: undefined, out: snap });
        writeFileSync(join(nested, 'f.txt'), 'the hidden fix\n');
        runSince(snap, hunks);

        const lines = stderr();
        expect(
          lines.some(
            (l) => l.includes('packages/nested') && l.includes('cannot see'),
          ),
        ).toBe(true);
        expect(
          lines.some((l) =>
            l.includes('the tree is unchanged since the snapshot'),
          ),
        ).toBe(false);
      } finally {
        process.chdir(cwdHere);
        rmSync(base, { recursive: true, force: true });
      }
    },
  );

  it('survives an untracked nested git repository with no commits', () => {
    // git refuses `add` on a repo with nothing checked out; the capture
    // tolerates exactly that failure and records everything else, instead of
    // dying with a raw trace after the fix already landed. The commitless
    // repo stays invisible in both trees — the same model as submodule
    // content — and the blind-spot note names it.
    const nested = join(repo, 'nested');
    mkdirSync(nested);
    gitAt(nested, 'init', '-q', '-b', 'main');
    writeFileSync(join(nested, 'f.txt'), 'untracked inside\n');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(repo, 'a.ts'), 'export const x = 9;\n');
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).toContain('+export const x = 9;');
    const lines = stderr();
    expect(lines.some((l) => /\bnested\b/.test(l))).toBe(true);
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(false);
  });

  it('survives a staged rename whose original path parses as a status entry', () => {
    // A rename's original path rides its own NUL element; consumed only
    // AFTER the sub-token gates, an ordinary-file rename re-injected the
    // original path into the entry stream, and a name like `u x` then died
    // in the parser on a missing field.
    writeFileSync(join(repo, 'u x'), 'rename me\n');
    git('add', '-A');
    git('commit', '-qm', 'add u x');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    git('mv', 'u x', 'renamed.txt');
    runSince();

    expect(stderr().at(-1)).toBe(
      'fix-delta: 1 file(s) changed since the snapshot — renamed.txt',
    );
    expect(readFileSync(hunksFile(), 'utf8')).toContain(
      'rename to renamed.txt',
    );
  });

  it("does not classify the review's own worktrees as blind-spot dirt", () => {
    // The probe applies the same exclusion as capture and comparison: a
    // review worktree under .qwen/tmp created or dirtied between the states
    // is bookkeeping, not a submodule holding invisible edits — without the
    // pathspec it passes the `?` gates and replaces the verdict line.
    git('worktree', 'add', '--detach', join('.qwen', 'tmp', 'review-pr-1'));
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'review-pr-1', 'stray.txt'),
      'x\n',
    );
    runSnapshot([join(repo, '.qwen', 'tmp', 'review-pr-1')]);
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'review-pr-1', 'stray.txt'),
      'y\n',
    );
    runSince(snapshotFile(), hunksFile(), [
      join(repo, '.qwen', 'tmp', 'review-pr-1'),
    ]);

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(lines.some((l) => l.includes('cannot see'))).toBe(false);
    expect(lines.some((l) => l.includes('pre-existing'))).toBe(false);
    expect(lines.at(-1)).toContain('the tree is unchanged since the snapshot');
  });

  it('excludes the review worktree when .gitignore names the family directly', () => {
    // Naming the family directly (not `.qwen/*`) collapses the worktree
    // itself to one `!` entry — a GIT-originated relative path, which is
    // `/`-separated on every platform. The exclusion must prune it there,
    // or the probe records the review's own bookkeeping as blind-spot dirt
    // and names it in false pre-existing/blind-spot notes.
    writeFileSync(
      join(repo, '.gitignore'),
      'node_modules\n.qwen/tmp/review-pr-*\n',
    );
    git('add', '-A');
    git('commit', '-qm', 'ignore the family');
    git('worktree', 'add', '--detach', join('.qwen', 'tmp', 'review-pr-1'));
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'review-pr-1', 'stray.txt'),
      'x\n',
    );
    runSnapshot([join(repo, '.qwen', 'tmp', 'review-pr-1')]);
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(snap.dirtySubmodules.some((p) => p.includes('review-pr-1'))).toBe(
      false,
    );
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'review-pr-1', 'stray.txt'),
      'y\n',
    );
    runSince(snapshotFile(), hunksFile(), [
      join(repo, '.qwen', 'tmp', 'review-pr-1'),
    ]);
    const lines = stderr();
    expect(lines.some((l) => l.includes('review-pr-1'))).toBe(false);
    expect(lines.at(-1)).toContain('the tree is unchanged since the snapshot');
    // The all-clear states the model's scope beside its claim: the working
    // tree and the working trees nested in it — a gitignored file's edit
    // and the interior of any git directory are outside every working
    // tree, and are not something the command claims to have seen.
    expect(lines.at(-1)).toContain(
      'edits to gitignored files, and anything inside a git directory, are outside this model',
    );
  });

  it('keeps user content tracked under .qwen directories visible', () => {
    // The exclusion is keyed on the review's own name families, never on
    // whole directories: content a repository tracks under `.qwen/reviews`
    // is ordinary reviewable content — a finding can anchor on it and the
    // fix can edit exactly that file between the two states.
    mkdirSync(join(repo, '.qwen', 'reviews'), { recursive: true });
    writeFileSync(join(repo, '.qwen', 'reviews', 'report.md'), 'v1\n');
    git('add', '-A');
    git('commit', '-qm', 'commit a review artifact');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(repo, '.qwen', 'reviews', 'report.md'), 'v2\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toContain('+v2');
    expect(stderr().at(-1)).toBe(
      'fix-delta: 1 file(s) changed since the snapshot — ' +
        '.qwen/reviews/report.md',
    );
  });

  it('refuses a symlinked .qwen/tmp instead of writing through the redirect', () => {
    // A symlink at an excluded directory redirects every side-file write
    // into a physical path no lexical pathspec matches — the hunks would
    // report the review's own bookkeeping (or attacker-planted content) as
    // fix edits. The run is refused, the way `releaseWorktree` refuses a
    // redirected ancestor.
    rmSync(join(repo, '.qwen', 'tmp'), { recursive: true, force: true });
    mkdirSync(join(repo, 'realtmp'));
    symlinkSync('realtmp', join(repo, '.qwen', 'tmp'));
    expect(() =>
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() }),
    ).toThrow(/excluded directory .* is a symlink/);
  });

  it('refuses a symlink planted at a side path instead of writing through it', () => {
    // The directory guard lstats only the PREFIXES of the excluded
    // directories: the command's own deterministic side path — Step 6B
    // re-runs with the same `--out` name every round, and the tree author
    // knows it — is the tree author's to plant. A tracked link at exactly
    // that name redirects the write through it, truncating whatever it
    // points at outside everything this command is supposed to touch.
    const victim = join(out, 'victim.txt');
    writeFileSync(victim, 'sentinel — must survive\n');
    const sidePath = join(
      repo,
      '.qwen',
      'tmp',
      'qwen-review-t-fix-snapshot.json',
    );
    runFixDelta({ snapshot: true, since: undefined, out: sidePath });
    // The re-run premise the refusal must not break: overwriting an
    // existing REGULAR file at the same deterministic name keeps working.
    runFixDelta({ snapshot: true, since: undefined, out: sidePath });
    rmSync(sidePath);
    symlinkSync(victim, sidePath);
    expect(() =>
      runFixDelta({ snapshot: true, since: undefined, out: sidePath }),
    ).toThrow(/side path .* is a symlink; refusing to write through/);
    expect(readFileSync(victim, 'utf8')).toBe('sentinel — must survive\n');

    // The `--since` file is a side path the same way: a redirected read
    // hands the audit a fabricated baseline.
    rmSync(sidePath);
    const linkPath = join(out, 'fake-snapshot.json');
    symlinkSync(victim, linkPath);
    expect(() => runSince(linkPath)).toThrow(
      /side path .* is a symlink; refusing to write through/,
    );
  });

  // POSIX-only: the raw-0xFF directory name cannot exist on NTFS (Buffer
  // paths are utf8-coerced before reaching the filesystem APIs), and the
  // byte-exact setup channel is /bin/sh.
  it.skipIf(process.platform === 'win32')(
    'names a nested repo whose directory name is not valid UTF-8',
    () => {
      // The `-z` output is parsed byte-exactly: a UTF-8 decode of the raw
      // bytes would mangle the name to U+FFFD, and every filesystem check
      // under it would fail while an edit inside prints the bare all-clear.
      const nameBuf = Buffer.concat([Buffer.from('dir'), Buffer.from([0xff])]);
      const ndAbs = Buffer.concat([
        Buffer.from(repo),
        Buffer.from('/'),
        nameBuf,
      ]);
      mkdirSync(ndAbs);
      // Neither spawn args nor `cwd` can carry the invalid byte — both are
      // UTF-8 coerced — so the repo is set up through the shell's stdin, the
      // one byte-exact channel.
      execFileSync('/bin/sh', [], {
        input: Buffer.concat([
          Buffer.from("set -e\ncd -- '"),
          ndAbs,
          Buffer.from(
            "'\n" +
              'git init -q -b main\n' +
              'git config user.email t@t.t\n' +
              'git config user.name t\n' +
              'printf inside > f.txt\n' +
              'git add -A\n' +
              'git commit -qm init\n',
          ),
        ]),
      });
      const fAbs = Buffer.concat([ndAbs, Buffer.from('/f.txt')]);
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      writeFileSync(fAbs, 'the fix — uncommitted inside\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(
        lines.some(
          (l) =>
            l.includes(nameBuf.toString('latin1')) && l.includes('cannot see'),
        ),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    },
  );

  it('names a symlink to a repository whose interior is edited through the link', () => {
    // `add -A` records the link itself, so an edit through it into the repo
    // it reaches moves no blob — the slashless `? link` entry is probed the
    // same way as a directory.
    const target = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-linktgt-')),
    );
    try {
      gitAt(target, 'init', '-q', '-b', 'main');
      gitAt(target, 'config', 'user.email', 't@t.t');
      gitAt(target, 'config', 'user.name', 't');
      writeFileSync(join(target, 'f.txt'), 'inside\n');
      gitAt(target, 'add', '-A');
      gitAt(target, 'commit', '-qm', 'init');
      symlinkSync(target, join(repo, 'linkrepo'));
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      writeFileSync(join(target, 'f.txt'), 'the fix — through the link\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(
        lines.some((l) => /\blinkrepo\b/.test(l) && l.includes('cannot see')),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('names a TRACKED symlink to a repository edited through the link', () => {
    // Committed before the snapshot, an unchanged link emits no status
    // entry — status-only discovery printed the bare all-clear while the
    // edit was on disk. The index scan admits mode-120000 entries next to
    // the gitlinks and applies the same exclusion checks before probing.
    const target = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-linktgt-')),
    );
    try {
      gitAt(target, 'init', '-q', '-b', 'main');
      gitAt(target, 'config', 'user.email', 't@t.t');
      gitAt(target, 'config', 'user.name', 't');
      writeFileSync(join(target, 'f.txt'), 'inside\n');
      gitAt(target, 'add', '-A');
      gitAt(target, 'commit', '-qm', 'init');
      symlinkSync(target, join(repo, 'vendor'));
      git('add', '-A');
      git('commit', '-qm', 'commit the link');
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      writeFileSync(join(target, 'f.txt'), 'the fix — through the link\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(
        lines.some((l) => /\bvendor\b/.test(l) && l.includes('cannot see')),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('names a nested repo hidden one level inside an ignored directory', () => {
    // Status never enumerates under an ignored path and `add -A` records
    // nothing there, so a nested repository hidden inside one is discovered
    // only by walking the collapsed `! dir/` entry.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nignored-dir/\n');
    const inner = join(repo, 'ignored-dir', 'inner');
    mkdirSync(inner, { recursive: true });
    gitAt(inner, 'init', '-q', '-b', 'main');
    gitAt(inner, 'config', 'user.email', 't@t.t');
    gitAt(inner, 'config', 'user.name', 't');
    writeFileSync(join(inner, 'f.txt'), 'inside\n');
    gitAt(inner, 'add', '-A');
    gitAt(inner, 'commit', '-qm', 'init');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });

    // A no-op run against a CLEAN hidden repo keeps the all-clear —
    // hedged to the capture's scope, but still the all-clear.
    runSince();
    expect(
      stderr().some((l) =>
        l.includes('the tree is unchanged since the snapshot'),
      ),
    ).toBe(true);
    expect(stderr().some((l) => l.includes('gitignored'))).toBe(true);
    expect(stderr().some((l) => l.includes('pre-existing'))).toBe(false);

    // …but a fix editing inside it is disclosed.
    (writeStderrLine as unknown as Mock).mockClear();
    writeFileSync(join(inner, 'f.txt'), 'the fix — uncommitted inside\n');
    runSince();
    const lines = stderr();
    expect(
      lines.some(
        (l) => l.includes('ignored-dir/inner') && l.includes('cannot see'),
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(false);
  });

  it('names a nested repo whose only new content is self-ignored', () => {
    // The inner probe runs `--ignored=matching`: a repository whose only
    // beyond-tracked content matches its OWN ignore rules emits nothing to
    // a plain status and is clean at both moments — git's own word — so it
    // is not DIRT; but the `! ` entry rides the digest, and a file that
    // appeared under its ignore rules since the snapshot moves it. The
    // disclosure is the interior-moved note, not the fresh-dirt one.
    const emb = join(repo, 'emb');
    mkdirSync(emb);
    gitAt(emb, 'init', '-q', '-b', 'main');
    gitAt(emb, 'config', 'user.email', 't@t.t');
    gitAt(emb, 'config', 'user.name', 't');
    writeFileSync(join(emb, 'f.txt'), 'committed inside\n');
    writeFileSync(join(emb, '.gitignore'), 'self-ignored.txt\n');
    gitAt(emb, 'add', '-A');
    gitAt(emb, 'commit', '-qm', 'init');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(emb, 'self-ignored.txt'), 'the fix\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) => /\bemb\b/.test(l) && l.includes('committed or stashed inside'),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.includes('pre-existing'))).toBe(false);
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(false);
  });

  it('names a submodule whose path contains spaces', () => {
    // kind-1 entries carry their path after eight fixed fields; the raw
    // remainder is the name, spaces included — a re-parse that split and
    // re-joined on single spaces would garble it.
    const subSrc = plantCommittedSubmodule('emb dir');
    try {
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      writeFileSync(join(repo, 'emb dir', 'f.txt'), 'after — the fix\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(
        lines.some((l) => l.includes('emb dir') && l.includes('cannot see')),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('answers dirty when the inner probe cannot run', () => {
    // The documented failure direction, pinned: a probe that cannot run
    // over-warns, it never silences a blind spot. Corrupt the interior
    // AFTER the snapshot so the baseline classifies clean and the failed
    // probe at --since time is the only thing standing between the edit and
    // the false all-clear. The INDEX, not HEAD: a corrupted HEAD makes the
    // superproject expand the repo to plain untracked files — no collapsed
    // entry, no blind spot left to warn about — while a corrupted index
    // keeps both and fails only the inner status.
    const emb = join(repo, 'emb');
    mkdirSync(emb);
    gitAt(emb, 'init', '-q', '-b', 'main');
    gitAt(emb, 'config', 'user.email', 't@t.t');
    gitAt(emb, 'config', 'user.name', 't');
    writeFileSync(join(emb, 'f.txt'), 'committed inside\n');
    gitAt(emb, 'add', '-A');
    gitAt(emb, 'commit', '-qm', 'init');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(emb, '.git', 'index'), 'garbage\n');
    writeFileSync(join(emb, 'f.txt'), 'the fix — uncommitted inside\n');
    runSince();

    const lines = stderr();
    expect(
      lines.some((l) => /\bemb\b/.test(l) && l.includes('cannot see')),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(false);
  });

  it('snapshots the real worktree under a hostile host environment', () => {
    // Ambient GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE in the user's environment
    // must not divert the throwaway-index snapshot to another tree or write
    // through the index file they point at. The protection is
    // `sanitizedGitEnv`'s stripping plus `gitWithEnv` re-adding the scratch
    // index AFTER it — this pins the invariant end-to-end.
    const other = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-other-')),
    );
    try {
      gitAt(other, 'init', '-q', '-b', 'main');
      gitAt(other, 'config', 'user.email', 't@t.t');
      gitAt(other, 'config', 'user.name', 't');
      writeFileSync(join(other, 'decoy.ts'), 'decoy\n');
      gitAt(other, 'add', '-A');
      gitAt(other, 'commit', '-qm', 'decoy');
      const plantedIndex = join(other, 'planted-index');
      writeFileSync(plantedIndex, 'the ambient index bytes\n');
      const ambient = {
        GIT_DIR: join(other, '.git'),
        GIT_WORK_TREE: other,
        GIT_INDEX_FILE: plantedIndex,
      };
      const saved = Object.fromEntries(
        Object.keys(ambient).map((k) => [k, process.env[k]]),
      );
      Object.assign(process.env, ambient);
      try {
        const indexBefore = readFileSync(join(repo, '.git', 'index'));
        runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
        const snap = JSON.parse(
          readFileSync(snapshotFile(), 'utf8'),
        ) as FixSnapshot;
        expect(realpathSync(snap.root)).toBe(repo);
        writeFileSync(join(repo, 'a.ts'), 'export const x = 8;\n');
        runSince();
        expect(readFileSync(hunksFile(), 'utf8')).toContain(
          '+export const x = 8;',
        );
        expect(readFileSync(plantedIndex, 'utf8')).toBe(
          'the ambient index bytes\n',
        );
        expect(
          readFileSync(join(repo, '.git', 'index')).equals(indexBefore),
        ).toBe(true);
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  // The name-side assertions are POSIX-only: a latin-1 Buffer path is
  // utf8-coerced before reaching the NTFS APIs, so the byte-exact name
  // never exists on disk on the Windows lane.
  it.skipIf(process.platform === 'win32')(
    'keeps the hunks byte-faithful for non-UTF-8 content and names',
    () => {
      // The artifact must stay git's patch itself: a lossy `.toString('utf8')`
      // roundtrip rewrites every non-UTF-8 byte of the fix to U+FFFD — the
      // hunks stop being `git apply`-replayable — and the same roundtrip
      // mangles every non-UTF-8 name in the summary.
      const latinName = Buffer.from([0x62, 0xe9]); // latin-1 'bé'
      writeFileSync(
        join(repo, 'latin.txt'),
        Buffer.from([0x63, 0x61, 0x66, 0xe9]), // latin-1 'café'
      );
      writeFileSync(
        Buffer.concat([Buffer.from(repo), Buffer.from('/'), latinName]),
        'x\n',
      );
      git('add', '-A');
      git('commit', '-qm', 'latin bytes');
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      writeFileSync(
        join(repo, 'latin.txt'),
        Buffer.concat([
          Buffer.from([0x63, 0x61, 0x66, 0xe9]),
          Buffer.from(' noir\n'),
        ]),
      );
      writeFileSync(
        Buffer.concat([Buffer.from(repo), Buffer.from('/'), latinName]),
        'y\n',
      );
      runSince();

      const hunks = readFileSync(hunksFile());
      expect(hunks.includes(0xe9)).toBe(true);
      expect(hunks.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
      expect(
        stderr().some((l) => l.includes(latinName.toString('latin1'))),
      ).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
    'refuses a capture an unreadable directory silently truncated',
    () => {
      // `git add` prints `warning: could not open directory ... Permission
      // denied` over a mode-000 directory and EXITS 0, leaving the
      // directory's content absent from the index — a try/catch on the exit
      // status never runs, so the capture is ruled on the child's own notes.
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      const blocked = join(repo, 'blocked');
      mkdirSync(blocked);
      writeFileSync(join(blocked, 'fix.txt'), 'the fix\n');
      chmodSync(blocked, 0o000);
      try {
        expect(() => runSince()).toThrow(/could not capture the whole tree/);
      } finally {
        chmodSync(blocked, 0o755);
      }
    },
  );

  it.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
    'refuses when a tolerated failure masks an unreadable directory',
    () => {
      // The zero-commit repo's tolerated error beside an unreadable
      // directory: a substring match over the aggregate message tolerated
      // the WHOLE failure and silently dropped `blocked/**`. Line-by-line,
      // the permission warning finds no tolerance.
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      const nested = join(repo, 'nested');
      mkdirSync(nested);
      gitAt(nested, 'init', '-q', '-b', 'main');
      const blocked = join(repo, 'blocked');
      mkdirSync(blocked);
      writeFileSync(join(blocked, 'fix.txt'), 'the fix\n');
      chmodSync(blocked, 0o000);
      try {
        expect(() => runSince()).toThrow(/could not capture the whole tree/);
      } finally {
        chmodSync(blocked, 0o755);
      }
    },
  );

  it('survives the line-ending warnings under core.autocrlf', () => {
    // The normalisation warnings announce the stored form — the file IS
    // added. They find tolerance, or every capture under `core.autocrlf`
    // refuses.
    git('config', 'core.autocrlf', 'true');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    runSince();
    expect(readFileSync(hunksFile(), 'utf8')).toContain('+export const x = 2;');
  });

  it('pins LC_ALL=C on the git children whose text it parses', () => {
    // The tolerated-note patterns match git's English rendering; LANG/LC_*
    // pass through the sanitizer to the child, and a translated catalog
    // would turn every tolerated shape into a hard refusal.
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    const addCalls = spawnRecord.calls.filter((c) => c.args.includes('add'));
    expect(addCalls.length).toBeGreaterThan(0);
    for (const call of addCalls) {
      expect(call.env?.['LC_ALL']).toBe('C');
      expect(call.env?.['LANG']).toBe('C');
    }
  });

  it('refuses an add that did not exit, even beside tolerated notes', () => {
    // A child killed mid-`add` (timeout, buffer overflow) or never spawned
    // leaves the scratch index at its read-tree-seeded state; `write-tree`
    // would then record HEAD's tree as the snapshot — a false baseline with
    // no error. Tolerance belongs to genuine exits alone.
    const tolerated =
      "warning: in the working copy of 'f.txt', LF will be replaced by " +
      'CRLF the next time Git touches it';
    expect(() =>
      assertCompleteCapture({
        stderr: `${tolerated}\n`,
        status: -1,
        completed: false,
      }),
    ).toThrow(/could not capture the whole tree/);
    // …while the identical notes beside a genuine exit stay tolerated.
    expect(() =>
      assertCompleteCapture({
        stderr: `${tolerated}\n`,
        status: 0,
        completed: true,
      }),
    ).not.toThrow();
  });

  it('captures a tree whose add warnings pass the 1 MiB stream default', () => {
    // `add -A` runs through a throwaway index with no stat cache, so every
    // tracked file is re-added and re-warned under core.autocrlf; ~11k
    // files pass Node's 1 MiB spawnSync default — past it the child is
    // killed mid-capture and the verdict sees truncated notes over the
    // seeded index. The raised ceiling keeps the whole tree capturable.
    git('config', 'core.autocrlf', 'true');
    for (let i = 0; i < 11_000; i++) {
      writeFileSync(join(repo, `f${i}.ts`), `export const v${i} = ${i};\n`);
    }
    // The SETUP add already emits the >1 MiB of warnings; run it with
    // stderr ignored so the test helper's own 1 MiB `execFileSync` buffer
    // does not overflow before the command under test even runs.
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' });
    git('commit', '-qm', 'large tree');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(repo, 'f0.ts'), 'export const v0 = 42;\n');
    runSince();
    expect(readFileSync(hunksFile(), 'utf8')).toContain(
      '+export const v0 = 42;',
    );
  }, 60_000);

  it.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
    'discloses an unlistable directory instead of silently skipping it',
    () => {
      // A directory the walk cannot OPEN hides whatever repositories sit
      // under it; skipping it silently turned an interior edit into a bare
      // all-clear. The walk reports what it cannot open, and the failure
      // direction over-warns.
      writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
      git('add', '-A');
      git('commit', '-qm', 'ignore ig');
      const blocked = join(repo, 'ig', 'blocked');
      const inner = join(blocked, 'more', 'inner');
      mkdirSync(inner, { recursive: true });
      gitAt(inner, 'init', '-q', '-b', 'main');
      gitAt(inner, 'config', 'user.email', 't@t.t');
      gitAt(inner, 'config', 'user.name', 't');
      writeFileSync(join(inner, 'f.txt'), 'inside\n');
      gitAt(inner, 'add', '-A');
      gitAt(inner, 'commit', '-qm', 'init');
      chmodSync(blocked, 0o111); // traversable, not listable
      try {
        runFixDelta({
          snapshot: true,
          since: undefined,
          out: snapshotFile(),
        });
        writeFileSync(join(inner, 'f.txt'), 'the fix — uncommitted inside\n');
        runSince();
        const lines = stderr();
        expect(
          lines.some(
            (l) => l.includes('ig/blocked') && l.includes('cannot see'),
          ),
        ).toBe(true);
        expect(
          lines.some((l) =>
            l.includes('the tree is unchanged since the snapshot'),
          ),
        ).toBe(false);
      } finally {
        chmodSync(blocked, 0o755);
      }
    },
  );

  it("does not re-discover the review's own worktrees under an ignored .qwen", () => {
    // A repository ignoring `.qwen` collapses it to one `!` entry; the walk
    // under it then reaches the review's own worktrees, where no pathspec
    // can follow — the discoveries are checked against the same exclusion
    // families, or the snapshot records the review's own bookkeeping as
    // blind-spot dirt.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.qwen/*\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore .qwen');
    git('worktree', 'add', '--detach', join('.qwen', 'tmp', 'review-pr-1'));
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'review-pr-1', 'stray.txt'),
      'x\n',
    );
    runSnapshot([join(repo, '.qwen', 'tmp', 'review-pr-1')]);
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(snap.dirtySubmodules.some((p) => p.includes('review-pr-1'))).toBe(
      false,
    );
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'review-pr-1', 'stray.txt'),
      'y\n',
    );
    runSince(snapshotFile(), hunksFile(), [
      join(repo, '.qwen', 'tmp', 'review-pr-1'),
    ]);
    const lines = stderr();
    expect(lines.some((l) => l.includes('review-pr-1'))).toBe(false);
    expect(lines.some((l) => l.includes('cannot see'))).toBe(false);
    expect(lines.at(-1)).toContain('the tree is unchanged since the snapshot');
  });

  it('never records an unconfirmed exhaustion stamp in the baseline', () => {
    // Past the walk budget the directory is UNRESOLVED, not confirmed
    // dirt: stamped into the baseline, it would filter a fix's real
    // interior edit out of the warning into a false all-clear — the exact
    // transition this pins.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nbig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore big');
    const big = join(repo, 'big');
    mkdirSync(big);
    const inner = join(big, 'inner');
    mkdirSync(inner);
    gitAt(inner, 'init', '-q', '-b', 'main');
    // The budget is charged per DIRECTORY OPENED, so the fixture is
    // directories — and the ceiling is lowered for the test rather than
    // building a package store: production reads the same field.
    setWalkBudgetsForTest({ perWalk: 4 });
    for (let i = 0; i <= 6; i++) {
      mkdirSync(join(big, `d${i}`, 'deeper'), { recursive: true });
    }
    // …and the plain files a directory holds are not the search: a
    // thousand of them beside the same directories still resolve.
    for (let i = 0; i < 1000; i++) {
      writeFileSync(join(big, `e${i}`), '');
    }
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(snap.dirtySubmodules).not.toContain('big');
    // The PER-WALK budget is what exhausts here — more directories than
    // the ceiling this test pins, well inside the per-run cap — and the
    // exhaustion is disclosed, never absorbed by the larger cap.
    expect(snap.unresolved).toContain('big');
    writeFileSync(join(inner, 'f.txt'), 'the fix — uncommitted inside\n');
    runSince();
    const lines = stderr();
    expect(
      lines.some((l) => /\bbig\b/.test(l) && l.includes('could not resolve')),
    ).toBe(true);
    expect(
      lines.some((l) => /\bbig\b/.test(l) && l.includes('cannot see')),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(false);

    // …and the files a directory holds are not the search: the same tiny
    // ceiling over a tree of THREE directories holding a thousand files
    // each resolves, so nothing is charged for what the walk drops.
    (writeStderrLine as unknown as Mock).mockClear();
    const flat = join(repo, 'ig');
    mkdirSync(flat, { recursive: true });
    for (const name of ['a', 'b', 'c']) {
      mkdirSync(join(flat, name), { recursive: true });
      for (let i = 0; i < 1000; i++) {
        writeFileSync(join(flat, name, `f${i}`), '');
      }
    }
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nbig/\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig too');
    setWalkBudgetsForTest({ perWalk: 5 });
    runSnapshot();
    const flatSnap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(flatSnap.unresolved).not.toContain('ig');

    // The per-RUN cap is the other ceiling: with the per-walk budget wide
    // open, a run that opens more directories than the cap allows still
    // discloses — the two are charged independently.
    (writeStderrLine as unknown as Mock).mockClear();
    setWalkBudgetsForTest({ perWalk: IGNORED_WALK_BUDGET, perRun: 3 });
    runSnapshot();
    const capped = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(capped.unresolved.length).toBeGreaterThan(0);
    setWalkBudgetsForTest({ perRun: IGNORED_WALK_RUN_CAP });

    // The control: the same tree under the shipped ceiling resolves, so
    // the disclosure above is the budget's and not the walk's.
    setWalkBudgetsForTest({ perWalk: IGNORED_WALK_BUDGET });
    (writeStderrLine as unknown as Mock).mockClear();
    runSnapshot();
    const wide = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(wide.unresolved).not.toContain('big');
    expect(Object.keys(wide.digests)).toContain('big/inner');
  }, 30_000);

  it('hedges the all-clear to what the capture can see, beside gitignored edits', () => {
    // `add -A` never records ignored paths — an edit inside one leaves both
    // trees byte-identical, and the bare all-clear beside it is false. The
    // claim is hedged to the model's scope.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.env\nigdir/\n');
    writeFileSync(join(repo, '.env'), 'SECRET=v1\n');
    mkdirSync(join(repo, 'igdir'));
    writeFileSync(join(repo, 'igdir', 'f.txt'), 'v1\n');
    git('add', '-A');
    git('commit', '-qm', 'ignored fixtures');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(repo, '.env'), 'SECRET=v2\n');
    writeFileSync(join(repo, 'igdir', 'f.txt'), 'v2\n');
    runSince();
    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const last = stderr().at(-1) ?? '';
    expect(last).toContain('the tree is unchanged since the snapshot');
    expect(last).toContain('gitignored');
  });

  it('does not call a baseline repo cleaned when the since-time probe cannot run', () => {
    // A repository dirty at snapshot time whose probe FAILS at comparison
    // time is unresolved, not gone — the "gone now" note would claim a
    // content change the model never saw.
    const emb = join(repo, 'emb');
    mkdirSync(emb);
    gitAt(emb, 'init', '-q', '-b', 'main');
    gitAt(emb, 'config', 'user.email', 't@t.t');
    gitAt(emb, 'config', 'user.name', 't');
    writeFileSync(join(emb, 'f.txt'), 'committed inside\n');
    gitAt(emb, 'add', '-A');
    gitAt(emb, 'commit', '-qm', 'init');
    writeFileSync(join(emb, 'f.txt'), 'dirt at snapshot time\n');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(emb, '.git', 'index'), 'garbage\n');
    runSince();
    const lines = stderr();
    expect(
      lines.some((l) => /\bemb\b/.test(l) && l.includes('could not resolve')),
    ).toBe(true);
    expect(lines.some((l) => l.includes('gone now'))).toBe(false);
  });

  it('is wired through yargs: --snapshot / --since are the modes, --out is required', async () => {
    const parse = (argv: string[]) =>
      yargs(argv)
        .command(fixDeltaCommand)
        .exitProcess(false)
        .fail((msg, err) => {
          throw err ?? new Error(msg);
        })
        .parseAsync();
    await parse(['fix-delta', '--snapshot', '--out', snapshotFile()]);
    // The snapshot line carries the full tree sha and the fingerprint the
    // orchestrator hands back — the one channel the tree cannot rewrite.
    const printed = stderr().find((l) => l.startsWith('fix-delta: snapshot '));
    const m =
      /^fix-delta: snapshot ([0-9a-f]{40,64}) of .* — fingerprint ([0-9a-f]{64}); pass it back as --fingerprint on --since$/.exec(
        printed ?? '',
      );
    expect(m).not.toBeNull();
    expect(m![1]).toBe(
      (JSON.parse(readFileSync(snapshotFile(), 'utf8')) as FixSnapshot).tree,
    );
    expect(m![2]).toBe(fingerprintOf(snapshotFile()));
    writeFileSync(join(repo, 'a.ts'), 'export const x = 7;\n');
    await parse([
      'fix-delta',
      '--since',
      snapshotFile(),
      '--fingerprint',
      m![2],
      '--out',
      hunksFile(),
    ]);
    expect(readFileSync(hunksFile(), 'utf8')).toContain('+export const x = 7;');
    // …and `--since` is refused without it.
    await expect(async () =>
      parse(['fix-delta', '--since', snapshotFile(), '--out', hunksFile()]),
    ).rejects.toThrow(/--since needs --fingerprint/);
    // A bare `--since` parses to the empty string: presence, not
    // truthiness, decides the mode.
    await expect(async () =>
      parse(['fix-delta', '--snapshot', '--since', '--out', snapshotFile()]),
    ).rejects.toThrow(/exactly one of --snapshot/);
    // yargs raises the missing-argument refusal synchronously from inside
    // parseAsync; an async wrapper turns either shape into a rejection.
    await expect(async () =>
      parse(['fix-delta', '--snapshot']),
    ).rejects.toThrow(/Missing required argument: out/);
  });

  it.each([
    [
      'both modes',
      { snapshot: true, since: '/s' },
      /exactly one of --snapshot/,
    ],
    [
      'neither mode',
      { snapshot: false, since: undefined },
      /exactly one of --snapshot/,
    ],
    [
      // yargs parses a bare `--since` as the empty string: presence, not
      // truthiness, is the mode test, or `--snapshot --since` ran in
      // snapshot mode with `''` as a side path — the process cwd, excluded
      // literally, so a run from a subdirectory recorded that subtree at
      // HEAD and reported the user's own edits there as the fix's.
      'both modes with a bare --since',
      { snapshot: true, since: '' },
      /exactly one of --snapshot/,
    ],
    [
      'a bare --since alone',
      { snapshot: false, since: '' },
      /--since needs the snapshot file/,
    ],
  ])('refuses %s', (_name, args, message) => {
    expect(() => runFixDelta({ ...args, out: hunksFile() })).toThrow(message);
  });

  it('refuses a snapshot from another checkout, and a tree this repository does not hold', () => {
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    writeFileSync(
      snapshotFile(),
      JSON.stringify({ ...snap, root: join(repo, 'elsewhere') }),
    );
    expect(() => runSince()).toThrow(/taken in .*elsewhere, but this is/);
    writeFileSync(
      snapshotFile(),
      JSON.stringify({ ...snap, tree: 'f'.repeat(40) }),
    );
    expect(() => runSince()).toThrow(/is not in this repository/);
    writeFileSync(snapshotFile(), '{"tree": 12}');
    expect(() => runSince()).toThrow(/not a fix-delta snapshot/);
  });

  it("excludes the command's own in-repo --out and --since files", () => {
    // The name families are keyed on what the REVIEW flow writes, but
    // `fix-delta` is a public subcommand whose `--out` takes any path with
    // no location validation: one that resolves inside the repository
    // outside those families is captured by the next snapshot and enters
    // the hunks as bookkeeping. The run's own side paths are excluded
    // dynamically.
    const snapIn = join(repo, 'fd-out', 'snap.json');
    const hunksIn = join(repo, 'fd-out', 'hunks.diff');
    runFixDelta({ snapshot: true, since: undefined, out: snapIn });
    writeFileSync(join(repo, 'a.ts'), 'export const x = 9;\n');
    runSince(snapIn, hunksIn);

    const hunks = readFileSync(hunksIn, 'utf8');
    expect(hunks).toContain('+export const x = 9;');
    expect(hunks).not.toContain('fd-out/snap.json');
    expect(hunks).not.toContain('fd-out/hunks.diff');
    expect(stderr().at(-1)).toBe(
      'fix-delta: 1 file(s) changed since the snapshot — a.ts',
    );
  });

  it('names a submodule whose dirt hides behind assume-unchanged / skip-worktree bits', () => {
    // The bits are git's documented local-override practice, and they hide
    // an entry from BOTH status runs the model reads: the inner probe
    // answers empty (a false 'clean') and the outer v2 status emits no
    // entry for the submodule at all, so status-only discovery prints the
    // bare all-clear while the edit is on disk. Discovery also scans the
    // index's own gitlinks, and an empty inner answer is confirmed against
    // the index's tags — never read as clean.
    const subSrc = plantCommittedSubmodule();
    try {
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      for (const bit of ['assume-unchanged', 'skip-worktree']) {
        (writeStderrLine as unknown as Mock).mockClear();
        gitAt(join(repo, 'sub'), 'update-index', `--${bit}`, 'f.txt');
        writeFileSync(join(repo, 'sub', 'f.txt'), 'the fix — bit-hidden\n');
        runSince();

        expect(readFileSync(hunksFile(), 'utf8')).toBe('');
        const lines = stderr();
        expect(
          lines.some(
            (l) =>
              /\bsub\b/.test(l) &&
              l.includes('cannot see') &&
              l.includes('could not resolve'),
          ),
        ).toBe(true);
        expect(
          lines.some((l) =>
            l.includes('the tree is unchanged since the snapshot'),
          ),
        ).toBe(false);
        gitAt(join(repo, 'sub'), 'update-index', `--no-${bit}`, 'f.txt');
      }
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('names a submodule whose dirt hides one level deeper behind an index bit', () => {
    // The level-1 pin beside it plants the bit on the submodule's OWN
    // file; this plants it one level DOWN — on a file of a repository
    // nested inside the submodule. The interior status that answers
    // "empty" ran with `--ignore-submodules=none`, reaching through the
    // level-2 checkout, and the index-bit confirmation read only the
    // level-1 tags — so the hidden edit answered clean. The confirmation
    // recurses to the depth the status was taken at.
    const subSrc = plantCommittedSubmodule('sub');
    const depSrc = makeSubmoduleSource();
    try {
      gitAt(
        join(repo, 'sub'),
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        depSrc,
        'dep',
      );
      gitAt(join(repo, 'sub', 'dep'), 'config', 'user.email', 't@t.t');
      gitAt(join(repo, 'sub', 'dep'), 'config', 'user.name', 't');
      gitAt(join(repo, 'sub'), 'add', '-A');
      gitAt(join(repo, 'sub'), 'commit', '-qm', 'add dep');
      git('add', '-A');
      git('commit', '-qm', 'sub gains dep');

      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      gitAt(
        join(repo, 'sub', 'dep'),
        'update-index',
        '--assume-unchanged',
        'f.txt',
      );
      writeFileSync(join(repo, 'sub', 'dep', 'f.txt'), 'the fix\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(
        lines.some((l) => /\bsub\b/.test(l) && l.includes('cannot see')),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
      rmSync(depSrc, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'names a nested repository whose own core.trustctime hides a same-size edit',
    async () => {
      // `core.trustctime=false` in the nested repository's OWN config
      // takes the ctime out of git's change check, so a same-size edit
      // whose recorded mtime is restored answers CLEAN — the C→C-same
      // cell over an edit that is on disk. (win32 maps ctime to creation
      // time, which an overwrite does not move: the hide the pin answers
      // does not exist there.) The pin restores git's default for the
      // probe, whatever the tree's config says.
      //
      // The mtime is a whole second set BEFORE the add: the index records
      // exactly it (nsec 0 included), so restoring it matches git's stat
      // at any precision. The edit lands one wall-clock second later so
      // the ctime second differs from the add's — the one field the
      // config hides and the pin restores.
      const nested = join(repo, 'nested');
      mkdirSync(nested);
      gitAt(nested, 'init', '-q', '-b', 'main');
      gitAt(nested, 'config', 'user.email', 't@t.t');
      gitAt(nested, 'config', 'user.name', 't');
      const old = new Date('2020-01-01T00:00:00.000Z');
      writeFileSync(join(nested, 'f.txt'), 'aaaa\n');
      utimesSync(join(nested, 'f.txt'), old, old);
      gitAt(nested, 'add', '-A');
      gitAt(nested, 'commit', '-qm', 'init');
      gitAt(nested, 'config', 'core.trustctime', 'false');

      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      await new Promise((r) => setTimeout(r, 1100));
      writeFileSync(join(nested, 'f.txt'), 'bbbb\n'); // same length
      utimesSync(join(nested, 'f.txt'), old, old);
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(
        lines.some((l) => l.includes('nested') && l.includes('cannot see')),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    },
  );

  it('discloses a dead gitlink whose checkout lost its git dir', () => {
    // A mode-160000 gitlink whose checkout directory still exists but whose
    // `.git` is gone emits no status entry, and `add -A` still records only
    // the gitlink — the old guard skipped it, printing the bare all-clear
    // while the edit was on disk. The state lands in the unresolved
    // disclosure instead.
    const subSrc = plantCommittedSubmodule();
    try {
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      renameSync(join(repo, 'sub', '.git'), join(repo, 'sub', '.git-x'));
      writeFileSync(join(repo, 'sub', 'f.txt'), 'after — the hidden fix\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(
        lines.some(
          (l) =>
            /\bsub\b/.test(l) &&
            l.includes('cannot see') &&
            l.includes('could not resolve'),
        ),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('keeps the all-clear for a gitlink whose checkout was never created', () => {
    // The fresh-clone arm the dead-gitlink disclosure must not touch: the
    // index records the gitlink but the checkout directory does not exist
    // (a clone that never ran `submodule update --init`). It holds nothing
    // an edit could hide in; probing it answered 'failed' and over-warned
    // on every run.
    const subSrc = plantCommittedSubmodule();
    try {
      rmSync(join(repo, 'sub'), { recursive: true, force: true });
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(lines.some((l) => l.includes('cannot see'))).toBe(false);
      expect(lines.some((l) => l.includes('could not resolve'))).toBe(false);
      expect(lines.at(-1)).toContain(
        'the tree is unchanged since the snapshot',
      );
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it('discloses the walk it cannot classify when dirents carry no type', () => {
    // DT_UNKNOWN — a filesystem that does not hand back d_type: every
    // dirent predicate answers false, and skipping the unclassifiable
    // child degenerated the walk to 'fully walked, nothing inside',
    // indistinguishable from empty. No such filesystem is constructible on
    // the CI hosts, so the dirent stream itself is stubbed; the nested
    // repository under the walk must still reach a 'cannot see'
    // disclosure, never the bare all-clear.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig');
    const inner = join(repo, 'ig', 'inner');
    mkdirSync(inner, { recursive: true });
    gitAt(inner, 'init', '-q', '-b', 'main');
    gitAt(inner, 'config', 'user.email', 't@t.t');
    gitAt(inner, 'config', 'user.name', 't');
    writeFileSync(join(inner, 'f.txt'), 'inside\n');
    gitAt(inner, 'add', '-A');
    gitAt(inner, 'commit', '-qm', 'init');

    readdirHook.unknownDirents = true;
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(inner, 'f.txt'), 'the fix — uncommitted inside\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some((l) => l.includes('ig/inner') && l.includes('cannot see')),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(false);
  });

  it('excludes a symlink reaching a review worktree, under an ignored directory', () => {
    // The exclusion keys on the discovered NAME; a link planted at any
    // other name under a collapsed ignored directory still reaches the
    // review's own worktree, and the walk probed it as blind-spot dirt —
    // the very thing the exclusion exists to remove. The target resolves.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig');
    mkdirSync(join(repo, 'ig'), { recursive: true });
    // The review's own worktree is the one the orchestrator NAMES
    // (`--review-worktree`) — a repository merely planted at the family
    // name is not it, and is probed like any other (see `probeExcluded`).
    const target = join(repo, '.qwen', 'tmp', 'review-pr-1');
    git('worktree', 'add', '-q', '--detach', target);
    symlinkSync(target, join(repo, 'ig', 'x'));

    runSnapshot([target]);
    writeFileSync(join(target, 'a.ts'), 'dirtied between the states\n');
    runSince(snapshotFile(), hunksFile(), [target]);

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(lines.some((l) => l.includes('cannot see'))).toBe(false);
    expect(lines.some((l) => l.includes('pre-existing'))).toBe(false);
    expect(lines.at(-1)).toContain('the tree is unchanged since the snapshot');
  });

  it('excludes a top-level symlink whose target is a review worktree', () => {
    // The slashless `?` branch checked the link's own name only, before
    // any target resolution: a link named outside the families reached the
    // review's own worktree past the exclusion and reported the review's
    // state as a blind spot.
    const target = join(repo, '.qwen', 'tmp', 'review-pr-1');
    git('worktree', 'add', '-q', '--detach', target);
    symlinkSync(target, join(repo, 'x'));

    runSnapshot([target]);
    writeFileSync(join(target, 'a.ts'), 'dirtied between the states\n');
    runSince(snapshotFile(), hunksFile(), [target]);

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(lines.some((l) => l.includes('cannot see'))).toBe(false);
    expect(lines.some((l) => l.includes('pre-existing'))).toBe(false);
    expect(lines.at(-1)).toContain('the tree is unchanged since the snapshot');
  });

  // POSIX-only: a newline in a directory name cannot exist on NTFS.
  it.skipIf(process.platform === 'win32')(
    'tolerates a zero-commit nested repo whose name contains a newline',
    () => {
      // The tolerated zero-commit note embeds the raw, unquoted path: a
      // newline in the directory name splits it across two lines, neither
      // matching line-by-line, and the shape the tolerance exists for
      // became a hard refusal on both modes.
      const nested = join(repo, 'bad\nname');
      mkdirSync(nested);
      gitAt(nested, 'init', '-q', '-b', 'main');

      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      writeFileSync(join(repo, 'a.ts'), 'export const x = 3;\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toContain(
        '+export const x = 3;',
      );
    },
  );

  it('keeps a binary edit git-apply-replayable in the hunks', () => {
    // Without `--binary` a binary-content edit enters the hunks as a bare
    // "Binary files … differ" stub — no patch data, not replayable —
    // while the summary still reports the file, so the audit all-clears
    // an edit it could not read.
    writeFileSync(
      join(repo, 'blob.bin'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    );
    git('add', '-A');
    git('commit', '-qm', 'binary fixture');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(
      join(repo, 'blob.bin'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02, 0x02]),
    );
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).toContain('GIT binary patch');
    expect(hunks).not.toContain('Binary files ');
  });

  // POSIX-only: a raw 0xE9-byte directory name cannot exist on NTFS.
  it.skipIf(process.platform === 'win32')(
    'keeps colliding display names apart when keying the blind-spot sets',
    () => {
      // UTF-8 `C3 A9` and the single invalid byte `E9` decode to the SAME
      // display name; identity keys on the raw bytes, or the clean repo's
      // `seen` mark swallows its dirty sibling's probe and the all-clear
      // prints beside the landed edit.
      const cleanAbs = Buffer.concat([
        Buffer.from(repo),
        Buffer.from('/'),
        Buffer.from([0xc3, 0xa9]),
      ]);
      const dirtyAbs = Buffer.concat([
        Buffer.from(repo),
        Buffer.from('/'),
        Buffer.from([0xe9]),
      ]);
      mkdirSync(cleanAbs);
      mkdirSync(dirtyAbs);
      initNestedRepoSh(cleanAbs);
      initNestedRepoSh(dirtyAbs);

      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      overwriteSh(
        Buffer.concat([dirtyAbs, Buffer.from('/f.txt')]),
        'the hidden fix',
      );
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(lines.some((l) => l.includes('cannot see'))).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    },
  );

  // POSIX-only: a raw 0xFF-byte directory name cannot exist on NTFS.
  it.skipIf(process.platform === 'win32')(
    'never probes a planted decoy in place of a name the bytes cannot reach',
    () => {
      // Spawn coerces every channel through UTF-8: a 0xFF name would
      // reach the child as U+FFFD and probe whatever lives at THAT name —
      // a clean decoy answering 'clean' for the dirty repository. The
      // probe must fail for the unrepresentable name instead.
      const realAbs = Buffer.concat([
        Buffer.from(repo),
        Buffer.from('/'),
        Buffer.from([0xff]),
      ]);
      const decoyAbs = Buffer.concat([
        Buffer.from(repo),
        Buffer.from('/'),
        Buffer.from([0xef, 0xbf, 0xbd]), // U+FFFD, UTF-8 encoded
      ]);
      mkdirSync(realAbs);
      mkdirSync(decoyAbs);
      initNestedRepoSh(realAbs);
      initNestedRepoSh(decoyAbs); // committed clean: the decoy

      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      overwriteSh(
        Buffer.concat([realAbs, Buffer.from('/f.txt')]),
        'the hidden fix',
      );
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(
        lines.some((l) => l.includes('\u00ff') && l.includes('cannot see')),
      ).toBe(true);
      // The decoy is clean and is never named; the real repo rides the
      // unresolved disclosure under its byte-preserving latin1 name.
      expect(lines.some((l) => l.includes('\ufffd'))).toBe(false);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    },
  );

  // --- repo-local config steering: the probe children, the capture and the
  // rendering are all steerable by the tree they measure unless they are
  // pinned. Each pin below has its own witness.

  it('never executes a discovered repository’s core.fsmonitor', () => {
    // `core.fsmonitor` runs a COMMAND on `status` and on `ls-files -v`, and
    // a repository the walk discovers in the working tree carries its own
    // `.git/config` — writable by anything running as this user, the
    // audited fix included. Without `-c core.fsmonitor=` the measurement
    // becomes the execution, exactly as `worktree.ts` says of the tripwire
    // it de-steers.
    const marker = join(out, 'fsmonitor-ran');
    const hook = join(out, 'fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    const nested = join(repo, 'planted');
    mkdirSync(nested);
    gitAt(nested, 'init', '-q', '-b', 'main');
    gitAt(nested, 'config', 'user.email', 't@t.t');
    gitAt(nested, 'config', 'user.name', 't');
    writeFileSync(join(nested, 'f.txt'), 'v1\n');
    gitAt(nested, 'add', '-A');
    gitAt(nested, 'commit', '-qm', 'init');
    gitAt(nested, 'config', 'core.fsmonitor', hook);

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(repo, 'a.ts'), 'export const x = 5;\n');
    runSince();

    expect(existsSync(marker)).toBe(false);
  });

  it('pins the audited work tree so core.worktree cannot answer for a decoy', () => {
    // A repo-local `[core] worktree = <decoy>` redirects the probe's status
    // at a pristine copy: the inner status answers clean while the edit
    // sits on disk in the audited directory — the planted-decoy shape the
    // probe says it exists to prevent, reached through config instead of a
    // mangled name.
    const decoy = join(out, 'decoy');
    mkdirSync(decoy);
    const nested = join(repo, 'planted');
    mkdirSync(nested);
    gitAt(nested, 'init', '-q', '-b', 'main');
    gitAt(nested, 'config', 'user.email', 't@t.t');
    gitAt(nested, 'config', 'user.name', 't');
    writeFileSync(join(nested, 'f.txt'), 'v1\n');
    gitAt(nested, 'add', '-A');
    gitAt(nested, 'commit', '-qm', 'init');
    writeFileSync(join(decoy, 'f.txt'), 'v1\n'); // the pristine copy
    gitAt(nested, 'config', 'core.worktree', decoy);

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(nested, 'f.txt'), 'the hidden fix\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some((l) => l.includes('cannot see') && l.includes('planted')),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('names a nested repository planted under a side-file family name', () => {
    // The families are excluded from capture and comparison because the
    // flow writes them between the two states — but the flow writes FILES
    // under `qwen-review-*`, never a repository. Excluding the family from
    // the PROBE too let a repository planted at a family-shaped name fall
    // out of every route at once: hidden from both trees by the capture
    // pathspec, and never discovered by the status the probe reads.
    const hidden = join(repo, 'subdir', '.qwen', 'tmp', 'qwen-review-hide');
    mkdirSync(hidden, { recursive: true });
    gitAt(hidden, 'init', '-q', '-b', 'main');
    gitAt(hidden, 'config', 'user.email', 't@t.t');
    gitAt(hidden, 'config', 'user.name', 't');
    writeFileSync(join(hidden, 'f.txt'), 'v1\n');
    gitAt(hidden, 'add', '-A');
    gitAt(hidden, 'commit', '-qm', 'init');

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(hidden, 'f.txt'), 'the hidden fix\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) => l.includes('cannot see') && l.includes('qwen-review-hide'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it("still excludes the review's own side files under a subdirectory", () => {
    // …and the de-globbed probe pathspec must not re-admit the bookkeeping
    // the families exist to remove: the same subdirectory layout, holding
    // what the flow actually writes there.
    mkdirSync(
      join(repo, 'subdir', '.qwen', 'tmp', 'qwen-review-local-prompts'),
      {
        recursive: true,
      },
    );
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(
      join(repo, 'subdir', '.qwen', 'tmp', 'qwen-review-local-prompts', 'p.md'),
      'x\n',
    );
    writeFileSync(
      join(repo, 'subdir', '.qwen', 'tmp', 'qwen-review-local-side.json'),
      '{}\n',
    );
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(lines.some((l) => l.includes('qwen-review-local'))).toBe(false);
    expect(lines.at(-1)).toContain('the tree is unchanged since the snapshot');
  });

  it("still excludes the file-target plan family the flow's own prompts write", () => {
    // A FILE target's plan lives at `.qwen/tmp/file-review-<file>-plan.json`
    // and its prompts one directory down — the fix audit's brief, input and
    // launch record included. Missing from the excluded families, the Step
    // 6B re-run captured the audit's own bookkeeping as the hunks it was
    // auditing, three more files on every pass.
    mkdirSync(join(repo, '.qwen', 'tmp', 'file-review-x-plan-prompts'), {
      recursive: true,
    });
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'file-review-x-plan-prompts', 'p.md'),
      'x\n',
    );
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(lines.some((l) => l.includes('file-review'))).toBe(false);
    expect(lines.at(-1)).toContain('the tree is unchanged since the snapshot');
  });

  it('scopes a repository an out-of-tree symlink target merely CONTAINS', () => {
    // `add -A` records the link, never what is behind it. The target is
    // OUTSIDE the audited tree, and the walk does not start there:
    // enumerating and baselining a foreign directory read an unrelated
    // commit in it as this tree's transition and withheld the all-clear.
    // The link is scope — named, with the rule that an edit through it
    // leaves no record here — not blind-spot dirt.
    const outside = join(out, 'linked');
    const inner = join(outside, 'deep', 'repo');
    mkdirSync(inner, { recursive: true });
    gitAt(inner, 'init', '-q', '-b', 'main');
    gitAt(inner, 'config', 'user.email', 't@t.t');
    gitAt(inner, 'config', 'user.name', 't');
    writeFileSync(join(inner, 'f.txt'), 'v1\n');
    gitAt(inner, 'add', '-A');
    gitAt(inner, 'commit', '-qm', 'init');
    symlinkSync(outside, join(repo, 'link'));

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(inner, 'f.txt'), 'the hidden fix\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) =>
          l.includes('link') &&
          l.includes('link reaching outside this repository'),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.includes('link/deep/repo'))).toBe(false);
    expect(lines.at(-1)).toContain('the tree is unchanged since the snapshot');
  });

  it('re-reports a submodule whose interior state changed since the snapshot', () => {
    // The mirror of "never reports a submodule whose only change is new
    // commits", one level down: a level-2 gitlink that merely moved (the
    // everyday `submodule update --remote` shape) stamps its PARENT as
    // confirmed dirt in the outer status, and the baseline used to record
    // that as a bare boolean — after which a fix's real edit inside the
    // parent was filtered into the pre-existing note and the blind-spot
    // warning went silent. The baseline records a DIGEST of the state
    // inside, so dirt that changed since is fresh dirt.
    const subSrc = plantCommittedSubmodule();
    const depSrc = makeSubmoduleSource();
    const sub = join(repo, 'sub');
    const dep = join(sub, 'dep');
    try {
      gitAt(
        sub,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        depSrc,
        'dep',
      );
      gitAt(sub, 'commit', '-qm', 'add dep');
      git('add', '-A');
      git('commit', '-qm', 'advance sub');
      // The level-2 gitlink moves: `sub` now reads ` M dep` — new commits
      // only, nothing else dirty in it.
      gitAt(dep, 'config', 'user.email', 't@t.t');
      gitAt(dep, 'config', 'user.name', 't');
      writeFileSync(join(dep, 'f.txt'), 'advanced\n');
      gitAt(dep, 'add', '-A');
      gitAt(dep, 'commit', '-qm', 'advance');

      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      // The fix edits inside `sub` — invisible to both trees.
      writeFileSync(join(sub, 'g.txt'), 'the fix\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(
        lines.some((l) => l.includes('cannot see') && /\bsub\b/.test(l)),
      ).toBe(true);
      expect(lines.at(-1)).not.toContain('the tree is unchanged since');
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
      rmSync(depSrc, { recursive: true, force: true });
    }
  });

  // POSIX-only: a byte that is not valid UTF-8 cannot be a name on NTFS.
  it.skipIf(process.platform === 'win32')(
    'keys the git-dir exclusion on bytes, not on the display decode',
    () => {
      // `decodePath` is not injective: the UTF-8 pair `C3 A9` and the lone
      // invalid byte `E9` both render 'é'. Comparing the DECODED name
      // against an in-worktree git dir named `gd-é` let a planted
      // `gd-<0xE9>` repository answer to that name — pruned from every
      // probe route, while `add -A` recorded only its gitlink, so an edit
      // inside it appeared nowhere.
      const wt = realpathSync(
        mkdtempSync(join(tmpdir(), 'qwen-fix-delta-gdcollide-')),
      );
      const cwdHere = process.cwd();
      try {
        gitAt(
          wt,
          'init',
          '-q',
          '-b',
          'main',
          '--separate-git-dir',
          join(wt, 'gd-é'),
        );
        gitAt(wt, 'config', 'user.email', 't@t.t');
        gitAt(wt, 'config', 'user.name', 't');
        writeFileSync(join(wt, 'a.ts'), 'export const x = 1;\n');
        gitAt(wt, 'add', 'a.ts');
        gitAt(wt, 'commit', '-qm', 'head');
        const plant = Buffer.concat([
          Buffer.from(join(wt, 'gd-')),
          Buffer.from([0xe9]),
        ]);
        execFileSync('/bin/sh', [], {
          input: Buffer.concat([
            Buffer.from("set -e\nmkdir -p '"),
            plant,
            Buffer.from("'\n"),
          ]),
        });
        initNestedRepoSh(plant);
        process.chdir(wt);
        const snap = join(out, 'gdcollide-snapshot.json');
        const hunks = join(out, 'gdcollide-hunks.diff');
        runFixDelta({ snapshot: true, since: undefined, out: snap });
        overwriteSh(
          Buffer.concat([plant, Buffer.from('/f.txt')]),
          'the hidden fix',
        );
        runSince(snap, hunks);

        expect(readFileSync(hunks, 'utf8')).toBe('');
        const lines = stderr();
        expect(lines.some((l) => l.includes('cannot see'))).toBe(true);
        expect(lines.at(-1)).not.toContain('the tree is unchanged since');
      } finally {
        process.chdir(cwdHere);
        rmSync(wt, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      }
    },
  );

  it('discloses a clean filter that steers what the capture stores', () => {
    // `filter.<name>.clean` replaces a path's STORED content, so a real
    // edit can be absent from both trees, or bytes the worktree never held
    // can be attested as an edit that never landed. The capture cannot see
    // the surface that shaped it — nothing in a comparison of two trees
    // says how either was built — so it is named before the bytes it
    // qualifies.
    git('config', 'filter.hide.clean', 'cat /dev/null');
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(
      join(repo, '.git', 'info', 'attributes'),
      'a.ts filter=hide\n',
    );

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    const snapLines = stderr();
    expect(
      snapLines.some(
        (l) => l.includes('filter.hide.clean') && l.includes('info/attributes'),
      ),
    ).toBe(true);

    writeFileSync(join(repo, 'a.ts'), 'export const x = 7;\n');
    runSince();
    expect(stderr().some((l) => l.includes('what `git add -A` stores'))).toBe(
      true,
    );
  });

  // POSIX-only: a byte that is not valid UTF-8 cannot be a name on NTFS.
  it.skipIf(process.platform === 'win32')(
    'asks git about the raw name bytes, not their display rendering',
    () => {
      // The attribute probe is fed the names `diff-tree` printed. Sending
      // the DISPLAY decode instead asks about a different path — a
      // non-UTF-8 name renders through latin1, and re-encoding that string
      // as UTF-8 is a name no rule matches — so the probe resolves
      // `unspecified` and answers 'no steering' for exactly the path it
      // could not name. Fail-open, in the one direction this disclosure
      // exists to close.
      const nameBytes = Buffer.concat([
        Buffer.from('bad'),
        Buffer.from([0xe9]),
        Buffer.from('.txt'),
      ]);
      const absFile = Buffer.concat([Buffer.from(`${repo}/`), nameBytes]);
      overwriteSh(absFile, 'v1');
      git('add', '-A');
      git('commit', '-qm', 'the non-UTF-8 file');

      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      mkdirSync(join(repo, '.git', 'info'), { recursive: true });
      writeFileSync(
        join(repo, '.git', 'info', 'attributes'),
        Buffer.concat([nameBytes, Buffer.from(' -diff\n')]),
      );
      overwriteSh(absFile, 'the fix');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toContain('GIT binary patch');
      expect(
        stderr().some((l) => l.includes('steers how the hunks above render')),
      ).toBe(true);
    },
  );

  it('stays quiet about steering surfaces an ordinary repository does not have', () => {
    // `git init` writes a comment-only `info/exclude`, and the disclosure
    // must not fire on it — a note every run prints is a note nobody reads.
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(repo, 'a.ts'), 'export const x = 7;\n');
    runSince();
    const lines = stderr();
    expect(lines.some((l) => l.includes('repo-local surfaces'))).toBe(false);
    expect(lines.some((l) => l.includes('steers how the hunks'))).toBe(false);
  });

  it('discloses an attributes rule that steers how the hunks render', () => {
    // One `-diff` line forces a TEXT fix into an opaque base85 `GIT binary
    // patch`: the hunks are non-empty, the file is listed, nothing fails —
    // and the auditor all-clears an edit it cannot read, the failure the
    // `--binary` flag above exists to prevent. The surface is plantable
    // BETWEEN the two moments, so it is read at `--since` time.
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(repo, '.git', 'info', 'attributes'), 'a.ts -diff\n');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 7;\n');
    runSince();

    // The rendering really is unreadable…
    expect(readFileSync(hunksFile(), 'utf8')).toContain('GIT binary patch');
    // …and the run says so, naming the path and the surface.
    expect(
      stderr().some(
        (l) =>
          l.includes('steers how the hunks above render') && l.includes('a.ts'),
      ),
    ).toBe(true);
  });

  it('discloses a process filter that steers what the capture stores', () => {
    // gitattributes(5): `filter.<name>.process` takes precedence over
    // `clean`/`smudge` whenever it is set, so a repository configured with
    // the process key ALONE steers `add -A` exactly as a clean filter does
    // — and a disclosure that matched only `.clean` named nothing over it.
    git('config', 'filter.x.process', 'cat');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    expect(stderr().some((l) => l.includes('filter.x.process'))).toBe(true);
  });

  it('discloses a core.excludesFile whose rule drops a new file from the capture', () => {
    // A fourth steering surface of the `info/exclude` class, settable from
    // the repository's own config and pointing OUTSIDE the tree: the
    // fix's new file enters neither captured tree, the hunks never mention
    // it, and without the disclosure the run all-clears a fix whose
    // content it never saw.
    writeFileSync(join(repo, '.git', 'steer-excludes'), 'newfile.txt\n');
    git('config', 'core.excludesFile', '.git/steer-excludes');

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(repo, 'a.ts'), 'export const x = 7;\n');
    writeFileSync(join(repo, 'newfile.txt'), 'the fix\n');
    runSince();

    // The drop is real…
    expect(readFileSync(hunksFile(), 'utf8')).not.toContain('newfile.txt');
    // …and named, at both moments.
    const lines = stderr();
    expect(
      lines.filter(
        (l) =>
          l.includes('core.excludesFile') && l.includes('what `git add -A`'),
      ),
    ).toHaveLength(2);
  });

  it('never executes the audited repository’s own core.fsmonitor', () => {
    // The outer spawns — `add`, `write-tree`, `status`, `ls-files` — read
    // the AUDITED repository's `.git/config`, the same surface the probe
    // pins one level down, and `core.fsmonitor` runs a command from it
    // during exactly those commands. The hook must never run: the
    // measurement must not become the execution.
    const marker = join(out, 'root-fsmonitor-ran');
    const hook = join(out, 'root-fsmonitor.sh');
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(hook, 0o755);
    git('config', 'core.fsmonitor', hook);

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(repo, 'a.ts'), 'export const x = 5;\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toContain('+export const x = 5;');
    expect(existsSync(marker)).toBe(false);
  });

  it('refuses a core.worktree that points the capture at a decoy', () => {
    // A pre-snapshot `[core] worktree = <decoy>` redirects
    // `rev-parse --show-toplevel` itself, so every later spawn — the
    // `--work-tree` pin included, since its argument IS the steered root —
    // measures the decoy consistently, both moments agree, and a bare
    // all-clear certifies a tree nobody read. The gate sits at root
    // derivation: the tree git names must contain the directory this
    // command runs in.
    const decoy = join(repo, '.decoy');
    mkdirSync(decoy);
    writeFileSync(join(decoy, 'a.ts'), 'export const x = 1;\n');
    git('config', 'core.worktree', decoy);

    expect(() =>
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() }),
    ).toThrow(/core\.worktree/);
    expect(existsSync(snapshotFile())).toBe(false);
  });

  it('records a fix to a tracked path under a family name', () => {
    // The families are excluded because the flow writes them between the
    // two states — as UNTRACKED files. A path the repository TRACKS under
    // a family name is user content by the `FIX_DELTA_EXCLUDES` contract,
    // and the glob used to drop the fix's edit to it from both trees: the
    // hunks omitted a landed edit and the run printed "unchanged" over it.
    const notes = join(repo, '.qwen', 'tmp', 'qwen-review-notes.md');
    writeFileSync(notes, 'v1\n');
    git('add', '-A');
    git('commit', '-qm', 'track a family-named file');

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(notes, 'v2 — the fix\n');
    // …beside the flow's own UNTRACKED side file, which stays excluded.
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'qwen-review-local-ledger.json'),
      '[]\n',
    );
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).toContain('+v2 — the fix');
    expect(hunks).toContain('qwen-review-notes.md');
    expect(hunks).not.toContain('qwen-review-local-ledger.json');
    expect(stderr().at(-1)).toContain(
      '1 file(s) changed since the snapshot — .qwen/tmp/qwen-review-notes.md',
    );
  });

  it('names a repository planted one level under a side-file family name', () => {
    // The walk pruned a `.git`-less directory by its family NAME, so a
    // repository nested one level under it was never discovered, while
    // the same-shaped capture pathspec hid the subtree from both trees —
    // an edit inside appeared in no hunks and drew no blind-spot line.
    // The walk descends: the side-file family holds files, which the
    // probe never asks about, and a repository under it is a repository.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.qwen/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore .qwen');
    const inner = join(repo, '.qwen', 'tmp', 'qwen-review-hide', 'inner');
    mkdirSync(inner, { recursive: true });
    gitAt(inner, 'init', '-q', '-b', 'main');
    gitAt(inner, 'config', 'user.email', 't@t.t');
    gitAt(inner, 'config', 'user.name', 't');
    writeFileSync(join(inner, 'f.txt'), 'v1\n');
    gitAt(inner, 'add', '-A');
    gitAt(inner, 'commit', '-qm', 'init');

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(inner, 'f.txt'), 'the hidden fix\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) => l.includes('cannot see') && l.includes('qwen-review-hide/inner'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('names a repository planted under the worktree family name', () => {
    // The worktree family pruned ANY repository under its name, while the
    // capture pathspec removed the subtree from both trees — a `git init`
    // planted there was invisible while the identical plant under any
    // other name was disclosed. What is pruned now is what git's own
    // registry says is a linked worktree of this repository (pinned by
    // 'excludes the review worktree when .gitignore names the family
    // directly'); a plant carries a `.git` directory and no registration.
    const planted = join(repo, '.qwen', 'tmp', 'review-pr-planted');
    mkdirSync(planted, { recursive: true });
    gitAt(planted, 'init', '-q', '-b', 'main');
    gitAt(planted, 'config', 'user.email', 't@t.t');
    gitAt(planted, 'config', 'user.name', 't');
    writeFileSync(join(planted, 'f.txt'), 'v1\n');
    gitAt(planted, 'add', '-A');
    gitAt(planted, 'commit', '-qm', 'init');

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(planted, 'f.txt'), 'the hidden fix\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) => l.includes('cannot see') && l.includes('review-pr-planted'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('discloses content committed inside a nested repository the trees cannot record', () => {
    // A repository an ignored directory hides enters neither tree at all —
    // there is no gitlink to move — and a fix COMMITTED inside it leaves
    // its status empty at both moments. The probe answered clean twice
    // and the run all-cleared. Identity rides the digest: a moved HEAD is
    // the one trace the commit leaves, and it is disclosed.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig');
    const inner = join(repo, 'ig', 'inner');
    mkdirSync(inner, { recursive: true });
    gitAt(inner, 'init', '-q', '-b', 'main');
    gitAt(inner, 'config', 'user.email', 't@t.t');
    gitAt(inner, 'config', 'user.name', 't');
    writeFileSync(join(inner, 'f.txt'), 'v1\n');
    gitAt(inner, 'add', '-A');
    gitAt(inner, 'commit', '-qm', 'init');

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(inner, 'g.txt'), 'the fix, committed\n');
    gitAt(inner, 'add', '-A');
    gitAt(inner, 'commit', '-qm', 'the fix');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) =>
          l.includes('committed or stashed inside') && l.includes('ig/inner'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('refuses a snapshot record that no longer matches its fingerprint', () => {
    // The record lives inside the tree the reviewed code can write to and
    // is excluded from both captures, so nothing about it is
    // self-certifying: a rewritten `tree` field diffs the fix against a
    // baseline taken AFTER a hidden edit and corroborates exactly the
    // claimed fix over it. The fingerprint `--snapshot` printed is the one
    // value the orchestrator holds outside that write surface.
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    const printed = fingerprintOf(snapshotFile());
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    // The hidden edit, then a baseline fabricated AFTER it with the
    // module's own recipe, spliced into the record.
    writeFileSync(join(repo, 'm.ts'), 'HIDDEN_EDIT_M\n');
    const forged = join(out, 'forged-snapshot.json');
    runFixDelta({ snapshot: true, since: undefined, out: forged });
    const forgedTree = (JSON.parse(readFileSync(forged, 'utf8')) as FixSnapshot)
      .tree;
    expect(forgedTree).not.toBe(snap.tree);
    writeFileSync(
      snapshotFile(),
      `${JSON.stringify({ ...snap, tree: forgedTree }, null, 2)}\n`,
    );
    writeFileSync(
      join(repo, 'a.ts'),
      'export const x = 7; // the claimed fix\n',
    );

    expect(() =>
      runFixDelta({
        snapshot: false,
        since: snapshotFile(),
        fingerprint: printed,
        out: hunksFile(),
      }),
    ).toThrow(
      /its fingerprint is [0-9a-f]{64}, not the [0-9a-f]{64} --snapshot/,
    );
    expect(existsSync(hunksFile())).toBe(false);
    // …and a `--since` with no fingerprint at all is refused before the
    // file is read.
    expect(() =>
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() }),
    ).toThrow(/--since needs --fingerprint/);
  });

  it('probes a gitfile that points into the registry when the orchestrator did not name it', () => {
    // A gitfile is a plain file anyone can write: a plant at another path
    // pointing into a GENUINE registry entry was pruned as that worktree,
    // while the capture pathspec hid it from both trees. Nothing in the
    // tree classifies a review worktree any more — only the path the
    // orchestrator names — so the plant is probed like any repository.
    git(
      'worktree',
      'add',
      '-q',
      '--detach',
      join('.qwen', 'tmp', 'review-pr-1'),
    );
    const evil = join(repo, '.qwen', 'tmp', 'review-pr-evil');
    mkdirSync(evil, { recursive: true });
    writeFileSync(
      join(evil, '.git'),
      `gitdir: ${join(repo, '.git', 'worktrees', 'review-pr-1')}\n`,
    );
    writeFileSync(join(evil, 'payload.txt'), 'v1\n');

    runSnapshot([join(repo, '.qwen', 'tmp', 'review-pr-1')]);
    writeFileSync(join(evil, 'payload2.txt'), 'the hidden fix\n');
    runSince(snapshotFile(), hunksFile(), [
      join(repo, '.qwen', 'tmp', 'review-pr-1'),
    ]);

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) => l.includes('cannot see') && l.includes('review-pr-evil'),
      ),
    ).toBe(true);
    // The genuine worktree stays the review's own.
    expect(lines.some((l) => /review-pr-1\b(?!\/)/.test(l))).toBe(false);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('names a repository planted inside a named review worktree', () => {
    // The worktree itself is the review's and is not probed — but its
    // subtree was dropped whole, so a repository planted one level inside
    // it was discovered by no route while the capture pathspec removed it
    // from both trees. A review worktree is walked, never probed.
    const wt = join(repo, '.qwen', 'tmp', 'review-pr-1');
    git('worktree', 'add', '-q', '--detach', wt);
    const inner = join(wt, 'inner');
    mkdirSync(inner);
    gitAt(inner, 'init', '-q', '-b', 'main');
    gitAt(inner, 'config', 'user.email', 't@t.t');
    gitAt(inner, 'config', 'user.name', 't');
    writeFileSync(join(inner, 'f.txt'), 'v1\n');
    gitAt(inner, 'add', '-A');
    gitAt(inner, 'commit', '-qm', 'init');

    runSnapshot([wt]);
    writeFileSync(join(inner, 'f.txt'), 'the hidden fix\n');
    runSince(snapshotFile(), hunksFile(), [wt]);

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) => l.includes('cannot see') && l.includes('review-pr-1/inner'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('walks a named review worktree reached through the ignored-directory walk', () => {
    // The walk route: with `.qwen` ignored the worktree is reached only by
    // walking the collapsed `! .qwen/` entry, and the walk must enqueue a
    // review worktree rather than prune its subtree.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.qwen/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore .qwen');
    const wt = join(repo, '.qwen', 'tmp', 'review-pr-1');
    git('worktree', 'add', '-q', '--detach', wt);
    const inner = join(wt, 'inner');
    mkdirSync(inner);
    gitAt(inner, 'init', '-q', '-b', 'main');
    gitAt(inner, 'config', 'user.email', 't@t.t');
    gitAt(inner, 'config', 'user.name', 't');
    writeFileSync(join(inner, 'f.txt'), 'v1\n');
    gitAt(inner, 'add', '-A');
    gitAt(inner, 'commit', '-qm', 'init');

    runSnapshot([wt]);
    writeFileSync(join(inner, 'f.txt'), 'the hidden fix\n');
    runSince(snapshotFile(), hunksFile(), [wt]);

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) => l.includes('cannot see') && l.includes('review-pr-1/inner'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('walks a named review worktree reached through a symlink', () => {
    // The symlink route: a top-level link at a non-family name resolves to
    // the review worktree. The link's target is excluded content, but the
    // exclusion is "walk, do not probe" — a repository inside the target
    // is disclosed under the link's own name. The link sorts BEFORE
    // `.qwen/` in the status output (`+` < `.`), so the symlink route is
    // the one that reaches the worktree first; the status route then
    // finds the physical directory already walked.
    const wt = join(repo, '.qwen', 'tmp', 'review-pr-1');
    git('worktree', 'add', '-q', '--detach', wt);
    const inner = join(wt, 'inner');
    mkdirSync(inner);
    gitAt(inner, 'init', '-q', '-b', 'main');
    gitAt(inner, 'config', 'user.email', 't@t.t');
    gitAt(inner, 'config', 'user.name', 't');
    writeFileSync(join(inner, 'f.txt'), 'v1\n');
    gitAt(inner, 'add', '-A');
    gitAt(inner, 'commit', '-qm', 'init');
    symlinkSync(wt, join(repo, '+x'));

    runSnapshot([wt]);
    writeFileSync(join(inner, 'f.txt'), 'the hidden fix\n');
    runSince(snapshotFile(), hunksFile(), [wt]);

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some((l) => l.includes('cannot see') && l.includes('+x/inner')),
    ).toBe(true);
    expect(lines.some((l) => l.includes('review-pr-1/inner'))).toBe(false);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('discloses a repository that appeared since the snapshot', () => {
    // Created between the moments, with the fix COMMITTED inside: its
    // status is clean, no superproject tree records the repository at all
    // (it sits in an ignored directory), and it had no baseline digest to
    // be compared against — so it reached no transition and the run
    // all-cleared over it.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig');
    mkdirSync(join(repo, 'ig'));

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    const inner = join(repo, 'ig', 'inner');
    mkdirSync(inner);
    gitAt(inner, 'init', '-q', '-b', 'main');
    gitAt(inner, 'config', 'user.email', 't@t.t');
    gitAt(inner, 'config', 'user.name', 't');
    writeFileSync(join(inner, 'fix.txt'), 'the fix, committed\n');
    gitAt(inner, 'add', '-A');
    gitAt(inner, 'commit', '-qm', 'the fix');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) =>
          l.includes('the snapshot never recorded') && l.includes('ig/inner'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('discloses a baseline repository the probe can no longer answer for', () => {
    // The mirror: a clean repository the baseline recorded that is gone at
    // `--since` — renamed here — dropped out of every transition, because
    // each compared two digests and this path has one.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig');
    const inner = join(repo, 'ig', 'inner');
    mkdirSync(inner, { recursive: true });
    gitAt(inner, 'init', '-q', '-b', 'main');
    gitAt(inner, 'config', 'user.email', 't@t.t');
    gitAt(inner, 'config', 'user.name', 't');
    writeFileSync(join(inner, 'f.txt'), 'v1\n');
    gitAt(inner, 'add', '-A');
    gitAt(inner, 'commit', '-qm', 'init');

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    renameSync(inner, join(out, 'moved-away'));
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) =>
          l.includes('finds nothing to answer for now') &&
          l.includes('ig/inner'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('keys a repository named __proto__ like any other', () => {
    // On a plain object `digests['__proto__'] = …` hits the inherited
    // setter and creates no own key, and the read back returns
    // `Object.prototype` where `undefined` was meant — so a repository
    // literally named `__proto__` was stamped pre-existing whatever its
    // interior did. Null-prototyped maps make it an ordinary key.
    const proto = join(repo, '__proto__');
    mkdirSync(proto);
    gitAt(proto, 'init', '-q', '-b', 'main');
    gitAt(proto, 'config', 'user.email', 't@t.t');
    gitAt(proto, 'config', 'user.name', 't');
    writeFileSync(join(proto, 'f.txt'), 'v1\n');
    gitAt(proto, 'add', '-A');
    gitAt(proto, 'commit', '-qm', 'init');
    writeFileSync(join(proto, 'dirt.txt'), 'already dirty\n');

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(Object.keys(snap.digests)).toContain('__proto__');
    writeFileSync(join(proto, 'f.txt'), 'the hidden fix\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some((l) => l.includes('cannot see') && l.includes('__proto__')),
    ).toBe(true);
    expect(lines.some((l) => l.includes('pre-existing'))).toBe(false);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('keys a clean repository named __proto__ like any other', () => {
    // The load side has its own setter to fall into: rebuilding the
    // record's `digests` onto a plain object drops the `__proto__` key
    // again, so a clean repository of that name whose HEAD moved between
    // the moments is in neither `Object.keys(snapshot.digests)` (never
    // `movedInside`) nor "absent from the baseline" (`snapshot.digests[p]`
    // reads `Object.prototype`, never `undefined`, so never `appeared`) —
    // a commit inside it drew the bare all-clear. Ignored, so that no
    // gitlink is recorded and the identity move is the only trace (a
    // recorded gitlink's move is in the hunks, and is not a blind spot).
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n__proto__/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore __proto__');
    const proto = join(repo, '__proto__');
    mkdirSync(proto);
    gitAt(proto, 'init', '-q', '-b', 'main');
    gitAt(proto, 'config', 'user.email', 't@t.t');
    gitAt(proto, 'config', 'user.name', 't');
    writeFileSync(join(proto, 'f.txt'), 'v1\n');
    gitAt(proto, 'add', '-A');
    gitAt(proto, 'commit', '-qm', 'init');

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(proto, 'g.txt'), 'the fix, committed\n');
    gitAt(proto, 'add', '-A');
    gitAt(proto, 'commit', '-qm', 'the fix');
    runSince();

    const lines = stderr();
    expect(
      lines.some(
        (l) =>
          l.includes('committed or stashed inside') && l.includes('__proto__'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('rules every add note on its own line once a filter shares the stream', () => {
    // A clean/process filter runs INSIDE the capture and writes to the same
    // stderr git does. An unterminated forged opener absorbs git's real
    // failure notes until a genuine zero-commit note closes the blob, and
    // the reassembly folded all of it into one tolerated note — over a path
    // the capture had silently skipped. With a filter configured, no
    // reassembly and no pairing: the frame refuses the capture.
    const frame =
      "error: '\n" +
      'error: open("secret.txt"): Permission denied\n' +
      "error: unable to index file 'secret.txt'\n" +
      "error: 'zzz/' does not have a commit checked out\n";
    const add = { stderr: frame, status: 1, completed: true };
    // Filter-less: only git writes the stream, and the shape is git's own
    // multi-line zero-commit note for a newline-named repository.
    expect(() => assertCompleteCapture(add, false)).not.toThrow();
    expect(() => assertCompleteCapture(add, true)).toThrow(
      /could not capture the whole tree[\s\S]*a clean\/process filter is configured/,
    );
    // …and the honest single-line shapes still pass under a filter — the
    // zero-commit note alone (git ≤ 2.54) and the pair newer gits print
    // (a Git-LFS user's global `filter.lfs.*` must not cost them the audit
    // over a freshly initialised repository in the tree).
    for (const honest of [
      "error: 'zzz/' does not have a commit checked out\n",
      "error: 'zzz/' does not have a commit checked out\nerror: unable to index file 'zzz/'\n",
    ]) {
      expect(() =>
        assertCompleteCapture(
          { stderr: honest, status: 1, completed: true },
          true,
        ),
      ).not.toThrow();
    }
    // A pairing note with no zero-commit note for its path stays
    // unexplained under a filter — nothing git prints skips a path on
    // that note alone.
    expect(() =>
      assertCompleteCapture(
        {
          stderr: "error: unable to index file 'secret.txt'\n",
          status: 1,
          completed: true,
        },
        true,
      ),
    ).toThrow(/could not capture the whole tree/);

    // End to end: the filter prints the opener, the tree holds the
    // zero-commit repository that would close it, and the capture refuses
    // rather than certify.
    const filter = join(out, 'forge.sh');
    writeFileSync(filter, '#!/bin/sh\nprintf "error: \'\\n" >&2\ncat\n');
    chmodSync(filter, 0o755);
    git('config', 'filter.p.clean', filter);
    writeFileSync(join(repo, '.gitattributes'), 'secret.txt filter=p\n');
    writeFileSync(join(repo, 'secret.txt'), 'v1\n');
    mkdirSync(join(repo, 'zzz'));
    gitAt(join(repo, 'zzz'), 'init', '-q', '-b', 'main');
    expect(() =>
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() }),
    ).toThrow(/a clean\/process filter is configured/);
  });

  it('splits a merged note at its opener, not only at the newline', () => {
    // A filter child shares git's stderr fd; one that omits its trailing
    // newline merges its bytes with git's next note, and the merged line
    // matched the prefix-anchored `/^hint:/` tolerance wholesale —
    // absorbing the note that proves a path was skipped, and certifying
    // a partial capture. The split happens at the note boundary too:
    // `hint: chatter` is tolerated and `error: unable to index …` stands
    // on its own line, unexplained.
    expect(() =>
      assertCompleteCapture(
        {
          stderr:
            "hint: filter chattererror: unable to index file 'sub/secret.txt'\n",
          status: 1,
          completed: true,
        },
        true,
      ),
    ).toThrow(/could not capture the whole tree/);
    // …and the boundary split is not the forbidden reassembly: a
    // tolerated zero-commit note MERGED behind chatter still reads as
    // itself (git never skips a path on that note alone).
    expect(() =>
      assertCompleteCapture(
        {
          stderr: "hint: xerror: 'zzz/' does not have a commit checked out\n",
          status: 1,
          completed: true,
        },
        true,
      ),
    ).not.toThrow();
  });

  it('never classifies the audited repository as its own nested repository', () => {
    // A committed link `self -> .` resolves to the audited root: every
    // discovery route (`? self`, `! self`, a tracked mode-120000 link)
    // followed it into root's own git dir and probed the audited tree as
    // a submodule — reporting every fix edit as invisible dirt while the
    // hunks recorded exactly those edits, a provably false claim on every
    // fix round, plantable by the PR author.
    symlinkSync('.', join(repo, 'self'));
    git('add', '-A');
    git('commit', '-qm', 'commit a link to the root');

    runSnapshot();
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toContain('+export const x = 2;');
    const lines = stderr();
    expect(lines.some((l) => l.includes('cannot see'))).toBe(false);
    expect(lines.some((l) => l.includes('pre-existing'))).toBe(false);
    expect(lines.at(-1)).toBe(
      'fix-delta: 1 file(s) changed since the snapshot — a.ts',
    );
  });

  it('never re-enters the audited repository through a link the walk reaches', () => {
    // The walk variant: a link inside an ignored directory resolves to the
    // audited root itself, which carries a `.git` of its own, and the walk
    // probed the audited tree as a nested repository under a synthetic
    // name (a link to root's PARENT rediscovers it the same way one level
    // down).
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig');
    mkdirSync(join(repo, 'ig', 'box'), { recursive: true });
    symlinkSync(repo, join(repo, 'ig', 'box', 'back'));

    runSnapshot();
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    runSince();

    const lines = stderr();
    expect(
      lines.some((l) => l.includes('cannot see') || l.includes('pre-existing')),
    ).toBe(false);
    expect(lines.at(-1)).toBe(
      'fix-delta: 1 file(s) changed since the snapshot — a.ts',
    );
  });

  it('recognises a self-link on a non-ASCII root when no inode can be verified', () => {
    // The lexical fallback in the audited-root guard decoded the path
    // bytes as latin1 before resolving: on a root whose own name is not
    // ASCII the resolved comparison then ran on a spelling that does not
    // exist, the guard answered false for the audited repository itself,
    // and the tree was probed as its own nested repository — a false
    // `cannot see` beside hunks that show the edit. Compared as bytes,
    // the fallback is exact.
    statHook.zeroInodes = true;
    const wt = realpathSync(mkdtempSync(join(tmpdir(), 'qwen-fix-delta-røt-')));
    const cwdHere = process.cwd();
    try {
      gitAt(wt, 'init', '-q', '-b', 'main');
      gitAt(wt, 'config', 'user.email', 't@t.t');
      gitAt(wt, 'config', 'user.name', 't');
      writeFileSync(join(wt, 'a.ts'), 'export const x = 1;\n');
      gitAt(wt, 'add', '-A');
      gitAt(wt, 'commit', '-qm', 'head');
      symlinkSync('.', join(wt, 'self'));
      process.chdir(wt);
      const snap = join(out, 'nonascii-snapshot.json');
      const hunks = join(out, 'nonascii-hunks.diff');
      runFixDelta({ snapshot: true, since: undefined, out: snap });
      writeFileSync(join(wt, 'a.ts'), 'export const x = 2;\n');
      runSince(snap, hunks);

      expect(readFileSync(hunks, 'utf8')).toContain('+export const x = 2;');
      const lines = stderr();
      expect(
        lines.some(
          (l) =>
            /\bself\b/.test(l) &&
            (l.includes('cannot see') || l.includes('pre-existing')),
        ),
      ).toBe(false);
      expect(lines.at(-1)).toBe(
        'fix-delta: 1 file(s) changed since the snapshot — a.ts',
      );
    } finally {
      process.chdir(cwdHere);
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it('re-checks the side path for a redirect after the capture ran the filters', () => {
    // The entry check is taken once; the capture then executes the
    // repository's filters (disclosed, never refused). A filter child that
    // swaps the deterministic `--out` path for a symlink after the check
    // had the record written THROUGH the link — the victim's content
    // replaced, unrecoverably when untracked. The check runs again
    // immediately before the write, when nothing further executes code.
    const victim = join(out, 'victim.txt');
    writeFileSync(victim, 'sentinel — must survive\n');
    const filter = join(out, 'swap.sh');
    writeFileSync(
      filter,
      `#!/bin/sh\nrm -f '${snapshotFile()}'\nln -s '${victim}' '${snapshotFile()}'\ncat\n`,
    );
    chmodSync(filter, 0o755);
    git('config', 'filter.swap.clean', filter);
    writeFileSync(join(repo, '.gitattributes'), 'a.ts filter=swap\n');

    expect(() => runSnapshot()).toThrow(/side path .* is a symlink/);
    expect(readFileSync(victim, 'utf8')).toBe('sentinel — must survive\n');
  });

  it('refuses a redirected ancestor of an in-repository side path', () => {
    // A link planted at any component above the side path redirects the
    // write the same way a link at the leaf does; bounded by the checkout,
    // so the user's own layout above the repository (`/var` on macOS) is
    // never walked.
    mkdirSync(join(out, 'elsewhere'));
    symlinkSync(join(out, 'elsewhere'), join(repo, 'redirected'));
    expect(() =>
      runFixDelta({
        snapshot: true,
        since: undefined,
        out: join(repo, 'redirected', 'deep', 'snapshot.json'),
      }),
    ).toThrow(/is a symlink above the side path/);
    expect(existsSync(join(out, 'elsewhere', 'deep'))).toBe(false);
  });

  it('discloses a diff attribute on the SOURCE name of a rename', () => {
    // `diff-tree -M` folds a rename into one entry under its new name, but
    // renders the pair off the OLD name's `diff` attribute: a `-diff` on
    // the source path turned the pair into an opaque binary patch while
    // the folded list's only name answered `unspecified` — no note.
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    writeFileSync(join(repo, 'a.txt'), `${body}\n`);
    git('add', '-A');
    git('commit', '-qm', 'a.txt');

    runSnapshot();
    mkdirSync(join(repo, '.git', 'info'), { recursive: true });
    writeFileSync(join(repo, '.git', 'info', 'attributes'), 'a.txt -diff\n');
    renameSync(join(repo, 'a.txt'), join(repo, 'b.txt'));
    writeFileSync(join(repo, 'b.txt'), `${body}\nline 30 — the fix\n`);
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toContain('GIT binary patch');
    expect(
      stderr().some(
        (l) =>
          l.includes('steers how the hunks above render') &&
          l.includes('a.txt'),
      ),
    ).toBe(true);
  });

  it('refuses a core.worktree that names an enclosing checkout', () => {
    // The containment gate passes for an ANCESTOR: the audited repository
    // sits inside another repository's checkout, `core.worktree` names
    // that checkout, and the whole measurement switched to the outer
    // repository — the audited one recorded as a gitlink, the fix
    // captured nowhere, both moments agreeing on the wrong tree. Refused
    // by the honest-toplevel gate (the first `.git` above the cwd is the
    // audited one, not the outer checkout); the git-dir identity gate
    // behind it is the belt to that brace.
    const outer = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-outer-')),
    );
    const cwdHere = process.cwd();
    try {
      gitAt(outer, 'init', '-q', '-b', 'main');
      gitAt(outer, 'config', 'user.email', 't@t.t');
      gitAt(outer, 'config', 'user.name', 't');
      writeFileSync(join(outer, 'outer.txt'), 'outer\n');
      gitAt(outer, 'add', '-A');
      gitAt(outer, 'commit', '-qm', 'outer');
      const audited = join(outer, 'audited');
      mkdirSync(audited);
      gitAt(audited, 'init', '-q', '-b', 'main');
      gitAt(audited, 'config', 'user.email', 't@t.t');
      gitAt(audited, 'config', 'user.name', 't');
      writeFileSync(join(audited, 'a.ts'), 'export const x = 1;\n');
      gitAt(audited, 'add', '-A');
      gitAt(audited, 'commit', '-qm', 'audited');
      gitAt(audited, 'config', 'core.worktree', outer);
      process.chdir(audited);

      expect(() =>
        runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() }),
      ).toThrow(/core\.worktree/);
      expect(existsSync(snapshotFile())).toBe(false);
      // …and nothing landed in the outer git dir.
      expect(
        readdirSync(join(outer, '.git')).some((n) =>
          n.startsWith('qwen-fix-delta-'),
        ),
      ).toBe(false);
    } finally {
      process.chdir(cwdHere);
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('records an edit confined to line endings under core.autocrlf', () => {
    // Under `core.autocrlf=input` both captures stored the normalised
    // blob: HEAD holds LF, the worktree holds CRLF (a Windows checkout, a
    // tool's rewrite), and the conversion made the CRLF worktree file
    // capture as the LF blob it already was — so the fix's CRLF→LF rewrite
    // left the two trees identical and the run all-cleared over an edit
    // that was applied. The capture is pinned to the raw bytes; the pin is
    // shared by both moments.
    writeFileSync(join(repo, 'crlf.txt'), 'line1\nline2\n');
    git('add', '-A');
    git('commit', '-qm', 'lf in the repository');
    git('config', 'core.autocrlf', 'input');
    writeFileSync(join(repo, 'crlf.txt'), 'line1\r\nline2\r\n');

    runSnapshot();
    writeFileSync(join(repo, 'crlf.txt'), 'line1\nline2\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toContain('crlf.txt');
    expect(stderr().at(-1)).toBe(
      'fix-delta: 1 file(s) changed since the snapshot — crlf.txt',
    );
  });

  it('probes a directory recreated over a stale registry entry', () => {
    // The squat: a worktree is registered, its directory removed (the
    // entry survives, stale), and a directory recreated at the same path
    // with a gitfile pointing at that entry plus hidden loose files. Both
    // halves of a registry back-link check pass — the entry's back-link
    // genuinely names the squat's own `.git` — so any tree-side
    // classification walks it and never probes it, while the capture
    // excludes the family subtree. Only the orchestrator's own naming
    // decides now, and this path was not named.
    const wt = join(repo, '.qwen', 'tmp', 'review-pr-hide');
    git('worktree', 'add', '-q', '--detach', wt);
    const gitfile = readFileSync(join(wt, '.git'), 'utf8');
    rmSync(wt, { recursive: true, force: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), gitfile);
    writeFileSync(join(wt, 'hidden.txt'), 'v1\n');

    runSnapshot();
    writeFileSync(join(wt, 'hidden.txt'), 'the hidden fix\n');
    writeFileSync(join(wt, 'hidden2.txt'), 'more hidden\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) => l.includes('cannot see') && l.includes('review-pr-hide'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  // POSIX-only: a byte that is not valid UTF-8 cannot be a name on NTFS.
  it.skipIf(process.platform === 'win32')(
    'keeps the digest exact under core.quotePath=false',
    () => {
      // The digest is taken off the status output as a string: under
      // `core.quotePath=false` — plantable in the nested repository's own
      // config — a name that is not valid UTF-8 arrived as raw bytes and
      // decoded to U+FFFD, so two different interior states hashed the
      // same and a real edit was stamped pre-existing.
      writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
      git('add', '-A');
      git('commit', '-qm', 'ignore ig');
      const inner = join(repo, 'ig', 'inner');
      mkdirSync(inner, { recursive: true });
      gitAt(inner, 'init', '-q', '-b', 'main');
      gitAt(inner, 'config', 'user.email', 't@t.t');
      gitAt(inner, 'config', 'user.name', 't');
      gitAt(inner, 'config', 'core.quotePath', 'false');
      writeFileSync(join(inner, 'f.txt'), 'v1\n');
      gitAt(inner, 'add', '-A');
      gitAt(inner, 'commit', '-qm', 'init');
      const innerBuf = Buffer.from(inner);
      const nameA = Buffer.concat([
        innerBuf,
        Buffer.from('/a'),
        Buffer.from([0xe9]),
        Buffer.from('.bin'),
      ]);
      const nameB = Buffer.concat([
        innerBuf,
        Buffer.from('/a'),
        Buffer.from([0xc9]),
        Buffer.from('.bin'),
      ]);
      overwriteSh(nameA, 'v1');

      runSnapshot();
      // The fix: the untracked name with byte E9 is gone, the one with C9
      // is there — different interior states that decode to the same
      // U+FFFD-mangled line.
      execFileSync('/bin/sh', [], {
        input: Buffer.concat([
          Buffer.from("set -e\nrm -f '"),
          nameA,
          Buffer.from("'\n"),
        ]),
      });
      overwriteSh(nameB, 'v2');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(
        lines.some((l) => l.includes('cannot see') && l.includes('ig/inner')),
      ).toBe(true);
      expect(lines.some((l) => l.includes('pre-existing'))).toBe(false);
    },
  );

  it('never counts a nested repository’s own ignored content as dirt', () => {
    // `--ignored=matching` keeps an ignored directory inside a nested
    // repository in the digest, but its `! ` entries are not DIRT: a
    // repository whose only beyond-tracked content is its own `dist/` or
    // `node_modules/` — the everyday shape, and one git itself reports
    // clean — was stamped dirty at both moments, so every no-op run printed
    // a false pre-existing note and a real edit inside its ignored
    // directory was filed as pre-existing.
    const nested = join(repo, 'nested');
    mkdirSync(nested);
    gitAt(nested, 'init', '-q', '-b', 'main');
    gitAt(nested, 'config', 'user.email', 't@t.t');
    gitAt(nested, 'config', 'user.name', 't');
    writeFileSync(join(nested, '.gitignore'), 'node_modules/\n*.log\n');
    writeFileSync(join(nested, 'f.txt'), 'v1\n');
    gitAt(nested, 'add', '-A');
    gitAt(nested, 'commit', '-qm', 'init');
    mkdirSync(join(nested, 'node_modules'));
    writeFileSync(join(nested, 'node_modules', 'dep.js'), 'x\n');

    runSnapshot();
    runSince();
    let lines = stderr();
    expect(lines.some((l) => l.includes('pre-existing'))).toBe(false);
    expect(lines.at(-1)).toContain('the tree is unchanged since the snapshot');

    // …and an ignored entry that APPEARS still moves the digest: the
    // interior-moved note, never "already there". (What `--ignored=matching`
    // cannot see — content under an ignored directory it lists collapsed —
    // is outside this model, exactly as the top level's ignored files are.)
    (writeStderrLine as unknown as Mock).mockClear();
    runSnapshot();
    writeFileSync(join(nested, 'build.log'), 'the fix\n');
    runSince();
    lines = stderr();
    expect(
      lines.some(
        (l) =>
          l.includes('committed or stashed inside') && l.includes('nested'),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.includes('pre-existing'))).toBe(false);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('discloses a link chain the probe cannot follow instead of skipping it', () => {
    // A 41-hop chain: `statSync` throws ELOOP past the kernel's limit, and
    // the catch returned silently — a dirty repository at the end of it
    // was never probed and never named. Every errno but ENOENT (a dangling
    // link reaches nothing) is a path the probe could not answer for.
    const target = join(repo, 'far');
    mkdirSync(target);
    gitAt(target, 'init', '-q', '-b', 'main');
    gitAt(target, 'config', 'user.email', 't@t.t');
    gitAt(target, 'config', 'user.name', 't');
    writeFileSync(join(target, 'f.txt'), 'v1\n');
    gitAt(target, 'add', '-A');
    gitAt(target, 'commit', '-qm', 'init');
    let prev = 'far';
    for (let i = 0; i < 41; i++) {
      symlinkSync(prev, join(repo, `hop${i}`));
      prev = `hop${i}`;
    }
    git('add', '-A');
    git('commit', '-qm', 'the chain');

    runSnapshot();
    writeFileSync(join(target, 'f.txt'), 'the hidden fix\n');
    runSince();

    const lines = stderr();
    expect(
      lines.some((l) => l.includes('cannot see') && /\bfar\b/.test(l)),
    ).toBe(true);
    expect(lines.some((l) => l.includes('hop40'))).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('discloses a path the snapshot could not answer for that is gone since', () => {
    // The baseline persists its unresolved paths (disclosure only, never a
    // baseline): with no digest on either side, an unresolved path that
    // was removed before `--since` reached no transition and the run
    // all-cleared over it.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig');
    const inner = join(repo, 'ig', 'inner');
    mkdirSync(inner, { recursive: true });
    // A `.git` git rejects: probed as unresolved, never as clean.
    writeFileSync(join(inner, '.git'), 'not a git dir\n');
    writeFileSync(join(inner, 'payload.txt'), 'v1\n');

    runSnapshot();
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(snap.unresolved).toContain('ig/inner');
    expect(snap.dirtySubmodules).not.toContain('ig/inner');
    rmSync(inner, { recursive: true, force: true });
    runSince();

    const lines = stderr();
    expect(
      lines.some(
        (l) =>
          l.includes('finds nothing to answer for now') &&
          l.includes('ig/inner'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('never answers for a nested repository with the superproject’s status', () => {
    // A `.git` git itself rejects passes the `existsSync` gate the walk
    // uses; discovery from inside then walked UP and answered with the
    // superproject's status under the nested `--work-tree` — an answer
    // about the wrong repository, stamped as this path's state. Under an
    // ignored directory: at the top level git expands such a directory to
    // plain files and the capture records the edit itself.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig');
    // An EMPTY `.git` directory is the shape git discovery walks past (a
    // gitfile pointing nowhere makes git fail outright, which the probe
    // already answered `failed` for).
    const nested = join(repo, 'ig', 'nested');
    mkdirSync(join(nested, '.git'), { recursive: true });
    writeFileSync(join(nested, 'payload.txt'), 'v1\n');

    runSnapshot();
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(snap.unresolved).toContain('ig/nested');
    writeFileSync(join(nested, 'payload.txt'), 'the hidden fix\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) => l.includes('could not resolve') && l.includes('ig/nested'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('never certifies a nested repository whose own config steers its status', () => {
    // A repo-local `filter.<name>.clean` canonicalises what status hashes:
    // a size-preserving interior edit answers clean. No `-c` neutralises a
    // filter wired by attributes, so such a repository is not answered
    // for at all — unresolved, never clean.
    const nested = join(repo, 'nested');
    mkdirSync(nested);
    gitAt(nested, 'init', '-q', '-b', 'main');
    gitAt(nested, 'config', 'user.email', 't@t.t');
    gitAt(nested, 'config', 'user.name', 't');
    writeFileSync(join(nested, 'f.txt'), 'v1\n');
    gitAt(nested, 'add', '-A');
    gitAt(nested, 'commit', '-qm', 'init');
    gitAt(nested, 'config', 'filter.hide.clean', 'cat /dev/null');

    runSnapshot();
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(snap.unresolved).toContain('nested');
    writeFileSync(join(nested, 'f.txt'), 'v2\n');
    runSince();
    expect(
      stderr().some(
        (l) => l.includes('could not resolve') && l.includes('nested'),
      ),
    ).toBe(true);
    expect(stderr().some((l) => l.includes('pre-existing'))).toBe(false);

    // …and through the status route too: a TRACKED submodule that is
    // dirty (an `S..U` entry) and carries the filter in its own config is
    // UNRESOLVED — never "named dirty with no digest", the cell the matrix
    // does not have.
    const subSrc = plantCommittedSubmodule('sub');
    try {
      gitAt(join(repo, 'sub'), 'config', '--local', 'filter.hide.clean', 'cat');
      writeFileSync(join(repo, 'sub', 'untracked.txt'), 'dirty inside\n');
      (writeStderrLine as unknown as Mock).mockClear();
      runSnapshot();
      const again = JSON.parse(
        readFileSync(snapshotFile(), 'utf8'),
      ) as FixSnapshot;
      expect(again.unresolved).toContain('sub');
      expect(again.dirtySubmodules).not.toContain('sub');
      expect(again.digests['sub']).toBeUndefined();
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32' || process.geteuid?.() === 0)(
    'never certifies a nested repository whose interior status warns past exit 0',
    () => {
      // `git status` EXITS 0 over `warning: could not open directory '…'`
      // while the subtree nobody could read is silently absent from the
      // entries — so stdout plus the exit code certified clean over content
      // nobody saw. The interior status is ruled on its stderr like the
      // capture's own `add` is: any note is unexplained, and unexplained is
      // failed, never clean. (win32 has no POSIX permission bits to make
      // the directory unreadable, and root bypasses them everywhere else.)
      const nested = join(repo, 'nested');
      mkdirSync(nested);
      gitAt(nested, 'init', '-q', '-b', 'main');
      gitAt(nested, 'config', 'user.email', 't@t.t');
      gitAt(nested, 'config', 'user.name', 't');
      writeFileSync(join(nested, 'f.txt'), 'v1\n');
      gitAt(nested, 'add', '-A');
      gitAt(nested, 'commit', '-qm', 'init');
      mkdirSync(join(nested, 'scratch'));
      writeFileSync(join(nested, 'scratch', 's.txt'), 'x\n');
      chmodSync(join(nested, 'scratch'), 0o000);
      try {
        runSnapshot();
        const snap = JSON.parse(
          readFileSync(snapshotFile(), 'utf8'),
        ) as FixSnapshot;
        expect(snap.unresolved).toContain('nested');
        // NO edit between the moments: the unreadable subtree alone is the
        // witness — a clean answer over it is the false certification.
        runSince();

        const lines = stderr();
        expect(
          lines.some((l) => l.includes('nested') && l.includes('cannot see')),
        ).toBe(true);
        expect(
          lines.some((l) =>
            l.includes('the tree is unchanged since the snapshot'),
          ),
        ).toBe(false);
      } finally {
        chmodSync(join(nested, 'scratch'), 0o755);
      }
    },
  );

  it('never certifies a nested repository whose filter arrives by include or worktree config', () => {
    // `git config --local` does not follow `include.path`/`includeIf`
    // (git's documented default for a single scope) and never reads the
    // per-worktree file: a filter pulled in either way steered `status`
    // while the enumeration found nothing, and the probe certified clean
    // over an edit on disk. The merged config with its scope column is
    // what the probe reads; every scope but the user's is the tree's.
    const nested = join(repo, 'nested');
    mkdirSync(nested);
    gitAt(nested, 'init', '-q', '-b', 'main');
    gitAt(nested, 'config', 'user.email', 't@t.t');
    gitAt(nested, 'config', 'user.name', 't');
    writeFileSync(join(nested, 'f.txt'), 'v1\n');
    gitAt(nested, 'add', '-A');
    gitAt(nested, 'commit', '-qm', 'init');
    writeFileSync(
      join(nested, '.git', 'extra.conf'),
      '[filter "hide"]\n\tclean = cat\n',
    );
    gitAt(nested, 'config', 'include.path', 'extra.conf');

    runSnapshot();
    let snap = JSON.parse(readFileSync(snapshotFile(), 'utf8')) as FixSnapshot;
    expect(snap.unresolved).toContain('nested');
    expect(snap.digests['nested']).toBeUndefined();

    // …and the per-worktree config file.
    gitAt(nested, 'config', '--unset', 'include.path');
    gitAt(nested, 'config', 'extensions.worktreeConfig', 'true');
    gitAt(nested, 'config', '--worktree', 'filter.hide.clean', 'cat');
    (writeStderrLine as unknown as Mock).mockClear();
    runSnapshot();
    snap = JSON.parse(readFileSync(snapshotFile(), 'utf8')) as FixSnapshot;
    expect(snap.unresolved).toContain('nested');
    expect(snap.digests['nested']).toBeUndefined();
  });

  it('walks a nested repository’s ignored directory for repositories', () => {
    // The top level walks its collapsed `! <dir>/` entries for
    // repositories; a nested repository's own ignored directory was not
    // walked, so a level-2 repository under it — a working tree nested in
    // this one — had its status counted by nobody: the level-1 digest
    // carries only the `! vendor/` line, unchanged by any edit beneath.
    const nested = join(repo, 'nested');
    mkdirSync(nested);
    gitAt(nested, 'init', '-q', '-b', 'main');
    gitAt(nested, 'config', 'user.email', 't@t.t');
    gitAt(nested, 'config', 'user.name', 't');
    writeFileSync(join(nested, '.gitignore'), 'vendor/\n');
    writeFileSync(join(nested, 'f.txt'), 'v1\n');
    gitAt(nested, 'add', '-A');
    gitAt(nested, 'commit', '-qm', 'init');
    const lib = join(nested, 'vendor', 'lib');
    mkdirSync(lib, { recursive: true });
    gitAt(lib, 'init', '-q', '-b', 'main');
    gitAt(lib, 'config', 'user.email', 't@t.t');
    gitAt(lib, 'config', 'user.name', 't');
    writeFileSync(join(lib, 'g.txt'), 'v1\n');
    gitAt(lib, 'add', '-A');
    gitAt(lib, 'commit', '-qm', 'init');

    runSnapshot();
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(Object.keys(snap.digests)).toContain('nested/vendor/lib');
    writeFileSync(join(lib, 'g.txt'), 'the hidden fix\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) => l.includes('cannot see') && l.includes('nested/vendor/lib'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('probes a nested repository’s collapsed entry that IS a repository', () => {
    // The everyday `.gitignore` names the vendored checkout itself
    // (`third_party/llvm`, `deps/x`, `build`), so the collapsed `! lib/`
    // IS the repository — walking it looks for repositories one level
    // BELOW and finds none, so the level-2 repository got no digest, no
    // unresolved entry, and an edit inside reached the bare all-clear.
    // The untracked shape is its sibling: under `showUntrackedFiles=all`
    // a `? lib/` entry is exactly a directory git will not descend into.
    const nested = join(repo, 'nested');
    mkdirSync(nested);
    gitAt(nested, 'init', '-q', '-b', 'main');
    gitAt(nested, 'config', 'user.email', 't@t.t');
    gitAt(nested, 'config', 'user.name', 't');
    writeFileSync(join(nested, '.gitignore'), 'lib/\n');
    writeFileSync(join(nested, 'f.txt'), 'v1\n');
    gitAt(nested, 'add', '-A');
    gitAt(nested, 'commit', '-qm', 'init');
    for (const name of ['lib', 'untracked']) {
      const inner = join(nested, name);
      mkdirSync(inner);
      gitAt(inner, 'init', '-q', '-b', 'main');
      gitAt(inner, 'config', 'user.email', 't@t.t');
      gitAt(inner, 'config', 'user.name', 't');
      writeFileSync(join(inner, 'g.txt'), 'v1\n');
      gitAt(inner, 'add', '-A');
      gitAt(inner, 'commit', '-qm', 'init');
    }

    runSnapshot();
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(Object.keys(snap.digests)).toContain('nested/lib');
    expect(Object.keys(snap.digests)).toContain('nested/untracked');
    writeFileSync(join(nested, 'lib', 'g.txt'), 'the hidden fix\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some((l) => l.includes('cannot see') && l.includes('nested/lib')),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('runs no hook the repository ships, at either moment', () => {
    // Hooks are steering the tree carries. `core.fsmonitor` runs from the
    // capture's `check-ignore` (the one spawn that measured this tree
    // unpinned), and a `post-index-change` hook inherits the capture's
    // throwaway `GIT_INDEX_FILE` — one `cp` of a prebuilt index resets the
    // very index being recorded and both trees come back equal over a
    // landed edit. A hook that only PRINTS is the other half: its line
    // lands in `add`'s stderr and the capture refuses as incomplete.
    const marker = join(out, 'hook-ran');
    const hookBody = `#!/bin/sh\nprintf ran >> ${marker}\nprintf 'HOOK SAID X' >&2\n`;
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    for (const name of ['post-index-change', 'fsmonitor-watchman']) {
      const path = join(repo, '.git', 'hooks', name);
      writeFileSync(path, hookBody);
      chmodSync(path, 0o755);
    }
    git('config', 'core.fsmonitor', '.git/hooks/fsmonitor-watchman');
    // The side file lives INSIDE the repository, so `check-ignore` runs:
    // outside it the capture never spawns it at all.
    const snap = join(repo, '.qwen', 'tmp', 'fd-snapshot.json');
    const hunks = join(repo, '.qwen', 'tmp', 'fd-hunks.diff');
    mkdirSync(dirname(snap), { recursive: true });

    runFixDelta({ snapshot: true, since: undefined, out: snap });
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    expect(() => runSince(snap, hunks)).not.toThrow();

    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(hunks, 'utf8')).toContain('export const x = 2;');
    expect(stderr().at(-1)).toContain('1 file(s) changed since the snapshot');
  });

  it('probes a repository hidden in a nested repository’s own ignored path', () => {
    // Depth alone was the difference: the walk stopped at the first `.git`
    // it met and handed that repository to the probe without descending,
    // so a repository under an ignored path OF a nested repository was
    // neither walked, nor dirt, nor a digest move — and the run printed
    // the bare all-clear over an edit inside it.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig');
    const repoA = join(repo, 'ig', 'repoA');
    mkdirSync(repoA, { recursive: true });
    gitAt(repoA, 'init', '-q', '-b', 'main');
    gitAt(repoA, 'config', 'user.email', 't@t.t');
    gitAt(repoA, 'config', 'user.name', 't');
    writeFileSync(join(repoA, '.gitignore'), 'build/\n');
    writeFileSync(join(repoA, 'f.txt'), 'v1\n');
    gitAt(repoA, 'add', '-A');
    gitAt(repoA, 'commit', '-qm', 'init');
    const deep = join(repoA, 'build', 'deep');
    mkdirSync(deep, { recursive: true });
    gitAt(deep, 'init', '-q', '-b', 'main');
    gitAt(deep, 'config', 'user.email', 't@t.t');
    gitAt(deep, 'config', 'user.name', 't');
    writeFileSync(join(deep, 'x.ts'), 'v1\n');
    gitAt(deep, 'add', '-A');
    gitAt(deep, 'commit', '-qm', 'init');

    runSnapshot();
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(Object.keys(snap.digests)).toContain('ig/repoA/build/deep');
    writeFileSync(join(deep, 'x.ts'), 'the hidden fix\n');
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) => l.includes('cannot see') && l.includes('ig/repoA/build/deep'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
  });

  it('discovers every repository on a filesystem that reports no inodes', () => {
    // FAT/exFAT and some SMB mounts answer `ino === 0` for every entry.
    // Keyed on a raw `dev:ino`, the first directory walked claimed the
    // identity of all of them: every later directory read as already
    // visited, every path compared equal to the audited root, and both
    // `dirtySubmodules` and `digests` came back EMPTY behind the bare
    // all-clear. No identity means walk and probe, never "seen".
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig');
    for (const name of ['one', 'two']) {
      const inner = join(repo, 'ig', name);
      mkdirSync(inner, { recursive: true });
      gitAt(inner, 'init', '-q', '-b', 'main');
      gitAt(inner, 'config', 'user.email', 't@t.t');
      gitAt(inner, 'config', 'user.name', 't');
      writeFileSync(join(inner, 'f.txt'), 'v1\n');
      gitAt(inner, 'add', '-A');
      gitAt(inner, 'commit', '-qm', 'init');
      writeFileSync(join(inner, 'dirty.txt'), 'uncommitted\n');
    }

    statHook.zeroInodes = true;
    runSnapshot();
    statHook.zeroInodes = false;
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(snap.dirtySubmodules).toEqual(
      expect.arrayContaining(['ig/one', 'ig/two']),
    );
    expect(Object.keys(snap.digests)).toEqual(
      expect.arrayContaining(['ig/one', 'ig/two']),
    );
  });

  it('never baselines a repository the walk reaches outside the root', () => {
    // A directory link out of the tree led the walk to enumerate, spawn
    // against and BASELINE content the capture never records: an unrelated
    // commit in that repository read as this tree's transition, and the
    // enumeration spent the run's budget on it. Out of root is disclosed,
    // never walked.
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-outside-')),
    );
    try {
      gitAt(outside, 'init', '-q', '-b', 'main');
      gitAt(outside, 'config', 'user.email', 't@t.t');
      gitAt(outside, 'config', 'user.name', 't');
      writeFileSync(join(outside, 'o.txt'), 'v1\n');
      gitAt(outside, 'add', '-A');
      gitAt(outside, 'commit', '-qm', 'init');
      writeFileSync(join(outside, 'dirt.txt'), 'unrelated\n');
      writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
      git('add', '-A');
      git('commit', '-qm', 'ignore ig');
      mkdirSync(join(repo, 'ig'));
      symlinkSync(outside, join(repo, 'ig', 'ext'));

      runSnapshot();
      const snap = JSON.parse(
        readFileSync(snapshotFile(), 'utf8'),
      ) as FixSnapshot;
      expect(Object.keys(snap.digests)).not.toContain('ig/ext');
      expect(snap.dirtySubmodules).not.toContain('ig/ext');
      expect(snap.unresolved).not.toContain('ig/ext');
      // Scope, not an unanswerable state: the link is named, its target's
      // dirt is not this tree's, and the run says so.
      expect(snap.outOfRoot).toContain('ig/ext');
      writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
      runSince();

      const lines = stderr();
      expect(
        lines.some(
          (l) => l.includes('ig/ext') && l.includes('outside this repository'),
        ),
      ).toBe(true);
      expect(lines.some((l) => l.includes('otherrepo'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('names a pre-existing dirty out-of-root repository a top-level link reaches, beside the all-clear', () => {
    // The link route — a slashless untracked status entry — both records
    // the scope AND probes the repository (its fresh dirt is a blind spot
    // either way). The two buckets then cancelled downstream: pre-existing
    // dirt exempted the path from the pre-existing note on scope, the
    // scope note dropped it for being dirty, and the run all-cleared with
    // no line naming the surface an edit is invisible through. Dirt that
    // is the SAME state the baseline recorded is scope, not fresh dirt.
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-outside-')),
    );
    try {
      gitAt(outside, 'init', '-q', '-b', 'main');
      gitAt(outside, 'config', 'user.email', 't@t.t');
      gitAt(outside, 'config', 'user.name', 't');
      writeFileSync(join(outside, 'o.txt'), 'v1\n');
      gitAt(outside, 'add', '-A');
      gitAt(outside, 'commit', '-qm', 'init');
      writeFileSync(join(outside, 'dirt.txt'), 'unrelated, uncommitted\n');
      symlinkSync(outside, join(repo, 'toplink'));

      runSnapshot();
      const snap = JSON.parse(
        readFileSync(snapshotFile(), 'utf8'),
      ) as FixSnapshot;
      expect(snap.outOfRoot).toContain('toplink');
      expect(snap.dirtySubmodules).toContain('toplink');
      runSince();

      const lines = stderr();
      expect(
        lines.some(
          (l) => l.includes('toplink') && l.includes('outside this repository'),
        ),
      ).toBe(true);
      expect(lines.at(-1)).toContain(
        'the tree is unchanged since the snapshot',
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('routes a tracked file whose worktree copy is a symlink to a repository', () => {
    // A tracked REGULAR FILE replaced in the worktree by a symlink keeps
    // its index mode and an `N...` sub token, so the S-token gate drops
    // the record and the index sweep (keyed on the index modes) skips it
    // — the repository behind the link was in no bucket while the run
    // all-cleared. The record's WORKTREE mode (120000) is the route.
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-outside-')),
    );
    try {
      gitAt(outside, 'init', '-q', '-b', 'main');
      gitAt(outside, 'config', 'user.email', 't@t.t');
      gitAt(outside, 'config', 'user.name', 't');
      writeFileSync(join(outside, 'f.txt'), 'v1\n');
      gitAt(outside, 'add', '-A');
      gitAt(outside, 'commit', '-qm', 'init');
      writeFileSync(join(repo, 'x'), 'v1\n');
      git('add', 'x');
      git('commit', '-qm', 'track x');
      rmSync(join(repo, 'x'));
      symlinkSync(outside, join(repo, 'x'));

      runSnapshot();
      const snap = JSON.parse(
        readFileSync(snapshotFile(), 'utf8'),
      ) as FixSnapshot;
      expect(snap.outOfRoot).toContain('x');
      writeFileSync(join(outside, 'f.txt'), 'the hidden fix\n');
      runSince();

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const lines = stderr();
      expect(
        lines.some((l) => /\bx\b/.test(l) && l.includes('cannot see')),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('scopes an index gitlink whose worktree path is a link out of the tree', () => {
    // The index gitlink route gated on `existsSync` alone — which follows
    // the link — and the funnel carried no containment ruling of its own,
    // so a gitlink path whose worktree is a link out of the tree was
    // probed and baselined as content of THIS tree, and a commit in the
    // external repository read as a move inside it. The funnel rules the
    // reach first. The entry is assume-unchanged so the STATUS route stays
    // blind and the pin measures the funnel.
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-outside-')),
    );
    try {
      gitAt(outside, 'init', '-q', '-b', 'main');
      gitAt(outside, 'config', 'user.email', 't@t.t');
      gitAt(outside, 'config', 'user.name', 't');
      writeFileSync(join(outside, 'o.txt'), 'v1\n');
      gitAt(outside, 'add', '-A');
      gitAt(outside, 'commit', '-qm', 'init');
      const sha = gitAt(outside, 'rev-parse', 'HEAD');
      git('update-index', '--add', '--cacheinfo', `160000,${sha},sub`);
      git('commit', '-qm', 'add gitlink');
      symlinkSync(outside, join(repo, 'sub'));
      git('update-index', '--assume-unchanged', 'sub');

      runSnapshot();
      const snap = JSON.parse(
        readFileSync(snapshotFile(), 'utf8'),
      ) as FixSnapshot;
      expect(snap.outOfRoot).toContain('sub');
      expect(snap.unresolved).not.toContain('sub');
      // A commit inside the external repository between the moments.
      writeFileSync(join(outside, 'o.txt'), 'v2\n');
      gitAt(outside, 'add', '-A');
      gitAt(outside, 'commit', '-qm', 'an unrelated move');
      runSince();

      const lines = stderr();
      expect(
        lines.some(
          (l) => l.includes('sub') && l.includes('outside this repository'),
        ),
      ).toBe(true);
      expect(
        lines.some(
          (l) => l.includes('sub') && l.includes('committed or stashed'),
        ),
      ).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('scopes a repository one level inside an out-of-root link target', () => {
    // The interior route: a nested repository discovered one level inside
    // an out-of-root link's target was handed to the probe with no reach
    // ruling of its own — and `isOutOfRoot` matches exactly, so a commit
    // inside the external repository was charged to the audited tree.
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-outside-')),
    );
    try {
      gitAt(outside, 'init', '-q', '-b', 'main');
      gitAt(outside, 'config', 'user.email', 't@t.t');
      gitAt(outside, 'config', 'user.name', 't');
      writeFileSync(join(outside, 'o.txt'), 'v1\n');
      gitAt(outside, 'add', '-A');
      gitAt(outside, 'commit', '-qm', 'init');
      const vendor = join(outside, 'vendor');
      mkdirSync(vendor);
      gitAt(vendor, 'init', '-q', '-b', 'main');
      gitAt(vendor, 'config', 'user.email', 't@t.t');
      gitAt(vendor, 'config', 'user.name', 't');
      writeFileSync(join(vendor, 'v.txt'), 'v1\n');
      gitAt(vendor, 'add', '-A');
      gitAt(vendor, 'commit', '-qm', 'init');
      symlinkSync(outside, join(repo, 'toplink'));

      runSnapshot();
      const snap = JSON.parse(
        readFileSync(snapshotFile(), 'utf8'),
      ) as FixSnapshot;
      expect(snap.outOfRoot).toContain('toplink');
      expect(snap.outOfRoot).toContain('toplink/vendor');
      // A commit inside the external repository between the moments.
      writeFileSync(join(vendor, 'v.txt'), 'v2\n');
      gitAt(vendor, 'add', '-A');
      gitAt(vendor, 'commit', '-qm', 'an unrelated move');
      runSince();

      const lines = stderr();
      expect(
        lines.some(
          (l) =>
            l.includes('toplink/vendor') &&
            l.includes('outside this repository'),
        ),
      ).toBe(true);
      expect(
        lines.some(
          (l) =>
            l.includes('toplink/vendor') && l.includes('committed or stashed'),
        ),
      ).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('states an out-of-root FILE link as scope, without spending the all-clear', () => {
    // The reach ruling ran only once the target was known to be a
    // DIRECTORY: a link reaching a FILE outside the tree was dropped
    // unclassified — in no bucket, named by no line — while an edit
    // through it lands where the trees record nothing. A file cannot
    // hold a repository, so there is nothing to probe; the scope fact
    // remains.
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-outside-')),
    );
    try {
      writeFileSync(join(outside, 'cfg.json'), '{"v":1}\n');
      symlinkSync(join(outside, 'cfg.json'), join(repo, 'cfglink'));

      runSnapshot();
      const snap = JSON.parse(
        readFileSync(snapshotFile(), 'utf8'),
      ) as FixSnapshot;
      expect(snap.outOfRoot).toContain('cfglink');
      expect(snap.unresolved).not.toContain('cfglink');
      runSince();

      const lines = stderr();
      expect(
        lines.some(
          (l) => l.includes('cfglink') && l.includes('outside this repository'),
        ),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('states an out-of-root FILE link an ignored directory hides as scope', () => {
    // The walk route's sibling case: `reposUnder` met the link's target
    // not being a directory with `continue`, past the reach ruling a
    // directory link gets — the same unclassified drop, one route down.
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-outside-')),
    );
    try {
      writeFileSync(join(outside, 'cfg.json'), '{"v":1}\n');
      writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
      git('add', '-A');
      git('commit', '-qm', 'ignore ig');
      mkdirSync(join(repo, 'ig'));
      symlinkSync(join(outside, 'cfg.json'), join(repo, 'ig', 'cfglink'));

      runSnapshot();
      const snap = JSON.parse(
        readFileSync(snapshotFile(), 'utf8'),
      ) as FixSnapshot;
      expect(snap.outOfRoot).toContain('ig/cfglink');
      runSince();

      const lines = stderr();
      expect(
        lines.some(
          (l) =>
            l.includes('ig/cfglink') && l.includes('outside this repository'),
        ),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a subtree an enclosing checkout already answers for', () => {
    // ONE planted `sub/.git` reading `gitdir: <repo>/.git` narrows every
    // reading to `sub`: git answers `--show-toplevel` = `sub`, the honest
    // walk stops at the plant, and both git-dir readings resolve through
    // it and agree — so the capture recorded a subtree, the hunks named
    // paths that do not exist at the repository root, and every edit
    // outside `sub` landed in no hunk. A stale gitfile a moved submodule
    // or a copied worktree left behind is the same shape.
    mkdirSync(join(repo, 'sub'), { recursive: true });
    writeFileSync(join(repo, 'sub', 'b.txt'), 'v1\n');
    git('add', '-A');
    git('commit', '-qm', 'sub');
    writeFileSync(join(repo, 'sub', '.git'), `gitdir: ${join(repo, '.git')}\n`);
    const cwdHere = process.cwd();
    try {
      process.chdir(join(repo, 'sub'));
      expect(() => runSnapshot()).toThrow(/CONTAINS it/);
    } finally {
      process.chdir(cwdHere);
    }
    expect(existsSync(snapshotFile())).toBe(false);
  });

  it('refuses a subtree plant even when the enclosing HEAD is spelled without the space', () => {
    // git's `validate_headref` skips ZERO or more whitespace after `ref:`,
    // so `ref:refs/heads/main` is a HEAD git answers for. The hand-rolled
    // predicate required `\s+`, answered false for the enclosing
    // repository, and the subtree-narrowing gate stood down over a
    // planted `sub/.git` — the snapshot recorded the subtree and
    // `--since` all-cleared over a fix applied at the root. The
    // classification now asks git itself.
    mkdirSync(join(repo, 'sub'), { recursive: true });
    writeFileSync(join(repo, 'sub', 'b.txt'), 'v1\n');
    git('add', '-A');
    git('commit', '-qm', 'sub');
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref:refs/heads/main');
    writeFileSync(join(repo, 'sub', '.git'), `gitdir: ${join(repo, '.git')}\n`);
    const cwdHere = process.cwd();
    try {
      process.chdir(join(repo, 'sub'));
      expect(() => runSnapshot()).toThrow(/CONTAINS it/);
    } finally {
      process.chdir(cwdHere);
    }
    expect(existsSync(snapshotFile())).toBe(false);
  });

  it('accepts an uppercase detached HEAD, as git does', () => {
    // `get_oid_hex` takes A-F too: a repository recovered by hand with an
    // uppercase SHA in `.git/HEAD` is a working detached HEAD to git. The
    // lowercase-only predicate said otherwise, the honest walk climbed
    // past an honest `.git`, and the refusal diagnosed a `core.worktree`
    // that was never set.
    const head = git('rev-parse', 'HEAD').toUpperCase();
    writeFileSync(join(repo, '.git', 'HEAD'), `${head}\n`);
    // git itself answers this HEAD: the precondition the pin is about.
    expect(git('rev-parse', '--show-toplevel')).toBe(repo);
    expect(() => runSnapshot()).not.toThrow();
    expect(existsSync(snapshotFile())).toBe(true);
  });

  it('captures a family-named path the user staged without committing', () => {
    // `-u` updates entries the throwaway index HOLDS, and that index is
    // HEAD's tree: a family-named path staged but not committed is tracked
    // by the same meaning the re-inclusion's contract uses, yet it was in
    // neither tree — so a fix's edit to it produced an empty delta and the
    // bare all-clear, the very harm the re-inclusion exists to prevent.
    // The repository IGNORES `.qwen/` — this one does, and so do many —
    // which is what makes `-f` load-bearing on the re-inclusion.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.qwen/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore .qwen');
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    const staged = join(repo, '.qwen', 'tmp', 'qwen-review-notes.md');
    writeFileSync(staged, 'staged content v1\n');
    git('add', '-f', '--', '.qwen/tmp/qwen-review-notes.md');

    runSnapshot();
    writeFileSync(staged, 'staged content v2 EDITED-BY-THE-FIX\n');
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).toContain('qwen-review-notes.md');
    expect(hunks).toContain('EDITED-BY-THE-FIX');
    // …and the baseline's content as the REMOVED line: a whole-file
    // addition would mean the baseline never recorded the staged path.
    expect(hunks).toContain('-staged content v1');
    expect(stderr().at(-1)).not.toContain('the tree is unchanged since');
  });

  it('records the deletion of a staged family-named dangling symlink', () => {
    // The staged re-inclusion filtered on `existsSync`, which FOLLOWS the
    // link: a staged DANGLING symlink was dropped from both trees, and
    // the fix's deletion of it produced no hunk over the bare all-clear.
    // git records a symlink (mode 120000) whether or not the target
    // exists; `lstat` answers for the entry git stored.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.qwen/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore .qwen');
    mkdirSync(join(repo, '.qwen', 'tmp'), { recursive: true });
    const link = join(repo, '.qwen', 'tmp', 'qwen-review-link');
    symlinkSync('gone-target', link);
    git('add', '-f', '--', '.qwen/tmp/qwen-review-link');

    runSnapshot();
    rmSync(link);
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).toContain('qwen-review-link');
    expect(hunks).toContain('deleted file mode 120000');
    // The link's target text rides the blob: it must render as a REMOVED
    // line — a whole-file addition would mean the baseline never recorded
    // the link at all.
    expect(hunks).toContain('-gone-target');
    expect(stderr().at(-1)).not.toContain('the tree is unchanged since');
  });

  it('keeps a file the fix replaced with a directory in the hunks', () => {
    // A tracked FILE replaced by a DIRECTORY of the same name records
    // `D <name>` beside the new entries, and "still on disk" alone called
    // that a capture artefact: the literal exclude then dropped the whole
    // SUBTREE from the hunks, and when the replacement was the only change
    // the run printed the all-clear over it. A ghost is a path an ignore
    // rule now hides — git is the authority on its own rules.
    writeFileSync(join(repo, 'config.json'), '{"v":1}\n');
    git('add', '-A');
    git('commit', '-qm', 'config');

    runSnapshot();
    rmSync(join(repo, 'config.json'));
    mkdirSync(join(repo, 'config.json'));
    writeFileSync(join(repo, 'config.json', 'prod.json'), '{"env":"prod"}\n');
    writeFileSync(join(repo, 'config.json', 'dev.json'), '{"env":"dev"}\n');
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).toContain('config.json/prod.json');
    expect(hunks).toContain('config.json/dev.json');
    const lines = stderr();
    expect(
      lines.some((l) => l.includes('still on') && l.includes('disk')),
    ).toBe(false);
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(false);
  });

  it('keeps a file the fix replaced with an ignored directory in the hunks', () => {
    // The same replacement WITH an ignore rule covering the name: the
    // ghost classifier answered "still on disk" (a directory now), the
    // rule answered "hidden", and a REAL deletion the fix made was
    // dropped from the hunks as the capture's own invention. A tree
    // records no plain-directory entries, so a directory under the name
    // is a replacement, never a ghost.
    writeFileSync(join(repo, 'config.json'), '{"v":1}\n');
    git('add', '-A');
    git('commit', '-qm', 'config');

    runSnapshot();
    rmSync(join(repo, 'config.json'));
    mkdirSync(join(repo, 'config.json'));
    writeFileSync(join(repo, 'config.json', 'prod.json'), '{"env":"prod"}\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nconfig.json/\n');
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).toContain('deleted file mode 100644');
    expect(hunks).toContain('config.json');
    // The count names the real changes: the `.gitignore` edit and the
    // deletion — the ignored replacement content enters neither tree.
    const lines = stderr();
    expect(
      lines.some((l) => /2 file\(s\) changed since the snapshot/.test(l)),
    ).toBe(true);
    expect(
      lines.some(
        (l) =>
          l.includes('config.json') &&
          l.includes('still on') &&
          l.includes('disk'),
      ),
    ).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'walks an in-tree link whose own name is not valid UTF-8',
    () => {
      // The root bound is decided on BYTES: a link whose name carries an
      // invalid byte decoded to U+FFFD, `realpathSync` threw for the
      // decoded string, and the walk called an in-tree link an escape —
      // so the repository behind it was never discovered, on every run,
      // on any filesystem that allows such a name (Linux; APFS refuses
      // them, which is why the sibling cases below fail locally too).
      writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
      git('add', '-A');
      git('commit', '-qm', 'ignore ig');
      const inner = join(repo, 'ig', 'inner');
      mkdirSync(inner, { recursive: true });
      gitAt(inner, 'init', '-q', '-b', 'main');
      gitAt(inner, 'config', 'user.email', 't@t.t');
      gitAt(inner, 'config', 'user.name', 't');
      writeFileSync(join(inner, 'f.txt'), 'v1\n');
      gitAt(inner, 'add', '-A');
      gitAt(inner, 'commit', '-qm', 'init');
      // A second route to the same directory, under a name spawn args
      // cannot carry — planted through the shell's stdin, the one
      // byte-exact channel.
      const linkAbs = Buffer.concat([
        Buffer.from(join(repo, 'ig', 'l')),
        Buffer.from([0xff]),
      ]);
      execFileSync('/bin/sh', [], {
        input: Buffer.concat([
          Buffer.from("set -e\nln -s -- '"),
          Buffer.from(join(repo, 'ig')),
          Buffer.from("' '"),
          linkAbs,
          Buffer.from("'\n"),
        ]),
      });

      runSnapshot();
      const snap = JSON.parse(
        readFileSync(snapshotFile(), 'utf8'),
      ) as FixSnapshot;
      // In-tree, so it is neither scope nor unresolvable, and the
      // repository behind it is recorded exactly once.
      expect(snap.outOfRoot).toEqual([]);
      expect(snap.unresolved).toEqual([]);
      expect(Object.keys(snap.digests)).toEqual(['ig/inner']);
    },
  );

  it('states an out-of-root link as scope, without spending the all-clear', () => {
    // `npm link`, a `file:../sibling` dependency and a hoisted package
    // store put a directory link out of the tree in an ordinary run.
    // Content out there is outside this command's model the way a
    // gitignored file's bytes are, so it states the scope; gating the
    // all-clear on it made the qualification fire on every run, which is
    // the disclosure nobody reads. A link that APPEARED since the
    // snapshot is the fix's doing and does gate.
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-linked-')),
    );
    try {
      writeFileSync(join(outside, 'o.txt'), 'v1\n');
      writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
      git('add', '-A');
      git('commit', '-qm', 'ignore ig');
      mkdirSync(join(repo, 'ig'));
      symlinkSync(outside, join(repo, 'ig', 'linked'));

      runSnapshot();
      const snap = JSON.parse(
        readFileSync(snapshotFile(), 'utf8'),
      ) as FixSnapshot;
      expect(snap.outOfRoot).toContain('ig/linked');
      expect(snap.unresolved).not.toContain('ig/linked');
      runSince();
      let lines = stderr();
      expect(
        lines.some(
          (l) =>
            l.includes('ig/linked') && l.includes('outside this repository'),
        ),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(true);

      // …and one that was not there at the snapshot gates it.
      (writeStderrLine as unknown as Mock).mockClear();
      runSnapshot();
      symlinkSync(outside, join(repo, 'ig', 'fresh-link'));
      runSince();
      lines = stderr();
      expect(
        lines.some(
          (l) =>
            l.includes('ig/fresh-link') &&
            l.includes('not there at the snapshot'),
        ),
      ).toBe(true);
      expect(
        lines.some((l) =>
          l.includes('the tree is unchanged since the snapshot'),
        ),
      ).toBe(false);

      // A path that was the link at snapshot time but holds an IN-TREE
      // repository now is content of this tree at this moment: keying the
      // transition on the union of both moments exempted it on the
      // baseline's say-so, and an edit committed inside the audited tree
      // all-cleared.
      (writeStderrLine as unknown as Mock).mockClear();
      runSnapshot();
      rmSync(join(repo, 'ig', 'linked'));
      mkdirSync(join(repo, 'ig', 'linked'));
      gitAt(join(repo, 'ig', 'linked'), 'init', '-q', '-b', 'main');
      gitAt(join(repo, 'ig', 'linked'), 'config', 'user.email', 't@t.t');
      gitAt(join(repo, 'ig', 'linked'), 'config', 'user.name', 't');
      writeFileSync(join(repo, 'ig', 'linked', 'f.txt'), 'the fix\n');
      gitAt(join(repo, 'ig', 'linked'), 'add', '-A');
      gitAt(join(repo, 'ig', 'linked'), 'commit', '-qm', 'the fix, committed');
      runSince();
      lines = stderr();
      expect(
        lines.some(
          (l) =>
            l.includes('ig/linked') &&
            (l.includes('outside this repository') ||
              l.includes('never recorded')),
        ),
      ).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('never reports a deletion the capture invented from a new ignore rule', () => {
    // The two captures run under whatever ignore rules exist at each
    // moment. A `.gitignore` line the fix writes — the most ordinary thing
    // a fix does — hides a pre-existing untracked file from the SECOND
    // capture, and the tree comparison read the absence as a deletion: the
    // hunks asserted an edit the fix never made and the count overstated
    // its footprint.
    mkdirSync(join(repo, 'coverage'), { recursive: true });
    writeFileSync(join(repo, 'coverage', 'lcov.info'), 'report\n');

    runSnapshot();
    writeFileSync(join(repo, '.gitignore'), 'coverage/\n');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).not.toContain('coverage/lcov.info');
    expect(hunks).toContain('a.ts');
    expect(existsSync(join(repo, 'coverage', 'lcov.info'))).toBe(true);
    const lines = stderr();
    expect(
      lines.some(
        (l) =>
          l.includes('coverage/lcov.info') &&
          l.includes('still on') &&
          l.includes('disk'),
      ),
    ).toBe(true);
    expect(
      lines.some((l) => /2 file\(s\) changed since the snapshot/.test(l)),
    ).toBe(true);
  });

  it('never reports an addition the capture invented from a removed ignore rule', () => {
    // The mirror direction: the rule HID the pre-existing untracked file
    // at snapshot time, so the first capture never recorded it; removing
    // the rule between the moments admits it to the second capture as a
    // full-file ADDITION — an edit the fix never made, attributed to it.
    // The first moment's rule set is gone by `--since` (the rule may have
    // lived in `info/exclude`), so the snapshot records what the rules hid
    // and the addition side is ruled against the record.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\ncoverage/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore coverage');
    mkdirSync(join(repo, 'coverage'));
    writeFileSync(join(repo, 'coverage', 'lcov.info'), 'pre-existing report\n');

    runSnapshot();
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).not.toContain('lcov.info');
    expect(hunks).toContain('a.ts');
    expect(hunks).toContain('.gitignore');
    expect(existsSync(join(repo, 'coverage', 'lcov.info'))).toBe(true);
    const lines = stderr();
    expect(
      lines.some(
        (l) =>
          l.includes('coverage/lcov.info') && l.includes('already on disk'),
      ),
    ).toBe(true);
    // The count names only the real changes: `.gitignore` and `a.ts`.
    expect(
      lines.some((l) => /2 file\(s\) changed since the snapshot/.test(l)),
    ).toBe(true);
  });

  it('classifies a ghost for a file staged in the user index, never committed', () => {
    // `check-ignore` without `--no-index` lets the USER's index outrank
    // the rules: a staged-but-uncommitted file is never reported ignored,
    // so it was never recognised as a ghost and the invented deletion
    // rode into the hunks as an edit the fix never made. The classifier
    // asks the rules-only question, which is the one the capture answers.
    writeFileSync(join(repo, 'foo.log'), 'a\n');
    git('add', '--', 'foo.log'); // staged, never committed

    runSnapshot();
    writeFileSync(join(repo, '.gitignore'), '*.log\n');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).not.toContain('deleted file mode');
    expect(hunks).not.toContain('foo.log');
    expect(hunks).toContain('.gitignore');
    expect(hunks).toContain('a.ts');
    const lines = stderr();
    expect(
      lines.some(
        (l) =>
          /\bfoo\.log\b/.test(l) &&
          l.includes('still on') &&
          l.includes('disk'),
      ),
    ).toBe(true);
    // The count names only the real changes: `.gitignore` and `a.ts`.
    expect(
      lines.some((l) => /2 file\(s\) changed since the snapshot/.test(l)),
    ).toBe(true);
  });

  it('classifies a capture-invented deletion of a dangling symlink as a ghost', () => {
    // The on-disk test used `existsSync`, which FOLLOWS the link: a
    // dangling symlink — on disk by every lstat meaning, recorded by git
    // as mode 120000 — failed the test and skipped the classifier, so the
    // invented deletion rode into the hunks as an edit the fix never made.
    symlinkSync('gone-target', join(repo, 'v'));

    runSnapshot();
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nv\n');
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).not.toContain('deleted file mode 120000');
    expect(hunks).not.toContain('gone-target');
    const lines = stderr();
    expect(
      lines.some(
        (l) => /\bv\b/.test(l) && l.includes('still on') && l.includes('disk'),
      ),
    ).toBe(true);
  });

  it('runs from a cwd whose own empty .git directory git climbs past', () => {
    // git's discovery skips a `.git` that is not a git dir (an empty
    // directory, a dangling link) and climbs; the honest-toplevel gate
    // read the entry's presence alone and refused the run as a
    // `core.worktree` redirect that was never set.
    mkdirSync(join(repo, 'sub', '.git'), { recursive: true });
    const cwdHere = process.cwd();
    try {
      process.chdir(join(repo, 'sub'));
      expect(() => runSnapshot()).not.toThrow();
      // …and the shape git validates rather than counts: a `.git`
      // directory with the entries but an EMPTY HEAD is not a git dir to
      // git either (`validate_headref`), and it climbs past that too.
      mkdirSync(join(repo, 'sub', '.git', 'objects'), { recursive: true });
      mkdirSync(join(repo, 'sub', '.git', 'refs'), { recursive: true });
      writeFileSync(join(repo, 'sub', '.git', 'HEAD'), '');
      expect(
        execFileSync('git', ['rev-parse', '--show-toplevel'], {
          cwd: join(repo, 'sub'),
          encoding: 'utf8',
        }).trim(),
      ).toBe(realpathSync(repo));
      expect(() => runSnapshot()).not.toThrow();
    } finally {
      process.chdir(cwdHere);
    }
    expect(stderr().some((l) => l.includes('core.worktree'))).toBe(false);
  });

  it('keeps the user’s own global filter out of the tree’s steering', () => {
    // The steering ruling is about the TREE: `filter.lfs.*` from a
    // `git lfs install` is the user's, and reading every scope as the
    // tree's would leave every nested repository unresolved on every run
    // for an everyday global config. A value carrying a NEWLINE is the
    // shape that broke the scope parse: the line form prints
    // `<scope>\t<key>\n<value>`, so the value's second line was read as
    // a scope of its own.
    writeFileSync(
      join(gitIsolation.home, '.gitconfig'),
      '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n' +
        '\tprocess = git-lfs filter-process\n' +
        '[filter "nl"]\n\tclean = "a\\nb"\n',
    );
    const nested = join(repo, 'nested');
    mkdirSync(nested);
    gitAt(nested, 'init', '-q', '-b', 'main');
    gitAt(nested, 'config', 'user.email', 't@t.t');
    gitAt(nested, 'config', 'user.name', 't');
    writeFileSync(join(nested, 'f.txt'), 'v1\n');
    gitAt(nested, 'add', '-A');
    gitAt(nested, 'commit', '-qm', 'init');

    runSnapshot();
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(snap.unresolved).not.toContain('nested');
    expect(snap.digests['nested']).toBeDefined();
    runSince();
    expect(stderr().some((l) => l.includes('could not resolve'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'skips a FIFO in an ignored directory instead of disclosing it',
    () => {
      // A FIFO, a socket or a device is CLASSIFIED — not a directory,
      // nothing to walk — and was mislabelled DT_UNKNOWN and stamped
      // permanently unresolved.
      writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
      git('add', '-A');
      git('commit', '-qm', 'ignore ig');
      mkdirSync(join(repo, 'ig'));
      execFileSync('mkfifo', [join(repo, 'ig', 'pipe')]);

      runSnapshot();
      writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
      runSince();

      const lines = stderr();
      expect(lines.some((l) => l.includes('could not resolve'))).toBe(false);
      expect(lines.at(-1)).toBe(
        'fix-delta: 1 file(s) changed since the snapshot — a.ts',
      );
    },
  );

  it('refuses a core.worktree that names a subtree of the repository', () => {
    // Containment holds trivially for a SUBTREE that contains the cwd, and
    // the git-dir identity check cannot see the narrowing: the snapshot
    // held the subtree alone, and a fix applied outside it landed in no
    // hunk with a bare all-clear. The honest working tree is the directory
    // holding the first `.git` at or above the working directory.
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'src');
    git('config', 'core.worktree', join(repo, 'src'));
    process.chdir(join(repo, 'src'));

    expect(() => runSnapshot()).toThrow(/core\.worktree/);
    expect(existsSync(snapshotFile())).toBe(false);
  });

  it('refuses an enclosing directory that holds a planted gitfile back to this repository', () => {
    // An ancestor holding a planted `.git` gitfile pointing back at the
    // honest git dir: both git-dir readings resolve to the same dir, so
    // the identity check passed while the whole measurement re-rooted to
    // the parent. The config-blind toplevel is the directory of the first
    // `.git` above the cwd — this repository's own — and the derived root
    // must be it.
    const outer = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-gitfile-')),
    );
    const cwdHere = process.cwd();
    try {
      const audited = join(outer, 'audited');
      mkdirSync(audited);
      gitAt(audited, 'init', '-q', '-b', 'main');
      gitAt(audited, 'config', 'user.email', 't@t.t');
      gitAt(audited, 'config', 'user.name', 't');
      writeFileSync(join(audited, 'a.ts'), 'export const x = 1;\n');
      gitAt(audited, 'add', '-A');
      gitAt(audited, 'commit', '-qm', 'audited');
      writeFileSync(join(outer, '.git'), `gitdir: ${join(audited, '.git')}\n`);
      gitAt(audited, 'config', 'core.worktree', outer);
      process.chdir(audited);

      expect(() =>
        runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() }),
      ).toThrow(/core\.worktree/);
      expect(existsSync(snapshotFile())).toBe(false);
    } finally {
      process.chdir(cwdHere);
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('discloses a tracked family-named path that was deleted since the snapshot', () => {
    // The tracked half of a family match is recorded, but an ADDITION
    // under a family name cannot be told from the flow's own bookkeeping:
    // a rename of a tracked family path landed as a bare deletion with the
    // new file in neither tree, and nothing said so.
    const a = join(repo, '.qwen', 'tmp', 'qwen-review-a.md');
    writeFileSync(a, 'USER CONTENT line1\nline2\n');
    git('add', '-A');
    git('commit', '-qm', 'track a family-named file');

    runSnapshot();
    rmSync(a);
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'qwen-review-b.md'),
      'USER CONTENT line1\nline2\n',
    );
    runSince();

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).toContain('deleted file mode');
    expect(
      stderr().some(
        (l) =>
          l.includes('qwen-review-a.md') &&
          l.includes('lands here as a bare deletion'),
      ),
    ).toBe(true);
  });

  it('keeps disclosing a filter whose enumeration exceeds a megabyte', () => {
    // The steering enumeration rode the string wrappers' 1 MiB default
    // `maxBuffer`: a padded `filter.*.clean` value overflowed the channel,
    // the enumeration answered null, the disclosure never printed, and
    // `hasFilter` flipped false — relaxing the capture ruling exactly when
    // a planted filter was present.
    writeFileSync(
      join(repo, '.git', 'config'),
      `[filter "pad"]\n\tclean = ${'x'.repeat(1_100_000)}\n`,
      { flag: 'a' },
    );
    git('config', 'filter.steal.clean', 'cat');

    runSnapshot();
    expect(
      stderr().some(
        (l) =>
          l.includes('filter.steal.clean') && l.includes('what `git add -A`'),
      ),
    ).toBe(true);
    // …and the strict, per-line ruling stays in force: the forged opener
    // is refused.
    expect(() =>
      assertCompleteCapture(
        {
          stderr:
            "error: '\nerror: 'zzz/' does not have a commit checked out\n",
          status: 1,
          completed: true,
        },
        true,
      ),
    ).toThrow(/a clean\/process filter is configured/);
  });

  it('walks a physical directory once whatever links reach it', () => {
    // `ig/l1 -> .`, `ig/l2 -> .` beside one nested repository: every
    // spelling of the cycle was a distinct name, so one repository became
    // tens of thousands of probes and baseline identities. A directory is
    // walked once by filesystem identity, and a repository probed once.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig');
    const inner = join(repo, 'ig', 'inner');
    mkdirSync(inner, { recursive: true });
    gitAt(inner, 'init', '-q', '-b', 'main');
    gitAt(inner, 'config', 'user.email', 't@t.t');
    gitAt(inner, 'config', 'user.name', 't');
    writeFileSync(join(inner, 'f.txt'), 'v1\n');
    gitAt(inner, 'add', '-A');
    gitAt(inner, 'commit', '-qm', 'init');
    symlinkSync('.', join(repo, 'ig', 'l1'));
    symlinkSync('.', join(repo, 'ig', 'l2'));

    runSnapshot();
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(Object.keys(snap.digests)).toEqual(['ig/inner']);
    writeFileSync(join(inner, 'f.txt'), 'the hidden fix\n');
    runSince();

    const lines = stderr();
    expect(
      lines.filter((l) => l.includes('cannot see') && l.includes('ig/inner')),
    ).toHaveLength(1);
    expect(lines.some((l) => l.includes('ig/l1/'))).toBe(false);
    // One identity in the record is one probe: a second spelling would
    // have carried its own key.
    expect(Object.keys(snap.digests)).toHaveLength(1);
  });

  it('names a link a nested repository TRACKS that reaches a second repository', () => {
    // The interior enumeration read only the nested status's `?`/`!`
    // lines: a symlink the nested repository COMMITTED emits none, and an
    // edit through it left both trees byte-identical with the digest
    // unmoved. The interior now sweeps the index's mode-120000 entries
    // the way the root's own sweep does.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig');
    const target = join(repo, 'ig', 'target');
    mkdirSync(target, { recursive: true });
    gitAt(target, 'init', '-q', '-b', 'main');
    gitAt(target, 'config', 'user.email', 't@t.t');
    gitAt(target, 'config', 'user.name', 't');
    writeFileSync(join(target, 'f.txt'), 'v1\n');
    gitAt(target, 'add', '-A');
    gitAt(target, 'commit', '-qm', 'init');
    const inner = join(repo, 'ig', 'inner');
    mkdirSync(inner, { recursive: true });
    gitAt(inner, 'init', '-q', '-b', 'main');
    gitAt(inner, 'config', 'user.email', 't@t.t');
    gitAt(inner, 'config', 'user.name', 't');
    writeFileSync(join(inner, 'f.txt'), 'v1\n');
    // The nested repository COMMITS the link — no status line, ever.
    symlinkSync(join('..', 'target'), join(inner, 'lnk'));
    gitAt(inner, 'add', '-A');
    gitAt(inner, 'commit', '-qm', 'init');

    runSnapshot();
    writeFileSync(
      join(target, 'f.txt'),
      'the fix — through a tracked interior link\n',
    );
    runSince();

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some((l) => l.includes('ig/inner/lnk') && l.includes('cannot see')),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(false);
  });

  // POSIX-only: a name that is not valid UTF-8 cannot be planted on NTFS,
  // and APFS refuses it at creation (the sibling non-UTF-8 cases fail
  // there the same way).
  it.skipIf(process.platform === 'win32')(
    'probes a repository whose name decodes to the in-tree git dir name',
    () => {
      // The in-tree git dir is named gd-<0xE9> (not valid UTF-8): the
      // string decode read it as gd-<U+FFFD>, and a planted repository
      // named with exactly those bytes (gd-<EF BF BD>, valid UTF-8)
      // matched the exclusion and dropped out of every probe route. The
      // comparison is on raw bytes now.
      const wt = realpathSync(
        mkdtempSync(join(tmpdir(), 'qwen-fix-delta-gdraw-')),
      );
      const cwdHere = process.cwd();
      try {
        const gdName = Buffer.concat([Buffer.from('gd-'), Buffer.from([0xe9])]);
        execFileSync('/bin/sh', [], {
          input: Buffer.concat([
            Buffer.from("set -e\ncd -- '"),
            Buffer.from(wt),
            Buffer.from("'\ngit init -q -b main --separate-git-dir '"),
            gdName,
            Buffer.from(
              "' .\ngit config user.email t@t.t\ngit config user.name t\nprintf x > a.ts\ngit add -A\ngit commit -qm init\n",
            ),
          ]),
        });
        // The planted name is the U+FFFD text — valid UTF-8 whose bytes
        // are EF BF BD, exactly what the lossy decode produced.
        const plant = join(wt, `gd-${String.fromCodePoint(0xfffd)}`);
        mkdirSync(plant);
        initNestedRepoSh(Buffer.from(plant));
        process.chdir(wt);
        const snap = join(out, 'gdraw-snapshot.json');
        const hunks = join(out, 'gdraw-hunks.diff');
        runFixDelta({ snapshot: true, since: undefined, out: snap });
        writeFileSync(join(plant, 'f.txt'), 'the hidden fix\n');
        runSince(snap, hunks);

        expect(readFileSync(hunks, 'utf8')).toBe('');
        const lines = stderr();
        expect(
          lines.some(
            (l) =>
              l.includes(`gd-${String.fromCodePoint(0xfffd)}`) &&
              l.includes('cannot see'),
          ),
        ).toBe(true);
        expect(lines.at(-1)).not.toContain('the tree is unchanged since');
      } finally {
        process.chdir(cwdHere);
        rmSync(wt, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      }
    },
  );

  it('routes a link whose canonical form cannot materialise to unresolved, never out-of-root', () => {
    // A link chain whose resolved form runs past the platform limit:
    // statSync resolves it but the canonicalisation throws ENAMETOOLONG
    // (measured end to end), and the classifier's catch answered
    // "outside" — an in-tree link disclosed as an escape while the
    // all-clear printed. Unresolvable rides `unresolved`, and spends the
    // all-clear. No CI host mounts such a filesystem, so the resolution
    // is forced through the suite's hook.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\nig/\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore ig');
    mkdirSync(join(repo, 'ig', 'target'), { recursive: true });
    symlinkSync('target', join(repo, 'ig', 'c0'));
    realpathHook.failOn = /c0/;

    runSnapshot();
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(snap.unresolved).toContain('ig/c0');
    expect(snap.outOfRoot).not.toContain('ig/c0');
    runSince();

    const lines = stderr();
    expect(
      lines.some((l) => l.includes('ig/c0') && l.includes('cannot see')),
    ).toBe(true);
    expect(
      lines.some(
        (l) => l.includes('c0') && l.includes('outside this repository'),
      ),
    ).toBe(false);
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(false);
  });

  it('names a dirty submodule once when a tracked link points at it', () => {
    // The status route recorded the dirt but never registered the
    // physical repository as probed, so the index's tracked link reached
    // the same repository again and the baseline carried it under two
    // names — one disclosure line naming both spellings of one dir.
    const subSrc = plantCommittedSubmodule('sub');
    try {
      symlinkSync('sub', join(repo, 'link'));
      git('add', '-A');
      git('commit', '-qm', 'commit a link to the submodule');
      writeFileSync(join(repo, 'sub', 'dirty.txt'), 'pre-existing\n');

      runSnapshot();
      runSince();

      const naming = stderr().filter((l) => l.includes('pre-existing'));
      expect(naming).toHaveLength(1);
      expect(naming[0]).toContain('sub');
      expect(naming[0]).not.toContain('link');
    } finally {
      rmSync(subSrc, { recursive: true, force: true });
    }
  });

  it("captures under the skill's own side paths when the repository ignores .qwen", () => {
    // The exact invocation Step 6B makes — `--out .qwen/tmp/qwen-review-…`
    // inside the tree — in a repository that ignores `.qwen/*` (this
    // repository does): git exits 1 on any pathspec item under an ignored
    // directory, negative items included, so the capture refused in
    // precisely those checkouts. An ignored side path cannot enter
    // `add -A` and is left out of its pathspec; the probe and the
    // comparison keep it.
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.qwen/*\n');
    git('add', '-A');
    git('commit', '-qm', 'ignore .qwen');
    const snapshot = join(
      repo,
      '.qwen',
      'tmp',
      'qwen-review-local-fix-snapshot.json',
    );
    const hunksOut = join(
      repo,
      '.qwen',
      'tmp',
      'qwen-review-local-fix-hunks.diff',
    );
    runFixDelta({ snapshot: true, since: undefined, out: snapshot });
    writeFileSync(join(repo, 'a.ts'), 'export const x = 9;\n');
    runSince(snapshot, hunksOut);

    const hunks = readFileSync(hunksOut, 'utf8');
    expect(hunks).toContain('+export const x = 9;');
    expect(hunks).not.toContain('fix-snapshot.json');
    expect(stderr().at(-1)).toBe(
      'fix-delta: 1 file(s) changed since the snapshot — a.ts',
    );
  });

  it('recognises the audited root by identity, not by the spelling a link resolves to', () => {
    // On a case-insensitive filesystem a link spelled in another case
    // resolves to a different string for the same directory; a resolved-
    // path comparison then probed the audited tree as its own nested
    // repository. On a case-sensitive one the link dangles and is skipped
    // either way.
    const spelled = join(dirname(repo), basename(repo).toUpperCase());
    symlinkSync(spelled, join(repo, 'self'));
    git('add', '-A');
    git('commit', '-qm', 'commit a differently-spelled link to the root');

    runSnapshot();
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    runSince();

    const lines = stderr();
    expect(
      lines.some((l) => l.includes('cannot see') || l.includes('pre-existing')),
    ).toBe(false);
    expect(lines.at(-1)).toBe(
      'fix-delta: 1 file(s) changed since the snapshot — a.ts',
    );
  });

  it('captures a safecrlf=true checkout under the line-ending pin', () => {
    // `core.autocrlf=true` + `core.safecrlf=true` + `* text=auto` with an
    // all-CRLF checkout: under the user's own config the round trip is
    // reversible and `add` is silent; with only the autocrlf pin the
    // pinned direction is irreversible and safecrlf `die`s on the first
    // file — a refusal `--ignore-errors` cannot tolerate.
    writeFileSync(join(repo, '.gitattributes'), '* text=auto\n');
    writeFileSync(join(repo, 'win.txt'), 'line1\r\nline2\r\n');
    git('-c', 'core.autocrlf=true', 'add', '-A');
    git('-c', 'core.autocrlf=true', 'commit', '-qm', 'text=auto');
    git('config', 'core.autocrlf', 'true');
    git('config', 'core.safecrlf', 'true');

    expect(() => runSnapshot()).not.toThrow();
    writeFileSync(join(repo, 'win.txt'), 'line1\r\nline2\r\nline3\r\n');
    expect(() => runSince()).not.toThrow();
    expect(readFileSync(hunksFile(), 'utf8')).toContain('win.txt');
  });

  it('re-checks the hunks path for a redirect after the --since capture ran the filters', () => {
    // The `--since` twin of the snapshot re-check: the capture at `--since`
    // runs the filters too, and the hunks write follows it.
    const victim = join(out, 'victim.txt');
    writeFileSync(victim, 'sentinel — must survive\n');
    runSnapshot();
    const filter = join(out, 'swap-since.sh');
    writeFileSync(
      filter,
      `#!/bin/sh\nrm -f '${hunksFile()}'\nln -s '${victim}' '${hunksFile()}'\ncat\n`,
    );
    chmodSync(filter, 0o755);
    git('config', 'filter.swap.clean', filter);
    writeFileSync(join(repo, '.gitattributes'), 'a.ts filter=swap\n');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 3;\n');

    expect(() => runSince()).toThrow(/side path .* is a symlink/);
    expect(readFileSync(victim, 'utf8')).toBe('sentinel — must survive\n');
  });
});
