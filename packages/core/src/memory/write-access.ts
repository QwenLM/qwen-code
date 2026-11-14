/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseRule,
  toolMatchesRuleToolName,
} from '../permissions/rule-parser.js';
import type { Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';

/**
 * The tool a memory write goes through. Every managed memory agent that saves
 * anything (extract, remember, dream) writes with one of these two, so a
 * blanket deny on both of them closes the whole write path.
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
  // A bare `edit` is the meta-tool: the permission engine applies it to
  // `write_file` too, so an exact name compare would miss the common
  // `deny: ["Edit"]` spelling and fork an extractor whose every save is then
  // refused.
  if (!toolMatchesRuleToolName(rule.toolName, toolName)) return false;
  // The last two conditions restate the match-any-invocation branch of
  // `matchesRule` in `permissions/rule-parser.ts`: a rule reaches a call with
  // no path or specifier only when it carries neither. Reusing `matchesRule`
  // here would not be equivalent — it answers "does this rule match *this*
  // invocation", not "does it match every path" — so state the coupling
  // instead: if that branch's notion of a bare rule changes, change this too.
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

/**
 * {@link blocksAllMemoryWrites} for a live session.
 *
 * `Config.getPermissionsDeny()` returns the list captured when the `Config`
 * was constructed. The memory agent is evaluated against the live
 * `PermissionManager`, and `/permissions` mutates only the manager, so the
 * snapshot diverges from what the fork will actually hit: a `deny: ["Edit"]`
 * removed through the dialog would keep this check reporting `writes_denied`
 * and never fork again.
 */
export function blocksAllMemoryWritesForConfig(config: Config): boolean {
  const permissionManager = config.getPermissionManager?.();
  if (!permissionManager) {
    return blocksAllMemoryWrites(config.getPermissionsDeny?.());
  }
  const denyRules = permissionManager
    .listRules()
    .filter((entry) => entry.type === 'deny')
    .map((entry) => entry.rule.raw);
  return blocksAllMemoryWrites(denyRules);
}
