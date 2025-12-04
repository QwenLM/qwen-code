/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Main ToolCall component - uses factory pattern to route to specialized components
 *
 * This file serves as the public API for tool call rendering.
 * It re-exports the router and types from the toolcalls module.
 */

import type React from 'react';
import { ToolCallRouter } from './toolcalls/index.js';

// Re-export types from the toolcalls module for backward compatibility
export type {
  ToolCallData,
  BaseToolCallProps as ToolCallProps,
} from './toolcalls/shared/types.js';

// Re-export the content type for external use
export type { ToolCallContent } from './toolcalls/shared/types.js';

/**
 * Main ToolCall component
 * Routes to specialized components based on the tool call kind
 *
 * Supported kinds:
 * - read: File reading operations
 * - write/edit: File writing and editing operations
 * - execute/bash/command: Command execution
 * - search/grep/glob/find: Search operations
 * - think/thinking: AI reasoning
 * - All others: Generic display
 */
export const ToolCall: React.FC<{
  toolCall: import('./toolcalls/shared/types.js').ToolCallData;
}> = ({ toolCall }) => <ToolCallRouter toolCall={toolCall} />;
