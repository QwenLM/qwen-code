/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';

import { describe, expect, it } from 'vitest';
import { findEffectiveWorkspace } from './worktree-workspace.js';

const always = () => true;
const never = () => false;

describe('findEffectiveWorkspace', () => {
  const ws = '/repo/project';

  it('returns boundWorkspace when no sessions exist', () => {
    const bridge = { listWorkspaceSessions: () => [] };
    expect(findEffectiveWorkspace(bridge, ws, always)).toBe(ws);
  });

  it('returns boundWorkspace when no session has a worktree', () => {
    const bridge = {
      listWorkspaceSessions: () => [
        { worktree: undefined },
        { worktree: undefined },
      ],
    };
    expect(findEffectiveWorkspace(bridge, ws, always)).toBe(ws);
  });

  it('returns the worktree path when a session has one on disk', () => {
    const worktree = '/repo/project/.qwen/worktrees/feat';
    const bridge = {
      listWorkspaceSessions: () => [
        { worktree: undefined },
        { worktree: { path: worktree } },
      ],
    };
    expect(findEffectiveWorkspace(bridge, ws, always)).toBe(
      path.normalize(worktree),
    );
  });

  it('skips a worktree whose path no longer exists on disk', () => {
    const worktree = '/repo/project/.qwen/worktrees/deleted';
    const bridge = {
      listWorkspaceSessions: () => [{ worktree: { path: worktree } }],
    };
    expect(findEffectiveWorkspace(bridge, ws, never)).toBe(ws);
  });

  it('returns the first existing worktree when multiple sessions have one', () => {
    const wt1 = '/repo/project/.qwen/worktrees/alpha';
    const wt2 = '/repo/project/.qwen/worktrees/beta';
    const bridge = {
      listWorkspaceSessions: () => [
        { worktree: { path: wt1 } },
        { worktree: { path: wt2 } },
      ],
    };
    expect(findEffectiveWorkspace(bridge, ws, always)).toBe(
      path.normalize(wt1),
    );
  });

  it('skips a worktree whose path is outside boundWorkspace', () => {
    const outside = '/tmp/evil/worktrees/escape';
    const bridge = {
      listWorkspaceSessions: () => [{ worktree: { path: outside } }],
    };
    expect(findEffectiveWorkspace(bridge, ws, always)).toBe(ws);
  });

  it('skips a worktree whose path shares a sibling prefix with boundWorkspace', () => {
    const sibling = '/repo/project-evil/worktrees/escape';
    const bridge = {
      listWorkspaceSessions: () => [{ worktree: { path: sibling } }],
    };
    expect(findEffectiveWorkspace(bridge, ws, always)).toBe(ws);
  });

  it('returns a normalized worktree path when the raw path contains .. segments', () => {
    const raw = '/repo/project/.qwen/worktrees/../worktrees/feat';
    const bridge = {
      listWorkspaceSessions: () => [{ worktree: { path: raw } }],
    };
    const result = findEffectiveWorkspace(bridge, ws, always);
    expect(result).not.toContain('..');
    expect(result).toBe(path.normalize('/repo/project/.qwen/worktrees/feat'));
  });
});
