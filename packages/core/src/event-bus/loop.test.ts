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
  type ModelRoundSource,
} from '../core/agent-loop.js';
import * as agentLoop from '../core/agent-loop.js';
import { SendMessageType } from '../core/client.js';
import { LoopEventBus } from './bus.js';
import { CANCEL_SETTLEMENT_CAP_MS } from './conversation.js';
import {
  LlmEventType,
  type ServerLlmStreamEvent,
  type ToolCallRequestInfo,
  type ToolCallResponseInfo,
  type Turn,
} from '../core/turn.js';
import type { Config } from '../config/config.js';
import type { LlmClient } from '../core/client.js';
import type { RuntimeContentGeneratorView } from '../agents/runtime/agent-context.js';

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

function makeClient(
  rounds: ServerLlmStreamEvent[][],
  sink?: unknown[],
): LlmClient {
  let index = 0;
  return {
    async *sendMessageStream(parts: unknown) {
      if (sink) sink.push(parts);
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
    onRoundEnd: (round) => {
      log.push(`end:${round}`);
    },
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

  it('matches when a terminal stop and tool calls share a round (stop wins)', async () => {
    const round = [
      { type: LlmEventType.ToolCallRequest, value: call('c1') },
      { type: LlmEventType.MaxSessionTurns },
    ] as ServerLlmStreamEvent[];
    const { proceduralResult, busResult, procedural, bus } = await bothPaths([
      round,
    ]);
    expect(busResult).toEqual(proceduralResult);
    expect(busResult.reason).toBe('max_session_turns');
    expect(bus.log).toEqual(procedural.log);
    expect(bus.log).not.toContain('tool:c1:executed');
  });

  it('passes a distinct toolSignal through to the executor', async () => {
    const toolCall = {
      type: LlmEventType.ToolCallRequest,
      value: call('c1'),
    } as ServerLlmStreamEvent;
    const toolAbort = new AbortController();
    toolAbort.abort();
    const seen: AbortSignal[] = [];
    const executor: AgentLoopToolExecutor = {
      run: async (requests, signal, hooks) => {
        seen.push(signal);
        return requests.map((request) => {
          hooks.beforeLaunch(request, []);
          return {
            request,
            response: response(request),
            status: 'success' as const,
            recorded: true,
          };
        });
      },
    };
    await runAgentLoop({
      ...options([[toolCall], [content]], makeHost().host, {
        toolSignal: toolAbort.signal,
        executor,
      }),
      useEventBus: true,
    });
    expect(seen[0]).toBe(toolAbort.signal);
  });

  it('records into the caller-supplied duplicates bookkeeping', async () => {
    const toolCall = {
      type: LlmEventType.ToolCallRequest,
      value: call('c1'),
    } as ServerLlmStreamEvent;
    const duplicates = {
      handled: new Map<string, string>(),
      responded: new Set<string>(),
    };
    await runAgentLoop({
      ...options([[toolCall], [content]], makeHost().host, { duplicates }),
      useEventBus: true,
    });
    expect(duplicates.handled.has('c1')).toBe(true);
  });

  it('sends the tool-result parts, not the original prompt, on the continuation round', async () => {
    const toolCall = {
      type: LlmEventType.ToolCallRequest,
      value: call('c1'),
    } as ServerLlmStreamEvent;
    const rounds = [[toolCall], [content]];
    const sink: unknown[] = [];
    await runAgentLoop({
      ...options(rounds, makeHost().host, { client: makeClient(rounds, sink) }),
      useEventBus: true,
    });
    expect(sink).toHaveLength(2);
    expect(sink[0]).toBe('hi');
    expect(sink[1]).not.toBe('hi');
    expect(JSON.stringify(sink[1])).toContain('functionResponse');
  });

  it('rejects, not pending, when a host onToolResult callback throws', async () => {
    const toolCall = {
      type: LlmEventType.ToolCallRequest,
      value: call('c1'),
    } as ServerLlmStreamEvent;
    const throwingHost = (): AgentLoopHost => ({
      onToolResult: () => {
        throw new Error('toolboom');
      },
    });
    const procedural = runAgentLoop(
      options([[toolCall], [content]], throwingHost()),
    );
    const bus = runAgentLoop({
      ...options([[toolCall], [content]], throwingHost()),
      useEventBus: true,
    });
    await expect(procedural).rejects.toThrow('toolboom');
    await expect(bus).rejects.toThrow('toolboom');
  });

  it('matches when onRoundEnd stops the loop before the tool batch', async () => {
    const toolCall = {
      type: LlmEventType.ToolCallRequest,
      value: call('c1'),
    } as ServerLlmStreamEvent;
    const stopping = (): HostFixture => {
      const fixture = makeHost();
      fixture.host.onRoundEnd = (round) => {
        fixture.log.push(`end:${round}`);
        return 'surface_ended';
      };
      return fixture;
    };
    const procedural = stopping();
    const bus = stopping();
    const proceduralResult = await runAgentLoop(
      options([[toolCall]], procedural.host),
    );
    const busResult = await runAgentLoop({
      ...options([[toolCall]], bus.host),
      useEventBus: true,
    });
    expect(busResult).toEqual(proceduralResult);
    expect(busResult.reason).toBe('surface_ended');
    expect(bus.log).toEqual(procedural.log);
    expect(bus.log).not.toContain('tool:c1:executed');
  });

  it("gives onRoundEnd the round's calls and stop on both paths", async () => {
    const rounds = [
      [{ type: LlmEventType.ToolCallRequest, value: call('c1') }],
      [
        { type: LlmEventType.ToolCallRequest, value: call('c2') },
        { type: LlmEventType.MaxSessionTurns },
      ],
    ] as ServerLlmStreamEvent[][];
    const run = async (useEventBus: boolean) => {
      const seen: unknown[] = [];
      const result = await runAgentLoop({
        ...options(rounds, {
          onRoundEnd: (round, model) => {
            seen.push({
              round,
              calls: model.calls.map(({ callId }) => callId),
              stop: model.stop,
            });
          },
        }),
        useEventBus,
      });
      return { seen, reason: result.reason };
    };
    const procedural = await run(false);
    const bus = await run(true);
    expect(bus).toEqual(procedural);
    expect(bus).toEqual({
      seen: [
        { round: 0, calls: ['c1'], stop: undefined },
        { round: 1, calls: ['c2'], stop: 'max_session_turns' },
      ],
      reason: 'max_session_turns',
    });
  });

  it('matches on the batch options and returns each call result', async () => {
    const calls = [call('c1'), call('c2')];
    const round = calls.map((value) => ({
      type: LlmEventType.ToolCallRequest,
      value,
    })) as ServerLlmStreamEvent[];
    const run = async (useEventBus: boolean) => {
      const recorded: string[] = [];
      const abort = new AbortController();
      const isolated = {
        handled: new Map<string, string>(),
        responded: new Set<string>(),
      };
      const shared = {
        handled: new Map<string, string>(),
        responded: new Set<string>(),
      };
      const { host, log } = makeHost();
      const result = await runAgentLoop({
        ...options([round, [content]], host, {
          config: {
            getChatRecordingService: () => ({
              recordToolResult: (
                _parts: Part[],
                { callId }: { callId: string },
              ) => recorded.push(callId),
            }),
          } as unknown as Config,
          signal: abort.signal,
          duplicates: shared,
          duplicateStateForCall: (request) =>
            request.callId === 'c2' ? isolated : shared,
          executor: {
            run: async (requests, _signal, hooks) => {
              abort.abort();
              return requests.map((request) => {
                hooks.beforeLaunch(request, []);
                return {
                  request,
                  response: response(request),
                  status: 'success' as const,
                };
              });
            },
          },
          keepCancelledResults: true,
          deferRecording: true,
        }),
        useEventBus,
      });
      const recordedBefore = [...recorded];
      for (const entry of result.responses ?? []) entry.record?.();
      return {
        reason: result.reason,
        parts: result.parts,
        responses: result.responses?.map(({ callId, parts }) => ({
          callId,
          parts,
        })),
        recordedBefore,
        recorded,
        handled: [...shared.handled.keys(), ...isolated.handled.keys()],
        isolated: [...isolated.handled.keys()],
        log,
      };
    };
    const procedural = await run(false);
    const bus = await run(true);
    expect(bus).toEqual(procedural);
    // The aborted batch keeps its results, unrecorded until the caller records them.
    expect(bus.reason).toBe('cancelled');
    expect(bus.responses?.map(({ callId }) => callId)).toEqual(['c1', 'c2']);
    expect(bus.recordedBefore).toEqual([]);
    expect(bus.recorded).toEqual(['c1', 'c2']);
    expect(bus.isolated).toEqual(['c2']);
  });

  it.each([false, true])(
    'exposes deferred recordings before the next round (event bus: %s)',
    async (useEventBus) => {
      const recorded: string[] = [];
      const nextRound: AgentLoopHost['nextRound'] = (
        round,
        parts,
        responses,
      ) => {
        expect(recorded).toHaveLength(round - 1);
        expect(responses).toHaveLength(1);
        responses?.[0]?.record?.();
        return {
          parts,
          promptId: 'p0',
          options: { type: SendMessageType.ToolResult },
        };
      };
      const result = await runAgentLoop({
        ...options(
          [
            [{ type: LlmEventType.ToolCallRequest, value: call('c1') }],
            [{ type: LlmEventType.ToolCallRequest, value: call('c2') }],
            [content],
          ],
          { nextRound },
          {
            config: {
              getChatRecordingService: () => ({
                recordToolResult: (
                  _parts: Part[],
                  { callId }: { callId: string },
                ) => recorded.push(callId),
              }),
            } as unknown as Config,
            deferRecording: true,
          },
        ),
        useEventBus,
      });
      expect(result).toMatchObject({ reason: 'completed', rounds: 3 });
      expect(recorded).toEqual(['c1', 'c2']);
    },
  );

  it('matches on a round source and counts no calls toward a client', async () => {
    const toolCall = {
      type: LlmEventType.ToolCallRequest,
      value: call('c1'),
    } as ServerLlmStreamEvent;
    const run = async (useEventBus: boolean) => {
      const rounds = [[toolCall], [content]];
      let index = 0;
      const sent: unknown[] = [];
      const client: ModelRoundSource = {
        async *sendRound(round) {
          sent.push(round.parts);
          for (const event of rounds[index++] ?? []) yield event;
          return undefined;
        },
      };
      const { host, log } = makeHost();
      const result = await runAgentLoop({
        ...options([], host, {
          client,
          executor: {
            run: async (requests, _signal, hooks) =>
              requests.map((request) => {
                hooks.beforeLaunch(request, []);
                return {
                  request,
                  response: response(request),
                  status: 'success' as const,
                };
              }),
          },
        }),
        useEventBus,
      });
      return { result, log, sent };
    };
    const procedural = await run(false);
    const bus = await run(true);
    expect(bus).toEqual(procedural);
    expect(bus.result.reason).toBe('completed');
    expect(bus.result.rounds).toBe(2);
    expect(bus.log).toContain('tool:c1:executed');
  });

  it('proves the bus path runs by its event sequence, and the flag-off run publishes nothing', async () => {
    const spy = vi.spyOn(LoopEventBus.prototype, 'publish');
    try {
      await runAgentLoop({
        ...options([[content]], makeHost().host),
        useEventBus: true,
      });
      // The declared sequence for a no-tool round; deleting the dispatch turns this red.
      expect(spy.mock.calls.map((call) => call[0].type)).toEqual([
        'loop.started',
        'llm.request',
        'llm.settled',
        'loop.finished',
      ]);
      spy.mockClear();
      await runAgentLoop(options([[content]], makeHost().host));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('runAgentLoop default executor wiring', () => {
  it('forwards scheduler options and runtimeView to the default executor on the bus path', async () => {
    const scheduler = { onAllToolCallsComplete: vi.fn() };
    const runtimeView = {
      contentGenerator: {},
      contentGeneratorConfig: {},
    } as unknown as RuntimeContentGeneratorView;
    const spy = vi
      .spyOn(agentLoop, 'createSchedulerExecutor')
      .mockReturnValue(makeExecutor());
    try {
      await runAgentLoop({
        ...options([[content]], makeHost().host),
        executor: undefined,
        scheduler,
        runtimeView,
        useEventBus: true,
      });
      expect(spy).toHaveBeenCalledWith(config, scheduler, runtimeView);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not create a default executor when one is injected', async () => {
    const spy = vi.spyOn(agentLoop, 'createSchedulerExecutor');
    try {
      await runAgentLoop({
        ...options([[content]], makeHost().host),
        useEventBus: true,
      });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('runAgentLoop on the event bus when its signal aborts', () => {
  const toolCall = {
    type: LlmEventType.ToolCallRequest,
    value: call('c1'),
  } as ServerLlmStreamEvent;

  /** An executor whose batch settles only when `settle` is called. */
  function heldExecutor() {
    let settle!: () => void;
    let start!: () => void;
    const started = new Promise<void>((resolve) => (start = resolve));
    const executor: AgentLoopToolExecutor = {
      run: (requests, _signal, hooks) => {
        start();
        return new Promise((done) => {
          settle = () =>
            done(
              requests.map((request) => {
                hooks.beforeLaunch(request, []);
                return {
                  request,
                  response: response(request),
                  status: 'success' as const,
                };
              }),
            );
        });
      },
    };
    return { executor, started, settle: () => settle() };
  }

  it('publishes loop.cancelled and decides as the procedural loop, keeping the results of the batch it cut off', async () => {
    const publish = vi.spyOn(LoopEventBus.prototype, 'publish');
    const run = async (useEventBus: boolean) => {
      const abort = new AbortController();
      const held = heldExecutor();
      const { host, log } = makeHost();
      const running = runAgentLoop({
        ...options([[toolCall], [content]], host, {
          signal: abort.signal,
          executor: held.executor,
          keepCancelledResults: true,
        }),
        useEventBus,
      });
      await held.started;
      abort.abort();
      held.settle();
      const result = await running;
      return { result, log };
    };
    try {
      const procedural = await run(false);
      publish.mockClear();
      const bus = await run(true);
      expect(bus).toEqual(procedural);
      expect(bus.result.reason).toBe('cancelled');
      expect(bus.result.responses?.map(({ callId }) => callId)).toEqual(['c1']);
      expect(
        publish.mock.calls.filter(([event]) => event.type === 'loop.cancelled'),
      ).toHaveLength(1);
    } finally {
      publish.mockRestore();
    }
  });

  it('removes its abort listener and clears its cap when the run settles', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const added = vi.spyOn(abort.signal, 'addEventListener');
      const removed = vi.spyOn(abort.signal, 'removeEventListener');
      const held = heldExecutor();
      const running = runAgentLoop({
        ...options([[toolCall], [content]], makeHost().host, {
          signal: abort.signal,
          executor: held.executor,
          keepCancelledResults: true,
        }),
        useEventBus: true,
      });
      await held.started;
      abort.abort();
      // The cancellation reaches Conversation before the batch settles.
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      held.settle();
      expect((await running).reason).toBe('cancelled');
      const listener = added.mock.calls.find(([type]) => type === 'abort')?.[1];
      expect(listener).toBeDefined();
      expect(removed).toHaveBeenCalledWith('abort', listener);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears its cap when a host callback rejects the cancelled run', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const held = heldExecutor();
      const running = runAgentLoop({
        ...options(
          [[toolCall], [content]],
          {
            onToolResult: () => {
              throw new Error('host failed');
            },
          },
          {
            signal: abort.signal,
            executor: held.executor,
            keepCancelledResults: true,
          },
        ),
        useEventBus: true,
      });
      await held.started;
      abort.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      held.settle();
      await expect(running).rejects.toThrow('host failed');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a run whose batch does not settle within the cap, and its host hears nothing after', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const held = heldExecutor();
      const { host, log } = makeHost();
      let settled: unknown;
      const running = runAgentLoop({
        ...options([[toolCall], [content]], host, {
          signal: abort.signal,
          executor: held.executor,
          keepCancelledResults: true,
        }),
        useEventBus: true,
      }).then((result) => (settled = result));
      await held.started;
      abort.abort();
      await vi.advanceTimersByTimeAsync(CANCEL_SETTLEMENT_CAP_MS - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await running;
      // The round's turn, and no results: the batch never settled.
      expect(settled).toEqual({ reason: 'cancelled', rounds: 1, turn: {} });
      const heard = [...log];
      held.settle();
      await vi.advanceTimersByTimeAsync(0);
      expect(log).toEqual(heard);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a run whose model stream ignores the abort, and closes the stream once it yields', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      let release!: () => void;
      const progress = { closed: false, pulled: 0 };
      const client = {
        async *sendMessageStream() {
          try {
            yield content;
            await new Promise<void>((resolve) => (release = resolve));
            // A stream that keeps going for as long as it is read.
            for (let i = 0; i < 50; i++) {
              progress.pulled++;
              yield content;
            }
          } finally {
            progress.closed = true;
          }
        },
        getHistoryToolCallFingerprints: () => [],
        recordCompletedToolCall: () => {},
      } as unknown as LlmClient;
      const { host, log } = makeHost();
      const running = runAgentLoop({
        ...options([], host, { client, signal: abort.signal }),
        useEventBus: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      abort.abort();
      await vi.advanceTimersByTimeAsync(CANCEL_SETTLEMENT_CAP_MS);
      expect(await running).toEqual({ reason: 'cancelled', rounds: 1 });
      const heard = [...log];
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(log).toEqual(heard);
      // The first event after the close stops the round.
      expect(progress.pulled).toBe(1);
      expect(progress.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
