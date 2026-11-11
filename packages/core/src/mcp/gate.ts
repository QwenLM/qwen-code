/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Single decision point for "may this MCP server be used in this session".
//
// Core ships a settings-only gate. A product pool can install a different
// implementation before `McpManager.init()`; the MCP runtime then only
// consumes a decision and never learns what produced it.
//
// Scope is deliberately narrow: the server's config plus the two settings lists.
// The user-disable dimensions (session toggle, persisted `disabled` flag) are
// resolved by the caller, which owns the async enablement callbacks, and are
// not part of this decision.

import type { MCPServerConfig } from './mcpServerConfig.js';

/**
 * Shown when a gate denies without supplying its own wording, and the text a
 * blocked tool call surfaces when no per-server detail was recorded.
 */
export const MCP_POLICY_BLOCKED_MESSAGE =
  'This MCP server has been blocked by policy. Contact your administrator.';

/**
 * The only deny reasons core names, because they are the only ones it reacts to
 * differently: a settings-list block is recorded for the UI's blocked list.
 *
 * Every other reason a gate returns is treated as a policy block, and an
 * unrecognized reason still fails closed — a decision is never downgraded just
 * because the runtime does not know the reason.
 */
export const MCP_GATE_DENY_ALLOWLIST = 'allowlist';
export const MCP_GATE_DENY_EXCLUDELIST = 'excludelist';

export const MCP_GATE_LIST_DENY_REASONS: readonly string[] = [
  MCP_GATE_DENY_ALLOWLIST,
  MCP_GATE_DENY_EXCLUDELIST,
];

export type McpGateDecision =
  | {
      readonly allowed: true;
      readonly reason?: string;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
      /** User-facing explanation. Falls back to {@link MCP_POLICY_BLOCKED_MESSAGE}. */
      readonly detail?: string;
    };

export interface McpGateRequest {
  readonly config: MCPServerConfig;
  readonly serverName: string;
  /** `mcp.allowed` from the merged settings view. Empty means "no allowlist". */
  readonly allowList: readonly string[];
  /** `mcp.excluded` from the merged settings view. */
  readonly excludeList: readonly string[];
}

export interface McpServerGate {
  evaluate(request: McpGateRequest): McpGateDecision;

  /**
   * Awaited once during Config initialization, before any `evaluate`. Lets a
   * gate warm up from cache so the first decision is not made against an empty
   * policy.
   */
  initialize?(): Promise<void>;

  /**
   * Begin background refresh. `onPolicyChanged` asks the MCP runtime to
   * re-evaluate every known server, so a policy that flips mid-session takes
   * effect without a restart.
   */
  start?(onPolicyChanged: () => void | Promise<void>): void;

  stop?(): void;
}

export function gateDenyMessage(decision: McpGateDecision): string {
  if (decision.allowed) return '';
  return decision.detail ?? MCP_POLICY_BLOCKED_MESSAGE;
}

/**
 * Whether a denial came from something other than the settings lists. Drives
 * which recovery the runtime applies and whether a transport diagnostic should
 * be suppressed in favour of the gate's own wording.
 */
export function isHostPolicyDeny(decision: McpGateDecision): boolean {
  return !decision.allowed && !MCP_GATE_LIST_DENY_REASONS.includes(decision.reason);
}

/**
 * The settings-only gate: the `mcp.allowed` and `mcp.excluded` lists. This is
 * the complete policy when no other gate is supplied.
 *
 * Matching is exact and case-sensitive, which is what the MCP runtime has always
 * done. `canLoadServer` in the CLI's config layer matches the same lists
 * case-insensitively for `mcp list` / `mcp enable` output; unifying the two is
 * deliberate future work, not something to slip into a decoupling change,
 * because loosening allowlist matching here would admit servers that are
 * currently rejected.
 */
export class McpSettingsGate implements McpServerGate {
  evaluate(request: McpGateRequest): McpGateDecision {
    const { serverName, allowList, excludeList } = request;

    if (allowList.length > 0 && !allowList.includes(serverName)) {
      return {
        allowed: false,
        reason: MCP_GATE_DENY_ALLOWLIST,
        detail: `Server '${serverName}' is not in mcp.allowed. Add it to settings.json mcp.allowed array to enable.`,
      };
    }

    if (excludeList.includes(serverName)) {
      return {
        allowed: false,
        reason: MCP_GATE_DENY_EXCLUDELIST,
        detail: `Server '${serverName}' is blocked by mcp.excluded. Remove it from settings.json mcp.excluded array to enable.`,
      };
    }

    return { allowed: true };
  }
}
