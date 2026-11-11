/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP qualified-name primitives: `mcp__{server}__{tool}`.
 *
 * A leaf module on purpose. The tool-name constants need these to classify a
 * name, and so does the MCP tool implementation — having the constants reach
 * into the implementation made every importer of a tool name pull the whole MCP
 * client with it.
 */

import { createHash } from 'node:crypto';

export const MCP_TOOL_PREFIX = 'mcp__';

/** Separator between the server and tool segments of a qualified name. */
export const MCP_QUALIFIED_NAME_SEPARATOR = '__';

/** Whether `name` is an MCP qualified name. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/**
 * Normalize one segment (a server or tool name) for use inside a qualified
 * name: anything outside `[a-zA-Z0-9_-]` becomes `_`, runs of `_` collapse, and
 * leading and trailing `_` are dropped — so a segment can never introduce a
 * false `__` delimiter when joined. Non-ASCII names also carry a stable hash
 * of the original segment: otherwise different Chinese names collapse to the
 * same (possibly empty) slug. ASCII names keep their existing spelling.
 */
export function normalizeMcpSegment(segment: string): string {
  const slug = segment
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (!/[^\p{ASCII}]/u.test(segment)) return slug;

  // A pure mapping keeps IDs stable across discovery order and reconnects.
  const hash = createHash('sha256').update(segment).digest('hex').slice(0, 12);
  return `${slug || 'u'}_${hash}`;
}

/** Apply the same identity mapping to user-authored MCP permission rules. */
export function normalizeMcpRuleName(name: string): string {
  if (!isMcpToolName(name) || !/[^\p{ASCII}]/u.test(name)) return name;
  const raw = name.slice(MCP_TOOL_PREFIX.length);
  const separator = raw.indexOf(MCP_QUALIFIED_NAME_SEPARATOR);
  const parts =
    separator < 0
      ? [raw]
      : [
          raw.slice(0, separator),
          raw.slice(separator + MCP_QUALIFIED_NAME_SEPARATOR.length),
        ];
  return `${MCP_TOOL_PREFIX}${parts
    .map((part) => (part === '*' ? part : normalizeMcpSegment(part)))
    .join(MCP_QUALIFIED_NAME_SEPARATOR)}`;
}

/**
 * Split a qualified name back into its parts. Returns an empty object when the
 * name is not an MCP name or either segment is missing.
 */
export function parseMcpToolName(name: string): {
  serverName?: string;
  toolName?: string;
} {
  if (!isMcpToolName(name)) {
    return {};
  }
  const withoutPrefix = name.slice(MCP_TOOL_PREFIX.length);
  const sepIdx = withoutPrefix.indexOf(MCP_QUALIFIED_NAME_SEPARATOR);
  if (sepIdx <= 0) {
    return {};
  }
  const serverName = withoutPrefix.slice(0, sepIdx);
  const toolName = withoutPrefix.slice(
    sepIdx + MCP_QUALIFIED_NAME_SEPARATOR.length,
  );
  if (!serverName || !toolName) {
    return {};
  }
  return { serverName, toolName };
}
