/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolInvocation, ToolResult } from './tools.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolErrorType } from './tool-error.js';
import { ToolDisplayNames, ToolNames } from './tool-names.js';

export interface ToolCallParams {
  name: string;
  arguments: Record<string, unknown>;
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
