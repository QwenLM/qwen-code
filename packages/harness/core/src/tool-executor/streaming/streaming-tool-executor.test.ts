/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoopContext } from '../../config/agent-loop-context.js';
import {
  CoreToolCallStatus,
  ROOT_TOOL_CALL_SCOPE_ID,
  type ToolCall,
} from '../types.js';
import {
  recordToolCallStats,
  resolveToolCallScopeId,
  StreamingToolExecutor,
} from './streaming-tool-executor.js';
import { LocalToolCallExecutor } from './tool-call-runner.js';
import * as gate from './pre-execution-gate.js';
import { MockTool } from '../../test-utils/mock-tool.js';
import { makeFakeConfig } from '../../test-utils/config.js';
import { testListedModel } from '../../test-utils/listed-model.js';
import { defineDeclarativeTool } from '../../tools/define-tool.js';
import { Kind, type ToolLiveOutput } from '../../tools/tools.js';
import type { ToolUseContext } from '../../tools/tool-types.js';
import {
  businessInfoContext,
  requestSetIdContext,
} from '../../utils/sessionIdContext.js';

import { getToolCallContext } from '../../utils/toolCallContext.js';
import { createUserMessage } from '../../protocol/transcript/conversions.js';
import {
  enqueueSubagentSdkEvent,
  disposeSessionEventQueue,
} from '../../agents/subagent-sdk-events.js';
import type { AnyDeclarativeTool } from '../../tools/tools.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


afterEach(() => vi.restoreAllMocks());

it('keeps Read images in the active executor result and conversation history', async () => {
  vi.spyOn(gate, 'createToolPreExecutionGate').mockImplementation(
    (options) => async (invocation, request) => {
      options.state.updateArgs(request.callId, request.args, invocation);
      return { status: 'proceed' };
    },
  );
  vi.spyOn(LocalToolCallExecutor.prototype, 'execute').mockResolvedValue({
    result: {
      llmContent: [{ inlineData: { data: 'aW1hZ2U=', mimeType: 'image/png' } }],
      returnDisplay: 'Read image',
      toolUseResult: { type: 'image', file: { base64: 'aW1hZ2U=' } },
    },
  });
  const tool = new MockTool({ name: 'Read' });
  const agent = {
    promptId: 'session',
    config: makeFakeConfig(),
    toolRegistry: {
      getTool: () => tool,
      getKnownTool: () => undefined,
      getAllToolNames: () => ['Read'],
    },
    toolCallSnapshots: { publishToolCallSnapshot: () => {} },
  } as unknown as AgentLoopContext;
  const signal = new AbortController().signal;
  const executor = new StreamingToolExecutor();
  try {
    const result = await executor.execute(
      { type: 'tool_use', id: 'read-image', name: 'Read', input: {} },
      {
        agentContext: agent,
        toolUseContext: { signal },
        signal,
        responseId: 'response',
        promptId: 'prompt',
        modelEntry: testListedModel('vision-model', { is_vl: true }),
      },
    );
    expect(result.block).toMatchObject({
      tool_use_id: 'read-image',
      content: [
        { type: 'text', text: 'Binary content provided (1 item(s)).' },
        {
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: 'aW1hZ2U=' },
        },
      ],
      is_error: false,
    });
    expect(result.historyMessage).toMatchObject({
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'read-image',
            content: expect.arrayContaining([
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'aW1hZ2U=',
                },
              },
            ]),
          },
        ],
      },
    });
  } finally {
    executor.dispose();
  }
});

it('keeps per-call metrics and rewritten Skill attribution through the active executor', async () => {
  vi.spyOn(gate, 'createToolPreExecutionGate').mockImplementation(
    (options) => async (invocation, request, _tool, _signal, context) => {
      options.state.updateArgs(request.callId, request.args, invocation);
      context!.skillHookContext = {
        requested_skill_name: 'original',
        skill_name: 'rewritten',
        activation_source: 'model_tool',
      };
      context!.extensionExecutionRawRecord!.skillName = 'rewritten';
      expect(Object.keys(request)).not.toContain('extensionExecutionRawRecord');
      expect(Object.keys(request)).not.toContain(
        'extensionStartedAtMonotonicMs',
      );
      return { status: 'proceed' };
    },
  );
  const execute = vi
    .spyOn(LocalToolCallExecutor.prototype, 'execute')
    .mockImplementation(async (context) => {
      expect(context.skillHookContext).toMatchObject({
        requested_skill_name: 'original',
        skill_name: 'rewritten',
      });
      expect(context.call.request.extensionExecutionRawRecord).toMatchObject({
        skillName: 'rewritten',
      });
      expect(context.call.request.extensionStartedAtMonotonicMs).toEqual(
        expect.any(Number),
      );
      return { result: { llmContent: 'ok', returnDisplay: 'ok' } };
    });
  const tool = new MockTool({ name: 'Skill' });
  const agent = {
    promptId: 'session',
    config: {
      promptId: 'session',
      isPlanMode: () => false,
    },
    toolRegistry: {
      getTool: () => tool,
      getKnownTool: () => undefined,
      getAllToolNames: () => ['Skill'],
    },
    toolCallSnapshots: { publishToolCallSnapshot: () => {} },
  } as unknown as AgentLoopContext;
  const signal = new AbortController().signal;
  const context = Object.freeze({ signal });
  const executor = new StreamingToolExecutor();
  try {
    for (const id of ['first', 'second']) {
      const result = await executor.execute(
        { type: 'tool_use', id, name: 'Skill', input: { skill: id } },
        {
          agentContext: agent,
          toolUseContext: context,
          signal,
          responseId: id,
          promptId: 'prompt',
        },
      );
      expect(result.block.is_error).not.toBe(true);
    }
    expect(execute).toHaveBeenCalledTimes(2);
    const requests = execute.mock.calls.map(([value]) => value.call.request);
    expect(requests[0].extensionExecutionRawRecord).not.toBe(
      requests[1].extensionExecutionRawRecord,
    );
    expect(context).not.toHaveProperty('skillHookContext');
  } finally {
    executor.dispose();
  }
});

it.each([false, true])(
  'uses current lifecycle identity across rounds instead of the initial context (session-bound=%s)',
  async (sessionBound) => {
    vi.spyOn(gate, 'createToolPreExecutionGate').mockImplementation(
      (options) => async (invocation, request) => {
        options.state.updateArgs(request.callId, request.args, invocation);
        return { status: 'proceed' };
      },
    );
    const observed: ToolUseContext[] = [];
    const Probe = defineDeclarativeTool({
      name: 'Probe',
      displayName: 'Probe',
      description: 'test',
      kind: Kind.Read,
      parameterSchema: { type: 'object', properties: {} },
      execute: async (_args, context) => {
        observed.push(context);
        return { llmContent: 'ok', returnDisplay: 'ok' };
      },
    });
    const tool = new Probe(undefined);
    const config = makeFakeConfig();
    const agent = {
      promptId: 'session',
      config,
      fileReadState: config.fileReadState,
      toolRegistry: {
        getTool: () => tool,
        getKnownTool: () => undefined,
        getAllToolNames: () => ['Probe'],
      },
      toolCallSnapshots: { publishToolCallSnapshot: () => {} },
    } as unknown as AgentLoopContext;
    const signal = new AbortController().signal;
    const initialBusiness = { id: 'business', version: '1', stage: 'init' };
    const initialContext = Object.freeze({
      signal,
      parentRequestSetId: 'initial-request-set',
      parentBusinessInfo: initialBusiness,
    });
    const execute = vi.spyOn(LocalToolCallExecutor.prototype, 'execute');
    const executor = new StreamingToolExecutor();
    try {
      for (const stage of ['start', 'processing']) {
        const business = { ...initialBusiness, stage };
        const result = await businessInfoContext.run(
          { id: 'unrelated', version: '1' },
          () =>
            requestSetIdContext.run('unrelated-request-set', () =>
              executor.execute(
                { type: 'tool_use', id: stage, name: 'Probe', input: {} },
                {
                  agentContext: agent,
                  toolUseContext: initialContext,
                  signal,
                  responseId: stage,
                  promptId: 'prompt',
                  sessionId: sessionBound ? 'session' : undefined,
                  requestSetId: 'current-request-set',
                  businessInfo: business,
                },
              ),
            ),
        );
        expect(result.block.is_error).not.toBe(true);
        const call = execute.mock.lastCall![0];
        expect(call.parentRequestSetId).toBe('current-request-set');
        expect(call.parentBusinessInfo).toBe(business);
        const context = observed.at(-1)!;
        expect(context.parentRequestSetId).toBe('current-request-set');
        expect(context.parentBusinessInfo).toBe(business);
      }
      expect(observed.map((context) => context.parentBusinessInfo?.stage)).toEqual([
        'start',
        'processing',
      ]);
      expect(initialContext.parentRequestSetId).toBe('initial-request-set');
      expect(initialBusiness.stage).toBe('init');
    } finally {
      executor.dispose();
    }
  },
);

it('publishes live tool output on the executing call snapshot', async () => {
  vi.spyOn(gate, 'createToolPreExecutionGate').mockImplementation(
    (options) => async (invocation, request) => {
      options.state.updateArgs(request.callId, request.args, invocation);
      return { status: 'proceed' };
    },
  );
  const progress = { isSubagentProgress: true, recentActivity: ['Read'] };
  const snapshots: ToolCall[][] = [];
  const Progressing = defineDeclarativeTool({
    name: 'Progressing',
    displayName: 'Progressing',
    description: 'test',
    kind: Kind.Read,
    parameterSchema: { type: 'object', properties: {} },
    canUpdateOutput: true,
    execute: async (_args, context) => {
      context.updateOutput?.(progress as unknown as ToolLiveOutput);
      // The snapshot is projected before the tool finishes.
      const executing = snapshots
        .at(-1)
        ?.find((call) => call.request.callId === 'live');
      expect(executing?.status).toBe(CoreToolCallStatus.Executing);
      expect(
        executing && 'liveOutput' in executing ? executing.liveOutput : undefined,
      ).toBe(progress);
      return { llmContent: 'ok', returnDisplay: 'ok' };
    },
  });
  const tool = new Progressing(undefined);
  const config = makeFakeConfig();
  const agent = {
    promptId: 'session',
    config,
    fileReadState: config.fileReadState,
    toolRegistry: {
      getTool: () => tool,
      getKnownTool: () => undefined,
      getAllToolNames: () => ['Progressing'],
    },
    toolCallSnapshots: {
      publishToolCallSnapshot: ({ toolCalls }: { toolCalls: ToolCall[] }) => {
        snapshots.push(toolCalls);
      },
    },
  } as unknown as AgentLoopContext;
  const signal = new AbortController().signal;
  const forwarded: ToolLiveOutput[] = [];
  const executor = new StreamingToolExecutor();
  try {
    const result = await executor.execute(
      { type: 'tool_use', id: 'live', name: 'Progressing', input: {} },
      {
        agentContext: agent,
        toolUseContext: Object.freeze({ signal }),
        signal,
        responseId: 'live',
        promptId: 'prompt',
        updateOutput: (output) => forwarded.push(output),
      },
    );
    expect(result.block.is_error).not.toBe(true);
    expect(forwarded).toEqual([progress]);
  } finally {
    executor.dispose();
  }
});

it('publishes the execution id on the executing call snapshot', async () => {
  vi.spyOn(gate, 'createToolPreExecutionGate').mockImplementation(
    (options) => async (invocation, request) => {
      options.state.updateArgs(request.callId, request.args, invocation);
      return { status: 'proceed' };
    },
  );
  const snapshots: ToolCall[][] = [];
  const WithExecutionId = defineDeclarativeTool({
    name: 'WithExecutionId',
    displayName: 'WithExecutionId',
    description: 'test',
    kind: Kind.Execute,
    parameterSchema: { type: 'object', properties: {} },
    canUpdateOutput: true,
    execute: async (_args, context) => {
      context.options?.setExecutionIdCallback?.(4242);
      return { llmContent: 'ok', returnDisplay: 'ok' };
    },
  });
  const tool = new WithExecutionId(undefined);
  const config = makeFakeConfig();
  const agent = {
    promptId: 'session',
    config,
    fileReadState: config.fileReadState,
    toolRegistry: {
      getTool: () => tool,
      getKnownTool: () => undefined,
      getAllToolNames: () => ['WithExecutionId'],
    },
    toolCallSnapshots: {
      publishToolCallSnapshot: ({ toolCalls }: { toolCalls: ToolCall[] }) => {
        snapshots.push(toolCalls);
      },
    },
  } as unknown as AgentLoopContext;
  const signal = new AbortController().signal;
  const executor = new StreamingToolExecutor();
  try {
    const result = await executor.execute(
      { type: 'tool_use', id: 'pid', name: 'WithExecutionId', input: {} },
      {
        agentContext: agent,
        toolUseContext: Object.freeze({ signal }),
        signal,
        responseId: 'pid',
        promptId: 'prompt',
      },
    );
    expect(result.block.is_error).not.toBe(true);

    const projected = snapshots.some((calls) => {
      const call = calls.find((candidate) => candidate.request.callId === 'pid');
      return call?.status === CoreToolCallStatus.Executing && call.pid === 4242;
    });
    expect(projected).toBe(true);
  } finally {
    executor.dispose();
  }
});

it('流式工具执行保留各自父调用身份，子事件可被消费且不污染调用方', async () => {
  vi.spyOn(gate, 'createToolPreExecutionGate').mockImplementation(
    (options: import('./pre-execution-gate.js').ToolGateOptions) =>
    async (
      invocation: unknown,
      request: { callId: string; args: Record<string, unknown> },
    ) => {
      options.state.updateArgs(
        request.callId,
        request.args,
        invocation as Parameters<typeof options.state.updateArgs>[2],
      );
      return { status: 'proceed' };
    },
  );

  const sessionId = 'tool-context-session';
  const root = await mkdtemp(join(tmpdir(), 'tool-context-'));
  const config = makeFakeConfig({ sessionId, targetDir: root });
  const executor = new StreamingToolExecutor();
  const signal = new AbortController().signal;
  const observed = new Map<string, string | undefined>();
  const tool = {
    name: 'ContextProbe',
    description: '',
    maxResultSizeChars: Infinity,
    isConcurrencySafe: () => true,
    build: (input: { label: string }) => ({
      params: input,
      execute: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const parentId = getToolCallContext()?.callId;
        observed.set(input.label, parentId);
        const message = createUserMessage(input.label);
        message.parent_tool_use_id = parentId ?? null;
        enqueueSubagentSdkEvent(sessionId, message);
        return { llmContent: 'done', returnDisplay: 'done' };
      },
    }),
  } as unknown as AnyDeclarativeTool;
  const agentContext = {
    config,
    promptId: config.promptId,
    toolCallSnapshots: config.toolCallSnapshots,
    toolRegistry: {
      getTool: () => tool,
      getKnownTool: () => undefined,
      getAllToolNames: () => [tool.name],
    },
  } as unknown as AgentLoopContext;
  const context = {
    agentContext,
    toolUseContext: { signal, sessionId },
    signal,
    sessionId,
    responseId: 'response',
    promptId: 'prompt',
  };
  try {
    const pending = ['first', 'second'].map((label) =>
      executor.execute(
        { type: 'tool_use', id: label, name: tool.name, input: { label } },
        context,
      ),
    );
    const events = [];
    for await (const event of executor.waitForExecutions(context))
      events.push(event);
    const results = await Promise.all(pending);
    expect(results.every((result) => !result.block.is_error)).toBe(true);
    expect(observed).toEqual(
      new Map([
        ['first', 'first'],
        ['second', 'second'],
      ]),
    );
    expect(
      events
        .map((event) =>
          'parent_tool_use_id' in event ? event.parent_tool_use_id : undefined,
        )
        .sort(),
    ).toEqual(['first', 'second']);
    expect(getToolCallContext()).toBeUndefined();
  } finally {
    executor.dispose();
    disposeSessionEventQueue(sessionId);
    await config.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

import { sessionStatsService, ToolCallDecision } from '../../services/session-stats.js';
import { ToolConfirmationOutcome } from '../../tools/tools.js';
import type { CompletedToolCall } from '../types.js';

function scopeFor(overrides: Record<string, unknown>): string {
  return resolveToolCallScopeId({
    promptId: 'session-1',
    config: { promptId: 'session-1' },
    ...overrides,
  } as unknown as AgentLoopContext);
}

describe('resolveToolCallScopeId', () => {
  it('keeps the main session on the root scope', () => {
    expect(scopeFor({})).toBe(ROOT_TOOL_CALL_SCOPE_ID);
  });

  it('scopes an internal fork by its own prompt id', () => {
    expect(scopeFor({ promptId: 'auto-dream-abcd' })).toBe('auto-dream-abcd');
  });

  it('keeps subagent isolation in the prompt/agent key', () => {
    expect(scopeFor({ promptId: 'turn-1', agentId: 'agent-1' })).toBe(
      'turn-1:agent-1',
    );
  });

  it('treats a missing context as root', () => {
    expect(resolveToolCallScopeId()).toBe(ROOT_TOOL_CALL_SCOPE_ID);
  });
});

function makeCompletedCall(
  overrides: Record<string, unknown> = {},
): CompletedToolCall {
  return {
    status: CoreToolCallStatus.Success,
    durationMs: 42,
    tool: { name: 'read_file' },
    request: { name: 'read_file', args: {}, callId: 'call-1', prompt_id: 'p-1' },
    response: { diffStat: undefined },
    ...overrides,
  } as unknown as CompletedToolCall;
}

describe('recordToolCallStats', () => {
  it('keeps tool counts, duration and decisions in local session stats', () => {
    sessionStatsService.clear('tool-stats-test');

    recordToolCallStats(
      // Native calls are keyed by the requested name, not the tool instance.
      makeCompletedCall({
        tool: { name: 'ReadFile' },
        outcome: ToolConfirmationOutcome.ProceedOnce,
      }),
    );

    const stats = sessionStatsService.getStats();
    expect(stats.tools.totalCalls).toBe(1);
    expect(stats.tools.totalSuccess).toBe(1);
    expect(stats.tools.totalFail).toBe(0);
    expect(stats.tools.totalDurationMs).toBe(42);
    expect(stats.tools.byName['read_file']).toMatchObject({ count: 1, success: 1 });
    expect(stats.tools.byName['ReadFile']).toBeUndefined();
    expect(stats.tools.totalDecisions[ToolCallDecision.ACCEPT]).toBe(1);
  });

  it('records successful file line deltas', () => {
    sessionStatsService.clear('tool-stats-test');

    recordToolCallStats(
      makeCompletedCall({
        tool: { name: 'edit' },
        request: { name: 'edit', args: {}, callId: 'call-2', prompt_id: 'p-1' },
        response: {
          diffStat: { model_added_lines: 3, model_removed_lines: 1 },
        },
      }),
    );

    const stats = sessionStatsService.getStats();
    expect(stats.tools.totalSuccess).toBe(1);
    expect(stats.tools.byName['edit']).toMatchObject({ count: 1, success: 1 });
    expect(stats.files.totalLinesAdded).toBe(3);
    expect(stats.files.totalLinesRemoved).toBe(1);
  });

  it('records failed calls without counting their line deltas', () => {
    sessionStatsService.clear('tool-stats-test');

    recordToolCallStats(
      makeCompletedCall({
        status: CoreToolCallStatus.Error,
        tool: { name: 'edit' },
        request: { name: 'edit', args: {}, callId: 'call-3', prompt_id: 'p-1' },
        response: {
          diffStat: { model_added_lines: 3, model_removed_lines: 1 },
        },
      }),
    );

    const stats = sessionStatsService.getStats();
    expect(stats.tools.totalFail).toBe(1);
    expect(stats.tools.byName['edit']).toMatchObject({ count: 1, fail: 1 });
    expect(stats.files.totalLinesAdded).toBe(0);
    expect(stats.files.totalLinesRemoved).toBe(0);
  });
});
