/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config, ConfigParameters } from './config.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { worktreeSessionService } from '../services/worktreeSessionService.js';
import type { WorktreeSettings } from '../services/worktree/contracts.js';
import type { TranscriptWorktreeSession } from '../protocol/transcript/entry.js';

describe('Config Worktree 运行入口', () => {
  const configs: Config[] = [];
  const settings: WorktreeSettings = {
    name: 'feature',
    path: '/repo/.qwen/worktrees/feature',
    worktreeCwd: '/repo/.qwen/worktrees/feature/apps/desktop',
    baseSha: 'abc123',
    originalCwd: '/repo/apps/desktop',
    sessionId: 'session-1',
    lifecycle: 'owner',
  };
  const state: TranscriptWorktreeSession = {
    worktreeName: settings.name,
    worktreePath: settings.path,
    worktreeCwd: settings.worktreeCwd,
    originalCwd: settings.originalCwd!,
    sessionId: 'session-1',
    lifecycle: 'owner',
  };

  function createConfig(params: Partial<ConfigParameters> = {}) {
    const config = makeFakeConfig({
      sessionId: 'session-1',
      cwd: '/repo/apps/desktop',
      ...params,
      targetDir: process.cwd(),
    });
    config.setTargetDir(params.targetDir ?? '/repo/apps/desktop');
    configs.push(config);
    return config;
  }

  afterEach(async () => {
    await Promise.all(configs.splice(0).map((config) => config.dispose()));
    vi.restoreAllMocks();
  });

  it.each([true, false])(
    'Writer 前置与持久化要求在创建副作用之前检查（持久化=%s）',
    async (sessionPersistence) => {
      const prepare = vi.spyOn(worktreeSessionService, 'prepare');
      const restore = vi.spyOn(worktreeSessionService, 'restore');
      const config = createConfig({
        sessionPersistence,
        worktree: { baseRef: 'head' },
      });
      const error = sessionPersistence
        ? /active transcript writer/
        : /session persistence/;

      await expect(
        config.enterWorktree({ kind: 'create', name: 'feature' }),
      ).rejects.toThrow(error);
      await expect(config.restoreWorktree(state)).rejects.toThrow(error);
      expect(config.getWorkingDir()).toBe('/repo/apps/desktop');
      expect(prepare).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      if (!sessionPersistence) {
        await expect(
          config.enterWorktree({ kind: 'create', name: 'feature' }, vi.fn()),
        ).rejects.toThrow(error);
      }
    },
  );

  it('两个会话分别使用自己的项目、创建设置与 Writer', async () => {
    const prepare = vi
      .spyOn(worktreeSessionService, 'prepare')
      .mockResolvedValue({
        settings,
        created: false,
        preparedForSessionId: 'session-1',
      });
    const enter = vi
      .spyOn(worktreeSessionService, 'enter')
      .mockResolvedValue(settings);
    const first = createConfig({
      worktreeSettings: { ...settings, name: 'old' },
      worktree: { baseRef: 'head' },
    });
    first.setTargetDir('/repo/.qwen/worktrees/old/apps/desktop');
    const second = createConfig({
      sessionId: 'session-2',
      targetDir: '/other/apps',
      worktree: { sparsePaths: ['apps'] },
    });
    const firstRecord = vi.fn().mockResolvedValue(undefined);
    const secondRecord = vi.fn().mockResolvedValue(undefined);
    first.registerSessionRuntimeBinding({
      refreshRuntimeContext: vi.fn(),
      recordWorktreeState: firstRecord,
    });
    second.registerSessionRuntimeBinding({
      refreshRuntimeContext: vi.fn(),
      recordWorktreeState: secondRecord,
    });

    const result = await first.enterWorktree({
      kind: 'create',
      name: 'feature',
      options: { prNumber: 42 },
    });
    await second.enterWorktree({ kind: 'create', name: 'feature' });
    expect(result).toEqual({ ...settings, created: false });
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      {
        kind: 'create',
        name: 'feature',
        originalCwd: '/repo/apps/desktop',
        projectRoot: '/repo/apps/desktop',
        options: {
          baseRef: 'head',
          prNumber: 42,
          fromCwd: '/repo/apps/desktop',
        },
      },
    );
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-2' }),
      {
        kind: 'create',
        name: 'feature',
        originalCwd: '/other/apps',
        projectRoot: '/other/apps',
        options: { sparsePaths: ['apps'], fromCwd: '/other/apps' },
      },
    );
    const firstContext = enter.mock.calls.find(
      ([context]) => context.config === first,
    )![0];
    const secondContext = enter.mock.calls.find(
      ([context]) => context.config === second,
    )![0];
    await firstContext.recordWorktreeState(state, true);
    await secondContext.recordWorktreeState(null);
    expect(firstRecord).toHaveBeenCalledWith(state, true);
    expect(secondRecord).toHaveBeenCalledWith(null);
    expect(second.getWorktreeSettings()).toBeUndefined();
  });

  it('attach 使用当前运行目录解析路径，项目归属仍为 originalCwd', async () => {
    const prepare = vi
      .spyOn(worktreeSessionService, 'prepare')
      .mockResolvedValue({
        settings,
        created: false,
        preparedForSessionId: 'session-1',
      });
    vi.spyOn(worktreeSessionService, 'enter').mockResolvedValue(settings);
    const config = createConfig({ worktreeSettings: settings });
    config.setTargetDir(settings.worktreeCwd);

    await config.enterWorktree({ kind: 'attach', path: '../other' }, vi.fn());
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ activeWorktreeSettings: settings }),
      {
        kind: 'attach',
        path: '../other',
        originalCwd: settings.originalCwd,
        launchRoot: settings.worktreeCwd,
      },
    );
  });

  it('恢复使用当前会话和显式 Writer，原样保留 Service 的恢复结果', async () => {
    const restore = vi
      .spyOn(worktreeSessionService, 'restore')
      .mockResolvedValue({
        status: 'fallback',
        pendingCleanup: 'cleanup pending',
      });
    const config = createConfig({ sessionId: 'resumed-session' });
    const record = vi.fn();

    await expect(config.restoreWorktree(state, record)).resolves.toEqual({
      status: 'fallback',
      pendingCleanup: 'cleanup pending',
    });
    expect(restore).toHaveBeenCalledWith(
      {
        config,
        sessionId: 'resumed-session',
        phase: 'restore',
        recordWorktreeState: record,
      },
      state,
    );
  });
});
