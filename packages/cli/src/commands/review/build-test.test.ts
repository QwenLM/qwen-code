/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runBuildTest,
  rebaseToRepoRoot,
  trimOutput,
  unresolvedWorkspaceDeps,
  buildRunEnv,
} from './build-test.js';
import {
  npmToolchainAdapter,
  unresolvedWorkspaceDeps as toolchainUnresolvedWorkspaceDeps,
} from './lib/npm-toolchain.js';
import type { WorkspacePackage } from './lib/workspaces.js';

const statfsSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const mock = { ...actual, statfsSync: statfsSyncMock };
  return { ...mock, default: mock };
});

beforeEach(() => {
  // Plenty of disk by default, so this suite behaves the same on a nearly-full
  // machine as on an empty one — the low-disk cases below opt in explicitly.
  statfsSyncMock.mockReturnValue({ bavail: 16 * 1024 ** 3, bsize: 1 });
});

const PKGS: WorkspacePackage[] = [
  { dir: 'packages/core', name: '@x/core', scripts: ['build'], deps: [] },
  { dir: 'packages/webui', name: '@x/webui', scripts: ['build'], deps: [] },
];

describe('unresolvedWorkspaceDeps', () => {
  it('re-exports the npm-toolchain implementation', () => {
    // Pins the module boundary this PR establishes (npm specifics live in
    // lib/npm-toolchain.ts): reverting the re-export to an inline copy ships
    // green unless this identity is asserted.
    expect(unresolvedWorkspaceDeps).toBe(toolchainUnresolvedWorkspaceDeps);
  });

  it('finds the workspace package a TS2307 names', () => {
    const out =
      "src/a.ts(23,8): error TS2307: Cannot find module '@x/webui' or its " +
      'corresponding type declarations.';
    expect(unresolvedWorkspaceDeps(out, PKGS)).toEqual(['@x/webui']);
  });

  it('resolves a deep import back to its package', () => {
    const out = "Cannot find module '@x/core/dist/utils' or its corresponding";
    expect(unresolvedWorkspaceDeps(out, PKGS)).toEqual(['@x/core']);
  });

  it("reads a bundler's wording too", () => {
    expect(
      unresolvedWorkspaceDeps('✘ [ERROR] Could not resolve "@x/webui"', PKGS),
    ).toEqual(['@x/webui']);
  });

  it('ignores a third-party module — widening cannot fix it, and would loop', () => {
    // A missing npm dependency is a broken install or a real defect in the diff.
    // Adding it to the build set finds nothing to build and the loop spins.
    const out = "error TS2307: Cannot find module 'react' or its corresponding";
    expect(unresolvedWorkspaceDeps(out, PKGS)).toEqual([]);
  });

  it('returns nothing for output with no unresolved module at all', () => {
    expect(
      unresolvedWorkspaceDeps('src/a.ts(1,1): error TS2345: nope', PKGS),
    ).toEqual([]);
  });
});

describe('buildRunEnv', () => {
  it("skips this repo's full-build `prepare` hook on npm ci", () => {
    // Without QWEN_SKIP_PREPARE=1, `npm ci` runs `npm run build` + `npm run
    // bundle` over every workspace (~190s) — wasted, because build-test does its
    // own scoped build next. Pinned here so a future env edit cannot silently
    // drop it and reintroduce the install-time full build.
    expect(buildRunEnv({})['QWEN_SKIP_PREPARE']).toBe('1');
    expect(buildRunEnv({})['CI']).toBe('1');
  });

  it('does not mutate the base env it was given', () => {
    const base = { PATH: '/x' };
    buildRunEnv(base);
    expect(base).toEqual({ PATH: '/x' });
  });
});

describe('runBuildTest', () => {
  let root: string;
  let planPath: string;

  const writePlan = (paths: string[]): void => {
    planPath = join(root, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        diffPathAbsolute: '/dev/null',
        files: paths.map((p) => ({ path: p, kind: 'source' })),
      }),
    );
  };

  const pkg = (dir: string, body: object): void => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify(body));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bt-'));
    // An npm repo (root `package-lock.json`) with a COMPLETE node_modules — the
    // `.package-lock.json` marker npm writes only when the tree is fully materialised
    // — so the install is skipped and no network is touched. (The install runs only
    // for an npm repo whose marker is missing; gating on the marker, not the bare
    // directory, is what stops a partial tree from being mistaken for a finished one.)
    writeFileSync(join(root, 'package-lock.json'), '{}');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('treats a package.json with no build role as no npm project at all', () => {
    // Docs sites, husky, and lint configs put a script-less package.json in
    // repos with nothing npm can scope. It must not make npm apply, or such a
    // root would claim the selection away from a second adapter that could
    // have verified the diff.
    // The handoff note is still npm's precise one: the repo IS npm-shaped,
    // and naming why it cannot be scoped beats a generic "no project here".
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r' }));
    writePlan(['src/a.ts']);
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 5,
      install: false,
    });
    expect(rep).toEqual({
      toolchain: 'unsupported',
      affected: [],
      buildSet: [],
      widenedWith: [],
      install: null,
      build: [],
      test: [],
      ok: true,
      timedOut: [],
      note:
        'No npm package here to scope (no workspaces, and the root has no build/test ' +
        'script). Fall back to the build/test precedence in your brief — installing ' +
        'dependencies first — and give each command a deadline it can actually meet.',
    });
  });

  it('surfaces the declared-but-empty workspaces note when no adapter applies', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    writePlan(['src/a.ts']);
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 5,
      install: false,
    });
    expect(rep.toolchain).toBe('unsupported');
    expect(rep.note).toContain(
      'declares npm workspaces, but none resolve to a package',
    );
  });

  it('keeps the complete generic unsupported report when no adapter applies', () => {
    writePlan(['src/a.java']);

    expect(
      runBuildTest({
        plan: planPath,
        worktree: root,
        timeout: 5,
        install: false,
      }),
    ).toEqual({
      toolchain: 'unsupported',
      affected: [],
      buildSet: [],
      widenedWith: [],
      install: null,
      build: [],
      test: [],
      ok: true,
      timedOut: [],
      note:
        'No supported npm project here to scope. Fall back to the ' +
        'build/test precedence in your brief — installing dependencies first — ' +
        'and give each command a deadline it can actually meet.',
    });
  });

  it('coerces fractional and zero deadlines at the spawn boundary', () => {
    // spawnSync validates `timeout` as an unsigned integer: a decimal
    // --timeout used to throw ERR_OUT_OF_RANGE out of the whole call (no
    // report, no --out file), and --timeout 0 armed no kill timer at all.
    pkg('.', { name: 'r', scripts: { test: 'vitest run' } });
    writePlan(['src/a.ts']);

    // 1.005s * 1000 = 1004.9999999999999 in IEEE-754: exactly the value
    // spawnSync rejects. 0.1 rounds to an integer and would mask the
    // regression; the explicit --budget keeps the wall-clock remainder
    // above the fractional deadline so it is the binding term.
    const fractional = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 1.005,
      budget: 600,
      install: false,
    });
    expect(fractional.toolchain).toBe('npm');
    expect(fractional.test).toHaveLength(1);
    expect(fractional.test[0]?.deadlineMs).toBe(1005);

    // Same explicit budget: without it a zero --timeout also zeroes the
    // whole-call budget, and the run discloses instead of reaching the spawn
    // boundary this case is about.
    const zero = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 0,
      budget: 600,
      install: false,
    });
    expect(zero.test[0]?.deadlineMs).toBe(1);
  });

  it('rejects non-finite --timeout and --budget with a descriptive error', () => {
    // yargs `type: 'number'` hands over NaN for `--timeout abc`; NaN
    // defeats every budget comparison and reaches spawnSync as an
    // invalid deadline — ERR_OUT_OF_RANGE with no report at all.
    pkg('.', { name: 'r', scripts: { test: 'vitest run' } });
    writePlan(['src/a.ts']);

    expect(() =>
      runBuildTest({
        plan: planPath,
        worktree: root,
        timeout: Number.NaN,
        install: false,
      }),
    ).toThrow(/--timeout must be a finite number/);
    expect(() =>
      runBuildTest({
        plan: planPath,
        worktree: root,
        timeout: 60,
        budget: Number.POSITIVE_INFINITY,
        install: false,
      }),
    ).toThrow(/--budget must be a finite number/);
  });

  it('reports `unsupported` — not a false "nothing to build" — for an unmodeled glob', () => {
    // `packages/**` matches real paths that the walker cannot resolve, so a diff
    // inside it would otherwise yield an empty affected set and a confident green.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/**'] }),
    );
    mkdirSync(join(root, 'packages', 'a'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'a', 'package.json'),
      JSON.stringify({ name: '@x/a', scripts: { build: 'exit 0' } }),
    );
    writePlan(['packages/a/src/x.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 5,
      install: false,
    });
    expect(rep.toolchain).toBe('unsupported');
    // The unscopable npm half no longer applies at selection — but the repo
    // IS an npm project whose layout cannot be scoped, so the note is npm's
    // precise unmodeled-glob wording, not the generic "no project here".
    expect(rep.note).toContain(
      'uses a workspace glob shape this command does not model',
    );
    expect(rep.note).not.toContain('no package to build');
  });

  it('reinstalls when node_modules exists but is INCOMPLETE (no .package-lock.json)', () => {
    // A partial tree — left by a timed-out install here, or by the agent's own shell
    // kill one level up — has the directory but not npm's completeness marker. Gating
    // on the directory would skip the install and build against the partial tree.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', { name: '@x/a', scripts: { build: 'exit 0' } });
    writePlan(['packages/a/src/x.ts']);
    // Bare node_modules, no marker — the beforeEach wrote both, so drop the marker.
    rmSync(join(root, 'node_modules', '.package-lock.json'), { force: true });

    const calls: string[] = [];
    runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: true,
      exec: (command, cwd) => {
        calls.push(command);
        if (command.startsWith('npm ci')) {
          writeFileSync(join(cwd, 'node_modules', '.package-lock.json'), '{}');
        }
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });
    // The install ran despite the directory already existing.
    expect(calls.some((c) => c.startsWith('npm ci'))).toBe(true);
  });

  it('builds and tests nothing for a LICENSE-only diff — the license family cannot fail a suite', () => {
    // A LICENSE edit outside every workspace cannot fail any suite, so
    // "nothing to run" is the honest answer, not a skipped step — and no
    // caveat: the scope misses nothing the workspaces could feel.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { test: 'exit 0' },
      }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['LICENSE', 'legal/LICENSE.txt']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 5,
      install: false,
      exec: (command) => {
        calls.push(command);
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });
    expect(rep.affected).toEqual([]);
    expect(calls).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.testScope).toEqual({ workspaces: [] });
    expect(rep.testScope?.caveat).toBeUndefined();
    expect(rep.note).toContain('no package to build');
    expect(rep.note).toContain('complete answer');
  });

  it('runs nothing but discloses the caveat for out-of-workspace files that are not inert', () => {
    // README/AGENTS.md-class prose is NOT inert: this repo's own root
    // AGENTS.md is asserted on by packages/cli's load-rules.test.ts. There is
    // still nothing to run for an outside-only diff, but the report must not
    // certify a complete answer.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { test: 'exit 0' },
      }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['README.md', 'AGENTS.md']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 5,
      install: false,
      exec: okExec,
    });
    expect(rep.build).toEqual([]);
    expect(rep.test).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.testScope?.workspaces).toEqual([]);
    expect(rep.testScope?.caveat).toContain('README.md');
    expect(rep.note).toContain('caveat');
    // The note embeds the caveat's substance, not just the word "caveat".
    expect(rep.note).toContain('README.md');
    expect(rep.note).not.toContain('complete answer');
  });

  it('keeps a diff scoped — and caveat-free — when its only out-of-workspace files are the license family', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { test: 'exit 0' },
      }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/b', { name: '@x/b', scripts: { test: 'exit 0' } });
    pkg('packages/c', { name: '@x/c', scripts: { test: 'exit 0' } });
    writePlan(['packages/a/src/x.ts', 'LICENSE', 'NOTICES.txt']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.testScope).toEqual({ workspaces: ['packages/a'] });
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/a"',
    ]);
    expect(rep.ok).toBe(true);
  });

  it('keeps a prose file riding along scoped, but the note carries the caveat', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { test: 'exit 0' },
      }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/b', { name: '@x/b', scripts: { test: 'exit 0' } });
    pkg('packages/c', { name: '@x/c', scripts: { test: 'exit 0' } });
    writePlan(['packages/a/src/x.ts', 'README.md']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.testScope?.workspaces).toEqual(['packages/a']);
    expect(rep.testScope?.caveat).toContain('README.md');
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/a"',
    ]);
    expect(rep.note).toContain('Caveat:');
    // The note embeds the caveat's substance, not just the "Caveat:" label.
    expect(rep.note).toContain('README.md');
    expect(rep.ok).toBe(true);
  });

  it('still runs nothing for an EMPTY diff — a full suite would measure nothing', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { test: 'exit 0' },
      }),
    );
    pkg('packages/a', { name: '@x/a', scripts: { build: 'exit 0' } });
    writePlan([]);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 5,
      install: false,
      exec: okExec,
    });
    expect(rep.build).toEqual([]);
    expect(rep.test).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.testScope).toEqual({ workspaces: [] });
    expect(rep.note).toContain('no test to run');
  });

  it('builds and tests a single-package npm repo (no `workspaces` field)', () => {
    // The most common npm repo shape. Without single-root support it would classify
    // as `unsupported` and get no npm build/test path at all.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'solo',
        scripts: { build: 'exit 0', test: 'exit 0' },
      }),
    );
    writePlan(['src/index.ts']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => {
        calls.push(command);
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });
    expect(rep.toolchain).toBe('npm');
    expect(rep.affected).toEqual(['.']);
    expect(rep.buildSet).toEqual(['.']);
    // The root package takes NO `--workspace`.
    expect(calls).toContain('npm run build');
    expect(calls).toContain('npm test');
    expect(calls.some((c) => c.includes('--workspace'))).toBe(false);
    expect(rep.ok).toBe(true);
  });

  it('says no tests ran for a single-package repo whose root defines only a build script', () => {
    // The root's build runs, but with no test script nothing is executed —
    // the note must not claim the tests of the changed package ran and passed.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'solo', scripts: { build: 'exit 0' } }),
    );
    writePlan(['src/index.ts']);
    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => {
        calls.push(command);
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });
    expect(rep.toolchain).toBe('npm');
    expect(rep.ok).toBe(true);
    expect(rep.test).toEqual([]);
    expect(rep.testScope).toBeUndefined();
    expect(rep.note).toContain('no tests ran');
    expect(rep.note).not.toContain('Everything passed');
    // The comment above claims the build runs — so witness it, not just the
    // note's wording: exactly the root's build, and nothing else, executed.
    expect(calls).toEqual(['npm run build']);
  });

  it('is `unsupported` for a single-package repo with no build/test script', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'solo', scripts: { lint: 'exit 0' } }),
    );
    writePlan(['src/index.ts']);
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 5,
      install: false,
    });
    expect(rep.toolchain).toBe('unsupported');
    expect(rep.note).toContain('Fall back');
  });

  it('does not run `npm ci` on a yarn/bun repo (no package-lock.json) with a tree', () => {
    // `workspaces` is also yarn/bun syntax; those write no `package-lock.json`, so
    // `npm ci` would fail-fast and mislabel a usable node_modules as a failed install.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    // Remove the npm lockfile the beforeEach wrote (and the completeness marker) —
    // this is a yarn/bun tree, present but not npm's.
    rmSync(join(root, 'package-lock.json'), { force: true });
    rmSync(join(root, 'node_modules', '.package-lock.json'), { force: true });
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/a/src/x.ts']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: true,
      exec: (command) => {
        calls.push(command);
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });
    // No `npm ci` — the existing tree is trusted; the build ran and passed.
    expect(calls.some((c) => c.startsWith('npm ci'))).toBe(false);
    expect(rep.install).toBeNull();
    expect(rep.ok).toBe(true);
    expect(rep.build.length).toBeGreaterThan(0);
  });

  it('hands off (not a false green) when an affected dir maps to no package', () => {
    // A nested package listed before a `*` that also claims its parent segment: the
    // walker maps `packages/nested/pkg/...` to `packages/nested` (no package.json),
    // which would be dropped from the build set — zero commands, ok:true, "Everything
    // passed" — the confident false green. A sibling package keeps the package map
    // non-empty so this reaches the affected-dir guard, not the empty-packages one.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/nested/pkg', 'packages/*'],
      }),
    );
    pkg('packages/nested/pkg', {
      name: '@x/nested',
      scripts: { build: 'exit 1', test: 'exit 1' },
    });
    pkg('packages/sibling', { name: '@x/sib', scripts: { build: 'exit 0' } });
    writePlan(['packages/nested/pkg/src/x.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    // NOT a scoped `ok: true` over zero commands — it hands off instead.
    expect(rep.toolchain).toBe('unsupported');
    expect(rep.note).toContain('map to no package');
    expect(rep.build).toEqual([]);
  });

  it('hands off a cold yarn repo (no install possible) instead of a false Critical', () => {
    // A review worktree is cold. `npm ci` cannot install a yarn repo, and building
    // against absent deps fails with `Cannot find module` in the PR's own files — the
    // false-Critical steer. So it hands off, naming the tool to install with.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    rmSync(join(root, 'package-lock.json'), { force: true });
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    writeFileSync(join(root, 'yarn.lock'), '');
    pkg('packages/a', { name: '@x/a', scripts: { build: 'exit 1' } });
    writePlan(['packages/a/src/x.ts']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: true,
      exec: (command) => {
        calls.push(command);
        return {
          command,
          exitCode: 1,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });
    expect(rep.toolchain).toBe('unsupported');
    expect(rep.note).toContain('yarn.lock');
    expect(rep.install).toBeNull();
    // Never ran a build that could only fail misleadingly.
    expect(calls).toEqual([]);
    expect(rep.note).not.toContain('Critical');
  });

  it('reorders when two affected packages have an undeclared source-reach', () => {
    // Both the needer (`aaa`) and the undeclared-needed (`zzz`) are changed, and the
    // alphabet orders the needer first. The TS2307 names an in-set package; filtering
    // on `!built.has` (not `!set.includes`) lets that trigger a reorder via alsoBuild
    // rather than terminal-fail with a false "Correlate → Critical".
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/aaa', {
      name: '@x/aaa',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/zzz', {
      name: '@x/zzz',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/aaa/src/x.ts', 'packages/zzz/src/y.ts']);

    let zzzBuilt = false;
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => {
        const ws = /--workspace="([^"]+)"/.exec(command)?.[1] ?? '';
        if (command.startsWith('npm run build') && ws === 'packages/zzz') {
          zzzBuilt = true;
        }
        if (
          command.startsWith('npm run build') &&
          ws === 'packages/aaa' &&
          !zzzBuilt
        ) {
          return {
            command,
            exitCode: 2,
            seconds: 1,
            timedOut: false,
            output: "error TS2307: Cannot find module '@x/zzz'",
          };
        }
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });
    // The reorder fixed it — a green build, not a terminal false failure.
    expect(rep.ok).toBe(true);
    expect(rep.buildSet.indexOf('packages/zzz')).toBeLessThan(
      rep.buildSet.indexOf('packages/aaa'),
    );
  });

  // The exec seam stands in for real `npm run`: these tests are about which packages
  // get built, in what order, and how a result is classified — not about npm's own
  // workspace resolution. Driving real npm here made the suite spawn dozens of slow
  // subprocesses under parallelism and hang; the seam is deterministic and instant.
  const wsOf = (command: string): string =>
    /--workspace="([^"]+)"/.exec(command)?.[1] ?? '';
  const okExec: NonNullable<Parameters<typeof runBuildTest>[0]['exec']> = (
    command,
  ) => ({ command, exitCode: 0, seconds: 1, timedOut: false, output: '' });

  it('rescues the runner summary from a trimmed middle', () => {
    // A failing suite's tail is all failure details and npm epilogue, which
    // pushes the one-line `Tests  3 failed | 1132 passed` summary into the
    // omitted middle — measured live on PR #8176, where the count check then
    // found no summary anywhere in the kept report. Tested against trimOutput
    // directly: the injected exec seam used elsewhere bypasses the trim, which
    // is exactly how the gap shipped.
    const summary = 'Tests  3 failed | 1132 passed (1135)';
    const trimmed = trimOutput(
      'head\n' + 'x'.repeat(3000) + `\n${summary}\n` + 'y'.repeat(9000),
    );
    expect(trimmed).toContain(summary);
    expect(trimmed).toContain('runner summaries kept');
    // The colored form a real pipe delivers is rescued too.
    const colored = `Tests\x1b[2m  \x1b[22m\x1b[31m3 failed\x1b[39m | 1132 passed`;
    expect(
      trimOutput(
        'h\n' + 'x'.repeat(3000) + `\n${colored}\n` + 'y'.repeat(9000),
      ),
    ).toContain(colored);
  });

  it('caps the rescue so hostile prose cannot void the trim', () => {
    // 40k lines matching the summary shape made the trim a no-op (1.6MB in,
    // 1.6MB out) — the rescue saves a handful of lines, never the middle.
    const hostile =
      'head\n' +
      Array.from({ length: 5000 }, (_, i) => `Test ${i} passed thing`).join(
        '\n',
      ) +
      '\n' +
      'y'.repeat(9000);
    const trimmed = trimOutput(hostile);
    expect(trimmed.length).toBeLessThan(hostile.length / 4);
  });

  it('buildOnly builds the same set but runs NO tests', () => {
    // For the merge-base tree an A/B probe compares against: base's suite was
    // green before this PR existed, so running it measures nothing about the
    // diff and doubles the cost of the one thing the probe does need — a
    // compiled tree to run against.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/core/src/a.ts']);

    const args = {
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    };
    const withTests = runBuildTest(args);
    const buildOnly = runBuildTest({ ...args, buildOnly: true });

    expect(withTests.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
    ]);
    expect(withTests.testScope).toBeDefined();
    expect(buildOnly.test).toEqual([]);
    // The probe runs no tests, so it must not claim a scoping decision — a
    // testScope on it would read as "the suite ran" in the agent's brief.
    expect(buildOnly.testScope).toBeUndefined();
    // The build itself is untouched — same set, same commands, same verdict.
    expect(buildOnly.buildSet).toEqual(withTests.buildSet);
    expect(buildOnly.build.map((b) => b.command)).toEqual(
      withTests.build.map((b) => b.command),
    );
    expect(buildOnly.ok).toBe(true);
    // And the note must not claim tests it did not run.
    expect(buildOnly.note).toContain('build-only');
    expect(buildOnly.note).not.toContain('ran the tests');
  });

  it('scopes build AND tests to the changed workspace and its dependents', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/leaf', {
      name: '@x/leaf',
      dependencies: { '@x/core': '*' },
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    // Enough unrelated islands that the two-package closure stays under the
    // more-than-half cap and the scoped path is what this test exercises.
    for (const island of ['island1', 'island2', 'island3']) {
      pkg(`packages/${island}`, {
        name: `@x/${island}`,
        scripts: { build: 'exit 0', test: 'exit 0' },
      });
    }
    writePlan(['packages/core/src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.affected).toEqual(['packages/core']);
    // core changed, so leaf's compile is where a break would surface.
    expect(rep.buildSet).toContain('packages/leaf');
    // The islands depend on nothing that changed.
    expect(rep.buildSet).not.toContain('packages/island1');
    // The changed workspace's tests run — and so do its dependent's: a
    // behaviour change in core can fail leaf's suite while leaf still compiles.
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
      'npm test --workspace="packages/leaf"',
    ]);
    expect(rep.testScope).toEqual({
      workspaces: ['packages/core', 'packages/leaf'],
    });
    // The note names the scope, so the review body can state what ran.
    expect(rep.note).toContain('packages/core, packages/leaf');
    expect(rep.note).not.toContain('Caveat:');
    expect(rep.ok).toBe(true);
  });

  it('tests the TRANSITIVE dependents of a changed workspace, not just direct ones', () => {
    // core <- mid <- top: a behaviour change in core can surface in top's suite
    // with mid unchanged in between. The closure must follow the chain.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/mid', {
      name: '@x/mid',
      dependencies: { '@x/core': '*' },
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/top', {
      name: '@x/top',
      // devDependencies count: a test-only consumer is still a consumer.
      devDependencies: { '@x/mid': '*' },
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    for (const island of ['i1', 'i2', 'i3', 'i4']) {
      pkg(`packages/${island}`, {
        name: `@x/${island}`,
        scripts: { test: 'exit 0' },
      });
    }
    writePlan(['packages/core/src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.testScope).toEqual({
      workspaces: ['packages/core', 'packages/mid', 'packages/top'],
    });
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
      'npm test --workspace="packages/mid"',
      'npm test --workspace="packages/top"',
    ]);
    expect(rep.ok).toBe(true);
  });

  it('builds what a MIDDLE package compiles against, but tests only the closure', () => {
    // core <- mid <- top plus islands; changing mid means the BUILD set is
    // {core, mid, top} (mid compiles against core) while the TEST scope is
    // the closure {mid, top} — core's suite cannot have been broken by a
    // change to its consumer, and the note must not claim it ran.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/mid', {
      name: '@x/mid',
      dependencies: { '@x/core': '*' },
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/top', {
      name: '@x/top',
      dependencies: { '@x/mid': '*' },
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    for (const island of ['i1', 'i2', 'i3', 'i4']) {
      pkg(`packages/${island}`, {
        name: `@x/${island}`,
        scripts: { test: 'exit 0' },
      });
    }
    writePlan(['packages/mid/src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.buildSet).toContain('packages/core');
    expect(rep.buildSet).toContain('packages/mid');
    expect(rep.testScope).toEqual({
      workspaces: ['packages/mid', 'packages/top'],
    });
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/mid"',
      'npm test --workspace="packages/top"',
    ]);
    expect(rep.note).toContain('tests scoped to packages/mid, packages/top');
    expect(rep.ok).toBe(true);
  });

  it('excludes a build-only dependent from the test scope and the note', () => {
    // leaf depends on core but defines no test script: nothing runs for it,
    // so naming it would claim coverage that cannot exist.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/leaf', {
      name: '@x/leaf',
      dependencies: { '@x/core': '*' },
      scripts: { build: 'exit 0' },
    });
    for (const island of ['i1', 'i2', 'i3']) {
      pkg(`packages/${island}`, {
        name: `@x/${island}`,
        scripts: { test: 'exit 0' },
      });
    }
    writePlan(['packages/core/src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    // The build set still has leaf — its compile is where a break surfaces.
    expect(rep.buildSet).toContain('packages/leaf');
    expect(rep.testScope).toEqual({ workspaces: ['packages/core'] });
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
    ]);
    // The note names what ran and must not claim the build-only dependent was
    // tested — naming it would assert a coverage that cannot exist.
    expect(rep.note).toContain('packages/core');
    expect(rep.note).toContain('defines a test script');
    expect(rep.note).not.toContain('packages/leaf');
  });

  it('runs the root suite as a dependent when the root package.json declares a workspace dependency', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { test: 'exit 0' },
        dependencies: { '@x/core': '*' },
      }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    for (const island of ['i1', 'i2', 'i3', 'i4']) {
      pkg(`packages/${island}`, {
        name: `@x/${island}`,
        scripts: { test: 'exit 0' },
      });
    }
    writePlan(['packages/core/src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.testScope?.workspaces).toContain('.');
    // Affected first: the changed workspace's own suite is unstarvable.
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
      'npm test',
    ]);
    expect(rep.ok).toBe(true);
  });

  it('keeps a build-only root out of the test scope and the half-cap count', () => {
    // The root declares a dependency on the changed member but defines NO test
    // script: it joins the closure only as '.', the script filter drops it, and
    // — because it is not a testable suite — it must not inflate the half-cap
    // denominator either. The script filter and the rootRuns gate are what
    // guarantee both; this pins the resulting scope.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { build: 'exit 0' },
        dependencies: { '@x/core': '*' },
      }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/a', {
      name: '@x/a',
      dependencies: { '@x/core': '*' },
      scripts: { test: 'exit 0' },
    });
    pkg('packages/island', { name: '@x/island', scripts: { test: 'exit 0' } });
    writePlan(['packages/core/src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    // 2 of the 3 testable workspaces is past half, so the caveat fires — the
    // build-only root is NOT counted as a fourth testable suite.
    expect(rep.testScope?.workspaces).toEqual(['packages/a', 'packages/core']);
    expect(rep.testScope?.caveat).toContain('2 of 3 testable workspaces');
    // Affected (core) runs first; dependents follow.
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
      'npm test --workspace="packages/a"',
    ]);
  });

  it('builds a workspace whose only edge is a dependency on the root package', () => {
    // docs depends on the root's NAME and the root depends on core, so docs is
    // in the test closure through the root. The build set is computed over the
    // same root-inclusive graph, so docs is built before it is tested — a
    // suite must never run against artifacts that were never compiled.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { build: 'exit 0', test: 'exit 0' },
        dependencies: { '@x/core': '*' },
      }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/docs', {
      name: '@x/docs',
      dependencies: { r: '*' },
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    for (const island of ['i1', 'i2', 'i3']) {
      pkg(`packages/${island}`, {
        name: `@x/${island}`,
        scripts: { test: 'exit 0' },
      });
    }
    writePlan(['packages/core/src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.testScope?.workspaces).toContain('packages/docs');
    // docs is built (the drift R2-23 fixed) — and so is the root: docs names
    // the root as a dependency, so the root joins the graph and its own
    // `build` runs like any other package's, dependencies-first.
    expect(rep.buildSet).toContain('packages/docs');
    expect(rep.buildSet).toContain('packages/core');
    expect(rep.buildSet).toContain('.');
    expect(rep.build.map((b) => b.command)).toEqual([
      'npm run build --workspace="packages/core"',
      'npm run build',
      'npm run build --workspace="packages/docs"',
    ]);
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
      'npm test',
      'npm test --workspace="packages/docs"',
    ]);
    expect(rep.ok).toBe(true);
  });

  it('buildOnly measures the SAME set as the full run in the root-bridge case', () => {
    // The merge-base probe is the baseline an A/B verdict is computed against:
    // if its build set excluded the root bridge (and docs behind it), base
    // would run docs's suite against artifacts the full run compiles —
    // manufacturing a behavioural difference out of thin air.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { build: 'exit 0', test: 'exit 0' },
        dependencies: { '@x/core': '*' },
      }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/docs', {
      name: '@x/docs',
      dependencies: { r: '*' },
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/core/src/a.ts']);

    const args = {
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    };
    const withTests = runBuildTest(args);
    const buildOnly = runBuildTest({ ...args, buildOnly: true });

    expect(withTests.buildSet).toContain('.');
    expect(buildOnly.buildSet).toEqual(withTests.buildSet);
    expect(buildOnly.build.map((b) => b.command)).toEqual(
      withTests.build.map((b) => b.command),
    );
    expect(buildOnly.test).toEqual([]);
    expect(buildOnly.ok).toBe(true);
  });

  it('skips a fan-out root suite — the scoped member suites are the coverage', () => {
    // The root's `test` fans out over every workspace: running it as bare
    // `npm test` would repeat the ENTIRE suite inside one command deadline,
    // the fallback this command refuses. It must not appear among the test
    // commands, and the caveat must say why.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: {
          build: 'exit 0',
          test: 'npm run test --workspaces --if-present',
        },
        dependencies: { '@x/core': '*' },
      }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/docs', {
      name: '@x/docs',
      dependencies: { r: '*' },
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    for (const island of ['i1', 'i2', 'i3', 'i4']) {
      pkg(`packages/${island}`, {
        name: `@x/${island}`,
        scripts: { test: 'exit 0' },
      });
    }
    writePlan(['packages/core/src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
      'npm test --workspace="packages/docs"',
    ]);
    expect(rep.testScope?.workspaces).not.toContain('.');
    expect(rep.testScope?.caveat).toContain('fans out');
    expect(rep.note).toContain('fans out');
    expect(rep.ok).toBe(true);
  });

  it('attempts every suite with the REMAINING budget and names only the never-attempted', () => {
    // Suites of ~2s of real wall clock against a 16s budget: core runs — with
    // a deadline shrunk to what remains, never the full 60s — and the suites
    // the floor cuts off are named notRun. Reserving a full per-command
    // deadline per suite (the old guard) would have run NONE of them.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/a', {
      name: '@x/a',
      dependencies: { '@x/core': '*' },
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/b', {
      name: '@x/b',
      dependencies: { '@x/a': '*' },
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    for (const island of ['i1', 'i2', 'i3']) {
      pkg(`packages/${island}`, {
        name: `@x/${island}`,
        scripts: { test: 'exit 0' },
      });
    }
    writePlan(['packages/core/src/a.ts']);

    const testCalls: Array<{ command: string; timeoutMs: number }> = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      budget: 16,
      install: false,
      exec: (command, _cwd, timeoutMs) => {
        if (command.startsWith('npm test')) {
          testCalls.push({ command, timeoutMs });
          // Real wall clock, so the budget actually drains.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
        }
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });
    // core (affected) ran with a deadline shrunk to the remaining budget; a
    // and b fell below the 15s attempt floor and are named, not faked.
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
    ]);
    expect(testCalls.every((c) => c.timeoutMs < 60_000)).toBe(true);
    // Structural: workspaces names what ran (scope order), notRun what was
    // never attempted.
    expect(rep.testScope?.workspaces).toEqual(['packages/core']);
    expect(rep.testScope?.notRun).toEqual(['packages/a', 'packages/b']);
    expect(rep.note).toContain('not run: packages/a, packages/b');
    expect(rep.ok).toBe(true);
  });

  it('routes builds and suites to notBuilt/notRun below the attempt floor — never a fake timeout', () => {
    // Budget below the 15s floor from the start: no build is attempted (an
    // attempt would manufacture a fake timeout), no suite runs against
    // artifacts never compiled, and the report says both plainly.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/leaf', {
      name: '@x/leaf',
      dependencies: { '@x/core': '*' },
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/core/src/a.ts']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      budget: 1,
      install: false,
      exec: (command) => {
        calls.push(command);
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });
    expect(calls.filter((c) => c.startsWith('npm run build'))).toEqual([]);
    expect(rep.test).toEqual([]);
    // Nothing reports as built or run that was not.
    expect(rep.buildSet).toEqual([]);
    expect(rep.testScope?.workspaces).toEqual([]);
    expect(rep.testScope?.notRun).toEqual(['packages/core', 'packages/leaf']);
    expect(rep.note).toContain('not built: packages/core, packages/leaf');
    expect(rep.note).toContain('before any suite could run');
    expect(rep.ok).toBe(true);
  });

  it('names budget-stopped UNTESTABLE suites in notRun too', () => {
    // The budget-break push must be UNFILTERED: a suite the build phase
    // left unbuilt (untestable) and the budget then never attempted
    // otherwise stayed in testScope.workspaces — reported as run and
    // passed though zero test commands executed.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/d', {
      name: '@x/d',
      dependencies: { '@x/a': '*', '@x/x': '*' },
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/x', {
      name: '@x/x',
      scripts: { build: 'exit 0' },
    });
    writePlan(['packages/a/src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      budget: 16,
      install: false,
      exec: (command) => {
        if (command.startsWith('npm run build')) {
          // Real wall clock, so the budget actually drains.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
        }
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    // `a` builds (2s), then the floor stops the build phase with x and d
    // unbuilt, and the test phase starts below the floor.
    expect(rep.test).toEqual([]);
    expect(rep.testScope?.workspaces).toEqual([]);
    expect(rep.testScope?.notRun).toEqual(['packages/a', 'packages/d']);
    expect(rep.note).toContain('not run: packages/a, packages/d');
    expect(rep.ok).toBe(true);
  });

  it('discloses a budget-stopped single-root suite instead of claiming no test script', () => {
    // The workspace branch names the budget when every suite was trimmed;
    // a single-root repo carries no testScope, and its note used to claim
    // the package defines no test script — though the script is exactly
    // why the suite sits in notRun.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        scripts: { build: 'exit 0', test: 'exit 0' },
      }),
    );
    writePlan(['src/a.ts']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      budget: 16,
      install: false,
      exec: (command) => {
        calls.push(command);
        if (command.startsWith('npm run build')) {
          // Real wall clock, so the budget actually drains.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
        }
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    expect(calls).toEqual(['npm run build']);
    expect(rep.test).toEqual([]);
    expect(rep.note).toContain(
      'whole-call budget was spent before any suite could run',
    );
    expect(rep.note).not.toContain('defines no test script');
    expect(rep.note).toContain('not run: .');
    expect(rep.ok).toBe(true);
  });

  it('runs the AFFECTED workspace first, so the budget trims dependents, never the changed suite', () => {
    // The closure is alphabetical — `alpha` before `zebra` — but the diff
    // changed zebra, and its own suite is the one most likely to catch the
    // regression. The run order must put it first.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/zebra', {
      name: '@x/zebra',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/alpha', {
      name: '@x/alpha',
      dependencies: { '@x/zebra': '*' },
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    for (const island of ['i1', 'i2', 'i3']) {
      pkg(`packages/${island}`, {
        name: `@x/${island}`,
        scripts: { test: 'exit 0' },
      });
    }
    writePlan(['packages/zebra/src/a.ts']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => {
        calls.push(command);
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/zebra"',
      'npm test --workspace="packages/alpha"',
    ]);
    expect(rep.ok).toBe(true);
  });

  it('skips a fan-out root BUILD — the scoped loop already builds the members it drives', () => {
    // The root devDepends on the changed member and its build is
    // `npm run build --workspaces`: running it as one bare command is the
    // whole-monorepo build this command exists to refuse.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: {
          build: 'npm run build --workspaces --if-present',
          test: 'exit 0',
        },
        devDependencies: { '@x/core': '*' },
      }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    for (const island of ['i1', 'i2', 'i3']) {
      pkg(`packages/${island}`, {
        name: `@x/${island}`,
        scripts: { test: 'exit 0' },
      });
    }
    writePlan(['packages/core/src/a.ts']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => {
        calls.push(command);
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });
    // The root is in the graph (its edges matter) but its aggregator build
    // must not execute — and must not linger in the reported build set, or
    // the report names a build that never ran.
    expect(rep.buildSet).not.toContain('.');
    expect(calls).not.toContain('npm run build');
    expect(rep.note).not.toContain('plus the root package');
    // The root's NON-fan-out test still runs as a dependent.
    expect(calls).toContain('npm test');
    expect(rep.ok).toBe(true);
  });

  it('carries the caveat on a FAILURE note too — the note is what the brief renders first', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 1' },
    });
    for (const island of ['i1', 'i2', 'i3']) {
      pkg(`packages/${island}`, {
        name: `@x/${island}`,
        scripts: { test: 'exit 0' },
      });
    }
    writePlan(['packages/a/src/x.ts', 'scripts/build.js']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => ({
        command,
        exitCode: command.startsWith('npm test') ? 1 : 0,
        seconds: 1,
        timedOut: false,
        output: '1 failing',
      }),
    });
    expect(rep.ok).toBe(false);
    expect(rep.note).toContain('failed');
    expect(rep.note).toContain('Caveat:');
    expect(rep.note).toContain('scripts/build.js');
  });

  it('shell-escapes a workspace dir name — the tree is PR-authored input', () => {
    // A dir named `$(touch pwned)` would execute inside double quotes on a
    // POSIX shell: `$()` and backticks stay live there. The command line must
    // escape it.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/$(touch pwned)', {
      name: '@x/evil',
      scripts: { test: 'exit 0' },
    });
    pkg('packages/island', { name: '@x/island', scripts: { test: 'exit 0' } });
    writePlan(['packages/$(touch pwned)/src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/\\$(touch pwned)"',
    ]);
  });

  it('certifies nothing to run for an outside-only diff, and names the caveat — never a complete answer', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { test: 'exit 0' },
      }),
    );
    pkg('packages/a', { name: '@x/a', scripts: { test: 'exit 0' } });
    writePlan(['scripts/build.js']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.build).toEqual([]);
    expect(rep.test).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.testScope?.caveat).toContain('scripts/build.js');
    expect(rep.note).toContain('caveat');
    expect(rep.note).not.toContain('complete answer');

    // The merge-base probe (build-only) over the same diff reports no
    // testScope and no inert-prose label — it is a probe, not a verdict.
    const probe = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      buildOnly: true,
      exec: okExec,
    });
    expect(probe.testScope).toBeUndefined();
    expect(probe.note).toContain('build-only probe');
    expect(probe.note).not.toContain('inert prose');
  });

  it('says no tests ran when no workspace in scope defines a test script', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0' },
    });
    pkg('packages/b', { name: '@x/b', scripts: { test: 'exit 0' } });
    pkg('packages/c', { name: '@x/c', scripts: { test: 'exit 0' } });
    writePlan(['packages/core/src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.build.map((b) => b.command)).toEqual([
      'npm run build --workspace="packages/core"',
    ]);
    expect(rep.test).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.note).toContain('no workspace in scope defines a test script');
  });

  it('records a caveat — and still runs the closure — when it covers more than half the workspaces', () => {
    // With core feeding both dependents, the closure is 3 of the 5 testable
    // suites (the root defines a test too, and it counts in the total) — past
    // half, so the report says the scoped set is not a meaningful narrowing.
    // The closure still runs: the root's full suite cannot finish inside a
    // command deadline on a large monorepo, so a full-suite fallback would
    // only ever report a timeout.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { test: 'exit 0' },
      }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/a', {
      name: '@x/a',
      dependencies: { '@x/core': '*' },
      scripts: { test: 'exit 0' },
    });
    pkg('packages/b', {
      name: '@x/b',
      dependencies: { '@x/core': '*' },
      scripts: { test: 'exit 0' },
    });
    pkg('packages/island', { name: '@x/island', scripts: { test: 'exit 0' } });
    writePlan(['packages/core/src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.testScope?.caveat).toContain(
      '3 of 5 testable suites (including the root)',
    );
    expect(rep.testScope?.caveat).toContain('more than half');
    // The closure runs, suite by suite — never the root's full-suite command.
    // Affected (core) first, dependents after.
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
      'npm test --workspace="packages/a"',
      'npm test --workspace="packages/b"',
    ]);
    // The BUILD stays scoped too: packages outside the closure cannot have
    // been broken at compile time.
    expect(rep.buildSet).not.toContain('packages/island');
    expect(rep.note).toContain('Caveat:');
    expect(rep.ok).toBe(true);
  });

  it('runs the scoped suites and records a caveat when the diff also touches non-workspace files', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { test: 'exit 0' },
      }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/b', { name: '@x/b', scripts: { test: 'exit 0' } });
    pkg('packages/c', { name: '@x/c', scripts: { test: 'exit 0' } });
    writePlan(['packages/a/src/x.ts', 'scripts/build.js']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.testScope?.caveat).toContain('scripts/build.js');
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/a"',
    ]);
    // The workspace part of the diff still gets its scoped compile signal.
    expect(rep.affected).toEqual(['packages/a']);
    expect(rep.build.map((b) => b.command)).toEqual([
      'npm run build --workspace="packages/a"',
    ]);
  });

  it('does not widen an outside-file caveat to every workspace — the closure still runs', () => {
    // eslint.config.js is influential, but the run stays the diff's closure:
    // b does not depend on a, so its suite cannot fail from this diff.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/b', { name: '@x/b', scripts: { test: 'exit 0' } });
    writePlan(['packages/a/src/x.ts', 'eslint.config.js']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.testScope?.caveat).toContain('eslint.config.js');
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/a"',
    ]);
  });

  it('records a caveat when a workspace package.json does not parse, and runs the visible closure', () => {
    // An unparseable manifest means the dependency graph is missing that
    // package's reverse edges — a dependent of the diff could be invisible.
    // The visible closure still runs; the caveat discloses the gap.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { test: 'exit 0' },
      }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/b', { name: '@x/b', scripts: { test: 'exit 0' } });
    pkg('packages/c', { name: '@x/c', scripts: { test: 'exit 0' } });
    mkdirSync(join(root, 'packages', 'broken'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'broken', 'package.json'),
      '{ not json',
    );
    writePlan(['packages/a/src/x.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.testScope?.caveat).toContain('packages/broken');
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/a"',
    ]);
  });

  it('records a caveat when a workspace manifest parses but has no usable name', () => {
    // npm links a nameless member and its dependencies all the same, so its
    // missing reverse edges are the same gap as an unparseable manifest.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*'],
        scripts: { test: 'exit 0' },
      }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/nameless', {
      dependencies: { '@x/core': '*' },
      scripts: { test: 'exit 0' },
    });
    pkg('packages/b', { name: '@x/b', scripts: { test: 'exit 0' } });
    pkg('packages/c', { name: '@x/c', scripts: { test: 'exit 0' } });
    writePlan(['packages/core/src/x.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.testScope?.caveat).toContain('packages/nameless');
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
    ]);
  });

  it('discloses a diff inside a negated member — softly, never as an incomplete scope', () => {
    // packages/desktop is a separate toolchain (its own lockfile); a diff
    // inside it cannot fail any npm workspace's suite, so "nothing to run"
    // stays the answer — disclosed softly (its own suite did not run), never
    // as an incomplete scope.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*', '!packages/desktop'],
        scripts: { test: 'exit 0' },
      }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/desktop', {
      name: '@x/desktop',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/desktop/src/main.rs']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.build).toEqual([]);
    expect(rep.test).toEqual([]);
    expect(rep.testScope?.workspaces).toEqual([]);
    expect(rep.testScope?.caveat).toContain('packages/desktop/src/main.rs');
    expect(rep.testScope?.caveat).toContain('were not run');
    expect(rep.note).toContain('were not run');
  });

  it('keeps a plain single-package repo report free of the testScope field', () => {
    // A single-package repo's one suite IS its full suite — the field would
    // claim a scoping decision that never happened, and this repo shape's
    // report must stay byte-identical to what it was before scoping existed.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'solo',
        scripts: { build: 'exit 0', test: 'exit 0' },
      }),
    );
    writePlan(['src/index.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    expect(rep.ok).toBe(true);
    expect(JSON.stringify(rep)).not.toContain('testScope');
  });

  it('reports a build failure with its output, and does not call it ok', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', { name: '@x/a', scripts: { build: 'exit 1' } });
    writePlan(['packages/a/src/x.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => ({
        command,
        exitCode: 1,
        seconds: 1,
        timedOut: false,
        output: 'src/x.ts(1,1): error TS2345: nope',
      }),
    });
    expect(rep.ok).toBe(false);
    expect(rep.build.at(-1)?.exitCode).toBe(1);
    expect(rep.build.at(-1)?.output).toContain('TS2345');
    expect(rep.note).toContain('Correlate');
    // The run never reached its test phase, so it must not carry a scope that
    // would read as "the suites ran" in the agent's brief.
    expect(rep.testScope).toBeUndefined();
  });

  it('widens on a compiler-named workspace package, and leaves no false failure behind', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    // `leaf` needs `@x/templates` at compile time but declares no dependency on it
    // — exactly what a tsconfig `paths` entry into another package's sources does.
    // It fails until `templates` has been built.
    pkg('packages/templates', {
      name: '@x/templates',
      scripts: { build: 'exit 0' },
    });
    pkg('packages/leaf', {
      name: '@x/leaf',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/leaf/src/x.ts']);

    let templatesBuilt = false;
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => {
        const ws = wsOf(command);
        if (
          command.startsWith('npm run build') &&
          ws === 'packages/templates'
        ) {
          templatesBuilt = true;
          return {
            command,
            exitCode: 0,
            seconds: 1,
            timedOut: false,
            output: '',
          };
        }
        if (
          command.startsWith('npm run build') &&
          ws === 'packages/leaf' &&
          !templatesBuilt
        ) {
          return {
            command,
            exitCode: 2,
            seconds: 1,
            timedOut: false,
            output: "error TS2307: Cannot find module '@x/templates'",
          };
        }
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    expect(rep.widenedWith).toEqual(['@x/templates']);
    // Ordered first: no declared edge can place it, so the topological sort would
    // otherwise fall back on the alphabet and rebuild the same failure.
    expect(rep.buildSet[0]).toBe('packages/templates');
    expect(rep.ok).toBe(true);

    // The regression this pins: the failed FIRST attempt must not survive in the
    // report. An agent told "a build failure in a changed file is a Critical" would
    // read it and file a public blocker on a PR whose build passes.
    expect(rep.build.filter((r) => r.exitCode !== 0)).toEqual([]);
  });

  it('stops widening at the attempt cap when the compiler keeps naming new packages', () => {
    // The loop is bounded at `attempt <= 3` (four tries). A build that names a fresh
    // missing workspace package on every attempt must exhaust the cap and report a
    // failure, not spin. Uses the exec seam so it is deterministic and shell-free.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    for (const p of ['leaf', 'p1', 'p2', 'p3', 'p4']) {
      pkg(`packages/${p}`, {
        name: `@x/${p}`,
        scripts: { build: 'x', test: 'x' },
      });
    }
    writePlan(['packages/leaf/src/x.ts']);

    // Each build attempt fails naming the *next* package, forever.
    const order = ['@x/p1', '@x/p2', '@x/p3', '@x/p4', '@x/p5'];
    let builds = 0;
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => {
        if (command.startsWith('npm run build')) {
          const name = order[Math.min(builds++, order.length - 1)];
          return {
            command,
            exitCode: 2,
            seconds: 1,
            timedOut: false,
            output: `error TS2307: Cannot find module '${name}'`,
          };
        }
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    // Four attempts (0..3), then it stops rather than spinning. (rep.build holds
    // only the last failure — the intermediate ones are filtered on each widen — so
    // the exec counter is what proves the loop is bounded.)
    expect(builds).toBe(4);
    expect(rep.ok).toBe(false);
    // Exactly three widenings (attempts 0-2 each add one package; attempt 3 is
    // terminal) — a tight bound catches an over-widening regression the loose one
    // would miss.
    expect(rep.widenedWith.length).toBe(3);
    expect(rep.note).toContain('Correlate');
    // The exhaustion branch returns before the test loop, so no test ran.
    expect(rep.test).toEqual([]);
  });

  it('does not widen — or re-time-out — when a build TIMES OUT mid-widening', () => {
    // A timeout leaves partial output that can contain a `Cannot find module` line.
    // That must not be read as a too-small build set and retried under another full
    // deadline; a timeout is infrastructure, so it aborts at once.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/webui', { name: '@x/webui', scripts: { build: 'x' } });
    pkg('packages/leaf', {
      name: '@x/leaf',
      scripts: { build: 'x', test: 'x' },
    });
    writePlan(['packages/leaf/src/x.ts']);

    const builds: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => {
        if (command.startsWith('npm run build')) {
          builds.push(command);
          // Times out, and its partial output happens to name a real workspace pkg.
          return {
            command,
            exitCode: null,
            seconds: 60,
            timedOut: true,
            output: "error TS2307: Cannot find module '@x/webui'",
          };
        }
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    expect(rep.widenedWith).toEqual([]); // did not treat the timeout as a graph gap
    expect(builds.length).toBe(1); // aborted after the first, did not retry
    expect(rep.ok).toBe(false);
    expect(rep.note).toContain('infrastructure');
    expect(rep.note).not.toContain('Critical');
  });

  it('excludes a negated workspace from the build set (integration)', () => {
    // `!packages/excluded` must keep that package out — building it could fail on a
    // repo where it is a separate toolchain (e.g. packages/desktop, its own lockfile).
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        workspaces: ['packages/*', '!packages/excluded'],
      }),
    );
    pkg('packages/core', {
      name: '@x/core',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    pkg('packages/excluded', {
      name: '@x/excluded',
      dependencies: { '@x/core': '*' },
      scripts: { build: 'exit 1' },
    });
    writePlan(['packages/core/src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });
    // core changed; excluded depends on it but is negated out, so it is not built.
    expect(rep.buildSet).toContain('packages/core');
    expect(rep.buildSet).not.toContain('packages/excluded');
    expect(rep.ok).toBe(true);
  });

  it('throws a descriptive error for a missing plan file', () => {
    expect(() =>
      runBuildTest({
        plan: join(root, 'does-not-exist.json'),
        worktree: root,
        timeout: 5,
        install: false,
      }),
    ).toThrow(/cannot read the plan/);
  });

  it('throws a descriptive error for a plan that is valid JSON but not an object', () => {
    const bad = join(root, 'bad.json');
    writeFileSync(bad, 'null');
    expect(() =>
      runBuildTest({ plan: bad, worktree: root, timeout: 5, install: false }),
    ).toThrow(/not a JSON object/);
    writeFileSync(bad, '[1,2,3]');
    expect(() =>
      runBuildTest({ plan: bad, worktree: root, timeout: 5, install: false }),
    ).toThrow(/not a JSON object/);
  });

  it('carries on when the install exits non-zero but leaves a usable tree', () => {
    // The live failure this pins. `npm ci` runs the project's `prepare` script, and
    // this repo's runs `npm run build` + `npm run bundle` over the WHOLE monorepo.
    // On the PR under review that build hit a pre-existing type error in a package
    // the diff does not touch. `npm ci` exited 1. build-test gave up having built
    // and tested nothing — withholding the one deterministic signal a review has,
    // because an unrelated package failed to compile during an install.
    //
    // The packages WERE installed; `node_modules` was on disk (8.8 MB of it). The
    // exit code was never the right question.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/a/src/x.ts']);
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: true,
      // An install that fails the way this repo's does: the tree lands COMPLETE (the
      // `.package-lock.json` marker is written before `prepare` runs), then the
      // building `prepare` script blows up on someone else's file, exit 1.
      exec: (command, cwd, _timeoutMs) => {
        calls.push(command);
        if (command.startsWith('npm ci')) {
          mkdirSync(join(cwd, 'node_modules'), { recursive: true });
          writeFileSync(join(cwd, 'node_modules', '.package-lock.json'), '{}');
          return {
            command,
            exitCode: 1,
            seconds: 190,
            timedOut: false,
            output:
              "client/components/ChatEditor.tsx(21,10): error TS2300: Duplicate identifier 'useWebShellPortalRoot'.",
          };
        }
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    expect(rep.install?.exitCode).toBe(1);
    // It went on to answer the question the review actually came to ask.
    expect(calls).toContain('npm run build --workspace="packages/a"');
    expect(calls).toContain('npm test --workspace="packages/a"');
    expect(rep.build.length).toBeGreaterThan(0);
    expect(rep.test.length).toBeGreaterThan(0);
    // And it says what happened, in the terms the agent must report it in.
    expect(rep.note).toContain('informational');
    expect(rep.note).toContain('never as a Critical');
  });

  it('gives up only when the install leaves NO tree behind', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', { name: '@x/a', scripts: { build: 'exit 0' } });
    writePlan(['packages/a/src/x.ts']);
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: true,
      exec: (command) => ({
        command,
        exitCode: 1,
        seconds: 2,
        timedOut: false,
        output: 'ENOENT: no such file or directory, open package-lock.json',
      }),
    });

    expect(rep.ok).toBe(false);
    expect(rep.build).toEqual([]);
    expect(rep.note).toContain('nothing could be built');
  });

  it('records a build-command timeout in timedOut and frames it as infrastructure', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', { name: '@x/a', scripts: { build: 'exit 0' } });
    writePlan(['packages/a/src/x.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => ({
        command,
        exitCode: null,
        seconds: 60,
        timedOut: true,
        output: '',
      }),
    });
    expect(rep.timedOut).toEqual(['npm run build --workspace="packages/a"']);
    expect(rep.ok).toBe(false);
    // The whole point of the field: the agent must not file this as a Critical.
    expect(rep.note).toContain('infrastructure');
    expect(rep.note).not.toContain('Critical');
  });

  it('aborts when the install times out, rather than building an incomplete tree', () => {
    // A timeout kills `npm ci` mid-download and leaves a PARTIAL node_modules.
    // Building against it produces "module not found" errors that look like defects
    // in the diff and are not. Unlike a `prepare` failure (which leaves a complete
    // tree), a timeout must abort even though node_modules exists.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/a/src/x.ts']);
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: true,
      exec: (command, cwd) => {
        calls.push(command);
        if (command.startsWith('npm ci')) {
          // Timed out mid-download: a partial tree exists, exitCode is null.
          mkdirSync(join(cwd, 'node_modules'), { recursive: true });
          return {
            command,
            exitCode: null,
            seconds: 60,
            timedOut: true,
            output: '',
          };
        }
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    expect(rep.install?.timedOut).toBe(true);
    expect(rep.ok).toBe(false);
    // It must NOT have gone on to build against the half-installed tree.
    expect(calls.some((c) => c.startsWith('npm run build'))).toBe(false);
    expect(rep.note).toContain('infrastructure');
    expect(rep.note).not.toContain('Critical');
  });

  it('skips `npm ci` on a low disk, with the deadline-skip shape and disclosure', () => {
    // The dogfood failure this pins: ~2.7G free, `npm ci` ran 33 seconds, died
    // on ENOSPC, and the now-full disk failed every agent downstream. The
    // preflight finds that out before the command runs, and reports it exactly
    // like a deadline skip: nothing executed, ok:false, and a note that frames
    // the skip as environment — never a finding against the PR.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/a/src/x.ts']);
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    statfsSyncMock.mockReturnValue({ bavail: 2.9e9, bsize: 1 }); // ~2.7G free

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: true,
      exec: (command) => {
        calls.push(command);
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    // Nothing ran: not `npm ci`, and not a build against the absent tree.
    expect(calls).toEqual([]);
    expect(rep.install).toBeNull();
    // The same shape a deadline skip leaves: ok:false, empty build/test, and a
    // note the agent reports as informational. (`timedOut` stays empty — no
    // command ran long enough to time out.)
    expect(rep.ok).toBe(false);
    expect(rep.build).toEqual([]);
    expect(rep.test).toEqual([]);
    expect(rep.timedOut).toEqual([]);
    expect(rep.note).toContain('Insufficient disk space (2.7G free');
    expect(rep.note).toContain('skipped `npm ci --no-audit --no-fund`');
    expect(rep.note).toContain('environment');
    expect(rep.note).toContain('informational');
    expect(rep.note).not.toContain('Critical');
  });

  it('skips the build phase when a warm tree meets a nearly-full disk', () => {
    // A complete node_modules skips the install (and its 3 GiB gate) entirely,
    // but a compile that hits ENOSPC mid-write fails with errors that read as
    // defects in the diff — and leaves the disk full for every later agent.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/a/src/x.ts']);
    statfsSyncMock.mockReturnValue({ bavail: 5.4e8, bsize: 1 }); // ~0.5G free

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: true,
      exec: (command) => {
        calls.push(command);
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    expect(calls).toEqual([]);
    expect(rep.ok).toBe(false);
    expect(rep.build).toEqual([]);
    expect(rep.test).toEqual([]);
    expect(rep.note).toContain('Insufficient disk space (0.5G free');
    expect(rep.note).toContain('informational');
    expect(rep.note).not.toContain('Critical');
  });

  it('still builds a warm tree between the build floor and the install floor', () => {
    // ~2G free fails the 3 GiB install gate but the install is not needed here
    // (the tree is complete), and it clears the 1 GiB build floor — so the run
    // proceeds. The two floors exist so a warm tree is not refused an install
    // it was never going to run.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/a/src/x.ts']);
    statfsSyncMock.mockReturnValue({ bavail: 2.2e9, bsize: 1 }); // ~2G free

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: true,
      exec: (command) => {
        calls.push(command);
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    expect(calls.some((c) => c.startsWith('npm ci'))).toBe(false);
    expect(calls).toContain('npm run build --workspace="packages/a"');
    expect(rep.ok).toBe(true);
  });

  it('proceeds when statfs itself is unavailable — the preflight must not invent failures', () => {
    // `statfsSync` does not exist on every platform. An unmeasurable disk lets
    // the run proceed; the preflight exists to prevent failures, not cause them.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/a/src/x.ts']);
    rmSync(join(root, 'node_modules'), { recursive: true, force: true });
    statfsSyncMock.mockImplementation(() => {
      throw new Error('ENOSYS: statfs not supported');
    });

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: true,
      exec: (command, cwd) => {
        calls.push(command);
        if (command.startsWith('npm ci')) {
          mkdirSync(join(cwd, 'node_modules'), { recursive: true });
          writeFileSync(join(cwd, 'node_modules', '.package-lock.json'), '{}');
        }
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    expect(calls.some((c) => c.startsWith('npm ci'))).toBe(true);
    expect(calls).toContain('npm run build --workspace="packages/a"');
    expect(rep.ok).toBe(true);
  });

  it('frames a TEST timeout as infrastructure, not a defect to correlate', () => {
    // A test that runs out of time fails (exitCode null), but the note must not tell
    // the agent to "correlate it with the diff — a failure is a Critical"; the brief
    // says timeouts are infrastructure, and the agent trusts the data over its
    // instructions.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'exit 0', test: 'exit 0' },
    });
    writePlan(['packages/a/src/x.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) =>
        command.startsWith('npm test')
          ? { command, exitCode: null, seconds: 60, timedOut: true, output: '' }
          : { command, exitCode: 0, seconds: 1, timedOut: false, output: '' },
    });

    expect(rep.ok).toBe(false);
    expect(rep.timedOut).toEqual(['npm test --workspace="packages/a"']);
    expect(rep.note).toContain('infrastructure');
    expect(rep.note).not.toContain('Critical');
    expect(rep.note).not.toContain('Correlate');
  });

  it('routes the run through the selected toolchain adapter (pins the delegation)', () => {
    // This PR's whole change is that runBuildTest selects an adapter and delegates
    // to adapter.run. Nothing else pinned that boundary: reverting the facade to the
    // old inline implementation kept every report-shape test green. Spy on the
    // adapter so a revert (adapter never called) turns this red.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', { name: '@x/a', scripts: { build: 'exit 0' } });
    writePlan(['packages/a/src/x.ts']);

    const runSpy = vi.spyOn(npmToolchainAdapter, 'run');

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec,
    });

    expect(runSpy).toHaveBeenCalledTimes(1);
    // The arguments are forwarded to the adapter unchanged.
    expect(runSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        root,
        changedFiles: ['packages/a/src/x.ts'],
        timeout: 60,
        install: false,
        exec: expect.any(Function),
      }),
    );
    // And the report runBuildTest returns IS the adapter's report.
    expect(rep).toBe(runSpy.mock.results[0]?.value);
    runSpy.mockRestore();
  });

  it('defaults the adapter exec to the real runner when none is injected', () => {
    // Every other test injects a fake exec, so the production default path
    // (args.exec undefined -> the real `run`) had zero coverage. Dropping the
    // `?? run` fallback would hand the adapter exec: undefined and crash the first
    // real `qwen review build-test`. Mock the adapter to capture the args it
    // receives (so no real npm spawns) and pin that exec is a function.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', { name: '@x/a', scripts: { build: 'exit 0' } });
    writePlan(['packages/a/src/x.ts']);

    let receivedExec: unknown;
    const runSpy = vi
      .spyOn(npmToolchainAdapter, 'run')
      .mockImplementation((args) => {
        receivedExec = args.exec;
        return {
          toolchain: 'npm',
          affected: [],
          buildSet: [],
          widenedWith: [],
          install: null,
          build: [],
          test: [],
          ok: true,
          timedOut: [],
          note: '',
        };
      });

    runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      // no `exec` — exercise the production default path
    });

    expect(receivedExec).toBeTypeOf('function');
    runSpy.mockRestore();
  });
});

describe('runBuildTest (Maven)', () => {
  let root: string;
  let planPath: string;

  const writePlan = (paths: string[]): void => {
    planPath = join(root, 'plan.json');
    writeFileSync(
      planPath,
      JSON.stringify({
        diffPathAbsolute: '/dev/null',
        files: paths.map((p) => ({ path: p, kind: 'source' })),
      }),
    );
  };

  const pom = (dir: string, body: string): void => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'pom.xml'), body);
  };

  // A nested reactor like the repos this path was built for:
  //   common, libs/dqc-all (aggregator), libs/dqc-all/dqc-core
  const mavenRepo = (): void => {
    pom(
      '',
      '<project><modules><module>common</module>' +
        '<module>libs/dqc-all</module></modules></project>',
    );
    pom('common', '<project/>');
    pom('libs/dqc-all', '<modules><module>dqc-core</module></modules>');
    pom('libs/dqc-all/dqc-core', '<project/>');
  };

  const okExec = (calls: string[]) => (command: string) => {
    calls.push(command);
    return {
      command,
      exitCode: 0,
      seconds: 1,
      timedOut: false,
      output: '',
    };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bt-mvn-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('scopes build and test to the deepest module the diff touches', () => {
    mavenRepo();
    writePlan(['libs/dqc-all/dqc-core/src/Main.java', 'README.md']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.toolchain).toBe('maven');
    expect(rep.affected).toEqual(['libs/dqc-all/dqc-core']);
    expect(calls).toEqual([
      'mvn -B -pl libs/dqc-all/dqc-core -am compile',
      'mvn -B -pl libs/dqc-all/dqc-core -am test',
    ]);
    expect(rep.ok).toBe(true);
    expect(rep.note).toContain('libs/dqc-all/dqc-core');
    // `-am` puts the upstream closure into the test phase too; say so.
    expect(rep.note).toContain('`-am` added');
  });

  it('scopes across two changed modules, sorted and comma-joined', () => {
    mavenRepo();
    writePlan(['common/src/A.java', 'libs/dqc-all/dqc-core/src/B.java']);

    const calls: string[] = [];
    runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(calls[0]).toBe(
      'mvn -B -pl common,libs/dqc-all/dqc-core -am compile',
    );
  });

  it('builds nothing for a diff outside every module — and says so', () => {
    mavenRepo();
    writePlan(['README.md', 'docs/x.md']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.toolchain).toBe('maven');
    expect(rep.affected).toEqual([]);
    expect(calls).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.note).toContain('nothing to build');
  });

  it('runs the whole reactor unscoped when the root pom itself changed', () => {
    mavenRepo();
    writePlan(['pom.xml']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.affected).toEqual(['.']);
    expect(calls).toEqual(['mvn -B compile', 'mvn -B test']);
    expect(rep.ok).toBe(true);
  });

  it('widens a changed NESTED aggregator pom to every module under it', () => {
    // `-pl libs/dqc-all` alone would compile nothing (packaging pom, no
    // sources) and `-am` pulls only upstream — the children inheriting the
    // changed config would never build, a confident false green.
    mavenRepo();
    writePlan(['libs/dqc-all/pom.xml']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    // The aggregator itself stays in the set (the pom file lives in it); a
    // packaging-pom module compiles nothing, so including it is harmless.
    expect(rep.affected).toEqual(['libs/dqc-all', 'libs/dqc-all/dqc-core']);
    expect(calls).toEqual([
      'mvn -B -pl libs/dqc-all,libs/dqc-all/dqc-core -am compile',
      'mvn -B -pl libs/dqc-all,libs/dqc-all/dqc-core -am test',
    ]);
    expect(rep.ok).toBe(true);
  });

  it('widens a changed parent pom whose dir is NOT itself a declared module', () => {
    // The widening's other branch: an inheritance-only parent pom sits at a
    // strict prefix of module dirs without being a module itself, so the
    // file-mapping puts it under no module. Without the widening, the
    // children inheriting the change would never build.
    mavenRepo();
    pom('libs', '<project/>');
    writePlan(['libs/pom.xml']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.affected).toEqual(['libs/dqc-all', 'libs/dqc-all/dqc-core']);
    expect(calls[0]).toBe(
      'mvn -B -pl libs/dqc-all,libs/dqc-all/dqc-core -am compile',
    );
  });

  it('unions widened descendants with the modules the diff also touches', () => {
    mavenRepo();
    writePlan(['libs/dqc-all/pom.xml', 'common/src/A.java']);

    const calls: string[] = [];
    runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(calls[0]).toBe(
      'mvn -B -pl common,libs/dqc-all,libs/dqc-all/dqc-core -am compile',
    );
  });

  it('treats a zero-module pom as one project: any change builds the root', () => {
    pom('', '<project/>');
    writePlan(['src/main/java/A.java']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.toolchain).toBe('maven');
    expect(calls).toEqual(['mvn -B compile', 'mvn -B test']);
  });

  it.skipIf(process.platform === 'win32')(
    'prefers ./mvnw when the repo pins a Maven wrapper',
    () => {
      mavenRepo();
      writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n', { mode: 0o755 });
      writePlan(['common/src/A.java']);

      const calls: string[] = [];
      runBuildTest({
        plan: planPath,
        worktree: root,
        timeout: 60,
        install: false,
        exec: okExec(calls),
      });

      expect(calls[0]).toBe('./mvnw -B -pl common -am compile');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'falls back to mvn when the wrapper lacks the exec bit',
    () => {
      // A wrapper committed from a Windows checkout has mode 644; `./mvnw`
      // would exit 126 on every command and misroute into the correlate-with-
      // diff framing. Degrade to `mvn` instead.
      mavenRepo();
      writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n', { mode: 0o644 });
      writePlan(['common/src/A.java']);

      const calls: string[] = [];
      runBuildTest({
        plan: planPath,
        worktree: root,
        timeout: 60,
        install: false,
        exec: okExec(calls),
      });

      expect(calls[0]).toBe('mvn -B -pl common -am compile');
    },
  );

  it('uses mvnw.cmd on Windows, where the POSIX exec-bit gate never fires', () => {
    // Node synthesizes the mode without 0o111 on Windows, so the exec-bit
    // gate can never pick the wrapper there — and `./mvnw` is a shell script
    // cmd cannot run anyway. The pinned wrapper on Windows is `mvnw.cmd`.
    mavenRepo();
    writeFileSync(join(root, 'mvnw.cmd'), '@echo off\r\n');
    writePlan(['common/src/A.java']);

    const platform = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    try {
      const calls: string[] = [];
      runBuildTest({
        plan: planPath,
        worktree: root,
        timeout: 60,
        install: false,
        exec: okExec(calls),
      });
      expect(calls[0]).toBe('mvnw.cmd -B -pl common -am compile');
    } finally {
      platform.mockRestore();
    }
  });

  it('skips the test command on --buildOnly', () => {
    mavenRepo();
    writePlan(['common/src/A.java']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      buildOnly: true,
      exec: okExec(calls),
    });

    expect(calls).toEqual(['mvn -B -pl common -am compile']);
    expect(rep.test).toEqual([]);
    expect(rep.note).toContain('build-only');
  });

  it('falls back to `unsupported` when a declared module dir has no pom.xml', () => {
    // Files under `ghost/` would map to no module and report a false green,
    // so the scoping hands off instead of guessing. The injected exec pins
    // that the handoff happens BEFORE any command: a regression of the guard
    // would otherwise spawn a real `mvn` on the host before the assertion
    // could fail.
    pom('', '<modules><module>common</module><module>ghost</module></modules>');
    pom('common', '<project/>');
    writePlan(['common/src/A.java']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(calls).toEqual([]);
    expect(rep.toolchain).toBe('unsupported');
    expect(rep.note).toContain('cannot model');
  });

  it('hands off when -pl selects a module only an inactive profile declares', () => {
    // A profile-declared module is captured by the layout walk, but `-pl`
    // selects against the DEFAULT reactor, which does not include it while
    // the profile is inactive — Maven refuses the selection itself. Framing
    // that as a diff-correlated build failure would push a Critical for a
    // reactor-selection error; hand off instead.
    pom(
      '',
      '<project><modules><module>common</module></modules>' +
        '<profiles><profile><id>release</id><modules>' +
        '<module>distribution</module></modules></profile></profiles>' +
        '</project>',
    );
    pom('common', '<project/>');
    pom('distribution', '<project/>');
    writePlan(['distribution/src/X.java']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => {
        calls.push(command);
        return {
          command,
          exitCode: 1,
          seconds: 1,
          timedOut: false,
          output:
            '[ERROR] Could not find the selected project in the reactor: ' +
            'distribution',
        };
      },
    });

    expect(calls).toHaveLength(1); // the failed selection is not evidence
    expect(rep.toolchain).toBe('unsupported');
    expect(rep.ok).toBe(true);
    expect(rep.note).toContain('profile');
    expect(rep.note).not.toContain('Critical');
  });

  it('stops after a failed build and frames it for correlation with the diff', () => {
    mavenRepo();
    writePlan(['common/src/A.java']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => {
        calls.push(command);
        return {
          command,
          exitCode: command.endsWith('compile') ? 1 : 0,
          seconds: 1,
          timedOut: false,
          output: '[ERROR] compile failed',
        };
      },
    });

    expect(calls).toHaveLength(1); // no test after a failed compile
    expect(rep.ok).toBe(false);
    expect(rep.note).toContain('Critical');
  });

  it('frames a build timeout as infrastructure, not a defect', () => {
    mavenRepo();
    writePlan(['common/src/A.java']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) => ({
        command,
        exitCode: null,
        seconds: 60,
        timedOut: true,
        output: '',
      }),
    });

    expect(rep.ok).toBe(false);
    expect(rep.timedOut).toEqual(['mvn -B -pl common -am compile']);
    expect(rep.note).toContain('infrastructure');
    expect(rep.note).not.toContain('Critical');
  });

  it('frames a TEST timeout as infrastructure, not a defect to correlate', () => {
    // The Maven analogue of the npm suite's test-timeout case: a `mvn test`
    // killed at the deadline must hit the infra branch, not the "correlate
    // with the diff — a failure is a Critical" framing.
    mavenRepo();
    writePlan(['common/src/A.java']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) =>
        command.endsWith('test')
          ? { command, exitCode: null, seconds: 60, timedOut: true, output: '' }
          : { command, exitCode: 0, seconds: 1, timedOut: false, output: '' },
    });

    expect(rep.ok).toBe(false);
    expect(rep.timedOut).toEqual(['mvn -B -pl common -am test']);
    expect(rep.note).toContain('ran out of time');
    expect(rep.note).toContain('infrastructure');
    expect(rep.note).not.toContain('Critical');
    expect(rep.note).not.toContain('Correlate');
  });

  it('frames a failing test for correlation with the diff', () => {
    mavenRepo();
    writePlan(['common/src/A.java']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: (command) =>
        command.endsWith('test')
          ? {
              command,
              exitCode: 1,
              seconds: 2,
              timedOut: false,
              output: '[ERROR] Tests run: 3, Failures: 1',
            }
          : { command, exitCode: 0, seconds: 1, timedOut: false, output: '' },
    });

    expect(rep.ok).toBe(false);
    expect(rep.note).toContain('1 command(s) failed');
    expect(rep.note).toContain('pre-existing');
  });

  it('skips the build on a low-disk machine and frames it as environment', () => {
    mavenRepo();
    writePlan(['common/src/A.java']);
    statfsSyncMock.mockReturnValue({ bavail: 100, bsize: 1 });

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(calls).toEqual([]);
    expect(rep.ok).toBe(false);
    expect(rep.note).toContain('Insufficient disk space');
  });

  it('widens a changed parent pom along INHERITANCE edges, not just directory ones', () => {
    // False green confirmed by probe: root declares `parent` + `app`; `app`
    // inherits `../parent`; a diff changing only `parent/pom.xml` used to
    // scope `mvn -pl parent -am` — the packaging-pom module compiles
    // nothing, `-am` pulls only upstream, and `app` (the module that
    // inherits the change) is never built while the report says green.
    pom(
      '',
      '<project><modules><module>parent</module>' +
        '<module>app</module></modules></project>',
    );
    pom('parent', '<project/>');
    pom(
      'app',
      '<project><parent><relativePath>../parent</relativePath></parent></project>',
    );
    writePlan(['parent/pom.xml']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.affected).toEqual(['app', 'parent']);
    expect(calls[0]).toBe('mvn -B -pl app,parent -am compile');
  });

  it('widens to inheritors when the changed parent pom is NOT a declared module', () => {
    pom('', '<project><modules><module>app</module></modules></project>');
    pom('parent', '<project/>');
    pom(
      'app',
      '<project><parent><relativePath>../parent</relativePath></parent></project>',
    );
    writePlan(['parent/pom.xml']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.affected).toEqual(['app']);
    expect(calls[0]).toBe('mvn -B -pl app -am compile');
  });

  it('keeps a changed leaf-module pom scoped to that module', () => {
    // The unplaceable-pom fallback must not fire for the common case: a
    // module's OWN pom changed — the file mapping already names the module.
    mavenRepo();
    writePlan(['common/pom.xml']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.affected).toEqual(['common']);
    expect(calls[0]).toBe('mvn -B -pl common -am compile');
  });

  it('builds the whole reactor for a pom the module model cannot place', () => {
    // Not a module, nothing under it, nothing inheriting it: an inheritance
    // chain through it is invisible to the walk, so scoping cannot be
    // trusted — the whole reactor is the safe answer.
    mavenRepo();
    pom('stray', '<project/>');
    writePlan(['stray/pom.xml']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.affected).toEqual(['.']);
    expect(calls).toEqual(['mvn -B compile', 'mvn -B test']);
  });

  it('builds the whole reactor when a reactor-global build input changed', () => {
    // `mvnw`, `mvnw.cmd`, and `.mvn/` config (arg files, JVM flags,
    // extensions) change what EVERY module compiles, exactly like the root
    // pom. Such a diff maps to no module and used to report "nothing to
    // build — a complete answer" with zero commands run.
    mavenRepo();
    for (const f of [
      'mvnw',
      'mvnw.cmd',
      '.mvn/maven.config',
      '.mvn/jvm.config',
    ]) {
      writePlan([f]);
      const calls: string[] = [];
      const rep = runBuildTest({
        plan: planPath,
        worktree: root,
        timeout: 60,
        install: false,
        exec: okExec(calls),
      });
      expect(rep.affected).toEqual(['.']);
      expect(calls).toEqual(['mvn -B compile', 'mvn -B test']);
    }
  });

  it('does not treat a wrapper INSIDE a module as reactor-global', () => {
    mavenRepo();
    writePlan(['common/mvnw']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.affected).toEqual(['common']);
    expect(calls[0]).toBe('mvn -B -pl common -am compile');
  });

  it('pins the exact affected set when no pom changed — no spurious widening', () => {
    mavenRepo();
    writePlan(['common/src/A.java', 'libs/dqc-all/dqc-core/src/B.java']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec([]),
    });

    // Exactly what affectedMavenModules computed — content AND order. The
    // aggregator libs/dqc-all is NOT dragged in; a regression that always
    // merged or re-widened `pomWidened` would change this array.
    expect(rep.affected).toEqual(['common', 'libs/dqc-all/dqc-core']);
  });

  it('routes to Maven when a stub root package.json has no build/test scripts', () => {
    // Renovate/prettier stub manifests in Maven monorepos: package.json
    // EXISTS, so a gate "simplified" to existence would misroute the repo
    // out of runMavenBuildTest. readRootPackage returns null (no scripts),
    // which is load-bearing here.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'stub' }));
    mavenRepo();
    writePlan(['common/src/A.java']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.toolchain).toBe('maven');
    expect(calls[0]).toBe('mvn -B -pl common -am compile');
  });

  it('proceeds when statfs itself is unavailable — the Maven preflight must not invent failures', () => {
    // `freeDiskBytes` returns null wherever statfsSync throws; JS coerces
    // `null < floor` to true, so an unwitnessed guard drop would skip every
    // Maven build on such a host with "Insufficient disk space (0.0G free)".
    mavenRepo();
    writePlan(['common/src/A.java']);
    statfsSyncMock.mockImplementation(() => {
      throw new Error('ENOSYS: statfs not supported');
    });

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(calls).toEqual([
      'mvn -B -pl common -am compile',
      'mvn -B -pl common -am test',
    ]);
    expect(rep.ok).toBe(true);
  });

  it('never picks the POSIX wrapper on win32 when only mvnw exists', () => {
    // `./mvnw` is a shell script cmd cannot run; selection must fall through
    // to `mvn`. Pins the win32 side of wrapper platform exclusivity.
    mavenRepo();
    writeFileSync(join(root, 'mvnw'), '#!/bin/sh\n');
    writePlan(['common/src/A.java']);

    const platform = vi
      .spyOn(process, 'platform', 'get')
      .mockReturnValue('win32');
    try {
      const calls: string[] = [];
      runBuildTest({
        plan: planPath,
        worktree: root,
        timeout: 60,
        install: false,
        exec: okExec(calls),
      });
      expect(calls[0]).toBe('mvn -B -pl common -am compile');
    } finally {
      platform.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'falls back to mvn on POSIX when only mvnw.cmd exists',
    () => {
      // The wrong-platform wrapper exits non-zero instantly — not a timeout,
      // no reactor-selection text — which would be framed as a Critical for
      // the PR instead of infrastructure.
      mavenRepo();
      writeFileSync(join(root, 'mvnw.cmd'), '@echo off\r\n');
      writePlan(['common/src/A.java']);

      const calls: string[] = [];
      runBuildTest({
        plan: planPath,
        worktree: root,
        timeout: 60,
        install: false,
        exec: okExec(calls),
      });
      expect(calls[0]).toBe('mvn -B -pl common -am compile');
    },
  );

  it('hands off a diff that only touches a nested npm project', () => {
    // The Maven gate routes on ROOT layout; it must not certify green for a
    // diff mvn never compiles — the npm project's own build/test is the one
    // the change can break.
    mavenRepo();
    mkdirSync(join(root, 'tools', 'web-console', 'src'), { recursive: true });
    writeFileSync(
      join(root, 'tools', 'web-console', 'package.json'),
      JSON.stringify({ name: 'web', scripts: { build: 'x', test: 'x' } }),
    );
    writePlan(['tools/web-console/src/index.ts']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.toolchain).toBe('unsupported');
    expect(calls).toEqual([]);
    expect(rep.note).toContain('tools/web-console');
  });

  it('hands off when the npm project is nested UNDER a module dir', () => {
    // The file maps to a module, so mvn would run green over the Java code
    // while the npm project's own build/test never runs.
    mavenRepo();
    mkdirSync(join(root, 'common', 'console'), { recursive: true });
    writeFileSync(
      join(root, 'common', 'console', 'package.json'),
      JSON.stringify({ name: 'c', scripts: { build: 'x', test: 'x' } }),
    );
    writePlan(['common/console/src/index.ts']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.toolchain).toBe('unsupported');
    expect(calls).toEqual([]);
  });

  it('still certifies a docs-only diff in a Maven repo', () => {
    mavenRepo();
    writePlan(['README.md']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.toolchain).toBe('maven');
    expect(rep.ok).toBe(true);
    expect(calls).toEqual([]);
    expect(rep.note).toContain('nothing to build');
  });

  it('keeps the npm path for a repo that has BOTH npm and Maven layouts', () => {
    // npm owns a repo that declares it; the Maven branch only takes repos
    // npm is entirely absent from.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'both',
        scripts: { build: 'exit 0', test: 'exit 0' },
      }),
    );
    pom('', '<project><modules><module>common</module></modules></project>');
    pom('common', '<project/>');
    // npm completeness markers, as the main suite's beforeEach would set them
    writeFileSync(join(root, 'package-lock.json'), '{}');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.package-lock.json'), '{}');
    writePlan(['src/a.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec([]),
    });

    expect(rep.toolchain).toBe('npm');
  });

  it('keeps the npm-UNMODELED handoff even when a pom.xml exists', () => {
    // The Maven gate's invariant is `globs.length === 0`: a repo that
    // DECLARES workspaces keeps the npm handoff even when the globs are
    // unmodeled and a pom.xml exists. Without it, the changed workspace file
    // maps to no Maven module and the report would say "nothing to build" —
    // a false green replacing the safe handoff to the brief's fallback.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/**'] }),
    );
    pom('', '<project/>');
    mkdirSync(join(root, 'packages', 'a'), { recursive: true });
    writePlan(['packages/a/src/x.ts']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 5,
      install: false,
      exec: okExec(calls),
    });

    expect(calls).toEqual([]);
    expect(rep.toolchain).toBe('unsupported');
    expect(rep.note).toContain('does not model');
  });

  it('keeps the npm no-packages handoff even when a pom.xml exists', () => {
    // Declared workspaces matching nothing: same false-green shape, other half
    // of the guard (`globs.length === 0` false here, `packages` empty).
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pom('', '<project/>');
    writePlan(['packages/a/src/x.ts']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 5,
      install: false,
      exec: okExec(calls),
    });

    expect(calls).toEqual([]);
    expect(rep.toolchain).toBe('unsupported');
    expect(rep.note).toContain('No npm package here to scope');
  });

  it('routes a Maven-only diff to Maven when the ROOT is an npm workspace repo', () => {
    // Polyglot false green: workspaces at the root, a Maven project that is
    // NOT a workspace; the java file mapped to no workspace and the report
    // certified "nothing to build" with zero commands.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    mkdirSync(join(root, 'packages', 'web'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'web', 'package.json'),
      JSON.stringify({ name: '@x/web', scripts: { build: 'exit 0' } }),
    );
    pom('', '<project><modules><module>backend</module></modules></project>');
    pom('backend', '<project/>');
    writePlan(['backend/src/Main.java']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.toolchain).toBe('maven');
    expect(calls[0]).toBe('mvn -B -pl backend -am compile');
  });

  it('hands off a MIXED workspace+Maven diff — one toolchain per call', () => {
    // The empty-affected gate's twin: the npm build would certify green
    // while the Maven side of the diff never compiles.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    mkdirSync(join(root, 'packages', 'web'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'web', 'package.json'),
      JSON.stringify({ name: '@x/web', scripts: { build: 'exit 0' } }),
    );
    pom('', '<project><modules><module>backend</module></modules></project>');
    pom('backend', '<project/>');
    writePlan(['packages/web/src/a.ts', 'backend/src/Main.java']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.toolchain).toBe('unsupported');
    expect(calls).toEqual([]);
  });

  it('routes a Maven-only diff to Maven when the ROOT is a single npm package', () => {
    // The single-root npm build used to certify green here: affected ['.'],
    // the root build passes, the changed Java code is never compiled.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        scripts: { build: 'exit 0', test: 'exit 0' },
      }),
    );
    pom('', '<project><modules><module>backend</module></modules></project>');
    pom('backend', '<project/>');
    writePlan(['backend/src/Main.java']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.toolchain).toBe('maven');
    expect(calls[0]).toBe('mvn -B -pl backend -am compile');
  });

  it('hands off a MIXED npm+Maven diff under a single root package', () => {
    // One toolchain per call: certifying either half alone would report
    // green while the other half's code never compiles.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'r',
        scripts: { build: 'exit 0', test: 'exit 0' },
      }),
    );
    pom('', '<project><modules><module>backend</module></modules></project>');
    pom('backend', '<project/>');
    writePlan(['backend/src/Main.java', 'src/a.ts']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.toolchain).toBe('unsupported');
    expect(calls).toEqual([]);
  });

  it('hands off an empty-affected diff claimed by a NESTED project (no root pom)', () => {
    // The nested Maven project is found by walking the changed files'
    // ancestors — there is no root pom.xml for the layout to read.
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    mkdirSync(join(root, 'packages', 'web'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'web', 'package.json'),
      JSON.stringify({ name: '@x/web', scripts: { build: 'exit 0' } }),
    );
    pom('backend', '<project/>');
    writePlan(['backend/src/Main.java']);

    const calls: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
      exec: okExec(calls),
    });

    expect(rep.toolchain).toBe('unsupported');
    expect(calls).toEqual([]);
  });
});

describe('runBuildTest (workspace in a repo subdirectory)', () => {
  // Monorepo developers open the workspace in a module subdir; the agent's
  // cwd — and therefore the local review's `--worktree` — is that subdir,
  // while capture-local's plan paths are repo-root-relative. The build must
  // re-anchor to the repo root instead of false-greening "nothing to build".
  let repo: string;
  let home: string;
  let planPath: string;
  let savedEnv: NodeJS.ProcessEnv;

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'bt-sub-'));
    home = mkdtempSync(join(tmpdir(), 'bt-sub-home-'));
    writeFileSync(join(home, '.gitconfig'), '');
    // Isolate from the developer's git environment (templates, hooks,
    // gpgsign) — the same pattern as git.integration.test.ts.
    savedEnv = { ...process.env };
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    process.env['GIT_CONFIG_GLOBAL'] = join(home, '.gitconfig');
    process.env['HOME'] = home;

    git('init', '-q', '--template=', '.');
    git('config', 'user.email', 'a@b');
    git('config', 'user.name', 'a');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', join(repo, '.no-such-hooks'));

    // A nested Maven reactor.
    writeFileSync(
      join(repo, 'pom.xml'),
      '<project><modules><module>common</module>' +
        '<module>libs/dqc-all</module></modules></project>',
    );
    mkdirSync(join(repo, 'common', 'src'), { recursive: true });
    mkdirSync(join(repo, 'libs', 'dqc-all', 'dqc-core', 'src'), {
      recursive: true,
    });
    writeFileSync(join(repo, 'common', 'pom.xml'), '<project/>');
    writeFileSync(
      join(repo, 'libs', 'dqc-all', 'pom.xml'),
      '<project><modules><module>dqc-core</module></modules></project>',
    );
    writeFileSync(
      join(repo, 'libs', 'dqc-all', 'dqc-core', 'pom.xml'),
      '<project/>',
    );
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'init');

    planPath = join(repo, 'plan.json');
  });

  afterEach(() => {
    process.env = savedEnv;
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('re-anchors to the repo root when the worktree is a module subdir', () => {
    writeFileSync(
      join(repo, 'libs', 'dqc-all', 'dqc-core', 'src', 'B.java'),
      'class B {}',
    );
    writeFileSync(
      planPath,
      JSON.stringify({
        files: [{ path: 'libs/dqc-all/dqc-core/src/B.java', kind: 'source' }],
      }),
    );

    const cwds: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: join(repo, 'libs', 'dqc-all'),
      timeout: 60,
      install: false,
      exec: (command, cwd) => {
        cwds.push(cwd);
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    expect(rep.toolchain).toBe('maven');
    expect(rep.affected).toEqual(['libs/dqc-all/dqc-core']);
    expect(rep.build[0]?.command).toBe(
      'mvn -B -pl libs/dqc-all/dqc-core -am compile',
    );
    // Commands ran in the repo root, not the subdirectory worktree.
    // realpath: on macOS the /var/folders tmp path carries a /private prefix
    // once resolved, and the re-anchor compares realpath'd paths.
    const repoReal = realpathSync(repo);
    expect(cwds.every((c) => c === repoReal)).toBe(true);
  });

  it('still scopes from the repo root when the worktree already IS the root', () => {
    writeFileSync(join(repo, 'common', 'src', 'A.java'), 'class A {}');
    writeFileSync(
      planPath,
      JSON.stringify({
        files: [{ path: 'common/src/A.java', kind: 'source' }],
      }),
    );

    const rep = runBuildTest({
      plan: planPath,
      worktree: repo,
      timeout: 60,
      install: false,
      exec: (command) => ({
        command,
        exitCode: 0,
        seconds: 1,
        timedOut: false,
        output: '',
      }),
    });

    expect(rep.toolchain).toBe('maven');
    expect(rep.affected).toEqual(['common']);
  });

  it('never moves a linked worktree — it IS its own --show-toplevel', () => {
    // The load-bearing claim behind "PR reviews never re-anchor", pinned
    // with a real linked worktree instead of a comment.
    const linked = join(repo, 'linked-wt');
    git('worktree', 'add', '--detach', '-q', linked, 'HEAD');
    expect(rebaseToRepoRoot(linked)).toBe(linked);
  });
});

describe('runBuildTest (npm workspace in a repo subdirectory)', () => {
  // rebaseToRepoRoot is load-bearing for the npm path too: a monorepo
  // developer's cwd is the workspace subdir, the plan's paths are
  // repo-root-relative, and the lockfile sits at the root. A mutant moving
  // the re-anchor into the Maven branch shipped every test green — these pin
  // the npm semantics, plus the standalone-project case the re-anchor must
  // NOT swallow.
  let repo: string;
  let home: string;
  let planPath: string;
  let savedEnv: NodeJS.ProcessEnv;

  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'bt-sub-npm-'));
    home = mkdtempSync(join(tmpdir(), 'bt-sub-npm-home-'));
    writeFileSync(join(home, '.gitconfig'), '');
    // Isolate from the developer's git environment — the same pattern as the
    // Maven subdir suite above.
    savedEnv = { ...process.env };
    process.env['GIT_CONFIG_NOSYSTEM'] = '1';
    process.env['GIT_CONFIG_GLOBAL'] = join(home, '.gitconfig');
    process.env['HOME'] = home;

    git('init', '-q', '--template=', '.');
    git('config', 'user.email', 'a@b');
    git('config', 'user.name', 'a');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', join(repo, '.no-such-hooks'));

    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    writeFileSync(join(repo, 'package-lock.json'), '{}');
    mkdirSync(join(repo, 'packages', 'a', 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'a', 'package.json'),
      JSON.stringify({
        name: '@x/a',
        scripts: { build: 'exit 0', test: 'exit 0' },
      }),
    );
    // npm completeness markers, so the install is skipped.
    mkdirSync(join(repo, 'node_modules'), { recursive: true });
    writeFileSync(join(repo, 'node_modules', '.package-lock.json'), '{}');
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', 'init');

    planPath = join(repo, 'plan.json');
  });

  afterEach(() => {
    process.env = savedEnv;
    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('re-anchors a workspace subdir to the repo root and scopes the workspace', () => {
    writeFileSync(join(repo, 'packages', 'a', 'src', 'x.ts'), 'export {}');
    writeFileSync(
      planPath,
      JSON.stringify({
        files: [{ path: 'packages/a/src/x.ts', kind: 'source' }],
      }),
    );

    const calls: string[] = [];
    const cwds: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: join(repo, 'packages', 'a'),
      timeout: 60,
      install: false,
      exec: (command, cwd) => {
        calls.push(command);
        cwds.push(cwd);
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    expect(rep.toolchain).toBe('npm');
    expect(rep.affected).toEqual(['packages/a']);
    expect(calls).toContain('npm run build --workspace="packages/a"');
    // Commands ran in the repo root, not the subdirectory worktree
    // (realpath: macOS tmp paths carry a /private prefix once resolved).
    const repoReal = realpathSync(repo);
    expect(cwds.every((c) => c === repoReal)).toBe(true);
  });

  it('keeps a standalone nested project on its own root when the repo root has no layout', () => {
    // The unconditional re-anchor dropped this deterministic build: scoping
    // moved to a root with no package.json and the report degraded to the
    // prose fallback ("No npm package here to scope").
    rmSync(join(repo, 'package.json'));
    rmSync(join(repo, 'package-lock.json'));
    rmSync(join(repo, 'node_modules'), { recursive: true, force: true });
    mkdirSync(join(repo, 'sub', 'project', 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'sub', 'project', 'package.json'),
      JSON.stringify({
        name: 'p',
        scripts: { build: 'exit 0', test: 'exit 0' },
      }),
    );
    writeFileSync(join(repo, 'sub', 'project', 'src', 'x.ts'), 'export {}');
    writeFileSync(
      planPath,
      JSON.stringify({
        files: [{ path: 'sub/project/src/x.ts', kind: 'source' }],
      }),
    );

    const calls: string[] = [];
    const cwds: string[] = [];
    const rep = runBuildTest({
      plan: planPath,
      worktree: join(repo, 'sub', 'project'),
      timeout: 60,
      install: false,
      exec: (command, cwd) => {
        calls.push(command);
        cwds.push(cwd);
        return {
          command,
          exitCode: 0,
          seconds: 1,
          timedOut: false,
          output: '',
        };
      },
    });

    expect(rep.toolchain).toBe('npm');
    expect(rep.affected).toEqual(['.']);
    expect(calls).toContain('npm run build');
    const projReal = realpathSync(join(repo, 'sub', 'project'));
    expect(cwds.every((c) => c === projReal)).toBe(true);
  });
});
