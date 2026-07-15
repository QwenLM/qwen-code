/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  workspaceDirFor,
  isWorkspaceMember,
  affectedWorkspaces,
  buildSetFor,
  hasUnmodeledWorkspaceGlob,
  type WorkspacePackage,
} from './workspaces.js';

// This repo's own globs, in this repo's own order. The order is the point: npm
// evaluates them in sequence and the last match wins.
const GLOBS = [
  'packages/*',
  'packages/channels/base',
  'packages/channels/telegram',
  'packages/channels/qqbot',
  '!packages/desktop',
];

describe('workspaceDirFor', () => {
  it('gives `packages/*` one path segment, not the whole subtree', () => {
    expect(
      workspaceDirFor('packages/cli/src/commands/review/submit.ts', GLOBS),
    ).toBe('packages/cli');
  });

  it('lets an explicitly-listed nested workspace win over the star that also matches it', () => {
    // `packages/*` matches this too, and would claim `packages/channels`, which is
    // not a package at all. The explicit glob is listed after it, so it wins — and
    // the build/test commands are scoped to a directory that has a package.json.
    expect(workspaceDirFor('packages/channels/qqbot/src/x.ts', GLOBS)).toBe(
      'packages/channels/qqbot',
    );
  });

  it('honours a negation, so a separate bun workspace is not a member', () => {
    // packages/desktop has its own lockfile and is not part of this npm workspace.
    // Building it from the root fails.
    expect(
      workspaceDirFor('packages/desktop/apps/electron/src/main.ts', GLOBS),
    ).toBeNull();
    expect(isWorkspaceMember('packages/desktop/src/a.test.ts', GLOBS)).toBe(
      false,
    );
  });

  it('re-includes what a negation excluded when a later glob matches again', () => {
    // npm's own rule: last match wins, whichever direction it points.
    const globs = ['packages/*', '!packages/desktop', 'packages/desktop'];
    expect(workspaceDirFor('packages/desktop/src/a.ts', globs)).toBe(
      'packages/desktop',
    );
  });

  it('returns null for a file inside no workspace', () => {
    expect(workspaceDirFor('README.md', GLOBS)).toBeNull();
    expect(workspaceDirFor('integration-tests/foo.test.ts', GLOBS)).toBeNull();
    expect(workspaceDirFor('.github/workflows/ci.yml', GLOBS)).toBeNull();
  });

  it('tolerates a `./` prefix', () => {
    expect(workspaceDirFor('./packages/cli/src/a.ts', GLOBS)).toBe(
      'packages/cli',
    );
  });
});

describe('hasUnmodeledWorkspaceGlob', () => {
  it('is false for the shapes the walker models — literals and a trailing /*', () => {
    expect(hasUnmodeledWorkspaceGlob(GLOBS)).toBe(false);
    expect(hasUnmodeledWorkspaceGlob(['packages/*', 'apps/web'])).toBe(false);
    expect(hasUnmodeledWorkspaceGlob(['!packages/desktop'])).toBe(false);
  });

  it('is true for `**`, an inner `*`, or a `foo-*` prefix the walker cannot model', () => {
    // A diff inside these resolves to an empty affected set, which would read as a
    // confident "nothing to build" — so build-test must fall back instead.
    expect(hasUnmodeledWorkspaceGlob(['packages/**'])).toBe(true);
    expect(hasUnmodeledWorkspaceGlob(['packages/*/lib'])).toBe(true);
    expect(hasUnmodeledWorkspaceGlob(['packages/foo-*'])).toBe(true);
    expect(hasUnmodeledWorkspaceGlob(['packages/*', 'apps/**'])).toBe(true);
  });
});

describe('affectedWorkspaces', () => {
  it('dedupes and sorts the workspaces a change set touches', () => {
    expect(
      affectedWorkspaces(
        [
          'packages/cli/src/a.ts',
          'packages/cli/src/b.ts',
          'packages/core/src/c.ts',
          'README.md',
        ],
        GLOBS,
      ),
    ).toEqual(['packages/cli', 'packages/core']);
  });

  it('is empty for a docs-only diff — which is a complete answer, not a skip', () => {
    expect(affectedWorkspaces(['README.md', 'docs/a.md'], GLOBS)).toEqual([]);
  });
});

// core <- bridge <- leaf ; core <- other ; templates (an island, until something
// turns out to need it)
const PKGS: WorkspacePackage[] = [
  {
    dir: 'packages/core',
    name: '@x/core',
    scripts: ['build', 'test'],
    deps: [],
  },
  {
    dir: 'packages/bridge',
    name: '@x/bridge',
    scripts: ['build', 'test'],
    deps: ['@x/core'],
  },
  {
    dir: 'packages/leaf',
    name: '@x/leaf',
    scripts: ['build', 'test'],
    deps: ['@x/bridge'],
  },
  {
    dir: 'packages/other',
    name: '@x/other',
    scripts: ['build', 'test'],
    deps: ['@x/core'],
  },
  {
    dir: 'packages/templates',
    name: '@x/templates',
    scripts: ['build'],
    deps: [],
  },
];

describe('buildSetFor', () => {
  it('orders dependencies before the package that needs them', () => {
    const set = buildSetFor(['packages/leaf'], PKGS);
    expect(set.indexOf('packages/core')).toBeLessThan(
      set.indexOf('packages/bridge'),
    );
    expect(set.indexOf('packages/bridge')).toBeLessThan(
      set.indexOf('packages/leaf'),
    );
  });

  it('does not build the siblings of a leaf change', () => {
    // The whole point: `other` cannot have been broken by a change to `leaf`.
    expect(buildSetFor(['packages/leaf'], PKGS)).not.toContain(
      'packages/other',
    );
  });

  it('builds the DEPENDENTS of a changed package — a break surfaces at their compile', () => {
    const set = buildSetFor(['packages/core'], PKGS);
    expect(set).toContain('packages/bridge');
    expect(set).toContain('packages/leaf');
    expect(set).toContain('packages/other');
  });

  it('treats `alsoBuild` as a dependency, NOT as changed code', () => {
    // The bug this guards: feeding a compiler-requested package back in as
    // `affected` makes its consumers "dependents of a changed package". On PR
    // #6866, widening with web-templates that way took the build set from 6
    // packages to 15 and built the CLI, which the PR does not touch.
    const asDependency = buildSetFor(['packages/leaf'], PKGS, [
      'packages/core',
    ]);
    expect(asDependency).not.toContain('packages/other');

    const asChangedCode = buildSetFor(['packages/leaf', 'packages/core'], PKGS);
    expect(asChangedCode).toContain('packages/other');
  });

  it('puts `alsoBuild` FIRST — no declared edge can order it', () => {
    // The compiler asked for `templates` precisely because nothing declares an
    // edge to it. The topological sort therefore has nothing to order it by and
    // falls back on the alphabet, which on PR #6866 placed it AFTER the package
    // that needed it: the retry rebuilt the same failure, and a widening that had
    // correctly diagnosed the gap could not close it.
    const set = buildSetFor(['packages/leaf'], PKGS, ['packages/templates']);
    expect(set[0]).toBe('packages/templates');
    expect(set.indexOf('packages/templates')).toBeLessThan(
      set.indexOf('packages/leaf'),
    );
  });

  it('terminates on a dependency cycle without dropping a package', () => {
    const cyclic: WorkspacePackage[] = [
      { dir: 'packages/a', name: '@x/a', scripts: ['build'], deps: ['@x/b'] },
      { dir: 'packages/b', name: '@x/b', scripts: ['build'], deps: ['@x/a'] },
    ];
    const set = buildSetFor(['packages/a'], cyclic);
    expect(new Set(set)).toEqual(new Set(['packages/a', 'packages/b']));
  });

  it('ignores an affected dir that is not a workspace', () => {
    expect(buildSetFor(['docs'], PKGS)).toEqual([]);
  });
});
