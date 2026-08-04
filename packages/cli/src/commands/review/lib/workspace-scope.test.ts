/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { isInertLicense, resolveTestScope } from './workspace-scope.js';
import type { WorkspacePackage } from './workspaces.js';

const GLOBS = ['packages/*'];

const p = (
  dir: string,
  name: string,
  deps: string[] = [],
  scripts: string[] = ['test'],
): WorkspacePackage => ({ dir, name, scripts, deps });

// Seven packages: core <- mid <- top is the dependency chain, the rest are
// islands — big enough that a three-package closure stays under the half cap.
const PKGS: WorkspacePackage[] = [
  p('packages/core', '@x/core'),
  p('packages/mid', '@x/mid', ['@x/core']),
  p('packages/top', '@x/top', ['@x/mid']),
  p('packages/i1', '@x/i1'),
  p('packages/i2', '@x/i2'),
  p('packages/i3', '@x/i3'),
  p('packages/i4', '@x/i4'),
];

describe('resolveTestScope', () => {
  it('scopes a single-workspace diff to that workspace', () => {
    const scope = resolveTestScope({
      changed: ['packages/i1/src/a.ts'],
      globs: GLOBS,
      packages: PKGS,
      skipped: [],
    });
    expect(scope).toEqual({ workspaces: ['packages/i1'] });
  });

  it('includes the transitive reverse-dependency closure of the diff', () => {
    // A behaviour change in core can fail top's suite with mid unchanged in
    // between — the compile catches none of that, only top's tests do.
    const scope = resolveTestScope({
      changed: ['packages/core/src/a.ts'],
      globs: GLOBS,
      packages: PKGS,
      skipped: [],
    });
    expect(scope).toEqual({
      workspaces: ['packages/core', 'packages/mid', 'packages/top'],
    });
  });

  it('follows a reverse-alphabetical chain — the closure is a fixed point, not one pass', () => {
    // a-app <- m-adapter <- z-core: the outer dependent sorts BEFORE its
    // intermediate, so a single pass over the alphabet ends before reaching
    // it and silently drops the suite most likely to catch the break.
    const chain: WorkspacePackage[] = [
      p('packages/a-app', '@x/a-app', ['@x/m-adapter']),
      p('packages/m-adapter', '@x/m-adapter', ['@x/z-core']),
      p('packages/z-core', '@x/z-core'),
      p('packages/i1', '@x/i1'),
      p('packages/i2', '@x/i2'),
      p('packages/i3', '@x/i3'),
    ];
    const scope = resolveTestScope({
      changed: ['packages/z-core/src/a.ts'],
      globs: GLOBS,
      packages: chain,
      skipped: [],
    });
    expect(scope).toEqual({
      workspaces: ['packages/a-app', 'packages/m-adapter', 'packages/z-core'],
    });
  });

  it('does not drag in the DEPENDENCIES of a changed leaf', () => {
    // top merely uses mid and core; changing top cannot have broken them, and
    // a closure that walked forward edges would grow into the whole monorepo.
    const scope = resolveTestScope({
      changed: ['packages/top/src/a.ts'],
      globs: GLOBS,
      packages: PKGS,
      skipped: [],
    });
    expect(scope).toEqual({ workspaces: ['packages/top'] });
  });

  it('excludes members with no test script — the list is exactly the suites that run', () => {
    // mid depends on core but defines only a build script: naming it would
    // claim coverage nothing can run.
    const withBuildOnly: WorkspacePackage[] = [
      p('packages/core', '@x/core'),
      p('packages/mid', '@x/mid', ['@x/core'], ['build']),
      p('packages/top', '@x/top', ['@x/mid']),
      p('packages/i1', '@x/i1'),
      p('packages/i2', '@x/i2'),
      p('packages/i3', '@x/i3'),
      p('packages/i4', '@x/i4'),
    ];
    const scope = resolveTestScope({
      changed: ['packages/core/src/a.ts'],
      globs: GLOBS,
      packages: withBuildOnly,
      skipped: [],
    });
    expect(scope).toEqual({
      workspaces: ['packages/core', 'packages/top'],
    });
  });

  it('records a caveat for an influential file outside every workspace, and still runs the closure', () => {
    const scope = resolveTestScope({
      changed: ['packages/i1/src/a.ts', 'scripts/prepare.js'],
      globs: GLOBS,
      packages: PKGS,
      skipped: [],
    });
    expect(scope.workspaces).toEqual(['packages/i1']);
    expect(scope.caveat).toContain('scripts/prepare.js');
    expect(scope.caveat).toContain('outside every workspace');
  });

  it('treats the root package.json as influential — it defines the test scripts themselves', () => {
    const scope = resolveTestScope({
      changed: ['package.json'],
      globs: GLOBS,
      packages: PKGS,
      skipped: [],
    });
    expect(scope.workspaces).toEqual([]);
    expect(scope.caveat).toContain('package.json');
  });

  it('records no caveat for a member a negation excludes — the npm graph cannot feel it', () => {
    // !packages/desktop is a separate toolchain with its own lockfile; a diff
    // inside it cannot fail any included workspace's suite.
    const scope = resolveTestScope({
      changed: ['packages/desktop/src/main.rs'],
      globs: ['packages/*', '!packages/desktop'],
      packages: PKGS,
      skipped: [],
    });
    expect(scope).toEqual({ workspaces: [] });
  });

  it('obliges no test and no caveat for a diff of LICENSE-family files alone', () => {
    // A LICENSE edit cannot fail any suite; it earns neither a run nor a
    // disclosure. The empty scoped set is the honest answer, and the caller
    // reports "nothing to run" as complete.
    const scope = resolveTestScope({
      changed: ['LICENSE', 'legal/LICENSE.txt'],
      globs: GLOBS,
      packages: PKGS,
      skipped: [],
    });
    expect(scope).toEqual({ workspaces: [] });
  });

  it('treats docs-classified prose as caveat-worthy — in-tree prose can be load-bearing', () => {
    // This repo's own root AGENTS.md is classified docs and is read and
    // asserted on by packages/cli's load-rules.test.ts. When the cost of
    // erring is a sentence of disclosure, err toward disclosing.
    const scope = resolveTestScope({
      changed: ['README.md', 'AGENTS.md'],
      globs: GLOBS,
      packages: PKGS,
      skipped: [],
    });
    expect(scope.workspaces).toEqual([]);
    expect(scope.caveat).toContain('README.md');
  });

  it('lets a LICENSE ride along without a caveat', () => {
    const scope = resolveTestScope({
      changed: ['LICENSE', 'packages/i1/src/a.ts'],
      globs: GLOBS,
      packages: PKGS,
      skipped: [],
    });
    expect(scope).toEqual({ workspaces: ['packages/i1'] });
  });

  it('keeps a prose file riding along scoped, but records the caveat', () => {
    const scope = resolveTestScope({
      changed: ['README.md', 'packages/i1/src/a.ts'],
      globs: GLOBS,
      packages: PKGS,
      skipped: [],
    });
    expect(scope.workspaces).toEqual(['packages/i1']);
    expect(scope.caveat).toContain('README.md');
  });

  it('obliges the workspace suite for prose INSIDE a workspace — the carve-out is location-dependent', () => {
    // isInertLicense is consulted only for files OUTSIDE every workspace:
    // in-tree docs can be executable behaviour, so they keep their suite.
    const scope = resolveTestScope({
      changed: ['packages/i1/docs/guide.md'],
      globs: GLOBS,
      packages: PKGS,
      skipped: [],
    });
    expect(scope).toEqual({ workspaces: ['packages/i1'] });
  });

  it('records a caveat when the closure covers more than half the TESTABLE workspaces', () => {
    const hub: WorkspacePackage[] = [
      p('packages/core', '@x/core'),
      p('packages/a', '@x/a', ['@x/core']),
      p('packages/b', '@x/b', ['@x/core']),
      p('packages/island', '@x/island'),
    ];
    const scope = resolveTestScope({
      changed: ['packages/core/src/a.ts'],
      globs: GLOBS,
      packages: hub,
      skipped: [],
    });
    // Past half, the scoped set still runs — but the report must say it is
    // not a meaningful narrowing.
    expect(scope.workspaces).toEqual([
      'packages/a',
      'packages/b',
      'packages/core',
    ]);
    expect(scope.caveat).toContain('3 of 4 testable workspaces');
    expect(scope.caveat).toContain('more than half');
  });

  it('does not count test-script-less members in the half cap', () => {
    // core plus one dependent is 2 of the 3 TESTABLE suites (the build-only
    // island does not narrow anything) — past half, so caveat.
    const mixed: WorkspacePackage[] = [
      p('packages/core', '@x/core'),
      p('packages/a', '@x/a', ['@x/core']),
      p('packages/island', '@x/island', [], ['build']),
    ];
    const scope = resolveTestScope({
      changed: ['packages/core/src/a.ts'],
      globs: GLOBS,
      packages: mixed,
      skipped: [],
    });
    expect(scope.caveat).toContain('2 of 2 testable workspaces');
  });

  it('stays clean at EXACTLY half — the cap is strictly more than half', () => {
    const half: WorkspacePackage[] = [
      p('packages/core', '@x/core'),
      p('packages/a', '@x/a', ['@x/core']),
      p('packages/i1', '@x/i1'),
      p('packages/i2', '@x/i2'),
    ];
    const scope = resolveTestScope({
      changed: ['packages/core/src/a.ts'],
      globs: GLOBS,
      packages: half,
      skipped: [],
    });
    expect(scope).toEqual({ workspaces: ['packages/a', 'packages/core'] });
  });

  it('pins the cap boundary at ODD counts — 3 of 5 is past half, 2 of 5 is not', () => {
    const five = (depsOfA: string[]): WorkspacePackage[] => [
      p('packages/core', '@x/core'),
      p('packages/a', '@x/a', depsOfA),
      p('packages/i1', '@x/i1'),
      p('packages/i2', '@x/i2'),
      p('packages/i3', '@x/i3'),
    ];
    const past = resolveTestScope({
      changed: ['packages/core/src/a.ts'],
      globs: GLOBS,
      // core <- a and core <- b: closure {a, b, core} = 3 of 5.
      packages: [
        p('packages/core', '@x/core'),
        p('packages/a', '@x/a', ['@x/core']),
        p('packages/b', '@x/b', ['@x/core']),
        p('packages/i1', '@x/i1'),
        p('packages/i2', '@x/i2'),
      ],
      skipped: [],
    });
    expect(past.caveat).toContain('3 of 5 testable workspaces');

    const under = resolveTestScope({
      changed: ['packages/core/src/a.ts'],
      globs: GLOBS,
      packages: five(['@x/core']),
      skipped: [],
    });
    expect(under).toEqual({
      workspaces: ['packages/a', 'packages/core'],
    });
  });

  it('records the broken-graph caveat when a manifest was skipped — before any other answer', () => {
    // The outside-file answer is graph-derived; a graph missing a package
    // makes it the least of the report's worries, so the skipped check wins.
    const scope = resolveTestScope({
      changed: ['scripts/x.js', 'packages/i1/src/a.ts'],
      globs: GLOBS,
      packages: PKGS,
      skipped: ['packages/broken'],
    });
    expect(scope.workspaces).toEqual(['packages/i1']);
    expect(scope.caveat).toContain('packages/broken');
    expect(scope.caveat).toContain('does not parse');
    expect(scope.caveat).not.toContain('scripts/x.js');
  });

  it('treats the root suite as a dependent when it declares a workspace dependency', () => {
    // A root package.json with a test script AND a dependency on the changed
    // workspace is a dependent like any other — its suite must run, or it
    // silently never does while the report claims every dependent was covered.
    const root = p('.', 'root', ['@x/core'], ['test']);
    const scope = resolveTestScope({
      changed: ['packages/core/src/a.ts'],
      globs: GLOBS,
      packages: PKGS,
      skipped: [],
      rootPackage: root,
    });
    expect(scope.workspaces).toEqual([
      '.',
      'packages/core',
      'packages/mid',
      'packages/top',
    ]);
    // 4 of the 8 testable suites is exactly half, and the cap is strictly MORE
    // than half — pinning the root-counted arithmetic on the clean side too.
    expect(scope.caveat).toBeUndefined();
  });

  it('counts a RUNNING root suite on both sides of the half cap', () => {
    // The root declares a dependency on the changed workspace, so it joins the
    // closure and runs. Workspace-only arithmetic sees 2 of 4 testable (at
    // half, no caveat) while the executed set is really 3 of the 5 testable
    // suites — strictly past half, so the report must say so.
    const small: WorkspacePackage[] = [
      p('packages/core', '@x/core'),
      p('packages/a', '@x/a', ['@x/core']),
      p('packages/i1', '@x/i1'),
      p('packages/i2', '@x/i2'),
    ];
    const scope = resolveTestScope({
      changed: ['packages/core/src/a.ts'],
      globs: GLOBS,
      packages: small,
      skipped: [],
      rootPackage: p('.', 'root', ['@x/core'], ['test']),
    });
    expect(scope.workspaces).toEqual(['.', 'packages/a', 'packages/core']);
    expect(scope.caveat).toContain(
      '3 of 5 testable suites (including the root)',
    );
    expect(scope.caveat).toContain('more than half');
  });

  it('keeps the broken-graph caveat ahead of the half-cap one — trust order', () => {
    // The same input that trips the half cap also carries a skipped manifest;
    // "the graph could not be computed" is the stronger disclosure and must
    // win, not be replaced by the narrower half-cap sentence.
    const hub: WorkspacePackage[] = [
      p('packages/core', '@x/core'),
      p('packages/a', '@x/a', ['@x/core']),
      p('packages/b', '@x/b', ['@x/core']),
      p('packages/island', '@x/island'),
    ];
    const scope = resolveTestScope({
      changed: ['packages/core/src/a.ts'],
      globs: GLOBS,
      packages: hub,
      skipped: ['packages/broken'],
    });
    expect(scope.caveat).toContain('does not parse');
    expect(scope.caveat).toContain('packages/broken');
    expect(scope.caveat).not.toContain('more than half');
  });

  it('discloses an affected dir the globs claim but no manifest populates', () => {
    // packages/sdk-python matches packages/* but has no package.json, so it is
    // no graph member; an empty scoped set there must not read as a complete
    // answer (the root can still define a script such a diff can fail).
    const scope = resolveTestScope({
      changed: ['packages/sdk-python/src/x.py'],
      globs: GLOBS,
      packages: PKGS,
      skipped: [],
    });
    expect(scope.workspaces).toEqual([]);
    expect(scope.caveat).toContain('packages/sdk-python');
    expect(scope.caveat).toContain('no readable');
  });

  it('decides the half cap on the TESTABLE count, not the member count', () => {
    // core plus one dependent is 2 of the 2 testable suites but only 2 of the
    // 5 members (three build-only islands). The cap must fire on the testable
    // denominator — a comparison against packages.length would let a run that
    // narrows nothing pass undisclosed.
    const mixed: WorkspacePackage[] = [
      p('packages/core', '@x/core'),
      p('packages/a', '@x/a', ['@x/core']),
      p('packages/b1', '@x/b1', [], ['build']),
      p('packages/b2', '@x/b2', [], ['build']),
      p('packages/b3', '@x/b3', [], ['build']),
    ];
    const scope = resolveTestScope({
      changed: ['packages/core/src/a.ts'],
      globs: GLOBS,
      packages: mixed,
      skipped: [],
    });
    expect(scope.workspaces).toEqual(['packages/a', 'packages/core']);
    expect(scope.caveat).toContain('2 of 2 testable workspaces');
  });

  it('returns an empty scoped set for an empty diff', () => {
    const scope = resolveTestScope({
      changed: [],
      globs: GLOBS,
      packages: PKGS,
      skipped: [],
    });
    expect(scope).toEqual({ workspaces: [] });
  });
});

describe('isInertLicense', () => {
  it('is the license family — with and without suffixes or text extensions', () => {
    // Inert: extensionless license files and their suffixed/plural variants.
    // Filtered so a failure names the misclassified path.
    const inert = [
      'LICENSE',
      'LICENCE',
      'LICENSES',
      'COPYING',
      'LICENSE-MIT',
      'NOTICES.txt',
      'NOTICE',
      'legal/LICENSE.txt',
      'LICENSES.md',
    ];
    expect(inert.filter((f) => isInertLicense(f))).toEqual(inert);
  });

  it('keeps everything else influential — prose, executables, configs, lockfiles', () => {
    // `LICENSE.js` is code wearing a license name. Docs-classified prose is
    // NOT inert: this repo's own root AGENTS.md is asserted on by
    // packages/cli's load-rules.test.ts. `UNLICENSE` and `vendor/MYLICENSE`
    // pin the regex's path anchor; `LICENSE-MIT.js` pins the dash group's
    // refusal to swallow an extension. `package-lock.json` changes installed
    // versions; integration tests are suites themselves.
    const influential = [
      'scripts/build.js',
      '.github/workflows/ci.yml',
      'package.json',
      'package-lock.json',
      'integration-tests/cli.test.ts',
      'README.md',
      'AGENTS.md',
      'docs/guide.md',
      'LICENSE.js',
      'LICENSE-MIT.js',
      'UNLICENSE',
      'vendor/MYLICENSE',
      'scripts/README.md',
      '.eslintrc.json',
    ];
    expect(influential.filter((f) => isInertLicense(f))).toEqual([]);
  });
});
