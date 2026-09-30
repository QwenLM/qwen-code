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
}

export const DEFERRED_TOOL_CALL_REFUSAL_PREFIX = '[tool_call bridge refused] ';
export const DEFERRED_TOOL_CALL_CANCELLATION_PREFIX =
  '[tool_call bridge cancelled] ';

function bridgeRefusal(message: string): Error {
  return new Error(`${DEFERRED_TOOL_CALL_REFUSAL_PREFIX}${message}`);
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

  // A hidden tool whose declaration or MCP server changed since tool_search
  // returned it would run arguments written against a schema the model no
  // longer has, possibly on a replacement server. A tool never reviewed in
  // this session keeps working by name.
  const reviewed = registry.getReviewedDeclaration?.(target.name);
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
