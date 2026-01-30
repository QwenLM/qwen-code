/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool call status
 */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Tool call location reference
 */
export interface ToolCallLocation {
  path: string;
  line?: number | null;
}

/**
 * Tool call content item
 */
export interface ToolCallContentItem {
  type: 'content' | 'diff';
  content?: {
    type: string;
    text?: string;
    [key: string]: unknown;
  };
  path?: string;
  oldText?: string | null;
  newText?: string;
  [key: string]: unknown;
}

/**
 * Tool call update data
 */
export interface ToolCallUpdate {
  toolCallId: string;
  kind?: string;
  title?: string;
  status?: ToolCallStatus;
  rawInput?: unknown;
  content?: ToolCallContentItem[];
  locations?: ToolCallLocation[];
  timestamp?: number;
}
