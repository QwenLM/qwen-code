/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { MockTool } from '../test-utils/mock-tool.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { runWithTeammateIdentity } from '../agents/team/identity.js';
import {
  deferredDeclarationFingerprint,
  type ToolRegistry,
} from './tool-registry.js';
import type { AnyDeclarativeTool, MediaPolicyToolDescriptor } from './tools.js';
import {
  DEFERRED_TOOL_CALL_REFUSAL_PREFIX,
  resolveDeferredToolCall,
  ToolCallTool,
} from './tool-call.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { projectMediaPolicyToolDeclaration } from '../omni/policy/model-access.js';
import {
  validateMediaPolicyIoParams,
  type MediaPolicyIoParams,
} from '../omni/policy/tools/media-policy-tool.js';
import { ToolErrorType } from './tool-error.js';
import { ToolNames } from './tool-names.js';
import { DEFAULT_MAX_SUBAGENT_DEPTH } from '../config/config.js';

function makeRegistry(
  tools: MockTool[] = [],
  hidden: ReadonlySet<string> = new Set(),
  options: {
    withToolSearch?: boolean;
    reviewed?: ReadonlyMap<string, string>;
  } = {},
): ToolRegistry {
  const { withToolSearch = true, reviewed } = options;
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
    getReviewedDeclaration: (name: string) => reviewed?.get(name),
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
        expect(
          result.error.message.startsWith(DEFERRED_TOOL_CALL_REFUSAL_PREFIX),
        ).toBe(true);
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

  describe('names that differ only by case (#11321)', () => {
    const first = new MockTool({ name: 'deferred_target', shouldDefer: true });
    const second = new MockTool({ name: 'Deferred_Target', shouldDefer: true });
    const hidden = new Set([first.name, second.name]);

    it.each([
      ['deferred_target', [first, second]],
      ['deferred_target', [second, first]],
      ['Deferred_Target', [first, second]],
      ['Deferred_Target', [second, first]],
    ] as const)(
      'resolves the exact spelling %s whatever the registration order',
      async (requestedName, order) => {
        // tool_search's select: applies the same rule, so the tool invoked is
        // the one whose schema was reviewed. The old last-match rule read
        // getAllToolNames() order, which ensureTool changes.
        const result = await resolveDeferredToolCall(
          makeRegistry([...order], hidden),
          { name: requestedName, arguments: {} },
        );

        expect(result).toMatchObject({
          tool: expect.objectContaining({ name: requestedName }),
        });
      },
    );

    it('refuses a spelling that matches several tools only by case', async () => {
      const result = await resolveDeferredToolCall(
        makeRegistry([first, second], hidden),
        { name: 'DEFERRED_TARGET', arguments: {} },
      );

      expect(result).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
        error: expect.objectContaining({
          message: expect.stringContaining(
            'matches more than one registered tool by case (Deferred_Target, deferred_target)',
          ),
        }),
      });
      expect(result).not.toHaveProperty('tool');
    });
  });

  describe('a tool that changed after tool_search returned it (#11321)', () => {
    const reviewedParams = {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    };
    const reviewedTool = new MockTool({
      name: 'mcp_lookup',
      description: 'Look up a record by id.',
      shouldDefer: true,
      params: reviewedParams,
    });
    const reviewed = new Map([
      [reviewedTool.name, deferredDeclarationFingerprint(reviewedTool)],
    ]);

    it('invokes the tool when its declaration is unchanged', async () => {
      const result = await resolveDeferredToolCall(
        makeRegistry([reviewedTool], new Set([reviewedTool.name]), {
          reviewed,
        }),
        { name: 'mcp_lookup', arguments: { id: 1 } },
      );

      expect(result).toMatchObject({ arguments: { id: 1 } });
    });

    it('invokes the tool when only its description changed', async () => {
      // Shipped deferred tools rebuild the model-facing description from
      // mutable state on every `schema` access: WebSearchTool interpolates the
      // current month/year (web-search.ts:997-1004) and ReadFileTool rebuilds
      // from the model's CURRENT input modalities (read-file.ts:628-637). Both
      // are intentional so a long-lived `qwen serve`/ACP process is not stale,
      // so prose drift across a month boundary or a `/model` switch must not
      // arm a false "changed" refusal against an identical parameter contract.
      const sameContractNewProse = new MockTool({
        name: 'mcp_lookup',
        description: 'Look up a record by id. (October 2026)',
        shouldDefer: true,
        params: reviewedParams,
      });
      const result = await resolveDeferredToolCall(
        makeRegistry(
          [sameContractNewProse],
          new Set([sameContractNewProse.name]),
          { reviewed },
        ),
        { name: 'mcp_lookup', arguments: { id: 1 } },
      );

      expect(result).toMatchObject({
        tool: expect.objectContaining({ name: 'mcp_lookup' }),
        arguments: { id: 1 },
      });
    });

    it('refuses and asks for a fresh review when the parameter contract changed', async () => {
      const replaced = new MockTool({
        name: 'mcp_lookup',
        description: 'Delete a record by id.',
        shouldDefer: true,
        params: {
          type: 'object',
          properties: { id: { type: 'string' }, purge: { type: 'boolean' } },
          required: ['id'],
        },
      });
      const result = await resolveDeferredToolCall(
        makeRegistry([replaced], new Set([replaced.name]), { reviewed }),
        { name: 'mcp_lookup', arguments: { id: 1 } },
      );

      expect(result).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
        targetName: 'mcp_lookup',
        error: expect.objectContaining({
          message: expect.stringContaining(
            'changed since tool_search last returned it. Run tool_search with select:mcp_lookup',
          ),
        }),
      });
    });

    it('refuses a case-variant spelling of a tool whose resolved declaration changed', async () => {
      // tool_search records under the REGISTERED name (tool.name) while models
      // invoke with a spelling that needs resolution, so the lookup must key on
      // the resolved target. Keying it on the raw envelope name instead finds no
      // recorded review and executes arguments written against the stale schema.
      const replaced = new MockTool({
        name: 'mcp_lookup',
        description: 'Delete a record by id.',
        shouldDefer: true,
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      });
      const result = await resolveDeferredToolCall(
        makeRegistry([replaced], new Set([replaced.name]), { reviewed }),
        { name: 'MCP_LOOKUP', arguments: { id: 1 } },
      );

      expect(result).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
        targetName: 'mcp_lookup',
        error: expect.objectContaining({
          message: expect.stringContaining(
            'changed since tool_search last returned it. Run tool_search with select:mcp_lookup',
          ),
        }),
      });
    });

    it('keeps invoking a tool never reviewed in this session by name', async () => {
      const unreviewed = new MockTool({ name: 'cron_list', shouldDefer: true });
      const result = await resolveDeferredToolCall(
        makeRegistry([unreviewed], new Set([unreviewed.name]), { reviewed }),
        { name: 'cron_list', arguments: {} },
      );

      expect(result).toMatchObject({
        tool: expect.objectContaining({ name: 'cron_list' }),
      });
    });
  });

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

  it('denies a policy-blocked target ahead of the hidden-tool gate', async () => {
    // Registered NOT hidden: the caller's execution-policy gate must fire
    // BEFORE the isDeferredAndHidden check, like the sibling plan-lifecycle
    // and leader-only gates above. Otherwise a policy-disabled but visible
    // target bridged through tool_call gets the "already visible — call it
    // directly" INVALID_TOOL_PARAMS, telling the model to call a tool the
    // owner's policy forbids (and on ACP accruing an invalid-parameter
    // strike). Mutation check: moving the isTargetExecutionAllowed gate
    // below the isDeferredAndHidden check turns this red with the
    // "already visible" refusal; dropping targetName from the denial also
    // turns it red.
    const target = new MockTool({ name: 'web_fetch', shouldDefer: false });
    const result = await resolveDeferredToolCall(
      makeRegistry([target], new Set()),
      { name: target.name, arguments: {} },
      { isTargetExecutionAllowed: async () => false },
    );

    expect(result).toMatchObject({
      errorType: ToolErrorType.EXECUTION_DENIED,
      targetName: 'web_fetch',
      error: expect.objectContaining({
        message: expect.stringContaining(
          "not permitted by this agent's tool policy",
        ),
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

  it('rejects a registered-but-undeclared target via the capability gate', async () => {
    // R27-3: isToolDeclared (the registry's capability gate — propose_goal is
    // registered but undeclared until a turn with a responder) is enforced by
    // every other reachability reader, including tool_search's select:; the
    // invocation half must agree, or tool_call executes a target the model
    // was never offered. Mutation check: removing the isToolDeclared gate in
    // resolveDeferredToolCall turns this red. The same stub leaves ordinary
    // declared tools resolvable, so the gate cannot degrade into a blanket
    // denial.
    const gated = new MockTool({
      name: ToolNames.PROPOSE_GOAL,
      shouldDefer: true,
    });
    const ordinary = new MockTool({
      name: 'deferred_target',
      shouldDefer: true,
    });
    const registry = makeRegistry(
      [gated, ordinary],
      new Set([gated.name, ordinary.name]),
    );
    registry.isToolDeclared = (name: string) => name !== ToolNames.PROPOSE_GOAL;

    const denied = await resolveDeferredToolCall(registry, {
      name: gated.name,
      arguments: {},
    });
    expect(denied).toMatchObject({
      errorType: ToolErrorType.EXECUTION_DENIED,
      error: expect.objectContaining({
        message: expect.stringContaining(ToolNames.PROPOSE_GOAL),
      }),
    });

    const allowed = await resolveDeferredToolCall(registry, {
      name: ordinary.name,
      arguments: { foo: 'bar' },
    });
    expect(allowed).toMatchObject({
      tool: expect.objectContaining({ name: ordinary.name }),
      arguments: { foo: 'bar' },
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

  describe('target-schema pre-validation (#12889)', () => {
    // Mirrors the issue's web_fetch: both fields required, so `{}` must not
    // be accepted just because the bridge envelope types arguments as a
    // bare object.
    const makeWebFetchLike = () =>
      new MockTool({
        name: 'web_fetch',
        shouldDefer: true,
        params: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['url', 'prompt'],
          additionalProperties: false,
        },
      });

    it('resolves a call whose arguments satisfy the target schema', async () => {
      const target = makeWebFetchLike();
      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        {
          name: 'web_fetch',
          arguments: { url: 'https://example.com', prompt: 'summarize' },
        },
      );

      expect(result).toMatchObject({
        tool: expect.objectContaining({ name: 'web_fetch' }),
        arguments: { url: 'https://example.com', prompt: 'summarize' },
      });
    });

    it('refuses an empty arguments object that misses required target fields', async () => {
      // #12889: the bridge validated only its own envelope, so `{}` passed
      // and the target's required-field error surfaced post-unwrap as a bare
      // Ajv message the model could not act on. The refusal must name the
      // target and the missing field. Mutation check: dropping the
      // pre-validation in resolveDeferredToolCall turns this red.
      const target = makeWebFetchLike();
      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        { name: 'web_fetch', arguments: {} },
      );

      expect(result).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
        targetName: 'web_fetch',
      });
      expect(result).not.toHaveProperty('tool');
      if ('error' in result) {
        expect(
          result.error.message.startsWith(DEFERRED_TOOL_CALL_REFUSAL_PREFIX),
        ).toBe(true);
        expect(result.error.message).toContain('"web_fetch"');
        expect(result.error.message).toContain("'url'");
      }
    });

    it('leaves surplus-key enforcement to the target without changing its schema', async () => {
      class LenientTool extends MockTool {
        override validateToolParams(): string | null {
          return null;
        }
      }
      for (const Tool of [MockTool, LenientTool]) {
        const target = new Tool({
          name: 'agent_like',
          shouldDefer: true,
          params: {
            type: 'object',
            properties: { prompt: { type: 'string' } },
            required: ['prompt'],
            additionalProperties: false,
          },
        });
        const result = await resolveDeferredToolCall(
          makeRegistry([target], new Set([target.name])),
          {
            name: target.name,
            arguments: { prompt: 'investigate', name: 'helper' },
          },
        );
        expect(result).not.toHaveProperty('error');
        expect(target.schema.parametersJsonSchema).toHaveProperty(
          'additionalProperties',
          false,
        );
        if ('tool' in result) {
          const build = () => result.tool.build(result.arguments);
          if (Tool === MockTool) {
            expect(build).toThrow('must NOT have additional properties');
          } else {
            expect(build).not.toThrow();
          }
        }
      }
    });

    it('still attributes wrong field types when surplus keys are present', async () => {
      const target = makeWebFetchLike();
      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        {
          name: target.name,
          arguments: { url: {}, prompt: 'summarize', extra: true },
        },
      );
      expect(result).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
        targetName: 'web_fetch',
        error: expect.objectContaining({
          message: expect.stringContaining('must be string'),
        }),
      });
    });

    it('returns the model-sent arguments even when validation coerces a clone', async () => {
      // SchemaValidator.validate coerces values in place (numeric strings →
      // numbers, etc.). The pre-check must run on a clone: the resolved
      // arguments stay exactly what the model sent, and the scheduler
      // re-validates them at build time.
      const target = new MockTool({
        name: 'counter',
        shouldDefer: true,
        params: {
          type: 'object',
          properties: { count: { type: 'integer' } },
          required: ['count'],
        },
      });
      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        { name: 'counter', arguments: { count: '3' } },
      );

      expect(result).toMatchObject({ arguments: { count: '3' } });
    });

    it('leaves optional null placeholders for the target to normalize', async () => {
      class NullTolerantTool extends MockTool {
        override validateToolParams(params: {
          [key: string]: unknown;
        }): string | null {
          return params['working_dir'] === null
            ? null
            : super.validateToolParams(params);
        }
      }
      const target = new NullTolerantTool({
        name: 'agent_like',
        shouldDefer: true,
        params: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            working_dir: { type: 'string' },
          },
          required: ['prompt'],
        },
      });
      const argumentsWithPlaceholder = {
        prompt: 'investigate',
        working_dir: null,
      };

      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        { name: target.name, arguments: argumentsWithPlaceholder },
      );

      expect(result).not.toHaveProperty('error');
      expect(result).toMatchObject({ arguments: argumentsWithPlaceholder });
    });

    it('does not reserve a target schema id in the shared validator', async () => {
      const target = new MockTool({
        name: 'identified_target',
        shouldDefer: true,
        params: {
          $id: 'https://example.com/deferred-tool-precheck',
          type: 'object',
          properties: { prompt: { type: 'string' } },
          required: ['prompt'],
          additionalProperties: false,
        },
      });

      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        { name: target.name, arguments: { prompt: 'investigate' } },
      );

      expect(result).not.toHaveProperty('error');
      expect(target.validateToolParams({})).toContain("'prompt'");
    });

    it('re-reads a target schema the target mutates in place after the first call', async () => {
      // AgentTool's refresh mutates its own parameterSchema object in place
      // (it adds and removes `model`/`name`), and Ajv caches a compiled
      // schema by object identity for the life of the process. Handing the
      // validator that same object pins every later bridged call to the
      // shape the first one happened to compile, ignoring changed constraints.
      // A stale validator would ignore the newly advertised model enum and
      // accept the unknown grade below.
      const target = new MockTool({
        name: 'agent_like',
        shouldDefer: true,
        params: {
          type: 'object',
          properties: { prompt: { type: 'string' } },
          required: ['prompt'],
          additionalProperties: false,
        },
      });
      const registry = makeRegistry([target], new Set([target.name]));

      // The first bridged call compiles the pre-refresh schema.
      await resolveDeferredToolCall(registry, {
        name: 'agent_like',
        arguments: { prompt: 'do the thing' },
      });

      // The refresh then advertises a new property on that SAME object.
      const schema = target.schema.parametersJsonSchema as {
        properties: Record<string, unknown>;
      };
      schema.properties['model'] = { type: 'string', enum: ['fast', 'pro'] };

      const invalid = await resolveDeferredToolCall(registry, {
        name: 'agent_like',
        arguments: { prompt: 'do the thing', model: 'unknown-grade' },
      });
      expect(invalid).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
        targetName: 'agent_like',
      });

      const result = await resolveDeferredToolCall(registry, {
        name: 'agent_like',
        arguments: { prompt: 'do the thing', model: 'fast' },
      });

      expect(result).not.toHaveProperty('error');
      expect(result).toMatchObject({
        arguments: { prompt: 'do the thing', model: 'fast' },
      });
    });

    it('pre-checks only the schema layer, leaving value-level rules to build()', async () => {
      // The pre-check exists to name the target and the missing field in
      // the refusal (#12889); a target's value-level rules (fs stats,
      // content scans, the AgentTool refresh kick) must run exactly once,
      // at build() time — running them here would pay their side effects
      // twice per bridged call. Mutation check: routing the pre-check
      // through target.validateToolParams (schema + value rules) fires the
      // spy and turns this red.
      const valueRuleSpy = vi.fn(
        (_params: { [key: string]: unknown }): string | null => null,
      );
      class ValueRuleTool extends MockTool {
        protected override validateToolParamValues(params: {
          [key: string]: unknown;
        }): string | null {
          return valueRuleSpy(params);
        }
      }
      const target = new ValueRuleTool({
        name: 'write_file',
        shouldDefer: true,
        params: {
          type: 'object',
          properties: { file_path: { type: 'string' } },
          required: ['file_path'],
        },
      });

      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        { name: 'write_file', arguments: { file_path: '/tmp/a.txt' } },
      );

      expect(result).not.toHaveProperty('error');
      expect(valueRuleSpy).not.toHaveBeenCalled();
    });

    // The shared native shape of the omni media-policy family: io params
    // with `resourceId` as the model-facing `inputPath` alternative, and
    // only `outputDir` required natively (0 of the 14 shipped tools require
    // inputPath — the call gate resolves resourceId → inputPath before
    // build() validates).
    const mediaPolicyNativeSchema = {
      type: 'object',
      properties: {
        inputPath: { type: 'string' },
        resourceId: { type: 'string' },
        outputDir: { type: 'string' },
      },
      required: ['outputDir'],
      additionalProperties: false,
    };

    // A MockTool carrying the real media-policy split: `schema` is derived
    // through the production projector (locked keys stripped from properties
    // AND required) instead of a hand-written literal, while
    // `validateToolParams` keeps checking the NATIVE schema plus the io
    // value rule, exactly like BaseMediaPolicyTool
    // (omni/policy/tools/media-policy-tool.ts).
    class MockMediaPolicyTool extends MockTool {
      constructor(private readonly lockedArguments: Record<string, unknown>) {
        super({
          name: 'omni_transcribe_audio',
          shouldDefer: true,
          params: mediaPolicyNativeSchema,
        });
      }

      override get mediaPolicyDescriptor(): MediaPolicyToolDescriptor {
        return {
          kind: 'media_policy',
          inputMediaTypes: ['audio'],
          outputs: [{ kind: 'media', required: true }],
        };
      }

      override get schema() {
        return projectMediaPolicyToolDeclaration(
          {
            getOmniPolicyToolsSettings: () => ({
              [this.name]: {
                modelAccess: {
                  enabled: true,
                  lockedArguments: this.lockedArguments,
                },
              },
            }),
          },
          {
            name: this.name,
            description: this.description,
            parametersJsonSchema: mediaPolicyNativeSchema,
          },
        );
      }

      override validateToolParams(params: {
        [key: string]: unknown;
      }): string | null {
        return (
          SchemaValidator.validate(mediaPolicyNativeSchema, params) ??
          validateMediaPolicyIoParams(params as unknown as MediaPolicyIoParams)
        );
      }
    }

    it('resolves a media-policy target whose arguments the policy gate completes', async () => {
      // The projection split a media-policy tool creates: `schema` is the
      // model-visible declaration (an operator `modelAccess.lockedArguments`
      // key stripped from BOTH properties and required), while
      // `validateToolParams` keeps checking the NATIVE schema. The model is
      // therefore correct to omit `outputDir`, and the modelAccess gate —
      // which both frontends run AFTER bridge resolution — merges it back
      // in. Pre-checking the raw arguments against the native schema refuses
      // a call the next stage accepts, and sending the locked key instead
      // makes the gate refuse it: unwinnable both ways. Mutation check:
      // dropping the media-policy branch in resolveDeferredToolCall turns
      // this red.
      const target = new MockMediaPolicyTool({ outputDir: '/locked/out' });
      // The mock really carries the split the defect needs, derived through
      // the real projector rather than pinned as a literal: the locked key
      // leaves properties and required, the rest of the surface stays.
      const projection = target.schema.parametersJsonSchema as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(projection.properties).toHaveProperty('inputPath');
      expect(projection.properties).not.toHaveProperty('outputDir');
      expect(projection.required ?? []).not.toContain('outputDir');
      expect(target.validateToolParams({ inputPath: '/tmp/in.wav' })).toContain(
        "'outputDir'",
      );

      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        {
          name: 'omni_transcribe_audio',
          arguments: { inputPath: '/tmp/in.wav' },
        },
      );

      expect(result).not.toHaveProperty('error');
      expect(result).not.toHaveProperty('errorType');
      expect(result).toMatchObject({
        tool: expect.objectContaining({ name: 'omni_transcribe_audio' }),
        arguments: { inputPath: '/tmp/in.wav' },
      });
    });

    it('resolves a media-policy target called with a resourceId handle and no inputPath', async () => {
      // The call shape omni/media-guidance.ts instructs the model to send:
      // an opaque session media handle instead of inputPath (the gate
      // resolves it to inputPath AFTER bridge resolution), with the locked
      // outputDir omitted. The bridge must not apply the native schema or
      // the io value rule here — both demand fields only the gate supplies.
      // Mutation check: removing the media-policy branch, or pre-checking
      // the native schema, refuses this on the locked outputDir.
      const target = new MockMediaPolicyTool({ outputDir: '/locked/out' });
      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        {
          name: 'omni_transcribe_audio',
          arguments: { resourceId: 'media-1-abcd' },
        },
      );

      expect(result).not.toHaveProperty('error');
      expect(result).not.toHaveProperty('errorType');
      expect(result).toMatchObject({
        tool: expect.objectContaining({ name: 'omni_transcribe_audio' }),
        arguments: { resourceId: 'media-1-abcd' },
      });
    });

    it('refuses a media-policy target whose arguments miss a model-visible required field', async () => {
      // With no lockedArguments the projection is the native schema, so a
      // bridged `{}` must still be refused here — naming the target and the
      // missing field — instead of surfacing a bare Ajv message from build()
      // under the wrapper name. Mutation check: skipping validation for
      // media-policy targets turns this red.
      const target = new MockMediaPolicyTool({});
      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        { name: 'omni_transcribe_audio', arguments: {} },
      );

      expect(result).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
        targetName: 'omni_transcribe_audio',
      });
      if ('error' in result) {
        expect(result.error.message).toContain('"omni_transcribe_audio"');
        expect(result.error.message).toContain("'outputDir'");
      }
    });

    it('resolves a target whose schema access throws, leaving the throw to build()', async () => {
      // A target whose declaration throws under the pre-check must not
      // become a new bridge failure mode: the scheduler's build() reports
      // the same throw as before. Mutation check: dropping the try/catch
      // around the pre-check turns this red.
      class ThrowingSchemaTool extends MockTool {
        override get schema(): never {
          throw new Error('boom from schema access');
        }
      }
      const target = new ThrowingSchemaTool({
        name: 'throwing_tool',
        shouldDefer: true,
        params: { type: 'object', properties: {} },
      });

      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        { name: 'throwing_tool', arguments: {} },
      );

      expect(result).not.toHaveProperty('error');
      expect(result).toMatchObject({
        tool: expect.objectContaining({ name: 'throwing_tool' }),
        arguments: {},
      });
    });
  });
});
