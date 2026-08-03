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
  resolveTestScope,
  unparseableWorkspaceManifests,
} from './workspace-scope.js';
import type { WorkspacePackage } from './workspaces.js';

const GLOBS = ['packages/*'];

const p = (
  dir: string,
  name: string,
  deps: string[] = [],
): WorkspacePackage => ({ dir, name, scripts: ['test'], deps });

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
      unparseable: [],
    });
    expect(scope).toEqual({ mode: 'workspaces', workspaces: ['packages/i1'] });
  });

  it('includes the transitive reverse-dependency closure of the diff', () => {
    // A behaviour change in core can fail top's suite with mid unchanged in
    // between — the compile catches none of that, only top's tests do.
    const scope = resolveTestScope({
      changed: ['packages/core/src/a.ts'],
      globs: GLOBS,
      packages: PKGS,
      unparseable: [],
    });
    expect(scope).toEqual({
      mode: 'workspaces',
      workspaces: ['packages/core', 'packages/mid', 'packages/top'],
    });
  });

  it('does not drag in the DEPENDENCIES of a changed leaf', () => {
    // top merely uses mid and core; changing top cannot have broken them, and
    // a closure that walked forward edges would grow into the whole monorepo.
    const scope = resolveTestScope({
      changed: ['packages/top/src/a.ts'],
      globs: GLOBS,
      packages: PKGS,
      unparseable: [],
    });
    expect(scope).toEqual({ mode: 'workspaces', workspaces: ['packages/top'] });
  });

  it('falls back to full for a file outside every workspace, naming the file', () => {
    const scope = resolveTestScope({
      changed: ['packages/i1/src/a.ts', 'scripts/prepare.js'],
      globs: GLOBS,
      packages: PKGS,
      unparseable: [],
    });
    expect(scope.mode).toBe('full');
    expect(scope.workspaces).toBeUndefined();
    expect(scope.reason).toContain('scripts/prepare.js');
    expect(scope.reason).toContain('outside every workspace');
  });

  it('falls back to full when the closure covers more than half the workspaces', () => {
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
      unparseable: [],
    });
    expect(scope.mode).toBe('full');
    expect(scope.reason).toContain('3 of 4 workspaces');
    expect(scope.reason).toContain('more than half');
  });

  it('stays scoped at EXACTLY half — the cap is strictly more than half', () => {
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
      unparseable: [],
    });
    expect(scope.mode).toBe('workspaces');
    expect(scope.workspaces).toEqual(['packages/core', 'packages/a'].sort());
  });

  it('falls back to full when the graph has an unparseable manifest — before any other answer', () => {
    // The out-of-workspace and half-cap answers are graph-derived; a graph
    // missing a package makes them meaningless, so this check wins.
    const scope = resolveTestScope({
      changed: ['packages/i1/src/a.ts'],
      globs: GLOBS,
      packages: PKGS,
      unparseable: ['packages/broken'],
    });
    expect(scope.mode).toBe('full');
    expect(scope.reason).toContain('packages/broken');
    expect(scope.reason).toContain('unparseable');
  });

  it('returns an empty scoped set for an empty diff', () => {
    const scope = resolveTestScope({
      changed: [],
      globs: GLOBS,
      packages: PKGS,
      unparseable: [],
    });
    expect(scope).toEqual({ mode: 'workspaces', workspaces: [] });
  });
});

describe('unparseableWorkspaceManifests', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ws-scope-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (dir: string, content: string): void => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), content);
  };

  it('names the dirs whose manifest exists but does not parse', () => {
    write('packages/good', JSON.stringify({ name: '@x/good' }));
    write('packages/bad', '{ not json');
    expect(unparseableWorkspaceManifests(root, ['packages/*'])).toEqual([
      'packages/bad',
    ]);
  });

  it('ignores a dir with no manifest — npm does not treat it as a workspace', () => {
    write('packages/good', JSON.stringify({ name: '@x/good' }));
    mkdirSync(join(root, 'packages', 'assets'), { recursive: true });
    expect(unparseableWorkspaceManifests(root, ['packages/*'])).toEqual([]);
  });

  it('ignores a broken manifest in a NEGATED dir — not a workspace, not our graph', () => {
    write('packages/good', JSON.stringify({ name: '@x/good' }));
    write('packages/desktop', '{ not json');
    expect(
      unparseableWorkspaceManifests(root, ['packages/*', '!packages/desktop']),
    ).toEqual([]);
  });

  it('checks literally-listed workspace dirs too, not only starred bases', () => {
    write('integrations/ctx', '{ not json');
    expect(
      unparseableWorkspaceManifests(root, ['packages/*', 'integrations/ctx']),
    ).toEqual(['integrations/ctx']);
  });
});
