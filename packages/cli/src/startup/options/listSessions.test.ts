/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { exitSuccessfully } from './exitLifecycle.js';
import { runListSessionsOption } from './listSessions.js';
import { listSessions } from '../../utils/sessions.js';

vi.mock('./exitLifecycle.js', () => ({
  exitSuccessfully: vi.fn(),
}));
vi.mock('../../utils/sessions.js', () => ({
  listSessions: vi.fn(),
}));

describe('runListSessionsOption', () => {
  type OptionContext = Parameters<typeof runListSessionsOption>[0];
  type OptionCoordinator = Parameters<typeof runListSessionsOption>[1];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exitSuccessfully).mockResolvedValue(undefined as never);
  });

  it('lists sessions without refreshing auth or running authenticated startup tasks', async () => {
    const refreshAuth = vi.fn();
    const config = { refreshAuth };
    const runAfterAuthAttemptStartup = vi.fn();
    const runAuthenticatedStartupTasks = vi.fn();
    const startupCoordinator = {
      runAfterAuthAttemptStartup,
      runAuthenticatedStartupTasks,
    } as unknown as OptionCoordinator;
    const context = {
      phase: 'configured',
      config,
      settings: {
        settings: {
          merged: { security: { auth: { selectedType: 'qoder-browser' } } },
        },
      },
    } as unknown as OptionContext;

    await runListSessionsOption(context, startupCoordinator);

    expect(refreshAuth).not.toHaveBeenCalled();
    expect(runAfterAuthAttemptStartup).not.toHaveBeenCalled();
    expect(runAuthenticatedStartupTasks).not.toHaveBeenCalled();
    expect(listSessions).toHaveBeenCalledWith(config);
    expect(exitSuccessfully).toHaveBeenCalledWith(
      config,
      startupCoordinator,
      'Listed sessions successfully',
      'gemini.listSessions',
    );
  });
});
