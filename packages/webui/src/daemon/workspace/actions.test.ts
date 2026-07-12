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

    const result = expect(
      actions.removeWorkspace('secondary', { force: true, timeoutMs: 10 }),
    ).rejects.toThrow('Remove workspace timed out after 10ms');
    await vi.advanceTimersByTimeAsync(10);

    await result;
    expect(remove).toHaveBeenCalledWith({ force: true, timeoutMs: 10 });
  });
});
