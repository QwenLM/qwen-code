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
import { WriteToolCall } from './Write/WriteToolCall.js';
import { EditToolCall } from './Edit/EditToolCall.js';
import { ExecuteToolCall as BashExecuteToolCall } from './Bash/Bash.js';
import { ExecuteToolCall } from './Execute/Execute.js';
import { UpdatedPlanToolCall } from './UpdatedPlan/UpdatedPlanToolCall.js';
import { SearchToolCall } from './Search/SearchToolCall.js';
import { ThinkToolCall } from './Think/ThinkToolCall.js';

/**
 * Factory function that returns the appropriate tool call component based on kind
 */
export const getToolCallComponent = (
  kind: string,
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
      return ExecuteToolCall;

    case 'bash':
    case 'command':
      return BashExecuteToolCall;

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

    default:
      // Fallback to generic component
      return GenericToolCall;
  }
};

/**
 * Main tool call component that routes to specialized implementations
 */
export const ToolCallRouter: React.FC<
  BaseToolCallProps & { isFirst?: boolean; isLast?: boolean }
> = ({ toolCall, isFirst, isLast }) => {
  // Check if we should show this tool call (hide internal ones)
  if (!shouldShowToolCall(toolCall.kind)) {
    return null;
  }

  // Get the appropriate component for this kind
  const Component = getToolCallComponent(toolCall.kind);

  // Render the specialized component
  return <Component toolCall={toolCall} isFirst={isFirst} isLast={isLast} />;
};

// Re-export types for convenience
export type { BaseToolCallProps, ToolCallData } from './shared/types.js';
