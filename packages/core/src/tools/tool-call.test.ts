/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MockTool } from '../test-utils/mock-tool.js';
import { runWithAgentContext } from '../agents/runtime/agent-context.js';
import { runWithTeammateIdentity } from '../agents/team/identity.js';
import {
  deferredDeclarationFingerprint,
  type ToolRegistry,
} from './tool-registry.js';
import type { AnyDeclarativeTool } from './tools.js';
import {
  DEFERRED_TOOL_CALL_REFUSAL_PREFIX,
  describeBridgedArgumentError,
  resolveDeferredToolCall,
  ToolCallTool,
} from './tool-call.js';
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
  const { withToolSearch = true } = options;
  // Unless a test says otherwise, every tool it passes counts as reviewed:
  // tool_call refuses a hidden tool whose schema is not in context (#12569).
  const reviewed =
    options.reviewed ??
    new Map(
      tools.map((tool) => [tool.name, deferredDeclarationFingerprint(tool)]),
    );
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
    getReviewedDeclaration: (name: string) => reviewed.get(name),
  } as unknown as ToolRegistry;
}

const target = (name: string, shouldDefer = true) =>
  new MockTool({ name, shouldDefer });

type ResolveOpts = {
  args?: Record<string, unknown>;
  visible?: boolean;
  worker?: boolean;
  withToolSearch?: boolean;
  reviewed?: ReadonlyMap<string, string>;
  depth?: { maxSubagentDepth: number };
};
/**
 * Resolves `{ name, arguments: args ?? {} }` through a registry of `targets`,
 * each registered hidden unless `visible`; `worker` runs the call inside a
 * subagent agent frame, `depth` is passed as the resolver's third argument.
 */
function resolveVia(targets: MockTool[], name: string, opts: ResolveOpts = {}) {
  const hidden = new Set(opts.visible ? [] : targets.map((t) => t.name));
  const registry = makeRegistry(targets, hidden, {
    withToolSearch: opts.withToolSearch,
    reviewed: opts.reviewed,
  });
  const call = () =>
    resolveDeferredToolCall(
      registry,
      { name, arguments: opts.args ?? {} },
      opts.depth,
    );
  return opts.worker ? runWithAgentContext('worker', call) : call();
}

/**
 * `resolveVia` with one target `name`: deferred and hidden, or with `visible`
 * non-deferred and registered visible (as real control-plane tools are).
 * `as` is the spelling the call uses.
 */
const resolveOne = (name: string, opts: ResolveOpts & { as?: string } = {}) =>
  resolveVia([target(name, !opts.visible)], opts.as ?? name, opts);

/** A refusal: `errorType` plus an error whose message contains `text`. */
const refusal = (errorType: ToolErrorType, text: string) => ({
  errorType,
  error: expect.objectContaining({ message: expect.stringContaining(text) }),
});
/** A resolution to the tool `name`, with exactly `args` when given. */
const resolvedTo = (name: string, args?: Record<string, unknown>) => ({
  tool: expect.objectContaining({ name }),
  ...(args !== undefined ? { arguments: args } : {}),
});
const NOT_AVAILABLE = refusal(
  ToolErrorType.EXECUTION_DENIED,
  'not available to this agent',
);

describe('describeBridgedArgumentError', () => {
  it('names the target, the bridge and where to read the schema', () => {
    expect(
      describeBridgedArgumentError(
        'web_fetch',
        "params must have required property 'url'.",
      ),
    ).toBe(
      `Deferred tool "web_fetch" (called through ${ToolNames.TOOL_CALL}) rejected the arguments: params must have required property 'url'. Pass arguments matching the schema returned by ${ToolNames.TOOL_SEARCH} for "web_fetch".`,
    );
  });
});

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
      const result = await resolveVia([], name);

      expect(result).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
      });
      // Pin the recursive-bridge guard by its message: the downstream
      // isDeferredAndHidden rejection also returns INVALID_TOOL_PARAMS, so
      // errorType alone survives deleting it (wenshao verification note 2).
      if ('error' in result) {
        expect(
          result.error.message.startsWith(DEFERRED_TOOL_CALL_REFUSAL_PREFIX),
        ).toBe(true);
        expect(result.error.message).toContain('cannot invoke bridge tool');
      }
    },
  );

  it('rejects an unknown deferred target', async () => {
    // Present-side remedy: with tool_search registered the denial points back
    // at discovery; dropping the suffix turns this red (absent-side twin:
    // 'does not suggest tool_search...' below) — round-5 deferred item.
    expect(await resolveVia([], 'missing_tool')).toMatchObject(
      refusal(ToolErrorType.TOOL_NOT_REGISTERED, 'Run tool_search again'),
    );
  });

  it('resolves a target case-insensitively like the discovery half', async () => {
    // tool_search's select: resolves names case-insensitively; the invocation
    // half must agree, or a schema reviewed as e.g. `Read_File` is not
    // callable through the bridge (round-5 deferred item). Removing the
    // case-insensitive fallback in resolveDeferredToolCall turns this red.
    const result = await resolveOne('deferred_target', {
      as: 'Deferred_Target',
      args: { foo: 'baz' },
    });

    expect(result).toMatchObject(resolvedTo('deferred_target', { foo: 'baz' }));
  });

  describe('names that differ only by case (#11321)', () => {
    const first = target('deferred_target');
    const second = target('Deferred_Target');

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
        const result = await resolveVia([...order], requestedName);

        expect(result).toMatchObject(resolvedTo(requestedName));
      },
    );

    it('refuses a spelling that matches several tools only by case', async () => {
      const result = await resolveVia([first, second], 'DEFERRED_TARGET');

      expect(result).toMatchObject(
        refusal(
          ToolErrorType.INVALID_TOOL_PARAMS,
          'matches more than one registered tool by case (Deferred_Target, deferred_target)',
        ),
      );
      expect(result).not.toHaveProperty('tool');
    });
  });

  describe('a tool that changed after tool_search returned it (#11321)', () => {
    const reviewedParams = {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id'],
    };
    const lookup = (description: string, params: object) =>
      new MockTool({
        name: 'mcp_lookup',
        description,
        shouldDefer: true,
        params,
      });
    const reviewedTool = lookup('Look up a record by id.', reviewedParams);
    const reviewed = new Map([
      [reviewedTool.name, deferredDeclarationFingerprint(reviewedTool)],
    ]);
    const resolveReviewed = (tool: MockTool, name: string, args = {}) =>
      resolveVia([tool], name, { args, reviewed });
    const CHANGED = {
      ...refusal(
        ToolErrorType.INVALID_TOOL_PARAMS,
        'changed since tool_search last returned it. Run tool_search with select:mcp_lookup',
      ),
      targetName: 'mcp_lookup',
    };

    it('invokes the tool when its declaration is unchanged', async () => {
      const result = await resolveReviewed(reviewedTool, 'mcp_lookup', {
        id: 1,
      });

      expect(result).toMatchObject({ arguments: { id: 1 } });
    });

    it('invokes the tool when only its description changed', async () => {
      // Deferred tools rebuild their description on every `schema` access
      // (WebSearchTool: current month/year, web-search.ts:997-1004;
      // ReadFileTool: CURRENT input modalities, read-file.ts:628-637) so a
      // long-lived `qwen serve`/ACP process is not stale. Prose drift across a
      // month boundary or a `/model` switch must not arm a false "changed"
      // refusal against an identical parameter contract.
      const sameContractNewProse = lookup(
        'Look up a record by id. (October 2026)',
        reviewedParams,
      );
      const result = await resolveReviewed(sameContractNewProse, 'mcp_lookup', {
        id: 1,
      });

      expect(result).toMatchObject(resolvedTo('mcp_lookup', { id: 1 }));
    });

    it('refuses and asks for a fresh review when the parameter contract changed', async () => {
      const replaced = lookup('Delete a record by id.', {
        type: 'object',
        properties: { id: { type: 'string' }, purge: { type: 'boolean' } },
        required: ['id'],
      });
      const result = await resolveReviewed(replaced, 'mcp_lookup', { id: 1 });

      expect(result).toMatchObject(CHANGED);
    });

    it('refuses a case-variant spelling of a tool whose resolved declaration changed', async () => {
      // tool_search records under the REGISTERED name while models may call a
      // spelling that needs resolution, so the lookup keys on the resolved
      // target; keyed on the raw envelope name it finds no review and runs
      // arguments written against the stale schema.
      const replaced = lookup('Delete a record by id.', {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      });
      const result = await resolveReviewed(replaced, 'MCP_LOOKUP', { id: 1 });

      expect(result).toMatchObject(CHANGED);
    });

    it('refuses a tool whose schema is not in context instead of running it by name (#12569)', async () => {
      // Never returned by tool_search, or returned before a compaction,
      // /clear or rewind cleared the review: either way the model is writing
      // arguments without the schema.
      const unreviewed = new MockTool({ name: 'cron_list', shouldDefer: true });
      const result = await resolveDeferredToolCall(
        makeRegistry([unreviewed], new Set([unreviewed.name]), { reviewed }),
        { name: 'cron_list', arguments: {} },
      );

      expect(result).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
        targetName: 'cron_list',
        error: expect.objectContaining({
          message: expect.stringContaining(
            'has no verified schema review in the current context. Run tool_search with select:cron_list',
          ),
        }),
      });
      expect(result).not.toHaveProperty('tool');
    });

    it('runs the same tool once its unchanged schema is reviewed', async () => {
      const unreviewed = new MockTool({ name: 'cron_list', shouldDefer: true });
      const result = await resolveDeferredToolCall(
        makeRegistry([unreviewed], new Set([unreviewed.name]), {
          reviewed: new Map([
            [unreviewed.name, deferredDeclarationFingerprint(unreviewed)],
          ]),
        }),
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
    expect(await resolveVia([], 'Tool_Call')).toMatchObject(
      refusal(ToolErrorType.INVALID_TOOL_PARAMS, 'cannot invoke bridge tool'),
    );
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
    ).resolves.toMatchObject(
      refusal(ToolErrorType.TOOL_NOT_REGISTERED, 'factory failed'),
    );
  });

  it('enforces subagent plan-tool restrictions', async () => {
    // The real enter_plan_mode is shouldDefer=false (enterPlanMode.ts: "always
    // visible so explicit plan-mode requests work"), so the fixture is NOT
    // hidden: the denial must come from the plan-lifecycle check AHEAD of the
    // isDeferredAndHidden gate. Removing that check, or moving the exclusion
    // check ahead of it, turns this red (round-5 review, R5-2/R5-4).
    const result = await resolveOne(ToolNames.ENTER_PLAN_MODE, {
      visible: true,
      worker: true,
    });

    // Pin the plan-lifecycle message: the exclusion check also denies plan
    // tools (members via SUBAGENT_PLAN_LIFECYCLE_TOOLS), so errorType alone
    // survives that check being deleted or shadowed and the guidance silently
    // becoming the generic denial (round-5 review, R5-4).
    expect(result).toMatchObject(
      refusal(
        ToolErrorType.EXECUTION_DENIED,
        'Plan mode is owned by the caller',
      ),
    );
  });

  it('rejects a leader-only target bridged from a subagent context', async () => {
    // Registered NOT hidden: real control-plane tools are not deferred, so
    // the denial must come from the leader-only check ahead of the deferred
    // gate (round-5 review, R5-2).
    const result = await resolveOne(ToolNames.TEAM_PLAN_APPROVAL, {
      visible: true,
      worker: true,
    });

    expect(result).toMatchObject(
      refusal(
        ToolErrorType.EXECUTION_DENIED,
        'only available to the team leader',
      ),
    );
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
      // prepareTools enforces it for declarations, but the bridge decouples
      // invocation from declaration, so without it a wildcard/general-purpose
      // subagent could run control-plane tools (team_delete, workflow).
      // Removing the check in resolveDeferredToolCall must turn this red.
      // Real shape (round-5 review, R5-2): these tools default shouldDefer to
      // false, so the fixture is NOT hidden and the denial must come from the
      // exclusion check ahead of the isDeferredAndHidden gate, not the wrong
      // "already visible — call it directly" INVALID_TOOL_PARAMS.
      const result = await resolveOne(toolName, {
        visible: true,
        worker: true,
      });

      expect(result).toMatchObject(NOT_AVAILABLE);
    },
  );

  it('discriminates the context-aware exclusion selector for teammates', async () => {
    // R5-3: with only shared-set members tested, replacing the selector with
    // either raw set survives the suite. A teammate's send_message must
    // RESOLVE (teammate set allows it) while team_delete stays denied.
    const identity = {
      agentId: 'worker@test-team',
      agentName: 'worker',
      teamName: 'test-team',
      isTeamLead: false,
    };

    const resolved = await runWithTeammateIdentity(identity, () =>
      resolveOne(ToolNames.SEND_MESSAGE, { args: { to: 'lead' } }),
    );
    expect(resolved).toMatchObject(
      resolvedTo(ToolNames.SEND_MESSAGE, { to: 'lead' }),
    );

    const refused = await runWithTeammateIdentity(identity, () =>
      resolveOne(ToolNames.TEAM_DELETE),
    );
    expect(refused).toMatchObject(NOT_AVAILABLE);
  });

  it('resolves a non-excluded deferred target from inside an agent frame', async () => {
    // R5-5 allow side (1): the exclusion gate must not degrade into a
    // blanket "agent frame denies everything" — the bridge exists precisely
    // so subagents can reach deferred tools (MCP, tools.eager-demoted).
    // Mutation check: an agent-frame blanket denial turns this red.
    const result = await resolveOne('deferred_target', {
      args: { foo: 'bar' },
      worker: true,
    });

    expect(result).toMatchObject(resolvedTo('deferred_target', { foo: 'bar' }));
  });

  it('does not apply the exclusion gate to the leader session', async () => {
    // R5-5 allow side (2): outside any agent frame and teammate identity the
    // gate must not fire — a leader whose tools.eager allowlist demoted
    // team_delete to deferred+hidden still bridges it legitimately.
    // Mutation check: removing the isSubagentLikeExecutionContext() gate (or
    // applying the check unconditionally) turns this red.
    const result = await resolveOne(ToolNames.TEAM_DELETE);

    expect(result).toMatchObject(resolvedTo(ToolNames.TEAM_DELETE));
  });

  it('rejects an exclusion-set target bridged via its legacy alias', async () => {
    // R5-6: exclusion membership must be keyed on the CANONICAL target.name,
    // not the raw envelope name — 'task' is the documented legacy alias of
    // 'agent' (tool-names.ts), and 'agent' is in both exclusion sets.
    // Mutation check: keying the membership test on invocation.params.name
    // turns this red ('task' is not a set member and would resolve).
    const result = await resolveOne(ToolNames.AGENT, {
      as: 'task',
      worker: true,
    });

    expect(result).toMatchObject(NOT_AVAILABLE);
  });

  it('re-admits agent to a subagent while the nesting depth permits', async () => {
    // Round-5 review, R4-1 follow-up: prepareTools re-admits AgentTool while
    // spawnBlockReason === null and the bridge must mirror that, not flatly
    // deny: a depth-0 subagent under the default max depth 5 may spawn to
    // level 2, so a deferred+hidden agent resolves. The flat exclusion (no
    // AGENT special case) turns this red.
    const result = await resolveOne(ToolNames.AGENT, {
      args: { prompt: 'nested' },
      worker: true,
      depth: { maxSubagentDepth: DEFAULT_MAX_SUBAGENT_DEPTH },
    });

    expect(result).toMatchObject(
      resolvedTo(ToolNames.AGENT, { prompt: 'nested' }),
    );
  });

  it('still denies agent when the nesting depth is exhausted', async () => {
    // Companion to the re-admission case: with maxSubagentDepth=1 a depth-0
    // subagent's child would sit at level 2 > 1, so the denial stands.
    const result = await resolveOne(ToolNames.AGENT, {
      worker: true,
      depth: { maxSubagentDepth: 1 },
    });

    expect(result).toMatchObject(NOT_AVAILABLE);
  });

  it('fails closed on agent when maxSubagentDepth is unknown', async () => {
    // The raw-set floor: without the configured depth threaded through, the
    // bridge cannot verify the spawn policy and keeps AgentTool excluded —
    // the documented fail-closed floor of EXCLUDED_TOOLS_FOR_SUBAGENTS.
    const result = await resolveOne(ToolNames.AGENT, { worker: true });

    expect(result).toMatchObject(NOT_AVAILABLE);
  });

  it('resolves a hidden deferred target while both bridge tools are registered', async () => {
    const result = await resolveOne('deferred_target', {
      args: { foo: 'bar' },
    });

    expect(result).toMatchObject(resolvedTo('deferred_target', { foo: 'bar' }));
  });

  it('rejects a hidden deferred target when tool_search is not registered', async () => {
    const result = await resolveOne('deferred_target', {
      withToolSearch: false,
    });

    expect(result).toMatchObject(
      refusal(ToolErrorType.EXECUTION_DENIED, 'unreachable'),
    );
  });

  it('rejects a registered-but-undeclared target via the capability gate', async () => {
    // R27-3: every other reachability reader (tool_search's select: too)
    // enforces isToolDeclared, the capability gate (propose_goal is registered
    // but undeclared until a turn with a responder); the invocation half must
    // agree, or tool_call runs a target the model was never offered. Removing
    // the gate turns this red; ordinary declared tools stay resolvable, so it
    // cannot degrade into a blanket denial.
    const gated = target(ToolNames.PROPOSE_GOAL);
    const ordinary = target('deferred_target');
    const registry = makeRegistry(
      [gated, ordinary],
      new Set([gated.name, ordinary.name]),
    );
    registry.isToolDeclared = (name: string) => name !== ToolNames.PROPOSE_GOAL;

    const denied = await resolveDeferredToolCall(registry, {
      name: gated.name,
      arguments: {},
    });
    expect(denied).toMatchObject(
      refusal(ToolErrorType.EXECUTION_DENIED, ToolNames.PROPOSE_GOAL),
    );

    const allowed = await resolveDeferredToolCall(registry, {
      name: ordinary.name,
      arguments: { foo: 'bar' },
    });
    expect(allowed).toMatchObject(resolvedTo(ordinary.name, { foo: 'bar' }));
  });

  it('does not suggest tool_search for unknown targets when it is absent', async () => {
    const result = await resolveVia([], 'missing_tool', {
      withToolSearch: false,
    });

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
