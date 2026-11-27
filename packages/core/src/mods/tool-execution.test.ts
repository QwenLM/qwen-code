/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { makeFakeConfig } from '../test-utils/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { CompletedToolCall } from '../core/coreToolScheduler.js';
import type { ToolCallRequestInfo } from '../core/turn.js';
import {
  finalizeToolResponses,
  toolResponseTextLength,
} from '../tools/tool-response-finalizer.js';
import { executeModTool, modToolRequest } from './tool-execution.js';

describe('Mod tool request projection', () => {
  const setup = () => {
    const config = makeFakeConfig({ chatRecording: false });
    const registry = new ToolRegistry(config);
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    const load = vi.fn(
      async () => new MockTool({ name: 'fixture', shouldDefer: true }),
    );
    registry.registerFactory('fixture', load);
    const request: ToolCallRequestInfo = {
      callId: 'call',
      name: 'fixture',
      args: { value: 'original' },
      isClientInitiated: false,
      prompt_id: 'prompt',
    };
    return { config, registry, request, load };
  };

  it('intercepts a registered lazy direct tool without executing its factory', async () => {
    const { config, request, load } = setup();
    expect(await modToolRequest(config, request)).toEqual(request);
    expect(load).not.toHaveBeenCalled();
  });

  it('resolves case-insensitive lazy deferred targets while retaining the original wrapper', async () => {
    const { config, request, load } = setup();
    const wrapped = {
      ...request,
      name: 'tool_call',
      args: { name: 'FIXTURE', arguments: JSON.stringify(request.args) },
    };
    expect(await modToolRequest(config, wrapped)).toEqual(request);
    expect(load).toHaveBeenCalledOnce();
    expect(wrapped.args).toEqual({
      name: 'FIXTURE',
      arguments: JSON.stringify(request.args),
    });
  });

  it.each(['fixture', 'tool_call', 'structured_output'])(
    'keeps Goal evidence outside Mods for %s',
    async (name) => {
      const { config, request, load } = setup();
      const goalContext = { goalId: 'goal', revision: 1, turnId: 'turn' };
      expect(
        await modToolRequest(config, { ...request, name, goalContext }),
      ).toBeUndefined();
      expect(load).not.toHaveBeenCalled();
    },
  );

  it('leaves unknown tools and invalid deferred inputs to the native scheduler', async () => {
    const { config, request, load } = setup();
    expect(
      await modToolRequest(config, { ...request, name: 'unknown' }),
    ).toBeUndefined();
    expect(
      await modToolRequest(config, {
        ...request,
        name: 'tool_call',
        args: { name: 'fixture', arguments: '[' },
      }),
    ).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it.each(['tool_search', 'search_memory'])(
    'keeps budget-exempt %s on the native path for direct and deferred calls',
    async (name) => {
      const { config, registry, request, load } = setup();
      registry.registerFactory(name, load);
      expect(
        await modToolRequest(config, { ...request, name }),
      ).toBeUndefined();
      expect(
        await modToolRequest(config, {
          ...request,
          name: 'tool_call',
          args: { name, arguments: {} },
        }),
      ).toBeUndefined();
      expect(load).not.toHaveBeenCalled();
    },
  );

  it('hands a Mod a reference in place of a native result that nests too deeply', async () => {
    const { request } = setup();
    let output: unknown = 'leaf';
    for (let i = 0; i < 300; i++) output = { output };
    const native = {
      status: 'success',
      request,
      response: {
        callId: request.callId,
        responseParts: [
          {
            functionResponse: {
              id: request.callId,
              name: request.name,
              response: { output },
            },
          },
        ],
        resultDisplay: 'deep',
        error: undefined,
        errorType: undefined,
        executionStatus: 'success',
      },
    } as unknown as CompletedToolCall;
    let seen: unknown;
    const { response } = await executeModTool(
      request,
      request,
      async (input, next, signal) => {
        const answer = await next(
          input,
          signal,
          async (_input, verdict) => verdict,
        );
        seen = answer;
        return answer;
      },
      async () => native,
      new AbortController().signal,
    );
    expect(seen).toMatchObject({
      ref: 1,
      result: {
        output: expect.stringContaining('exceeds the Mod payload limit'),
      },
    });
    expect(response.responseParts).toEqual(native.response.responseParts);
  });

  it.each([
    [
      'returns an earlier reference',
      { ref: 1, result: { error: 'first' } },
      { error: 'first' },
    ],
    [
      'returns the retry',
      { ref: 3, result: { output: 'retry' } },
      { output: 'retry' },
    ],
    [
      'rewrites the result',
      { result: 'replacement' },
      { output: 'replacement' },
    ],
    [
      'withholds the result',
      { deny: 'withheld' },
      { error: expect.stringContaining('withheld') },
    ],
    [
      'receives a refusal on its last retry',
      { result: 'replacement' },
      { error: expect.stringContaining('refused') },
    ],
  ] as const)(
    'keeps the first native hook stop when the Mod %s',
    async (action, answer, expected) => {
      const { request } = setup();
      const tool = new MockTool({ name: request.name });
      const attempts = [
        { error: 'first' },
        { error: 'second', hookStopReason: 'stop after failure' },
        {
          output: 'retry',
          hookStopReason:
            action === 'returns the retry' ? undefined : 'later hook stop',
        },
        ...(action === 'receives a refusal on its last retry'
          ? [{ error: 'refused' }]
          : []),
      ];
      let index = 0;
      const { response } = await executeModTool(
        request,
        request,
        async (input, next, signal) => {
          for (const _attempt of attempts) {
            await next(input, signal, async (_input, verdict) => verdict);
          }
          return answer;
        },
        async () => {
          const attempt = attempts[index++];
          const refused = attempt.error === 'refused';
          return {
            status: attempt.error ? 'error' : 'success',
            request,
            tool,
            invocation: tool.build(request.args),
            response: {
              callId: request.callId,
              responseParts: [
                {
                  functionResponse: {
                    response: attempt.error
                      ? { error: attempt.error }
                      : { output: attempt.output },
                  },
                },
              ],
              executionStatus: refused
                ? 'not_started'
                : attempt.error
                  ? 'error'
                  : 'success',
              error: attempt.error ? new Error(attempt.error) : undefined,
              errorType: undefined,
              resultDisplay: attempt.error ?? attempt.output,
              hookStopReason: attempt.hookStopReason,
            },
          };
        },
        new AbortController().signal,
      );
      expect(response.responseParts[0].functionResponse?.response).toEqual(
        expected,
      );
      expect(response.executionStatus).toBe('success');
      expect(response.hookStopReason).toBe('stop after failure');
    },
  );

  it.each([
    { payload: 'x'.repeat(120_000) },
    { output: { payload: 'x'.repeat(120_000) } },
    { output: 'short', payload: 'x'.repeat(120_000) },
    ['x'.repeat(120_000)],
  ])(
    'puts all synthetic JSON within the native batch budget',
    async (result) => {
      const { request } = setup();
      const config = makeFakeConfig({ toolOutputBatchBudget: 1000 });
      const execute = vi.fn(async () => {
        throw new Error('Synthetic output must not execute the tool');
      });
      const { response } = await executeModTool(
        request,
        request,
        async () => ({ result }),
        execute,
        new AbortController().signal,
      );
      expect(execute).not.toHaveBeenCalled();
      expect(response.executionStatus).toBe('not_started');
      expect(toolResponseTextLength(response.responseParts)).toBeGreaterThan(
        1000,
      );
      expect(
        JSON.parse(
          response.responseParts[0].functionResponse!.response![
            'output'
          ] as string,
        ),
      ).toEqual(result);
      const [finalized] = await finalizeToolResponses(
        config,
        [
          {
            callId: request.callId,
            toolName: request.name,
            responseParts: response.responseParts,
            persistedOutputFiles: [],
          },
        ],
        undefined,
        false,
      );
      expect(
        toolResponseTextLength(finalized.responseParts),
      ).toBeLessThanOrEqual(1000);
      expect(JSON.stringify(finalized.responseParts).length).toBeLessThan(1200);
    },
  );
});
