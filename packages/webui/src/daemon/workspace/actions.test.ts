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
});
