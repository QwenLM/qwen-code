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
  ToolDisplayNames,
  ToolNames,
} from './tool-names.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  getLeaderOnlyToolUnavailableMessage,
  getSubagentPlanToolUnavailableMessage,
  isLeaderOnlyToolUnavailableInSubagent,
  isPlanLifecycleToolUnavailableInSubagent,
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
    };

export async function resolveDeferredToolCall(
  registry: ToolRegistry,
  envelope: Record<string, unknown>,
): Promise<DeferredToolCallResolution> {
  let bridge: AnyDeclarativeTool | undefined;
  try {
    bridge = await registry.ensureTool(ToolNames.TOOL_CALL);
  } catch (error) {
    return {
      error: new Error(
        `tool_call could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      ),
      errorType: ToolErrorType.TOOL_NOT_REGISTERED,
    };
  }
  if (!bridge) {
    return {
      error: new Error('tool_call is not registered in this session.'),
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
      error: error instanceof Error ? error : new Error(String(error)),
      errorType: ToolErrorType.INVALID_TOOL_PARAMS,
    };
  }

  const targetName = canonicalToolName(invocation.params.name);
  if (
    targetName === ToolNames.TOOL_CALL ||
    targetName === ToolNames.TOOL_SEARCH
  ) {
    return {
      error: new Error(`tool_call cannot invoke bridge tool "${targetName}".`),
      errorType: ToolErrorType.INVALID_TOOL_PARAMS,
    };
  }

  let target: AnyDeclarativeTool | undefined;
  try {
    target = await registry.ensureTool(targetName);
  } catch (error) {
    return {
      error: new Error(
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
      error: new Error(
        `Deferred tool "${invocation.params.name}" is not registered in this session.${remedy}`,
      ),
      errorType: ToolErrorType.TOOL_NOT_REGISTERED,
    };
  }
  if (!registry.isDeferredAndHidden(target.name)) {
    return {
      error: new Error(
        `Tool "${target.name}" is already visible to the model or is not deferred. Call it directly instead of using tool_call.`,
      ),
      errorType: ToolErrorType.INVALID_TOOL_PARAMS,
    };
  }
  // The bridge has two halves: discovery (tool_search) and invocation
  // (tool_call). When tool_search is unregistered the hidden target cannot
  // be reviewed, and client.ts already reports such tools as unreachable for
  // the session — resolution must agree instead of invoking by name.
  if (!registry.getTool(ToolNames.TOOL_SEARCH)) {
    return {
      error: new Error(
        `Deferred tool "${target.name}" is unreachable in this session: tool_search is not registered, so the ToolSearch + ToolCall bridge is incomplete and deferred tools cannot be invoked via tool_call.`,
      ),
      errorType: ToolErrorType.EXECUTION_DENIED,
    };
  }
  if (isPlanLifecycleToolUnavailableInSubagent(target.name)) {
    return {
      error: new Error(getSubagentPlanToolUnavailableMessage(target.name)),
      errorType: ToolErrorType.EXECUTION_DENIED,
    };
  }
  if (isLeaderOnlyToolUnavailableInSubagent(target.name)) {
    return {
      error: new Error(getLeaderOnlyToolUnavailableMessage(target.name)),
      errorType: ToolErrorType.EXECUTION_DENIED,
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

  constructor() {
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

  protected createInvocation(
    params: ToolCallParams,
  ): ToolInvocation<ToolCallParams, ToolResult> {
    return new ToolCallInvocation(params);
  }
}
