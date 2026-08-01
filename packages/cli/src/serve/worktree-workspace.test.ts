/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { findEffectiveWorkspace } from './worktree-workspace.js';

describe('findEffectiveWorkspace', () => {
  const ws = '/repo/project';

  it('returns boundWorkspace when no sessions exist', () => {
    const bridge = { listWorkspaceSessions: () => [] };
    expect(findEffectiveWorkspace(bridge, ws)).toBe(ws);
  });

  it('returns boundWorkspace when no session has a worktree', () => {
    const bridge = {
      listWorkspaceSessions: () => [
        { worktree: undefined },
        { worktree: undefined },
      ],
    };
    expect(findEffectiveWorkspace(bridge, ws)).toBe(ws);
  });

  it('returns the worktree path when a session has one', () => {
    const worktree = '/repo/project/.qwen/worktrees/feat';
    const bridge = {
      listWorkspaceSessions: () => [
        { worktree: undefined },
        { worktree: { path: worktree } },
      ],
    };
    expect(findEffectiveWorkspace(bridge, ws)).toBe(worktree);
  });

  it('returns the first worktree when multiple sessions have one', () => {
    const wt1 = '/repo/project/.qwen/worktrees/alpha';
    const wt2 = '/repo/project/.qwen/worktrees/beta';
    const bridge = {
      listWorkspaceSessions: () => [
        { worktree: { path: wt1 } },
        { worktree: { path: wt2 } },
      ],
    };
    expect(findEffectiveWorkspace(bridge, ws)).toBe(wt1);
  });
});
