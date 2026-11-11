/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Soft cap on the body of a lazy MCP reminder (full catalog or delta).
 */
export const LAZY_MCP_TEXT_MAX_CHARS = 10_000;

/**
 * Upper bound for one server's one-line description in the lazy catalog.
 */
export const LAZY_MCP_SERVER_DESC_MAX_CHARS = 200;

/**
 * Lazy-mode dispatch tool name. Defined in this dependency-free module so the
 * permission layer can resolve the lazy path rule identity without importing
 * mcp-call-tool.ts (which imports the permission layer).
 */
export const MCP_CALL_TOOL_NAME = 'mcp_call';
export const MCP_LIST_TOOL_NAME = 'mcp_list';
export const MCP_GET_TOOL_NAME = 'mcp_get';

export const MCP_CALL_DESCRIPTION =
  'Invoke an MCP tool by its fully-qualified name with the given arguments.\n' +
  '\n' +
  'Use `mcp_list` to discover available tools and `mcp_get` to inspect the ' +
  'input schema before calling. The `arguments` object must match the schema ' +
  'returned by `mcp_get`.\n' +
  '\n' +
  'Errors from the MCP server are returned in the response and do NOT throw.';
