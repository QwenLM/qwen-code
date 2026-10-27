/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Part, PartListUnion } from '@google/genai';
import { ApprovalMode } from '../config/approval-mode.js';
import type { Config } from '../config/config.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ExecTool } from '../tools/exec.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { Kind } from '../tools/tools.js';
import {
  createSchedulerExecutor,
  runAgentLoop,
  runToolBatch,
  type AgentLoopDuplicateState,
  type AgentLoopHost,
  type AgentLoopSettledCall,
  type AgentLoopToolExecutor,
  type AgentLoopToolResult,
} from './agent-loop.js';
import { SendMessageType } from './client.js';
import { PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE } from './plan-mode-entry-policy.js';
import type { LlmClient, SendMessageOptions } from './client.js';
import {
  getCachedToolCallFingerprint,
  recordHandledToolCall,
} from './toolCallIdUtils.js';
import {
  LlmEventType,
  type ServerLlmStreamEvent,
  type ToolCallRequestInfo,
  type ToolCallResponseInfo,
  type Turn,
} from './turn.js';

function toolRequest(
  callId: string,
  name = 'read_file',
  args: Record<string, unknown> = {},
): ToolCallRequestInfo {
  return {
    callId,
    providerCallId: callId,
    name,
    args,
    isClientInitiated: false,
    prompt_id: 'prompt-1',
  };
}

function requestEvent(request: ToolCallRequestInfo): ServerLlmStreamEvent {
  return { type: LlmEventType.ToolCallRequest, value: request };
}

const content: ServerLlmStreamEvent = {
  type: LlmEventType.Content,
  value: 'hello',
};

function okResponse(
  request: ToolCallRequestInfo,
  extra: Partial<ToolCallResponseInfo> = {},
): ToolCallResponseInfo {
  return {
    callId: request.callId,
    responseParts: [
      {
        functionResponse: {
          id: request.callId,
          name: request.name,
          response: { output: `ran ${request.callId}` },
        },
      },
    ],
    resultDisplay: `ran ${request.callId}`,
    error: undefined,
    errorType: undefined,
    ...extra,
  };
}

/** A client whose Nth send streams `rounds[N]`. */
function fakeClient(rounds: ServerLlmStreamEvent[][]) {
  const sends: Array<{
    parts: PartListUnion;
    promptId: string;
    options: SendMessageOptions;
    signal: AbortSignal;
  }> = [];
  let closedEarly = 0;
  const client = {
    sendMessageStream: vi.fn(
      (
        parts: PartListUnion,
        signal: AbortSignal,
        promptId: string,
        options: SendMessageOptions,
      ) => {
        const events = rounds[sends.length] ?? [];
        sends.push({ parts, promptId, options, signal });
        return (async function* () {
          let done = false;
          try {
            for (const event of events) yield event;
            done = true;
            return { pendingToolCalls: [] } as unknown as Turn;
          } finally {
            if (!done) closedEarly++;
          }
        })();
      },
    ),
    getHistoryToolCallFingerprints: vi.fn(() => new Map<string, string>()),
    recordCompletedToolCall: vi.fn(),
  };
  return {
    client: client as unknown as LlmClient,
    sends,
    raw: client,
    closedEarly: () => closedEarly,
  };
}

/** Runs every launched call successfully, in order. */
function fakeExecutor(
  respond: (request: ToolCallRequestInfo) => ToolCallResponseInfo = (r) =>
    okResponse(r),
  onRun?: () => void,
) {
  const batches: ToolCallRequestInfo[][] = [];
  const signals: AbortSignal[] = [];
  const executor: AgentLoopToolExecutor = {
    async run(requests, signal, hooks) {
      batches.push(requests);
      signals.push(signal);
      onRun?.();
      const settled: AgentLoopSettledCall[] = [];
      for (const request of requests) {
        if (!hooks.beforeLaunch(request, settled)) continue;
        settled.push({
          status: 'success',
          request,
          response: respond(request),
        });
      }
      return settled;
    },
  };
  return { executor, batches, signals };
}

function fakeConfig() {
  const recordToolResult = vi.fn();
  const config = {
    getChatRecordingService: () => ({ recordToolResult }),
    getSessionId: () => 'session-1',
    getToolOutputBatchBudget: () => undefined,
  } as unknown as Config;
  return { config, recordToolResult };
}

function first(parts: PartListUnion = [{ text: 'go' }]) {
  return {
    parts,
    promptId: 'prompt-1',
    options: { type: SendMessageType.UserQuery },
  };
}

function ids(parts: PartListUnion | undefined): Array<string | undefined> {
  return (parts as Part[]).map((part) => part.functionResponse?.id);
}

describe('runAgentLoop', () => {
  it('stops when the model calls no tools, forwarding every event', async () => {
    const finished: ServerLlmStreamEvent = {
      type: LlmEventType.Finished,
      value: { reason: undefined, usageMetadata: undefined },
    };
    const { client } = fakeClient([[content, finished]]);
    const { executor, batches } = fakeExecutor();
    const seen: ServerLlmStreamEvent[] = [];
    const host: AgentLoopHost = {
      onRoundStart: vi.fn(),
      onRoundEnd: vi.fn(),
      onModelEvent: (event) => {
        seen.push(event);
      },
    };

    const result = await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal: new AbortController().signal,
      first: first(),
      executor,
      host,
    });

    expect(result.reason).toBe('completed');
    expect(result.rounds).toBe(1);
    expect(seen).toEqual([content, finished]);
    expect(host.onRoundStart).toHaveBeenCalledWith(0, 'prompt-1');
    expect(host.onRoundEnd).toHaveBeenCalledOnce();
    expect(batches).toEqual([]);
  });

  it('runs a batch, records it and sends its results as the next round', async () => {
    const read = toolRequest('call-1');
    const { client, sends, raw } = fakeClient([
      [requestEvent(read)],
      [content],
    ]);
    const { executor, batches } = fakeExecutor();
    const { config, recordToolResult } = fakeConfig();

    const result = await runAgentLoop({
      client,
      config,
      signal: new AbortController().signal,
      first: first(),
      executor,
    });

    expect(result).toMatchObject({ reason: 'completed', rounds: 2 });
    expect(batches).toEqual([[read]]);
    expect(sends[1].options).toEqual({ type: SendMessageType.ToolResult });
    expect(ids(sends[1].parts)).toEqual(['call-1']);
    expect(recordToolResult).toHaveBeenCalledOnce();
    expect(recordToolResult.mock.calls[0][1]).toMatchObject({
      callId: 'call-1',
      status: 'success',
    });
    expect(raw.recordCompletedToolCall).toHaveBeenCalledWith('read_file', {});
  });

  it('drops the calls of an attempt that a retry replaced', async () => {
    const stale = toolRequest('stale');
    const fresh = toolRequest('fresh');
    const { client } = fakeClient([
      [requestEvent(stale), { type: LlmEventType.Retry }, requestEvent(fresh)],
      [content],
    ]);
    const { executor, batches } = fakeExecutor();
    const discarded: Array<readonly ToolCallRequestInfo[]> = [];

    await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal: new AbortController().signal,
      first: first(),
      executor,
      host: {
        onModelEvent: (event, calls) => {
          if (event.type === LlmEventType.Retry) discarded.push(calls);
        },
      },
    });

    expect(discarded).toEqual([[stale]]);
    expect(batches).toEqual([[fresh]]);
  });

  it.each([
    [LlmEventType.LoopDetected, 'loop_detected'],
    [LlmEventType.MaxSessionTurns, 'max_session_turns'],
    [LlmEventType.SessionTokenLimitExceeded, 'session_token_limit'],
    [LlmEventType.UserPromptSubmitBlocked, 'user_prompt_blocked'],
  ] as const)('stops on %s without running tools', async (type, reason) => {
    const { client } = fakeClient([
      [
        requestEvent(toolRequest('call-1')),
        { type, value: {} } as unknown as ServerLlmStreamEvent,
      ],
    ]);
    const { executor, batches } = fakeExecutor();

    const result = await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal: new AbortController().signal,
      first: first(),
      executor,
    });

    expect(result.reason).toBe(reason);
    expect(batches).toEqual([]);
  });

  it('stops on UserCancelled without running tools once its signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = fakeClient([
      [
        requestEvent(toolRequest('call-1')),
        { type: LlmEventType.UserCancelled } as ServerLlmStreamEvent,
      ],
    ]);
    const { executor, batches } = fakeExecutor();

    const result = await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal: controller.signal,
      first: first(),
      executor,
    });

    expect(result.reason).toBe('cancelled');
    expect(batches).toEqual([]);
  });

  it('ends the round as the model left it when only a merged signal cancelled it', async () => {
    // A Goal pause aborts the Goal signal the client merges into the stream's.
    const { client } = fakeClient([
      [
        requestEvent(toolRequest('call-1')),
        { type: LlmEventType.UserCancelled } as ServerLlmStreamEvent,
      ],
      [{ type: LlmEventType.UserCancelled } as ServerLlmStreamEvent],
    ]);
    const { executor, batches } = fakeExecutor();

    const result = await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal: new AbortController().signal,
      first: first(),
      executor,
    });

    expect(result).toMatchObject({ reason: 'completed', rounds: 2 });
    expect(batches.map((batch) => batch.map(({ callId }) => callId))).toEqual([
      ['call-1'],
    ]);
  });

  it('answers a provider replay without running it, and stops when it repeats', async () => {
    const replay = toolRequest('call-1', 'read_file', { path: 'a' });
    const duplicates: AgentLoopDuplicateState = {
      handled: new Map(),
      responded: new Set(),
    };
    recordHandledToolCall(
      duplicates.handled,
      'call-1',
      getCachedToolCallFingerprint(replay, replay.name, replay.args),
    );
    const results: AgentLoopToolResult[] = [];
    const run = (rounds: ServerLlmStreamEvent[][]) => {
      const { client } = fakeClient(rounds);
      const { executor, batches } = fakeExecutor();
      return {
        batches,
        done: runAgentLoop({
          client,
          config: fakeConfig().config,
          signal: new AbortController().signal,
          first: first(),
          executor,
          duplicates,
          maxRounds: 1,
          host: { onToolResult: (result) => void results.push(result) },
        }),
      };
    };

    const once = run([[requestEvent(replay)]]);
    expect(await once.done).toMatchObject({ reason: 'next_round' });
    expect(once.batches).toEqual([]);
    expect(results.map((r) => r.origin)).toEqual(['replayed']);

    const twice = run([[requestEvent({ ...replay })]]);
    expect(await twice.done).toMatchObject({
      reason: 'duplicate_provider_call',
      parts: [],
    });
  });

  it('answers a repeated call id once, after the executed calls', async () => {
    const call = toolRequest('call-1');
    const again = { ...call };
    const { client, sends } = fakeClient([
      [requestEvent(call), requestEvent(again)],
      [content],
    ]);
    const { executor, batches } = fakeExecutor();
    const origins: string[] = [];

    await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal: new AbortController().signal,
      first: first(),
      executor,
      host: { onToolResult: (result) => void origins.push(result.origin) },
    });

    expect(batches).toEqual([[call]]);
    expect(origins).toEqual(['executed', 'duplicate']);
    expect(ids(sends[1].parts)).toEqual(['call-1', 'call-1']);
  });

  it('returns the pending results when maxRounds is reached', async () => {
    const { client, sends } = fakeClient([[requestEvent(toolRequest('c1'))]]);
    const { executor } = fakeExecutor();

    const result = await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal: new AbortController().signal,
      first: first(),
      executor,
      maxRounds: 1,
    });

    expect(result.reason).toBe('next_round');
    expect(ids(result.parts)).toEqual(['c1']);
    expect(sends).toHaveLength(1);
  });

  it('builds later rounds with nextRound', async () => {
    const { client, sends } = fakeClient([
      [requestEvent(toolRequest('c1'))],
      [content],
    ]);
    const { executor } = fakeExecutor();
    const extra: Part = { text: 'from a teammate' };

    await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal: new AbortController().signal,
      first: first(),
      executor,
      host: {
        nextRound: (round, parts) => ({
          parts: [...parts, extra],
          promptId: `prompt-${round}`,
          options: { type: SendMessageType.Teammate },
        }),
      },
    });

    expect(sends[1].promptId).toBe('prompt-1');
    expect(sends[1].options.type).toBe(SendMessageType.Teammate);
    expect((sends[1].parts as Part[]).at(-1)).toBe(extra);
  });

  it('gives the calls the surface does not run the skipped output', async () => {
    const keep = toolRequest('keep', 'structured_output');
    const drop = toolRequest('drop');
    const { client, sends } = fakeClient([
      [requestEvent(drop), requestEvent(keep)],
      [content],
    ]);
    const { executor, batches } = fakeExecutor();
    const results: AgentLoopToolResult[] = [];

    await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal: new AbortController().signal,
      first: first(),
      executor,
      host: {
        selectCalls: (executable) =>
          executable.filter((r) => r.name === 'structured_output'),
        skippedOutput: () => 'Skipped.',
        onToolResult: (result) => void results.push(result),
      },
    });

    expect(batches).toEqual([[keep]]);
    expect(results.map((r) => [r.request.callId, r.origin])).toEqual([
      ['keep', 'executed'],
      ['drop', 'skipped'],
    ]);
    expect(results[1].response.resultDisplay).toBe('Skipped.');
    expect(ids(sends[1].parts)).toEqual(['drop', 'keep']);
  });

  it('leaves a call the launch hook refuses unexecuted', async () => {
    const one = toolRequest('one');
    const two = toolRequest('two');
    const { client } = fakeClient([
      [requestEvent(one), requestEvent(two)],
      [content],
    ]);
    const { executor } = fakeExecutor();
    const seenSettled: string[][] = [];
    const results: AgentLoopToolResult[] = [];

    await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal: new AbortController().signal,
      first: first(),
      executor,
      host: {
        beforeToolLaunch: (request, settled) => {
          seenSettled.push(settled.map((c) => c.request.callId));
          return request.callId !== 'two';
        },
        onToolResult: (result) => void results.push(result),
      },
    });

    expect(seenSettled).toEqual([[], ['one']]);
    expect(results.map((r) => [r.request.callId, r.origin])).toEqual([
      ['one', 'executed'],
      ['two', 'skipped'],
    ]);
  });

  it('offers a call the scheduler settled without launching it at its turn', async () => {
    const bad = toolRequest('bad');
    const one = toolRequest('one');
    const last = toolRequest('last');
    const { client } = fakeClient([
      [requestEvent(bad), requestEvent(one), requestEvent(last)],
      [content],
    ]);
    const rejected = (request: ToolCallRequestInfo): AgentLoopSettledCall => ({
      status: 'error',
      request,
      response: okResponse(request, { error: new Error('Invalid params.') }),
    });
    // The scheduler rejects `bad` and `last` and launches only `one`.
    const executor: AgentLoopToolExecutor = {
      async run(_requests, _signal, hooks) {
        const settled = [rejected(bad), rejected(last)];
        if (hooks.beforeLaunch(one, settled)) {
          settled.push({
            status: 'success',
            request: one,
            response: okResponse(one),
          });
        }
        return settled;
      },
    };
    const offered: string[] = [];
    const results: AgentLoopToolResult[] = [];

    await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal: new AbortController().signal,
      first: first(),
      executor,
      host: {
        beforeToolLaunch: (request) => {
          offered.push(request.callId);
          return request.callId !== 'last';
        },
        onToolResult: (result) => void results.push(result),
      },
    });

    expect(offered).toEqual(['bad', 'one', 'last']);
    expect(results.map((r) => [r.request.callId, r.origin])).toEqual([
      ['bad', 'executed'],
      ['one', 'executed'],
      ['last', 'skipped'],
    ]);
  });

  it('does not record the skipped siblings of a plan-mode entry as completed calls', async () => {
    const write = toolRequest('write', 'write_file');
    const enter = toolRequest('enter', 'enter_plan_mode');
    const { client, raw } = fakeClient([
      [requestEvent(write), requestEvent(enter)],
      [content],
    ]);
    const { executor } = fakeExecutor((request) =>
      request.callId === 'write'
        ? okResponse(request, {
            error: new Error(PLAN_MODE_ENTRY_SIBLING_SKIP_MESSAGE),
            executionStatus: 'not_started',
          })
        : okResponse(request),
    );

    await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal: new AbortController().signal,
      first: first(),
      executor,
    });

    expect(raw.recordCompletedToolCall.mock.calls).toEqual([
      ['enter_plan_mode', {}],
    ]);
  });

  it('stops on terminateTurn unless the surface keeps going', async () => {
    const respond = (r: ToolCallRequestInfo) =>
      okResponse(r, { terminateTurn: true });
    const stops = async (endsOnTerminateTurn: boolean) => {
      const { client } = fakeClient([
        [requestEvent(toolRequest('c1'))],
        [content],
      ]);
      return runAgentLoop({
        client,
        config: fakeConfig().config,
        signal: new AbortController().signal,
        first: first(),
        executor: fakeExecutor(respond).executor,
        host: { endsOnTerminateTurn: () => endsOnTerminateTurn },
      });
    };

    const ended = await stops(true);
    expect(ended.reason).toBe('tool_ended_turn');
    expect(ids(ended.parts)).toEqual(['c1']);
    expect((await stops(false)).reason).toBe('completed');
  });

  it('ends after the batch when a result callback asks', async () => {
    const { client, sends } = fakeClient([[requestEvent(toolRequest('c1'))]]);
    const { config, recordToolResult } = fakeConfig();

    const result = await runAgentLoop({
      client,
      config,
      signal: new AbortController().signal,
      first: first(),
      executor: fakeExecutor().executor,
      host: { onToolResult: () => true },
    });

    expect(result.reason).toBe('surface_ended');
    expect(recordToolResult).toHaveBeenCalledOnce();
    expect(sends).toHaveLength(1);
  });

  it('reports what ran but sends and records nothing after an abort', async () => {
    const controller = new AbortController();
    const { client, sends } = fakeClient([[requestEvent(toolRequest('c1'))]]);
    const { config, recordToolResult } = fakeConfig();
    const results: AgentLoopToolResult[] = [];

    const result = await runAgentLoop({
      client,
      config,
      signal: controller.signal,
      first: first(),
      executor: fakeExecutor(undefined, () => controller.abort()).executor,
      host: { onToolResult: (r) => void results.push(r) },
    });

    expect(result).toMatchObject({ reason: 'cancelled', parts: [] });
    expect(results.map((r) => r.request.callId)).toEqual(['c1']);
    expect(recordToolResult).not.toHaveBeenCalled();
    expect(sends).toHaveLength(1);
  });

  it('after an abort, reports only the calls the surface let launch', async () => {
    const controller = new AbortController();
    const one = toolRequest('one');
    const two = toolRequest('two');
    const { client } = fakeClient([[requestEvent(one), requestEvent(two)]]);
    // Both calls are asked about before either starts; the abort then
    // cancels the one that was let through before it runs.
    const executor: AgentLoopToolExecutor = {
      async run(requests, _signal, hooks) {
        for (const request of requests) hooks.beforeLaunch(request, []);
        return requests.map((request) => ({
          status: 'cancelled' as const,
          request,
          response: okResponse(request, {
            error: new Error('Tool call cancelled before execution.'),
            executionStatus: 'not_started',
          }),
        }));
      },
    };
    const results: AgentLoopToolResult[] = [];

    const result = await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal: controller.signal,
      first: first(),
      executor,
      host: {
        beforeToolLaunch: (request) => {
          if (request.callId === 'two') controller.abort();
          return !controller.signal.aborted;
        },
        onToolResult: (r) => void results.push(r),
      },
    });

    expect(result.reason).toBe('cancelled');
    expect(results.map((r) => [r.request.callId, r.status])).toEqual([
      ['one', 'cancelled'],
    ]);
  });

  it('keeps a batch a result ended when an abort lands after it', async () => {
    const controller = new AbortController();
    const { client } = fakeClient([[requestEvent(toolRequest('c1'))]]);
    const { config, recordToolResult } = fakeConfig();

    const result = await runAgentLoop({
      client,
      config,
      signal: controller.signal,
      first: first(),
      executor: fakeExecutor(undefined, () => controller.abort()).executor,
      host: { onToolResult: () => true },
    });

    expect(result).toMatchObject({ reason: 'surface_ended' });
    expect(ids(result.parts)).toEqual(['c1']);
    expect(recordToolResult).toHaveBeenCalledOnce();
  });

  it('closes the model stream when the surface throws', async () => {
    const fake = fakeClient([[content, content]]);

    await expect(
      runAgentLoop({
        client: fake.client,
        config: fakeConfig().config,
        signal: new AbortController().signal,
        first: first(),
        executor: fakeExecutor().executor,
        host: {
          onModelEvent: () => {
            throw new Error('stop here');
          },
        },
      }),
    ).rejects.toThrow('stop here');
    expect(fake.closedEarly()).toBe(1);
  });

  it('runs tools under toolSignal and model rounds under signal', async () => {
    const signal = new AbortController().signal;
    const toolSignal = new AbortController().signal;
    const { client, sends } = fakeClient([
      [requestEvent(toolRequest('c1'))],
      [content],
    ]);
    const { executor, signals } = fakeExecutor();

    await runAgentLoop({
      client,
      config: fakeConfig().config,
      signal,
      toolSignal,
      first: first(),
      executor,
    });

    expect(sends.map((s) => s.signal)).toEqual([signal, signal]);
    expect(signals).toEqual([toolSignal]);
  });
});

describe('runToolBatch', () => {
  const duplicates = (): AgentLoopDuplicateState => ({
    handled: new Map(),
    responded: new Set(),
  });

  it('finishes and records a cancelled batch for a surface that keeps it', async () => {
    const controller = new AbortController();
    const { client } = fakeClient([]);
    const { config, recordToolResult } = fakeConfig();

    const result = await runToolBatch([toolRequest('c1')], {
      config,
      client,
      signal: controller.signal,
      duplicates: duplicates(),
      executor: fakeExecutor(undefined, () => controller.abort()).executor,
      keepCancelledResults: true,
    });

    expect(result.stop).toBe('cancelled');
    expect(ids(result.parts)).toEqual(['c1']);
    expect(recordToolResult).toHaveBeenCalledTimes(1);
  });

  it('runs one batch with the scheduler executor a surface passes', async () => {
    const { client } = fakeClient([]);
    const { config } = fakeConfig();
    const { executor, batches } = fakeExecutor();

    const result = await runToolBatch([toolRequest('c1'), toolRequest('c2')], {
      config,
      client,
      signal: new AbortController().signal,
      duplicates: duplicates(),
      executor,
    });

    expect(result.stop).toBeUndefined();
    expect(batches).toHaveLength(1);
    expect(ids(result.parts)).toEqual(['c1', 'c2']);
  });
});

describe('createSchedulerExecutor', () => {
  it('runs the calls an exec script makes, with their output on the exec call', async () => {
    const config = makeFakeConfig({
      codeModeOnly: true,
      approvalMode: ApprovalMode.YOLO,
      chatRecording: false,
      targetDir: '/tmp',
      cwd: '/tmp',
    });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    registry.registerTool(new ExecTool(config));
    registry.registerTool(
      new MockTool({
        name: 'read_probe',
        kind: Kind.Read,
        params: { type: 'object', additionalProperties: false },
        canUpdateOutput: true,
        execute: async (_params, _signal, updateOutput) => {
          updateOutput?.('probing');
          return { llmContent: 'probe output', returnDisplay: 'probe output' };
        },
      }),
    );
    const asked: string[] = [];
    const outputs: Array<[string, unknown]> = [];

    const completed = await createSchedulerExecutor(config).run(
      [
        toolRequest('exec-1', 'exec', {
          source: 'const r = await tools.read_probe({}); text(r.output);',
        }),
      ],
      new AbortController().signal,
      {
        beforeLaunch: (request) => {
          asked.push(request.callId);
          return request.callId === 'exec-1';
        },
        output: (callId, chunk) => void outputs.push([callId, chunk]),
      },
    );

    expect(asked).toEqual(['exec-1']);
    expect(completed.map((call) => call.status)).toEqual(['success']);
    expect(JSON.stringify(completed[0].response.responseParts)).toContain(
      'probe output',
    );
    expect(outputs).toContainEqual(['exec-1', 'probing']);
  }, 20_000);
});
