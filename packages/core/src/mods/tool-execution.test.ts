/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { makeFakeConfig } from '../test-utils/config.js';
import { MockTool } from '../test-utils/mock-tool.js';
import { ToolRegistry } from '../tools/tool-registry.js';
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
