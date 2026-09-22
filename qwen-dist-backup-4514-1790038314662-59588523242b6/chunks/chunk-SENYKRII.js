// Force strict mode and setup for ESM
"use strict";
import {
  TotalSessionLimitExceededError,
  WorkspaceDrainingError
} from "./chunk-YXHY6BKS.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/total-session-admission.ts
init_esbuild_shims();
function createTotalSessionAdmissionController({
  maxTotalSessions,
  getBridges
}) {
  let inFlight = 0;
  const inFlightByWorkspace = /* @__PURE__ */ new Map();
  const drainingWorkspaces = /* @__PURE__ */ new Set();
  const limit = maxTotalSessions === void 0 || maxTotalSessions === 0 || maxTotalSessions === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : maxTotalSessions;
  return {
    admit(context) {
      if (drainingWorkspaces.has(context.workspaceCwd)) {
        throw new WorkspaceDrainingError(context.workspaceCwd);
      }
      if (limit !== Number.POSITIVE_INFINITY) {
        if (getLiveCount(getBridges()) + inFlight >= limit) {
          throw Object.assign(new TotalSessionLimitExceededError(limit), {
            operation: context.operation,
            workspaceCwd: context.workspaceCwd,
            ...context.sessionId ? { sessionId: context.sessionId } : {},
            ...context.sourceSessionId ? { sourceSessionId: context.sourceSessionId } : {}
          });
        }
      }
      inFlight++;
      inFlightByWorkspace.set(
        context.workspaceCwd,
        (inFlightByWorkspace.get(context.workspaceCwd) ?? 0) + 1
      );
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          inFlight--;
          const workspaceInFlight = (inFlightByWorkspace.get(context.workspaceCwd) ?? 1) - 1;
          if (workspaceInFlight <= 0) {
            inFlightByWorkspace.delete(context.workspaceCwd);
          } else {
            inFlightByWorkspace.set(context.workspaceCwd, workspaceInFlight);
          }
        }
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
        inFlight: inFlightByWorkspace.get(workspaceCwd) ?? 0
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
    }
  };
}
__name(createTotalSessionAdmissionController, "createTotalSessionAdmissionController");
function getLiveCount(bridges) {
  return bridges.reduce((sum, bridge) => sum + bridge.sessionCount, 0);
}
__name(getLiveCount, "getLiveCount");

export {
  createTotalSessionAdmissionController
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
