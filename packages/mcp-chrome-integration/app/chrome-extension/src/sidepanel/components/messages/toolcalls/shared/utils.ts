/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared utility functions for tool call components
 */

import type {
  ToolCallContent,
  GroupedContent,
  ToolCallStatus,
} from './types.js';

/**
 * Format any value to a string for display
 */
export const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    // TODO: Trying to take out the Output part from the string
    try {
      value = (JSON.parse(value) as { output?: unknown }).output ?? value;
    } catch (_error) {
      // ignore JSON parse errors
    }
    return value as string;
  }
  // Handle Error objects specially
  if (value instanceof Error) {
    return value.message || value.toString();
  }
  // Handle error-like objects with message property
  if (typeof value === 'object' && value !== null && 'message' in value) {
    const errorObj = value as { message?: string; stack?: string };
    return errorObj.message || String(value);
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch (_e) {
      return String(value);
    }
  }
  return String(value);
};

/**
 * Safely convert title to string, handling object types
 * Returns empty string if no meaningful title
 */
export const safeTitle = (title: unknown): string => {
  if (typeof title === 'string' && title.trim()) {
    return title;
  }
  if (title && typeof title === 'object') {
    return JSON.stringify(title);
  }
  return '';
};

/**
 * Check if a tool call should be displayed
 * Hides internal tool calls
 */
export const shouldShowToolCall = (kind: string): boolean =>
  !kind.includes('internal');

/**
 * Check if a tool call has actual output to display
 * Returns false for tool calls that completed successfully but have no visible output
 */
export const hasToolCallOutput = (
  toolCall: import('./types.js').ToolCallData,
): boolean => {
  // Always show failed tool calls (even without content)
  if (toolCall.status === 'failed') {
    return true;
  }

  // Always show execute/bash/command tool calls (they show the command in title)
  const kind = toolCall.kind.toLowerCase();
  if (kind === 'execute' || kind === 'bash' || kind === 'command') {
    // But only if they have a title
    if (
      toolCall.title &&
      typeof toolCall.title === 'string' &&
      toolCall.title.trim()
    ) {
      return true;
    }
  }

  // Show if there are locations (file paths)
  if (toolCall.locations && toolCall.locations.length > 0) {
    return true;
  }

  // Show if there is content
  if (toolCall.content && toolCall.content.length > 0) {
    const grouped = groupContent(toolCall.content);
    // Has any meaningful content?
    if (
      grouped.textOutputs.length > 0 ||
      grouped.errors.length > 0 ||
      grouped.diffs.length > 0 ||
      grouped.otherData.length > 0
    ) {
      return true;
    }
  }

  // Show if there's a meaningful title for generic tool calls
  if (
    toolCall.title &&
    typeof toolCall.title === 'string' &&
    toolCall.title.trim()
  ) {
    return true;
  }

  // No output, don't show
  return false;
};

/**
 * Group tool call content by type to avoid duplicate labels
 */
export const groupContent = (content?: ToolCallContent[]): GroupedContent => {
  const textOutputs: string[] = [];
  const errors: string[] = [];
  const diffs: ToolCallContent[] = [];
  const otherData: unknown[] = [];

  content?.forEach((item) => {
    if (item.type === 'diff') {
      diffs.push(item);
    } else if (item.content) {
      const contentObj = item.content;

      // Handle error content
      if (contentObj.type === 'error' || 'error' in contentObj) {
        // Try to extract meaningful error message
        let errorMsg = '';

        // Check if error is a string
        if (typeof contentObj.error === 'string') {
          errorMsg = contentObj.error;
        }
        // Check if error has a message property
        else if (
          contentObj.error &&
          typeof contentObj.error === 'object' &&
          'message' in contentObj.error
        ) {
          errorMsg = (contentObj.error as { message: string }).message;
        }
        // Try text field
        else if (contentObj.text) {
          errorMsg = formatValue(contentObj.text);
        }
        // Format the error object itself
        else if (contentObj.error) {
          errorMsg = formatValue(contentObj.error);
        }
        // Fallback
        else {
          errorMsg = 'An error occurred';
        }

        errors.push(errorMsg);
      }
      // Handle text content
      else if (contentObj.text) {
        textOutputs.push(formatValue(contentObj.text));
      }
      // Handle other content
      else {
        otherData.push(contentObj);
      }
    }
  });

  return { textOutputs, errors, diffs, otherData };
};

/**
 * Map a tool call status to a ToolCallContainer status (bullet color)
 * - pending/in_progress -> loading
 * - completed -> success
 * - failed -> error
 * - default fallback
 */
export const mapToolStatusToContainerStatus = (
  status: ToolCallStatus,
): 'success' | 'error' | 'warning' | 'loading' | 'default' => {
  switch (status) {
    case 'pending':
    case 'in_progress':
      return 'loading';
    case 'failed':
      return 'error';
    case 'completed':
      return 'success';
    default:
      return 'default';
  }
};
