/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it, vi } from 'vitest';
import {
  SendMessageType,
  type Config,
  type LlmClient,
  type ToolCallRequestInfo,
} from '@qwen-code/qwen-code-core';
import { getToolCallFingerprint } from '@qwen-code/qwen-code-core/core/toolCallIdUtils.js';
import type { AgentLoopToolExecutor } from '@qwen-code/qwen-code-core/core/agent-loop.js';
import {
  startSharedLoopRound,
  type SharedLoopRoundOptions,
} from './shared-loop-round.js';

const call = (callId: string) => ({
  type: 'tool_call_request',
  value: {
    callId,
    providerCallId: callId,
    name: 'read_file',
    args: {},
    isClientInitiated: false,
    prompt_id: 'p1',
  },
});

const clientYielding = (events: Array<Record<string, unknown> | Error>) =>
  ({
    sendMessageStream: vi.fn(async function* () {
      for (const event of events) {
        if (event instanceof Error) throw event;
        yield event;
      }
    }),
    recordCompletedToolCall: vi.fn(),
  }) as unknown as LlmClient;

const config = {
  getSessionId: () => 'session',
  getToolOutputBatchBudget: () => Number.POSITIVE_INFINITY,
  getChatRecordingService: () => undefined,
} as unknown as Config;

const round = {
  parts: [{ text: 'hi' }],
  promptId: 'p1',
  options: { type: SendMessageType.UserQuery },
};

/** An executor that runs each call to an `ok` result. */
const okExecutor = () => {
  const run = vi.fn(
    async (
      requests: ToolCallRequestInfo[],
      _signal: AbortSignal,
      hooks: Parameters<AgentLoopToolExecutor['run']>[2],
    ) =>
      requests.flatMap((request) =>
        hooks.beforeLaunch(request, [])
          ? [
              {
                status: 'success' as const,
                request,
                response: {
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
                },
              },
            ]
          : [],
      ),
  );
  return { run };
};

describe.each([false, true])('startSharedLoopRound (kernel=%s)', (kernel) => {
  const start = (
    client: LlmClient,
    extra: Partial<SharedLoopRoundOptions> = {},
  ) =>
    startSharedLoopRound(client, round, {
      config,
      signal: new AbortController().signal,
      toolSignal: new AbortController().signal,
      deferRecording: true,
      useEventBus: kernel,
      onModelEvent: () => {},
      ...extra,
    });

  it("runs the round's batch on what the turn hands it, under the tool signal", async () => {
    const toolSignal = new AbortController().signal;
    const shared = start(clientYielding([call('fresh'), call('replayed')]), {
      toolSignal,
    });
    expect((await shared.model).calls.map(({ callId }) => callId)).toEqual([
      'fresh',
      'replayed',
    ]);
    const executor = okExecutor();
    const results: string[] = [];
    const batch = await shared.runBatch({
      executor,
      handled: new Map([['replayed', getToolCallFingerprint('read_file', {})]]),
      responded: new Set(),
      onToolResult: ({ request, origin }) => {
        results.push(`${request.callId}:${origin}`);
      },
    });
    // The handled call is answered as a replay; only the other one runs.
    expect(executor.run).toHaveBeenCalledOnce();
    expect(executor.run.mock.calls[0][0].map(({ callId }) => callId)).toEqual([
      'fresh',
    ]);
    expect(executor.run.mock.calls[0][1]).toBe(toolSignal);
    expect(results).toEqual(['replayed:replayed', 'fresh:executed']);
    expect(batch.responses?.map(({ callId }) => callId)).toEqual([
      'fresh',
      'replayed',
    ]);
  });

  it('runs the tools under the signal the batch brings, behind its launch check', async () => {
    const toolSignal = new AbortController().signal;
    const shared = start(clientYielding([call('first'), call('second')]), {
      deferRecording: false,
    });
    await shared.model;
    const executor = okExecutor();
    const results: string[] = [];
    const batch = await shared.runBatch({
      executor,
      handled: new Map(),
      responded: new Set(),
      toolSignal,
      beforeToolLaunch: ({ callId }) => callId === 'first',
      onToolResult: ({ request, origin }) => {
        results.push(`${request.callId}:${origin}`);
      },
    });
    expect(executor.run.mock.calls[0][1]).toBe(toolSignal);
    expect(results).toEqual(['first:executed', 'second:skipped']);
    // The batch recorded its results instead of leaving them to the turn.
    expect(batch.responses?.map(({ record }) => record)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('runs the tools in the async context the batch was handed over in', async () => {
    const turn = new AsyncLocalStorage<string>();
    const shared = start(clientYielding([call('c1')]));
    await shared.model;
    const executor = okExecutor();
    const contexts: Array<string | undefined> = [];
    await turn.run('batch', () =>
      shared.runBatch({
        executor: {
          run: (requests, signal, hooks) => {
            contexts.push(turn.getStore());
            return executor.run(requests, signal, hooks);
          },
        },
        handled: new Map(),
        responded: new Set(),
        onToolResult: () => {},
      }),
    );
    expect(contexts).toEqual(['batch']);
  });

  it('skips the batch, replays included, when the turn closes the round', async () => {
    const responded = new Set<string>();
    const onToolResult = vi.fn();
    const shared = start(clientYielding([call('c1')]));
    await shared.model;
    await shared.close();
    // A batch handed over after the close finds the run already ended.
    const executor = okExecutor();
    await expect(
      shared.runBatch({
        executor,
        handled: new Map(),
        responded,
        onToolResult,
      }),
    ).resolves.toEqual({ parts: [], stop: 'surface_ended' });
    expect(executor.run).not.toHaveBeenCalled();
    expect(onToolResult).not.toHaveBeenCalled();
    expect(responded.size).toBe(0);
  });

  it("rejects the round's model with the failure of its request", async () => {
    const shared = start(
      clientYielding([{ type: 'content', value: 'a' }, new Error('down')]),
    );
    await expect(shared.model).rejects.toThrow('down');
    await expect(shared.close()).resolves.toBeUndefined();
  });

  it('ends without a batch for a round with no calls', async () => {
    const shared = start(clientYielding([{ type: 'content', value: 'a' }]));
    expect(await shared.model).toEqual({ calls: [] });
    await expect(
      shared.runBatch({
        executor: okExecutor(),
        handled: new Map(),
        responded: new Set(),
        onToolResult: () => {},
      }),
    ).resolves.toEqual({ parts: [] });
  });
});
