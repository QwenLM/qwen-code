/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentViewProcessState,
  AgentViewSessionStateFile,
} from '../agent-view/protocol.js';
import {
  isManagedAgentViewContinueBlocked,
  isManagedAgentViewResumeBlocked,
} from './agent-view-resume-guard.js';

const mockReadAgentViewSessionState = vi.hoisted(() => vi.fn());

vi.mock('../agent-view/supervisor-store.js', () => ({
  readAgentViewSessionState: mockReadAgentViewSessionState,
}));

describe('managed Agent View resume guards', () => {
  beforeEach(() => {
    mockReadAgentViewSessionState.mockReset();
  });

  it('blocks --resume for managed sessions regardless of liveness', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'exited'));

    await expect(isManagedAgentViewResumeBlocked('session-1')).resolves.toBe(
      true,
    );
  });

  it('blocks --continue while a managed worker is still alive', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'alive'));

    await expect(isManagedAgentViewContinueBlocked('session-1')).resolves.toBe(
      true,
    );
  });

  it('allows --continue once the managed worker has exited', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'exited'));

    await expect(isManagedAgentViewContinueBlocked('session-1')).resolves.toBe(
      false,
    );
  });

  it('allows --continue for unmanaged and unknown sessions', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(
      state('unmanaged', 'alive'),
    );
    await expect(isManagedAgentViewContinueBlocked('session-1')).resolves.toBe(
      false,
    );

    mockReadAgentViewSessionState.mockResolvedValue(undefined);
    await expect(isManagedAgentViewContinueBlocked('session-1')).resolves.toBe(
      false,
    );
  });

  it('never blocks inside an Agent View worker', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'alive'));

    await expect(
      isManagedAgentViewContinueBlocked('session-1', {
        QWEN_AGENT_VIEW_WORKER: '1',
      }),
    ).resolves.toBe(false);

    expect(mockReadAgentViewSessionState).not.toHaveBeenCalled();
  });
});

function state(
  ownership: AgentViewSessionStateFile['ownership'],
  processState: AgentViewProcessState,
): AgentViewSessionStateFile {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    ownership,
    sessionState: 'working',
    processState,
    attachState: 'detached',
    projectCwd: '/project',
    originalCwd: '/project',
    activeCwd: '/project',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    worktree: { mode: 'none' },
  };
}
