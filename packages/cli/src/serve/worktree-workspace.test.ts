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

  it('returns boundWorkspace when all sessions are at the workspace', () => {
    const bridge = {
      listWorkspaceSessions: () => [
        { sessionId: 'a', workspaceCwd: ws },
        { sessionId: 'b', workspaceCwd: ws },
      ],
    };
    expect(findEffectiveWorkspace(bridge, ws)).toBe(ws);
  });

  it('returns the relocated session cwd when one exists', () => {
    const worktree = '/repo/project/.qwen/worktrees/feat';
    const bridge = {
      listWorkspaceSessions: () => [
        { sessionId: 'a', workspaceCwd: ws },
        { sessionId: 'b', workspaceCwd: worktree },
      ],
    };
    expect(findEffectiveWorkspace(bridge, ws)).toBe(worktree);
  });

  it('returns the first relocated session when multiple exist', () => {
    const wt1 = '/repo/project/.qwen/worktrees/alpha';
    const wt2 = '/repo/project/.qwen/worktrees/beta';
    const bridge = {
      listWorkspaceSessions: () => [
        { sessionId: 'a', workspaceCwd: wt1 },
        { sessionId: 'b', workspaceCwd: wt2 },
      ],
    };
    expect(findEffectiveWorkspace(bridge, ws)).toBe(wt1);
  });
});
