/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseRule } from '../permissions/rule-parser.js';
import { ToolNames } from '../tools/tool-names.js';

/**
 * The tool a memory write goes through. Every managed memory agent that saves
 * anything (extract, remember, dream) writes with one of these two, so a
 * blanket deny on either one closes the whole write path.
 */
const WRITE_TOOLS = [ToolNames.WRITE_FILE, ToolNames.EDIT] as const;

/**
 * Deny rules that carry a specifier (`edit(...)`, `write_file(...)`) constrain
 * *which* paths are allowed, not whether the tool can run at all: the scoped
 * memory agent re-decides each path itself and merges the base verdict in. Only
 * a bare tool name denies every invocation regardless of path.
 */
function isBlanketDenyOf(toolName: string, rawRule: string): boolean {
  const trimmed = rawRule.trim();
  // MCP tool patterns (`mcp__server__*`) never name a built-in write tool.
  if (trimmed.startsWith('mcp__')) return false;
  const rule = parseRule(trimmed);
  if (rule.invalid) return false;
  if (rule.toolName !== toolName) return false;
  return !rule.specifier && !rule.toolParamMatchers?.length;
}

/**
 * Whether the inherited permission state denies every `write_file`/`edit`
 * call, which makes managed auto-memory extraction unable to save anything.
 *
 * Non-interactive runs add these two tool names to the deny list unless the
 * caller explicitly allowed them (see `non-interactive mode` in the CLI
 * config), because there is no UI to answer a prompt. The memory agents
 * inherit that deny list and `mergePermissionDecision` lets a base `deny` win
 * over the scoped memory `allow`, so each save is refused after the extractor
 * has already been forked and paid for. Detecting it up front turns a silent
 * token burn into a reported skip.
 */
export function blocksAllMemoryWrites(
  denyRules: readonly string[] | undefined,
): boolean {
  if (!denyRules?.length) return false;
  return WRITE_TOOLS.every((tool) =>
    denyRules.some((rule) => isBlanketDenyOf(tool, rule)),
  );
}
