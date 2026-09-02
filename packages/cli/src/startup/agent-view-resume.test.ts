/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentViewSessionStateFile } from '../agent-view/protocol.js';
import { createAgentViewWorkerSidebandEnv } from '../agent-view/worker-sideband.js';
import { routeManagedAgentViewResume } from './agent-view-resume.js';
import { isAgentViewWorkerResumeCommandBlocked } from './agent-view-resume-guard.js';

const mockReadAgentViewSessionState = vi.hoisted(() => vi.fn());
const mockRequireValidWorkerToken = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const mockWriteStderrLine = vi.hoisted(() => vi.fn());
const mockAttach = vi.hoisted(() => vi.fn());
const mockEnsureAgentViewSupervisor = vi.hoisted(() =>
  vi.fn(async () => ({ attach: mockAttach })),
);

vi.mock('../agent-view/supervisor-store.js', () => ({
  readAgentViewSessionStateForControl: mockReadAgentViewSessionState,
  sanitizeSessionId: (sessionId: string) => sessionId.toLowerCase(),
}));

vi.mock('../utils/stdioHelpers.js', () => ({
  writeStderrLineSafe: mockWriteStderrLine,
}));

vi.mock('../agent-view/supervisor-runner.js', () => ({
  ensureAgentViewSupervisor: mockEnsureAgentViewSupervisor,
}));

vi.mock('../agent-view/supervisor-process.js', () => ({
  requireValidWorkerToken: mockRequireValidWorkerToken,
}));

describe('routeManagedAgentViewResume', () => {
  beforeEach(() => {
    process.exitCode = undefined;
    mockReadAgentViewSessionState.mockReset();
    mockRequireValidWorkerToken.mockReset().mockResolvedValue(undefined);
    mockWriteStderrLine.mockReset();
    mockAttach.mockReset();
    mockEnsureAgentViewSupervisor.mockClear();
  });

  it('routes managed Agent View resumes to supervisor attach', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed'));

    await expect(routeManagedAgentViewResume('session-1')).resolves.toBe(true);

    expect(mockReadAgentViewSessionState).toHaveBeenCalledWith('session-1');
    expect(mockEnsureAgentViewSupervisor).toHaveBeenCalledOnce();
    expect(mockAttach).toHaveBeenCalledWith('session-1');
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      'Session session-1 is managed by Agent View; attaching via supervisor...',
    );
    expect(process.exitCode).toBe(0);
  });

  it('rejects one-shot input for managed Agent View resumes', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed'));

    await expect(
      routeManagedAgentViewResume('session-1', process.env, true),
    ).resolves.toBe(true);

    expect(mockEnsureAgentViewSupervisor).not.toHaveBeenCalled();
    expect(mockAttach).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Cannot use one-shot input'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('blocks managed resumes when Agent View is disabled', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed'));

    await expect(
      routeManagedAgentViewResume('session-1', process.env, false, false),
    ).resolves.toBe(true);

    expect(mockEnsureAgentViewSupervisor).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Agent View is disabled'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('reports the disabled gate before one-shot restrictions', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed'));

    await expect(
      routeManagedAgentViewResume('session-1', process.env, true, false),
    ).resolves.toBe(true);

    expect(mockEnsureAgentViewSupervisor).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).toHaveBeenCalledWith(
      expect.stringContaining('Agent View is disabled'),
    );
    expect(mockWriteStderrLine).not.toHaveBeenCalledWith(
      expect.stringContaining('Cannot use one-shot input'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('marks managed Agent View resume failures as unsuccessful', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed'));
    mockAttach.mockRejectedValueOnce(new Error('attach failed'));

    await expect(routeManagedAgentViewResume('session-1')).resolves.toBe(true);

    expect(mockWriteStderrLine).toHaveBeenCalledWith('attach failed');
    expect(process.exitCode).toBe(1);
  });

  it('continues native resume when the Agent View session is missing', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(undefined);

    await expect(routeManagedAgentViewResume('session-1')).resolves.toBe(false);

    expect(mockWriteStderrLine).not.toHaveBeenCalled();
  });

  it('continues native resume for unmanaged Agent View sessions', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('unmanaged'));

    await expect(routeManagedAgentViewResume('session-1')).resolves.toBe(false);

    expect(mockWriteStderrLine).not.toHaveBeenCalled();
  });

  it('continues native resume inside an Agent View worker', async () => {
    mockReadAgentViewSessionState.mockResolvedValue(state('managed'));

    await expect(
      routeManagedAgentViewResume(
        'session-1',
        createAgentViewWorkerSidebandEnv({
          sessionId: 'session-1',
          sidebandEndpoint: 'unix:/tmp/qwen-agent-view.sock',
          token: 'token-1',
          activeCwd: '/repo',
        }),
      ),
    ).resolves.toBe(false);

    expect(mockRequireValidWorkerToken).toHaveBeenCalledWith(
      'session-1',
      { token: 'token-1' },
      {},
    );
    expect(mockReadAgentViewSessionState).not.toHaveBeenCalled();
    expect(mockWriteStderrLine).not.toHaveBeenCalled();
  });
});

describe('isAgentViewWorkerResumeCommandBlocked', () => {
  it('blocks /resume only inside a fully-initialized attached worker', () => {
    expect(
      isAgentViewWorkerResumeCommandBlocked(
        createAgentViewWorkerSidebandEnv({
          sessionId: 'session-1',
          sidebandEndpoint: 'unix:/tmp/qwen-agent-view.sock',
          token: 'token-1',
          activeCwd: '/repo',
        }),
      ),
    ).toBe(true);
  });

  it('does not block on a stray worker marker alone', () => {
    expect(
      isAgentViewWorkerResumeCommandBlocked({ QWEN_AGENT_VIEW_WORKER: '1' }),
    ).toBe(false);
    expect(isAgentViewWorkerResumeCommandBlocked({})).toBe(false);
  });
});

function state(
  ownership: AgentViewSessionStateFile['ownership'],
): AgentViewSessionStateFile {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    ownership,
    sessionState: 'working',
    processState: 'alive',
    attachState: 'detached',
    projectCwd: '/project',
    originalCwd: '/project',
    activeCwd: '/project',
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    worktree: { mode: 'none' },
  };
}
