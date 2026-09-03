/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { performance } from 'node:perf_hooks';
import {
  emitDaemonLog,
  extractDaemonHttpTraceContext,
  extractInboundTraceId,
  hashDaemonWorkspace,
  isTelemetrySdkInitialized,
  recordDaemonError,
  recordDaemonHttpRequest,
  recordDaemonHttpResponse,
  withDaemonRequestSpan,
} from '@qwen-code/qwen-code-core';
import { sanitizeLogText } from '@qwen-code/channel-base';
import type { NextFunction, Request, Response } from 'express';
import {
  CLIENT_ID_HEADER,
  CLIENT_ID_RE,
  getDeferredRuntimeRequestTiming,
  MAX_CLIENT_ID_LENGTH,
} from './request-helpers.js';
import {
  daemonInboundTraceIdContext,
  daemonTelemetryResponseContext,
  type InboundTraceIdResponse,
  type TelemetryResponse,
} from './telemetry-context.js';

export { getDaemonTelemetryInboundTraceId } from './telemetry-context.js';

type LegacySessionTelemetryAttribution = 'handler_resolved' | 'pre_resolved';

interface LegacySessionTelemetryRoute {
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST';
  path: string;
  attribution: LegacySessionTelemetryAttribution;
  route: string;
}

export const legacySessionTelemetryRoutes = [
  {
    method: 'POST',
    path: '/session',
    attribution: 'handler_resolved',
    route: 'POST /session',
  },
  {
    method: 'POST',
    path: '/session/:id/load',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/load',
  },
  {
    method: 'POST',
    path: '/session/:id/resume',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/resume',
  },
  {
    method: 'POST',
    path: '/session/:id/branch',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/branch',
  },
  {
    method: 'POST',
    path: '/session/:id/fork',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/fork',
  },
  {
    method: 'POST',
    path: '/session/:id/side-task',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/side-task',
  },
  {
    method: 'POST',
    path: '/session/:id/cd',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/cd',
  },
  {
    method: 'GET',
    path: '/session/:id/status',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/status',
  },
  {
    method: 'GET',
    path: '/session/:id/export',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/export',
  },
  {
    method: 'GET',
    path: '/session/:id/transcript',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/transcript',
  },
  {
    method: 'GET',
    path: '/session/:id/context',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/context',
  },
  {
    method: 'GET',
    path: '/session/:id/context-usage',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/context-usage',
  },
  {
    method: 'GET',
    path: '/session/:id/stats',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/stats',
  },
  {
    method: 'GET',
    path: '/session/:id/supported-commands',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/supported-commands',
  },
  {
    method: 'GET',
    path: '/session/:id/tasks',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/tasks',
  },
  {
    method: 'GET',
    path: '/session/:id/agents',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/agents',
  },
  {
    method: 'GET',
    path: '/session/:id/agent-trace',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/agent-trace',
  },
  {
    method: 'GET',
    path: '/session/:id/subagents/:subagentRef',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/subagents/:subagentRef',
  },
  {
    method: 'POST',
    path: '/session/:id/subagents/:subagentRef/cancel',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/subagents/:subagentRef/cancel',
  },
  {
    method: 'GET',
    path: '/session/:id/lsp',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/lsp',
  },
  {
    method: 'GET',
    path: '/session/:id/hooks',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/hooks',
  },
  {
    method: 'GET',
    path: '/session/:id/artifacts',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/artifacts',
  },
  {
    method: 'POST',
    path: '/session/:id/artifacts',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/artifacts',
  },
  {
    method: 'DELETE',
    path: '/session/:id/artifacts/:artifactId',
    attribution: 'handler_resolved',
    route: 'DELETE /session/:id/artifacts/:artifactId',
  },
  {
    method: 'POST',
    path: '/session/:id/tasks/:taskId/cancel',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/tasks/:taskId/cancel',
  },
  {
    method: 'POST',
    path: '/session/:id/tasks/:taskId/workflow-action',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/tasks/:taskId/workflow-action',
  },
  {
    method: 'GET',
    path: '/session/:id/saved-workflows/:name',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/saved-workflows/:name',
  },
  {
    method: 'POST',
    path: '/session/:id/goal',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/goal',
  },
  {
    method: 'GET',
    path: '/session/:id/goal',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/goal',
  },
  {
    method: 'POST',
    path: '/session/:id/goal/clear',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/goal/clear',
  },
  {
    method: 'POST',
    path: '/session/:id/continue',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/continue',
  },
  {
    method: 'POST',
    path: '/session/:id/attachments',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/attachments',
  },
  {
    method: 'GET',
    path: '/session/:id/attachments',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/attachments',
  },
  {
    method: 'GET',
    path: '/session/:id/attachments/:attachmentId',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/attachments/:attachmentId',
  },
  {
    method: 'DELETE',
    path: '/session/:id/attachments/:attachmentId',
    attribution: 'handler_resolved',
    route: 'DELETE /session/:id/attachments/:attachmentId',
  },
  {
    method: 'POST',
    path: '/session/:id/prompt',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/prompt',
  },
  {
    method: 'POST',
    path: '/session/:id/generate',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/generate',
  },
  {
    method: 'POST',
    path: '/session/:id/heartbeat',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/heartbeat',
  },
  {
    method: 'POST',
    path: '/session/:id/detach',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/detach',
  },
  {
    method: 'POST',
    path: '/session/:id/cancel',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/cancel',
  },
  {
    method: 'DELETE',
    path: '/session/:id',
    attribution: 'handler_resolved',
    route: 'DELETE /session/:id',
  },
  {
    method: 'POST',
    path: '/sessions/delete',
    attribution: 'handler_resolved',
    route: 'POST /sessions/delete',
  },
  {
    method: 'POST',
    path: '/sessions/archive',
    attribution: 'handler_resolved',
    route: 'POST /sessions/archive',
  },
  {
    method: 'POST',
    path: '/sessions/unarchive',
    attribution: 'handler_resolved',
    route: 'POST /sessions/unarchive',
  },
  {
    method: 'PATCH',
    path: '/session/:id/metadata',
    attribution: 'handler_resolved',
    route: 'PATCH /session/:id/metadata',
  },
  {
    method: 'PATCH',
    path: '/session/:id/organization',
    attribution: 'handler_resolved',
    route: 'PATCH /session/:id/organization',
  },
  {
    method: 'POST',
    path: '/session/:id/model',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/model',
  },
  {
    method: 'POST',
    path: '/session/:id/config-option',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/config-option',
  },
  {
    method: 'POST',
    path: '/session/:id/recap',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/recap',
  },
  {
    method: 'POST',
    path: '/session/:id/btw',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/btw',
  },
  {
    method: 'POST',
    path: '/session/:id/mid-turn-message',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/mid-turn-message',
  },
  {
    method: 'DELETE',
    path: '/session/:id/mid-turn-messages/:messageId',
    attribution: 'handler_resolved',
    route: 'DELETE /session/:id/mid-turn-messages/:messageId',
  },
  {
    method: 'GET',
    path: '/session/:id/mid-turn-messages',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/mid-turn-messages',
  },
  {
    method: 'GET',
    path: '/session/:id/pending-prompts',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/pending-prompts',
  },
  {
    method: 'DELETE',
    path: '/session/:id/pending-prompts/:promptId',
    attribution: 'handler_resolved',
    route: 'DELETE /session/:id/pending-prompts/:promptId',
  },
  {
    method: 'GET',
    path: '/session/:id/turns/current',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/turns/current',
  },
  {
    method: 'GET',
    path: '/session/:id/turns/:promptId',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/turns/:promptId',
  },
  {
    method: 'POST',
    path: '/session/:id/shell',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/shell',
  },
  {
    method: 'GET',
    path: '/session/:id/rewind/snapshots',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/rewind/snapshots',
  },
  {
    method: 'POST',
    path: '/session/:id/rewind',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/rewind',
  },
  {
    method: 'POST',
    path: '/session/:id/approval-mode',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/approval-mode',
  },
  {
    method: 'POST',
    path: '/session/:id/language',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/language',
  },
  {
    method: 'POST',
    path: '/session/:id/permission/:requestId',
    attribution: 'handler_resolved',
    route: 'POST /session/:id/permission/:requestId',
  },
  {
    method: 'POST',
    path: '/permission/:requestId',
    attribution: 'pre_resolved',
    route: 'POST /permission/:requestId',
  },
  {
    method: 'GET',
    path: '/session/:id/events',
    attribution: 'handler_resolved',
    route: 'GET /session/:id/events',
  },
  {
    method: 'POST',
    path: '/session/:id/a2ui-action',
    attribution: 'pre_resolved',
    route: 'POST /session/:id/a2ui-action',
  },
] as const satisfies readonly LegacySessionTelemetryRoute[];

interface ResolvedDaemonTelemetryRoute {
  route: string;
  sessionId?: string;
  permissionRequestId?: string;
  attribution?: LegacySessionTelemetryAttribution;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchLegacySessionTelemetryRoute(
  method: string,
  requestPath: string,
): ResolvedDaemonTelemetryRoute | undefined {
  const path =
    requestPath.length > 1 && requestPath.endsWith('/')
      ? requestPath.slice(0, -1)
      : requestPath;
  const requestSegments = path.split('/').slice(1);
  const prefix = requestSegments[0]?.toLowerCase();
  if (
    prefix !== 'session' &&
    prefix !== 'sessions' &&
    prefix !== 'permission'
  ) {
    return undefined;
  }

  for (const entry of legacySessionTelemetryRoutes) {
    if (entry.method !== method) continue;
    const templateSegments = entry.path.split('/').slice(1);
    if (templateSegments.length !== requestSegments.length) continue;
    const params = new Map<string, string>();
    let matched = true;
    for (let index = 0; index < templateSegments.length; index += 1) {
      const templateSegment = templateSegments[index]!;
      const requestSegment = requestSegments[index]!;
      if (templateSegment.startsWith(':')) {
        if (requestSegment === '') {
          matched = false;
          break;
        }
        params.set(templateSegment.slice(1), requestSegment);
      } else if (
        templateSegment.toLowerCase() !== requestSegment.toLowerCase()
      ) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    const rawSessionId = params.get('id');
    const rawRequestId = params.get('requestId');
    const requestId =
      rawRequestId !== undefined ? decodePathSegment(rawRequestId) : undefined;
    return {
      route: entry.route,
      attribution: entry.attribution,
      ...(rawSessionId ? { sessionId: decodePathSegment(rawSessionId) } : {}),
      ...(requestId !== undefined &&
      requestId.length <= MAX_CLIENT_ID_LENGTH &&
      CLIENT_ID_RE.test(requestId)
        ? { permissionRequestId: requestId }
        : {}),
    };
  }
  return undefined;
}

export function setDaemonTelemetryWorkspace(
  res: Response,
  workspaceCwd: string,
): void {
  try {
    const context = (res as TelemetryResponse)[daemonTelemetryResponseContext];
    if (context && context.workspaceCwd === undefined) {
      context.workspaceCwd = workspaceCwd;
    }
  } catch {
    // Telemetry must not affect request handling.
  }
}

// Route handlers are split across `routes/*.ts`; any added or renamed route
// that needs daemon telemetry must keep these patterns in sync.
export function resolveDaemonTelemetryRoute(
  req: Request,
): ResolvedDaemonTelemetryRoute | undefined {
  const legacyRoute = matchLegacySessionTelemetryRoute(req.method, req.path);
  if (legacyRoute) return legacyRoute;
  const path = req.path.replace(/\/$/, '') || '/';
  if (req.method === 'GET' && path === '/daemon/status') {
    return { route: 'GET /daemon/status' };
  }
  if (req.method === 'GET' && /^\/workspace\/[^/]+\/sessions$/.test(path)) {
    return { route: 'GET /workspace/:id/sessions' };
  }
  if (req.method === 'GET' && /^\/workspaces\/[^/]+\/sessions$/.test(path)) {
    return { route: 'GET /workspace/:id/sessions' };
  }
  if (
    req.method === 'GET' &&
    /^\/workspaces\/[^/]+\/sessions\/live-state$/.test(path)
  ) {
    return { route: 'GET /workspaces/:workspace/sessions/live-state' };
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
      sessionId: decodePathSegment(workspaceTranscript[1]),
    };
  }
  const workspaceExport = path.match(
    /^\/workspaces\/[^/]+\/session\/([^/]+)\/export$/,
  );
  if (workspaceExport?.[1] && req.method === 'GET') {
    return {
      route: 'GET /workspaces/:workspace/session/:id/export',
      sessionId: decodePathSegment(workspaceExport[1]),
    };
  }
  const workspaceArchivedExport = path.match(
    /^\/workspaces\/[^/]+\/session\/([^/]+)\/archive\/export$/,
  );
  if (workspaceArchivedExport?.[1] && req.method === 'GET') {
    return {
      route: 'GET /workspaces/:workspace/session/:id/archive/export',
      sessionId: decodePathSegment(workspaceArchivedExport[1]),
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
        suffix === '/workspace/file/upload' ||
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
  if (req.method === 'POST' && path === '/language') {
    return { route: 'POST /language' };
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

// The rejected-traceparent breadcrumb is rate-limited like the access
// log: an attacker (or a broken client) can send invalid traceparent headers
// on every request, and an unbounded DEBUG emit per request would let
// crafted traffic flood the daemon log.
const TRACEPARENT_BREADCRUMB_BURST = 60;
const TRACEPARENT_BREADCRUMB_REFILL_PER_SECOND = 2;

/**
 * Capture the caller trace id from a valid inbound `traceparent` header in
 * both telemetry modes. Mounted before auth, rate limiting, and body
 * parsing so the access log line of a request short-circuited at those
 * layers (401/429/400) — or one matching no route (404) — still joins the
 * caller's trace. The id is stored under its own symbol (see
 * telemetry-context.ts): creating the telemetry response context would
 * flip the handler-resolved workspace attribution gate.
 */
export function daemonInboundTraceIdCaptureMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    const inboundTraceId = extractInboundTraceId(req.headers);
    if (inboundTraceId !== undefined) {
      (res as InboundTraceIdResponse)[daemonInboundTraceIdContext] =
        inboundTraceId;
    }
  } catch {
    // Telemetry must not affect request handling.
  }
  next();
}

export function daemonTelemetryMiddleware(
  resolveWorkspaceCwd: (req: Request) => string | undefined,
  // Optional in-process sink for the Daemon Status dashboard's time-series
  // charts. Fed the same (durationMs, statusCode) already computed for OTel,
  // so it adds no extra measurement — just a second consumer. Only known
  // routes (those `resolveDaemonTelemetryRoute` matches) are counted, matching
  // the OTel counter's scope, so the "requests" line reflects daemon API
  // traffic rather than static-asset or unrouted noise.
  recordRequest?: (durationMs: number, statusCode: number) => void,
): (req: Request, res: Response, next: NextFunction) => void {
  const workspaceHashByCwd = new Map<string, string>();
  // The rejected-traceparent breadcrumb is rate-limited per middleware
  // instance like the access log: an attacker (or a broken client) can send
  // invalid traceparent headers on every request, and an unbounded DEBUG
  // emit per request would let crafted traffic flood the daemon log.
  let breadcrumbTokens = TRACEPARENT_BREADCRUMB_BURST;
  let breadcrumbRefillBaseline = performance.now();
  const acquireBreadcrumbToken = (): boolean => {
    const now = Math.max(performance.now(), breadcrumbRefillBaseline);
    breadcrumbTokens = Math.min(
      TRACEPARENT_BREADCRUMB_BURST,
      breadcrumbTokens +
        ((now - breadcrumbRefillBaseline) / 1_000) *
          TRACEPARENT_BREADCRUMB_REFILL_PER_SECOND,
    );
    breadcrumbRefillBaseline = now;
    if (breadcrumbTokens < 1) return false;
    breadcrumbTokens -= 1;
    return true;
  };
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
    const sessionId = route.sessionId;
    let workspaceHash: string | undefined;
    if (route.attribution !== 'handler_resolved') {
      try {
        const workspaceCwd = resolveWorkspaceCwd(req);
        if (workspaceCwd !== undefined) {
          workspaceHash = resolveWorkspaceHash(workspaceCwd);
        }
      } catch {
        // Telemetry must not affect request handling.
      }
    }
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
    // With telemetry on, extract the full W3C context (span parent + forced
    // sampling). The camelCase `traceId` access-log field is captured by
    // daemonInboundTraceIdCaptureMiddleware (mounted pre-auth) in both
    // modes, so one log query shape works for every deployment; with
    // telemetry on the span-derived snake_case prefix carries the same id
    // redundantly, while telemetry-off logs have it as their only carrier —
    // no telemetry config, no trace backend needed.
    let parentContext: ReturnType<typeof extractDaemonHttpTraceContext>;
    if (isTelemetrySdkInitialized()) {
      try {
        parentContext = extractDaemonHttpTraceContext(req.headers);
      } catch {
        // Telemetry must not affect request handling.
        parentContext = undefined;
      }
      try {
        const inboundTraceparent = req.headers?.['traceparent'];
        if (
          !parentContext &&
          typeof inboundTraceparent === 'string' &&
          inboundTraceparent.length > 0 &&
          acquireBreadcrumbToken()
        ) {
          // Leave a breadcrumb when a present-but-invalid header is rejected,
          // so a broken cross-service join is diagnosable from daemon logs
          // alone instead of requiring a request replay. Traceparent carries
          // only trace-id/span-id/flags — no user content — so recording the
          // rejected value is privacy-safe and shows *why* the join failed.
          // sanitizeLogText truncates and also neutralizes control characters
          // so a crafted header cannot forge log structure.
          emitDaemonLog(
            'Rejected invalid inbound traceparent header.',
            {
              'http.route': route.route,
              'http.request.header.traceparent': sanitizeLogText(
                inboundTraceparent,
                128,
              ),
            },
            {
              eventName: 'qwen-code.daemon.traceparent.invalid',
              severityNumber: 5, // SeverityNumber.DEBUG
            },
          );
        }
      } catch {
        // Telemetry must not affect request handling (covers the log emit
        // AND the header sanitization above it).
      }
    }
    const telemetryRes = res as TelemetryResponse;
    if (route.attribution === 'handler_resolved') {
      try {
        telemetryRes[daemonTelemetryResponseContext] ??= {};
      } catch {
        // Telemetry must not affect request handling.
      }
    }
    void withDaemonRequestSpan(
      {
        method: req.method,
        route: route.route,
        ...(workspaceHash !== undefined ? { workspaceHash } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(route.permissionRequestId
          ? { permissionRequestId: route.permissionRequestId }
          : {}),
        ...(clientId ? { clientId } : {}),
        ...(parentContext ? { parentContext } : {}),
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
            try {
              const context = telemetryRes[daemonTelemetryResponseContext];
              delete telemetryRes[daemonTelemetryResponseContext];
              if (context?.workspaceCwd !== undefined) {
                span?.setAttribute(
                  'qwen-code.workspace.hash',
                  resolveWorkspaceHash(context.workspaceCwd),
                );
              }
            } catch {
              // Telemetry must not affect response or metrics settlement.
            }
            recordDaemonHttpResponse(span, res.statusCode);
            const durationMs = Date.now() - startMs;
            const successfulSse =
              route.route === 'GET /session/:id/events' &&
              res.statusCode === 200 &&
              res.headersSent;
            if (!successfulSse) {
              recordDaemonHttpRequest(
                durationMs,
                route.route,
                res.statusCode,
                deferredRuntime?.path,
              );
            }
            // Exclude the dashboard's own status poll from the metrics-ring
            // request rate/latency, or the Requests chart shows a baseline of
            // ≥1/window with no external traffic (the dashboard counting itself)
            // — misleading an operator investigating load. OTel still counts it.
            if (
              !successfulSse &&
              route.route !== 'GET /daemon/status' &&
              route.route !== 'POST /session/:id/heartbeat'
            ) {
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
