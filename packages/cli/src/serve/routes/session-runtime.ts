/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import type { DaemonLogger } from '../daemon-logger.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import { sendUntrustedWorkspaceResponse } from '../workspace-route-runtime.js';
import { setDaemonTelemetryWorkspace } from '../server/telemetry.js';

export function requireSessionRuntime(opts: {
  sessionId: string;
  route: string;
  res: Response;
  workspaceRegistry: WorkspaceRegistry;
  daemonLog?: DaemonLogger;
  details?: Record<string, unknown>;
}): WorkspaceRuntime | undefined {
  const {
    sessionId,
    route,
    res,
    workspaceRegistry,
    daemonLog,
    details = {},
  } = opts;
  if (workspaceRegistry.list().length === 1) {
    const runtime = workspaceRegistry.primary;
    setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
    return runtime;
  }

  const resolution = workspaceRegistry.resolveLiveSessionOwner(sessionId);
  if (resolution.kind === 'found') {
    const runtime = resolution.runtime;
    setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
    if (!runtime.primary && !runtime.trusted) {
      daemonLog?.warn('session routing failed', {
        route,
        resolutionKind: 'untrusted_workspace',
        sessionId,
        workspaceId: runtime.workspaceId,
        workspaceCwd: runtime.workspaceCwd,
        ...details,
      });
      sendUntrustedWorkspaceResponse(res, {
        sessionId,
        workspaceCwd: runtime.workspaceCwd,
        workspaceId: runtime.workspaceId,
      });
      return undefined;
    }
    return runtime;
  }

  if (resolution.kind === 'not_found') {
    daemonLog?.warn('session routing failed', {
      route,
      resolutionKind: 'not_found',
      sessionId,
      ...details,
    });
    res.status(404).json({
      error: `No session with id "${sessionId}"`,
      code: 'session_not_found',
      sessionId,
    });
    return undefined;
  }

  const workspaceIds = resolution.runtimes.map(
    (runtime) => runtime.workspaceId,
  );
  daemonLog?.warn('session routing failed', {
    route,
    resolutionKind: 'ambiguous',
    sessionId,
    workspaceIds,
    ...details,
  });
  res.status(500).json({
    error: `Session owner is ambiguous for "${sessionId}"`,
    code: 'ambiguous_session_owner',
    sessionId,
    route,
    workspaceIds,
  });
  return undefined;
}
