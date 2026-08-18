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
  releaseExitedManagedSessionForContinue,
} from './agent-view-resume-guard.js';

const mockReadAgentViewSessionState = vi.hoisted(() => vi.fn());
const mockPatchAgentViewSessionState = vi.hoisted(() => vi.fn());

vi.mock('../agent-view/supervisor-store.js', () => ({
  readAgentViewSessionState: mockReadAgentViewSessionState,
  patchAgentViewSessionState: mockPatchAgentViewSessionState,
}));

describe('managed Agent View resume guards', () => {
  beforeEach(() => {
    mockReadAgentViewSessionState.mockReset();
    mockPatchAgentViewSessionState.mockReset();
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

  it('never blocks the worker that owns the session', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'alive'));

    await expect(
      isManagedAgentViewContinueBlocked('session-1', workerEnv('session-1')),
    ).resolves.toBe(false);

    expect(mockReadAgentViewSessionState).not.toHaveBeenCalled();
  });

  it('does not bypass the guard for a two-key marker/session-id env', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'alive'));

    // Marker + matching session id alone (no sideband endpoint/token/cwd)
    // must not exempt the process from the guard.
    await expect(
      isManagedAgentViewResumeBlocked('session-1', {
        QWEN_AGENT_VIEW_WORKER: '1',
        QWEN_AGENT_VIEW_SESSION_ID: 'session-1',
      }),
    ).resolves.toBe(true);

    await expect(
      isManagedAgentViewContinueBlocked('session-1', {
        QWEN_AGENT_VIEW_WORKER: '1',
        QWEN_AGENT_VIEW_SESSION_ID: 'session-1',
      }),
    ).resolves.toBe(true);
  });

  it('does not bypass the guard for a forged or foreign worker env', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'alive'));

    // Lone QWEN_AGENT_VIEW_WORKER=1 without the sideband session id.
    await expect(
      isManagedAgentViewResumeBlocked('session-1', {
        QWEN_AGENT_VIEW_WORKER: '1',
      }),
    ).resolves.toBe(true);

    // Worker env claiming a different session.
    await expect(
      isManagedAgentViewContinueBlocked('session-1', {
        QWEN_AGENT_VIEW_WORKER: '1',
        QWEN_AGENT_VIEW_SESSION_ID: 'other-session',
      }),
    ).resolves.toBe(true);
  });

  it('releases an exited managed session for foreground --continue', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'exited'));

    await releaseExitedManagedSessionForContinue('session-1');

    expect(mockPatchAgentViewSessionState).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ ownership: 'unmanaged' }),
    );
  });

  it('keeps ownership for live or unmanaged sessions', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'alive'));
    await releaseExitedManagedSessionForContinue('session-1');
    expect(mockPatchAgentViewSessionState).not.toHaveBeenCalled();

    mockReadAgentViewSessionState.mockResolvedValue(
      state('unmanaged', 'exited'),
    );
    await releaseExitedManagedSessionForContinue('session-1');
    expect(mockPatchAgentViewSessionState).not.toHaveBeenCalled();
  });

  it('does not release ownership from inside a worker', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'exited'));

    await releaseExitedManagedSessionForContinue(
      'session-1',
      workerEnv('session-1'),
    );

    expect(mockPatchAgentViewSessionState).not.toHaveBeenCalled();
  });

  it('still releases ownership when only a stray worker marker is set', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'exited'));

    await releaseExitedManagedSessionForContinue('session-1', {
      QWEN_AGENT_VIEW_WORKER: '1',
    });

    expect(mockPatchAgentViewSessionState).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ ownership: 'unmanaged' }),
    );
  });
});

function workerEnv(sessionId: string): NodeJS.ProcessEnv {
  return {
    QWEN_AGENT_VIEW_WORKER: '1',
    QWEN_AGENT_VIEW_SESSION_ID: sessionId,
    QWEN_AGENT_VIEW_SIDEBAND: 'unix:/tmp/qwen-agent-view.sock',
    QWEN_AGENT_VIEW_TOKEN: 'token-1',
    QWEN_AGENT_VIEW_ACTIVE_CWD: '/repo',
  };
}

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
