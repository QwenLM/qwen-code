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

    it('keeps invoking a tool never reviewed in this session by name', async () => {
      const result = await resolveReviewed(target('cron_list'), 'cron_list');

      expect(result).toMatchObject(resolvedTo('cron_list'));
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

    // Same tolerance one level down: todo_write's item schema declares
    // additionalProperties: false while its own validateToolParams only
    // type-checks the known keys, so a nested surplus key must not trip the
    // pre-check either.
    const makeTodoLike = (Tool: typeof MockTool = MockTool) =>
      new Tool({
        name: 'todo_like',
        shouldDefer: true,
        params: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  content: { type: 'string' },
                  status: { type: 'string', enum: ['pending', 'completed'] },
                },
                required: ['id', 'content', 'status'],
                additionalProperties: false,
              },
            },
          },
          required: ['todos'],
          additionalProperties: false,
        },
      });

    it('leaves nested surplus-key enforcement to the target without changing its schema', async () => {
      // Mutation check: relaxing only the top-level additionalProperties
      // turns this red with "must NOT have additional properties".
      class LenientTool extends MockTool {
        override validateToolParams(): string | null {
          return null;
        }
      }
      for (const Tool of [MockTool, LenientTool]) {
        const target = makeTodoLike(Tool);
        const result = await resolveDeferredToolCall(
          makeRegistry([target], new Set([target.name])),
          {
            name: target.name,
            arguments: {
              todos: [
                {
                  id: '1',
                  content: 'write the test',
                  status: 'pending',
                  priority: 'high',
                },
              ],
            },
          },
        );
        expect(result).not.toHaveProperty('error');
        expect(JSON.stringify(target.schema.parametersJsonSchema)).toContain(
          '"additionalProperties":false',
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

    it('still refuses nested schema violations when surplus keys are tolerated', async () => {
      const target = makeTodoLike();
      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        {
          name: target.name,
          arguments: {
            todos: [
              {
                id: '1',
                content: 'write the test',
                status: 'bogus',
                priority: 'high',
              },
            ],
          },
        },
      );

      expect(result).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
        targetName: 'todo_like',
      });
      if ('error' in result) {
        expect(
          result.error.message.startsWith(DEFERRED_TOOL_CALL_REFUSAL_PREFIX),
        ).toBe(true);
        expect(result.error.message).toContain(
          'must be equal to one of the allowed values',
        );
      }
    });

    // A deferred and hidden MCP target publishes its server's inputSchema
    // unmodified, and per-branch `additionalProperties: false` is the standard
    // generated tagged-union idiom: the branches are told apart BY the keyword.
    const makeTaggedUnionLike = () =>
      new MockTool({
        name: 'mcp__srv__union',
        shouldDefer: true,
        params: {
          type: 'object',
          oneOf: [
            {
              properties: { a: { type: 'string' } },
              required: ['a'],
              additionalProperties: false,
            },
            {
              properties: { a: { type: 'string' }, b: { type: 'string' } },
              required: ['a'],
              additionalProperties: false,
            },
          ],
        },
      });

    it('resolves a tagged union whose branches are told apart by additionalProperties', async () => {
      // R8-1: a rewrite keyed on the property name alone also flipped the
      // keyword INSIDE each oneOf branch, so {a, b} matched both branches and
      // oneOf (exactly one) failed. The pre-check then refused a call the
      // target's own schema and build() both accept, and — because targetName
      // is populated — booked a parameter-error strike toward RETRY LOOP
      // DETECTED for a tool that works. Mutation check: descending into
      // composition keywords turns this red with "must match exactly one
      // schema in oneOf".
      const target = makeTaggedUnionLike();
      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        { name: target.name, arguments: { a: 'x', b: 'y' } },
      );

      expect(result).not.toHaveProperty('error');
      expect(result).toMatchObject({ arguments: { a: 'x', b: 'y' } });
      // Relaxing happens on a clone: the target's published schema is intact.
      expect(JSON.stringify(target.schema.parametersJsonSchema)).toContain(
        '"additionalProperties":false',
      );
      if ('tool' in result) {
        expect(() => result.tool.build(result.arguments)).not.toThrow();
      }
    });

    it('still refuses a tagged-union call that matches no branch', async () => {
      // Preserving the branches is not the same as disabling the pre-check:
      // `{b}` satisfies neither branch's `required: ['a']`, so it must still be
      // refused and attributed to the target.
      const target = makeTaggedUnionLike();
      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        { name: target.name, arguments: { b: 'y' } },
      );

      expect(result).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
        targetName: 'mcp__srv__union',
      });
      expect(result).not.toHaveProperty('tool');
      if ('error' in result) {
        expect(
          result.error.message.startsWith(DEFERRED_TOOL_CALL_REFUSAL_PREFIX),
        ).toBe(true);
        expect(result.error.message).toContain('"mcp__srv__union"');
      }
    });

    it('leaves annotation data that looks like the keyword alone', async () => {
      // Same inversion one class over: `const` holds data the schema compares
      // against, so rewriting the keyword inside it makes the pre-check demand
      // a value the authored schema rejects.
      const target = new MockTool({
        name: 'annotated_target',
        shouldDefer: true,
        params: {
          type: 'object',
          properties: {
            config: { const: { additionalProperties: false } },
          },
          required: ['config'],
        },
      });
      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        {
          name: target.name,
          arguments: { config: { additionalProperties: false } },
        },
      );

      expect(result).not.toHaveProperty('error');
    });

    it('reads a property named additionalProperties as a name, not the keyword', async () => {
      // Keys of a name-to-schema map are data. The authored schema forbids this
      // property outright, so the pre-check must keep refusing it rather than
      // relax the prohibition away.
      const target = new MockTool({
        name: 'named_property_target',
        shouldDefer: true,
        params: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            additionalProperties: false,
          },
          required: ['prompt'],
        },
      });
      const result = await resolveDeferredToolCall(
        makeRegistry([target], new Set([target.name])),
        {
          name: target.name,
          arguments: { prompt: 'investigate', additionalProperties: true },
        },
      );

      expect(result).toMatchObject({
        errorType: ToolErrorType.INVALID_TOOL_PARAMS,
        targetName: 'named_property_target',
      });
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
