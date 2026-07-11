/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import type { ToolInvocation, ToolResult } from './tools.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';

/**
 * Provider-facing envelope for calling a hidden deferred tool.
 *
 * `name` is the real deferred tool name returned by `tool_search`; `arguments`
 * is passed through to that target after the scheduler validates that the
 * target schema was already presented in the current conversation.
 */
export interface DeferredToolCallParams {
  name: string;
  arguments: Record<string, unknown>;
}

class DeferredToolCallInvocation extends BaseToolInvocation<
  DeferredToolCallParams,
  ToolResult
> {
  getDescription(): string {
    return this.params.name;
  }

  async execute(_signal: AbortSignal): Promise<ToolResult> {
    // This invocation is a defensive fallback. In normal operation,
    // CoreToolScheduler.normalizeDeferredToolCall rewrites the request to the
    // real target tool before build/execute, so this wrapper should never run.
    const message =
      '`deferred_tool_call` is a transport wrapper and must be normalized by the scheduler before execution. Use `tool_search` to fetch a deferred tool schema, then call `deferred_tool_call` with that real target name.';
    return {
      llmContent: `Error: ${message}`,
      returnDisplay: message,
      error: {
        message,
        type: ToolErrorType.EXECUTION_FAILED,
      },
    };
  }
}

export class DeferredToolCallTool extends BaseDeclarativeTool<
  DeferredToolCallParams,
  ToolResult
> {
  constructor() {
    // Keep this schema stable in the provider's function-declaration list. The
    // actual deferred tool schemas are returned as text by ToolSearch and routed
    // through this wrapper, avoiding provider-side tool-list mutations.
    super(
      ToolNames.DEFERRED_TOOL_CALL,
      ToolDisplayNames.DEFERRED_TOOL_CALL,
      'Calls a deferred tool after its current schema has been fetched with tool_search.',
      Kind.Other,
      {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Exact deferred tool name returned by tool_search.',
          },
          arguments: {
            type: 'object',
            description:
              'Arguments matching the target schema returned by tool_search.',
          },
        },
        required: ['name', 'arguments'],
        additionalProperties: false,
      },
      true,
      false,
      false,
      true,
      'deferred proxy tool call',
    );
  }

  protected createInvocation(
    params: DeferredToolCallParams,
  ): ToolInvocation<DeferredToolCallParams, ToolResult> {
    return new DeferredToolCallInvocation(params);
  }
}
