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
const mockRequireValidWorkerToken = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockRelease = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ released: true }),
);

vi.mock('../agent-view/supervisor-store.js', () => ({
  readAgentViewSessionState: mockReadAgentViewSessionState,
  sanitizeSessionId: (sessionId: string) => sessionId.toLowerCase(),
}));

vi.mock('../agent-view/supervisor-runner.js', () => ({
  ensureAgentViewSupervisor: vi.fn(async () => ({ release: mockRelease })),
}));

vi.mock('../agent-view/supervisor-process.js', () => ({
  requireValidWorkerToken: mockRequireValidWorkerToken,
}));

describe('managed Agent View resume guards', () => {
  beforeEach(() => {
    mockReadAgentViewSessionState.mockReset();
    mockRequireValidWorkerToken.mockReset().mockResolvedValue(undefined);
    mockRelease.mockReset().mockResolvedValue({ released: true });
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

  it('allows --continue once the managed worker is hibernated', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(
      state('managed', 'hibernated'),
    );

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

    expect(mockRequireValidWorkerToken).toHaveBeenCalledWith(
      'session-1',
      { token: 'token-1' },
      {},
    );
    expect(mockReadAgentViewSessionState).not.toHaveBeenCalled();
  });

  it('normalizes worker and resume session ids before comparing them', async () => {
    await expect(
      isManagedAgentViewResumeBlocked('SESSION-1', workerEnv('session-1')),
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

  it('does not bypass guards when a complete worker env has an invalid token', async () => {
    mockRequireValidWorkerToken.mockRejectedValue(
      new Error('Agent View worker token is invalid.'),
    );
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'alive'));

    await expect(
      isManagedAgentViewResumeBlocked('session-1', workerEnv('session-1')),
    ).resolves.toBe(true);
    await expect(
      isManagedAgentViewContinueBlocked('session-1', workerEnv('session-1')),
    ).resolves.toBe(true);

    expect(mockReadAgentViewSessionState).toHaveBeenCalledTimes(2);
  });

  it('blocks --resume and --continue during the adopting window', async () => {
    // /background adopt writes ownership 'adopting' and spawns the worker
    // before patching 'managed'; both guards must already block.
    mockReadAgentViewSessionState.mockResolvedValue(
      state('adopting', 'starting'),
    );

    await expect(isManagedAgentViewResumeBlocked('session-1')).resolves.toBe(
      true,
    );
    await expect(isManagedAgentViewContinueBlocked('session-1')).resolves.toBe(
      true,
    );
  });

  it('blocks ordinary resume/continue while allowing an explicit release retry', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(
      state('removing', 'exited'),
    );

    await expect(isManagedAgentViewResumeBlocked('session-1')).resolves.toBe(
      true,
    );
    await expect(isManagedAgentViewContinueBlocked('session-1')).resolves.toBe(
      true,
    );
    await expect(
      releaseExitedManagedSessionForContinue('session-1'),
    ).resolves.toBe(true);
    expect(mockRelease).toHaveBeenCalledWith('session-1');
  });

  it('does not release ownership during the adopting window', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(
      state('adopting', 'starting'),
    );

    await expect(
      releaseExitedManagedSessionForContinue('session-1'),
    ).resolves.toBe(false);

    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('releases an exited managed session for foreground --continue', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'exited'));
    await expect(
      releaseExitedManagedSessionForContinue('session-1'),
    ).resolves.toBe(true);

    expect(mockRelease).toHaveBeenCalledWith('session-1');
  });

  it('releases a hibernated managed session for foreground --continue', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(
      state('managed', 'hibernated'),
    );

    await releaseExitedManagedSessionForContinue('session-1');

    expect(mockRelease).toHaveBeenCalledWith('session-1');
  });

  it('keeps ownership for live or unmanaged sessions', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'alive'));
    await expect(
      releaseExitedManagedSessionForContinue('session-1'),
    ).resolves.toBe(false);
    expect(mockRelease).not.toHaveBeenCalled();

    mockReadAgentViewSessionState.mockResolvedValue(
      state('unmanaged', 'exited'),
    );
    await expect(
      releaseExitedManagedSessionForContinue('session-1'),
    ).resolves.toBe(true);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('does not release ownership from inside a worker', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'exited'));

    await releaseExitedManagedSessionForContinue(
      'session-1',
      workerEnv('session-1'),
    );

    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('does not skip release when a complete worker env has an invalid token', async () => {
    mockRequireValidWorkerToken.mockRejectedValue(
      new Error('Agent View worker token is invalid.'),
    );
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'exited'));

    await releaseExitedManagedSessionForContinue(
      'session-1',
      workerEnv('session-1'),
    );

    expect(mockRelease).toHaveBeenCalledWith('session-1');
  });

  it('releases ownership when the worker env belongs to another session', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'exited'));

    await releaseExitedManagedSessionForContinue(
      'session-1',
      workerEnv('other-session'),
    );

    expect(mockRelease).toHaveBeenCalledWith('session-1');
  });

  it('still releases ownership when only a stray worker marker is set', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'exited'));

    await releaseExitedManagedSessionForContinue('session-1', {
      QWEN_AGENT_VIEW_WORKER: '1',
    });

    expect(mockRelease).toHaveBeenCalledWith('session-1');
  });

  it('re-blocks continue when the managed session becomes live before release', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'exited'));
    mockRelease.mockRejectedValueOnce(new Error('session became active'));

    await expect(
      releaseExitedManagedSessionForContinue('session-1'),
    ).resolves.toBe(false);
  });

  it('surfaces retryable release failures instead of treating them as live sessions', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'exited'));
    mockRelease.mockRejectedValueOnce(
      new Error(
        'Agent View worker record at /tmp/worker.json is temporarily unreadable. Retry the operation.',
      ),
    );

    await expect(
      releaseExitedManagedSessionForContinue('session-1'),
    ).rejects.toThrow('temporarily unreadable');
  });

  it('does not start the supervisor to release ownership when the gate is disabled', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed', 'exited'));

    await expect(
      releaseExitedManagedSessionForContinue('session-1', process.env, false),
    ).resolves.toBe(false);

    expect(mockRelease).not.toHaveBeenCalled();
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
