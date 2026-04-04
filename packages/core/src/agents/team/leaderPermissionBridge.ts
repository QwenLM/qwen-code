/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Leader Permission Bridge — module-level singleton that routes
 * teammate tool approval requests to the leader's UI.
 *
 * In Phase 1 (in-process), teammates share the same Node.js
 * process as the leader. When a teammate's CoreToolScheduler
 * decides a tool needs user approval, the TOOL_WAITING_APPROVAL
 * event is forwarded through this bridge so the leader's UI
 * can show the confirmation dialog with a worker badge
 * (teammate name + color).
 *
 * Usage:
 *   1. Leader registers via registerLeader() on team create.
 *   2. TeamManager.setupEventBridge() calls forwardApproval()
 *      when a teammate emits TOOL_WAITING_APPROVAL.
 *   3. Leader's UI reads the forwarded approval from the queue.
 *   4. Leader unregisters via unregisterLeader() on team delete.
 */

import type {
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
} from '../../tools/tools.js';

// ─── Types ───────────────────────────────────────────────────

/**
 * Approval request forwarded from a teammate to the leader's UI.
 */
export interface ForwardedApproval {
  /** Teammate that needs approval. */
  teammateName: string;
  /** Teammate's assigned color for UI badge. */
  teammateColor?: string;
  /** Original confirmation details (with onConfirm callback). */
  details: ToolCallConfirmationDetails;
}

/**
 * Callbacks that the leader's UI registers on the bridge.
 */
export interface LeaderApprovalCallbacks {
  /**
   * Push a teammate's tool approval request into the
   * leader's confirmation queue. The leader's UI will
   * render it alongside the leader's own pending approvals.
   */
  enqueueApproval(approval: ForwardedApproval): void;
}

// ─── Singleton State ─────────────────────────────────────────

let leaderCallbacks: LeaderApprovalCallbacks | null = null;

// ─── Public API ──────────────────────────────────────────────

/**
 * Register the leader's approval callbacks.
 * Called once when the team is created.
 */
export function registerLeader(callbacks: LeaderApprovalCallbacks): void {
  leaderCallbacks = callbacks;
}

/**
 * Get the currently registered leader callbacks, or null
 * if no leader is registered (startup race / not in a team).
 */
export function getLeader(): LeaderApprovalCallbacks | null {
  return leaderCallbacks;
}

/**
 * Unregister the leader. Called on team delete / cleanup.
 */
export function unregisterLeader(): void {
  leaderCallbacks = null;
}

/**
 * Forward a teammate's tool approval request to the leader.
 *
 * If the bridge is registered, the request is pushed to the
 * leader's approval queue. Returns true if forwarded.
 *
 * If no leader is registered (bridge is null), returns false.
 * The caller should fall back to permissionSync (file-based).
 */
export function forwardApproval(
  teammateName: string,
  teammateColor: string | undefined,
  details: ToolCallConfirmationDetails,
): boolean {
  if (!leaderCallbacks) {
    return false;
  }
  leaderCallbacks.enqueueApproval({
    teammateName,
    teammateColor,
    details,
  });
  return true;
}

/**
 * Create a wrapper around the original onConfirm callback
 * that adds teammate identity context. This allows the UI
 * to track which teammate's tool was approved/denied.
 */
export function wrapConfirmWithBadge(
  original: ToolCallConfirmationDetails,
  teammateName: string,
  _teammateColor?: string,
): ToolCallConfirmationDetails {
  // Clone the details and inject badge metadata.
  // The UI can read the extra properties for rendering.
  return {
    ...original,
    title: `[${teammateName}] ${original.title}`,
    onConfirm: async (
      outcome: ToolConfirmationOutcome,
      payload?: ToolConfirmationPayload,
    ) => {
      await original.onConfirm(outcome, payload);
    },
  } as ToolCallConfirmationDetails;
}
