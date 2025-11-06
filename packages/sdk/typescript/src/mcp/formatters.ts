/**
 * Tool result formatting utilities for MCP responses
 *
 * Converts various output types to MCP content blocks.
 */

/**
 * MCP content block types
 */
export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; uri: string; mimeType?: string; text?: string };

/**
 * Tool result structure
 */
export interface ToolResult {
  content: McpContentBlock[];
  isError?: boolean;
}

/**
 * Format tool result for MCP response
 *
 * Converts any value to MCP content blocks (strings, objects, errors, etc.)
 *
 * @param result - Tool handler output or error
 * @returns Formatted tool result
 *
 * @example
 * ```typescript
 * formatToolResult('Hello')
 * // → { content: [{ type: 'text', text: 'Hello' }] }
 *
 * formatToolResult({ temperature: 72 })
 * // → { content: [{ type: 'text', text: '{"temperature":72}' }] }
 * ```
 */
export function formatToolResult(result: unknown): ToolResult {
  // Handle Error objects
  if (result instanceof Error) {
    return {
      content: [
        {
          type: 'text',
          text: result.message || 'Unknown error',
        },
      ],
      isError: true,
    };
  }

  // Handle null/undefined
  if (result === null || result === undefined) {
    return {
      content: [
        {
          type: 'text',
          text: '',
        },
      ],
    };
  }

  // Handle string
  if (typeof result === 'string') {
    return {
      content: [
        {
          type: 'text',
          text: result,
        },
      ],
    };
  }

  // Handle number
  if (typeof result === 'number') {
    return {
      content: [
        {
          type: 'text',
          text: String(result),
        },
      ],
    };
  }

  // Handle boolean
  if (typeof result === 'boolean') {
    return {
      content: [
        {
          type: 'text',
          text: String(result),
        },
      ],
    };
  }

  // Handle object (including arrays)
  if (typeof result === 'object') {
    try {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch {
      // JSON.stringify failed
      return {
        content: [
          {
            type: 'text',
            text: String(result),
          },
        ],
      };
    }
  }

  // Fallback: convert to string
  return {
    content: [
      {
        type: 'text',
        text: String(result),
      },
    ],
  };
}

/**
 * Format error for MCP response
 *
 * @param error - Error object or string
 * @returns Tool result with error flag
 */
export function formatToolError(error: Error | string): ToolResult {
  const message = error instanceof Error ? error.message : error;

  return {
    content: [
      {
        type: 'text',
        text: message,
      },
    ],
    isError: true,
  };
}

/**
 * Format text content for MCP response
 *
 * @param text - Text content
 * @returns Tool result with text content
 */
export function formatTextResult(text: string): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

/**
 * Format JSON content for MCP response
 *
 * @param data - Data to serialize as JSON
 * @returns Tool result with JSON text content
 */
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

/**
 * Merge multiple tool results into a single result
 *
 * @param results - Array of tool results
 * @returns Merged tool result
 */
export function mergeToolResults(results: ToolResult[]): ToolResult {
  const mergedContent: McpContentBlock[] = [];
  let hasError = false;

  for (const result of results) {
    mergedContent.push(...result.content);
    if (result.isError) {
      hasError = true;
    }
  }

  return {
    content: mergedContent,
    isError: hasError,
  };
}

/**
 * Validate MCP content block
 *
 * @param block - Content block to validate
 * @returns True if valid
 */
export function isValidContentBlock(block: unknown): block is McpContentBlock {
  if (!block || typeof block !== 'object') {
    return false;
  }

  const blockObj = block as Record<string, unknown>;

  if (!blockObj.type || typeof blockObj.type !== 'string') {
    return false;
  }

  switch (blockObj.type) {
    case 'text':
      return typeof blockObj.text === 'string';

    case 'image':
      return (
        typeof blockObj.data === 'string' &&
        typeof blockObj.mimeType === 'string'
      );

    case 'resource':
      return typeof blockObj.uri === 'string';

    default:
      return false;
  }
}
