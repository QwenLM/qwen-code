/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared types for tool call components
 */

/**
 * Tool call content types
 */
export interface ToolCallContent {
  type: 'content' | 'diff';
  // For content type
  content?: {
    type: string;
    text?: string;
    error?: unknown;
    [key: string]: unknown;
  };
  // For diff type
  path?: string;
  oldText?: string | null;
  newText?: string;
}

/**
 * Tool call location type
 */
export interface ToolCallLocation {
  path: string;
  line?: number | null;
}

/**
 * Tool call status type
 */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Base tool call data interface
 */
export interface ToolCallData {
  toolCallId: string;
  kind: string;
  title: string | object;
  status: ToolCallStatus;
  rawInput?: string | object;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  timestamp?: number; // Add a timestamp field for message sorting
}

/**
 * Base props for all tool call components
 */
export interface BaseToolCallProps {
  toolCall: ToolCallData;
}

/**
 * Grouped content structure for rendering
 */
export interface GroupedContent {
  textOutputs: string[];
  errors: string[];
  diffs: ToolCallContent[];
  otherData: unknown[];
}
