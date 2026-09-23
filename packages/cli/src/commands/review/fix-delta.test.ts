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
// The seed witness below is a property of the ARGUMENTS the capture hands
// git, which no fixture can observe from outside a single run — record the
// execFileSync calls instead, delegating every call to the real thing.
const execRecord = vi.hoisted(() => ({
  calls: [] as Array<readonly string[]>,
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFileSync = ((...call: Parameters<typeof actual.execFileSync>) => {
    execRecord.calls.push((call[1] as readonly string[] | undefined) ?? []);
    return actual.execFileSync(...call);
  }) as typeof actual.execFileSync;
  return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});

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
  FIX_DELTA_SCOPE,
  fixDeltaCommand,
  runFixDelta,
  type FixSnapshot,
} from './fix-delta.js';
import { isolateHostGitConfig } from './lib/test-utils.js';

describe('fix-delta', () => {
  let repo: string;
  // The command's own outputs live OUTSIDE the fixture repo, so the
  // index/stash invariance test measures the command and not its files;
  // the side-file tests plant review side files in the repo itself.
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
  const runSnapshot = (outFile = snapshotFile()) =>
    runFixDelta({ snapshot: true, out: outFile });
  const runSince = (since = snapshotFile(), outFile = hunksFile()) =>
    runFixDelta({ snapshot: false, since, out: outFile });
  const hunks = () => readFileSync(hunksFile(), 'utf8');
  const record = (file = snapshotFile()) =>
    JSON.parse(readFileSync(file, 'utf8')) as FixSnapshot;

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
    execRecord.calls = [];
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
    writeFileSync(join(repo, 'reviewed-new.ts'), 'export const r = 1;\n');
    runSnapshot();

    writeFileSync(join(repo, 'a.ts'), 'export const x = 3;\n');
    writeFileSync(join(repo, 'a.test.ts'), 'it("pins x", () => {});\n');
    rmSync(join(repo, 'gone.ts'));
    runSince();

    const diff = hunks();
    expect(diff).toContain('-export const x = 2;');
    expect(diff).toContain('+export const x = 3;');
    expect(diff).not.toContain('export const x = 1;');
    expect(diff).toContain('diff --git a/a.test.ts b/a.test.ts');
    expect(diff).toContain('diff --git a/gone.ts b/gone.ts');
    expect(diff).toContain('deleted file mode');
    expect(diff).not.toContain('reviewed-new.ts');
    expect(stderr()).toContain(
      'fix-delta: 3 file(s) changed since the snapshot — a.test.ts, a.ts, gone.ts',
    );
  });

  it("never writes the user's index or the stash", () => {
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    git('add', 'a.ts');
    writeFileSync(join(repo, 'unstaged.ts'), 'u\n');
    const indexBefore = readFileSync(join(repo, '.git', 'index'));
    // An exported GIT_INDEX_FILE is what a hook or wrapper can leave in
    // the environment; the capture must not follow it into a real index.
    const planted = join(out, 'planted-index');
    process.env['GIT_INDEX_FILE'] = planted;
    try {
      runSnapshot();
      writeFileSync(join(repo, 'a.ts'), 'export const x = 3;\n');
      runSince();
    } finally {
      delete process.env['GIT_INDEX_FILE'];
    }
    expect(readFileSync(join(repo, '.git', 'index'))).toEqual(indexBefore);
    expect(() => readFileSync(planted)).toThrow();
    expect(git('diff', '--cached', '--name-only')).toBe('a.ts');
    expect(git('stash', 'list')).toBe('');
    expect(hunks()).toContain('+export const x = 3;');
  });

  it("leaves the review's own side files out at any depth — directory contents included — and keeps every other .qwen path", () => {
    mkdirSync(join(repo, 'pkg', '.qwen', 'tmp'), { recursive: true });
    writeFileSync(join(repo, '.qwen', 'tmp', 'user-notes.md'), 'v1\n');
    runSnapshot();

    // Everything the flow writes between the two moments.
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'qwen-review-local-plan.json'),
      '{}\n',
    );
    mkdirSync(join(repo, '.qwen', 'tmp', 'qwen-review-local-plan-prompts'));
    writeFileSync(
      join(
        repo,
        '.qwen',
        'tmp',
        'qwen-review-local-plan-prompts',
        'chunk-8.md',
      ),
      'brief\n',
    );
    writeFileSync(
      join(repo, '.qwen', 'tmp', 'file-review-a-plan.json'),
      '{}\n',
    );
    mkdirSync(join(repo, '.qwen', 'tmp', 'review-pr-12-wt'));
    writeFileSync(join(repo, '.qwen', 'tmp', 'review-pr-12-wt', 'x'), 'x\n');
    writeFileSync(
      join(repo, 'pkg', '.qwen', 'tmp', 'qwen-review-pkg-findings.json'),
      '[]\n',
    );
    // …and user content that only looks close to a family name.
    writeFileSync(join(repo, '.qwen', 'tmp', 'user-notes.md'), 'v2\n');
    writeFileSync(join(repo, '.qwen', 'tmp', 'qwen-reviewer.md'), 'mine\n');
    runSince();

    const diff = hunks();
    expect(diff).not.toContain('qwen-review-local');
    expect(diff).not.toContain('chunk-8.md');
    expect(diff).not.toContain('file-review-');
    expect(diff).not.toContain('review-pr-12');
    expect(diff).not.toContain('qwen-review-pkg');
    expect(diff).toContain('diff --git a/.qwen/tmp/user-notes.md');
    expect(diff).toContain('+v2');
    expect(diff).toContain('diff --git a/.qwen/tmp/qwen-reviewer.md');
  });

  it('leaves its own --out and --since files out when they sit in the repository', () => {
    const inRepoSnapshot = join(repo, 'snap.json');
    const inRepoHunks = join(repo, 'hunks.diff');
    runSnapshot(inRepoSnapshot);
    writeFileSync(join(repo, 'a.ts'), 'export const x = 3;\n');
    runFixDelta({ snapshot: false, since: inRepoSnapshot, out: inRepoHunks });
    const diff = readFileSync(inRepoHunks, 'utf8');
    expect(diff).toContain('+export const x = 3;');
    expect(diff).not.toContain('snap.json');
    expect(diff).not.toContain('hunks.diff');
  });

  it('writes an empty hunks file on an unchanged tree, says so, and states the scope', () => {
    writeFileSync(join(repo, 'a.ts'), 'export const x = 2;\n');
    runSnapshot();
    runSince();
    expect(hunks()).toBe('');
    const lines = stderr();
    expect(
      lines.some((l) => l.includes('the tree is unchanged since the snapshot')),
    ).toBe(true);
    expect(lines).toContain(FIX_DELTA_SCOPE);
    expect(lines.some((l) => l.includes('HEAD moved'))).toBe(false);
  });

  it('states the scope beside a non-empty result too, naming what it does not cover', () => {
    runSnapshot();
    writeFileSync(join(repo, 'a.ts'), 'export const x = 3;\n');
    runSince();
    const lines = stderr();
    expect(lines[lines.length - 1]).toBe(FIX_DELTA_SCOPE);
    expect(FIX_DELTA_SCOPE).toMatch(/submodule or a nested repository/);
    expect(FIX_DELTA_SCOPE).toMatch(/gitignored file/);
  });

  it('an edit inside a nested repository is outside the scope: no hunk, and the scope line says why', () => {
    const nested = join(repo, 'vendor');
    mkdirSync(nested);
    gitAt(nested, 'init', '-q', '-b', 'main');
    gitAt(nested, 'config', 'user.email', 't@t.t');
    gitAt(nested, 'config', 'user.name', 't');
    writeFileSync(join(nested, 'f.txt'), 'before\n');
    gitAt(nested, 'add', '-A');
    gitAt(nested, 'commit', '-qm', 'init');
    runSnapshot();
    writeFileSync(join(nested, 'f.txt'), 'after\n');
    runSince();
    expect(hunks()).toBe('');
    expect(stderr()).toContain(FIX_DELTA_SCOPE);
  });

  it('records HEAD once and seeds the capture from that same commit', () => {
    runSnapshot();
    const snap = record();
    expect(snap.head).toBe(git('rev-parse', 'HEAD'));
    const headReads = execRecord.calls.filter(
      (args) => args.includes('rev-parse') && args.includes('HEAD^{commit}'),
    );
    expect(headReads).toHaveLength(1);
    const seeds = execRecord.calls.filter((args) => args.includes('read-tree'));
    expect(seeds).toHaveLength(1);
    // The recorded sha, never the symbolic `HEAD`: a commit landing after
    // the read would otherwise seed the tree from a different moment than
    // the record names.
    expect(seeds[0][seeds[0].length - 1]).toBe(snap.head);
  });

  it('seeds the second capture from the snapshot tree, so a force-added ignored file the fix edits stays in the hunks', () => {
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules', 'patched.js'), 'v1\n');
    git('add', '-f', 'node_modules/patched.js');
    git('commit', '-qm', 'vendor a patched file');
    runSnapshot();
    writeFileSync(join(repo, 'node_modules', 'patched.js'), 'v2\n');
    runSince();
    expect(hunks()).toContain('diff --git a/node_modules/patched.js');
    expect(hunks()).toContain('+v2');
  });

  it('never seeds the second capture from HEAD now: an ignored file untracked by a commit in the window is no phantom deletion', () => {
    mkdirSync(join(repo, 'node_modules'));
    writeFileSync(join(repo, 'node_modules', 'patched.js'), 'v1\n');
    git('add', '-f', 'node_modules/patched.js');
    git('commit', '-qm', 'vendor a patched file');
    runSnapshot();
    // Untracked by commit, still on disk and unchanged: nothing was edited.
    git('rm', '-q', '--cached', 'node_modules/patched.js');
    git('commit', '-qm', 'stop tracking it');
    runSince();
    expect(hunks()).toBe('');
    expect(
      stderr().some((l) => l.includes('HEAD moved between the two moments')),
    ).toBe(true);
  });

  it('discloses a commit made between the two moments, and keeps diffing against the snapshot tree', () => {
    runSnapshot();
    const before = record().head as string;
    writeFileSync(join(repo, 'a.ts'), 'export const x = 3;\n');
    git('commit', '-qam', 'the fixer committed');
    runSince();
    // The committed edit is still on disk relative to the snapshot tree.
    expect(hunks()).toContain('+export const x = 3;');
    const moved = stderr().find((l) =>
      l.includes('HEAD moved between the two moments'),
    );
    expect(moved).toBeDefined();
    expect(moved).toContain(before.slice(0, 12));
    expect(moved).toContain(git('rev-parse', 'HEAD').slice(0, 12));
  });

  it('works under an unborn HEAD, recording null and disclosing the first commit', () => {
    rmSync(join(repo, '.git'), { recursive: true, force: true });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t.t');
    git('config', 'user.name', 't');
    runSnapshot();
    expect(record().head).toBeNull();
    writeFileSync(join(repo, 'new.ts'), 'n\n');
    runSince();
    expect(hunks()).toContain('diff --git a/new.ts b/new.ts');
    expect(stderr().some((l) => l.includes('HEAD moved'))).toBe(false);

    (writeStderrLine as unknown as Mock).mockClear();
    git('add', '-A');
    git('commit', '-qm', 'first');
    runSince();
    expect(
      stderr().some((l) =>
        l.includes('HEAD moved between the two moments (unborn ->'),
      ),
    ).toBe(true);
  });

  it('keeps a non-ASCII name readable in the hunks', () => {
    runSnapshot();
    writeFileSync(join(repo, 'café.ts'), 'c\n');
    runSince();
    expect(hunks()).toContain('diff --git a/café.ts b/café.ts');
  });

  it.skipIf(process.platform === 'win32')(
    'escapes a control character in a changed name before it reaches a stderr line',
    () => {
      runSnapshot();
      writeFileSync(join(repo, 'evil\nfix-delta: forged.ts'), 'x\n');
      runSince();
      const summary = stderr().find((l) => l.includes('file(s) changed'));
      expect(summary).toContain('evil\\x0afix-delta: forged.ts');
      expect(stderr().every((l) => !l.includes('\n'))).toBe(true);
    },
  );

  describe('refusals', () => {
    it('refuses neither or both modes, and an empty --since', () => {
      expect(() => runFixDelta({ snapshot: false, out: hunksFile() })).toThrow(
        /exactly one of --snapshot/,
      );
      expect(() =>
        runFixDelta({
          snapshot: true,
          since: snapshotFile(),
          out: hunksFile(),
        }),
      ).toThrow(/exactly one of --snapshot/);
      expect(() =>
        runFixDelta({ snapshot: true, since: '', out: hunksFile() }),
      ).toThrow(/exactly one of --snapshot/);
      expect(() =>
        runFixDelta({ snapshot: false, since: '', out: hunksFile() }),
      ).toThrow(/an empty path names nothing/);
    });

    it('refuses a record that is missing, not JSON, or not a snapshot', () => {
      expect(() => runSince(join(out, 'absent.json'))).toThrow(
        /cannot read the snapshot/,
      );
      writeFileSync(snapshotFile(), 'not json');
      expect(() => runSince()).toThrow(/cannot read the snapshot/);
      runSnapshot();
      const snap = record();
      for (const bad of [
        { ...snap, tree: 'HEAD' },
        { ...snap, head: 'HEAD' },
        { root: snap.root, tree: snap.tree },
      ]) {
        writeFileSync(snapshotFile(), JSON.stringify(bad));
        expect(() => runSince()).toThrow(/not a fix-delta snapshot/);
      }
    });

    it('refuses a snapshot taken in another repository, or naming a tree this one lacks', () => {
      runSnapshot();
      const snap = record();
      writeFileSync(
        snapshotFile(),
        JSON.stringify({ ...snap, root: join(repo, 'elsewhere') }),
      );
      expect(() => runSince()).toThrow(/the snapshot was taken in/);
      writeFileSync(
        snapshotFile(),
        JSON.stringify({ ...snap, tree: 'f'.repeat(40) }),
      );
      expect(() => runSince()).toThrow(/is not in this repository/);
    });
  });

  it('runs through the yargs command the CLI registers', async () => {
    // The contract test at the CLI boundary: every other case calls
    // `runFixDelta` directly, which bypasses option parsing.
    const cli = () =>
      yargs().command(fixDeltaCommand).strict().exitProcess(false);
    await cli().parseAsync([
      'fix-delta',
      '--snapshot',
      '--out',
      snapshotFile(),
    ]);
    expect(record().root).toBe(repo);
    writeFileSync(join(repo, 'a.ts'), 'export const x = 3;\n');
    await cli().parseAsync([
      'fix-delta',
      '--since',
      snapshotFile(),
      '--out',
      hunksFile(),
    ]);
    expect(hunks()).toContain('+export const x = 3;');
  });
});
