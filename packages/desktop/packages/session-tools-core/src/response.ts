/**
 * Session Tools Core - Response Helpers
 *
 * Helper functions for creating standardized tool responses.
 * Used by all session tool implementations.
 */

import type { ToolResult, TextContent } from './types.ts';

/**
 * Create a successful text response
 */
export function successResponse(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: {},
    isError: false,
  };
}

/**
 * Create an error response.
 *
 * IMPORTANT: some tool-call transports only accept a plain output string.
 *
 * This means `isError: true` is invisible to the model. To make errors
 * distinguishable from successes, we prefix the output text with "[ERROR]".
 * The model can then parse this prefix to understand the tool call failed.
 *
 * This covers all session MCP tool errors (source_test, config_validate,
 * skill_validate, SubmitPlan, credential_prompt, oauth triggers, etc.).
 *
 * See also: blockWithReason() in packages/shared/src/agent/mode-manager.ts
 * which applies the same prefix for permission-mode blocks.
 */
export function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `[ERROR] ${message}` }],
    structuredContent: {},
    isError: true,
  };
}

/**
 * Create a text content block
 */
export function textContent(text: string): TextContent {
  return { type: 'text', text };
}

/**
 * Create a multi-block response (e.g., for multiple sections)
 */
export function multiBlockResponse(texts: string[], isError?: boolean): ToolResult {
  return {
    content: texts.map(text => ({ type: 'text' as const, text })),
    structuredContent: {},
    isError,
  };
}
