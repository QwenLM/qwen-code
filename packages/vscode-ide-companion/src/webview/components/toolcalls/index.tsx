/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tool call component factory - routes to specialized components by kind
 */

import type React from 'react';
import type { BaseToolCallProps } from './shared/types.js';
import { shouldShowToolCall } from './shared/utils.js';
import { GenericToolCall } from './GenericToolCall.js';
import { ReadToolCall } from './Read/ReadToolCall.js';
import { WriteToolCall } from './WriteToolCall.js';
import { EditToolCall } from './Edit/EditToolCall.js';
import { ExecuteToolCall as BashExecuteToolCall } from './Bash/Bash.js';
import { ExecuteToolCall } from './Execute/Execute.js';
import { UpdatedPlanToolCall } from './UpdatedPlan/UpdatedPlanToolCall.js';
import { ExecuteNodeToolCall } from './ExecuteNode/ExecuteNodeToolCall.js';
import { SearchToolCall } from './SearchToolCall.js';
import { ThinkToolCall } from './ThinkToolCall.js';
import { TodoWriteToolCall } from './TodoWriteToolCall.js';

/**
 * Factory function that returns the appropriate tool call component based on kind
 */
export const getToolCallComponent = (
  kind: string,
  toolCall?: import('./shared/types.js').ToolCallData,
): React.FC<BaseToolCallProps> => {
  const normalizedKind = kind.toLowerCase();

  // Route to specialized components
  switch (normalizedKind) {
    case 'read':
      return ReadToolCall;

    case 'write':
      return WriteToolCall;

    case 'edit':
      return EditToolCall;

    case 'execute':
      // Check if this is a node/npm version check command
      if (toolCall) {
        const commandText =
          typeof toolCall.rawInput === 'string'
            ? toolCall.rawInput
            : typeof toolCall.rawInput === 'object' &&
                toolCall.rawInput !== null
              ? (toolCall.rawInput as { command?: string }).command || ''
              : '';

        // TODO:
        if (
          commandText.includes('node --version') ||
          commandText.includes('npm --version')
        ) {
          return ExecuteNodeToolCall;
        }
      }
      return ExecuteToolCall;

    case 'bash':
    case 'command':
      return BashExecuteToolCall;

    case 'updated_plan':
    case 'updatedplan':
    case 'todo_write':
      return UpdatedPlanToolCall;

    case 'search':
    case 'grep':
    case 'glob':
    case 'find':
      return SearchToolCall;

    case 'think':
    case 'thinking':
      return ThinkToolCall;

    case 'todowrite':
      return TodoWriteToolCall;
    // case 'todo_write':
    case 'update_todos':
      return TodoWriteToolCall;

    // Add more specialized components as needed
    // case 'fetch':
    //   return FetchToolCall;
    // case 'delete':
    //   return DeleteToolCall;

    default:
      // Fallback to generic component
      return GenericToolCall;
  }
};

/**
 * Main tool call component that routes to specialized implementations
 */
export const ToolCallRouter: React.FC<BaseToolCallProps> = ({ toolCall }) => {
  // Check if we should show this tool call (hide internal ones)
  if (!shouldShowToolCall(toolCall.kind)) {
    return null;
  }

  // Get the appropriate component for this kind
  const Component = getToolCallComponent(toolCall.kind, toolCall);

  // Render the specialized component
  return <Component toolCall={toolCall} />;
};

// Re-export types for convenience
export type { BaseToolCallProps, ToolCallData } from './shared/types.js';
