/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tool call component factory - routes to specialized components by kind
 * All UI components are now imported from @qwen-code/webui
 */

import type { FC } from 'react';
import {
  shouldShowToolCall,
  // All ToolCall components from webui
  GenericToolCall,
  ThinkToolCall,
  SaveMemoryToolCall,
  EditToolCall,
  WriteToolCall,
  SearchToolCall,
  UpdatedPlanToolCall,
  ShellToolCall,
  ReadToolCall,
  WebFetchToolCall,
} from '@qwen-code/webui';
import type { BaseToolCallProps } from '@qwen-code/webui';

/**
 * Factory function that returns the appropriate tool call component based on kind
 */
export const getToolCallComponent = (kind: string): FC<BaseToolCallProps> => {
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

    case 'save_memory':
    case 'savememory':
    case 'memory':
      return SaveMemoryToolCall;

    case 'fetch':
    case 'web_fetch':
    case 'webfetch':
    case 'web_search':
    case 'websearch':
      return WebFetchToolCall;

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
  const Component = getToolCallComponent(toolCall.kind);

  // Render the specialized component
  return <Component toolCall={toolCall} />;
};

// Re-export types for convenience
export type { BaseToolCallProps, ToolCallData } from '@qwen-code/webui';
