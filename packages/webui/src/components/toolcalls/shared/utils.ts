/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared utility functions for tool call components
 * Platform-agnostic utilities that can be used across different platforms
 */

import type {
  ToolCallContent,
  GroupedContent,
  ToolCallData,
  ToolCallStatus,
  ContainerStatus,
} from './types.js';

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
  const outputMatch = text.match(
    /Output:[ \t]{0,20}(.{0,1000}?)(?=\nError:|$)/i,
  );
  if (outputMatch && outputMatch[1]) {
    const output = outputMatch[1].trim();
    if (output && output !== '(none)' && output.length > 0) {
      return output;
    }
  }

  // Third try: Check if text starts with structured format
  if (text.match(/^Command:/)) {
    const lines = text.split('\n');
    const outputLines: string[] = [];
    let inOutput = false;

    for (const line of lines) {
      if (
        line.startsWith('Error:') ||
        line.startsWith('Exit Code:') ||
        line.startsWith('Signal:') ||
        line.startsWith('Background PIDs:') ||
        line.startsWith('Process Group PGID:')
      ) {
        break;
      }
      if (line.startsWith('Command:') || line.startsWith('Directory:')) {
        continue;
      }
      if (line.startsWith('Output:')) {
        inOutput = true;
        const content = line.substring('Output:'.length).trim();
        if (content && content !== '(none)') {
          outputLines.push(content);
        }
        continue;
      }
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
    return extractCommandOutput(value);
  }
  if (value instanceof Error) {
    return value.message || value.toString();
  }
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
 * Uses try/catch to handle circular references safely
 */
export const safeTitle = (title: unknown): string => {
  if (typeof title === 'string' && title.trim()) {
    return title;
  }
  if (title && typeof title === 'object') {
    try {
      return JSON.stringify(title);
    } catch (_e) {
      // Handle circular references or BigInt
      return String(title);
    }
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
 * Group tool call content by type to avoid duplicate labels
 * Error detection logic:
 * - If contentObj.error is set (not null/undefined), treat as error
 * - If contentObj.type === 'error' AND has content (text or error), treat as error
 * This avoids false positives from empty error markers while not missing real errors
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

      // Determine if this is an error:
      // 1. error field is explicitly set (not null/undefined)
      // 2. type is 'error' AND has actual content (text or error field)
      const hasErrorField = contentObj.error != null;
      const isErrorType =
        contentObj.type === 'error' &&
        (contentObj.text != null || contentObj.error != null);
      const hasError = hasErrorField || isErrorType;

      if (hasError) {
        let errorMsg = '';

        if (typeof contentObj.error === 'string') {
          errorMsg = contentObj.error;
        } else if (
          contentObj.error &&
          typeof contentObj.error === 'object' &&
          'message' in contentObj.error
        ) {
          errorMsg = (contentObj.error as { message: string }).message;
        } else if (contentObj.text) {
          errorMsg = formatValue(contentObj.text);
        } else if (contentObj.error) {
          errorMsg = formatValue(contentObj.error);
        } else {
          errorMsg = 'An error occurred';
        }

        errors.push(errorMsg);
      } else if (contentObj.text) {
        textOutputs.push(formatValue(contentObj.text));
      } else {
        otherData.push(contentObj);
      }
    }
  });

  return { textOutputs, errors, diffs, otherData };
};

/**
 * Check if a tool call has actual output to display
 * Returns false for tool calls that completed successfully but have no visible output
 */
export const hasToolCallOutput = (toolCall: ToolCallData): boolean => {
  if (toolCall.status === 'failed') {
    return true;
  }

  const kind = toolCall.kind.toLowerCase();
  if (kind === 'execute' || kind === 'bash' || kind === 'command') {
    if (
      toolCall.title &&
      typeof toolCall.title === 'string' &&
      toolCall.title.trim()
    ) {
      return true;
    }
  }

  if (toolCall.locations && toolCall.locations.length > 0) {
    return true;
  }

  if (toolCall.content && toolCall.content.length > 0) {
    const grouped = groupContent(toolCall.content);
    if (
      grouped.textOutputs.length > 0 ||
      grouped.errors.length > 0 ||
      grouped.diffs.length > 0 ||
      grouped.otherData.length > 0
    ) {
      return true;
    }
  }

  if (
    toolCall.title &&
    typeof toolCall.title === 'string' &&
    toolCall.title.trim()
  ) {
    return true;
  }

  return false;
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
): ContainerStatus => {
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
