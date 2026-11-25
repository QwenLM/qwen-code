/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { McpResultMeta } from '../../mcp/tools/mcp-result.js';

/**
 * Select one tool's side-channel value from a transcript user message.
 * A single tool's semantic result may itself be an array.
 */
export function selectToolResultSideChannel(
  stored: unknown,
  index: number,
  toolResultCount: number,
): unknown {
  if (toolResultCount <= 1) {
    return stored;
  }
  return Array.isArray(stored) ? stored[index] : undefined;
}

export function selectMcpResultMeta(
  stored: McpResultMeta | Array<McpResultMeta | null> | undefined,
  index: number,
  toolResultCount: number,
): McpResultMeta | undefined {
  const selected = selectToolResultSideChannel(
    stored,
    index,
    toolResultCount,
  );
  return selected && typeof selected === 'object' && !Array.isArray(selected)
    ? (selected as McpResultMeta)
    : undefined;
}

export function projectMcpHostEnvelope(
  toolUseResult: unknown,
  mcpMeta: McpResultMeta | undefined,
): unknown {
  return mcpMeta === undefined
    ? toolUseResult
    : { content: toolUseResult, ...mcpMeta };
}
