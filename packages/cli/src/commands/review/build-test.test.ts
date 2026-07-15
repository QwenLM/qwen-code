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
    // node_modules present, so the install is skipped and no network is touched.
    mkdirSync(join(root, 'node_modules'), { recursive: true });
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

  it('scopes the build to the changed workspace and its dependents', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    // `npm run build --workspace=<dir>` is what the command actually shells out to,
    // and it resolves the workspace by directory — so a real (tiny) npm workspace
    // is the honest fixture here.
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
    });
    expect(rep.affected).toEqual(['packages/core']);
    // core changed, so leaf's compile is where a break would surface.
    expect(rep.buildSet).toContain('packages/leaf');
    // island depends on nothing that changed.
    expect(rep.buildSet).not.toContain('packages/island');
    // Only the changed workspace's tests run.
    expect(rep.test.map((t) => t.command)).toEqual([
      'npm test --workspace=packages/core',
    ]);
    expect(rep.ok).toBe(true);
  });

  it('reports a build failure with its output, and does not call it ok', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', {
      name: '@x/a',
      scripts: { build: 'echo "error TS2345: nope" && exit 1' },
    });
    writePlan(['packages/a/src/x.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
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
    // It fails until the marker that `templates`' build drops appears.
    pkg('packages/templates', {
      name: '@x/templates',
      scripts: { build: 'touch ../../.templates-built' },
    });
    pkg('packages/leaf', {
      name: '@x/leaf',
      scripts: {
        build:
          'test -f ../../.templates-built || ' +
          '{ echo "error TS2307: Cannot find module \'@x/templates\'"; exit 2; }',
        test: 'exit 0',
      },
    });
    writePlan(['packages/leaf/src/x.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 60,
      install: false,
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
      // An install that fails the way this repo's does: the tree lands, the
      // building `prepare` script blows up on someone else's file, exit 1.
      exec: (command, cwd, _timeoutMs) => {
        calls.push(command);
        if (command.startsWith('npm ci')) {
          mkdirSync(join(cwd, 'node_modules'), { recursive: true });
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
    expect(calls).toContain('npm run build --workspace=packages/a');
    expect(calls).toContain('npm test --workspace=packages/a');
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

  it('calls a deadline an infrastructure result, never a defect in the diff', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'r', workspaces: ['packages/*'] }),
    );
    pkg('packages/a', { name: '@x/a', scripts: { build: 'sleep 30' } });
    writePlan(['packages/a/src/x.ts']);

    const rep = runBuildTest({
      plan: planPath,
      worktree: root,
      timeout: 1,
      install: false,
    });
    expect(rep.timedOut).toEqual(['npm run build --workspace=packages/a']);
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
    expect(rep.timedOut).toEqual(['npm test --workspace=packages/a']);
    expect(rep.note).toContain('infrastructure');
    expect(rep.note).not.toContain('Critical');
    expect(rep.note).not.toContain('Correlate');
  });
});
