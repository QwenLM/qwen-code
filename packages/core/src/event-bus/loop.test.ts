/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Part } from '@google/genai';
import {
  runAgentLoop,
  type AgentLoopOptions,
  type AgentLoopToolExecutor,
  type AgentLoopHost,
} from '../core/agent-loop.js';
import { SendMessageType } from '../core/client.js';
import {
  LlmEventType,
  type ServerLlmStreamEvent,
  type ToolCallRequestInfo,
  type ToolCallResponseInfo,
  type Turn,
} from '../core/turn.js';
import type { Config } from '../config/config.js';
import type { LlmClient } from '../core/client.js';

// The finalizer is a shared dependency of both loop paths; stubbing it here
// keeps the two paths identical while avoiding its telemetry/config surface.
vi.mock('../tools/tool-response-finalizer.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    finalizeToolResponses: async (
      _config: unknown,
      entries: Array<{
        responseParts: Part[];
        persistedOutputFiles?: string[];
        artifacts?: unknown[];
      }>,
    ) =>
      entries.map((entry) => ({
        responseParts: entry.responseParts,
        persistedOutputFiles: entry.persistedOutputFiles,
        artifacts: entry.artifacts,
      })),
  };
});

function call(id: string): ToolCallRequestInfo {
  return {
    callId: id,
    name: 'read_file',
    args: {},
    isClientInitiated: false,
    prompt_id: 'p0',
  };
}

function response(
  request: ToolCallRequestInfo,
  terminateTurn?: boolean,
): ToolCallResponseInfo {
  return {
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
    ...(terminateTurn ? { terminateTurn } : {}),
  };
}

function makeClient(rounds: ServerLlmStreamEvent[][]): LlmClient {
  let index = 0;
  return {
    async *sendMessageStream() {
      const events = rounds[index++] ?? [];
      for (const event of events) yield event;
      return {} as Turn;
    },
    getHistoryToolCallFingerprints: () => [],
    recordCompletedToolCall: () => {},
  } as unknown as LlmClient;
}

function makeExecutor(terminateTurn?: boolean): AgentLoopToolExecutor {
  return {
    run: async (requests, _signal, hooks) =>
      requests.map((request) => {
        hooks.beforeLaunch(request, []);
        return {
          request,
          response: response(request, terminateTurn),
          status: 'success' as const,
          recorded: true,
        };
      }),
  };
}

interface HostFixture {
  host: AgentLoopHost;
  log: string[];
}

function makeHost(
  endOnResult = false,
  nextRound?: AgentLoopHost['nextRound'],
): HostFixture {
  const log: string[] = [];
  const host: AgentLoopHost = {
    onRoundStart: (round, promptId) => log.push(`start:${round}:${promptId}`),
    onModelEvent: (event, discarded) => {
      log.push(`model:${event.type}:${discarded.length}`);
    },
    onRoundEnd: (round) => log.push(`end:${round}`),
    onToolResult: (result) => {
      log.push(`tool:${result.request.callId}:${result.origin}`);
      return endOnResult;
    },
    ...(nextRound ? { nextRound } : {}),
  };
  return { host, log };
}

const config = {
  getChatRecordingService: () => undefined,
} as unknown as Config;
const signal = new AbortController().signal;

function options(
  rounds: ServerLlmStreamEvent[][],
  host: AgentLoopHost,
  extra: Partial<AgentLoopOptions> = {},
): AgentLoopOptions {
  return {
    client: makeClient(rounds),
    config,
    signal,
    first: {
      parts: 'hi',
      promptId: 'p0',
      options: { type: SendMessageType.UserQuery },
    },
    host,
    executor: makeExecutor(),
    ...extra,
  };
}

async function bothPaths(
  rounds: ServerLlmStreamEvent[][],
  extra: Partial<AgentLoopOptions> = {},
  endOnResult = false,
) {
  const procedural = makeHost(endOnResult);
  const bus = makeHost(endOnResult);
  const proceduralResult = await runAgentLoop(
    options(rounds, procedural.host, extra),
  );
  const busResult = await runAgentLoop({
    ...options(rounds, bus.host, extra),
    useEventBus: true,
  });
  return { proceduralResult, busResult, procedural, bus };
}

const content: ServerLlmStreamEvent = {
  type: LlmEventType.Content,
  value: 'hello',
} as ServerLlmStreamEvent;

describe('runAgentLoop event-bus parity', () => {
  it('matches on a completed round with no tools', async () => {
    const { proceduralResult, busResult, procedural, bus } = await bothPaths([
      [content],
    ]);
    expect(busResult).toEqual(proceduralResult);
    expect(busResult.reason).toBe('completed');
    expect(bus.log).toEqual(procedural.log);
    expect(bus.log).toEqual(['start:0:p0', 'model:content:0', 'end:0']);
  });

  it('matches on a terminal stop event', async () => {
    const stop = {
      type: LlmEventType.MaxSessionTurns,
    } as ServerLlmStreamEvent;
    const { proceduralResult, busResult, procedural, bus } = await bothPaths([
      [stop],
    ]);
    expect(busResult).toEqual(proceduralResult);
    expect(busResult.reason).toBe('max_session_turns');
    expect(bus.log).toEqual(procedural.log);
  });

  it('matches on a tool loop that then completes', async () => {
    const toolCall = {
      type: LlmEventType.ToolCallRequest,
      value: call('c1'),
    } as ServerLlmStreamEvent;
    const { proceduralResult, busResult, procedural, bus } = await bothPaths([
      [toolCall],
      [content],
    ]);
    expect(busResult).toEqual(proceduralResult);
    expect(busResult.reason).toBe('completed');
    expect(busResult.rounds).toBe(2);
    expect(bus.log).toEqual(procedural.log);
    expect(bus.log).toContain('tool:c1:executed');
    // onRoundEnd of round 0 precedes the tool result, as in the procedural loop.
    expect(bus.log.indexOf('end:0')).toBeLessThan(
      bus.log.indexOf('tool:c1:executed'),
    );
  });

  it('matches when maxRounds stops after a tool batch', async () => {
    const toolCall = {
      type: LlmEventType.ToolCallRequest,
      value: call('c1'),
    } as ServerLlmStreamEvent;
    const { proceduralResult, busResult, procedural, bus } = await bothPaths(
      [[toolCall]],
      { maxRounds: 1 },
    );
    expect(busResult).toEqual(proceduralResult);
    expect(busResult.reason).toBe('next_round');
    expect(bus.log).toEqual(procedural.log);
  });

  it('matches when a tool result ends the turn', async () => {
    const toolCall = {
      type: LlmEventType.ToolCallRequest,
      value: call('c1'),
    } as ServerLlmStreamEvent;
    const { proceduralResult, busResult, procedural, bus } = await bothPaths(
      [[toolCall]],
      { executor: makeExecutor(true) },
    );
    expect(busResult).toEqual(proceduralResult);
    expect(busResult.reason).toBe('tool_ended_turn');
    expect(bus.log).toEqual(procedural.log);
  });

  it('matches when a surface callback ends the loop', async () => {
    const toolCall = {
      type: LlmEventType.ToolCallRequest,
      value: call('c1'),
    } as ServerLlmStreamEvent;
    const { proceduralResult, busResult, procedural, bus } = await bothPaths(
      [[toolCall]],
      {},
      true,
    );
    expect(busResult).toEqual(proceduralResult);
    expect(busResult.reason).toBe('surface_ended');
    expect(bus.log).toEqual(procedural.log);
  });

  it('matches when the signal is already aborted', async () => {
    const toolCall = {
      type: LlmEventType.ToolCallRequest,
      value: call('c1'),
    } as ServerLlmStreamEvent;
    const aborted = new AbortController();
    aborted.abort();
    const { proceduralResult, busResult, procedural, bus } = await bothPaths(
      [[toolCall]],
      { signal: aborted.signal },
    );
    expect(busResult).toEqual(proceduralResult);
    expect(busResult.reason).toBe('cancelled');
    expect(bus.log).toEqual(procedural.log);
  });

  it('rejects identically when a host callback throws', async () => {
    const rounds = [[content]];
    const throwingHost = (): AgentLoopHost => ({
      onModelEvent: () => {
        throw new Error('boom');
      },
    });
    const procedural = runAgentLoop(options(rounds, throwingHost()));
    const bus = runAgentLoop({
      ...options(rounds, throwingHost()),
      useEventBus: true,
    });
    await expect(procedural).rejects.toThrow('boom');
    await expect(bus).rejects.toThrow('boom');
  });

  async function expectSameRejection(value: unknown): Promise<void> {
    const rounds = [[content]];
    const throwingHost = (): AgentLoopHost => ({
      onModelEvent: () => {
        throw value;
      },
    });
    const procedural = runAgentLoop(options(rounds, throwingHost()));
    const bus = runAgentLoop({
      ...options(rounds, throwingHost()),
      useEventBus: true,
    });
    await expect(procedural).rejects.toBe(value);
    await expect(bus).rejects.toBe(value);
  }

  it('rejects with the original structured error value', async () => {
    await expectSameRejection({ code: 'E_LIMIT', message: 'quota' });
  });

  it('rejects with a null-prototype value without hanging', async () => {
    await expectSameRejection(Object.create(null));
  });

  it('matches when the host supplies the next round', async () => {
    const toolCall = {
      type: LlmEventType.ToolCallRequest,
      value: call('c1'),
    } as ServerLlmStreamEvent;
    const rounds = [[toolCall], [content]];
    const nextRound: AgentLoopHost['nextRound'] = () => ({
      parts: 'custom',
      promptId: 'custom-prompt',
      options: { type: SendMessageType.ToolResult },
    });
    const procedural = makeHost(false, nextRound);
    const bus = makeHost(false, nextRound);
    const proceduralResult = await runAgentLoop(
      options(rounds, procedural.host),
    );
    const busResult = await runAgentLoop({
      ...options(rounds, bus.host),
      useEventBus: true,
    });
    expect(busResult).toEqual(proceduralResult);
    expect(bus.log).toEqual(procedural.log);
    expect(bus.log).toContain('start:1:custom-prompt');
  });

  it('matches on a batch with multiple tool calls', async () => {
    const tc1 = {
      type: LlmEventType.ToolCallRequest,
      value: call('c1'),
    } as ServerLlmStreamEvent;
    const tc2 = {
      type: LlmEventType.ToolCallRequest,
      value: call('c2'),
    } as ServerLlmStreamEvent;
    const { proceduralResult, busResult, procedural, bus } = await bothPaths([
      [tc1, tc2],
      [content],
    ]);
    expect(busResult).toEqual(proceduralResult);
    expect(busResult.reason).toBe('completed');
    expect(bus.log).toEqual(procedural.log);
    expect(bus.log).toContain('tool:c1:executed');
    expect(bus.log).toContain('tool:c2:executed');
  });

  it('matches with the default executor and duplicates when no tools run', async () => {
    const rounds = [[content]];
    const procedural = makeHost();
    const bus = makeHost();
    const proceduralOptions = options(rounds, procedural.host);
    delete proceduralOptions.executor;
    const busOptions = { ...options(rounds, bus.host), useEventBus: true };
    delete busOptions.executor;
    const proceduralResult = await runAgentLoop(proceduralOptions);
    const busResult = await runAgentLoop(busOptions);
    expect(busResult).toEqual(proceduralResult);
    expect(busResult.reason).toBe('completed');
    expect(bus.log).toEqual(procedural.log);
  });
});
