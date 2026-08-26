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
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const snapshotFile = () => join(out, 'fix-snapshot.json');
  const hunksFile = () => join(out, 'fix-hunks.diff');
  const stderr = () =>
    (writeStderrLine as unknown as Mock).mock.calls.map((c) => c[0] as string);

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

  it('names the submodule blind spot instead of claiming nothing was applied', () => {
    // A fix that lands inside a submodule without being committed there moves
    // no gitlink — the superproject tree, which is all a snapshot records, is
    // byte-identical. The command must name that blind spot, not print
    // "nothing was applied" and steer the orchestrator at a correct ledger.
    const subSrc = realpathSync(
      mkdtempSync(join(tmpdir(), 'qwen-fix-delta-subsrc-')),
    );
    const run = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    try {
      run(subSrc, 'init', '-q', '-b', 'main');
      run(subSrc, 'config', 'user.email', 't@t.t');
      run(subSrc, 'config', 'user.name', 't');
      writeFileSync(join(subSrc, 'f.txt'), 'before\n');
      run(subSrc, 'add', '-A');
      run(subSrc, 'commit', '-qm', 'init');
      git(
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-q',
        subSrc,
        'sub',
      );
      run(join(repo, 'sub'), 'config', 'user.email', 't@t.t');
      run(join(repo, 'sub'), 'config', 'user.name', 't');
      git('add', '-A');
      git('commit', '-qm', 'add submodule');

      runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
      // The fix lands inside the submodule, uncommitted there.
      writeFileSync(join(repo, 'sub', 'f.txt'), 'after — the fix\n');
      runFixDelta({ snapshot: false, since: snapshotFile(), out: hunksFile() });

      expect(readFileSync(hunksFile(), 'utf8')).toBe('');
      const last = stderr().at(-1) ?? '';
      expect(last).toContain('submodule');
      expect(last).toContain('sub');
      expect(last).not.toContain('nothing was applied');
      expect(last).not.toContain('the tree is unchanged since the snapshot');
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
    writeFileSync(join(repo, 'untracked.ts'), 'x\n');
    const statusBefore = git('status', '--porcelain', '--untracked-files=all');
    const stashBefore = git('stash', 'list');
    const indexBefore = git('write-tree');

    runFixDelta({ snapshot: true, since: undefined, out: snapshotFile() });
    writeFileSync(join(repo, 'untracked.ts'), 'y\n');
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
