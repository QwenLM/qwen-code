/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  replacementMutantsOf,
  splitDiffIntoHunks,
  selectHunkProbes,
  MAX_HUNK_PROBES,
  isWorkspaceMember,
  planTestEfficacy,
  classifyProbeRun,
  classifyMutantRun,
  safeRmWithin,
  selectMutants,
  parseAddedLines,
  hasCollocatedNewTest,
  collocatedProbe,
  collocatedNotGreenDetail,
  runnerFailureReason,
  type ProbeReason,
  heldForRedCollocatedTest,
  fitsAnotherMutantRun,
  probeCleanupFailureDetail,
  findVitestBin,
  MAX_MUTANTS,
  runControlMutant,
  runOneMutant,
  runOneHunkProbe,
  committedSymlinkProbes,
} from './test-efficacy.js';
import { isolateHostGitConfig } from './lib/test-utils.js';
import { sanitizedGitEnv } from './lib/worktree.js';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  symlinkSync,
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Hermetic git config for every fixture in this file, the same discipline as
// the sibling integration suites: `sanitizedGitEnv` strips env redirects, but
// the file scopes stay reachable through $HOME/.gitconfig and /etc/gitconfig.
// A persistent runner's ambient `core.sparseCheckout` flipped the very
// semantics the skip-worktree refusal pins — on git 2.39 an active sparse flag
// makes `checkout --force` clear the bit and read clean — so the refusal never
// fired and the run died later on a missing vitest.
let gitIsolation: ReturnType<typeof isolateHostGitConfig>;

beforeEach(() => {
  gitIsolation = isolateHostGitConfig();
});

afterEach(() => {
  gitIsolation.dispose();
});

// The real root `package.json` workspace list.
const GLOBS = [
  'packages/*',
  'packages/channels/base',
  'packages/channels/telegram',
  '!packages/desktop-shell',
];

describe('isWorkspaceMember', () => {
  it('places the integration-tests directory outside every workspace', () => {
    // The whole of the PR #6486 unreachability finding, decided without running
    // anything: `npm test` is `npm run test --workspaces`, and this path is in
    // no workspace, so nothing ever collects it.
    expect(
      isWorkspaceMember(
        'integration-tests/interactive/model-toggle-hotkey.test.ts',
        GLOBS,
      ),
    ).toBe(false);
  });

  it('places a package test inside one', () => {
    expect(
      isWorkspaceMember('packages/cli/src/config/keyBindings.test.ts', GLOBS),
    ).toBe(true);
    expect(
      isWorkspaceMember('packages/channels/base/src/x.test.ts', GLOBS),
    ).toBe(true);
  });

  it('honours a negated glob', () => {
    expect(
      isWorkspaceMember('packages/desktop-shell/src/a.test.ts', GLOBS),
    ).toBe(false);
  });

  it('honours workspace-glob ORDER — a positive after a negation re-includes', () => {
    // npm evaluates the list in order. Filtering all negations first let a
    // negation win wherever it sat, which would file a false `unreachable`.
    const globs = [
      'packages/*',
      '!packages/desktop-shell',
      'packages/desktop-shell',
    ];
    expect(
      isWorkspaceMember('packages/desktop-shell/src/a.test.ts', globs),
    ).toBe(true);
    const reordered = [
      'packages/*',
      'packages/desktop-shell',
      '!packages/desktop-shell',
    ];
    expect(
      isWorkspaceMember('packages/desktop-shell/src/a.test.ts', reordered),
    ).toBe(false);
  });

  it('does not match a sibling directory by prefix', () => {
    expect(isWorkspaceMember('packages-old/cli/a.test.ts', GLOBS)).toBe(false);
    expect(isWorkspaceMember('scripts/a.test.ts', GLOBS)).toBe(false);
  });
});

describe('planTestEfficacy', () => {
  // PR #6486's real file list: one unreachable integration test, two reachable
  // unit tests, and the production files they are supposed to be gating.
  const files6486 = [
    { path: 'packages/cli/src/ui/AppContainer.tsx', kind: 'source' },
    { path: 'packages/cli/src/config/keyBindings.ts', kind: 'source' },
    { path: 'packages/cli/src/config/keyBindings.test.ts', kind: 'test' },
    { path: 'packages/cli/src/ui/keyMatchers.test.ts', kind: 'test' },
    {
      path: 'integration-tests/interactive/model-toggle-hotkey.test.ts',
      kind: 'test',
    },
  ];

  it('reports the unreachable test and probes only the ones that can run', () => {
    const plan = planTestEfficacy(files6486, GLOBS);
    expect(plan.unreachable).toEqual([
      'integration-tests/interactive/model-toggle-hotkey.test.ts',
    ]);
    expect(plan.probes).toEqual([
      'packages/cli/src/config/keyBindings.test.ts',
      'packages/cli/src/ui/keyMatchers.test.ts',
    ]);
    expect(plan.revert).toEqual([
      'packages/cli/src/ui/AppContainer.tsx',
      'packages/cli/src/config/keyBindings.ts',
    ]);
  });

  it('excludes fixture-directory data but keeps runtime-loaded source', () => {
    // The discriminator is the directory, not the extension. A `.md` fixture
    // under `__fixtures__/` is test-support data — reverting it breaks the test
    // that loads it. But an executable skill prompt (`SKILL.md`) and a config
    // JSON a test validates against are production source that a test can
    // genuinely gate, so they stay revertable.
    const plan = planTestEfficacy(
      [
        { path: 'packages/cli/src/x.ts', kind: 'source' },
        { path: 'packages/cli/src/__fixtures__/body.md', kind: 'source' },
        {
          path: 'packages/core/src/skills/bundled/review/SKILL.md',
          kind: 'source',
        },
        { path: 'packages/cli/src/config/schema.json', kind: 'source' },
        { path: 'packages/cli/src/x.test.ts', kind: 'test' },
      ],
      GLOBS,
    );
    expect(plan.revert).toEqual([
      'packages/cli/src/x.ts',
      'packages/core/src/skills/bundled/review/SKILL.md',
      'packages/cli/src/config/schema.json',
    ]);
  });

  it('probes nothing on a source-only diff (no tests to run)', () => {
    // Mirror of the test-only case: source changed but no test file to probe
    // means nothing to gate. `probes` must be empty even though `revert` is not.
    const plan = planTestEfficacy(
      [{ path: 'packages/cli/src/a.ts', kind: 'source' }],
      GLOBS,
    );
    expect(plan.revert).toEqual(['packages/cli/src/a.ts']);
    expect(plan.probes).toEqual([]);
  });

  it('probes nothing on a test-only diff', () => {
    // A new test for OLD code is supposed to pass with nothing reverted. Probing
    // it would report every such PR as "inert" — a false blocker on exactly the
    // PRs we want people to write.
    const plan = planTestEfficacy(
      [{ path: 'packages/cli/src/a.test.ts', kind: 'test' }],
      GLOBS,
    );
    expect(plan.probes).toEqual([]);
    expect(plan.revert).toEqual([]);
  });
});

describe('findVitestBin', () => {
  it('names the search root when vitest cannot be resolved', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'no-vitest-'));
    // A bare tmpdir answers "not found" only when nothing up-tree happens to
    // provide vitest — a node_modules above the runner's TMPDIR (observed on
    // self-hosted CI) would resolve one and the throw never fires. Inject the
    // MODULE_NOT_FOUND itself so the test asks the same question on every
    // host instead of depending on the ambient filesystem.
    const vitestNotInstalled = () => {
      const err = new Error(
        "Cannot find module 'vitest/package.json'",
      ) as NodeJS.ErrnoException;
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    };

    expect(() => findVitestBin(worktree, vitestNotInstalled)).toThrow(
      `vitest not found searching up from ${worktree}`,
    );
  });

  it('names the package when vitest declares no bin', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'vitest-no-bin-'));
    const vitestDir = join(worktree, 'node_modules', 'vitest');
    mkdirSync(vitestDir, { recursive: true });
    writeFileSync(join(vitestDir, 'package.json'), '{}');

    expect(() => findVitestBin(worktree)).toThrow(/declares no "vitest" bin/);
  });

  it('keeps the real error when vitest is present but hides its package.json', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'vitest-hidden-'));
    const vitestDir = join(worktree, 'node_modules', 'vitest');
    mkdirSync(vitestDir, { recursive: true });
    // An `exports` map with no `./package.json` (and no `./*` wildcard) makes
    // `require.resolve('vitest/package.json')` throw ERR_PACKAGE_PATH_NOT_EXPORTED.
    // vitest IS installed here, so the blanket "vitest not found" would be a lie
    // that sends the reader hunting a missing install; the real error survives.
    writeFileSync(
      join(vitestDir, 'package.json'),
      JSON.stringify({ name: 'vitest', exports: { '.': './index.js' } }),
    );
    writeFileSync(join(vitestDir, 'index.js'), '');

    expect(() => findVitestBin(worktree)).toThrow(/not defined by "exports"/);
  });
});

/**
 * Make a fixture directory the checkout a probe tree always is in production.
 *
 * `restoreProbeTreeTracked` refuses a tree with no `.git` — there is nothing to
 * put it back to, and running the restore anyway would check the ENCLOSING
 * repository out into it — so a bare `mkdtemp` no longer reaches the behaviour
 * these tests are about. Commit whatever the test has already written, so the
 * restore is a no-op and the test still pins its own thing.
 */
function asCheckout(dir: string): void {
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@t.t',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null/no-hooks',
        ...args,
      ],
      // Sanitized like the guards these fixtures exist to provoke: an
      // ambient GIT_INDEX_FILE (observed on a persistent runner) makes
      // add/commit stage into ANOTHER index, and the bit a later
      // update-index sets locally can never reproduce the state under
      // test — the fixture must build the same index the guard reads.
      { cwd: dir, encoding: 'utf8', env: sanitizedGitEnv() },
    );
  git('init', '-q', '-b', 'main', '--template=', '.');
  git('add', '-A');
  git('commit', '-qm', 'fixture', '--no-verify', '--allow-empty');
}

describe('runControlMutant', () => {
  it('returns null — not false — when the probe file cannot be read', () => {
    // `false` is a VERDICT: "the injected always-failing test stayed green".
    // With an unreadable probe file nothing is injected and nothing runs, so
    // reporting `false` states a run that never happened, re-classes every
    // survivor with that sentence, and discards the whole mutant/hunk window
    // over an I/O error. `null` is the file's own third-outcome discipline.
    const dir = mkdtempSync(join(tmpdir(), 'qwen-control-'));
    try {
      expect(runControlMutant(dir, 'nope/does-not-exist.test.ts')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the probe file byte-identical when it cannot run', () => {
    // The restore is in a `finally`, but the early return happens BEFORE the
    // write — a probe file the control corrupted would poison every mutant
    // run after it.
    const dir = mkdtempSync(join(tmpdir(), 'qwen-control-'));
    try {
      const original = 'import { it } from "vitest";\nit("t", () => {});\n';
      writeFileSync(join(dir, 'a.test.ts'), original);
      // The control throws only when the vitest run never starts. A bare
      // tmpdir has no vitest only when nothing up-tree provides one — a
      // node_modules above the runner's TMPDIR (observed on self-hosted CI)
      // would resolve vitest and the run would actually execute. Plant a
      // shadow vitest whose `exports` hides its package.json: the innermost
      // node_modules wins resolution on every host, so findVitestBin surfaces
      // the ERR_PACKAGE_PATH_NOT_EXPORTED and the restore's `finally` has to
      // survive exactly that path — or the control leaves an injected
      // always-failing test behind in a file every later mutant run uses.
      // (The caller's outer catch is what turns the throw into inconclusive.)
      const vitestDir = join(dir, 'node_modules', 'vitest');
      mkdirSync(vitestDir, { recursive: true });
      writeFileSync(
        join(vitestDir, 'package.json'),
        JSON.stringify({
          name: 'vitest',
          exports: { '.': './index.js' },
        }),
      );
      writeFileSync(join(vitestDir, 'index.js'), '');
      asCheckout(dir);
      expect(() => runControlMutant(dir, 'a.test.ts')).toThrow();
      expect(readFileSync(join(dir, 'a.test.ts'), 'utf8')).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null — never injects through — a probe file that is a symlink', () => {
    // A PR can commit its test as mode 120000 naming anywhere a relative path
    // reaches — the shared review worktree sits at a predictable sibling path
    // — and the injection would follow the link out of the probe tree. The
    // control that never ran is `null`, and the link's target is untouched.
    const dir = mkdtempSync(join(tmpdir(), 'qwen-control-'));
    const outside = mkdtempSync(join(tmpdir(), 'qwen-control-target-'));
    try {
      const original = 'shared file content\n';
      writeFileSync(join(outside, 'shared.test.ts'), original);
      symlinkSync(join(outside, 'shared.test.ts'), join(dir, 'a.test.ts'));

      expect(runControlMutant(dir, 'a.test.ts')).toBeNull();
      expect(readFileSync(join(outside, 'shared.test.ts'), 'utf8')).toBe(
        original,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('probe write sites refuse a symlinked target', () => {
  // The mutant and hunk probes write the same way the control does; a leaf
  // symlink would carry the mutation and its restore into whatever the link
  // names. Both refuse the shape as inconclusive before anything runs.
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-probetree-'));
    const outside = mkdtempSync(join(tmpdir(), 'qwen-probetree-target-'));
    const original = 'line one\nline two\n';
    writeFileSync(join(outside, 'shared.ts'), original);
    symlinkSync(join(outside, 'shared.ts'), join(dir, 'target.ts'));
    return { dir, outside, original };
  };
  const teardown = (dir: string, outside: string) => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  };

  it('runOneMutant reports inconclusive and leaves the target untouched', () => {
    const { dir, outside, original } = setup();
    try {
      const r = runOneMutant(
        dir,
        { file: 'target.ts', line: 1, statement: 'line one' },
        [],
      );
      expect(r.verdict).toBe('inconclusive');
      expect(r.detail).toContain('symlink');
      expect(readFileSync(join(outside, 'shared.ts'), 'utf8')).toBe(original);
    } finally {
      teardown(dir, outside);
    }
  });

  it('runOneHunkProbe reports inconclusive and leaves the target untouched', () => {
    const { dir, outside, original } = setup();
    try {
      const r = runOneHunkProbe(
        dir,
        {
          file: 'target.ts',
          index: 0,
          header: '@@ -1,2 +1,2 @@',
          startLine: 1,
          patch: 'irrelevant — the guard fires before git apply',
        },
        [],
      );
      expect(r.verdict).toBe('inconclusive');
      expect(r.detail).toContain('symlink');
      expect(readFileSync(join(outside, 'shared.ts'), 'utf8')).toBe(original);
    } finally {
      teardown(dir, outside);
    }
  });

  it('refuses a target reached through a SYMLINKED ANCESTOR too — a leaf check cannot see it', () => {
    // `lstat` resolves every intermediate component, so once a directory of a
    // REUSED probe tree has been relinked by code that ran in it, a leaf-only
    // check reports the outside file as ordinary and every later write
    // follows the link out of the tree. The guard walks every component, the
    // way `safeRmWithin` does on the delete side.
    const dir = mkdtempSync(join(tmpdir(), 'qwen-probetree-anc-'));
    const outside = mkdtempSync(join(tmpdir(), 'qwen-probetree-anc-target-'));
    try {
      const original = 'line one\nline two\n';
      mkdirSync(join(outside, 'src'), { recursive: true });
      writeFileSync(join(outside, 'src', 'lib.ts'), original);
      symlinkSync(join(outside, 'src'), join(dir, 'src'));

      const m = runOneMutant(
        dir,
        { file: 'src/lib.ts', line: 1, statement: 'line one' },
        [],
      );
      expect(m.verdict).toBe('inconclusive');
      expect(m.detail).toContain('symlink');

      const h = runOneHunkProbe(
        dir,
        {
          file: 'src/lib.ts',
          index: 0,
          header: '@@ -1,2 +1,2 @@',
          startLine: 1,
          patch: 'irrelevant — the guard fires before git apply',
        },
        [],
      );
      expect(h.verdict).toBe('inconclusive');
      expect(h.detail).toContain('symlink');

      expect(runControlMutant(dir, 'src/lib.ts')).toBeNull();

      expect(readFileSync(join(outside, 'src', 'lib.ts'), 'utf8')).toBe(
        original,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('committedSymlinkProbes', () => {
  // A test committed as mode 120000 is collected by vitest THROUGH the link —
  // every verdict it could produce is about code the probe tree never mutated,
  // and no write guard sees it, because the harness never WRITES probe files.
  it('names the probes committed as symlinks and nothing else', () => {
    const repo = mkdtempSync(join(tmpdir(), 'qwen-symlink-mode-'));
    const isolation = isolateHostGitConfig();
    try {
      // Sanitized for the reason asCheckout is: the function under test
      // reads with a sanitized env, so the fixture must build with one.
      const g = (...args: string[]) =>
        execFileSync('git', args, {
          cwd: repo,
          encoding: 'utf8',
          env: sanitizedGitEnv(),
        }).trim();
      g('init', '-q', '-b', 'main');
      g('config', 'user.email', 't@t.t');
      g('config', 'user.name', 't');
      writeFileSync(join(repo, 'real.test.ts'), 'x\n');
      writeFileSync(join(repo, 'target.ts'), 'y\n');
      symlinkSync('target.ts', join(repo, 'linked.test.ts'));
      g('add', '-A');
      g('commit', '-qm', 'head');

      const got = committedSymlinkProbes(repo, [
        'real.test.ts',
        'linked.test.ts',
        'absent.test.ts',
      ]);
      expect([...got]).toEqual(['linked.test.ts']);
    } finally {
      isolation.dispose();
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('probeCleanupFailureDetail', () => {
  // Sibling of worktreeCreateFailureDetail, and pure for the same reason: the path
  // fires only when the tree outlives BOTH `worktree remove` and `rmSync`, which
  // no portable test can force. The reason is the whole value of the message —
  // it dropped out of an earlier cut of this code and a reviewer caught it.
  it('keeps the exception reason — the rmSync error that explains the survival', () => {
    const got = probeCleanupFailureDetail(
      '/w/wt-probe',
      new Error("EBUSY: resource busy, rmdir '/w/wt-probe'"),
      "fatal: '/w/wt-probe' is not a working tree\n",
    );
    expect(got).toContain('could not remove probe worktree /w/wt-probe');
    expect(got).toContain('EBUSY: resource busy');
  });

  it("falls back to git's refusal when rmSync itself did not throw", () => {
    const got = probeCleanupFailureDetail(
      '/w/wt-probe',
      undefined,
      "fatal: '/w/wt-probe' contains modified files\n",
    );
    expect(got).toBe(
      "could not remove probe worktree /w/wt-probe: fatal: '/w/wt-probe' contains modified files",
    );
  });

  it('says only what it knows when neither had anything to say', () => {
    // No dangling ": " — the bare path is the honest message here.
    expect(probeCleanupFailureDetail('/w/wt-probe', undefined, '  \n')).toBe(
      'could not remove probe worktree /w/wt-probe',
    );
  });
});

describe('restoreProbeTreeTracked, through runOneMutant', () => {
  it('refuses to run when the tree carries NO .git at all', () => {
    // The state the tree can never be put back from, and the cheapest one to
    // reach: `.git` is an untracked pointer file inside the directory the PR's
    // own suite runs in, so one `rm` used to turn every later restore into
    // "nothing to restore" and let the plants stand. Running the restore
    // anyway is not the alternative either — with no `.git`, discovery walks
    // UP and checks the enclosing repository out into this tree.
    const dir = mkdtempSync(join(tmpdir(), 'qwen-nogit-'));
    try {
      writeFileSync(join(dir, 'a.ts'), 'gone.clear();\n');

      const r = runOneMutant(
        dir,
        { file: 'a.ts', line: 1, statement: 'gone.clear();' },
        ['a.test.ts'],
      );

      expect(r.verdict).toBe('inconclusive');
      expect(r.detail).toContain('no .git');
      expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('gone.clear();\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to run through a repo-LOCAL content filter, and only a local one', () => {
    // The restore rewrites every tracked file in this tree, and a checkout
    // EXECUTES `filter.<name>.smudge` whenever it does — the same surface
    // `scratch-tree` refuses to reset through, run twice per probe run one
    // directory over with no screen at all.
    const dir = mkdtempSync(join(tmpdir(), 'qwen-filter-'));
    const canaryDir = mkdtempSync(join(tmpdir(), 'qwen-canary-'));
    const isolation = isolateHostGitConfig();
    try {
      writeFileSync(join(dir, 'a.ts'), 'gone.clear();\n');
      writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
      // The attributes line is half the plant and belongs in the fixture: a
      // filter git never SELECTS for a tracked path executes nothing, so
      // without this the restore is harmless with or without the screen and
      // the test would stay green if a later edit moved the screen below the
      // checkout. With it, the canary below pins the ORDER, not just the
      // message.
      writeFileSync(join(dir, '.gitattributes'), '*.ts filter=evil\n');
      asCheckout(dir);
      // OUTSIDE the probe tree, but inside a fixture this test removes: the
      // restore's second spawn is `clean -ffdx`, which deletes an untracked
      // canary written into the tree and would hide the very ordering bug the
      // canary exists to catch. Nothing is left on the runner either way.
      const canary = join(canaryDir, 'PWNED-smudge');
      execFileSync('git', ['config', 'filter.evil.smudge', `touch ${canary}`], {
        cwd: dir,
      });
      // A checkout runs the smudge only on files it actually REWRITES, and it
      // rewrites nothing when the tree already matches HEAD. A dirty file is
      // what a probe run leaves behind and what the restore exists to undo, so
      // it is also the condition under which the canary can fire at all.
      writeFileSync(join(dir, 'a.ts'), 'dirtied by a previous run\n');

      const r = runOneMutant(
        dir,
        { file: 'a.ts', line: 1, statement: 'gone.clear();' },
        ['a.test.ts'],
      );

      expect(r.verdict).toBe('inconclusive');
      expect(r.detail).toContain('filter.evil.smudge');
      // The refusal has to come BEFORE the checkout, not merely instead of a
      // verdict: this is the assertion that goes red if the screen moves down.
      expect(existsSync(canary)).toBe(false);

      // ...and a filter in the user's GLOBAL config is their own contract, the
      // way it is for any git command they run. `git lfs install` writes one
      // there, so refusing on it would put every contributor with git-lfs into
      // permanent refusal — the failure mode a blanket rule reproduces.
      execFileSync('git', ['config', '--unset', 'filter.evil.smudge'], {
        cwd: dir,
      });
      // Reach that global file through a repo-local include too. Following
      // includes is necessary to catch a local included filter, but judging
      // the include directive itself would refuse this legitimate origin.
      execFileSync(
        'git',
        ['config', 'include.path', join(isolation.home, '.gitconfig')],
        { cwd: dir },
      );
      execFileSync(
        'git',
        ['config', '--global', 'filter.lfs.clean', 'git-lfs clean -- %f'],
        { cwd: dir },
      );

      // It gets all the way to the runner, which this bare fixture does not
      // have — the throw is from `findVitestBin`, and that IS the observation:
      // the restore did not refuse, so the phase proceeded.
      let afterDetail: string;
      try {
        afterDetail = runOneMutant(
          dir,
          { file: 'a.ts', line: 1, statement: 'gone.clear();' },
          ['a.test.ts'],
        ).detail;
      } catch (e) {
        afterDetail = e instanceof Error ? e.message : String(e);
      }

      expect(afterDetail).not.toContain('filter.lfs.clean');
      expect(afterDetail).not.toContain('content filter');
      // The local `evil` filter is gone, so nothing selected by the committed
      // attributes line remains to execute either.
      expect(existsSync(canary)).toBe(false);
    } finally {
      isolation.dispose();
      rmSync(dir, { recursive: true, force: true });
      rmSync(canaryDir, { recursive: true, force: true });
    }
  });

  it('refuses a repo-local content filter hidden behind include.path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qwen-filter-include-'));
    const canaryDir = mkdtempSync(join(tmpdir(), 'qwen-canary-'));
    const isolation = isolateHostGitConfig();
    try {
      writeFileSync(join(dir, 'a.ts'), 'gone.clear();\n');
      writeFileSync(join(dir, '.gitattributes'), '*.ts filter=included\n');
      asCheckout(dir);
      const canary = join(canaryDir, 'PWNED-included-smudge');
      const included = join(dir, '.git', 'review-filter.inc');
      writeFileSync(
        included,
        `[filter "included"]\n\tsmudge = touch ${canary}\n`,
      );
      execFileSync('git', ['config', 'include.path', included], { cwd: dir });
      writeFileSync(join(dir, 'a.ts'), 'dirtied by a previous run\n');

      const r = runOneMutant(
        dir,
        { file: 'a.ts', line: 1, statement: 'gone.clear();' },
        ['a.test.ts'],
      );

      expect(r.verdict).toBe('inconclusive');
      expect(r.detail).toContain('filter.included.smudge');
      expect(existsSync(canary)).toBe(false);
    } finally {
      isolation.dispose();
      rmSync(dir, { recursive: true, force: true });
      rmSync(canaryDir, { recursive: true, force: true });
    }
  });

  it('still sees a filter whose value is padded past the default spawn buffer', () => {
    // The screened file is attacker-writable and git prints every matching
    // value in full, so a `smudge` padded past `spawnSync`'s DEFAULT 1 MiB
    // buffer used to kill git with ENOBUFS — and the screen skipped the one
    // file that defines the filter and reported the repository clean, while
    // the restore's checkout ran the last value.
    const dir = mkdtempSync(join(tmpdir(), 'qwen-bigvalue-'));
    const canaryDir = mkdtempSync(join(tmpdir(), 'qwen-canary-'));
    const isolation = isolateHostGitConfig();
    try {
      writeFileSync(join(dir, 'a.ts'), 'gone.clear();\n');
      writeFileSync(join(dir, '.gitattributes'), '*.ts filter=evil\n');
      asCheckout(dir);
      const canary = join(canaryDir, 'PWNED-bigvalue');
      // git takes the LAST value; the first is only there to push the
      // enumeration's output past the default buffer.
      appendFileSync(
        join(dir, '.git', 'config'),
        `[filter "evil"]\n\tsmudge = echo ${'x'.repeat(1200000)}\n` +
          `\tsmudge = touch ${canary}\n`,
      );
      writeFileSync(join(dir, 'a.ts'), 'dirtied by a previous run\n');

      const r = runOneMutant(
        dir,
        { file: 'a.ts', line: 1, statement: 'gone.clear();' },
        ['a.test.ts'],
      );

      expect(r.verdict).toBe('inconclusive');
      expect(r.detail).toContain('filter.evil.smudge');
      expect(existsSync(canary)).toBe(false);
    } finally {
      isolation.dispose();
      rmSync(dir, { recursive: true, force: true });
      rmSync(canaryDir, { recursive: true, force: true });
    }
  });

  it('refuses a config candidate it cannot read — not "clean"', () => {
    // git reports an unreadable `--file` with exit 1 and a warning on stderr —
    // the same status as "no key matched" — so a screen that asks git and reads
    // the exit code calls a config it never read clean. The candidate here is
    // `config.worktree`, which git honors once `extensions.worktreeConfig` is
    // on; a directory in its place is a candidate the screen cannot check.
    const dir = mkdtempSync(join(tmpdir(), 'qwen-unreadable-'));
    const isolation = isolateHostGitConfig();
    try {
      writeFileSync(join(dir, 'a.ts'), 'gone.clear();\n');
      asCheckout(dir);
      mkdirSync(join(dir, '.git', 'config.worktree'));

      const r = runOneMutant(
        dir,
        { file: 'a.ts', line: 1, statement: 'gone.clear();' },
        ['a.test.ts'],
      );

      expect(r.verdict).toBe('inconclusive');
      expect(r.detail).toContain('could not be read to the end');
    } finally {
      isolation.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to run when the index hides a tracked file from the restore', () => {
    // `checkout --force` SILENTLY skips a file carrying skip-worktree, and
    // `clean` never touches a tracked file — so a bit the guest suite sets with
    // `update-index` leaves its tampered content standing through a restore
    // that answered "as the commit left it", with `git status` reading empty.
    // `scratch-tree` documents this shape for the identical reset and refuses;
    // this function did not read the bits at all.
    const dir = mkdtempSync(join(tmpdir(), 'qwen-skipwt-'));
    try {
      writeFileSync(join(dir, 'a.ts'), 'gone.clear();\n');
      // A second tracked file, so `checkout -- .` still has something to do:
      // with the only tracked path hidden the pathspec matches nothing and git
      // fails for a different reason — fail-closed either way, but this test is
      // about the oracle, not about that.
      writeFileSync(join(dir, 'b.ts'), 'export const b = 1;\n');
      asCheckout(dir);
      // With the same sanitized env the guard's own git calls use: an
      // ambient discovery redirect (a GIT_INDEX_FILE on a persistent runner)
      // writes the bit into ANOTHER index than the guard reads, the refusal
      // this test pins never fires, and the mutant run dies later on a
      // missing vitest instead — the incident this file's isolation
      // discipline exists for.
      execFileSync('git', ['update-index', '--skip-worktree', 'a.ts'], {
        cwd: dir,
        env: sanitizedGitEnv(),
      });
      writeFileSync(join(dir, 'a.ts'), 'MUTANT\n');

      const r = runOneMutant(
        dir,
        { file: 'a.ts', line: 1, statement: 'gone.clear();' },
        ['a.test.ts'],
      );

      expect(r.verdict).toBe('inconclusive');
      expect(r.detail).toContain('skip-worktree');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to run when the tree HAS a .git it cannot resolve', () => {
    // The gate skips a directory with no `.git` because there is no commit to
    // restore FROM — but `.git` is untracked, so nothing ever restores IT, and
    // a guest that overwrites it once would buy "proceed, nothing to put back"
    // from every later phase: the planted content stands and the verdicts are
    // the plant's. Present-but-unresolvable is a failure, not a skip. Same
    // discipline the residue probe's oracles fail closed under.
    const dir = mkdtempSync(join(tmpdir(), 'qwen-brokengit-'));
    try {
      writeFileSync(join(dir, 'a.ts'), 'gone.clear();\n');
      writeFileSync(join(dir, '.git'), 'gitdir: /nonexistent-repo\n');

      const r = runOneMutant(
        dir,
        { file: 'a.ts', line: 1, statement: 'gone.clear();' },
        ['a.test.ts'],
      );

      expect(r.verdict).toBe('inconclusive');
      expect(r.detail).toContain('could not be put back');
      // And the mutation never happened.
      expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe('gone.clear();\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('safeRmWithin', () => {
  // A reviewer reproduced a P0: the revert set is PR-controlled, and `rmSync`
  // follows symlinks in the path prefix, so a PR that turns `dir` into a symlink
  // to an outside directory and has the probe delete `dir/victim` deleted the
  // OUTSIDE file. These pin the guard that closed it.
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'saferm-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'saferm-outside-'));
    writeFileSync(join(outside, 'victim'), 'must survive');
    return { root, outside };
  };

  it('removes a file reachable through real directories', () => {
    const { root } = setup();
    mkdirSync(join(root, 'realdir'));
    writeFileSync(join(root, 'realdir', 'f'), 'x');
    safeRmWithin(root, 'realdir/f');
    expect(existsSync(join(root, 'realdir', 'f'))).toBe(false);
  });

  // A backslash is a legal filename character on POSIX and a separator on
  // Windows, so the shape only exists off Windows — which is where it bites.
  it.skipIf(process.platform === 'win32')(
    'treats a backslash in a POSIX name as a NAME, not as a separator',
    () => {
      // One committed file whose single-component name contains backslashes.
      // Splitting on them unconditionally turned that name into three
      // components — two of them `..` — and `join` normalises those away
      // silently, so a PR-controlled name became a delete anywhere the tree's
      // parent reaches, starting with the shared review worktree next door.
      const { root, outside } = setup();
      const escaping = `\\..\\${basename(outside)}\\victim`;

      expect(() => safeRmWithin(root, escaping)).not.toThrow();

      expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe(
        'must survive',
      );
      // ...and a name that really does climb is refused outright rather than
      // resolved, whichever separator spelled it.
      expect(() => safeRmWithin(root, '../victim')).toThrow(/parent reference/);
    },
  );

  it('refuses to delete through a symlinked ancestor, sparing the outside file', () => {
    const { root, outside } = setup();
    // `dir` is a symlink to an outside directory; deleting `dir/victim` must not
    // follow it. This is the exact P0 shape.
    symlinkSync(outside, join(root, 'dir'));
    expect(() => safeRmWithin(root, 'dir/victim')).toThrow(/through a symlink/);
    expect(readFileSync(join(outside, 'victim'), 'utf8')).toBe('must survive');
  });

  it('unlinks a symlink that is itself the target, not what it points at', () => {
    const { root, outside } = setup();
    // Reverting an ADDED symlink means removing the link — never its target.
    symlinkSync(outside, join(root, 'addedlink'));
    safeRmWithin(root, 'addedlink');
    expect(existsSync(join(root, 'addedlink'))).toBe(false);
    expect(existsSync(join(outside, 'victim'))).toBe(true);
  });

  it('is a no-op on a missing path (force rm never threw there either)', () => {
    const { root } = setup();
    expect(() => safeRmWithin(root, 'nope/gone')).not.toThrow();
  });
});

describe('classifyProbeRun', () => {
  const json = (o: unknown) => JSON.stringify(o);
  const only = <T>(got: T[]): T => got[0];
  /** The tag, if the verdict is one that carries one. Narrowing is the point:
   *  `ProbeResult` only offers `reason` on the `inconclusive` arm. */
  const reasonOf = (r: ReturnType<typeof classifyProbeRun>[number]) =>
    r.verdict === 'inconclusive' ? r.reason : undefined;

  // The tags are what `collocatedNotGreenDetail` reads, and an untagged branch
  // silently degrades every hold of that kind to a vague catch-all. Measured
  // before these existed: deleting one tag left all 116 tests green.
  it('tags a run that produced no parseable output as no-output', () => {
    const got = classifyProbeRun(
      1,
      'boom',
      ['packages/lib/src/a.test.ts'],
      'x',
    );
    expect(only(got).verdict).toBe('inconclusive');
    expect(reasonOf(only(got))).toBe('no-output');
  });

  it('tags a file absent from the results as not-in-results', () => {
    // Distinct from collecting zero tests: the run answered and this file was
    // not in the answer, which a path miss produces as readily as a compile
    // error.
    const got = classifyProbeRun(
      1,
      json({
        testResults: [
          {
            name: '/w/packages/lib/src/other.test.ts',
            assertionResults: [{ status: 'passed' }],
          },
        ],
      }),
      ['packages/lib/src/a.test.ts'],
    );
    expect(reasonOf(only(got))).toBe('not-in-results');
    expect(only(got).detail).toContain('none for this file');
  });

  it('tags a file that collected nothing as no-tests', () => {
    const got = classifyProbeRun(
      1,
      json({
        testResults: [
          { name: '/w/packages/lib/src/a.test.ts', assertionResults: [] },
        ],
      }),
      ['packages/lib/src/a.test.ts'],
    );
    expect(reasonOf(only(got))).toBe('no-tests');
  });

  it('tags an all-skipped file as all-skipped', () => {
    const got = classifyProbeRun(
      0,
      json({
        testResults: [
          {
            name: '/w/packages/lib/src/a.test.ts',
            assertionResults: [{ status: 'skipped' }, { status: 'skipped' }],
          },
        ],
      }),
      ['packages/lib/src/a.test.ts'],
    );
    expect(reasonOf(only(got))).toBe('all-skipped');
  });

  it('leaves a decided verdict untagged', () => {
    const got = classifyProbeRun(
      0,
      json({
        testResults: [
          {
            name: '/w/packages/lib/src/a.test.ts',
            assertionResults: [{ status: 'passed' }],
          },
        ],
      }),
      ['packages/lib/src/a.test.ts'],
    );
    expect(only(got).verdict).toBe('inert');
    expect('reason' in only(got)).toBe(false);
  });

  it('calls a test that still passes without the change INERT', () => {
    // The finding. The source is reverted and the test is green anyway, so it
    // is green whether or not the feature exists.
    const got = classifyProbeRun(
      0,
      json({
        testResults: [
          {
            name: '/w/packages/lib/src/inert.test.ts',
            assertionResults: [{ status: 'passed' }, { status: 'passed' }],
          },
        ],
      }),
      ['packages/lib/src/inert.test.ts'],
    );
    expect(only(got).verdict).toBe('inert');
    expect(only(got).detail).toContain('does not gate');
  });

  it('calls a real assertion failure GATED', () => {
    const got = classifyProbeRun(
      1,
      json({
        testResults: [
          {
            name: '/w/a.test.ts',
            assertionResults: [{ status: 'failed' }, { status: 'passed' }],
          },
        ],
      }),
      ['a.test.ts'],
    );
    expect(only(got).verdict).toBe('gated');
  });

  it('matches Windows result paths to repository-relative probes', () => {
    const platformSpy = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    try {
      const got = classifyProbeRun(
        0,
        json({
          testResults: [
            {
              name: 'C:\\w\\packages\\lib\\src\\inert.test.ts',
              assertionResults: [{ status: 'passed' }],
            },
          ],
        }),
        ['packages/lib/src/inert.test.ts'],
      );
      expect(only(got).verdict).toBe('inert');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('matches Windows result paths case-insensitively', () => {
    const platformSpy = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    try {
      // Windows paths are case-insensitive; a drive letter or 8.3 name reported
      // in different case must still match the git-relative probe, or the file
      // silently reads `inconclusive`.
      const got = classifyProbeRun(
        0,
        json({
          testResults: [
            {
              name: 'C:\\W\\Packages\\Lib\\src\\Inert.test.ts',
              assertionResults: [{ status: 'passed' }],
            },
          ],
        }),
        ['packages/lib/src/inert.test.ts'],
      );
      expect(only(got).verdict).toBe('inert');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('keeps POSIX matching case-sensitive', () => {
    const platformSpy = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('linux');
    try {
      // Case folding is win32-only: on POSIX case is significant, so a
      // different-case name is a different file and must NOT satisfy the probe.
      const got = only(
        classifyProbeRun(
          1,
          json({
            testResults: [
              {
                name: '/w/SRC/A.test.ts',
                assertionResults: [{ status: 'failed' }],
              },
            ],
          }),
          ['src/a.test.ts'],
        ),
      );
      expect(got.verdict).toBe('inconclusive');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('does not treat a POSIX backslash filename as a path separator', () => {
    const platformSpy = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('linux');
    try {
      // On POSIX a backslash is a legal filename character. The win32-only
      // normalisation must not run here, or `/w/vendor/other\src/a.test.ts`
      // would collapse into `/w/vendor/other/src/a.test.ts` and satisfy the
      // probe `src/a.test.ts` — taking a neighbour's verdict, exactly what the
      // path-separator boundary exists to prevent.
      const got = only(
        classifyProbeRun(
          1,
          json({
            testResults: [
              {
                name: '/w/vendor/other\\src/a.test.ts',
                assertionResults: [{ status: 'failed' }],
              },
            ],
          }),
          ['src/a.test.ts'],
        ),
      );
      expect(got.verdict).toBe('inconclusive');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('does not let a gating test cover for an inert one in the same run', () => {
    // The bug the LIVE run found and the unit tests did not. One `vitest run`
    // covers every probe; a run-level verdict scored BOTH files `gated` because
    // the gating test failed — so every inert test with a working sibling was
    // invisible, which is the exact defect this command exists to find.
    const got = classifyProbeRun(
      1,
      json({
        testResults: [
          {
            name: '/w/packages/lib/src/inert.test.ts',
            assertionResults: [{ status: 'passed' }],
          },
          {
            name: '/w/packages/lib/src/gating.test.ts',
            assertionResults: [{ status: 'failed' }],
          },
        ],
      }),
      ['packages/lib/src/inert.test.ts', 'packages/lib/src/gating.test.ts'],
    );
    expect(got.map((r) => [r.file, r.verdict])).toEqual([
      ['packages/lib/src/inert.test.ts', 'inert'],
      ['packages/lib/src/gating.test.ts', 'gated'],
    ]);
  });

  it('does NOT call a compile error GATED', () => {
    // The trap this command would otherwise walk into. Reverting the source
    // routinely breaks the test's own imports — it references a symbol the diff
    // introduced. The runner exits non-zero and collects nothing. That is not
    // the test catching a regression; mistaking it for one would hand back
    // exactly the false assurance we are trying to remove.
    const got = classifyProbeRun(1, json({ testResults: [] }), ['a.test.ts']);
    expect(only(got).verdict).toBe('inconclusive');
    expect(only(got).detail).toContain('not evidence either way');
  });

  it('is inconclusive on unparseable output, and says why', () => {
    const got = only(
      classifyProbeRun(
        1,
        'ELIFECYCLE npm ERR!',
        ['a.test.ts'],
        'ENOENT: vitest',
      ),
    );
    expect(got.verdict).toBe('inconclusive');
    // The runner's own error is the only thing that explains this outcome;
    // dropping stderr leaves an `inconclusive` nobody can act on.
    expect(got.detail).toContain('ENOENT: vitest');
  });

  it('does not take another file’s verdict by suffix collision', () => {
    // `endsWith(file)` alone matches `/w/vendor/other-src/a.test.ts` for the
    // probe `src/a.test.ts` — and would then report that file's verdict for
    // ours, silently. Match on a path-separator boundary.
    const got = only(
      classifyProbeRun(
        1,
        json({
          testResults: [
            {
              name: '/w/vendor/other-src/a.test.ts',
              assertionResults: [{ status: 'failed' }],
            },
          ],
        }),
        ['src/a.test.ts'],
      ),
    );
    // Our file was never collected — that is `inconclusive`, not the neighbour's
    // `gated`.
    expect(got.verdict).toBe('inconclusive');
  });

  it('does not call an all-skipped file INERT', () => {
    // Nothing failed and nothing passed — every test was skipped. Reporting
    // "all 0 test(s) still PASSED" about tests that never executed is the same
    // false assurance in a different costume.
    const got = only(
      classifyProbeRun(
        0,
        json({
          testResults: [
            {
              name: '/w/a.test.ts',
              assertionResults: [{ status: 'skipped' }, { status: 'skipped' }],
            },
          ],
        }),
        ['a.test.ts'],
      ),
    );
    expect(got.verdict).toBe('inconclusive');
    expect(got.detail).toContain('none executed');
  });
});

describe('parseAddedLines', () => {
  it('numbers added lines on the NEW side, per post-change path', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,0 +11,2 @@ ctx',
      '+first added',
      '+second added',
      '@@ -20 +22,0 @@ ctx',
      '-removed only',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-x',
      '-y',
      'diff --git a/src/b.ts b/src/b.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/b.ts',
      '@@ -0,0 +1 @@',
      '+only line',
      '',
    ].join('\n');
    const got = parseAddedLines(diff);
    // The `index`/`new file mode` header lines sit between hunks; counting
    // them as context would shift every number below by the header count.
    expect(got.get('src/a.ts')).toEqual([11, 12]);
    expect(got.get('src/b.ts')).toEqual([1]);
    // A deletion has no new side and must contribute nothing.
    expect(got.has('src/gone.ts')).toBe(false);
  });

  it('counts context lines, so a default -U3 diff still numbers correctly', () => {
    const diff = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -4,3 +4,4 @@',
      ' ctx one',
      '+added',
      ' ctx two',
      ' ctx three',
      '',
    ].join('\n');
    expect(parseAddedLines(diff).get('src/a.ts')).toEqual([5]);
  });

  it('does not count a "\\ No newline" marker as a context line', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -5,0 +6,2 @@',
      '+added line',
      '\\ No newline at end of file',
      '+second added',
    ].join('\n');
    const got = parseAddedLines(diff);
    expect(got.get('src/a.ts')).toEqual([6, 7]);
  });

  it('does not read an added `++ x` line as a file header', () => {
    // `git diff --unified=0` prefixes each added line with `+`, so a spaced
    // pre-increment (`++ count;`) renders as `+++ count;`. Matching `+++ `
    // unconditionally misreads it as a header, drops the line, and attributes
    // every later added line in the file to a phantom path. The next file's
    // real header must still be recognised once its `diff --git` leaves the
    // hunk.
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,0 +2,2 @@ ctx',
      '+++ count;',
      '+tail.clear();',
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -0,0 +1 @@',
      '+only line',
      '',
    ].join('\n');
    const got = parseAddedLines(diff);
    expect(got.get('src/a.ts')).toEqual([2, 3]);
    expect(got.get('src/b.ts')).toEqual([1]);
    expect(got.has('count;')).toBe(false);
  });
});

describe('selectMutants', () => {
  const src = (lines: string[]) => lines.join('\n');
  const all = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it('selects the dogfood shape: one safety statement inside a guarded branch', () => {
    // The finding the revert probe is structurally blind to: the sole
    // statement of a not-continued branch. Deleting it leaves `{}` — legal —
    // and the file still carries its other, tested behaviour. The comment
    // above it must not block the walk back to the `{` that proves the line
    // stands alone.
    const content = src([
      'export function onPrompt(continued: boolean) {',
      '  if (!continued) {',
      "    // an abandoned task's todos must not bleed into a new prompt",
      '    reminders.clear();',
      '  }',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      {
        file: 'src/todo.ts',
        content,
        addedLines: [2, 3, 4, 5],
        hasNewTests: false,
      },
    ]);
    expect(got).toEqual([
      { file: 'src/todo.ts', line: 4, statement: 'reminders.clear();' },
    ]);
  });

  it('matches the whole safety-verb set', () => {
    const content = src([
      'cache.delete(key);',
      'state.reset();',
      'ctrl.abort();',
      "emitter.removeListener('tick', onTick);",
      'timer.unref();',
      'this.pending = [];',
      'this.timers = new Map();',
      'this.subs = new Map<string, Sub>();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(8), hasNewTests: false },
    ]);
    expect(got.map((c) => c.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('matches Set, WeakMap, and WeakSet reassignments', () => {
    const content = src([
      'this.set = new Set();',
      'this.wm = new WeakMap();',
      'this.ws = new WeakSet();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(3), hasNewTests: false },
    ]);
    expect(got.map((c) => c.line)).toEqual([1, 2, 3]);
  });

  it('skips a modifier-less class field that only looks like an assignment', () => {
    // `cache = new Map();` in a class body matches the safety-verb set and
    // balances its delimiters, but it is a field DECLARATION: deleting it breaks
    // the compile (a wasted run) or, if unused, survives and files a false
    // finding. A statement inside a method body is enclosed by the method's
    // brace, not the class's, and must still be selected.
    const content = src([
      'class Store {',
      '  cache = new Map();',
      '  reset() {',
      '    this.cache.clear();',
      '  }',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(6), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 4, statement: 'this.cache.clear();' },
    ]);
  });

  it('skips a class field when the class header spans multiple lines', () => {
    const content = src([
      'class Store',
      '  extends Base',
      '{',
      '  cache = new Map();',
      '  reset() {',
      '    this.cache.clear();',
      '  }',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(8), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 6, statement: 'this.cache.clear();' },
    ]);
  });

  it('skips a class field when the extends clause has an inline object type', () => {
    // `extends Base<{ foo: string }>` has balanced braces on its own line.
    // The backward walk must not break there — only a net-unbalanced brace
    // (a real block boundary) stops it — or the `class` keyword on the line
    // above is never reached and the field is admitted.
    const content = src([
      'class Store',
      '  extends Base<{ foo: string }>',
      '{',
      '  cache = new Map();',
      '  reset() {',
      '    this.cache.clear();',
      '  }',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(8), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 6, statement: 'this.cache.clear();' },
    ]);
  });

  it('selects a method-body statement when the method is the first class member', () => {
    // The backward walk from the method's `{` reaches `class Store {` on the
    // very first step. The `[;{}]` stop must fire before the `class` match on
    // that same line, or the walk overshoots into the class header and rejects
    // a statement that is inside the method body, not the class body.
    const content = src([
      'class Store {',
      '  reset() {',
      '    this.cache.clear();',
      '  }',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(5), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 3, statement: 'this.cache.clear();' },
    ]);
  });

  it('skips what it cannot delete whole — declarations, headers, fragments', () => {
    // Every line here contains a safety verb; none is a deletable statement.
    // False negatives are fine, but each false positive wastes a suite run —
    // or worse, `if (stale)` above a call would silently rebind the NEXT
    // statement to the `if` when the call is deleted.
    const content = src([
      'const fresh = new Map();', // declaration
      'if (done) pending.delete(id);', // control-flow header on the line
      'register(', // opener …
      '  bar.clear(),', // … argument, not `;`-terminated
      ');', // … tail
      'chain', // receiver …
      '  .clear();', // … fluent tail, starts with `.`
      'const n = base +', // continuation …
      '  offsets.delete(k);', // … its tail
      'if (stale)', // brace-less if …
      '  cache.clear();', // … its sole statement
      'this.items = [1];', // not reassignment-to-EMPTY
      'this.map = new Map(entries);', // not reassignment-to-empty either
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(13), hasNewTests: false },
    ]);
    expect(got).toEqual([]);
  });

  it('rejects a multi-statement line even when a safety verb matches', () => {
    // Two statements on one line: deleting the whole line removes BOTH, and
    // the extra deletion can MASK a missing test on the safety verb.
    const content = src([
      'export function reset() {',
      "  this.cache.clear(); this.emit('reset');",
      '  live.clear();',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: [2, 3], hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 3, statement: 'live.clear();' },
    ]);
  });

  it('skips safety-verb text inside template literals and comment blocks', () => {
    // Deleting a line of string or commented-out code changes no behaviour, so
    // its mutant would ALWAYS survive — a guaranteed false finding.
    const content = src([
      'const brief = `',
      '  sessions.clear();',
      '`;',
      '/*',
      'old.clear();',
      '*/',
      'live.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(7), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 7, statement: 'live.clear();' },
    ]);
  });

  it('keeps line accounting across a string that swallows its line end', () => {
    // A `\`-continued string is legal JS whose literal contains the newline. A
    // scanner that consumes that newline drops one per-line flag and every
    // later line reads its NEIGHBOUR's literal-state — here that would admit
    // line 4, which starts inside a block comment: deleting it removes the
    // `*/` and comments out the code below, a mutant nobody asked for.
    const content = src([
      "const s = 'weird \\",
      "tail';",
      '/* block',
      'note */ cache.clear();',
      'after.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(5), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 5, statement: 'after.clear();' },
    ]);
  });

  it('keeps line accounting across a backslash-continued template literal', () => {
    // The template-state escape skip must not swallow a `\`-continued line's
    // newline: doing so drops a per-line flag and shifts every later verdict
    // onto its neighbour — here that would admit line 4, which starts inside a
    // block comment, so deleting it removes the `*/` and comments out the code
    // below. Mirrors the single-quote case above for the template branch.
    const content = src([
      'const brief = `weird \\',
      'tail`;',
      '/* block',
      'note */ cache.clear();',
      'after.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(5), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 5, statement: 'after.clear();' },
    ]);
  });

  it('does not let a nested template inside ${} close the outer literal', () => {
    // A backtick inside a `${…}` interpolation opens a NESTED template.
    // Reading it as the outer close marks the outer literal's remaining lines
    // as code, and the template TEXT `baz.clear();` becomes a candidate whose
    // deletion compiles and survives — a false finding filed against string
    // content. Real code after the outer literal must still be selected.
    const content = src([
      'const x = `foo ${`bar;',
      'baz.clear();',
      '`} qux`;',
      'after.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(4), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 4, statement: 'after.clear();' },
    ]);
  });

  it('does not let a regex literal in an interpolation swallow later code', () => {
    // A regex literal is not a string: skipping from the `'` in `/'/g` to a
    // matching quote runs past the interpolation's `}` (no closing quote on the
    // line), so the scanner never leaves the template, its end state is not
    // `code`, and a real safety statement on the next line is silently dropped.
    // Not skipping quotes inside an interpolation keeps the brace depth honest;
    // the statement must be selected.
    const content = src([
      'const q = `${x.replace(/\'/g, "")}`;',
      'items.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(2), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 2, statement: 'items.clear();' },
    ]);
  });

  it('does not let a } in nested-template text close the outer interpolation', () => {
    // A `}` in a nested template's TEXT (not its own interpolation) must not
    // decrement the outer interpDepth. Without the nested-template sub-scan,
    // the depth drops to 0 and the nested close backtick reads as the outer
    // close, admitting the outer literal's remaining text as code.
    const content = src([
      'const x = `a${x + `b } c`}d',
      'items.clear();',
      '`;',
      'after.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(4), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 4, statement: 'after.clear();' },
    ]);
  });

  it('keeps outer-template text after a nested template whose text holds a }', () => {
    // The #8020 trigger. A `}` in the nested template's TEXT must not read as
    // the end of the outer interpolation: with a depth counter it drained the
    // depth to zero, the nested close backtick then read as the OUTER close,
    // and the template text `sessions.clear();` — a non-executable line —
    // became a deletion mutant whose survival was a guaranteed false finding.
    const content = src([
      'const x = `text ${ foo(`nested }`) };',
      'sessions.clear();',
      '`;',
      'after.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(4), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 4, statement: 'after.clear();' },
    ]);
  });

  it('tracks a nested template inside a nested interpolation (two levels)', () => {
    // Same trigger one level deeper: the deep template's text `}` must only be
    // text. A single nesting counter cannot represent this — it mis-assigns
    // the `}` to the nested interpolation, reads the rest of the line out of
    // phase, and either admits the template text `sessions.clear();` or ends
    // the scan derailed and silently drops the REAL candidate on line 4. Only
    // a stack of template/interpolation frames gets both lines right.
    const content = src([
      'const x = `text ${ foo(`nested ${ bar(`deep }`) } tail`) };',
      'sessions.clear();',
      '`;',
      'after.clear();',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(4), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 4, statement: 'after.clear();' },
    ]);
  });

  it('treats a lone ${ left unclosed at EOF as a derailed scan, not code', () => {
    // An interpolation that never closes leaves every later line's state
    // unknowable. The scan must end non-`code` so the file's candidates are
    // dropped (and disclosed), never trusted.
    const content = src(['const x = `text ${ foo(', 'sessions.clear();', '']);
    const { selected, derailed } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(2), hasNewTests: false },
    ]);
    expect(selected).toEqual([]);
    expect(derailed).toEqual(['src/s.ts']);
  });

  it('does not read a single-line nested-template interpolation as code', () => {
    // The same nesting on one line: skipping from the outer backtick to the
    // NEXT backtick exposes the inner template's content (`key.reset(`) as
    // code, so a verb that is actually string content matches and a valid
    // template assignment is selected and deleted — a wasted run and a false
    // finding.
    const content = src([
      'export function summarize(entries: Entry[]) {',
      "  summary = `Results: ${entries.map((e) => `key.reset(${e.id})`).join('; ')};`;",
      '  live.clear();',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: [2, 3], hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 3, statement: 'live.clear();' },
    ]);
  });

  it('rejects a class field below a template whose text contains a brace', () => {
    // The class-body walk reads code lines, not raw text: a multi-line
    // template whose CONTENT holds an unmatched `{` (agent briefs embed JSON
    // examples) would otherwise read as an opening brace, stop the walk before
    // the class header, and admit the field — deleting a declaration, not a
    // cleanup. The method-body statement below it must still be selected.
    const content = src([
      'class Store {',
      '  brief = `',
      '    docs with { brace',
      '  `;',
      '  cache = new Map();',
      '  reset() {',
      '    this.cache.clear();',
      '  }',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: all(9), hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 7, statement: 'this.cache.clear();' },
    ]);
  });

  it('sees through a trailing comment on the candidate and its predecessor', () => {
    // The end-anchored checks run on the code portion only. A trailing comment
    // must not hide the candidate's `;` (dropping a genuine reset) nor the
    // predecessor's statement end — `reminders.clear(); // why` is exactly the
    // dogfood shape this probe was built to catch.
    const content = src([
      'export function reset() {',
      '  const x = setup(); // prepare',
      '  reminders.clear(); // why',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: [2, 3], hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 3, statement: 'reminders.clear(); // why' },
    ]);
  });

  it('does not select a safety verb that only appears inside a string', () => {
    // A verb inside a string is not a statement: deleting the line removes a
    // log call, the suite stays green, and a misleading `mutant-survived`
    // finding is filed — a false positive that also burns a suite run.
    const content = src([
      'export function report() {',
      '  logger.info("sessions.clear() done");',
      '  live.clear();',
      '}',
      '',
    ]);
    const { selected: got } = selectMutants([
      { file: 'src/s.ts', content, addedLines: [2, 3], hasNewTests: false },
    ]);
    expect(got).toEqual([
      { file: 'src/s.ts', line: 3, statement: 'live.clear();' },
    ]);
  });

  it('discards ALL candidates from a file whose scan derails, and names the file', () => {
    // A backtick inside a regex literal flips the scanner into template state
    // through to EOF. Even the valid candidate before the derailment is
    // discarded — the scan is untrustworthy past it, and over-rejecting is the
    // cheap error. The file comes back in `derailed` so the caller can
    // disclose the dropped candidates instead of reporting a silent zero. A
    // clean sibling file's candidates are unaffected.
    const content = src([
      'state.clear();',
      'const re = /`/;',
      'other.clear();',
      '',
    ]);
    const { selected, derailed } = selectMutants([
      { file: 'src/s.ts', content, addedLines: [1, 2, 3], hasNewTests: false },
      {
        file: 'src/clean.ts',
        content: src(['live.clear();', '']),
        addedLines: [1],
        hasNewTests: false,
      },
    ]);
    expect(selected).toEqual([
      { file: 'src/clean.ts', line: 1, statement: 'live.clear();' },
    ]);
    expect(derailed).toEqual(['src/s.ts']);
  });

  it('caps at MAX_MUTANTS, preferring files that also have new tests', () => {
    const line = (i: number) => `store${i}.clear();`;
    const content = src([...all(5).map(line), '']);
    const { selected: got, skippedForCap } = selectMutants([
      // Diff order says untested first; the preference must still put every
      // candidate from the tested file ahead of it, and the cap then keeps
      // the untested file's EARLIEST lines.
      {
        file: 'src/untested.ts',
        content,
        addedLines: all(5),
        hasNewTests: false,
      },
      { file: 'src/tested.ts', content, addedLines: all(5), hasNewTests: true },
    ]);
    expect(MAX_MUTANTS).toBe(8);
    expect(got).toHaveLength(8);
    expect(skippedForCap).toBe(2);
    expect(got.slice(0, 5).map((c) => c.file)).toEqual(
      Array(5).fill('src/tested.ts'),
    );
    expect(got.slice(5).map((c) => [c.file, c.line])).toEqual([
      ['src/untested.ts', 1],
      ['src/untested.ts', 2],
      ['src/untested.ts', 3],
    ]);
  });
});

describe('hasCollocatedNewTest', () => {
  it('pairs file.ts with its collocated file.test.ts / file.spec.ts', () => {
    expect(
      hasCollocatedNewTest('packages/cli/src/x.ts', [
        'packages/cli/src/x.test.ts',
      ]),
    ).toBe(true);
    expect(
      hasCollocatedNewTest('packages/cli/src/x.ts', [
        'packages/cli/src/x.spec.ts',
      ]),
    ).toBe(true);
    expect(
      hasCollocatedNewTest('packages/cli/src/Comp.tsx', [
        'packages/cli/src/Comp.test.tsx',
      ]),
    ).toBe(true);
  });

  it('does not pair across directories or by basename suffix', () => {
    expect(
      hasCollocatedNewTest('packages/cli/src/x.ts', [
        'packages/core/src/x.test.ts',
      ]),
    ).toBe(false);
    // `xy.test.ts` must not satisfy `y.ts` — stem equality, not endsWith.
    expect(
      hasCollocatedNewTest('packages/cli/src/y.ts', [
        'packages/cli/src/xy.test.ts',
      ]),
    ).toBe(false);
  });
});

describe('collocatedProbe', () => {
  it('returns the collocated test path when one is in the probe set', () => {
    expect(
      collocatedProbe('packages/cli/src/x.ts', [
        'packages/cli/src/other.test.ts',
        'packages/cli/src/x.test.ts',
      ]),
    ).toBe('packages/cli/src/x.test.ts');
    expect(
      collocatedProbe('packages/cli/src/x.ts', ['packages/cli/src/x.spec.ts']),
    ).toBe('packages/cli/src/x.spec.ts');
  });

  it('returns undefined when no collocated test is probed', () => {
    // A different directory, or a basename-suffix collision, is not collocated.
    expect(
      collocatedProbe('packages/cli/src/x.ts', [
        'packages/core/src/x.test.ts',
        'packages/cli/src/xy.test.ts',
      ]),
    ).toBeUndefined();
  });
});

describe('runnerFailureReason', () => {
  // Driven through the real spawnSync rather than hand-written strings: the
  // version this replaced matched a message the code never emits, and a
  // fabricated fixture is exactly what let that pass.
  it('calls a suite killed at the deadline one that did not survive', () => {
    const r = spawnSync(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 5000)'],
      { timeout: 300, encoding: 'utf8' },
    );
    // What node actually reports, and why the old message match failed:
    // `error` is set on a timeout, so the throw never reaches a
    // "runner killed by" sentence.
    expect(r.error?.message).toContain('ETIMEDOUT');
    expect(runnerFailureReason(r)).toBe('runner-died');
  });

  it('calls a runner that could not start one that never ran', () => {
    const r = spawnSync('/nonexistent/vitest-bin', [], { encoding: 'utf8' });
    expect(r.error?.message).toContain('ENOENT');
    expect(r.signal).toBeNull();
    expect(runnerFailureReason(r)).toBe('not-run');
  });

  it('calls a plain failure before any spawn one that never ran', () => {
    expect(runnerFailureReason({})).toBe('not-run');
  });
});

describe('collocatedNotGreenDetail', () => {
  const perFile = [
    { file: 'packages/cli/src/red.test.ts', verdict: 'gated' as const },
    {
      file: 'packages/cli/src/empty.test.ts',
      verdict: 'inconclusive' as const,
      // The union requires it, which is the point: a fixture cannot stand for
      // an untagged `inconclusive` because the code cannot produce one.
      reason: 'no-tests' as const,
    },
  ];

  it('says the test was red when the baseline collected it and it failed', () => {
    // The case that produced this function: on PR #8368 AuthDialog.test.tsx
    // compiled and ran 26 tests, one of which failed. Reporting that as an
    // import error sends the reader to a file that imports fine.
    const detail = collocatedNotGreenDetail(
      'mutant',
      'packages/cli/src/red.test.ts',
      perFile,
    );
    expect(detail).toContain('was RED there');
    expect(detail).not.toContain('compile or import error');
  });

  it.each(['not-run', 'runner-died', 'control-failed'] as const)(
    'refuses to explain %s, which a baseline entry cannot carry',
    (reason) => {
      // These are set on the run-level results array, never by
      // classifyProbeRun. Rendered inside this sentence, `control-failed`
      // would read "did not run green … it read green there".
      const detail = collocatedNotGreenDetail(
        'mutant',
        'packages/cli/src/x.test.ts',
        [
          {
            file: 'packages/cli/src/x.test.ts',
            verdict: 'inconclusive' as const,
            reason,
          },
        ],
      );
      expect(detail).toContain('the baseline did not classify it');
      expect(detail).toContain('does not apply');
    },
  );

  it('refuses to explain a probe the baseline reported GREEN', () => {
    // `inert` is what greenProbes is built from, so this sentence does not
    // apply to it. The production caller cannot get here; the export can, and
    // a fluent claim contradicting the measurement is worse than saying so.
    const detail = collocatedNotGreenDetail(
      'mutant',
      'packages/cli/src/green.test.ts',
      [{ file: 'packages/cli/src/green.test.ts', verdict: 'inert' as const }],
    );
    expect(detail).toContain('reported it GREEN');
    expect(detail).toContain('does not apply');
  });

  it('says the baseline never reported a probe it has no entry for', () => {
    // Absent is an evidentiary hole, never the claim that its tests failed —
    // and not the claim that it collected nothing either, which is a
    // measurement the baseline never took.
    const detail = collocatedNotGreenDetail(
      'mutant',
      'packages/cli/src/absent.test.ts',
      perFile,
    );
    expect(detail).toContain('did not report it');
    expect(detail).not.toContain('RED');
  });

  it.each([
    ['no-output', 'produced no parseable output', 'nothing at all is known'],
    ['no-tests', 'collected no tests there', 'compile or import error'],
    ['all-skipped', 'executed none of them', 'collected tests there'],
    [
      'not-in-results',
      'produced results there but none for it',
      'a path that did not match',
    ],
  ])(
    'names %s as the reason rather than guessing one',
    (reason, phrase, alsoPhrase) => {
      const detail = collocatedNotGreenDetail(
        'mutant',
        'packages/cli/src/x.test.ts',
        [
          {
            file: 'packages/cli/src/x.test.ts',
            verdict: 'inconclusive' as const,
            reason: reason as ProbeReason,
          },
        ],
      );
      expect(detail).toContain(phrase);
      expect(detail).toContain(alsoPhrase);
      // The runner falling over is not a compile error, and the message that
      // says so is the whole point of carrying the reason.
      if (reason === 'no-output') {
        expect(detail).not.toContain('compile or import error');
      }
    },
  );

  it('names the probe and what the passing probes cannot show, per kind', () => {
    expect(
      collocatedNotGreenDetail(
        'mutant',
        'packages/cli/src/red.test.ts',
        perFile,
      ),
    ).toBe(
      "this mutant's collocated test packages/cli/src/red.test.ts did not run green in the unmutated baseline — it was RED there, so the remaining probes passing cannot show the statement is uncovered",
    );
    expect(
      collocatedNotGreenDetail('hunk', 'packages/cli/src/red.test.ts', perFile),
    ).toContain('cannot show the hunk is uncovered');
  });
});

describe('heldForRedCollocatedTest — the one decision both loops make', () => {
  const perFile = [
    {
      file: 'packages/cli/src/x.test.ts',
      verdict: 'gated' as const,
    },
    {
      file: 'packages/cli/src/ok.test.ts',
      verdict: 'inert' as const,
    },
  ];
  const probes = ['packages/cli/src/x.test.ts', 'packages/cli/src/ok.test.ts'];

  it('holds when the collocated test was not green, and explains why', () => {
    const detail = heldForRedCollocatedTest(
      'mutant',
      'packages/cli/src/x.ts',
      probes,
      ['packages/cli/src/ok.test.ts'],
      perFile,
    );
    expect(detail).toContain('was RED there');
    expect(detail).toContain('packages/cli/src/x.test.ts');
  });

  it('does not hold when the collocated test was green', () => {
    expect(
      heldForRedCollocatedTest(
        'hunk',
        'packages/cli/src/ok.ts',
        probes,
        ['packages/cli/src/ok.test.ts'],
        perFile,
      ),
    ).toBeUndefined();
  });

  it('does not hold when the file has no collocated probe at all', () => {
    // No covering test was measured either way, so this guard has nothing to
    // say — the other probes decide.
    expect(
      heldForRedCollocatedTest(
        'mutant',
        'packages/cli/src/untested.ts',
        probes,
        [],
        perFile,
      ),
    ).toBeUndefined();
  });
});

describe('classifyMutantRun', () => {
  // Verdicts flow through the SAME per-file classifier the revert probe uses,
  // so these fixtures are the vitest-JSON shapes classifyProbeRun already
  // understands — what is under test is the mutant-level aggregation.
  const perFile = (exit: number, json: unknown, probes: string[]) =>
    classifyProbeRun(exit, JSON.stringify(json), probes);

  it('SURVIVED when every affected test still passes', () => {
    const got = classifyMutantRun(
      perFile(
        0,
        {
          testResults: [
            { name: '/w/a.test.ts', assertionResults: [{ status: 'passed' }] },
          ],
        },
        ['a.test.ts'],
      ),
    );
    expect(got).toBe('survived');
  });

  it('KILLED when any assertion fails — the deletion was caught', () => {
    const got = classifyMutantRun(
      perFile(
        1,
        {
          testResults: [
            { name: '/w/a.test.ts', assertionResults: [{ status: 'passed' }] },
            { name: '/w/b.test.ts', assertionResults: [{ status: 'failed' }] },
          ],
        },
        ['a.test.ts', 'b.test.ts'],
      ),
    );
    expect(got).toBe('killed');
  });

  it('INCONCLUSIVE when the mutant breaks the compile, never killed', () => {
    // The revert probe's trap, inherited: a run that collected nothing is not
    // a test catching the deletion.
    const got = classifyMutantRun(
      perFile(1, { testResults: [] }, ['a.test.ts']),
    );
    expect(got).toBe('inconclusive');
  });

  it('does not let a green sibling upgrade a non-collected file to SURVIVED', () => {
    // The file that failed to collect might be the very one that would have
    // caught the deletion — "survived" requires every file to have run.
    const got = classifyMutantRun(
      perFile(
        0,
        {
          testResults: [
            { name: '/w/a.test.ts', assertionResults: [{ status: 'passed' }] },
          ],
        },
        ['a.test.ts', 'b.test.ts'],
      ),
    );
    expect(got).toBe('inconclusive');
  });

  it('a kill outranks an inconclusive sibling — red is red', () => {
    const got = classifyMutantRun(
      perFile(
        1,
        {
          testResults: [
            { name: '/w/a.test.ts', assertionResults: [{ status: 'failed' }] },
          ],
        },
        ['a.test.ts', 'b.test.ts'],
      ),
    );
    expect(got).toBe('killed');
  });

  it('an empty run proves nothing', () => {
    expect(classifyMutantRun([])).toBe('inconclusive');
  });
});

describe('fitsAnotherMutantRun', () => {
  it('requires room for one more mutant run — the revert is reserved by the deadline', () => {
    expect(fitsAnotherMutantRun(60_000, 60_000)).toBe(true);
    expect(fitsAnotherMutantRun(59_999, 60_000)).toBe(false);
    expect(fitsAnotherMutantRun(0, 60_000)).toBe(false);
  });
});

describe('splitDiffIntoHunks', () => {
  const DIFF = [
    'diff --git a/src/x.ts b/src/x.ts',
    'index 111..222 100644',
    '--- a/src/x.ts',
    '+++ b/src/x.ts',
    '@@ -1,3 +1,4 @@',
    ' const a = 1;',
    '+const added = 2;',
    ' const b = 3;',
    ' const c = 4;',
    '@@ -20,3 +21,3 @@',
    ' const p = 1;',
    '-const q = 2;',
    '+const q = 99;',
    ' const r = 3;',
    '',
  ].join('\n');

  it('returns one self-contained patch per hunk', () => {
    const hunks = splitDiffIntoHunks(DIFF);
    expect(hunks.map((h) => h.header)).toEqual([
      '@@ -1,3 +1,4 @@',
      '@@ -20,3 +21,3 @@',
    ]);
    // Each patch carries the file header, so `git apply` can place it alone.
    for (const h of hunks) {
      expect(h.patch).toContain('diff --git a/src/x.ts b/src/x.ts');
      expect(h.patch).toContain('--- a/src/x.ts');
      expect(h.patch).toContain('+++ b/src/x.ts');
      expect(h.patch.endsWith('\n')).toBe(true);
    }
    // And ONLY its own hunk — the whole point of splitting.
    expect(hunks[0].patch).toContain('+const added = 2;');
    expect(hunks[0].patch).not.toContain('const q = 99;');
    expect(hunks[1].patch).toContain('+const q = 99;');
    expect(hunks[1].patch).not.toContain('const added = 2;');
  });

  it('anchors startLine at the first ADDED line, past the context prefix', () => {
    // DIFF's first hunk opens with one context line before its `+` (2), the
    // second with one before its change (22) — anchoring at the header start
    // pointed findings at untouched context.
    expect(splitDiffIntoHunks(DIFF).map((h) => h.startLine)).toEqual([2, 22]);
  });

  it('does not let a "\\ No newline" marker inflate startLine', () => {
    // The marker corresponds to no file line; counting it as context shifts
    // startLine off by one per marker, while parseAddedLines already excludes it.
    const d = [
      'diff --git a/f b/f',
      '--- a/f',
      '+++ b/f',
      '@@ -1,2 +1,2 @@',
      ' const same = 1;',
      '-const old = 2;',
      '\\ No newline at end of file',
      '+const new = 2;',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(splitDiffIntoHunks(d).map((h) => h.startLine)).toEqual([2]);
  });

  it('does not mistake a removed line whose text begins `@@` for a header', () => {
    // In a unified diff every body line is prefixed, so `-@@ x` is content.
    const d = [
      'diff --git a/a.md b/a.md',
      '--- a/a.md',
      '+++ b/a.md',
      '@@ -1,2 +1,2 @@',
      '-@@ old marker',
      '+@@ new marker',
      '',
    ].join('\n');
    const hunks = splitDiffIntoHunks(d);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].patch).toContain('-@@ old marker');
  });

  it('gives each hunk ITS OWN file header on a multi-file diff', () => {
    const d = [
      'diff --git a/one.ts b/one.ts',
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1,1 +1,1 @@',
      '-const a = 1;',
      '+const a = 2;',
      'diff --git a/two.ts b/two.ts',
      '--- a/two.ts',
      '+++ b/two.ts',
      '@@ -5,1 +5,1 @@',
      '-const b = 1;',
      '+const b = 2;',
      '',
    ].join('\n');
    const hunks = splitDiffIntoHunks(d);
    expect(hunks).toHaveLength(2);
    // The second patch must name the second file, or git applies it to the wrong one.
    expect(hunks[1].patch).toContain('diff --git a/two.ts b/two.ts');
    expect(hunks[1].patch).not.toContain('one.ts');
    expect(hunks[0].patch).not.toContain('two.ts');
  });

  it('returns nothing for a diff with no hunks (a binary file)', () => {
    expect(
      splitDiffIntoHunks(
        'diff --git a/i.png b/i.png\nBinary files a/i.png and b/i.png differ\n',
      ),
    ).toEqual([]);
    expect(splitDiffIntoHunks('')).toEqual([]);
  });

  it("does not swallow a binary file into the next file's header", () => {
    // A binary entry has no `@@` hunks; the boundary scan must stop at the
    // next `diff --git` rather than running past it into the next file.
    const d = [
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,1 +1,1 @@',
      '-const a = 1;',
      '+const a = 2;',
      '',
    ].join('\n');
    const hunks = splitDiffIntoHunks(d);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].patch).toContain('diff --git a/src/x.ts b/src/x.ts');
    expect(hunks[0].patch).not.toContain('img.png');
  });
});

describe('selectHunkProbes', () => {
  const diffOf = (...hunks: Array<[number, number]>) =>
    [
      'diff --git a/f b/f',
      '--- a/f',
      '+++ b/f',
      ...hunks.map(
        ([start, len]) => `@@ -${start},${len} +${start},${len} @@\n x`,
      ),
      '',
    ].join('\n');

  const file = (over: Record<string, unknown> = {}) => ({
    file: 'src/a.ts',
    diff: diffOf([1, 3], [20, 3]),
    hasNewTests: false,
    mutantLines: [] as number[],
    ...over,
  });

  it('produces one candidate per hunk', () => {
    const { selected } = selectHunkProbes([file()]);
    expect(selected.map((c) => c.startLine)).toEqual([1, 20]);
    expect(selected.map((c) => c.index)).toEqual([0, 1]);
  });

  it('skips a hunk a mutant already covers, and keeps the others', () => {
    // The mutant ran the finer-grained experiment on those lines; a second run
    // over the whole hunk buys a coarser answer at the same price.
    const { selected } = selectHunkProbes([file({ mutantLines: [2] })]);
    expect(selected.map((c) => c.startLine)).toEqual([20]);
  });

  it('does not overshoot the hunk end into a later, unrelated mutant', () => {
    // The overlap range is the header's new-side span [start, start+len). The
    // old code anchored it at the first ADDED line (past leading context) and added
    // the full new-side length, overshooting the real end by the context-line count
    // — so a mutant just past the hunk wrongly skipped it and lost probe coverage.
    const diff = [
      'diff --git a/f b/f',
      '--- a/f',
      '+++ b/f',
      '@@ -1,3 +1,4 @@',
      ' const a = 1;',
      '+const added = 2;',
      ' const b = 3;',
      ' const c = 4;',
      '',
    ].join('\n');
    // Hunk covers new-side lines 1-4; a mutant at 5 is outside it and must NOT
    // cause the hunk to be skipped.
    const { selected } = selectHunkProbes([
      { file: 'f', diff, hasNewTests: false, mutantLines: [5] },
    ]);
    expect(selected).toHaveLength(1);
  });

  it('puts files whose collocated tests the diff also touches first', () => {
    const { selected } = selectHunkProbes([
      file({ file: 'src/plain.ts', diff: diffOf([1, 1]) }),
      file({ file: 'src/tested.ts', diff: diffOf([1, 1]), hasNewTests: true }),
    ]);
    expect(selected.map((c) => c.file)).toEqual([
      'src/tested.ts',
      'src/plain.ts',
    ]);
  });

  it('COUNTS what the cap drops rather than losing it', () => {
    // A capped `survived: 0` that read as "every change is covered" is exactly
    // the false assurance the mutant cap already guards against.
    const many = Array.from({ length: MAX_HUNK_PROBES + 3 }, (_, i) =>
      file({ file: `src/f${i}.ts`, diff: diffOf([1, 1]) }),
    );
    const { selected, skippedForCap } = selectHunkProbes(many);
    expect(selected).toHaveLength(MAX_HUNK_PROBES);
    expect(skippedForCap).toBe(3);
  });

  it('skips deleted files rather than spending cap slots on them', () => {
    // A deleted file's hunks are all removals; runOneHunkProbe reads the file
    // first and returns `inconclusive` every time.
    const deleted = {
      file: 'src/gone.ts',
      diff: [
        'diff --git a/src/gone.ts b/src/gone.ts',
        'deleted file mode 100644',
        '--- a/src/gone.ts',
        '+++ /dev/null',
        '@@ -1,3 +0,0 @@',
        '-const a = 1;',
        '-const b = 2;',
        '-const c = 3;',
        '',
      ].join('\n'),
      hasNewTests: false,
      mutantLines: [] as number[],
    };
    const { selected } = selectHunkProbes([deleted, file()]);
    expect(selected.every((c) => c.file !== 'src/gone.ts')).toBe(true);
    expect(selected.length).toBeGreaterThan(0);
  });

  it('skips added files whose reverse-apply deletes the whole file', () => {
    // An added file's hunk probe reverse-applies to a deletion — guaranteed
    // inconclusive when a probe imports it, and a file-level statement wearing
    // a hunk-level message when nothing does.
    const added = {
      file: 'src/new.ts',
      diff: [
        'diff --git a/src/new.ts b/src/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/new.ts',
        '@@ -0,0 +1,3 @@',
        '+const a = 1;',
        '+const b = 2;',
        '+const c = 3;',
        '',
      ].join('\n'),
      hasNewTests: false,
      mutantLines: [] as number[],
    };
    const { selected } = selectHunkProbes([added, file()]);
    expect(selected.every((c) => c.file !== 'src/new.ts')).toBe(true);
    expect(selected.length).toBeGreaterThan(0);
  });

  it('has nothing to probe when every hunk is mutant-covered', () => {
    const { selected, skippedForCap } = selectHunkProbes([
      file({ mutantLines: [2, 21] }),
    ]);
    expect(selected).toEqual([]);
    expect(skippedForCap).toBe(0);
  });
});

describe('selectMutants — replacement operators', () => {
  const fileOf = (content: string, addedLines: number[]) => ({
    file: 'src/m.ts',
    content,
    addedLines,
    hasNewTests: false,
  });

  it('selects a replacement candidate on a diff with no safety verbs', () => {
    const { selected } = selectMutants([
      fileOf('const model = pick() ?? config.getModel();\n', [1]),
    ]);
    expect(selected).toEqual([
      {
        file: 'src/m.ts',
        line: 1,
        statement: 'const model = pick() ?? config.getModel();',
        operator: 'coalesce',
        mutated: 'const model = pick();',
      },
    ]);
  });

  it('spends the cap on deletion mutants BEFORE replacement ones', () => {
    const { selected, skippedForCap } = selectMutants(
      [fileOf('if (a !== b) go();\nstate.clear();\n', [1, 2])],
      1,
    );
    expect(selected).toHaveLength(1);
    expect(selected[0].statement).toBe('state.clear();');
    expect(selected[0].operator).toBeUndefined();
    expect(skippedForCap).toBe(1);
  });

  it('caps replacements at their sub-cap and counts what it drops', () => {
    // 24x pool inflation measured on real commits: uncapped replacements would
    // drain the time window hunk probes draw from last, silently un-shipping
    // the hunk-survived finding class.
    const many = Array.from({ length: 6 }, (_, i) =>
      fileOf(`if (a${i} !== b${i}) go();\n`, [1]),
    ).map((f, i) => ({ ...f, file: `src/g${i}.ts` }));
    const { selected, skippedForCap } = selectMutants(many);
    expect(selected).toHaveLength(3); // REPLACEMENT_SUB_CAP
    expect(skippedForCap).toBe(3);
  });

  it('emits one candidate per line — a safety-verb line is not also mutated by replacement', () => {
    // The input must trigger BOTH paths or the `continue` under test is not
    // load-bearing: this line carries a safety verb AND a `?? fallback`, so
    // without the guard it would yield a replacement candidate too.
    const { selected } = selectMutants([
      fileOf('cache.delete(key) ?? fallback.reset();\n', [1]),
    ]);
    expect(selected).toHaveLength(1);
    expect(selected[0].operator).toBeUndefined(); // deletion won
  });
});

describe('replacementMutantsOf', () => {
  const same = (line: string) => replacementMutantsOf(line, line.trim());

  it('drops a simple `?? fallback`', () => {
    expect(same('  const m = pick() ?? config.getModel();')).toEqual({
      operator: 'coalesce',
      mutated: '  const m = pick();',
    });
  });

  it('leaves a `??` whose fallback is not a simple chain alone', () => {
    // Dropping part of `a ?? b + c` would truncate a larger expression.
    expect(same('const n = x ?? y + z;')).toBeNull();
  });

  it('drops a `+ UPPER_CONST` reserve term', () => {
    expect(
      same('  if (estimate + COMPACT_MAX_OUTPUT_TOKENS > window) {'),
    ).toEqual({
      operator: 'term-drop',
      mutated: '  if (estimate > window) {',
    });
  });

  it('replaces a comparison-bearing if condition with true', () => {
    expect(same('  if (effective !== config.getModel()) {')).toEqual({
      operator: 'guard-true',
      mutated: '  if (true) {',
    });
  });

  it('PRESERVES leading whitespace when editing a trimmed code view', () => {
    // The shipped-then-caught bug: codeLines are trimmed, so an index computed
    // there and applied to the raw line spliced `iftrue 0)` into a guard. The
    // edit is now computed on the code view and re-indented.
    const raw = '      if (n <= 0) return 0;';
    expect(replacementMutantsOf(raw, 'if (n <= 0) return 0;')).toEqual({
      operator: 'guard-true',
      mutated: '      if (true) return 0;',
    });
  });

  it('yields NOTHING when the raw line and the code view disagree', () => {
    // A string or comment was blanked out of the code view — indices cannot be
    // trusted across the two, so the line is conservatively skipped.
    expect(
      replacementMutantsOf(
        "  if (s === ')') { fire(); }",
        "if (s === '') { fire(); }",
      ),
    ).toBeNull();
  });

  it('handles nested parens in the condition', () => {
    expect(same('if (a(b) !== c(d, e(f))) return;')).toEqual({
      operator: 'guard-true',
      mutated: 'if (true) return;',
    });
  });

  it('does not read a GENERIC call as a comparison', () => {
    // `if (isRecord<string>(v))` is a type-guard predicate — the `if (ready)`
    // shape whose survivors this gate calls noise. Telling `a<b` from
    // `fn<T>(x)` needs a parser, so the gate stays silence-biased.
    expect(same('if (isRecord<string>(v)) return;')).toBeNull();
    expect(same('if (fn<Bar>(x)) go();')).toBeNull();
    // A spaced comparison still qualifies.
    expect(same('if (n <= 0) return 0;')?.operator).toBe('guard-true');
  });

  it('does not read an arrow function as a comparison', () => {
    // `=>` ends in `>` followed by a space, so the old class matched it and
    // every predicate guard became a guard-true candidate — exactly the
    // `if (ready)` noise the gate exists to exclude.
    expect(same('if (items.some((x) => x.ok)) return;')).toBeNull();
    expect(same('if (fn(() => run())) go();')).toBeNull();
    // A real comparison still qualifies.
    expect(same('if (a !== b) go();')?.operator).toBe('guard-true');
  });

  it('skips an if with no comparison, and one whose condition spans lines', () => {
    expect(same('if (ready) go();')).toBeNull();
    expect(same('if (a !== b &&')).toBeNull();
  });

  it('emits at most one candidate per line, most-specific first', () => {
    // Both a `??` and a comparison on one line: coalesce wins.
    expect(same('if ((x ?? fallback) !== y) go();')?.operator).toBe('coalesce');
  });
});
