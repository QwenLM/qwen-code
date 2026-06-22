/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApprovalMode } from '../config/config.js';
import type { MergedGateFinding } from './types.js';

/**
 * Where the gate is in its lifecycle for the current Plan Mode Entry.
 *
 * - `capped`: normal single-agent gate review, bounded by the capped review limit.
 * - `uncapped`: user chose to keep iterating past the cap; gate still runs but
 *   the round limit no longer applies.
 * - `user_takeover`: user took manual control; the automatic gate stops and
 *   exit_plan_mode reverts to the normal user-confirmation path.
 * - `user_override`: user approved execution at the cap; exit skips the gate.
 */
export type GateMode =
  | 'capped'
  | 'uncapped'
  | 'user_takeover'
  | 'user_override';

/**
 * Session-scoped state for a single Plan Mode Entry. Held on `Config`, created
 * fresh on entering PLAN and cleared on successfully leaving PLAN.
 */
export interface PlanGateState {
  /** Identifies the current Plan Mode Entry; increments on each PLAN entry. */
  entryId: number;
  /** Number of capped review rounds consumed so far. */
  reviewCount: number;
  gateMode: GateMode;
  /**
   * True when plan mode was entered by the model via `enter_plan_mode` (an
   * autonomous flow that should be gated by the LLM reviewer). False when the
   * user entered plan mode explicitly (Shift+Tab, `/plan`, the approval-mode
   * dialog) — those entries always route through the user confirmation dialog,
   * regardless of `prePlanMode`. See issue #5574: cycling Shift+Tab to PLAN
   * always lands with `prePlanMode === 'yolo'` (it is the mode immediately
   * before PLAN in the cycle), which must NOT auto-approve via the gate.
   */
  enteredByModel: boolean;
  /** Findings merged in the previous round, for the next Evidence Bundle. */
  lastFindings: MergedGateFinding[];
  /** Main model's resolution summary for the previous round's findings. */
  lastResolutionSummary?: string;
  /** True once the cap is hit with remaining P1/P2 and the user must decide. */
  capEscalationPending: boolean;
  /** True once the gate returns needs_user and the user must answer. */
  needsUserPending: boolean;
}

export function createPlanGateState(
  entryId: number,
  enteredByModel = false,
): PlanGateState {
  return {
    entryId,
    reviewCount: 0,
    gateMode: 'capped',
    enteredByModel,
    lastFindings: [],
    capEscalationPending: false,
    needsUserPending: false,
  };
}

/** AUTO and YOLO are the autonomous modes that route exit through the gate. */
export function isAutonomousPrePlanMode(mode: ApprovalMode): boolean {
  return mode === ApprovalMode.AUTO || mode === ApprovalMode.YOLO;
}
