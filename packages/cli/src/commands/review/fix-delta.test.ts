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
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mock } from 'vitest';
import yargs from 'yargs';
import {
  FIX_DELTA_EXCLUDES,
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
  });

  afterEach(() => {
    process.chdir(cwdBefore);
    rmSync(repo, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
    gitIsolation.dispose();
    tmpdirOverride.value = undefined;
  });

  it('diffs exactly the edits made between the snapshot and now — on top of the reviewed change', () => {
    // The local review's own uncommitted change: present at snapshot time, so
    // it must NOT be in the hunks — the audit is about the fix, not the diff.
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    const snap = JSON.parse(
      readFileSync(snapshotFile(), 'utf8'),
    ) as FixSnapshot;
    expect(snap.root).toBe(repo);
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
    // byte-identical. The command must name that blind spot, not print
    // "nothing was applied" and steer the orchestrator at a correct ledger.
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
      expect(last).not.toContain('nothing was applied');
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
      expect(last).not.toContain('nothing was applied');
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
    // "nothing was applied".
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
      expect(lines.some((l) => l.includes('nothing was applied'))).toBe(false);
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
      expect(lines.some((l) => l.includes('nothing was applied'))).toBe(false);
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
      expect(lines.some((l) => l.includes('nothing was applied'))).toBe(false);
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
    expect(lines.some((l) => l.includes('nothing was applied'))).toBe(false);
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
    expect(lines.some((l) => l.includes('nothing was applied'))).toBe(false);
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

    // (a) No edits: no false pre-existing note beside the all-clear.
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
    expect(stderr().some((l) => l.includes('nothing was applied'))).toBe(true);
    expect(stderr().some((l) => l.includes('pre-existing'))).toBe(false);

    // (b) A fix editing inside the nested repo, uncommitted there.
    (writeStderrLine as unknown as Mock).mockClear();
    writeFileSync(join(emb, 'f.txt'), 'the fix — uncommitted inside\n');
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });
    const lines = stderr();
    expect(
      lines.some((l) => /\bemb\b/.test(l) && l.includes('cannot see')),
    ).toBe(true);
    expect(lines.some((l) => l.includes('nothing was applied'))).toBe(false);
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
      expect(last).not.toContain('nothing was applied');
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
      expect(lines.some((l) => l.includes('nothing was applied'))).toBe(false);
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
      expect(lines.some((l) => l.includes('nothing was applied'))).toBe(false);
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
    // files under .qwen/tmp, written between the two states.
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
    for (const dir of FIX_DELTA_EXCLUDES) {
      mkdirSync(join(repo, dir), { recursive: true });
      writeFileSync(join(repo, dir, 'ledger.json'), '[]\n');
    }
    // …and a review run from a subdirectory writes them under that
    // subdirectory: the exclusion matches at any depth.
    mkdirSync(join(repo, 'sub', '.qwen', 'tmp'), { recursive: true });
    writeFileSync(join(repo, 'sub', '.qwen', 'tmp', 'nested.json'), '{}\n');
    writeFileSync(join(repo, '.qwen', 'settings.json'), '{}\n');
    writeFileSync(join(repo, 'a.ts'), 'export const x = 9;\n');
    runFixDelta({ snapshot: false, since: snapshot, out: hunksOut });
    const hunks = readFileSync(hunksOut, 'utf8');
    expect(hunks).toContain('a/a.ts');
    expect(hunks).not.toContain('ledger.json');
    expect(hunks).not.toContain('nested.json');
    expect(hunks).not.toContain('fix-snapshot.json');
    // Only the review-owned directories are excluded — a fix that touched a
    // real `.qwen/` file is still an edit.
    expect(hunks).toContain('a/.qwen/settings.json');
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
    expect(snap.root).toBe(repo);
    writeFileSync(join(repo, 'a.ts'), 'export const x = 9;\n');
    writeFileSync(join(subdir, 'b.ts'), 'export const b = 1;\n');
    // A review run from the subdirectory writes its side files there.
    mkdirSync(join(subdir, '.qwen', 'tmp'), { recursive: true });
    writeFileSync(join(subdir, '.qwen', 'tmp', 'side.json'), '{}\n');
    runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

    const hunks = readFileSync(hunksFile(), 'utf8');
    expect(hunks).toContain('+export const x = 9;');
    expect(hunks).toContain('diff --git a/subdir/b.ts b/subdir/b.ts');
    expect(hunks).not.toContain('side.json');
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
      gitAt(wt, 'add', '-A');
      gitAt(wt, 'commit', '-qm', 'head');
      process.chdir(wt);
      const snap = join(out, 'sepgd-snapshot.json');
      const hunks = join(out, 'sepgd-hunks.diff');
      runFixDelta({ snapshot: true, since: undefined, out: snap });
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
        expect(snap.root).toBe(repo);
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
});
