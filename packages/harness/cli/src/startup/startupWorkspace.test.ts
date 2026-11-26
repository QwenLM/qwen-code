/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import {
  ENV_WORKTREE_HANDLED,
  ENV_WORKTREE_INFO,
} from '@qwen-code/core';
import { resolveStartupWorkspace } from './startupWorkspace.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('worktree startup workspace routing', () => {
  it.each([
    { listSessions: true },
    { listExtensions: true },
    { listModels: true },
    { deleteSession: 'session-id' },
  ])(
    'ignores malformed inherited state for non-runtime route %j',
    async (args) => {
      vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
      vi.stubEnv(ENV_WORKTREE_INFO, '{broken');
      await expect(resolveStartupWorkspace(args, '/launch')).resolves.toEqual({
        resourceRoot: '/launch',
      });
    },
  );

  it('keeps a valid inherited originalCwd for session listing', async () => {
    vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
    vi.stubEnv(
      ENV_WORKTREE_INFO,
      JSON.stringify({
        name: 'existing',
        path: '/worktree',
        originalCwd: '/project',
      }),
    );
    await expect(
      resolveStartupWorkspace({ listSessions: true }, '/worktree'),
    ).resolves.toMatchObject({
      resourceRoot: '/project',
      inheritedWorktreeRequest: {
        kind: 'restore-inherited',
        state: { originalCwd: '/project', worktreePath: '/worktree' },
      },
    });
  });

  it.each([{}])(
    'rejects malformed inherited state before runtime startup %j',
    async (args) => {
      vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
      vi.stubEnv(ENV_WORKTREE_INFO, '{broken');
      await expect(resolveStartupWorkspace(args, '/launch')).rejects.toThrow(
        /Invalid inherited worktree/,
      );
    },
  );

  it.each([{ acp: true }, { sdk: true }])(
    'Host 不依赖进程 cwd，并延后解析继承 Worktree：%j',
    async (args) => {
      vi.stubEnv(ENV_WORKTREE_HANDLED, '1');
      vi.stubEnv(ENV_WORKTREE_INFO, '{broken');
      vi.spyOn(process, 'cwd').mockImplementation(() => {
        throw new Error('Launch cwd is unavailable');
      });
      await expect(resolveStartupWorkspace(args)).resolves.toEqual({
        resourceRoot: homedir(),
      });
    },
  );

  it('普通单会话未指定目录时仍使用进程 cwd', async () => {
    vi.stubEnv(ENV_WORKTREE_HANDLED, '0');
    vi.spyOn(process, 'cwd').mockReturnValue('/launch');

    await expect(resolveStartupWorkspace({})).resolves.toEqual({
      resourceRoot: '/launch',
      inheritedWorktreeRequest: undefined,
    });
  });

  it('普通单会话指定目录时不依赖进程 cwd', async () => {
    vi.stubEnv(ENV_WORKTREE_HANDLED, '0');
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('Launch cwd is unavailable');
    });

    await expect(resolveStartupWorkspace({}, '/session')).resolves.toEqual({
      resourceRoot: '/session',
      inheritedWorktreeRequest: undefined,
    });
  });
});
