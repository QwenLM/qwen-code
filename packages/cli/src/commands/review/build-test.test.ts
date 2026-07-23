/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runBuildTest,
  unresolvedWorkspaceDeps,
  buildRunEnv,
} from './build-test.js';
import type { WorkspacePackage } from './lib/workspaces.js';

const PKGS: WorkspacePackage[] = [
  { dir: 'packages/core', name: '@x/core', scripts: ['build'], deps: [] },
  { dir: 'packages/webui', name: '@x/webui', scripts: ['build'], deps: [] },
];

describe('unresolvedWorkspaceDeps', () => {
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
    rmSync(root, { recursive: true, force: true });
  });

  it('reports `unsupported` for a repo with no workspaces, rather than guessing', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r' }));
    writePlan(['src/a.ts']);
    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 5,
      install: false,
    });
    expect(rep.toolchain).toBe('unsupported');
    expect(rep.ok).toBe(true);
    expect(rep.build).toEqual([]);
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
    expect(rep.note).toContain('does not model');
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

  it('builds and tests nothing for a docs-only diff — and says so', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', { name: '@x/a', scripts: { build: 'exit 0' } });
    writePlan(['README.md', 'docs/x.md']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 5,
      install: false,
    });
    expect(rep.affected).toEqual([]);
    expect(rep.build).toEqual([]);
    expect(rep.test).toEqual([]);
    expect(rep.ok).toBe(true);
    expect(rep.note).toContain('no package to build');
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

  it('scopes the build to the changed workspace and its dependents', () => {
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
    pkg('packages/island', { name: '@x/island', scripts: { build: 'exit 0' } });
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
    // island depends on nothing that changed.
    expect(rep.buildSet).not.toContain('packages/island');
    // Only the changed workspace's tests run.
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace="packages/core"',
    ]);
    expect(rep.ok).toBe(true);
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
});
