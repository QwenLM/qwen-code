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
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
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
    return entries.map((e) => ({
      name: (e as { name: unknown }).name,
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
    }));
  }) as typeof actual.readdirSync;
  return { ...actual, default: { ...actual, readdirSync }, readdirSync };
});
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mock } from 'vitest';
import yargs from 'yargs';
import {
  IGNORED_WALK_BUDGET,
  assertCompleteCapture,
  excludePathspec,
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
      expect(stderr().at(-1)).toBe(
        'fix-delta: 1 file(s) changed since the snapshot — sub',
      );
      expect(stderr().some((l) => l.includes('cannot see'))).toBe(false);

      // The same shape with the move already recorded — snapshot taken after
      // the commit inside: nothing applied, nothing invisible.
      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshot, out: hunksOut });
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshot, out: hunksOut });

    const hunks = readFileSync(hunksOut, 'utf8');
    expect(hunks).toContain('+in — the fix');
    // Out-of-cone tracked entries drop identically from both trees: no
    // phantom deletion.
    expect(hunks).not.toContain('outcone/out.ts');
  });

  it('writes an empty diff and says so when nothing changed', () => {
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snap, out: hunks });

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
      runFixDelta({ snapshot: false, since: snap, out: hunks });

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
      // The pathspec itself: git's separator is the only one it may carry.
      expect(excludePathspec(wt)).toContain(':(exclude,literal)sub/gd');
      for (const spec of excludePathspec(wt)) {
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
      runFixDelta({ snapshot: false, since: snap, out: hunks });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'review-pr-1', 'stray.txt'),
      'y\n',
    );
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
    const lines = stderr();
    expect(lines.some((l) => l.includes('review-pr-1'))).toBe(false);
    expect(lines.at(-1)).toContain('the tree is unchanged since the snapshot');
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    expect(() =>
      runFixDelta({ snapshot: false, since: linkPath, out: hunksFile() }),
    ).toThrow(/side path .* is a symlink; refusing to write through/);
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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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

  it('names a nested repo whose only uncommitted content is self-ignored', () => {
    // The inner probe runs `--ignored=matching`: a repository whose only
    // uncommitted content matches its OWN ignore rules emits nothing to a
    // plain status, and an edit inside would classify clean in both states.
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some((l) => /\bemb\b/.test(l) && l.includes('cannot see')),
    ).toBe(true);
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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
        runFixDelta({
          snapshot: false,
          since: snapshotFile(),
          out: hunksFile(),
        });
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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
        expect(() =>
          runFixDelta({
            snapshot: false,
            since: snapshotFile(),
            out: hunksFile(),
          }),
        ).toThrow(/could not capture the whole tree/);
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
        expect(() =>
          runFixDelta({
            snapshot: false,
            since: snapshotFile(),
            out: hunksFile(),
          }),
        ).toThrow(/could not capture the whole tree/);
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
        runFixDelta({
          snapshot: false,
          since: snapshotFile(),
          out: hunksFile(),
        });
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
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
    for (let i = 0; i <= IGNORED_WALK_BUDGET; i++) {
      writeFileSync(join(big, `e${i}`), '');
    }
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(snap.dirtySubmodules).not.toContain('big');
    writeFileSync(join(inner, 'f.txt'), 'the fix — uncommitted inside\n');
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
    const lines = stderr();
    expect(
      lines.some((l) => /\bbig\b/.test(l) && l.includes('cannot see')),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(false);
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
    writeFileSync(join(repo, 'a.ts'), 'export const x = 7;\n');
    await parse(['fix-delta', '--since', snapshotFile(), '--out', hunksFile()]);
    expect(readFileSync(hunksFile(), 'utf8')).toContain('+export const x = 7;');
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
    expect(() =>
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() }),
    ).toThrow(/taken in .*elsewhere, but this is/);
    writeFileSync(
      snapshotFile(),
      JSON.stringify({ ...snap, tree: 'f'.repeat(40) }),
    );
    expect(() =>
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() }),
    ).toThrow(/is not in this repository/);
    writeFileSync(snapshotFile(), '{"tree": 12}');
    expect(() =>
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() }),
    ).toThrow(/not a fix-delta snapshot/);
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
    runFixDelta({ snapshot: false, since: snapIn, out: hunksIn });

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
        runFixDelta({
          snapshot: false,
          since: snapshotFile(),
          out: hunksFile(),
        });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    const target = join(repo, '.qwen', 'tmp', 'review-pr-1');
    mkdirSync(target, { recursive: true });
    gitAt(target, 'init', '-q', '-b', 'main');
    gitAt(target, 'config', 'user.email', 't@t.t');
    gitAt(target, 'config', 'user.name', 't');
    writeFileSync(join(target, 'f.txt'), 'inside\n');
    gitAt(target, 'add', '-A');
    gitAt(target, 'commit', '-qm', 'init');
    symlinkSync(target, join(repo, 'ig', 'x'));

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(target, 'f.txt'), 'dirtied between the states\n');
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    mkdirSync(target, { recursive: true });
    gitAt(target, 'init', '-q', '-b', 'main');
    gitAt(target, 'config', 'user.email', 't@t.t');
    gitAt(target, 'config', 'user.name', 't');
    writeFileSync(join(target, 'f.txt'), 'inside\n');
    gitAt(target, 'add', '-A');
    gitAt(target, 'commit', '-qm', 'init');
    symlinkSync(target, join(repo, 'x'));

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(target, 'f.txt'), 'dirtied between the states\n');
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(lines.some((l) => l.includes('qwen-review-local'))).toBe(false);
    expect(lines.at(-1)).toContain('the tree is unchanged since the snapshot');
  });

  it('names a repository a symlink target merely CONTAINS', () => {
    // `add -A` records the link, never what is behind it, so a repository
    // one level down the target is exactly as invisible as one the link
    // points straight at. The branch returned silently when the target
    // carried no `.git` of its own — neither probed nor disclosed.
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

    expect(readFileSync(hunksFile(), 'utf8')).toBe('');
    const lines = stderr();
    expect(
      lines.some(
        (l) => l.includes('cannot see') && l.includes('link/deep/repo'),
      ),
    ).toBe(true);
    expect(lines.at(-1)).not.toContain('the tree is unchanged since');
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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
        runFixDelta({ snapshot: false, since: snap, out: hunks });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
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
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

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
});
