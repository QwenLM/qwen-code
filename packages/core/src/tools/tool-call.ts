/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AnyDeclarativeTool,
  ToolInvocation,
  ToolResult,
} from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import {
  canonicalToolName,
  resolveRegisteredToolName,
  ToolDisplayNames,
  ToolNames,
} from './tool-names.js';
import {
  deferredDeclarationFingerprint,
  type ToolRegistry,
} from './tool-registry.js';
import { SchemaValidator } from '../utils/schemaValidator.js';
import {
  getExcludedToolUnavailableMessage,
  getLeaderOnlyToolUnavailableMessage,
  getSubagentPlanToolUnavailableMessage,
  isLeaderOnlyToolUnavailableInSubagent,
  isPlanLifecycleToolUnavailableInSubagent,
  isSubagentLikeExecutionContext,
  isToolExcludedForCurrentContext,
} from '../agents/runtime/subagent-plan-tool-policy.js';

export interface ToolCallParams {
  name: string;
  arguments: Record<string, unknown>;
}

export type DeferredToolCallResolution =
  | {
      tool: AnyDeclarativeTool;
      arguments: Record<string, unknown>;
    }
  | {
      error: Error;
      errorType: ToolErrorType;
      /** Validated target identity for per-tool parameter-error accounting. */
      targetName?: string;
    };

export interface DeferredToolCallOptions {
  /** Omission keeps AgentTool excluded in subagent contexts. */
  maxSubagentDepth?: number;
  /**
   * Set when the model's response was cut by max_tokens. The bridged
   * arguments may be incomplete for transport reasons rather than a schema
   * misreading, so the argument pre-check must yield to the caller's
   * truncation-aware handling (the scheduler rejects truncated Edit-kind
   * calls outright and appends truncation guidance to build-time validation
   * failures) instead of reporting a schema mismatch.
   */
  wasOutputTruncated?: boolean;
  /**
   * The caller's per-target execution policy (scheduler execution allowlist
   * / permission-manager enablement). Consulted before the argument
   * pre-check so a denied target keeps its specific EXECUTION_DENIED refusal
   * instead of surfacing a parameter error for a call that could never run.
   */
  isTargetExecutionAllowed?: (targetName: string) => boolean | Promise<boolean>;
  /**
   * Set when the caller applies its own target policy downstream of
   * resolution (the scheduler's permission-manager gate) with a richer
   * denial message than the bridge can build. Returning true skips the
   * argument pre-check for that target so the caller's own denial — not a
   * parameter error for a call that could never run — is what the model
   * sees.
   */
  suppressArgumentPreCheck?: (targetName: string) => boolean | Promise<boolean>;
  /** Media-policy fields supplied by the caller's downstream modelAccess gate. */
  getDefaultArgumentNames?: (targetName: string) => readonly string[];
}

export const DEFERRED_TOOL_CALL_REFUSAL_PREFIX = '[tool_call bridge refused] ';
export const DEFERRED_TOOL_CALL_CANCELLATION_PREFIX =
  '[tool_call bridge cancelled] ';

function bridgeRefusal(message: string): Error {
  return new Error(`${DEFERRED_TOOL_CALL_REFUSAL_PREFIX}${message}`);
}

/**
 * Schema keywords whose subtree the relaxation below must leave byte-identical.
 * `oneOf`/`not` discriminate: a per-branch `additionalProperties: false` tells
 * branches apart, so relaxing it there inverts the schema's meaning instead of
 * widening acceptance (`if` selects a branch by the same mechanism). Annotation
 * keywords hold data the schema compares against, not a subschema. `$defs` and
 * `definitions` are reached only through `$ref`: they are shared definitions,
 * and relaxing inside one silently rewrites every branch that references it —
 * each use site is already covered directly by the walk above.
 * (`allOf`/`anyOf`/`then`/`else` are deliberately absent: relaxing under them
 * only widens acceptance, so the walk descends.)
 */
const VERBATIM_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  'oneOf',
  'not',
  'if',
  'const',
  'default',
  'enum',
  'example',
  'examples',
  '$defs',
  'definitions',
]);

/**
 * Schema keywords whose value maps an arbitrary NAME to a subschema or
 * constraint. The names are data, so a property literally named
 * `additionalProperties` keeps its own schema rather than being read as the
 * keyword: these are walked by value only.
 */
const NAME_TO_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  'dependencies',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

/** Relaxes `additionalProperties: false` in an already-cloned schema tree. */
function relaxAdditionalPropertiesInPlace(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      relaxAdditionalPropertiesInPlace(item);
    }
    return;
  }
  if (!node || typeof node !== 'object') {
    return;
  }
  const schema = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(schema)) {
    if (VERBATIM_SCHEMA_KEYS.has(key)) {
      continue;
    }
    if (NAME_TO_SCHEMA_KEYS.has(key)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const byName = value as Record<string, unknown>;
        for (const subschema of Object.values(byName)) {
          relaxAdditionalPropertiesInPlace(subschema);
        }
      }
      continue;
    }
    if (key === 'additionalProperties' && value === false) {
      schema[key] = true;
      continue;
    }
    relaxAdditionalPropertiesInPlace(value);
  }
}

/**
 * Deep-clones a target schema with `additionalProperties: false` relaxed at
 * every position where relaxing only widens acceptance. Some targets
 * deliberately tolerate surplus keys (for example, Agent's `name` outside team
 * mode, or todo_write's item-level extra fields), so that decision is left to
 * their own build(): a nested `additionalProperties: false` (todo_write's items
 * schema) must not refuse bridged calls the target's own validator accepts.
 *
 * The walk is structural rather than keyed on the property name alone, because
 * a name-keyed rewrite also reaches the positions listed in
 * `VERBATIM_SCHEMA_KEYS` and `NAME_TO_SCHEMA_KEYS`, where it makes the
 * pre-check STRICTER than the schema the target publishes: an input matching
 * exactly one `oneOf` branch then matches two and `oneOf` fails, and a `const`
 * branch compares against rewritten data.
 */
function relaxAdditionalProperties(schema: unknown): Record<string, unknown> {
  // The JSON round-trip deep-clones, so the walk can relax in place and never
  // touches the target's own schema object (which it may mutate and reuse).
  const clone = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  relaxAdditionalPropertiesInPlace(clone);
  return clone;
}

export async function resolveDeferredToolCall(
  registry: ToolRegistry,
  envelope: Record<string, unknown>,
  options?: DeferredToolCallOptions,
): Promise<DeferredToolCallResolution> {
  let bridge: AnyDeclarativeTool | undefined;
  try {
    bridge = await registry.ensureTool(ToolNames.TOOL_CALL);
  } catch (error) {
    return {
      error: bridgeRefusal(
        `tool_call could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      ),
      errorType: ToolErrorType.TOOL_NOT_REGISTERED,
    };
  }
  if (!bridge) {
    return {
      error: bridgeRefusal('tool_call is not registered in this session.'),
      errorType: ToolErrorType.TOOL_NOT_REGISTERED,
    };
  }

  let invocation: ToolInvocation<ToolCallParams, ToolResult>;
  try {
    invocation = bridge.build(envelope) as ToolInvocation<
      ToolCallParams,
      ToolResult
    >;
  } catch (error) {
    return {
      error: bridgeRefusal(
        error instanceof Error ? error.message : String(error),
      ),
      errorType: ToolErrorType.INVALID_TOOL_PARAMS,
    };
  }

  let targetName = canonicalToolName(invocation.params.name);
  // Same resolution as tool_search's select: mode, so the tool invoked is
  // the tool whose schema was reviewed.
  const resolved = resolveRegisteredToolName(
    targetName,
    registry.getAllToolNames?.() ?? [],
  );
  if (Array.isArray(resolved)) {
    return {
      error: bridgeRefusal(
        `"${invocation.params.name}" matches more than one registered tool by case (${resolved.join(', ')}). Call tool_call with the exact name.`,
      ),
      errorType: ToolErrorType.INVALID_TOOL_PARAMS,
    };
  }
  if (resolved !== undefined) {
    targetName = resolved;
  }
  if (
    targetName === ToolNames.TOOL_CALL ||
    targetName === ToolNames.TOOL_SEARCH
  ) {
    return {
      error: bridgeRefusal(
        `tool_call cannot invoke bridge tool "${targetName}".`,
      ),
      errorType: ToolErrorType.INVALID_TOOL_PARAMS,
      targetName,
    };
  }

  let target: AnyDeclarativeTool | undefined;
  try {
    target = await registry.ensureTool(targetName);
  } catch (error) {
    return {
      error: bridgeRefusal(
        `Deferred tool "${invocation.params.name}" could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      ),
      errorType: ToolErrorType.TOOL_NOT_REGISTERED,
    };
  }
  if (!target) {
    // The remedy must not advertise a bridge half that is not registered in
    // this session (a `tool_search` deny rule or `--exclude-tools tool_search`
    // leaves tool_call as the only half).
    const remedy = registry.getTool(ToolNames.TOOL_SEARCH)
      ? ' Run tool_search again to inspect the available tools.'
      : ' No deferred-tool discovery is available in this session.';
    return {
      error: bridgeRefusal(
        `Deferred tool "${invocation.params.name}" is not registered in this session.${remedy}`,
      ),
      errorType: ToolErrorType.TOOL_NOT_REGISTERED,
    };
  }
  // Policy denials precede the hidden-tool gate because excluded control
  // tools are often non-deferred and need their specific denial messages.
  if (isPlanLifecycleToolUnavailableInSubagent(target.name)) {
    return {
      error: bridgeRefusal(getSubagentPlanToolUnavailableMessage(target.name)),
      errorType: ToolErrorType.EXECUTION_DENIED,
    };
  }
  if (isLeaderOnlyToolUnavailableInSubagent(target.name)) {
    return {
      error: bridgeRefusal(getLeaderOnlyToolUnavailableMessage(target.name)),
      errorType: ToolErrorType.EXECUTION_DENIED,
    };
  }
  // Reuse prepareTools's exclusion predicate so hidden invocation cannot
  // bypass the subagent/teammate declaration policy.
  if (
    isSubagentLikeExecutionContext() &&
    isToolExcludedForCurrentContext(target.name, options?.maxSubagentDepth)
  ) {
    return {
      error: bridgeRefusal(getExcludedToolUnavailableMessage(target.name)),
      errorType: ToolErrorType.EXECUTION_DENIED,
    };
  }
  // The caller's execution policy precedes the hidden-tool gate and the
  // argument pre-check: a denied target keeps its specific denial rather
  // than a parameter error for a call that could never run.
  if (
    options?.isTargetExecutionAllowed !== undefined &&
    !(await options.isTargetExecutionAllowed(target.name))
  ) {
    return {
      error: bridgeRefusal(
        `Tool "${target.name}" is not permitted by this agent's tool policy (execution allowlist or disallowedTools blocklist).`,
      ),
      errorType: ToolErrorType.EXECUTION_DENIED,
      targetName: target.name,
    };
  }

  if (!registry.isDeferredAndHidden(target.name)) {
    return {
      error: bridgeRefusal(
        `Tool "${target.name}" is already visible to the model or is not deferred. Call it directly instead of using tool_call.`,
      ),
      errorType: ToolErrorType.INVALID_TOOL_PARAMS,
      targetName: target.name,
    };
  }
  // Invocation must honor the same capability gate as declaration and
  // discovery. Test registries without the optional gate remain valid.
  if (registry.isToolDeclared?.(target.name) === false) {
    return {
      error: bridgeRefusal(
        `Deferred tool "${target.name}" is not declared in this session, so it cannot be invoked via tool_call.`,
      ),
      errorType: ToolErrorType.EXECUTION_DENIED,
    };
  }
  // The bridge has two halves: discovery (tool_search) and invocation
  // (tool_call). When tool_search is unregistered the hidden target cannot
  // be reviewed, and client.ts already reports such tools as unreachable for
  // the session — resolution must agree instead of invoking by name.
  if (!registry.getTool(ToolNames.TOOL_SEARCH)) {
    return {
      error: bridgeRefusal(
        `Deferred tool "${target.name}" is unreachable in this session: tool_search is not registered, so the ToolSearch + ToolCall bridge is incomplete and deferred tools cannot be invoked via tool_call.`,
      ),
      errorType: ToolErrorType.EXECUTION_DENIED,
    };
  }

  // The arguments must be written against a schema the model currently has.
  // A review is recorded when tool_search returns the schema and rebuilt
  // from surviving results after history replacement, so a tool
  // never reviewed here, or whose review left context with a compaction,
  // clear or rewind, is refused rather than run by name (#12569). A registry
  // that does not define the lookup at all is deliberately not gated: both
  // production callers (coreToolScheduler, the ACP Session) pass a
  // ToolRegistry, which always defines it, so only partial test registries
  // reach that branch.
  const reviewed = registry.getReviewedDeclaration?.(target.name);
  if (
    typeof registry.getReviewedDeclaration === 'function' &&
    reviewed === undefined
  ) {
    return {
      error: bridgeRefusal(
        `Deferred tool "${target.name}" has no verified schema review in the current context. Run tool_search with select:${target.name} and call it with the returned schema.`,
      ),
      errorType: ToolErrorType.INVALID_TOOL_PARAMS,
      targetName: target.name,
    };
  }
  // A hidden tool whose declaration or MCP server changed since tool_search
  // returned it would run arguments written against a schema the model no
  // longer has, possibly on a replacement server.
  if (
    reviewed !== undefined &&
    reviewed !== deferredDeclarationFingerprint(target)
  ) {
    return {
      error: bridgeRefusal(
        `Deferred tool "${target.name}" changed since tool_search last returned it. Run tool_search with select:${target.name} and call it with the current schema.`,
      ),
      errorType: ToolErrorType.INVALID_TOOL_PARAMS,
      targetName: target.name,
    };
  }

  // The bridge envelope deliberately types `arguments` as a bare object (the
  // declaration must stay byte-stable across catalog changes), so `{}` is
  // envelope-valid even when the target requires fields. Pre-validate against
  // the target's model-visible schema so the refusal names the target and the
  // missing field, instead of surfacing a bare Ajv message after the call has
  // been unwrapped (#12889). Validate clones of both sides: SchemaValidator
  // coerces argument values in place and the scheduler re-validates them at
  // build time; and Ajv caches a compiled schema by object identity, so a
  // target that mutates its own schema object in place (AgentTool's refresh
  // adds and removes `model`/`name`) would otherwise stay pinned to whatever
  // shape it had on the first bridged call. Compile the per-call copy in an
  // isolated validator so it sees the current shape without reserving the
  // target's `$id` in the process-shared registry.
  //
  // Only the schema layer runs here — never the target's full
  // validateToolParams: its value-level rules (fs stats, content scans, the
  // AgentTool refresh kick) run unchanged at build() time, so running them
  // here would pay their side effects twice per bridged call. The
  // model-visible `schema` getter is also what makes this safe for omni
  // media-policy targets: their declaration is a projection with operator
  // `lockedArguments` stripped from `required`, while their
  // `validateToolParams` deliberately checks the NATIVE schema plus io value
  // rules that assume the modelAccess gate (which both frontends run AFTER
  // bridge resolution) has merged those arguments back in — running it here
  // would refuse calls the very next stage accepts.
  // Defaults remain model-visible and overridable; omit their names only
  // from this clone's required list because the same gate supplies them.
  let paramsError: string | null = null;
  // A truncated response yields to the caller's truncation handling: the
  // arguments are incomplete for transport reasons, not a schema misreading.
  // A target the caller's own downstream policy gate will deny (the
  // scheduler's permission-manager gate owns the richer denial message)
  // must surface that denial, not a parameter error for a call that could
  // never run.
  const preCheckSuppressed =
    options?.suppressArgumentPreCheck !== undefined &&
    (await options.suppressArgumentPreCheck(target.name));
  if (!options?.wasOutputTruncated && !preCheckSuppressed) {
    try {
      const argsClone = structuredClone(invocation.params.arguments);
      // Surplus-key tolerance is the target's own call, so relax the keyword
      // wherever relaxing only widens acceptance — but never inside a
      // composition branch or annotation data, where the rewrite inverts the
      // schema's meaning and the pre-check ends up stricter than the schema the
      // target publishes. See relaxAdditionalProperties.
      const schemaClone = relaxAdditionalProperties(
        target.schema.parametersJsonSchema,
      );
      if (
        target.mediaPolicyDescriptor?.kind === 'media_policy' &&
        Array.isArray(schemaClone['required'])
      ) {
        const defaults = new Set(
          options?.getDefaultArgumentNames?.(target.name),
        );
        schemaClone['required'] = schemaClone['required'].filter(
          (name) => !defaults.has(name),
        );
      }
      const required = new Set(
        Array.isArray(schemaClone['required']) ? schemaClone['required'] : [],
      );
      for (const [name, value] of Object.entries(argsClone)) {
        if (value === null && !required.has(name)) {
          delete argsClone[name];
        }
      }
      const compiled = SchemaValidator.compileIsolated(schemaClone);
      if ('validate' in compiled) {
        paramsError = compiled.validate(argsClone);
      }
    } catch {
      // A target whose validation throws under this pre-check must not become
      // a new bridge failure mode: the scheduler's build() reports the same
      // throw as before.
    }
  }
  if (paramsError) {
    return {
      error: bridgeRefusal(
        `Deferred tool "${target.name}" rejected the arguments: ${paramsError}. Pass arguments matching the schema returned by tool_search for "${target.name}".`,
      ),
      errorType: ToolErrorType.INVALID_TOOL_PARAMS,
      targetName: target.name,
    };
  }

  return {
    tool: target,
    arguments: structuredClone(invocation.params.arguments),
  };
}

class ToolCallInvocation extends BaseToolInvocation<
  ToolCallParams,
  ToolResult
> {
  getDescription(): string {
    return this.params.name;
  }

  execute(_signal: AbortSignal): Promise<ToolResult> {
    const message =
      'tool_call must be dispatched through the tool scheduler so the underlying tool keeps its permissions, hooks, and approvals.';
    return Promise.resolve({
      llmContent: `Error: ${message}`,
      returnDisplay: message,
      error: { message, type: ToolErrorType.EXECUTION_FAILED },
    });
  }
}

export class ToolCallTool extends BaseDeclarativeTool<
  ToolCallParams,
  ToolResult
> {
  static readonly Name = ToolNames.TOOL_CALL;

  constructor(private readonly registry?: ToolRegistry) {
    super(
      ToolCallTool.Name,
      ToolDisplayNames.TOOL_CALL,
      'Invokes a deferred tool after its schema has been reviewed with tool_search. Pass the exact deferred tool name and arguments matching the reviewed schema. Permissions, hooks, and approvals apply to the underlying tool.',
      Kind.Other,
      {
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
      },
      true,
      false,
      false,
      true,
      'deferred bridge invoke execute',
    );
  }

  override toAutoClassifierInput(
    params: ToolCallParams,
  ): Record<string, unknown> {
    // History parts are unvalidated: a malformed bridged entry may carry a
    // non-string name. Dereferencing it would throw, and the caller's catch
    // falls back to the raw envelope — leaking unredacted arguments into the
    // classifier prompt. Coerce first and fail closed on the name alone.
    const rawName = typeof params.name === 'string' ? params.name : '';
    const targetName = canonicalToolName(rawName);
    if (rawName === '') {
      return { name: targetName };
    }
    let target = this.registry?.getTool(targetName);

    // Keep classifier projection aligned with deferred-call resolution. A
    // name that matches several tools by case is refused there, so it
    // resolves to no target here and projects name-only.
    if (!target && this.registry) {
      const resolved = resolveRegisteredToolName(
        targetName,
        this.registry.getAllToolNames?.() ?? [],
      );
      if (typeof resolved === 'string') {
        target = this.registry.getTool(resolved);
      }
    }

    // Never expose the raw bridge envelope when the target is unavailable:
    // it may contain secrets that only the target's projection knows how to
    // redact. The target identity still preserves the prior-action chain.
    if (!target) {
      return { name: targetName };
    }

    // A nested tool_call envelope resolves back to this wrapper (the
    // case-insensitive lookup above admits case variants too), and
    // unwrapping it would recurse without a depth bound.
    // resolveDeferredToolCall refuses to execute that nesting and the
    // sibling fallback in classifier-transcript.ts stops at one bridge
    // layer, so the projection must agree: name-only, under the resolved
    // registered name.
    if (target.name === ToolNames.TOOL_CALL) {
      return { name: target.name };
    }

    try {
      const projected = target.toAutoClassifierInput(
        structuredClone(params.arguments) as never,
      );
      if (projected === '') {
        return { name: target.name };
      }
      if (projected === undefined) {
        return {
          name: target.name,
          arguments: structuredClone(params.arguments),
        };
      }
      return { name: target.name, arguments: projected };
    } catch {
      // Projection errors must fail closed rather than leaking unprojected
      // arguments into the AUTO classifier transcript.
      return { name: target.name };
    }
  }

  protected createInvocation(
    params: ToolCallParams,
  ): ToolInvocation<ToolCallParams, ToolResult> {
    return new ToolCallInvocation(params);
  }
}
