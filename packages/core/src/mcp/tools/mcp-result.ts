/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Host-only MCP result metadata preserved alongside semantic tool output. */
export interface McpResultMeta {
  _meta?: Record<string, unknown>;
  structuredContent?: Record<string, unknown>;
}

/** In-memory protocol result for programmatic consumption, before display conversion. */
export interface McpCallResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

/** Provider-oriented text block persisted as MCP semantic tool output. */
export interface McpSemanticTextBlock {
  type: 'text';
  text: string;
  /** MCP text-block metadata is retained in persistence, not the model. */
  _meta?: Record<string, unknown>;
}

/** Provider-oriented image block persisted as MCP semantic tool output. */
export interface McpSemanticImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export type McpSemanticContentBlock =
  | McpSemanticTextBlock
  | McpSemanticImageBlock;

export type McpSemanticToolResult = string | McpSemanticContentBlock[];
