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
import { ToolCallRouter } from './index.js';

// Re-export types from the toolcalls module for backward compatibility
export type {
  ToolCallData,
  BaseToolCallProps as ToolCallProps,
} from './shared/types.js';

// Re-export the content type for external use
export type { ToolCallContent } from './shared/types.js';
export const ToolCall: React.FC<{
  toolCall: import('./shared/types.js').ToolCallData;
  isFirst?: boolean;
  isLast?: boolean;
}> = ({ toolCall, isFirst, isLast }) => (
  <ToolCallRouter toolCall={toolCall} isFirst={isFirst} isLast={isLast} />
);
