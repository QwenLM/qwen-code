/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MockTool } from '../test-utils/mock-tool.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import type { ToolRegistry } from './tool-registry.js';
import type { AnyDeclarativeTool } from './tools.js';
import { resolveDeferredToolCall, ToolCallTool } from './tool-call.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames } from './tool-names.js';

function makeRegistry(
  tools: MockTool[] = [],
  hidden: ReadonlySet<string> = new Set(),
  options: { withToolSearch?: boolean } = {},
): ToolRegistry {
  const { withToolSearch = true } = options;
  const allTools = new Map<string, AnyDeclarativeTool>([
    [ToolNames.TOOL_CALL, new ToolCallTool()],
    ...(withToolSearch
      ? ([
          [
            ToolNames.TOOL_SEARCH,
            new MockTool({ name: ToolNames.TOOL_SEARCH }),
          ],
        ] as const)
      : []),
    ...tools.map((tool) => [tool.name, tool] as const),
  ]);
  return {
    ensureTool: async (name: string) => allTools.get(name),
    getTool: (name: string) => allTools.get(name),
    isDeferredAndHidden: (name: string) => hidden.has(name),
  } as unknown as ToolRegistry;
}

describe('ToolCallTool', () => {
  it('is an always-visible bridge with a stable generic schema', () => {
    const tool = new ToolCallTool();

    expect(tool.name).toBe(ToolNames.TOOL_CALL);
    expect(tool.alwaysLoad).toBe(true);
    expect(tool.shouldDefer).toBe(false);
    expect(tool.schema.parametersJsonSchema).toEqual({
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact deferred tool name returned by tool_search.',
          minLength: 1,
        },
        arguments: {
          type: 'object',
          description:
            'Arguments matching the deferred tool schema returned by tool_search.',
        },
      },
      required: ['name', 'arguments'],
      additionalProperties: false,
    });
  });

  it('validates the bridge envelope', () => {
    const tool = new ToolCallTool();

    expect(() => tool.build({ name: '', arguments: {} })).toThrow();
    expect(() => tool.build({ name: 'deferred_tool' } as never)).toThrow();
    expect(() =>
      tool.build({ name: 'deferred_tool', arguments: {} }),
    ).not.toThrow();
  });

  it('refuses direct execution outside the scheduler', async () => {
    const result = await new ToolCallTool()
      .build({ name: 'deferred_tool', arguments: {} })
      .execute(new AbortController().signal);

    expect(result.error?.message).toContain('tool scheduler');
  });

  it.each([ToolNames.TOOL_CALL, ToolNames.TOOL_SEARCH])(
    'rejects recursive bridge target %s',
    async (name) => {
      const result = await resolveDeferredToolCall(makeRegistry(), {
        name,
        arguments: {},
      });

      expect(result).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
      });
      // Pin the dedicated recursive-bridge guard by its message: the
      // downstream isDeferredAndHidden rejection also returns
      // INVALID_TOOL_PARAMS, so asserting on errorType alone would stay
      // green if this guard were deleted (wenshao verification note 2).
      if ('error' in result) {
        expect(result.error.message).toContain('cannot invoke bridge tool');
      }
    },
  );

  it('rejects an unknown deferred target', async () => {
    const result = await resolveDeferredToolCall(makeRegistry(), {
      name: 'missing_tool',
      arguments: {},
    });

    expect(result).toMatchObject({
      errorType: ToolErrorType.TOOL_NOT_REGISTERED,
    });
  });

  it('returns a tool error when a deferred target factory throws', async () => {
    const registry = makeRegistry();
    registry.ensureTool = async (name: string) => {
      if (name === ToolNames.TOOL_CALL) return new ToolCallTool();
      throw new Error('factory failed');
    };

    await expect(
      resolveDeferredToolCall(registry, {
        name: 'broken_tool',
        arguments: {},
      }),
    ).resolves.toMatchObject({
      errorType: ToolErrorType.TOOL_NOT_REGISTERED,
      error: expect.objectContaining({
        message: expect.stringContaining('factory failed'),
      }),
    });
  });

  it('enforces subagent plan-tool restrictions', async () => {
    const target = new MockTool({
      name: ToolNames.ENTER_PLAN_MODE,
      shouldDefer: true,
    });
    const result = await runWithAgentContext('worker', () =>
      resolveDeferredToolCall(makeRegistry([target], new Set([target.name])), {
        name: target.name,
        arguments: {},
      }),
    );

    expect(result).toMatchObject({ errorType: ToolErrorType.EXECUTION_DENIED });
  });

  it('rejects a leader-only target bridged from a subagent context', async () => {
    const target = new MockTool({
      name: ToolNames.TEAM_PLAN_APPROVAL,
      shouldDefer: true,
    });
    const result = await runWithAgentContext('worker', () =>
      resolveDeferredToolCall(makeRegistry([target], new Set([target.name])), {
        name: target.name,
        arguments: {},
      }),
    );

    expect(result).toMatchObject({
      errorType: ToolErrorType.EXECUTION_DENIED,
      error: expect.objectContaining({
        message: expect.stringContaining('only available to the team leader'),
      }),
    });
  });

  it('resolves a hidden deferred target while both bridge tools are registered', async () => {
    const target = new MockTool({ name: 'deferred_target', shouldDefer: true });
    const result = await resolveDeferredToolCall(
      makeRegistry([target], new Set([target.name])),
      { name: target.name, arguments: { foo: 'bar' } },
    );

    expect(result).toMatchObject({
      tool: expect.objectContaining({ name: target.name }),
      arguments: { foo: 'bar' },
    });
  });

  it('rejects a hidden deferred target when tool_search is not registered', async () => {
    const target = new MockTool({ name: 'deferred_target', shouldDefer: true });
    const result = await resolveDeferredToolCall(
      makeRegistry([target], new Set([target.name]), {
        withToolSearch: false,
      }),
      { name: target.name, arguments: {} },
    );

    expect(result).toMatchObject({
      errorType: ToolErrorType.EXECUTION_DENIED,
      error: expect.objectContaining({
        message: expect.stringContaining('unreachable'),
      }),
    });
  });

  it('does not suggest tool_search for unknown targets when it is absent', async () => {
    const result = await resolveDeferredToolCall(
      makeRegistry([], new Set(), { withToolSearch: false }),
      { name: 'missing_tool', arguments: {} },
    );

    expect(result).toMatchObject({
      errorType: ToolErrorType.TOOL_NOT_REGISTERED,
    });
    if ('error' in result) {
      expect(result.error.message).not.toContain('tool_search');
      expect(result.error.message).toContain(
        'No deferred-tool discovery is available',
      );
    }
  });
});
