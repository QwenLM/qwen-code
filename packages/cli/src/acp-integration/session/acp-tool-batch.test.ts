/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/tools/tools.js';
import type {
  AgentLoopToolResult,
  ToolBatchOptions,
} from '@qwen-code/qwen-code-core/core/agent-loop.js';
import type { Part } from '@google/genai';
import { runAcpToolBatch, type AcpToolBatchHost } from './acp-tool-batch.js';

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
    requests: ToolCallRequestInfo[],
    options: ToolBatchOptions,
  ) => Promise<{ parts: Part[]; stop?: string }>,
}));

vi.mock('@qwen-code/qwen-code-core/core/agent-loop.js', () => ({
  createSchedulerExecutor: (_config: unknown, options: SchedulerOptions) => {
    batch.options = options;
    return {};
  },
  runToolBatch: (requests: ToolCallRequestInfo[], options: ToolBatchOptions) =>
    batch.run(requests, options),
}));

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

describe('runAcpToolBatch', () => {
  let log: Array<[string, unknown]>;
  let host: AcpToolBatchHost;
  let requestPermission: ReturnType<typeof vi.fn>;

  beforeEach(() => {
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
      getChatRecordingService: () => undefined,
      getApprovalMode: () => 'default',
      setApprovalMode: vi.fn(),
      getLlmClient: () => ({}),
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

  it('reports a call as it starts and as it settles', async () => {
    batch.run = async (_requests, options) => {
      const { onToolCallsUpdate, onToolExecutionStarted } = batch.options;
      onToolCallsUpdate([{ status: 'scheduled', request: read, invocation }]);
      onToolCallsUpdate([{ status: 'executing', request: read, invocation }]);
      onToolExecutionStarted(read.callId, 1);
      batch.options.onToolExecutionSettled(read.callId, 'success', 2);
      onToolCallsUpdate([
        { status: 'success', request: read, response: response(read) },
      ]);
      options.host?.onToolResult?.(executed(read));
      return { parts: response(read).responseParts };
    };

    const result = await runAcpToolBatch(host, {
      requests: [read],
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
    batch.run = async (_requests, options) => {
      toolSignal = options.toolSignal;
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
    batch.run = async (_requests, options) => {
      options.host?.onToolResult?.({
        ...executed(read),
        status: 'error',
        origin: 'replayed',
      });
      return { parts: [] };
    };

    await runAcpToolBatch(host, {
      requests: [read],
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
