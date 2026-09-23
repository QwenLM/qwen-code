/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview What `agent({ tools })` accepts, and how a dispatch narrows a
 * subagent to it.
 *
 * An allowlist only ever narrows. The dispatch writes the result onto the
 * subagent's `tools`, the same field an agent definition's own allowlist uses,
 * and the subagent's declaration filter does the rest: a tool outside that list
 * is never declared, and a call for an undeclared tool is answered "not found"
 * rather than run. Denies are applied after the allowlist, so an allowlist can
 * never bring back a tool the workflow floor or a deny takes away.
 *
 * Entries are exact tool names. The declaration filter looks each allowlist
 * entry up by exact name and expands no pattern, so a pattern would name
 * nothing the agent could ever be given; it is refused rather than accepted and
 * silently dropped. `exec` is refused too: in code mode it is the surface the
 * agent calls other tools through, and naming it would hand over every tool it
 * can call.
 *
 * The checks here are about names only. Whether a named tool is actually
 * available to the subagent (registered in this session, not hidden, not a
 * control-plane tool) is decided by the declaration filter, exactly as it is
 * for an agent definition's allowlist.
 */

import { matchesToolPattern } from '../../permissions/rule-parser.js';
import { resolveBuiltinToolName, ToolNames } from '../../tools/tool-names.js';

/** Most names a refusal lists before it says how many more there were. */
const MAX_LISTED_TOOL_NAMES = 10;

/**
 * A built-in tool named by its display name or a legacy alias becomes its tool
 * name, so both spellings share one resume key. Any other name comes back as
 * given.
 */
export function canonicalAgentToolName(name: string): string {
  return resolveBuiltinToolName(name) ?? name;
}

/**
 * Why an `agent({ tools })` entry cannot name a tool to allow, or `null` when
 * it can. The reason is a sentence that follows `agent({tools}): `. The entry
 * is echoed as written, so a caller that shows the reason must strip control
 * characters from it.
 */
export function describeAgentToolAllowEntryProblem(
  name: string,
): string | null {
  if (name.includes('*')) {
    return `${JSON.stringify(name)} is a pattern, and the allowlist takes exact tool names; name an MCP tool the way the model sees it (mcp__<server>__<tool>), or omit tools to keep every tool.`;
  }
  if (canonicalAgentToolName(name) === ToolNames.EXEC) {
    return `${JSON.stringify(name)} is the code-mode surface, not a tool to allow; list the tools it may call instead.`;
  }
  if (name.startsWith('mcp__') && name.split('__').length < 3) {
    return `${JSON.stringify(name)} names a whole MCP server, and the allowlist takes exact tool names; list that server's tools as mcp__<server>__<tool>.`;
  }
  return null;
}

/** `"a", "b", "c"`, capped, for a refusal message. */
export function listAgentToolNames(names: readonly string[]): string {
  const shown = names
    .slice(0, MAX_LISTED_TOOL_NAMES)
    .map((name) => JSON.stringify(name))
    .join(', ');
  const more = names.length - MAX_LISTED_TOOL_NAMES;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

export interface AgentToolNarrowingInput {
  /** The script's `tools` entries as the sandbox handed them over. */
  readonly requested: readonly string[];
  /** `requested` mapped to registered tool names, index for index. */
  readonly requestedNames: readonly string[];
  /**
   * The agent definition's own allowlist as written, or `undefined` when the
   * agent inherits every tool (no allowlist, or one holding `'*'`).
   */
  readonly agentTypeTools?: readonly string[];
  /** `agentTypeTools` mapped to registered tool names. */
  readonly agentTypeToolNames?: readonly string[];
  /**
   * Every deny that applies to this dispatch — the workflow floor, the agent
   * definition's denies and this call's — mapped to registered tool names.
   * Entries may be MCP patterns.
   */
  readonly denies: readonly string[];
  /**
   * Resolves a registered tool's advertised permission aliases (the MCP
   * legacy spellings), so a deny written in a legacy spelling still covers
   * the tool it names (#10199). Denies are fail-open on a lost match.
   */
  readonly toolAliasesFor?: (toolName: string) => readonly string[] | undefined;
  /** Whether the agent answers through `structured_output`. */
  readonly schema: boolean;
}

/**
 * The tools a dispatch narrowed by `agent({ tools })` may be declared: the
 * requested names, bounded by the agent definition's allowlist, minus every
 * deny, plus `structured_output` for a schema agent. Throws, naming the
 * entries as written, when the bound or the denies leave no requested tool —
 * such an agent could only spend its dispatch.
 */
export function narrowAgentTools(input: AgentToolNarrowingInput): string[] {
  const requestedNames = [...new Set(input.requestedNames)];

  const bounded =
    input.agentTypeToolNames === undefined
      ? requestedNames
      : requestedNames.filter((name) =>
          input.agentTypeToolNames!.includes(name),
        );
  if (bounded.length === 0) {
    throw new Error(
      `agent({tools, agentType}): none of ${listAgentToolNames(input.requested)} is among the tools the agent type allows (${listAgentToolNames(input.agentTypeTools ?? [])}).`,
    );
  }

  const allowed = bounded.filter(
    (name) =>
      !input.denies.some((pattern) =>
        matchesToolPattern(pattern, name, input.toolAliasesFor?.(name)),
      ),
  );
  if (allowed.length === 0) {
    throw new Error(
      `agent({tools}): every tool in ${listAgentToolNames(input.requested)} is denied for this agent, by disallowedTools, by the agent type, or by the tools no workflow subagent may use.`,
    );
  }

  if (input.schema && !allowed.includes(ToolNames.STRUCTURED_OUTPUT)) {
    allowed.push(ToolNames.STRUCTURED_OUTPUT);
  }
  return allowed;
}
