/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** One model-visible agent type in an Agent tool listing. */
export interface AgentListingEntry {
  name: string;
  description: string;
}

/**
 * The slice of the Agent tool that policy-aware prompt surfaces read: the
 * concrete instance's availability after allow/deny rules, `disallowedTools`,
 * and built-in capability preflight are applied.
 *
 * `AgentTool` declares `implements AgentPolicyView`, so renaming either member
 * breaks the build instead of silently degrading every reader to its fallback.
 */
export interface AgentPolicyView {
  getAvailableAgentListing(modelId?: string): AgentListingEntry[];
  isAgentTypeAvailable(agentType: string): boolean;
}

/**
 * Narrows an entry obtained from a `ToolRegistry` to {@link AgentPolicyView}.
 *
 * Structural rather than `instanceof`: readers live below `AgentTool` in the
 * import graph. Both members are checked here, so callers get either a fully
 * usable view or `undefined` — a partially-implemented tool must not leave each
 * reader to invent its own per-member fallback.
 */
export function asAgentPolicyView(
  tool: unknown,
): AgentPolicyView | undefined {
  const candidate = tool as Partial<AgentPolicyView> | null | undefined;
  return typeof candidate?.getAvailableAgentListing === 'function' &&
    typeof candidate.isAgentTypeAvailable === 'function'
    ? (candidate as AgentPolicyView)
    : undefined;
}
