/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MockTool } from '../test-utils/mock-tool.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { runWithTeammateIdentity } from '../agents/team/identity.js';
import type { ToolRegistry } from './tool-registry.js';
import type { AnyDeclarativeTool } from './tools.js';
import { resolveDeferredToolCall, ToolCallTool } from './tool-call.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames } from './tool-names.js';
import { DEFAULT_MAX_SUBAGENT_DEPTH } from '../config/config.js';

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
    getAllToolNames: () => [...allTools.keys()],
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
      // Pin the present-side remedy: with tool_search registered the denial
      // must point back at discovery. Mutation check: dropping the remedy
      // suffix turns this red (the absent-side twin is pinned by the
      // 'does not suggest tool_search...' case below) — round-5 deferred item.
      error: expect.objectContaining({
        message: expect.stringContaining('Run tool_search again'),
      }),
    });
  });

  it('resolves a target case-insensitively like the discovery half', async () => {
    // tool_search's select: resolves requested names case-insensitively;
    // the invocation half must agree, otherwise a schema reviewed as e.g.
    // `Read_File` is not callable through the bridge (round-5 deferred
    // item). Mutation check: removing the case-insensitive fallback in
    // resolveDeferredToolCall turns this red.
    const target = new MockTool({ name: 'deferred_target', shouldDefer: true });
    const result = await resolveDeferredToolCall(
      makeRegistry([target], new Set([target.name])),
      { name: 'Deferred_Target', arguments: { foo: 'baz' } },
    );

    expect(result).toMatchObject({
      tool: expect.objectContaining({ name: 'deferred_target' }),
      arguments: { foo: 'baz' },
    });
  });

  it.each(['deferred_target', 'Deferred_Target', 'DEFERRED_TARGET'])(
    'resolves case-colliding name %s with the same last-match rule as tool_search',
    async (requestedName) => {
      // R7-14: the discovery half builds a lowercase-keyed Map (last
      // registered variant overwrites earlier ones); the invocation half must
      // resolve the same tool for a case-variant request. Mutation check:
      // switching the fallback to first-match turns this red.
      const first = new MockTool({
        name: 'deferred_target',
        shouldDefer: true,
      });
      const second = new MockTool({
        name: 'Deferred_Target',
        shouldDefer: true,
      });
      const result = await resolveDeferredToolCall(
        makeRegistry([first, second], new Set([first.name, second.name])),
        { name: requestedName, arguments: {} },
      );

      expect(result).toMatchObject({
        tool: expect.objectContaining({ name: 'Deferred_Target' }),
      });
    },
  );

  it('rejects case-variant spellings of the bridge tools themselves', async () => {
    // Companion pin: the case-insensitive fallback must feed the recursive
    // guard, so `Tool_Call` cannot dodge it via casing.
    const result = await resolveDeferredToolCall(makeRegistry(), {
      name: 'Tool_Call',
      arguments: {},
    });

    expect(result).toMatchObject({
      errorType: ToolErrorType.INVALID_TOOL_PARAMS,
      error: expect.objectContaining({
        message: expect.stringContaining('cannot invoke bridge tool'),
      }),
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
    // The real enter_plan_mode is constructed shouldDefer=false
    // (enterPlanMode.ts: "always visible so explicit plan-mode requests
    // work"), so the fixture is registered NOT hidden: the denial must come
    // from the plan-lifecycle check running AHEAD of the isDeferredAndHidden
    // gate. Mutation checks: removing the plan-lifecycle check, or moving the
    // exclusion check ahead of it, turns this red (round-5 review, R5-2/R5-4).
    const target = new MockTool({
      name: ToolNames.ENTER_PLAN_MODE,
      shouldDefer: false,
    });
    const result = await runWithAgentContext('worker', () =>
      resolveDeferredToolCall(makeRegistry([target], new Set()), {
        name: target.name,
        arguments: {},
      }),
    );

    expect(result).toMatchObject({
      errorType: ToolErrorType.EXECUTION_DENIED,
      // Pin the dedicated plan-lifecycle message: the exclusion check also
      // returns EXECUTION_DENIED for plan tools (they are exclusion-set
      // members via SUBAGENT_PLAN_LIFECYCLE_TOOLS), so asserting errorType
      // alone would stay green if the plan-lifecycle check were deleted or
      // shadowed by the exclusion check and the behavior-shaping guidance
      // silently changed to the generic denial (round-5 review, R5-4).
      error: expect.objectContaining({
        message: expect.stringContaining('Plan mode is owned by the caller'),
      }),
    });
  });

  it('rejects a leader-only target bridged from a subagent context', async () => {
    // Registered NOT hidden: real control-plane tools are not deferred, so
    // the denial must come from the leader-only check ahead of the deferred
    // gate (round-5 review, R5-2).
    const target = new MockTool({
      name: ToolNames.TEAM_PLAN_APPROVAL,
      shouldDefer: false,
    });
    const result = await runWithAgentContext('worker', () =>
      resolveDeferredToolCall(makeRegistry([target], new Set()), {
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

  it.each([
    ToolNames.TEAM_DELETE,
    ToolNames.WORKFLOW,
    // SEND_MESSAGE is excluded only from EXCLUDED_TOOLS_FOR_SUBAGENTS (not
    // the teammate set), so it discriminates the context-aware selector
    // (round-5 review, R5-3).
    ToolNames.SEND_MESSAGE,
  ])(
    'rejects an exclusion-set target (%s) bridged from a subagent context',
    async (toolName) => {
      // R4-1: the bridge must not bypass the subagent tool-exclusion set.
      // prepareTools enforces it at declaration level, but the bridge makes
      // invocation independent of declaration — without carrying the exclusion
      // set over, a wildcard/general-purpose subagent could discover and
      // execute control-plane tools it must not reach (team_delete, workflow).
      // Mutation check: removing the exclusion check in resolveDeferredToolCall
      // must turn this test red.
      //
      // Real shape witness (round-5 review, R5-2): the real team_delete/
      // workflow/send_message default shouldDefer to false, so the fixture is
      // registered NOT hidden — the denial must come from the exclusion check
      // running ahead of the isDeferredAndHidden gate, not the factually-wrong
      // "already visible — call it directly" INVALID_TOOL_PARAMS.
      const target = new MockTool({ name: toolName, shouldDefer: false });
      const result = await runWithAgentContext('worker', () =>
        resolveDeferredToolCall(makeRegistry([target], new Set()), {
          name: target.name,
          arguments: {},
        }),
      );

      expect(result).toMatchObject({
        errorType: ToolErrorType.EXECUTION_DENIED,
        error: expect.objectContaining({
          message: expect.stringContaining('not available to this agent'),
        }),
      });
    },
  );

  it('discriminates the context-aware exclusion selector for teammates', async () => {
    // R5-3: with only shared-set members tested, replacing the selector with
    // either raw set survives the suite. A teammate's send_message must
    // RESOLVE (teammate set allows it) while team_delete stays denied.
    const allowed = new MockTool({
      name: ToolNames.SEND_MESSAGE,
      shouldDefer: true,
    });
    const denied = new MockTool({
      name: ToolNames.TEAM_DELETE,
      shouldDefer: true,
    });
    const identity = {
      agentId: 'worker@test-team',
      agentName: 'worker',
      teamName: 'test-team',
      isTeamLead: false,
    };

    const resolved = await runWithTeammateIdentity(identity, () =>
      resolveDeferredToolCall(
        makeRegistry([allowed], new Set([allowed.name])),
        {
          name: allowed.name,
          arguments: { to: 'lead' },
        },
      ),
    );
    expect(resolved).toMatchObject({
      tool: expect.objectContaining({ name: ToolNames.SEND_MESSAGE }),
      arguments: { to: 'lead' },
    });

    const refused = await runWithTeammateIdentity(identity, () =>
      resolveDeferredToolCall(makeRegistry([denied], new Set([denied.name])), {
        name: denied.name,
        arguments: {},
      }),
    );
    expect(refused).toMatchObject({
      errorType: ToolErrorType.EXECUTION_DENIED,
      error: expect.objectContaining({
        message: expect.stringContaining('not available to this agent'),
      }),
    });
  });

  it('resolves a non-excluded deferred target from inside an agent frame', async () => {
    // R5-5 allow side (1): the exclusion gate must not degrade into a
    // blanket "agent frame denies everything" — the bridge exists precisely
    // so subagents can reach deferred tools (MCP, tools.eager-demoted).
    // Mutation check: an agent-frame blanket denial turns this red.
    const target = new MockTool({ name: 'deferred_target', shouldDefer: true });
    const result = await runWithAgentContext('worker', () =>
      resolveDeferredToolCall(makeRegistry([target], new Set([target.name])), {
        name: target.name,
        arguments: { foo: 'bar' },
      }),
    );

    expect(result).toMatchObject({
      tool: expect.objectContaining({ name: target.name }),
      arguments: { foo: 'bar' },
    });
  });

  it('does not apply the exclusion gate to the leader session', async () => {
    // R5-5 allow side (2): outside any agent frame and teammate identity the
    // gate must not fire — a leader whose tools.eager allowlist demoted
    // team_delete to deferred+hidden still bridges it legitimately.
    // Mutation check: removing the isSubagentLikeExecutionContext() gate (or
    // applying the check unconditionally) turns this red.
    const target = new MockTool({
      name: ToolNames.TEAM_DELETE,
      shouldDefer: true,
    });
    const result = await resolveDeferredToolCall(
      makeRegistry([target], new Set([target.name])),
      { name: target.name, arguments: {} },
    );

    expect(result).toMatchObject({
      tool: expect.objectContaining({ name: ToolNames.TEAM_DELETE }),
    });
  });

  it('rejects an exclusion-set target bridged via its legacy alias', async () => {
    // R5-6: exclusion membership must be keyed on the CANONICAL target.name,
    // not the raw envelope name — 'task' is the documented legacy alias of
    // 'agent' (tool-names.ts), and 'agent' is in both exclusion sets.
    // Mutation check: keying the membership test on invocation.params.name
    // turns this red ('task' is not a set member and would resolve).
    const target = new MockTool({ name: ToolNames.AGENT, shouldDefer: true });
    const result = await runWithAgentContext('worker', () =>
      resolveDeferredToolCall(makeRegistry([target], new Set([target.name])), {
        name: 'task',
        arguments: {},
      }),
    );

    expect(result).toMatchObject({
      errorType: ToolErrorType.EXECUTION_DENIED,
      error: expect.objectContaining({
        message: expect.stringContaining('not available to this agent'),
      }),
    });
  });

  it('re-admits agent to a subagent while the nesting depth permits', async () => {
    // Round-5 review, R4-1 follow-up: prepareTools depth-gates AgentTool
    // (re-admitted while spawnBlockReason === null); the bridge must mirror
    // that re-admission instead of flatly denying. A depth-0 subagent under
    // the default max depth 5 may spawn to level 2, so a deferred+hidden
    // agent resolves. Mutation check: the flat exclusion (no AGENT special
    // case) turns this red.
    const target = new MockTool({ name: ToolNames.AGENT, shouldDefer: true });
    const result = await runWithAgentContext('worker', () =>
      resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        { name: target.name, arguments: { prompt: 'nested' } },
        { maxSubagentDepth: DEFAULT_MAX_SUBAGENT_DEPTH },
      ),
    );

    expect(result).toMatchObject({
      tool: expect.objectContaining({ name: ToolNames.AGENT }),
      arguments: { prompt: 'nested' },
    });
  });

  it('still denies agent when the nesting depth is exhausted', async () => {
    // Companion to the re-admission case: with maxSubagentDepth=1 a depth-0
    // subagent's child would sit at level 2 > 1, so the denial stands.
    const target = new MockTool({ name: ToolNames.AGENT, shouldDefer: true });
    const result = await runWithAgentContext('worker', () =>
      resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        { name: target.name, arguments: {} },
        { maxSubagentDepth: 1 },
      ),
    );

    expect(result).toMatchObject({
      errorType: ToolErrorType.EXECUTION_DENIED,
      error: expect.objectContaining({
        message: expect.stringContaining('not available to this agent'),
      }),
    });
  });

  it('fails closed on agent when maxSubagentDepth is unknown', async () => {
    // The raw-set floor: without the configured depth threaded through, the
    // bridge cannot verify the spawn policy and keeps AgentTool excluded —
    // the documented fail-closed floor of EXCLUDED_TOOLS_FOR_SUBAGENTS.
    const target = new MockTool({ name: ToolNames.AGENT, shouldDefer: true });
    const result = await runWithAgentContext('worker', () =>
      resolveDeferredToolCall(makeRegistry([target], new Set([target.name])), {
        name: target.name,
        arguments: {},
      }),
    );

    expect(result).toMatchObject({
      errorType: ToolErrorType.EXECUTION_DENIED,
      error: expect.objectContaining({
        message: expect.stringContaining('not available to this agent'),
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
