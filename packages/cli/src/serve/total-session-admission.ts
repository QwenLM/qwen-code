/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  TotalSessionLimitExceededError,
  WorkspaceDrainingError,
  type BridgeFreshSessionAdmission,
  type BridgeFreshSessionAdmissionContext,
  type BridgeFreshSessionReservation,
} from './acp-session-bridge.js';

interface SessionCountSource {
  readonly sessionCount: number;
}

export interface TotalSessionAdmissionOptions {
  readonly maxTotalSessions?: number;
  readonly getBridges: () => readonly SessionCountSource[];
}

export interface TotalSessionAdmissionSnapshot {
  readonly liveCount: number;
  readonly inFlight: number;
}

export interface TotalSessionAdmissionController {
  readonly admit: BridgeFreshSessionAdmission;
  readonly snapshot: () => TotalSessionAdmissionSnapshot;
  readonly snapshotForWorkspace: (
    workspaceCwd: string,
  ) => TotalSessionAdmissionSnapshot;
  readonly beginWorkspaceDrain: (workspaceCwd: string) => void;
  readonly cancelWorkspaceDrain: (workspaceCwd: string) => void;
  readonly completeWorkspaceDrain: (workspaceCwd: string) => void;
}

export function createTotalSessionAdmissionController({
  maxTotalSessions,
  getBridges,
}: TotalSessionAdmissionOptions): TotalSessionAdmissionController {
  let inFlight = 0;
  const inFlightByWorkspace = new Map<string, number>();
  const drainingWorkspaces = new Set<string>();
  const limit =
    maxTotalSessions === undefined ||
    maxTotalSessions === 0 ||
    maxTotalSessions === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : maxTotalSessions;

  return {
    admit(
      context: BridgeFreshSessionAdmissionContext,
    ): BridgeFreshSessionReservation {
      if (drainingWorkspaces.has(context.workspaceCwd)) {
        throw new WorkspaceDrainingError(context.workspaceCwd);
      }
      if (limit !== Number.POSITIVE_INFINITY) {
        if (getLiveCount(getBridges()) + inFlight >= limit) {
          throw Object.assign(new TotalSessionLimitExceededError(limit), {
            operation: context.operation,
            workspaceCwd: context.workspaceCwd,
            ...(context.sessionId ? { sessionId: context.sessionId } : {}),
            ...(context.sourceSessionId
              ? { sourceSessionId: context.sourceSessionId }
              : {}),
          });
        }
      }

      inFlight++;
      inFlightByWorkspace.set(
        context.workspaceCwd,
        (inFlightByWorkspace.get(context.workspaceCwd) ?? 0) + 1,
      );
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          inFlight--;
          const workspaceInFlight =
            (inFlightByWorkspace.get(context.workspaceCwd) ?? 1) - 1;
          if (workspaceInFlight <= 0) {
            inFlightByWorkspace.delete(context.workspaceCwd);
          } else {
            inFlightByWorkspace.set(context.workspaceCwd, workspaceInFlight);
          }
        },
      };
    },
    snapshot() {
      return { liveCount: getLiveCount(getBridges()), inFlight };
    },
    snapshotForWorkspace(workspaceCwd) {
      return {
        // Per-workspace live sessions remain bridge-owned; removal reads
        // `runtime.bridge.sessionCount`. This controller only owns admission
        // reservations, so the aggregate snapshot shape uses zero here.
        liveCount: 0,
        inFlight: inFlightByWorkspace.get(workspaceCwd) ?? 0,
      };
    },
    beginWorkspaceDrain(workspaceCwd) {
      drainingWorkspaces.add(workspaceCwd);
    },
    cancelWorkspaceDrain(workspaceCwd) {
      drainingWorkspaces.delete(workspaceCwd);
    },
    completeWorkspaceDrain(workspaceCwd) {
      drainingWorkspaces.delete(workspaceCwd);
      inFlightByWorkspace.delete(workspaceCwd);
    },
  };
}

function getLiveCount(bridges: readonly SessionCountSource[]): number {
  return bridges.reduce((sum, bridge) => sum + bridge.sessionCount, 0);
}
