/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool result formatting utilities for MCP responses.
 */

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function formatJsonResult(data: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function formatToolError(error: Error | string): ToolResult {
  const message = error instanceof Error ? error.message : error;
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}
