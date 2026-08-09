/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_VIEW_WORKER_ENV_KEYS,
  createPersistedAgentViewWorkerEnv,
  createAgentViewWorkerSidebandEnv as createRawAgentViewWorkerSidebandEnv,
  isAgentViewWorkerEnv,
  QWEN_AGENT_VIEW_ACTIVE_CWD,
  QWEN_AGENT_VIEW_GENERATION,
  QWEN_AGENT_VIEW_SESSION_ID,
  QWEN_AGENT_VIEW_SIDEBAND,
  QWEN_AGENT_VIEW_TOKEN,
  QWEN_AGENT_VIEW_WORKER,
  readAgentViewWorkerSidebandEnv,
  readAgentViewWorkerControlEvents,
  reportAgentViewWorkerState,
  resetAgentViewWorkerStateReportForTests,
  sendAgentViewWorkerEvent,
  startAgentViewWorkerHeartbeat,
} from './worker-sideband.js';

const mockCallAgentViewSupervisor = vi.hoisted(() =>
  vi.fn(
    async (
      _endpoint: string,
      _method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => ({
      accepted: true,
      workerGeneration: params['workerGeneration'],
      sequence: params['sequence'],
    }),
  ),
);

const WORKER_GENERATION = 'generation-1';

function createAgentViewWorkerSidebandEnv(
  config: Omit<
    Parameters<typeof createRawAgentViewWorkerSidebandEnv>[0],
    'workerGeneration'
  >,
) {
  return createRawAgentViewWorkerSidebandEnv({
    ...config,
    workerGeneration: WORKER_GENERATION,
  });
}

vi.mock('./supervisor-client.js', () => ({
  callAgentViewSupervisor: mockCallAgentViewSupervisor,
}));

describe('worker sideband env', () => {
  beforeEach(() => {
    mockCallAgentViewSupervisor.mockClear();
    mockCallAgentViewSupervisor.mockImplementation(
      async (_endpoint, _method, params) => ({
        accepted: true,
        workerGeneration: params['workerGeneration'],
        sequence: params['sequence'],
      }),
    );
    resetAgentViewWorkerStateReportForTests();
  });

  it('builds the worker-mode environment variables', () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: 'unix:/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });

    expect(env).toEqual({
      [QWEN_AGENT_VIEW_WORKER]: '1',
      [QWEN_AGENT_VIEW_SESSION_ID]: 'session-1',
      [QWEN_AGENT_VIEW_SIDEBAND]: 'unix:/tmp/qwen-agent-view.sock',
      [QWEN_AGENT_VIEW_TOKEN]: 'token-1',
      [QWEN_AGENT_VIEW_ACTIVE_CWD]: '/repo',
      [QWEN_AGENT_VIEW_GENERATION]: WORKER_GENERATION,
    });
    expect(AGENT_VIEW_WORKER_ENV_KEYS).toContain(QWEN_AGENT_VIEW_WORKER);
  });

  it('never includes the worker token in persisted launch metadata', () => {
    const env = createPersistedAgentViewWorkerEnv({
      sessionId: 'session-1',
      sidebandEndpoint: 'unix:/tmp/qwen-agent-view.sock',
      activeCwd: '/repo',
      workerGeneration: WORKER_GENERATION,
    });

    expect(env).not.toHaveProperty(QWEN_AGENT_VIEW_TOKEN);
  });

  it('detects worker mode only when explicitly enabled', () => {
    expect(isAgentViewWorkerEnv({ [QWEN_AGENT_VIEW_WORKER]: '1' })).toBe(true);
    expect(isAgentViewWorkerEnv({ [QWEN_AGENT_VIEW_WORKER]: 'true' })).toBe(
      false,
    );
    expect(isAgentViewWorkerEnv({})).toBe(false);
  });

  it('reads a complete sideband environment', () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: 'pipe:qwen',
      token: 'token-1',
      activeCwd: '/repo',
    });

    expect(readAgentViewWorkerSidebandEnv(env)).toEqual({
      sessionId: 'session-1',
      sidebandEndpoint: 'pipe:qwen',
      token: 'token-1',
      activeCwd: '/repo',
      workerGeneration: WORKER_GENERATION,
    });
  });

  it('returns undefined outside worker mode or when required fields are absent', () => {
    expect(readAgentViewWorkerSidebandEnv({})).toBeUndefined();
    expect(
      readAgentViewWorkerSidebandEnv({
        [QWEN_AGENT_VIEW_WORKER]: '1',
        [QWEN_AGENT_VIEW_SESSION_ID]: 'session-1',
      }),
    ).toBeUndefined();
  });

  it('sends worker events through the configured sideband endpoint', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });

    await expect(
      sendAgentViewWorkerEvent(
        {
          type: 'ready',
          cwd: '/repo',
          capabilities: ['ready'],
        },
        env,
      ),
    ).resolves.toEqual({
      accepted: true,
      workerGeneration: WORKER_GENERATION,
      sequence: 0,
    });

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledWith(
      '/tmp/qwen-agent-view.sock',
      'workerEvent',
      {
        type: 'ready',
        cwd: '/repo',
        capabilities: ['ready'],
        sessionId: 'session-1',
        token: 'token-1',
        workerGeneration: WORKER_GENERATION,
        sequence: 0,
      },
    );
  });

  it('sends detach requests through the configured sideband endpoint', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });

    await sendAgentViewWorkerEvent({ type: 'detach' }, env);

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledWith(
      '/tmp/qwen-agent-view.sock',
      'workerEvent',
      {
        type: 'detach',
        sessionId: 'session-1',
        token: 'token-1',
        workerGeneration: WORKER_GENERATION,
        sequence: 0,
      },
    );
  });

  it('reads worker control events through the configured sideband endpoint', async () => {
    mockCallAgentViewSupervisor.mockResolvedValueOnce({
      events: [
        {
          type: 'redraw',
          sequence: 1,
          at: '2026-07-17T00:00:00.000Z',
        },
        {
          type: 'prompt',
          sequence: 2,
          text: 'next step',
          at: '2026-07-17T00:00:01.000Z',
        },
        {
          type: 'answer',
          sequence: 3,
          text: 'yes',
          outcome: 'proceed_once',
          payload: { answers: { 0: 'yes' } },
          at: '2026-07-17T00:00:02.000Z',
        },
        {
          type: 'prompt',
          sequence: 4,
          at: '2026-07-17T00:00:03.000Z',
        },
      ],
    });
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });

    await expect(readAgentViewWorkerControlEvents(env)).resolves.toEqual([
      {
        type: 'redraw',
        sequence: 1,
        at: '2026-07-17T00:00:00.000Z',
      },
      {
        type: 'prompt',
        sequence: 2,
        text: 'next step',
        at: '2026-07-17T00:00:01.000Z',
      },
      {
        type: 'answer',
        sequence: 3,
        text: 'yes',
        outcome: 'proceed_once',
        payload: { answers: { 0: 'yes' } },
        at: '2026-07-17T00:00:02.000Z',
      },
    ]);

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledWith(
      '/tmp/qwen-agent-view.sock',
      'workerControl',
      {
        sessionId: 'session-1',
        token: 'token-1',
      },
      { timeoutMs: 1000 },
    );
  });

  it('reports worker state through the configured sideband endpoint', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });

    await reportAgentViewWorkerState(
      {
        sessionState: 'needs_input',
        cwd: '/repo',
        summary: 'Waiting for Bash',
        waitingFor: 'Bash',
      },
      env,
    );

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledWith(
      '/tmp/qwen-agent-view.sock',
      'workerEvent',
      {
        type: 'state',
        sessionState: 'needs_input',
        cwd: '/repo',
        summary: 'Waiting for Bash',
        waitingFor: 'Bash',
        sessionId: 'session-1',
        token: 'token-1',
        workerGeneration: WORKER_GENERATION,
        sequence: 0,
      },
    );
  });

  it('does not resend identical worker state reports', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });

    await reportAgentViewWorkerState({ sessionState: 'working' }, env);
    await reportAgentViewWorkerState({ sessionState: 'working' }, env);

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(1);
  });

  it('deduplicates worker state reports per session', async () => {
    const firstEnv = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });
    const secondEnv = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-2',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-2',
      activeCwd: '/repo',
    });

    await reportAgentViewWorkerState({ sessionState: 'working' }, firstEnv);
    await reportAgentViewWorkerState({ sessionState: 'working' }, secondEnv);

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(2);
  });

  it('retries identical worker state reports after a send failure', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });
    mockCallAgentViewSupervisor
      .mockRejectedValueOnce(new Error('supervisor unavailable'))
      .mockResolvedValueOnce({
        accepted: true,
        workerGeneration: WORKER_GENERATION,
        sequence: 0,
      });

    await reportAgentViewWorkerState({ sessionState: 'working' }, env);
    await reportAgentViewWorkerState({ sessionState: 'working' }, env);

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(2);
  });

  it('retries a failed event before assigning its sequence to a newer event', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });
    mockCallAgentViewSupervisor.mockRejectedValueOnce(
      new Error('supervisor unavailable'),
    );

    await reportAgentViewWorkerState({ sessionState: 'working' }, env);
    await reportAgentViewWorkerState({ sessionState: 'idle' }, env);

    expect(
      mockCallAgentViewSupervisor.mock.calls.map((call) => ({
        sessionState: call[2]['sessionState'],
        sequence: call[2]['sequence'],
      })),
    ).toEqual([
      { sessionState: 'working', sequence: 0 },
      { sessionState: 'working', sequence: 0 },
      { sessionState: 'idle', sequence: 1 },
    ]);
  });

  it('does not deduplicate concurrent state reports before send succeeds', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });
    let rejectFirst: (error: Error) => void = () => {};
    mockCallAgentViewSupervisor
      .mockImplementationOnce(
        () =>
          new Promise<unknown>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({
        accepted: true,
        workerGeneration: WORKER_GENERATION,
        sequence: 0,
      });

    const first = reportAgentViewWorkerState({ sessionState: 'working' }, env);
    const second = reportAgentViewWorkerState({ sessionState: 'working' }, env);
    await vi.waitFor(() => {
      expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(1);
    });
    rejectFirst(new Error('supervisor unavailable'));

    await Promise.all([first, second]);

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(2);
  });

  it('skips worker state reports outside worker mode', async () => {
    await reportAgentViewWorkerState({ sessionState: 'idle' }, {});

    expect(mockCallAgentViewSupervisor).not.toHaveBeenCalled();
  });

  it('sends heartbeat events until disposed', async () => {
    vi.useFakeTimers();
    try {
      const env = createAgentViewWorkerSidebandEnv({
        sessionId: 'session-1',
        sidebandEndpoint: '/tmp/qwen-agent-view.sock',
        token: 'token-1',
        activeCwd: '/repo',
      });

      const heartbeat = startAgentViewWorkerHeartbeat(env, 100);
      await vi.advanceTimersByTimeAsync(100);

      expect(mockCallAgentViewSupervisor).toHaveBeenCalledWith(
        '/tmp/qwen-agent-view.sock',
        'workerEvent',
        {
          type: 'heartbeat',
          sessionId: 'session-1',
          token: 'token-1',
          workerGeneration: WORKER_GENERATION,
          sequence: 0,
        },
      );

      heartbeat?.dispose();
      mockCallAgentViewSupervisor.mockClear();
      await vi.advanceTimersByTimeAsync(100);
      expect(mockCallAgentViewSupervisor).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores heartbeat send failures', async () => {
    vi.useFakeTimers();
    try {
      const env = createAgentViewWorkerSidebandEnv({
        sessionId: 'session-1',
        sidebandEndpoint: '/tmp/qwen-agent-view.sock',
        token: 'token-1',
        activeCwd: '/repo',
      });
      mockCallAgentViewSupervisor.mockRejectedValueOnce(
        new Error('supervisor unavailable'),
      );

      const heartbeat = startAgentViewWorkerHeartbeat(env, 100);
      await vi.advanceTimersByTimeAsync(100);

      expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(1);
      heartbeat?.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
