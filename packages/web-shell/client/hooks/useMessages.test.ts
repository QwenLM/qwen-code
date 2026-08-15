// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  DaemonHttpError,
  type DaemonStatusTranscriptBlock,
  type DaemonTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import {
  type BackgroundAgentResolution,
  getBackgroundAgentNotificationKey,
  getPendingBackgroundAgentKey,
  reconcileBackgroundAgentResolutions,
  transcriptBlocksToLocalizedMessages,
  useMessages,
} from './useMessages';
import type { Message } from '../adapters/types';

const hookState = vi.hoisted(() => {
  const resolveSubagentSession = vi.fn();
  return {
    blocks: [] as DaemonTranscriptBlock[],
    connection: {
      sessionId: 'session-1',
      status: 'connected',
      loadingTranscript: false,
      catchingUp: false,
    },
    client: { resolveSubagentSession },
    resolveSubagentSession,
  };
});

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => hookState.connection,
  useTranscriptBlocks: () => hookState.blocks,
  useWorkspace: () => ({ client: hookState.client }),
}));

function baseBlock(
  block: Omit<
    DaemonTranscriptBlock,
    'clientReceivedAt' | 'createdAt' | 'updatedAt'
  >,
): DaemonTranscriptBlock {
  return {
    ...block,
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  } as DaemonTranscriptBlock;
}

describe('transcriptBlocksToLocalizedMessages', () => {
  it('uses the same localized labels for externally supplied blocks', () => {
    const t = (key: string, vars?: Record<string, string | number>) =>
      vars?.name ? `${key}:${vars.name}` : `localized:${key}`;
    const blocks: DaemonTranscriptBlock[] = [
      baseBlock({ id: 'cancelled', kind: 'prompt_cancelled' }),
      baseBlock({
        id: 'branch',
        kind: 'status',
        text: 'legacy branch text',
        source: 'session_branched',
        data: { displayName: 'review' },
      } as Omit<
        DaemonStatusTranscriptBlock,
        'clientReceivedAt' | 'createdAt' | 'updatedAt'
      >),
      baseBlock({
        id: 'interrupted',
        kind: 'error',
        text: 'terminated',
        errorKind: 'model_stream_interrupted',
      } as Omit<
        DaemonStatusTranscriptBlock,
        'clientReceivedAt' | 'createdAt' | 'updatedAt'
      >),
      baseBlock({
        id: 'loop',
        kind: 'error',
        text: 'internal fallback',
        errorKind: 'loop_detected',
      } as Omit<
        DaemonStatusTranscriptBlock,
        'clientReceivedAt' | 'createdAt' | 'updatedAt'
      >),
    ];

    expect(transcriptBlocksToLocalizedMessages(blocks, t)).toMatchObject([
      { content: 'localized:request.cancelled' },
      { content: 'branch.success:review' },
      { content: 'localized:error.modelStreamInterrupted' },
      { content: 'localized:error.loopDetected' },
    ]);
  });
});

function backgroundAgentMessage(status: 'pending' | 'completed' = 'pending') {
  return {
    id: 'agent-block',
    role: 'tool_group',
    tools: [
      {
        callId: 'agent-call',
        toolName: 'agent',
        status,
        args: { run_in_background: true },
        rawOutput: { type: 'task_execution', status: 'background' },
        startTime: 10,
      },
    ],
  } satisfies Message;
}

function backgroundAgentResolution(
  status: 'running' | 'completed' | 'failed' | 'cancelled',
): BackgroundAgentResolution {
  return {
    status,
    durationMs: 20,
  };
}

function backgroundAgentBlock(toolCallId: string): DaemonTranscriptBlock {
  return baseBlock({
    id: `agent-block-${toolCallId}`,
    kind: 'tool',
    toolCallId,
    title: 'Agent',
    status: 'completed',
    toolName: 'agent',
    rawInput: { run_in_background: true },
    rawOutput: { type: 'task_execution', status: 'background' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mountStatusConsumer(options: { allTools?: boolean } = {}) {
  const container = document.createElement('div');
  const root = createRoot(container);
  const t = (key: string) => key;
  function Consumer() {
    const messages = useMessages(t);
    const status = options.allTools
      ? messages
          .flatMap((message) =>
            message.role === 'tool_group'
              ? message.tools.map((tool) => tool.status)
              : [],
          )
          .join(',')
      : messages[0]?.role === 'tool_group'
        ? messages[0].tools[0]?.status
        : undefined;
    return createElement('div', null, status);
  }
  return {
    container,
    render: () =>
      root.render(createElement(StrictMode, null, createElement(Consumer))),
    unmount: () => root.unmount(),
  };
}

describe('background agent task reconciliation', () => {
  it('uses terminal agent notifications as a reconciliation trigger without requiring toolUseId', () => {
    expect(
      getBackgroundAgentNotificationKey([
        baseBlock({
          id: 'notification',
          kind: 'assistant',
          text: '',
          meta: {
            source: 'background_notification',
            backgroundTask: {
              kind: 'agent',
              taskId: 'legacy-agent',
              status: 'completed',
            },
          },
        }),
      ]),
    ).toBe('notification:completed');
  });

  it('uses only the latest terminal agent notification in the trigger key', () => {
    expect(
      getBackgroundAgentNotificationKey([
        baseBlock({
          id: 'older',
          kind: 'assistant',
          text: '',
          meta: {
            source: 'background_notification',
            backgroundTask: { kind: 'agent', status: 'completed' },
          },
        }),
        baseBlock({
          id: 'latest',
          kind: 'assistant',
          text: '',
          meta: {
            source: 'background_notification',
            backgroundTask: { kind: 'agent', status: 'failed' },
          },
        }),
      ]),
    ).toBe('latest:failed');
  });

  it('only requests reconciliation for an active background agent', () => {
    expect(getPendingBackgroundAgentKey([backgroundAgentMessage()])).toBe(
      'agent-call',
    );
    expect(
      getPendingBackgroundAgentKey([backgroundAgentMessage('completed')]),
    ).toBe('');
  });

  it.each([
    ['completed', 'completed', undefined],
    ['failed', 'failed', undefined],
    ['cancelled', 'completed', 'cancelled'],
  ] as const)(
    'restores a %s background agent from the task snapshot',
    (taskStatus, expectedStatus, expectedRawStatus) => {
      const [message] = reconcileBackgroundAgentResolutions(
        [backgroundAgentMessage()],
        new Map([['agent-call', backgroundAgentResolution(taskStatus)]]),
      );

      expect(message).toMatchObject({
        role: 'tool_group',
        tools: [
          {
            status: expectedStatus,
            endTime: 30,
            ...(expectedRawStatus
              ? { rawOutput: { status: expectedRawStatus } }
              : {}),
          },
        ],
      });
    },
  );

  it('does not complete the card from a running task snapshot', () => {
    expect(
      reconcileBackgroundAgentResolutions(
        [backgroundAgentMessage()],
        new Map([['agent-call', backgroundAgentResolution('running')]]),
      ),
    ).toMatchObject([{ role: 'tool_group', tools: [{ status: 'pending' }] }]);
  });

  it('queries once for a pending card and retains terminal state after reconnect', async () => {
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockResolvedValue(
      backgroundAgentResolution('completed'),
    );
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1);
      expect(hookState.resolveSubagentSession).toHaveBeenCalledWith(
        'session-1',
        'agent-call',
      );
      expect(container.textContent).toBe('completed');
    });

    hookState.blocks = [
      ...hookState.blocks,
      baseBlock({
        id: 'stream',
        kind: 'assistant',
        text: 'unrelated',
        streaming: true,
      }),
    ];
    await act(async () => render());

    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1);
    hookState.connection.status = 'disconnected';
    await act(async () => render());
    hookState.connection.status = 'connected';
    await act(async () => render());
    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1);

    await act(async () => unmount());
  });

  it('retries a running background agent with bounded backoff until terminal', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockResolvedValue(
      backgroundAgentResolution('running'),
    );
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('pending');

    // The backoff doubles after each non-terminal result and caps at 60s.
    // Asserted synchronously at exact 1-ms boundaries: vi.waitFor would
    // advance fake timers by its poll interval and blur them.
    for (const [index, delay] of [
      3_000, 6_000, 12_000, 24_000, 48_000, 60_000,
    ].entries()) {
      await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(index + 1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(index + 2);
      expect(container.textContent).toBe('pending');
    }

    hookState.resolveSubagentSession.mockResolvedValueOnce(
      backgroundAgentResolution('completed'),
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(8);
    expect(container.textContent).toBe('completed');

    await act(async () => unmount());
    vi.useRealTimers();
  });

  it('treats a missing background agent as terminal after repeated misses', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockRejectedValue(
      new DaemonHttpError(
        404,
        { code: 'session_not_found', toolCallId: 'agent-call' },
        'not found',
      ),
    );
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1),
    );
    expect(container.textContent).toBe('pending');

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2);
      expect(container.textContent).toBe('failed');
    });

    await act(async () => unmount());
    vi.useRealTimers();
  });

  it('recovers a missing background agent that registers after a first miss', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession
      .mockRejectedValueOnce(
        new DaemonHttpError(
          404,
          { code: 'session_not_found', toolCallId: 'agent-call' },
          'not found',
        ),
      )
      .mockResolvedValueOnce(backgroundAgentResolution('completed'));
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1),
    );
    expect(container.textContent).toBe('pending');

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2);
      expect(container.textContent).toBe('completed');
    });

    await act(async () => unmount());
    vi.useRealTimers();
  });

  it('treats a permanent client error as terminal without retrying', async () => {
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockRejectedValue(
      new DaemonHttpError(400, { code: 'invalid_tool_call_id' }, 'bad request'),
    );
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() => expect(container.textContent).toBe('failed'));

    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1);
    await act(async () => unmount());
  });

  it('retries a rate-limited query instead of failing the agent', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession
      .mockRejectedValueOnce(
        new DaemonHttpError(
          429,
          { code: 'rate_limit_exceeded', retryAfterMs: 500 },
          'rate limited',
        ),
      )
      .mockResolvedValueOnce(backgroundAgentResolution('completed'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1),
    );
    expect(container.textContent).toBe('pending');
    await vi.waitFor(() =>
      expect(warnSpy).toHaveBeenCalledWith(
        '[web-shell] background agent reconciliation retry scheduled',
        {
          sessionId: 'session-1',
          callIds: ['agent-call'],
          errors: ['HTTP 429 rate_limit_exceeded'],
        },
      ),
    );

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2);
      expect(container.textContent).toBe('completed');
    });

    await act(async () => unmount());
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('stops retrying and fails agents whose errors exhaust the retry budget', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockRejectedValue(
      new DaemonHttpError(500, { code: 'internal_error' }, 'server error'),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1),
    );
    expect(container.textContent).toBe('pending');

    // Seven scheduled retries (3s, 6s, 12s, 24s, 48s, then capped at 60s);
    // the eighth round exhausts the budget instead of scheduling another.
    for (const delay of [
      3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000,
    ]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(8);
      expect(container.textContent).toBe('failed');
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[web-shell] background agent reconciliation retry budget exhausted; marking agents failed',
      {
        sessionId: 'session-1',
        callIds: ['agent-call'],
        errors: ['HTTP 500 internal_error'],
      },
    );

    // The timer chain has stopped: no further polling.
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(8);

    await act(async () => unmount());
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('keeps the grown retry delay when other agent notifications arrive', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockRejectedValue(
      new DaemonHttpError(500, { code: 'internal_error' }, 'server error'),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1),
    );

    // First retry schedules at the 3s base; it errors, so the next delay
    // grows to 6s.
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2),
    );

    // A notification for another agent triggers an immediate round but must
    // not reset the backoff: the following retry is attempt 3 (12s), not a
    // fresh 3s base.
    hookState.blocks = [
      ...hookState.blocks,
      baseBlock({
        id: 'terminal-notification',
        kind: 'assistant',
        text: '',
        meta: {
          source: 'background_notification',
          backgroundTask: {
            kind: 'agent',
            taskId: 'other-agent',
            status: 'completed',
          },
        },
      }),
    ];
    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(3),
    );

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(9_000));
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(4),
    );

    await act(async () => unmount());
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('does not carry missing-agent miss counts across a reconnect', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockRejectedValue(
      new DaemonHttpError(
        404,
        { code: 'session_not_found', toolCallId: 'agent-call' },
        'not found',
      ),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1),
    );
    expect(container.textContent).toBe('pending');

    hookState.connection.status = 'disconnected';
    await act(async () => render());
    hookState.connection.status = 'connected';
    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2),
    );
    // The post-reconnect miss starts a fresh grace window, so the agent
    // stays pending instead of failing on a stale second miss.
    expect(container.textContent).toBe('pending');

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(3);
      expect(container.textContent).toBe('failed');
    });

    await act(async () => unmount());
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('gives a session-level 404 the same grace as a missing agent', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockRejectedValue(
      new DaemonHttpError(
        404,
        { code: 'session_not_found', sessionId: 'session-1' },
        'not found',
      ),
    );
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1),
    );
    // The daemon answers this shape for transient workspace states too, so
    // a first session-level miss keeps polling instead of failing the card.
    expect(container.textContent).toBe('pending');

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2);
      expect(container.textContent).toBe('failed');
    });

    await act(async () => unmount());
    vi.useRealTimers();
  });

  it('recovers a session-level 404 when the next round reaches the daemon', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession
      .mockRejectedValueOnce(
        new DaemonHttpError(
          404,
          { code: 'session_not_found', sessionId: 'session-1' },
          'not found',
        ),
      )
      .mockResolvedValueOnce(backgroundAgentResolution('completed'));
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1),
    );
    expect(container.textContent).toBe('pending');

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2);
      expect(container.textContent).toBe('completed');
    });

    await act(async () => unmount());
    vi.useRealTimers();
  });

  it('does not fail an agent on a 404 identifying a different tool call', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockRejectedValue(
      new DaemonHttpError(
        404,
        { code: 'session_not_found', toolCallId: 'other-call' },
        'not found',
      ),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1),
    );
    expect(container.textContent).toBe('pending');

    // The mismatched 404 is transient; reconciliation must keep polling
    // instead of abandoning the card at pending.
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2),
    );
    expect(container.textContent).toBe('pending');

    await act(async () => unmount());
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('reconciles after a terminal agent notification without toolUseId', async () => {
    hookState.connection.sessionId = 'session-1';
    hookState.connection.status = 'connected';
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession
      .mockResolvedValueOnce(backgroundAgentResolution('running'))
      .mockResolvedValueOnce(backgroundAgentResolution('completed'));
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    expect(container.textContent).toBe('pending');
    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1);

    hookState.blocks = [
      ...hookState.blocks,
      baseBlock({
        id: 'terminal-notification',
        kind: 'assistant',
        text: '',
        meta: {
          source: 'background_notification',
          backgroundTask: {
            kind: 'agent',
            taskId: 'legacy-agent',
            status: 'completed',
          },
        },
      }),
    ];
    await act(async () => render());
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2);
      expect(container.textContent).toBe('completed');
    });

    await act(async () => unmount());
  });

  it('ignores an older response after the pending Agent set expands', async () => {
    hookState.connection.sessionId = 'session-1';
    hookState.connection.status = 'connected';
    hookState.blocks = [backgroundAgentBlock('agent-a')];
    const older = deferred<BackgroundAgentResolution>();
    const newerA = deferred<BackgroundAgentResolution>();
    const newerB = deferred<BackgroundAgentResolution>();
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newerA.promise)
      .mockReturnValueOnce(newerB.promise);
    const { container, render, unmount } = mountStatusConsumer({
      allTools: true,
    });

    await act(async () => render());
    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1);
    hookState.blocks = [
      backgroundAgentBlock('agent-a'),
      backgroundAgentBlock('agent-b'),
    ];
    await act(async () => render());
    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(3);

    await act(async () => {
      newerA.resolve(backgroundAgentResolution('completed'));
      newerB.resolve(backgroundAgentResolution('completed'));
    });
    expect(container.textContent).toBe('completed,completed');
    await act(async () => older.resolve(backgroundAgentResolution('running')));
    expect(container.textContent).toBe('completed,completed');

    await act(async () => unmount());
  });

  it('does not consume grace misses for a superseded round', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    const older = deferred<BackgroundAgentResolution>();
    const newer = deferred<BackgroundAgentResolution>();
    hookState.resolveSubagentSession
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
      .mockResolvedValue(backgroundAgentResolution('completed'));
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1);

    // A notification supersedes the in-flight round while it is pending.
    hookState.blocks = [
      ...hookState.blocks,
      baseBlock({
        id: 'terminal-notification',
        kind: 'assistant',
        text: '',
        meta: {
          source: 'background_notification',
          backgroundTask: {
            kind: 'agent',
            taskId: 'legacy-agent',
            status: 'completed',
          },
        },
      }),
    ];
    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2),
    );

    // Both rounds hit the same unregistered-daemon 404. The stale round's
    // 404 lands first, then the live round's: only the live round's miss
    // may count, so the stale one must not pre-increment the counter and
    // fail the agent on the live round's first miss.
    const miss = new DaemonHttpError(
      404,
      { code: 'session_not_found', toolCallId: 'agent-call' },
      'not found',
    );
    await act(async () => {
      older.reject(miss);
      newer.reject(miss);
    });
    expect(container.textContent).toBe('pending');

    // The live round keeps polling and reconciles on the next attempt.
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(3);
      expect(container.textContent).toBe('completed');
    });

    await act(async () => unmount());
    vi.useRealTimers();
  });

  it('applies successful resolutions when another pending Agent fails', async () => {
    hookState.connection.sessionId = 'session-1';
    hookState.connection.status = 'connected';
    hookState.blocks = [
      backgroundAgentBlock('agent-a'),
      backgroundAgentBlock('agent-b'),
    ];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockImplementation(
      (_sessionId: string, callId: string) =>
        callId === 'agent-a'
          ? Promise.resolve(backgroundAgentResolution('completed'))
          : Promise.reject(new Error('not found')),
    );
    const { container, render, unmount } = mountStatusConsumer({
      allTools: true,
    });

    await act(async () => render());
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(3);
      expect(container.textContent).toBe('completed,pending');
    });
    expect(hookState.resolveSubagentSession.mock.calls[2]?.[1]).toBe('agent-b');

    hookState.resolveSubagentSession.mockImplementation(
      (_sessionId: string, callId: string) =>
        callId === 'agent-b'
          ? Promise.resolve(backgroundAgentResolution('completed'))
          : Promise.reject(new Error('not found')),
    );
    hookState.blocks = [
      ...hookState.blocks,
      baseBlock({
        id: 'terminal-notification',
        kind: 'assistant',
        text: '',
        meta: {
          source: 'background_notification',
          backgroundTask: {
            kind: 'agent',
            taskId: 'legacy-agent',
            status: 'completed',
          },
        },
      }),
    ];
    await act(async () => render());
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(4);
      expect(container.textContent).toBe('completed,completed');
    });

    await act(async () => unmount());
  });

  it('ignores an older response after switching sessions', async () => {
    hookState.connection.sessionId = 'session-a';
    hookState.connection.status = 'connected';
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    const sessionA = deferred<BackgroundAgentResolution>();
    const sessionB = deferred<BackgroundAgentResolution>();
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession
      .mockReturnValueOnce(sessionA.promise)
      .mockReturnValueOnce(sessionB.promise);
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    hookState.connection.sessionId = 'session-b';
    await act(async () => render());
    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2);

    await act(async () =>
      sessionB.resolve(backgroundAgentResolution('completed')),
    );
    expect(container.textContent).toBe('completed');
    await act(async () =>
      sessionA.resolve(backgroundAgentResolution('running')),
    );
    expect(container.textContent).toBe('completed');

    await act(async () => unmount());
    hookState.connection.sessionId = 'session-1';
  });

  it('keeps retry tolerance for the completion query of a long-running agent', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockResolvedValue(
      backgroundAgentResolution('running'),
    );
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    // Drive the agent through the full backoff ladder while it answers
    // running; healthy rounds must not consume the failure budget.
    for (const delay of [
      3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000,
    ]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(8),
    );
    expect(container.textContent).toBe('pending');

    // The completion notification triggers the final query; a single transient
    // 500 there must recover rather than permanently fail the completed agent.
    hookState.resolveSubagentSession
      .mockRejectedValueOnce(
        new DaemonHttpError(500, { code: 'internal_error' }, 'server error'),
      )
      .mockResolvedValueOnce(backgroundAgentResolution('completed'));
    hookState.blocks = [
      ...hookState.blocks,
      baseBlock({
        id: 'terminal-notification',
        kind: 'assistant',
        text: '',
        meta: {
          source: 'background_notification',
          backgroundTask: {
            kind: 'agent',
            taskId: 'legacy-agent',
            status: 'completed',
          },
        },
      }),
    ];
    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(9),
    );
    expect(container.textContent).toBe('pending');

    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(10);
      expect(container.textContent).toBe('completed');
    });

    await act(async () => unmount());
    vi.useRealTimers();
  });

  it('fails only the erroring agent when the budget exhausts with several pending agents', async () => {
    vi.useFakeTimers();
    hookState.blocks = [
      backgroundAgentBlock('agent-a'),
      backgroundAgentBlock('agent-b'),
    ];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockImplementation(
      (_sessionId: string, callId: string) =>
        callId === 'agent-a'
          ? Promise.reject(
              new DaemonHttpError(
                500,
                { code: 'internal_error' },
                'server error',
              ),
            )
          : Promise.resolve(backgroundAgentResolution('running')),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container, render, unmount } = mountStatusConsumer({
      allTools: true,
    });

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2),
    );
    expect(container.textContent).toBe('pending,pending');

    // Agent A errors every round while agent B answers running; once the
    // budget exhausts only the erroring agent is marked failed.
    for (const delay of [
      3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000,
    ]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }
    await vi.waitFor(() => {
      expect(container.textContent).toBe('failed,pending');
    });

    // A's failure shrinks the pending set, opening a fresh retry scope: the
    // healthy sibling keeps polling and still reconciles terminal.
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenLastCalledWith(
        'session-1',
        'agent-b',
      ),
    );
    hookState.resolveSubagentSession.mockImplementation(
      (_sessionId: string, callId: string) =>
        callId === 'agent-b'
          ? Promise.resolve(backgroundAgentResolution('completed'))
          : Promise.reject(
              new DaemonHttpError(
                500,
                { code: 'internal_error' },
                'server error',
              ),
            ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await vi.waitFor(() => {
      expect(container.textContent).toBe('failed,completed');
    });

    await act(async () => unmount());
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('does not fail a healthy sibling that blips when another agent exhausts the budget', async () => {
    vi.useFakeTimers();
    hookState.blocks = [
      backgroundAgentBlock('agent-a'),
      backgroundAgentBlock('agent-b'),
    ];
    hookState.resolveSubagentSession.mockReset();
    let bCalls = 0;
    hookState.resolveSubagentSession.mockImplementation(
      (_sessionId: string, callId: string) => {
        if (callId === 'agent-a') {
          return Promise.reject(
            new DaemonHttpError(
              500,
              { code: 'internal_error' },
              'server error',
            ),
          );
        }
        bCalls += 1;
        // Agent B answers running for seven rounds and has a single
        // transient blip exactly in the round that exhausts agent A.
        return bCalls === 8
          ? Promise.reject(
              new DaemonHttpError(
                500,
                { code: 'internal_error' },
                'server error',
              ),
            )
          : Promise.resolve(backgroundAgentResolution('running'));
      },
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container, render, unmount } = mountStatusConsumer({
      allTools: true,
    });

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2),
    );
    for (const delay of [
      3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000,
    ]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }
    await vi.waitFor(() => {
      expect(container.textContent).toBe('failed,pending');
    });

    // B's own consecutive-error count is one, so it keeps polling on a
    // fresh scope and still reconciles terminal.
    hookState.resolveSubagentSession.mockImplementation(
      (_sessionId: string, callId: string) =>
        callId === 'agent-b'
          ? Promise.resolve(backgroundAgentResolution('completed'))
          : Promise.reject(
              new DaemonHttpError(
                500,
                { code: 'internal_error' },
                'server error',
              ),
            ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await vi.waitFor(() => {
      expect(container.textContent).toBe('failed,completed');
    });

    await act(async () => unmount());
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('keeps the full retry budget when the client identity changes between rounds', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockRejectedValue(
      new DaemonHttpError(500, { code: 'internal_error' }, 'server error'),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const originalClient = hookState.client;
    const { container, render, unmount } = mountStatusConsumer();

    try {
      await act(async () => render());
      await vi.waitFor(() =>
        expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1),
      );
      expect(container.textContent).toBe('pending');

      // The embedding host swaps the client identity while staying
      // connected. The settled round was already processed, so the hook must
      // issue a fresh query instead of attaching a second handler to the
      // cached promise and counting the same round twice.
      hookState.client = {
        resolveSubagentSession: hookState.resolveSubagentSession,
      };
      await act(async () => render());
      await vi.waitFor(() =>
        expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2),
      );
      expect(container.textContent).toBe('pending');

      // The double-count must not shorten the documented budget: failure
      // still takes eight erroring rounds in total.
      for (const delay of [6_000, 12_000, 24_000, 48_000, 60_000, 60_000]) {
        await act(async () => vi.advanceTimersByTimeAsync(delay));
      }
      await vi.waitFor(() => {
        expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(8);
        expect(container.textContent).toBe('failed');
      });
    } finally {
      await act(async () => unmount());
      hookState.client = originalClient;
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('re-arms the missing-agent grace after a successful response', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession
      .mockRejectedValueOnce(
        new DaemonHttpError(
          404,
          { code: 'session_not_found', toolCallId: 'agent-call' },
          'not found',
        ),
      )
      .mockResolvedValueOnce(backgroundAgentResolution('running'))
      .mockRejectedValueOnce(
        new DaemonHttpError(
          404,
          { code: 'session_not_found', toolCallId: 'agent-call' },
          'not found',
        ),
      )
      .mockRejectedValueOnce(
        new DaemonHttpError(
          404,
          { code: 'session_not_found', toolCallId: 'agent-call' },
          'not found',
        ),
      );
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1),
    );
    expect(container.textContent).toBe('pending');

    // Round 2 answers running, resetting the miss counter.
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2),
    );
    expect(container.textContent).toBe('pending');

    // Round 3 misses again, but the earlier success re-armed the grace, so a
    // single fresh miss stays pending instead of failing.
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(3),
    );
    expect(container.textContent).toBe('pending');

    // Round 4 is the second miss of the fresh window and fails the agent.
    await act(async () => vi.advanceTimersByTimeAsync(12_000));
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(4);
      expect(container.textContent).toBe('failed');
    });

    await act(async () => unmount());
    vi.useRealTimers();
  });

  it('does not consume the error budget for tolerated missing-agent misses', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    // Alternate in-grace 404 misses and healthy answers for far more rounds
    // than the error budget allows; each tolerated miss is followed by a
    // success, so none of them may accumulate toward exhaustion.
    for (let round = 0; round < 10; round += 1) {
      hookState.resolveSubagentSession
        .mockRejectedValueOnce(
          new DaemonHttpError(
            404,
            { code: 'session_not_found', toolCallId: 'agent-call' },
            'not found',
          ),
        )
        .mockResolvedValueOnce(backgroundAgentResolution('running'));
    }
    hookState.resolveSubagentSession.mockResolvedValue(
      backgroundAgentResolution('running'),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1),
    );
    expect(container.textContent).toBe('pending');

    // Drive nineteen more rounds over the full backoff ladder; each step
    // advances exactly one retry so the alternating miss/success rounds
    // interleave with React's flushes.
    for (let round = 0; round < 19; round += 1) {
      await act(async () =>
        vi.advanceTimersByTimeAsync(Math.min(3_000 * 2 ** round, 60_000)),
      );
    }
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(20),
    );
    expect(container.textContent).toBe('pending');

    await act(async () => unmount());
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('starts a fresh retry budget after a reconnect', async () => {
    vi.useFakeTimers();
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockRejectedValue(
      new DaemonHttpError(500, { code: 'internal_error' }, 'server error'),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container, render, unmount } = mountStatusConsumer();

    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1),
    );
    // Six retries take the budget to one transient error short of exhaustion.
    for (const delay of [3_000, 6_000, 12_000, 24_000, 48_000, 60_000]) {
      await act(async () => vi.advanceTimersByTimeAsync(delay));
    }
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(7),
    );
    expect(container.textContent).toBe('pending');

    // A reconnect resets the budget, so the next error opens a fresh ladder
    // instead of exhausting the pre-disconnect budget.
    hookState.connection.status = 'disconnected';
    await act(async () => render());
    hookState.connection.status = 'connected';
    await act(async () => render());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(8),
    );
    expect(container.textContent).toBe('pending');

    await act(async () => unmount());
    warnSpy.mockRestore();
    vi.useRealTimers();
  });
});
