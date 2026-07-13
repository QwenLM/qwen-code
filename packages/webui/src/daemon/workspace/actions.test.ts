/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWorkspaceActions } from './actions.js';

describe('workspace actions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the action timeout to workspace removal', async () => {
    vi.useFakeTimers();
    const remove = vi.fn(() => new Promise<never>(() => {}));
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceById: () => ({ remove }) }) as never,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });

    const result = actions
      .removeWorkspace('secondary', { force: true, timeoutMs: 10 })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await vi.advanceTimersByTimeAsync(10);

    const error = await result;
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: 'Remove workspace timed out after 10ms',
    });
    expect(remove).toHaveBeenCalledWith({ force: true, timeoutMs: 10 });
  });

  it('forwards successful workspace removal results', async () => {
    const removal = {
      removed: true as const,
      workspaceId: 'secondary',
      workspaceCwd: '/ws/secondary',
      forced: false,
      persistedRegistrationRemoved: true,
      activity: {
        sessions: 0,
        activePrompts: 0,
        pendingSessionStarts: 0,
        acpConnections: 0,
        memoryTasks: 0,
        channelWorkers: 0,
      },
    };
    const remove = vi.fn().mockResolvedValue(removal);
    const workspaceById = vi.fn(() => ({ remove }));
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceById }) as never,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });

    await expect(
      actions.removeWorkspace('secondary', { force: false }),
    ).resolves.toEqual(removal);
    expect(workspaceById).toHaveBeenCalledWith('secondary');
    expect(remove).toHaveBeenCalledWith({ force: false });
  });

  it('rejects workspace removal without a connected client', async () => {
    const actions = createDaemonWorkspaceActions({
      getClient: () => undefined,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });

    await expect(actions.removeWorkspace('secondary')).rejects.toThrow(
      'Remove workspace failed: DaemonClient is not connected',
    );
  });

  it('preserves zero as the disabled timeout sentinel', async () => {
    vi.useFakeTimers();
    const removal = {
      removed: true as const,
      workspaceId: 'secondary',
      workspaceCwd: '/ws/secondary',
      forced: false,
      persistedRegistrationRemoved: false,
      activity: {
        sessions: 0,
        activePrompts: 0,
        pendingSessionStarts: 0,
        acpConnections: 0,
        memoryTasks: 0,
        channelWorkers: 0,
      },
    };
    const remove = vi.fn().mockResolvedValue(removal);
    const actions = createDaemonWorkspaceActions({
      getClient: () => ({ workspaceById: () => ({ remove }) }) as never,
      getWorkspaceCwd: () => '/ws',
      baseUrl: '',
    });

    await expect(
      actions.removeWorkspace('secondary', { timeoutMs: 0 }),
    ).resolves.toEqual(removal);
    expect(remove).toHaveBeenCalledWith({ timeoutMs: 0 });
  });
});
