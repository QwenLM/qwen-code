/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * AUTO mode denial-tracking state machine.
 *
 * Protects users from infinite loops when the classifier persistently blocks
 * (LLM stuck in a dead-end) or persistently fails (infrastructure problem).
 * After the consecutive thresholds are exceeded the orchestrator falls back
 * to DEFAULT-mode confirmation flow for the next tool call. The session
 * itself stays in AUTO; only the single offending call is downgraded.
 *
 * Block and unavailable counters cross-reset: they represent different
 * failure modes and should not accumulate together. Switching ApprovalMode
 * resets all counters.
 *
 * `total*` counters are telemetry-only — they do NOT trigger fallback.
 * A long session naturally accumulates blocks; forcing manual approval after
 * an absolute total would harm UX.
 */

/** Reasons the orchestrator may choose to fall back to manual approval. */
export type DenialFallbackReason =
  | 'consecutive_block'
  | 'consecutive_unavailable';

export interface AutoModeDenialState {
  consecutiveBlock: number;
  consecutiveUnavailable: number;
  totalBlock: number;
  totalUnavailable: number;
}

export const AUTO_MODE_DENIAL_LIMITS = {
  maxConsecutiveBlock: 3,
  maxConsecutiveUnavailable: 2,
} as const;

/** Freshly-initialised state with all counters zero. */
export function createDenialState(): AutoModeDenialState {
  return {
    consecutiveBlock: 0,
    consecutiveUnavailable: 0,
    totalBlock: 0,
    totalUnavailable: 0,
  };
}

/** Record a successful (allow) decision. Resets both consecutive counters. */
export function recordAllow(state: AutoModeDenialState): AutoModeDenialState {
  if (state.consecutiveBlock === 0 && state.consecutiveUnavailable === 0) {
    return state; // no-op
  }
  return {
    ...state,
    consecutiveBlock: 0,
    consecutiveUnavailable: 0,
  };
}

/**
 * Record a classifier-policy block. Increments `consecutiveBlock` and
 * `totalBlock`; cross-resets `consecutiveUnavailable`.
 */
export function recordBlock(state: AutoModeDenialState): AutoModeDenialState {
  return {
    consecutiveBlock: state.consecutiveBlock + 1,
    consecutiveUnavailable: 0,
    totalBlock: state.totalBlock + 1,
    totalUnavailable: state.totalUnavailable,
  };
}

/**
 * Record a classifier-unavailable (infrastructure failure) outcome.
 * Increments `consecutiveUnavailable` and `totalUnavailable`; cross-resets
 * `consecutiveBlock`.
 */
export function recordUnavailable(
  state: AutoModeDenialState,
): AutoModeDenialState {
  return {
    consecutiveBlock: 0,
    consecutiveUnavailable: state.consecutiveUnavailable + 1,
    totalBlock: state.totalBlock,
    totalUnavailable: state.totalUnavailable + 1,
  };
}

/**
 * Decide whether the next tool call should bypass the classifier and fall
 * back to DEFAULT-mode confirmation. The fallback applies to a single call
 * only; the session remains in AUTO.
 */
export function shouldFallback(
  state: AutoModeDenialState,
): { fallback: true; reason: DenialFallbackReason } | { fallback: false } {
  if (state.consecutiveBlock >= AUTO_MODE_DENIAL_LIMITS.maxConsecutiveBlock) {
    return { fallback: true, reason: 'consecutive_block' };
  }
  if (
    state.consecutiveUnavailable >=
    AUTO_MODE_DENIAL_LIMITS.maxConsecutiveUnavailable
  ) {
    return { fallback: true, reason: 'consecutive_unavailable' };
  }
  return { fallback: false };
}

/**
 * Called after the user manually approves a fallback-prompted tool call.
 * Resets BOTH consecutive counters so the agent can resume normal AUTO flow.
 *
 * Symmetric with `recordAllow`: a manual approval signals the user accepted
 * the action, and the next call should re-engage the classifier. If the
 * classifier or its infrastructure is still degraded, the next call's
 * verdict will simply re-arm the appropriate counter (one block / one
 * unavailable) — same recovery curve as initial onset, no permanent
 * lock-out. Resetting only `consecutiveBlock` (the original v1 behaviour)
 * created an asymmetry: a transient API blip past
 * `maxConsecutiveUnavailable` would permanently downgrade the rest of the
 * session to manual approval even after the user approved the fallback
 * prompt, until ApprovalMode toggled.
 */
export function recordFallbackApprove(
  state: AutoModeDenialState,
): AutoModeDenialState {
  if (state.consecutiveBlock === 0 && state.consecutiveUnavailable === 0) {
    return state;
  }
  return { ...state, consecutiveBlock: 0, consecutiveUnavailable: 0 };
}

// (No `recordFallbackReject` helper: rejection deliberately leaves
// counters unchanged. The invariant is enforced by simply not calling
// any state-mutating function on the reject path — adding a no-op
// helper would invite future maintainers to wire it in and create
// drift between the doc'd "reject preserves state" rule and code.)

/**
 * True when a `ToolConfirmationOutcome` represents the user approving
 * the call (any kind of "proceed"). Shared between the CLI scheduler's
 * outcome handler and the ACP Session's outcome handler so adding a new
 * approve-shaped outcome can't drift between the two paths.
 *
 * Cancel / abort intentionally not handled — they leave denialTracking
 * untouched on the AUTO-fallback path. Caller decides.
 */
export function isApproveOutcome(outcome: string): boolean {
  return (
    outcome === 'proceed_once' ||
    outcome === 'proceed_always' ||
    outcome === 'proceed_always_project' ||
    outcome === 'proceed_always_user' ||
    outcome === 'modify_with_editor'
  );
}

/**
 * Reset every counter. Called when the user switches ApprovalMode (a
 * deliberate change of intent invalidates the historic signal).
 */
export function resetDenialState(): AutoModeDenialState {
  return createDenialState();
}
