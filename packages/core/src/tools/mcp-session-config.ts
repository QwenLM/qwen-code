/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfig } from '../config/config.js';

export function normalizeMcpIncludeEntry(entry: string): string {
  const paren = entry.indexOf('(');
  return paren === -1 ? entry : entry.slice(0, paren);
}

function normalizeFilter(
  entries: readonly string[] | undefined,
  stripParenthesizedSuffix: boolean,
): string[] {
  const normalized = (entries ?? []).map((entry) => {
    if (!stripParenthesizedSuffix) return entry;
    return normalizeMcpIncludeEntry(entry);
  });
  return [...new Set(normalized)].sort();
}

/**
 * Stable identity for MCP settings projected into one session rather than
 * used to create the transport. Semantically equivalent filters share a key:
 * order, duplicates, and include-list argument suffixes do not cause
 * registration churn. An absent include list remains distinct from an empty
 * one because they mean "allow all" and "allow none", respectively.
 */
export function mcpSessionMetadataKey(config: MCPServerConfig): string {
  return JSON.stringify({
    trust: config.trust ?? null,
    alwaysLoadTools: config.alwaysLoadTools === true,
    // An absent allowlist accepts every name, while an explicit empty
    // allowlist accepts none. Preserve that semantic distinction.
    includeTools:
      config.includeTools === undefined
        ? null
        : normalizeFilter(config.includeTools, true),
    excludeTools: normalizeFilter(config.excludeTools, false),
  });
}
