/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  hashDaemonWorkspace,
  recordDaemonError,
  recordDaemonHttpRequest,
  recordDaemonHttpResponse,
  withDaemonRequestSpan,
} from '@qwen-code/qwen-code-core';
import type { NextFunction, Request, Response } from 'express';
import {
  CLIENT_ID_HEADER,
  CLIENT_ID_RE,
  getDeferredRuntimeRequestTiming,
  MAX_CLIENT_ID_LENGTH,
} from './request-helpers.js';

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Route handlers are split across `routes/*.ts`; any added or renamed route
// that needs daemon telemetry must keep these patterns in sync.
export function resolveDaemonTelemetryRoute(
  req: Request,
):
  | { route: string; sessionId?: string; permissionRequestId?: string }
  | undefined {
  const path = req.path.replace(/\/$/, '') || '/';
  if (req.method === 'POST' && path === '/session') {
    return { route: 'POST /session' };
  }
  if (req.method === 'POST' && path === '/sessions/delete') {
    return { route: 'POST /sessions/delete' };
  }
  if (req.method === 'GET' && path === '/daemon/status') {
    return { route: 'GET /daemon/status' };
  }
  const rewindSnapshots = path.match(/^\/session\/([^/]+)\/rewind\/snapshots$/);
  if (rewindSnapshots?.[1] && req.method === 'GET') {
    return {
      route: 'GET /session/:id/rewind/snapshots',
      sessionId: rewindSnapshots[1],
    };
  }
  const sessionAction = path.match(
    /^\/session\/([^/]+)\/(load|resume|prompt|cancel|recap|btw|mid-turn-message|model|shell|detach|rewind|approval-mode|language|a2ui-action)$/,
  );
  const sessionActionId = sessionAction?.[1];
  const sessionActionName = sessionAction?.[2];
  if (sessionActionId && sessionActionName && req.method === 'POST') {
    return {
      route: `POST /session/:id/${sessionActionName}`,
      sessionId: sessionActionId,
    };
  }
  const sessionMetadata = path.match(/^\/session\/([^/]+)\/metadata$/);
  if (sessionMetadata?.[1] && req.method === 'PATCH') {
    return {
      route: 'PATCH /session/:id/metadata',
      sessionId: sessionMetadata[1],
    };
  }
  const sessionArtifacts = path.match(/^\/session\/([^/]+)\/artifacts$/);
  if (sessionArtifacts?.[1]) {
    if (req.method === 'GET') {
      return {
        route: 'GET /session/:id/artifacts',
        sessionId: sessionArtifacts[1],
      };
    }
    if (req.method === 'POST') {
      return {
        route: 'POST /session/:id/artifacts',
        sessionId: sessionArtifacts[1],
      };
    }
  }
  const sessionArtifact = path.match(
    /^\/session\/([^/]+)\/artifacts\/([^/]+)$/,
  );
  if (sessionArtifact?.[1] && req.method === 'DELETE') {
    return {
      route: 'DELETE /session/:id/artifacts/:artifactId',
      sessionId: sessionArtifact[1],
    };
  }
  const sessionPermission = path.match(
    /^\/session\/([^/]+)\/permission\/([^/]+)$/,
  );
  if (
    sessionPermission?.[1] &&
    sessionPermission?.[2] &&
    req.method === 'POST'
  ) {
    const rawRequestId = sessionPermission[2];
    return {
      route: 'POST /session/:id/permission/:requestId',
      sessionId: sessionPermission[1],
      ...(rawRequestId.length <= MAX_CLIENT_ID_LENGTH &&
      CLIENT_ID_RE.test(rawRequestId)
        ? { permissionRequestId: rawRequestId }
        : {}),
    };
  }
  const globalPermission = path.match(/^\/permission\/([^/]+)$/);
  if (globalPermission?.[1] && req.method === 'POST') {
    const rawRequestId = globalPermission[1];
    return {
      route: 'POST /permission/:requestId',
      ...(rawRequestId.length <= MAX_CLIENT_ID_LENGTH &&
      CLIENT_ID_RE.test(rawRequestId)
        ? { permissionRequestId: rawRequestId }
        : {}),
    };
  }
  const deleteSession = path.match(/^\/session\/([^/]+)$/);
  const deleteSessionId = deleteSession?.[1];
  if (deleteSessionId && req.method === 'DELETE') {
    return { route: 'DELETE /session/:id', sessionId: deleteSessionId };
  }
  if (req.method === 'GET' && /^\/workspace\/[^/]+\/sessions$/.test(path)) {
    return { route: 'GET /workspace/:id/sessions' };
  }
  if (req.method === 'GET' && /^\/workspaces\/[^/]+\/sessions$/.test(path)) {
    return { route: 'GET /workspace/:id/sessions' };
  }
  if (req.method === 'GET' && /^\/workspace\/[^/]+\/session-info$/.test(path)) {
    return { route: 'GET /workspace/:id/session-info' };
  }
  if (
    req.method === 'GET' &&
    /^\/workspaces\/[^/]+\/session-info$/.test(path)
  ) {
    return { route: 'GET /workspace/:id/session-info' };
  }
  const workspaceTranscript = path.match(
    /^\/workspaces\/[^/]+\/session\/([^/]+)\/transcript$/,
  );
  if (workspaceTranscript?.[1] && req.method === 'GET') {
    return {
      route: 'GET /workspaces/:workspace/session/:id/transcript',
      sessionId: workspaceTranscript[1],
    };
  }
  const workspaceExport = path.match(
    /^\/workspaces\/[^/]+\/session\/([^/]+)\/export$/,
  );
  if (workspaceExport?.[1] && req.method === 'GET') {
    return {
      route: 'GET /workspaces/:workspace/session/:id/export',
      sessionId: workspaceExport[1],
    };
  }
  const workspaceArchivedExport = path.match(
    /^\/workspaces\/[^/]+\/session\/([^/]+)\/archive\/export$/,
  );
  if (workspaceArchivedExport?.[1] && req.method === 'GET') {
    return {
      route: 'GET /workspaces/:workspace/session/:id/archive/export',
      sessionId: workspaceArchivedExport[1],
    };
  }
  const pluralWorkspacePrefix = /^\/workspaces\/[^/]+/;
  if (pluralWorkspacePrefix.test(path)) {
    const suffix = path.replace(pluralWorkspacePrefix, '/workspace');
    if (req.method === 'GET') {
      if (
        suffix === '/workspace/mcp' ||
        suffix === '/workspace/skills' ||
        suffix === '/workspace/tools' ||
        suffix === '/workspace/providers' ||
        suffix === '/workspace/env' ||
        suffix === '/workspace/preflight' ||
        suffix === '/workspace/hooks' ||
        suffix === '/workspace/settings' ||
        suffix === '/workspace/voice' ||
        suffix === '/workspace/permissions' ||
        suffix === '/workspace/trust' ||
        suffix === '/workspace/memory' ||
        suffix === '/workspace/agents'
      ) {
        return { route: `GET ${suffix}` };
      }
      if (/^\/workspace\/agents\/[^/]+$/.test(suffix)) {
        return { route: 'GET /workspace/agents/:agentType' };
      }
      if (suffix === '/workspace/file') return { route: 'GET /file' };
      if (suffix === '/workspace/file/bytes') {
        return { route: 'GET /file/bytes' };
      }
      if (suffix === '/workspace/stat') return { route: 'GET /stat' };
      if (suffix === '/workspace/list') return { route: 'GET /list' };
      if (suffix === '/workspace/glob') return { route: 'GET /glob' };
      if (/^\/workspace\/mcp\/[^/]+\/tools$/.test(suffix)) {
        return { route: 'GET /workspace/mcp/:server/tools' };
      }
      if (/^\/workspace\/mcp\/[^/]+\/resources$/.test(suffix)) {
        return { route: 'GET /workspace/mcp/:server/resources' };
      }
    }
    if (req.method === 'POST') {
      if (
        suffix === '/workspace/settings' ||
        suffix === '/workspace/voice' ||
        suffix === '/workspace/voice/transcribe' ||
        suffix === '/workspace/permissions' ||
        suffix === '/workspace/trust/request' ||
        suffix === '/workspace/init' ||
        suffix === '/workspace/reload' ||
        suffix === '/workspace/file/write' ||
        suffix === '/workspace/file/edit' ||
        suffix === '/workspace/mcp/servers' ||
        suffix === '/workspace/memory' ||
        suffix === '/workspace/agents' ||
        suffix === '/workspace/sessions/delete' ||
        suffix === '/workspace/sessions/archive' ||
        suffix === '/workspace/sessions/unarchive' ||
        suffix === '/workspace/session-groups'
      ) {
        return { route: `POST ${suffix}` };
      }
      if (/^\/workspace\/tools\/[^/]+\/enable$/.test(suffix)) {
        return { route: 'POST /workspace/tools/:name/enable' };
      }
      if (/^\/workspace\/mcp\/[^/]+\/restart$/.test(suffix)) {
        return { route: 'POST /workspace/mcp/:server/restart' };
      }
      if (/^\/workspace\/agents\/[^/]+$/.test(suffix)) {
        return { route: 'POST /workspace/agents/:agentType' };
      }
      if (
        /^\/workspace\/mcp\/[^/]+\/(approve|enable|disable|authenticate|clear-auth)$/.test(
          suffix,
        )
      ) {
        return {
          route: `POST /workspace/mcp/:server/${suffix.split('/').at(-1)}`,
        };
      }
    }
    if (
      req.method === 'DELETE' &&
      /^\/workspace\/mcp\/servers\/[^/]+$/.test(suffix)
    ) {
      return { route: 'DELETE /workspace/mcp/servers/:name' };
    }
    if (
      req.method === 'DELETE' &&
      /^\/workspace\/agents\/[^/]+$/.test(suffix)
    ) {
      return { route: 'DELETE /workspace/agents/:agentType' };
    }
    if (suffix === '/workspace/session-groups' && req.method === 'GET') {
      return { route: 'GET /workspace/session-groups' };
    }
    if (
      /^\/workspace\/session-groups\/[^/]+$/.test(suffix) &&
      req.method === 'PATCH'
    ) {
      return { route: 'PATCH /workspace/session-groups/:groupId' };
    }
    if (
      /^\/workspace\/session-groups\/[^/]+$/.test(suffix) &&
      req.method === 'DELETE'
    ) {
      return { route: 'DELETE /workspace/session-groups/:groupId' };
    }
  }
  if (req.method === 'POST' && path === '/workspace/init') {
    return { route: 'POST /workspace/init' };
  }
  if (req.method === 'POST' && path === '/workspace/setup-github') {
    return { route: 'POST /workspace/setup-github' };
  }
  if (req.method === 'POST' && path === '/workspace/reload') {
    return { route: 'POST /workspace/reload' };
  }
  const mcpRestart = path.match(/^\/workspace\/mcp\/([^/]+)\/restart$/);
  if (mcpRestart?.[1] && req.method === 'POST') {
    return { route: 'POST /workspace/mcp/:server/restart' };
  }
  if (req.method === 'POST' && path === '/workspace/mcp/servers') {
    return { route: 'POST /workspace/mcp/servers' };
  }
  const mcpDelete = path.match(/^\/workspace\/mcp\/servers\/([^/]+)$/);
  if (mcpDelete?.[1] && req.method === 'DELETE') {
    return { route: 'DELETE /workspace/mcp/servers/:name' };
  }
  if (req.method === 'POST' && path === '/workspace/auth/device-flow') {
    return { route: 'POST /workspace/auth/device-flow' };
  }
  const deviceFlowDelete = path.match(
    /^\/workspace\/auth\/device-flow\/([^/]+)$/,
  );
  if (deviceFlowDelete?.[1] && req.method === 'DELETE') {
    return { route: 'DELETE /workspace/auth/device-flow/:id' };
  }
  const toolEnable = path.match(/^\/workspace\/tools\/([^/]+)\/enable$/);
  if (toolEnable?.[1] && req.method === 'POST') {
    return { route: 'POST /workspace/tools/:name/enable' };
  }
  if (path === '/workspace/settings') {
    if (req.method === 'GET') return { route: 'GET /workspace/settings' };
    if (req.method === 'POST') return { route: 'POST /workspace/settings' };
  }
  if (path === '/workspace/permissions') {
    if (req.method === 'GET') return { route: 'GET /workspace/permissions' };
    if (req.method === 'POST') return { route: 'POST /workspace/permissions' };
  }
  if (path === '/workspace/trust') {
    if (req.method === 'GET') return { route: 'GET /workspace/trust' };
  }
  if (req.method === 'POST' && path === '/workspace/trust/request') {
    return { route: 'POST /workspace/trust/request' };
  }
  if (path === '/workspace/voice') {
    if (req.method === 'GET') return { route: 'GET /workspace/voice' };
    if (req.method === 'POST') return { route: 'POST /workspace/voice' };
  }
  if (req.method === 'POST' && path === '/workspace/voice/transcribe') {
    return { route: 'POST /workspace/voice/transcribe' };
  }
  return undefined;
}

export function daemonTelemetryMiddleware(
  resolveWorkspaceCwd: (req: Request) => string,
  // Optional in-process sink for the Daemon Status dashboard's time-series
  // charts. Fed the same (durationMs, statusCode) already computed for OTel,
  // so it adds no extra measurement — just a second consumer. Only known
  // routes (those `resolveDaemonTelemetryRoute` matches) are counted, matching
  // the OTel counter's scope, so the "requests" line reflects daemon API
  // traffic rather than static-asset or unrouted noise.
  recordRequest?: (durationMs: number, statusCode: number) => void,
  resolveSessionWorkspaceCwd?: (sessionId: string) => string | undefined,
): (req: Request, res: Response, next: NextFunction) => void {
  const workspaceHashByCwd = new Map<string, string>();
  const resolveWorkspaceHash = (workspaceCwd: string): string => {
    const existing = workspaceHashByCwd.get(workspaceCwd);
    if (existing !== undefined) return existing;
    const workspaceHash = hashDaemonWorkspace(workspaceCwd);
    workspaceHashByCwd.set(workspaceCwd, workspaceHash);
    return workspaceHash;
  };

  return (req, res, next) => {
    const route = resolveDaemonTelemetryRoute(req);
    if (!route) {
      next();
      return;
    }
    const resolveOwnerWorkspace =
      route.route === 'GET /session/:id/rewind/snapshots' ||
      route.route === 'POST /session/:id/rewind' ||
      route.route === 'POST /session/:id/shell';
    const sessionId = route.sessionId
      ? decodePathSegment(route.sessionId)
      : undefined;
    const workspaceCwd =
      (resolveOwnerWorkspace && sessionId
        ? resolveSessionWorkspaceCwd?.(sessionId)
        : undefined) ?? resolveWorkspaceCwd(req);
    const workspaceHash = resolveWorkspaceHash(workspaceCwd);
    const rawClientId = req.get(CLIENT_ID_HEADER);
    const clientId =
      rawClientId !== undefined &&
      rawClientId !== '' &&
      rawClientId.length <= MAX_CLIENT_ID_LENGTH &&
      CLIENT_ID_RE.test(rawClientId)
        ? rawClientId
        : undefined;
    const deferredRuntime = getDeferredRuntimeRequestTiming(req);
    const startMs = deferredRuntime?.startedAt.getTime() ?? Date.now();
    void withDaemonRequestSpan(
      {
        method: req.method,
        route: route.route,
        workspaceHash,
        ...(sessionId ? { sessionId } : {}),
        ...(route.permissionRequestId
          ? { permissionRequestId: route.permissionRequestId }
          : {}),
        ...(clientId ? { clientId } : {}),
        ...(deferredRuntime?.waitMs !== undefined
          ? {
              startTime: deferredRuntime.startedAt,
              deferredRuntimeWaitMs: deferredRuntime.waitMs,
              deferredRuntimePath: deferredRuntime.path,
            }
          : {}),
      },
      async (span) =>
        await new Promise<void>((resolve, reject) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            recordDaemonHttpResponse(span, res.statusCode);
            const durationMs = Date.now() - startMs;
            recordDaemonHttpRequest(
              durationMs,
              route.route,
              res.statusCode,
              deferredRuntime?.path,
            );
            // Exclude the dashboard's own status poll from the metrics-ring
            // request rate/latency, or the Requests chart shows a baseline of
            // ≥1/window with no external traffic (the dashboard counting itself)
            // — misleading an operator investigating load. OTel still counts it.
            if (route.route !== 'GET /daemon/status') {
              recordRequest?.(durationMs, res.statusCode);
            }
            resolve();
          };
          res.once('finish', finish);
          res.once('close', finish);
          try {
            next();
          } catch (error) {
            recordDaemonError(span, error);
            reject(error);
          }
        }),
    ).catch(next);
  };
}
