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

describe('resolveBoundWorkspaceRoot', () => {
  it('returns the directory unchanged for an ordinary session cwd', () => {
    expect(resolveBoundWorkspaceRoot('/mnt/workspace/w/agent')).toBe(
      path.resolve('/mnt/workspace/w/agent'),
    );
  });

  it('strips a .qwen/worktrees/<slug> suffix', () => {
    expect(
      resolveBoundWorkspaceRoot(
        '/mnt/workspace/w/agent/.qwen/worktrees/my-feature',
      ),
    ).toBe(path.resolve('/mnt/workspace/w/agent'));
  });

  it('does not strip a nested path under the worktree', () => {
    const nested = '/mnt/workspace/w/agent/.qwen/worktrees/my-feature/reports';
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
});

describe('toCanonicalWorkspaceArtifactPath', () => {
  it('returns a posix path relative to an ordinary session root', () => {
    expect(
      toCanonicalWorkspaceArtifactPath(
        '/mnt/workspace/w/agent/reports/summary.csv',
        '/mnt/workspace/w/agent',
      ),
    ).toBe('reports/summary.csv');
  });

  it('anchors a worktree file at the bound workspace root', () => {
    expect(
      toCanonicalWorkspaceArtifactPath(
        '/mnt/workspace/w/agent/.qwen/worktrees/my-feature/report.csv',
        '/mnt/workspace/w/agent/.qwen/worktrees/my-feature',
      ),
    ).toBe('.qwen/worktrees/my-feature/report.csv');
  });

  it('returns null when the file is outside the bound workspace', () => {
    expect(
      toCanonicalWorkspaceArtifactPath(
        '/tmp/outside.csv',
        '/mnt/workspace/w/agent',
      ),
    ).toBeNull();
  });

  it('returns null for the workspace root itself', () => {
    expect(
      toCanonicalWorkspaceArtifactPath(
        '/mnt/workspace/w/agent',
        '/mnt/workspace/w/agent',
      ),
    ).toBeNull();
  });
});
