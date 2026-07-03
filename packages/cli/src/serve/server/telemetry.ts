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
  MAX_CLIENT_ID_LENGTH,
} from './request-helpers.js';

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
  boundWorkspace: string,
): (req: Request, res: Response, next: NextFunction) => void {
  const workspaceHash = hashDaemonWorkspace(boundWorkspace);
  return (req, res, next) => {
    const route = resolveDaemonTelemetryRoute(req);
    if (!route) {
      next();
      return;
    }
    const rawClientId = req.get(CLIENT_ID_HEADER);
    const clientId =
      rawClientId !== undefined &&
      rawClientId !== '' &&
      rawClientId.length <= MAX_CLIENT_ID_LENGTH &&
      CLIENT_ID_RE.test(rawClientId)
        ? rawClientId
        : undefined;
    const startMs = Date.now();
    void withDaemonRequestSpan(
      {
        method: req.method,
        route: route.route,
        workspaceHash,
        ...(route.sessionId ? { sessionId: route.sessionId } : {}),
        ...(route.permissionRequestId
          ? { permissionRequestId: route.permissionRequestId }
          : {}),
        ...(clientId ? { clientId } : {}),
      },
      async (span) =>
        await new Promise<void>((resolve, reject) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            recordDaemonHttpResponse(span, res.statusCode);
            recordDaemonHttpRequest(
              Date.now() - startMs,
              route.route,
              res.statusCode,
            );
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
