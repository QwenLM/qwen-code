/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared tool-call routing — maps ToolCallData to the appropriate
 * specialized component. Used by both ChatViewer and VSCode IDE.
 */

import type { FC } from 'react';
import type { BaseToolCallProps, ToolCallData } from './shared/index.js';
import { AgentToolCall, isAgentExecutionToolCall } from './AgentToolCall.js';
import { GenericToolCall } from './GenericToolCall.js';
import { ThinkToolCall } from './ThinkToolCall.js';
import { EditToolCall } from './EditToolCall.js';
import { WriteToolCall } from './WriteToolCall.js';
import { SearchToolCall } from './SearchToolCall.js';
import { UpdatedPlanToolCall } from './UpdatedPlanToolCall.js';
import { ShellToolCall } from './ShellToolCall.js';
import { ReadToolCall } from './ReadToolCall.js';
import { WebFetchToolCall } from './WebFetchToolCall.js';

/**
 * Returns the appropriate tool-call component for the given tool call data.
 *
 * Checks for structured agent execution output first, then falls back to
 * kind-based routing.
 */
export function getToolCallComponent(
  toolCall: ToolCallData,
): FC<BaseToolCallProps> {
  if (isAgentExecutionToolCall(toolCall)) {
    return AgentToolCall;
  }

  const normalizedKind = toolCall.kind.toLowerCase();

  switch (normalizedKind) {
    case 'read':
    case 'read_file':
    case 'read_many_files':
    case 'readmanyfiles':
    case 'list_directory':
    case 'listfiles':
      return ReadToolCall;
    case 'write':
      return WriteToolCall;
    case 'edit':
      return EditToolCall;
    case 'execute':
    case 'bash':
    case 'command':
      return ShellToolCall;
    case 'updated_plan':
    case 'updatedplan':
    case 'todo_write':
    case 'update_todos':
    case 'todowrite':
      return UpdatedPlanToolCall;
    case 'search':
    case 'grep':
    case 'glob':
    case 'find':
      return SearchToolCall;
    case 'think':
    case 'thinking':
      return ThinkToolCall;
    case 'fetch':
    case 'web_fetch':
    case 'webfetch':
    case 'web_search': // compatibility alias for legacy persisted tool-call records
      return WebFetchToolCall;
    default:
      return GenericToolCall;
  }
}
