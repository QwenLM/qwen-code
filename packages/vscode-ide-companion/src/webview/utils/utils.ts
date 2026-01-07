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
  ToolCallData,
  ToolCallStatus,
} from '../components/messages/toolcalls/shared/types.js';

/**
 * Extract output from command execution result text
 * Handles both JSON format and structured text format
 *
 * Example structured text:
 * ```
 * Command: lsof -i :5173
 * Directory: (root)
 * Output: COMMAND   PID    USER...
 * Error: (none)
 * Exit Code: 0
 * ```
 */
export const extractCommandOutput = (text: string): string => {
  // First try: Parse as JSON and extract output field
  try {
    const parsed = JSON.parse(text) as { output?: unknown; Output?: unknown };
    const output = parsed.output ?? parsed.Output;
    if (output !== undefined && output !== null) {
      return typeof output === 'string'
        ? output
        : JSON.stringify(output, null, 2);
    }
  } catch (_error) {
    // Not JSON, continue with text parsing
  }

  // Second try: Extract from structured text format
  // Look for "Output: " followed by content until "Error: " or end of string
  // Only match if there's actual content after "Output:" (not just whitespace)
  // Avoid treating the next line (e.g. "Error: ...") as output when the Output line is empty.
  // Intentionally do not allow `\s*` here since it would consume newlines.
  const outputMatch = text.match(/Output:[ \t]*(.+?)(?=\nError:|$)/i);
  if (outputMatch && outputMatch[1]) {
    const output = outputMatch[1].trim();
    // Only return if there's meaningful content (not just "(none)" or empty)
    if (output && output !== '(none)' && output.length > 0) {
      return output;
    }
  }

  // Third try: Check if text starts with structured format (Command:, Directory:, etc.)
  // If so, try to extract everything between first line and "Error:" or "Exit Code:"
  if (text.match(/^Command:/)) {
    const lines = text.split('\n');
    const outputLines: string[] = [];
    let inOutput = false;

    for (const line of lines) {
      // Stop at metadata lines
      if (
        line.startsWith('Error:') ||
        line.startsWith('Exit Code:') ||
        line.startsWith('Signal:') ||
        line.startsWith('Background PIDs:') ||
        line.startsWith('Process Group PGID:')
      ) {
        break;
      }
      // Skip header lines
      if (line.startsWith('Command:') || line.startsWith('Directory:')) {
        continue;
      }
      // Start collecting after "Output:" label
      if (line.startsWith('Output:')) {
        inOutput = true;
        const content = line.substring('Output:'.length).trim();
        if (content && content !== '(none)') {
          outputLines.push(content);
        }
        continue;
      }
      // Collect output lines
      if (
        inOutput ||
        (!line.startsWith('Command:') && !line.startsWith('Directory:'))
      ) {
        outputLines.push(line);
      }
    }

    if (outputLines.length > 0) {
      const result = outputLines.join('\n').trim();
      if (result && result !== '(none)') {
        return result;
      }
    }
  }

  // Fallback: Return original text
  return text;
};

/**
 * Format any value to a string for display
 */
export const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    // Extract command output from structured text
    return extractCommandOutput(value);
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
export const hasToolCallOutput = (toolCall: ToolCallData): boolean => {
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
