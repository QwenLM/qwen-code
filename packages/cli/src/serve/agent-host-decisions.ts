/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Permission decisions on the Agent Host wire, shared by the
 * coordinator routes and the Host client.
 *
 * The coordinator keeps a run's decisions until the Host reports
 * `permission_resolved`, so the same decision arrives many times. A decision
 * is told apart by its key: the coordinator's `decisionId` when it stamps one
 * (one per answer, so a person answering a re-armed request again is a new
 * decision), else the answer itself.
 */

import type { HostPermissionDecision } from '@qwen-code/qwen-code-core/agents/session-agents/contract.js';

/** A decision as it travels; older coordinators send no `decisionId`. */
export type HostDecision = HostPermissionDecision & { decisionId?: string };

/** One request a Host is waiting on, with the decision keys it has used. */
export interface HostAwaitedPermission {
  runId: string;
  attempt: number;
  requestId: string;
  seen: string[];
}

export function hostDecisionKey(decision: HostDecision): string {
  return typeof decision.decisionId === 'string' && decision.decisionId
    ? `id:${decision.decisionId}`
    : `option:${decision.optionId}`;
}

/** The decisions that answer a request the Host waits on, not yet used. */
export function decisionsForAwaited(
  decisions: readonly HostDecision[],
  awaited: readonly HostAwaitedPermission[],
): HostDecision[] {
  return decisions.filter((decision) =>
    awaited.some(
      (entry) =>
        entry.runId === decision.runId &&
        entry.attempt === decision.attempt &&
        entry.requestId === decision.requestId &&
        !entry.seen.includes(hostDecisionKey(decision)),
    ),
  );
}
