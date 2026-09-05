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
import { isInternalWorkspaceRuntime } from '../workspace-runtime-visibility.js';
import {
  sendUntrustedWorkspaceResponse,
  sendWorkspaceRuntimeUnavailable,
} from '../workspace-route-runtime.js';
import { setDaemonTelemetryWorkspace } from '../server/telemetry.js';

export function requirePrimarySessionRuntime(
  workspaceRegistry: WorkspaceRegistry,
  res: Response,
): WorkspaceRuntime | undefined {
  const entry = workspaceRegistry.primaryEntry;
  const runtime = entry.state === 'active' ? entry.current?.runtime : undefined;
  if (runtime) {
    setDaemonTelemetryWorkspace(res, runtime.workspaceCwd);
    return runtime;
  }
  sendWorkspaceRuntimeUnavailable(res, entry);
  return undefined;
}

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
  if (workspaceRegistry.listAllEntries().length === 1) {
    return requirePrimarySessionRuntime(workspaceRegistry, res);
  }

  const resolution = workspaceRegistry.resolveLiveSessionOwner(sessionId);
  if (resolution.kind === 'unavailable') {
    daemonLog?.warn('session routing failed', {
      route,
      resolutionKind: 'workspace_runtime_unavailable',
      sessionId,
      ...details,
    });
    sendWorkspaceRuntimeUnavailable(res);
    return undefined;
  }
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
    if (
      workspaceRegistry.primaryEntry.state !== 'active' ||
      !workspaceRegistry.primaryEntry.current
    ) {
      return requirePrimarySessionRuntime(workspaceRegistry, res);
    }
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
    ...(resolution.runtimes.every(
      (runtime) => !isInternalWorkspaceRuntime(runtime),
    )
      ? { workspaceIds }
      : {}),
  });
  return undefined;
}
