/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmClient, ToolCallRequestInfo } from '@qwen-code/qwen-code-core';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import { SendMessageType } from '@qwen-code/qwen-code-core/core/client.js';
import { LlmEventType } from '@qwen-code/qwen-code-core/core/turn.js';
import { CANCEL_SETTLEMENT_CAP_MS } from '@qwen-code/qwen-code-core/event-bus/conversation.js';
import type {
  AgentLoopToolExecutor,
  AgentLoopToolResult,
  ToolBatchResult,
} from '@qwen-code/qwen-code-core/core/agent-loop.js';
import {
  startSharedLoopRound,
  type SharedLoopBatch,
} from '../../ui/hooks/shared-loop-round.js';
import {
  deferredToolUpdateContext,
  runAcpToolBatch,
  type AcpToolBatchHost,
} from './acp-tool-batch.js';

type SchedulerOptions = {
  onToolCallsUpdate: (calls: unknown[]) => void;
  outputUpdateHandler: (callId: string, chunk: unknown) => void;
  onToolExecutionStarted: (callId: string, startedAt: number) => void;
  onToolExecutionSettled: (
    callId: string,
    status: string,
    durationMs: number,
  ) => void;
};

const batch = vi.hoisted(() => ({
  options: undefined as unknown as SchedulerOptions,
  run: undefined as unknown as (
    shared: SharedLoopBatch,
  ) => Promise<ToolBatchResult>,
  execute: undefined as AgentLoopToolExecutor['run'] | undefined,
}));

vi.mock(
  '@qwen-code/qwen-code-core/core/agent-loop.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/core/agent-loop.js')
      >();
    return {
      ...actual,
      createSchedulerExecutor: (
        _config: unknown,
        options: SchedulerOptions,
      ) => {
        batch.options = options;
        return { run: batch.execute };
      },
    };
  },
);

/** The loop call of the batch's round, which runs what it is handed. */
const loop = { runBatch: (shared: SharedLoopBatch) => batch.run(shared) };

const read: ToolCallRequestInfo = {
  callId: 'call_read',
  name: 'read_file',
  args: { file_path: 'a.txt' },
  isClientInitiated: false,
  prompt_id: 'prompt',
};
const write: ToolCallRequestInfo = {
  callId: 'call_write',
  name: 'write_file',
  args: { file_path: 'a.txt', content: 'x' },
  isClientInitiated: false,
  prompt_id: 'prompt',
};
const invocation = {
  getDescription: () => 'Writing to a.txt',
  toolLocations: () => [],
};
const editDetails = (onConfirm = vi.fn().mockResolvedValue(undefined)) => ({
  type: 'edit' as const,
  title: 'Edit',
  fileName: 'a.txt',
  filePath: 'a.txt',
  fileDiff: '',
  originalContent: '',
  newContent: 'x',
  onConfirm,
});
const response = (
  request: ToolCallRequestInfo,
  fields: Record<string, unknown> = {},
) => ({
  callId: request.callId,
  responseParts: [
    {
      functionResponse: {
        id: request.callId,
        name: request.name,
        response: { output: 'ok' },
      },
    },
  ],
  resultDisplay: 'ok',
  error: undefined,
  errorType: undefined,
  executionStatus: 'success',
  ...fields,
});
const executed = (
  request: ToolCallRequestInfo,
  status = 'success',
): AgentLoopToolResult =>
  ({
    request,
    executionRequest: request,
    response: response(request),
    status,
    origin: 'executed',
  }) as AgentLoopToolResult;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runAcpToolBatch', () => {
  let log: Array<[string, unknown]>;
  let host: AcpToolBatchHost;
  let requestPermission: ReturnType<typeof vi.fn>;
  const isEventBusAgentLoopEnabled = vi.fn();
  const getToolOutputBatchBudget = vi.fn();
  const recordToolResult = vi.fn();
  const recordCompletedToolCall = vi.fn();

  beforeEach(() => {
    batch.execute = undefined;
    recordToolResult.mockClear();
    recordCompletedToolCall.mockClear();
    isEventBusAgentLoopEnabled.mockReturnValue(false);
    getToolOutputBatchBudget.mockReturnValue(Number.POSITIVE_INFINITY);
    log = [];
    const record =
      (name: string, result?: unknown) =>
      async (...args: unknown[]) => {
        log.push([name, args.length === 1 ? args[0] : args]);
        return result;
      };
    requestPermission = vi.fn().mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
    });
    const config = {
      getSessionId: () => 'session',
      getChatRecordingService: () => ({ recordToolResult }),
      getApprovalMode: () => 'default',
      setApprovalMode: vi.fn(),
      getLlmClient: () => ({ recordCompletedToolCall }),
      isEventBusAgentLoopEnabled,
      getToolOutputBatchBudget,
    };
    host = {
      ctx: { sessionId: 'session', config, sendUpdate: vi.fn() },
      client: {},
      toolCallEmitter: {
        emitStart: record('start', true),
        emitResult: record('result'),
        emitError: record('error'),
        emitLifecycle: record('lifecycle'),
        mapToolKind: () => 'edit',
      },
      messageEmitter: { emitAgentMessage: record('message') },
      sendUpdate: record('update'),
      requestPermission: async (...args: unknown[]) => {
        log.push(['permission', args[0]]);
        return requestPermission(...args);
      },
      sendModeUpdate: record('mode'),
      onPlanModeEntered: vi.fn(),
      todoPlanApproval: () => undefined,
      isTodoPlanApprovalStale: () => false,
      onTodoWriteSettled: vi.fn(),
      continueRelatedAgent: () => undefined,
      sendTerminalSequence: vi.fn(),
      refuseToolCall: () => undefined,
    } as unknown as AcpToolBatchHost;
  });

  const events = () =>
    log.map(([name, value]) => [
      name,
      name === 'lifecycle'
        ? (value as { phase: string }).phase
        : name === 'start'
          ? (value as { status: string }).status
          : name === 'result'
            ? (value as { success: boolean }).success
            : undefined,
    ]);

  async function runOnKernel(
    requests: ToolCallRequestInfo[],
    signal: AbortSignal,
  ) {
    isEventBusAgentLoopEnabled.mockReturnValue(true);
    const client = {
      async *sendMessageStream() {
        for (const request of requests) {
          yield { type: LlmEventType.ToolCallRequest, value: request };
        }
      },
      recordCompletedToolCall,
    } as unknown as LlmClient;
    const round = startSharedLoopRound(
      client,
      {
        parts: [{ text: 'test' }],
        promptId: 'prompt',
        options: { type: SendMessageType.UserQuery },
      },
      {
        config: host.ctx.config,
        signal,
        deferRecording: false,
        useEventBus: true,
        onModelEvent: () => {},
      },
    );
    await round.model;
    return runAcpToolBatch(host, {
      requests,
      loop: round,
      signal,
      duplicates: { handled: new Map(), responded: new Set() },
    });
  }

  it('returns at the kernel cancellation deadline while an approved tool is still running', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const started = deferred<void>();
    const tool = deferred<[]>();
    batch.execute = async () => {
      batch.options.onToolCallsUpdate([
        {
          status: 'awaiting_approval',
          request: write,
          invocation,
          tool: { kind: 'edit' },
          confirmationDetails: editDetails(
            vi.fn(async () => {
              started.resolve();
              await tool.promise;
            }),
          ),
        },
      ]);
      return tool.promise;
    };
    const settled = vi.fn();
    const result = runOnKernel([write], abort.signal).then(settled);
    try {
      await started.promise;
      abort.abort();
      await vi.advanceTimersByTimeAsync(CANCEL_SETTLEMENT_CAP_MS - 1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({ stop: 'cancelled', parts: [] }),
      );
    } finally {
      tool.resolve([]);
      await result;
      vi.useRealTimers();
    }
  });

  it('keeps the scheduler response when cancellation settles before confirmation returns', async () => {
    const abort = new AbortController();
    const confirming = deferred<void>();
    const confirmation = deferred<void>();
    const cancelled = {
      ...executed(write),
      status: 'cancelled' as const,
      response: {
        ...response(write),
        executionStatus: 'not_started' as const,
      },
    };
    batch.execute = async (_requests, signal) => {
      const onConfirm = vi.fn(async () => {
        confirming.resolve();
        await confirmation.promise;
      });
      batch.options.onToolCallsUpdate([
        {
          status: 'awaiting_approval',
          request: write,
          invocation,
          tool: { kind: 'edit' },
          confirmationDetails: editDetails(onConfirm),
        },
      ]);
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      batch.options.onToolCallsUpdate([cancelled]);
      return [cancelled];
    };
    const settled = vi.fn();
    const running = runOnKernel([write], abort.signal).then(settled);
    try {
      await confirming.promise;
      abort.abort();
      await vi.waitFor(() =>
        expect(settled).toHaveBeenCalledWith(
          expect.objectContaining({
            stop: 'cancelled',
            parts: cancelled.response.responseParts,
          }),
        ),
      );
      expect(events()).toContainEqual(['error', undefined]);
      expect(recordToolResult).toHaveBeenCalledTimes(1);
      // This cancellation settles with a recorded response, so it takes the
      // fallback path that reads the kernel switch for the 'acp' surface; a
      // wrong-but-valid label there must red this, not pass silently.
      const kernelCalls = isEventBusAgentLoopEnabled.mock.calls;
      expect(kernelCalls.length).toBeGreaterThan(0);
      expect(kernelCalls.every(([surface]) => surface === 'acp')).toBe(true);
    } finally {
      confirmation.resolve();
      await running;
    }
  });

  it.each([Number.POSITIVE_INFINITY, 512])(
    'keeps and delivers the completed sibling once after the cancellation deadline (budget %s)',
    async (budget) => {
      vi.useFakeTimers();
      getToolOutputBatchBudget.mockReturnValue(budget);
      const abort = new AbortController();
      const started = deferred<void>();
      const stalled = deferred<[]>();
      const pendingUpdate = deferred<void>();
      const emitStart = host.toolCallEmitter.emitStart;
      host.toolCallEmitter.emitStart = async (params) => {
        const emitted = await emitStart(params);
        await pendingUpdate.promise;
        return emitted;
      };
      const emitResult = host.toolCallEmitter.emitResult;
      const deferredDelivery = vi.fn();
      host.toolCallEmitter.emitResult = (params) => {
        deferredDelivery(deferredToolUpdateContext.getStore());
        return emitResult(params);
      };
      const fullOutput = 'abcdefghij'.repeat(120);
      const readResult = executed(read);
      const completed = {
        ...readResult,
        status: 'success' as const,
        response: {
          ...readResult.response,
          responseParts: [
            {
              functionResponse: {
                id: read.callId,
                name: read.name,
                response: { output: fullOutput },
              },
            },
          ],
        },
      };
      batch.execute = async (_requests, _signal, hooks) => {
        hooks.beforeLaunch(read, []);
        batch.options.onToolCallsUpdate([
          { status: 'executing', request: read },
        ]);
        batch.options.onToolExecutionStarted(read.callId, 1);
        batch.options.onToolCallsUpdate([completed]);
        hooks.beforeLaunch(write, [completed]);
        started.resolve();
        await stalled.promise;
        return [completed];
      };
      const running = runOnKernel([read, write], abort.signal);
      const settled = vi.fn<(result: Awaited<typeof running>) => void>();
      void running.then(settled);
      try {
        await started.promise;
        abort.abort();
        await vi.advanceTimersByTimeAsync(CANCEL_SETTLEMENT_CAP_MS);
        expect(events()).toContainEqual(['start', 'in_progress']);
        expect(events()).not.toContainEqual(['result', true]);
        const result = settled.mock.calls[0]?.[0];
        expect(result?.stop).toBe('cancelled');
        if (!result) throw new Error('Batch did not return at the deadline');
        const output = result.parts[0]?.functionResponse?.response?.['output'];
        if (typeof output !== 'string') throw new Error('Missing tool output');
        if (Number.isFinite(budget)) {
          expect(output.length).toBeLessThanOrEqual(budget);
          expect(output).toContain('Tool output truncated.');
        } else {
          expect(output).toBe(fullOutput);
        }
        expect(result.results).toEqual([
          {
            ...completed,
            response: { ...completed.response, responseParts: result.parts },
          },
        ]);
        expect(recordToolResult).toHaveBeenCalledExactlyOnceWith(
          result.parts,
          expect.objectContaining({ callId: read.callId, status: 'success' }),
          undefined,
        );
        expect(recordCompletedToolCall).toHaveBeenCalledExactlyOnceWith(
          read.name,
          read.args,
          { ...completed.response, status: completed.status },
        );
        pendingUpdate.resolve();
        stalled.resolve([]);
        await vi.advanceTimersByTimeAsync(0);
        expect(events().filter(([name]) => name === 'result')).toEqual([
          ['result', true],
        ]);
        expect(deferredDelivery).toHaveBeenCalledExactlyOnceWith(true);
        expect(recordToolResult).toHaveBeenCalledTimes(1);
        expect(recordCompletedToolCall).toHaveBeenCalledTimes(1);
      } finally {
        pendingUpdate.resolve();
        stalled.resolve([]);
        await running;
        vi.useRealTimers();
      }
    },
  );

  it('reports a call as it starts and as it settles', async () => {
    batch.run = async (shared) => {
      const { onToolCallsUpdate, onToolExecutionStarted } = batch.options;
      onToolCallsUpdate([{ status: 'scheduled', request: read, invocation }]);
      onToolCallsUpdate([{ status: 'executing', request: read, invocation }]);
      onToolExecutionStarted(read.callId, 1);
      batch.options.onToolExecutionSettled(read.callId, 'success', 2);
      onToolCallsUpdate([
        { status: 'success', request: read, response: response(read) },
      ]);
      shared.onToolResult(executed(read));
      return { parts: response(read).responseParts };
    };

    const result = await runAcpToolBatch(host, {
      requests: [read],
      loop,
      signal: new AbortController().signal,
      duplicates: { handled: new Map(), responded: new Set() },
    });

    expect(events()).toEqual([
      ['start', 'in_progress'],
      ['lifecycle', 'started'],
      ['lifecycle', 'ended'],
      ['result', true],
    ]);
    expect(result.results).toHaveLength(1);
    expect(result.stopAfterPermissionCancel).toBe(false);
  });

  it('asks the client for an approval and answers the scheduler', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    batch.run = async () => {
      batch.options.onToolCallsUpdate([
        {
          status: 'awaiting_approval',
          request: write,
          tool: { kind: 'edit' },
          invocation,
          confirmationDetails: editDetails(onConfirm),
        },
      ]);
      await vi.waitFor(() => expect(onConfirm).toHaveBeenCalled());
      return { parts: [] };
    };

    await runAcpToolBatch(host, {
      requests: [write],
      loop,
      signal: new AbortController().signal,
      duplicates: { handled: new Map(), responded: new Set() },
    });

    expect(log[0]).toEqual([
      'permission',
      expect.objectContaining({
        sessionId: 'session',
        toolCall: expect.objectContaining({
          toolCallId: 'call_write',
          status: 'pending',
          title: 'Writing to a.txt',
          rawInput: write.args,
          _meta: expect.objectContaining({ toolName: 'write_file' }),
        }),
      }),
    ]);
    expect(onConfirm).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      {
        answers: undefined,
      },
    );
  });

  it('stops the rest of the batch when the user cancels an approval', async () => {
    requestPermission.mockResolvedValue({ outcome: { outcome: 'cancelled' } });
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    let toolSignal: AbortSignal | undefined;
    batch.run = async (shared) => {
      toolSignal = shared.toolSignal;
      batch.options.onToolCallsUpdate([
        {
          status: 'awaiting_approval',
          request: write,
          tool: { kind: 'edit' },
          invocation,
          confirmationDetails: editDetails(onConfirm),
        },
      ]);
      await vi.waitFor(() => expect(onConfirm).toHaveBeenCalled());
      batch.options.onToolCallsUpdate([
        {
          status: 'cancelled',
          request: write,
          response: response(write, {
            executionStatus: 'not_started',
            responseParts: [],
          }),
        },
      ]);
      return { parts: [] };
    };

    const result = await runAcpToolBatch(host, {
      requests: [write],
      loop,
      signal: new AbortController().signal,
      duplicates: { handled: new Map(), responded: new Set() },
    });

    expect(onConfirm).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel, {
      cancelMessage: 'Tool "write_file" was canceled by the user.',
    });
    expect(toolSignal?.aborted).toBe(true);
    expect(result.stopAfterPermissionCancel).toBe(true);
    expect(log.at(-1)).toEqual([
      'error',
      [
        'call_write',
        'write_file',
        new Error('Tool "write_file" was canceled by the user.'),
      ],
    ]);
  });

  it('stops the batch at a call whose plan approval went stale before its launch', async () => {
    const exitPlan: ToolCallRequestInfo = {
      callId: 'call_exit',
      name: 'exit_plan_mode',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt',
    };
    let stale = false;
    host.todoPlanApproval = () => ({
      revision: { planId: 'plan', sourceCallId: 'call_todo' },
      generation: 1,
    });
    host.isTodoPlanApprovalStale = () => stale;
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    let launched: boolean | undefined;
    batch.run = async (shared) => {
      batch.options.onToolCallsUpdate([
        {
          status: 'awaiting_approval',
          request: exitPlan,
          tool: { kind: 'think' },
          invocation,
          confirmationDetails: editDetails(onConfirm),
        },
      ]);
      await vi.waitFor(() => expect(onConfirm).toHaveBeenCalled());
      stale = true;
      launched = shared.beforeToolLaunch?.(exitPlan, []);
      return { parts: [] };
    };

    const result = await runAcpToolBatch(host, {
      requests: [exitPlan],
      loop,
      signal: new AbortController().signal,
      duplicates: { handled: new Map(), responded: new Set() },
    });

    expect(launched).toBe(false);
    expect(result.stopAfterPermissionCancel).toBe(true);
  });

  it('tells the client the mode changed before an edit allowed always starts', async () => {
    requestPermission.mockResolvedValue({
      outcome: { outcome: 'selected', optionId: 'proceed_always' },
    });
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    batch.run = async () => {
      batch.options.onToolCallsUpdate([
        {
          status: 'awaiting_approval',
          request: write,
          tool: { kind: 'edit' },
          invocation,
          confirmationDetails: editDetails(onConfirm),
        },
      ]);
      await vi.waitFor(() => expect(onConfirm).toHaveBeenCalled());
      batch.options.onToolCallsUpdate([
        { status: 'executing', request: write, invocation },
      ]);
      batch.options.onToolExecutionStarted(write.callId, 1);
      return { parts: [] };
    };

    await runAcpToolBatch(host, {
      requests: [write],
      loop,
      signal: new AbortController().signal,
      duplicates: { handled: new Map(), responded: new Set() },
    });

    expect(events().slice(1, 3)).toEqual([
      ['mode', undefined],
      ['start', 'in_progress'],
    ]);
  });

  it('reports a call refused before it ran as an error, without a start', async () => {
    batch.run = async () => {
      batch.options.onToolCallsUpdate([
        {
          status: 'error',
          request: write,
          response: response(write, {
            executionStatus: 'not_started',
            error: new Error('Denied.'),
          }),
        },
      ]);
      return { parts: [] };
    };

    await runAcpToolBatch(host, {
      requests: [write],
      loop,
      signal: new AbortController().signal,
      duplicates: { handled: new Map(), responded: new Set() },
    });

    expect(events()).toEqual([
      ['lifecycle', 'ended'],
      ['error', undefined],
    ]);
    expect(log.at(-1)?.[1]).toEqual([
      'call_write',
      'write_file',
      new Error('Denied.'),
    ]);
  });

  it('reports a replayed call as failed', async () => {
    batch.run = async (shared) => {
      shared.onToolResult({
        ...executed(read),
        status: 'error',
        origin: 'replayed',
      });
      return { parts: [] };
    };

    await runAcpToolBatch(host, {
      requests: [read],
      loop,
      signal: new AbortController().signal,
      duplicates: { handled: new Map(), responded: new Set() },
    });

    expect(events()).toEqual([['result', false]]);
  });

  it('forwards shell heartbeats of a running call', async () => {
    const heartbeat = { type: 'shell_progress', elapsedMs: 5 };
    batch.run = async () => {
      batch.options.onToolCallsUpdate([
        { status: 'executing', request: read, invocation },
      ]);
      batch.options.outputUpdateHandler(read.callId, heartbeat);
      return { parts: [] };
    };

    await runAcpToolBatch(host, {
      requests: [read],
      loop,
      signal: new AbortController().signal,
      duplicates: { handled: new Map(), responded: new Set() },
    });

    expect(log).toContainEqual([
      'update',
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_read',
        status: 'in_progress',
        _meta: { toolName: 'read_file', shellProgress: heartbeat },
      },
    ]);
  });
});
