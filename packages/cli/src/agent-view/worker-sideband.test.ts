/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_VIEW_WORKER_ENV_KEYS,
  createAgentViewWorkerSidebandEnv,
  isAgentViewWorkerEnv,
  QWEN_AGENT_VIEW_ACTIVE_CWD,
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
  vi.fn(async (): Promise<unknown> => ({ accepted: true })),
);

vi.mock('./supervisor-client.js', () => ({
  callAgentViewSupervisor: mockCallAgentViewSupervisor,
}));

describe('worker sideband env', () => {
  beforeEach(() => {
    mockCallAgentViewSupervisor.mockClear();
    mockCallAgentViewSupervisor.mockResolvedValue({ accepted: true });
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
    });
    expect(AGENT_VIEW_WORKER_ENV_KEYS).toContain(QWEN_AGENT_VIEW_WORKER);
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
    });
  });

  it('returns undefined outside worker mode or when required fields are absent', () => {
    expect(readAgentViewWorkerSidebandEnv({})).toBeUndefined();
    for (const missingKey of [
      QWEN_AGENT_VIEW_WORKER,
      QWEN_AGENT_VIEW_SESSION_ID,
      QWEN_AGENT_VIEW_SIDEBAND,
      QWEN_AGENT_VIEW_TOKEN,
      QWEN_AGENT_VIEW_ACTIVE_CWD,
    ] as const) {
      const env = createAgentViewWorkerSidebandEnv({
        sessionId: 'session-1',
        sidebandEndpoint: 'pipe:qwen',
        token: 'token-1',
        activeCwd: '/repo',
      });
      delete env[missingKey];
      expect(readAgentViewWorkerSidebandEnv(env)).toBeUndefined();
    }
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
    ).resolves.toEqual({ accepted: true });

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledWith(
      '/tmp/qwen-agent-view.sock',
      'workerEvent',
      {
        type: 'ready',
        cwd: '/repo',
        capabilities: ['ready'],
        at: expect.any(String),
        sessionId: 'session-1',
        token: 'token-1',
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
        at: expect.any(String),
        sessionId: 'session-1',
        token: 'token-1',
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
          promptId: 'prompt-1',
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
        promptId: 'prompt-1',
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

    mockCallAgentViewSupervisor.mockResolvedValueOnce({
      events: [
        {
          type: 'prompt',
          sequence: 3,
          promptId: 'prompt-1',
          text: 'next step',
          at: '2026-07-17T00:00:01.000Z',
        },
      ],
    });
    await expect(readAgentViewWorkerControlEvents(env)).resolves.toEqual([]);
    expect(mockCallAgentViewSupervisor).toHaveBeenLastCalledWith(
      '/tmp/qwen-agent-view.sock',
      'workerControl',
      {
        sessionId: 'session-1',
        token: 'token-1',
      },
      { timeoutMs: 1000 },
    );
  });

  it('ignores malformed worker control responses', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });

    for (const response of [null, {}, { events: 'invalid' }]) {
      mockCallAgentViewSupervisor.mockResolvedValueOnce(response);
      await expect(readAgentViewWorkerControlEvents(env)).resolves.toEqual([]);
    }
  });

  it('correlates state reports with the accepted prompt', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });

    mockCallAgentViewSupervisor.mockResolvedValueOnce({
      events: [
        {
          type: 'prompt',
          sequence: 1,
          promptId: 'prompt-1',
          text: 'next step',
          at: '2026-07-17T00:00:01.000Z',
        },
      ],
    });
    await readAgentViewWorkerControlEvents(env);
    await reportAgentViewWorkerState({ sessionState: 'working' }, env);
    await reportAgentViewWorkerState({ sessionState: 'idle' }, env);
    await reportAgentViewWorkerState({ sessionState: 'working' }, env);
    await reportAgentViewWorkerState({ sessionState: 'completed' }, env);

    expect(mockCallAgentViewSupervisor).toHaveBeenNthCalledWith(
      2,
      '/tmp/qwen-agent-view.sock',
      'workerEvent',
      expect.not.objectContaining({ promptId: expect.any(String) }),
    );
    expect(mockCallAgentViewSupervisor).toHaveBeenNthCalledWith(
      4,
      '/tmp/qwen-agent-view.sock',
      'workerEvent',
      expect.objectContaining({
        sessionState: 'working',
        promptId: 'prompt-1',
      }),
    );
    expect(mockCallAgentViewSupervisor).toHaveBeenNthCalledWith(
      5,
      '/tmp/qwen-agent-view.sock',
      'workerEvent',
      expect.objectContaining({
        sessionState: 'completed',
        promptId: 'prompt-1',
      }),
    );
  });

  it('correlates working even when the pre-submit idle report is deduplicated', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });

    await reportAgentViewWorkerState({ sessionState: 'idle' }, env);
    mockCallAgentViewSupervisor.mockResolvedValueOnce({
      events: [
        {
          type: 'prompt',
          sequence: 1,
          promptId: 'prompt-1',
          text: 'next step',
          at: '2026-07-17T00:00:01.000Z',
        },
      ],
    });
    await readAgentViewWorkerControlEvents(env);
    await reportAgentViewWorkerState({ sessionState: 'idle' }, env);
    await reportAgentViewWorkerState({ sessionState: 'working' }, env);

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(3);
    expect(mockCallAgentViewSupervisor).toHaveBeenLastCalledWith(
      '/tmp/qwen-agent-view.sock',
      'workerEvent',
      expect.objectContaining({
        sessionState: 'working',
        promptId: 'prompt-1',
      }),
    );
  });

  it('retries a lost correlated state response on the next control poll', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });
    mockCallAgentViewSupervisor.mockResolvedValueOnce({
      events: [
        {
          type: 'prompt',
          sequence: 1,
          promptId: 'prompt-1',
          text: 'next step',
          at: '2026-07-17T00:00:01.000Z',
        },
      ],
    });
    await readAgentViewWorkerControlEvents(env);
    await reportAgentViewWorkerState({ sessionState: 'idle' }, env);
    mockCallAgentViewSupervisor.mockRejectedValueOnce(
      new Error('response lost'),
    );
    await reportAgentViewWorkerState({ sessionState: 'working' }, env);
    mockCallAgentViewSupervisor.mockRejectedValueOnce(
      new Error('supervisor unavailable'),
    );
    await reportAgentViewWorkerState({ sessionState: 'completed' }, env);
    mockCallAgentViewSupervisor.mockResolvedValueOnce({ events: [] });
    await readAgentViewWorkerControlEvents(env);

    for (const call of [4, 5]) {
      expect(mockCallAgentViewSupervisor).toHaveBeenNthCalledWith(
        call,
        '/tmp/qwen-agent-view.sock',
        'workerEvent',
        expect.objectContaining({
          sessionState: 'completed',
          promptId: 'prompt-1',
        }),
      );
    }
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
        at: expect.any(String),
        sessionId: 'session-1',
        token: 'token-1',
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

  it('sends same-state reports when details change', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });

    await reportAgentViewWorkerState(
      { sessionState: 'working', summary: 'Running build' },
      env,
    );
    await reportAgentViewWorkerState(
      { sessionState: 'working', summary: 'Waiting for approval' },
      env,
    );

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(2);
  });

  it('defaults worker state report cwd to the sideband active cwd', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });

    await reportAgentViewWorkerState({ sessionState: 'working' }, env);

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledWith(
      '/tmp/qwen-agent-view.sock',
      'workerEvent',
      expect.objectContaining({
        cwd: '/repo',
      }),
    );
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
      .mockResolvedValueOnce({ accepted: true });

    await reportAgentViewWorkerState({ sessionState: 'working' }, env);
    await reportAgentViewWorkerState({ sessionState: 'working' }, env);

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(2);
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
      .mockResolvedValueOnce({ accepted: true });

    const first = reportAgentViewWorkerState({ sessionState: 'working' }, env);
    const second = reportAgentViewWorkerState({ sessionState: 'working' }, env);
    rejectFirst(new Error('supervisor unavailable'));

    await Promise.all([first, second]);

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent state reports before recording dedupe keys', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });
    let resolveFirst: (value: unknown) => void = () => {};
    mockCallAgentViewSupervisor
      .mockImplementationOnce(
        () =>
          new Promise<unknown>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ accepted: true })
      .mockResolvedValueOnce({ accepted: true });

    const first = reportAgentViewWorkerState({ sessionState: 'working' }, env);
    const second = reportAgentViewWorkerState(
      { sessionState: 'needs_input' },
      env,
    );

    await Promise.resolve();
    expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(1);

    resolveFirst({ accepted: true });
    await Promise.all([first, second]);
    await reportAgentViewWorkerState({ sessionState: 'working' }, env);

    expect(
      mockCallAgentViewSupervisor.mock.calls.map(
        (call) =>
          ((call as unknown[])[2] as { sessionState?: string } | undefined)
            ?.sessionState,
      ),
    ).toEqual(['working', 'needs_input', 'working']);
  });

  it('skips worker events, control reads, and heartbeats outside worker mode', async () => {
    await expect(
      sendAgentViewWorkerEvent({ type: 'heartbeat' }, {}),
    ).resolves.toBeUndefined();
    await expect(readAgentViewWorkerControlEvents({})).resolves.toEqual([]);
    expect(startAgentViewWorkerHeartbeat({})).toBeUndefined();

    expect(mockCallAgentViewSupervisor).not.toHaveBeenCalled();
  });

  it('re-sends a state after an intervening failed report', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });

    await reportAgentViewWorkerState({ sessionState: 'working' }, env);
    mockCallAgentViewSupervisor.mockRejectedValueOnce(new Error('offline'));
    await reportAgentViewWorkerState({ sessionState: 'needs_input' }, env);
    await reportAgentViewWorkerState({ sessionState: 'working' }, env);

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(3);
  });

  it('sends one event for concurrent identical state reports', async () => {
    const env = createAgentViewWorkerSidebandEnv({
      sessionId: 'session-1',
      sidebandEndpoint: '/tmp/qwen-agent-view.sock',
      token: 'token-1',
      activeCwd: '/repo',
    });
    let release: (value: unknown) => void = () => {};
    mockCallAgentViewSupervisor.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const first = reportAgentViewWorkerState({ sessionState: 'working' }, env);
    const second = reportAgentViewWorkerState({ sessionState: 'working' }, env);
    release({ accepted: true });
    await Promise.all([first, second]);

    expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(1);
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
      await vi.advanceTimersByTimeAsync(100);

      expect(mockCallAgentViewSupervisor).toHaveBeenCalledWith(
        '/tmp/qwen-agent-view.sock',
        'workerEvent',
        {
          type: 'heartbeat',
          at: expect.any(String),
          sessionId: 'session-1',
          token: 'token-1',
        },
      );
      expect(mockCallAgentViewSupervisor).toHaveBeenCalledTimes(2);

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
