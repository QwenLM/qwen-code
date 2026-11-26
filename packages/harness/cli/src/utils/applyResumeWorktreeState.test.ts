/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreEvents } from '@qwen-code/core';
import type {
  Config,
  TranscriptWorktreeSession,
  WorktreeRestoreResult,
} from '@qwen-code/core';
import { applyResumeWorktreeState } from './applyResumeWorktreeState.js';

const state: TranscriptWorktreeSession = {
  originalCwd: '/repo/apps/desktop',
  preEnterOriginalCwd: '/repo/apps/desktop',
  worktreePath: '/repo/.qwen/worktrees/feature',
  worktreeCwd: '/repo/.qwen/worktrees/feature/apps/desktop',
  worktreeName: 'feature',
  sessionId: 'session-1',
  lifecycle: 'owner',
};

function configWithRestore(result: WorktreeRestoreResult): Config {
  return {
    getSessionId: () => 'session-1',
    restoreWorktree: vi.fn().mockResolvedValue(result),
  } as unknown as Config;
}

describe('applyResumeWorktreeState', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports deferred ownership cleanup while allowing the conversation to resume', async () => {
    const feedback = vi
      .spyOn(coreEvents, 'emitFeedback')
      .mockImplementation(() => {});
    const pendingCleanup = 'Ownership recovery retained';
    const outcome = await applyResumeWorktreeState(
      configWithRestore({ status: 'fallback', pendingCleanup }),
      state,
      vi.fn(),
    );
    expect(outcome).toEqual({
      status: 'fallback',
      worktreeSession: null,
      acceptLegacyFileHistorySnapshots: false,
      pendingCleanup,
    });
    expect(feedback).toHaveBeenCalledWith('warning', pendingCleanup);
  });

  it('warns after recovering an interrupted exit without replaying removal', async () => {
    const feedback = vi
      .spyOn(coreEvents, 'emitFeedback')
      .mockImplementation(() => {});
    const config = configWithRestore({ status: 'fallback' });
    await applyResumeWorktreeState(
      config,
      { ...state, pendingExit: true },
      vi.fn(),
    );
    expect(feedback).toHaveBeenCalledWith(
      'warning',
      expect.stringMatching(/interrupted worktree exit/i),
    );
  });

  it('records explicit ordinary state without overwriting unresolved legacy state', async () => {
    const config = configWithRestore({
      status: 'failed',
      message: 'must not run',
    });
    const record = vi.fn();

    await expect(
      applyResumeWorktreeState(config, null, record),
    ).resolves.toEqual({
      status: 'ordinary',
      worktreeSession: null,
      acceptLegacyFileHistorySnapshots: true,
    });
    await expect(
      applyResumeWorktreeState(config, undefined, record),
    ).resolves.toEqual({
      status: 'ordinary',
      worktreeSession: null,
      acceptLegacyFileHistorySnapshots: true,
    });

    expect(config.restoreWorktree).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenNthCalledWith(1, null);
  });

  it('delegates object restore with immediate JSONL persistence', async () => {
    const settings = {
      name: 'feature',
      path: state.worktreePath,
      worktreeCwd: state.worktreeCwd!,
      baseSha: '',
      originalCwd: state.originalCwd,
      lifecycle: 'attached' as const,
    };
    const config = configWithRestore({ status: 'restored', settings });
    const record = vi.fn().mockResolvedValue(undefined);

    const result = await applyResumeWorktreeState(config, state, record);

    expect(config.restoreWorktree).toHaveBeenCalledWith(state, record);
    expect(result).toMatchObject({
      status: 'restored',
      acceptLegacyFileHistorySnapshots: false,
      worktreeSession: {
        worktreeCwd: state.worktreeCwd,
        lifecycle: 'attached',
      },
    });
  });

  it('maps missing worktree fallback to an ordinary persisted state', async () => {
    const config = configWithRestore({ status: 'fallback' });

    await expect(
      applyResumeWorktreeState(config, state, vi.fn()),
    ).resolves.toEqual({
      status: 'fallback',
      worktreeSession: null,
      acceptLegacyFileHistorySnapshots: false,
    });
  });

  it('throws the service failure instead of guessing a working directory', async () => {
    const config = configWithRestore({
      status: 'failed',
      message: 'Both paths are unavailable.',
    });

    await expect(
      applyResumeWorktreeState(config, state, vi.fn()),
    ).rejects.toThrow('Both paths are unavailable.');
  });
});
