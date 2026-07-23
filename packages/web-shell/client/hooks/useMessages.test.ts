// @vitest-environment jsdom

import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type {
  DaemonStatusTranscriptBlock,
  DaemonTranscriptBlock,
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
    ];

    expect(transcriptBlocksToLocalizedMessages(blocks, t)).toMatchObject([
      { content: 'localized:request.cancelled' },
      { content: 'branch.success:review' },
      { content: 'localized:error.modelStreamInterrupted' },
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
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

  it('queries once for a pending card, ignores streaming, and retries after reconnect', async () => {
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession.mockResolvedValue(
      backgroundAgentResolution('completed'),
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    const t = (key: string) => key;
    function Consumer() {
      const messages = useMessages(t);
      const status =
        messages[0]?.role === 'tool_group'
          ? messages[0].tools[0]?.status
          : undefined;
      return createElement('div', null, status);
    }

    const renderConsumer = () =>
      root.render(createElement(StrictMode, null, createElement(Consumer)));

    await act(async () => renderConsumer());
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
    await act(async () => renderConsumer());

    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1);
    hookState.connection.status = 'disconnected';
    await act(async () => renderConsumer());
    hookState.connection.status = 'connected';
    await act(async () => renderConsumer());
    await vi.waitFor(() =>
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2),
    );

    await act(async () => root.unmount());
  });

  it('reconciles after a terminal agent notification without toolUseId', async () => {
    hookState.connection.sessionId = 'session-1';
    hookState.connection.status = 'connected';
    hookState.blocks = [backgroundAgentBlock('agent-call')];
    hookState.resolveSubagentSession.mockReset();
    hookState.resolveSubagentSession
      .mockResolvedValueOnce(backgroundAgentResolution('running'))
      .mockResolvedValueOnce(backgroundAgentResolution('completed'));
    const container = document.createElement('div');
    const root = createRoot(container);
    const t = (key: string) => key;
    function Consumer() {
      const messages = useMessages(t);
      const status =
        messages[0]?.role === 'tool_group'
          ? messages[0].tools[0]?.status
          : undefined;
      return createElement('div', null, status);
    }
    const renderConsumer = () =>
      root.render(createElement(StrictMode, null, createElement(Consumer)));

    await act(async () => renderConsumer());
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
    await act(async () => renderConsumer());
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2);
      expect(container.textContent).toBe('completed');
    });

    await act(async () => root.unmount());
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
    const container = document.createElement('div');
    const root = createRoot(container);
    const t = (key: string) => key;
    function Consumer() {
      const statuses = useMessages(t).flatMap((message) =>
        message.role === 'tool_group'
          ? message.tools.map((tool) => tool.status)
          : [],
      );
      return createElement('div', null, statuses.join(','));
    }
    const renderConsumer = () =>
      root.render(createElement(StrictMode, null, createElement(Consumer)));

    await act(async () => renderConsumer());
    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(1);
    hookState.blocks = [
      backgroundAgentBlock('agent-a'),
      backgroundAgentBlock('agent-b'),
    ];
    await act(async () => renderConsumer());
    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(3);

    await act(async () => {
      newerA.resolve(backgroundAgentResolution('completed'));
      newerB.resolve(backgroundAgentResolution('completed'));
    });
    expect(container.textContent).toBe('completed,completed');
    await act(async () => older.resolve(backgroundAgentResolution('running')));
    expect(container.textContent).toBe('completed,completed');

    await act(async () => root.unmount());
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
    const container = document.createElement('div');
    const root = createRoot(container);
    const t = (key: string) => key;
    function Consumer() {
      const statuses = useMessages(t).flatMap((message) =>
        message.role === 'tool_group'
          ? message.tools.map((tool) => tool.status)
          : [],
      );
      return createElement('div', null, statuses.join(','));
    }
    const renderConsumer = () =>
      root.render(createElement(StrictMode, null, createElement(Consumer)));

    await act(async () => renderConsumer());
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2);
      expect(container.textContent).toBe('completed,pending');
    });

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
    await act(async () => renderConsumer());
    await vi.waitFor(() => {
      expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(4);
      expect(container.textContent).toBe('completed,completed');
    });

    await act(async () => root.unmount());
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
    const container = document.createElement('div');
    const root = createRoot(container);
    const t = (key: string) => key;
    function Consumer() {
      const messages = useMessages(t);
      const status =
        messages[0]?.role === 'tool_group'
          ? messages[0].tools[0]?.status
          : undefined;
      return createElement('div', null, status);
    }
    const renderConsumer = () =>
      root.render(createElement(StrictMode, null, createElement(Consumer)));

    await act(async () => renderConsumer());
    hookState.connection.sessionId = 'session-b';
    await act(async () => renderConsumer());
    expect(hookState.resolveSubagentSession).toHaveBeenCalledTimes(2);

    await act(async () =>
      sessionB.resolve(backgroundAgentResolution('completed')),
    );
    expect(container.textContent).toBe('completed');
    await act(async () =>
      sessionA.resolve(backgroundAgentResolution('running')),
    );
    expect(container.textContent).toBe('completed');

    await act(async () => root.unmount());
    hookState.connection.sessionId = 'session-1';
  });
});
