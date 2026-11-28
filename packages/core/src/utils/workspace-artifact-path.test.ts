/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveBoundWorkspaceRoot,
  toCanonicalWorkspaceArtifactPath,
} from './workspace-artifact-path.js';

const agent = '/mnt/workspace/w/agent';
const myWorktree = `${agent}/.qwen/worktrees/my-feature`;

describe('resolveBoundWorkspaceRoot', () => {
  it('returns the directory unchanged for an ordinary session cwd', () => {
    expect(resolveBoundWorkspaceRoot(agent)).toBe(path.resolve(agent));
  });

  it('strips a .qwen/worktrees/<slug> suffix', () => {
    expect(resolveBoundWorkspaceRoot(myWorktree)).toBe(path.resolve(agent));
  });

  it('does not strip a nested path under the worktree', () => {
    const nested = `${myWorktree}/reports`;
    expect(resolveBoundWorkspaceRoot(nested)).toBe(path.resolve(nested));
  });

  it('treats a worktree whose bound workspace is the filesystem root', () => {
    const worktree = path.join(
      path.parse(process.cwd()).root,
      '.qwen',
      'worktrees',
      'feature',
    );
    expect(resolveBoundWorkspaceRoot(worktree)).toBe(path.parse(worktree).root);
  });
  it('strips a configured custom worktree root suffix when anchored to repoRoot', () => {
    const customWorktree = `${agent}/.worktrees/my-feature`;
    expect(resolveBoundWorkspaceRoot(customWorktree, '.worktrees', agent)).toBe(
      path.resolve(agent),
    );
    const multiSegment = `${agent}/tmp/wts/my-feature`;
    expect(resolveBoundWorkspaceRoot(multiSegment, 'tmp/wts', agent)).toBe(
      path.resolve(agent),
    );
  });

  it('does not widen a non-worktree repo matching a custom root segment (R1-6)', () => {
    const standaloneRepo = '/x/worktrees/repo';
    expect(resolveBoundWorkspaceRoot(standaloneRepo, 'worktrees')).toBe(
      path.resolve(standaloneRepo),
    );
    // Legacy .qwen/worktrees/<slug> must still strip to repo root, not `.qwen`,
    // even when worktree.root is configured as `worktrees`.
    expect(resolveBoundWorkspaceRoot(myWorktree, 'worktrees')).toBe(
      path.resolve(agent),
    );
  });

  it('does not strip a custom prefix when worktreeRoot is invalid', () => {
    const customWorktree = `${agent}/.worktrees/my-feature`;
    expect(resolveBoundWorkspaceRoot(customWorktree, '../escape', agent)).toBe(
      path.resolve(customWorktree),
    );
  });
});

describe('toCanonicalWorkspaceArtifactPath', () => {
  it('returns a posix path relative to an ordinary session root', () => {
    expect(
      toCanonicalWorkspaceArtifactPath(`${agent}/reports/summary.csv`, agent),
    ).toBe('reports/summary.csv');
  });

  it('anchors a worktree file at the bound workspace root', () => {
    expect(
      toCanonicalWorkspaceArtifactPath(`${myWorktree}/report.csv`, myWorktree),
    ).toBe('.qwen/worktrees/my-feature/report.csv');
    const customWorktree = `${agent}/.worktrees/my-feature`;
    expect(
      toCanonicalWorkspaceArtifactPath(
        `${customWorktree}/report.csv`,
        customWorktree,
        '.worktrees',
        agent,
      ),
    ).toBe('.worktrees/my-feature/report.csv');
  });

  it('returns null when the file is outside the bound workspace', () => {
    expect(
      toCanonicalWorkspaceArtifactPath('/tmp/outside.csv', agent),
    ).toBeNull();
  });

  it('returns null for the workspace root itself', () => {
    expect(toCanonicalWorkspaceArtifactPath(agent, agent)).toBeNull();
  });
});
