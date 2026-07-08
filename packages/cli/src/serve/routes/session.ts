/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import {
  APPROVAL_MODES,
  BTW_MAX_INPUT_LENGTH,
  GROUP_COLOR_OPTIONS,
  SessionService,
  SessionOrganizationError,
  addDaemonRequestAttribute,
  type ApprovalMode,
  type SessionGroupColor,
  type SessionArchiveState,
} from '@qwen-code/qwen-code-core';
import type { SessionArtifactInput } from '@qwen-code/acp-bridge/sessionArtifacts';
import type { Application, Request, RequestHandler, Response } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  canonicalizeWorkspace,
  InvalidClientIdError,
  PromptQueueFullError,
  SessionArtifactValidationError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
  type AcpSessionBridge,
} from '../acp-session-bridge.js';
import type { DaemonLogger } from '../daemon-logger.js';
import type { SendBridgeError } from '../server/error-response.js';
import {
  PromptDeadlineExceededError,
  resolvePromptDeadlineMs,
} from '../server/prompt-deadline.js';
import {
  parseClientIdHeader,
  parseOptionalWorkspaceCwd,
  requireSessionId,
  safeBody,
  safeLogValue,
} from '../server/request-helpers.js';
import {
  InvalidCursorError,
  listLiveWorkspaceSessionsForResponse,
  listWorkspaceSessionsForResponse,
  parseSessionPageSizeQuery,
} from '../server/session-list.js';
import {
  archiveDaemonSessions,
  assertSessionLoadable,
  deleteDaemonSessions,
  logSessionArchiveWarning,
  type SessionArchiveCoordinator,
  unarchiveDaemonSessions,
} from '../server/session-archive.js';
import {
  exportSessionTranscript,
  parseSessionExportFormat,
  sessionExportFormatValues,
} from '../server/session-export.js';
import { createSessionOrganizationService } from '../session-organization-helpers.js';
import { requireSessionRuntime } from './session-runtime.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

interface RegisterSessionRoutesDeps {
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  workspaceRegistry: WorkspaceRegistry;
  archiveCoordinator: SessionArchiveCoordinator;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  sendBridgeError: SendBridgeError;
  daemonLog?: DaemonLogger;
  promptDeadlineMs?: number;
  sessionShellCommandEnabled: boolean;
  languageCodes: string[];
}

function sendArtifactValidationError(res: Response, err: unknown): boolean {
  if (!(err instanceof SessionArtifactValidationError)) {
    return false;
  }
  res.status(400).json({
    v: 1,
    error: {
      code: err.code,
      message: err.message,
      ...(err.field ? { field: err.field } : {}),
    },
  });
  return true;
}

function sendSessionOrganizationError(res: Response, err: unknown): boolean {
  if (!(err instanceof SessionOrganizationError)) {
    return false;
  }
  const status =
    err.code === 'group_name_conflict'
      ? 409
      : err.code === 'group_not_found'
        ? 404
        : err.code === 'session_organization_store_unreadable'
          ? 500
          : 400;
  res.status(status).json({
    error: err.message,
    code: err.code,
    ...(err.field !== undefined ? { field: err.field } : {}),
  });
  return true;
}

export function registerSessionRoutes(
  app: Application,
  deps: RegisterSessionRoutesDeps,
): void {
  const {
    boundWorkspace,
    bridge,
    workspaceRegistry,
    archiveCoordinator,
    mutate,
    sendBridgeError,
    daemonLog,
    promptDeadlineMs,
    sessionShellCommandEnabled,
  } = deps;
  const LANGUAGE_CODES = deps.languageCodes;

  const logSessionRoutingFailure = (
    route: string,
    resolutionKind: string,
    details: Record<string, unknown> = {},
  ): void => {
    daemonLog?.warn('session routing failed', {
      route,
      resolutionKind,
      ...details,
    });
  };

  const sendWorkspaceMismatch = (
    res: Response,
    requestedWorkspace: string,
  ): void => {
    const runtimes = workspaceRegistry.list();
    if (runtimes.length > 1) {
      res.status(400).json({
        error: `Workspace mismatch: daemon is bound to ${runtimes.length} workspaces; none matched the requested workspace.`,
        code: 'workspace_mismatch',
        boundWorkspace,
        workspaceCount: runtimes.length,
        requestedWorkspace,
      });
      return;
    }
    res.status(400).json({
      error: `Workspace mismatch: daemon is bound to "${boundWorkspace}"`,
      code: 'workspace_mismatch',
      boundWorkspace,
      requestedWorkspace,
    });
  };

  const resolveRuntimeForSessionCreation = (
    body: Record<string, unknown>,
    res: Response,
  ): { runtime: WorkspaceRuntime; workspaceCwd: string } | undefined => {
    const cwd = parseOptionalWorkspaceCwd(body, boundWorkspace, res);
    if (cwd === undefined) return undefined;
    let key: string;
    try {
      key = canonicalizeWorkspace(cwd);
    } catch (err) {
      if (workspaceRegistry.list().length > 1 && 'cwd' in body) {
        logSessionRoutingFailure('POST /session', 'workspace_mismatch', {
          requestedWorkspace: cwd,
        });
        sendWorkspaceMismatch(res, cwd);
        return undefined;
      }
      sendBridgeError(res, err, { route: 'POST /session' });
      return undefined;
    }
    if (workspaceRegistry.list().length === 1) {
      return {
        runtime: workspaceRegistry.primary,
        workspaceCwd:
          'cwd' in body ? key : workspaceRegistry.primary.workspaceCwd,
      };
    }
    const runtime = workspaceRegistry.resolveWorkspaceCwd(
      'cwd' in body ? key : undefined,
    );
    if (!runtime) {
      logSessionRoutingFailure('POST /session', 'workspace_mismatch', {
        requestedWorkspace: key,
      });
      sendWorkspaceMismatch(res, key);
      return undefined;
    }
    if (!runtime.primary && !runtime.trusted) {
      logSessionRoutingFailure('POST /session', 'untrusted_workspace', {
        workspaceId: runtime.workspaceId,
        workspaceCwd: runtime.workspaceCwd,
      });
      res.status(403).json({
        error: `Workspace "${runtime.workspaceCwd}" is not trusted.`,
        code: 'untrusted_workspace',
        workspaceCwd: runtime.workspaceCwd,
      });
      return undefined;
    }
    return { runtime, workspaceCwd: runtime.workspaceCwd };
  };

  const resolveRuntimeFromWorkspaceParam = (
    req: Request,
    res: Response,
    paramName = 'id',
  ): WorkspaceRuntime | null => {
    const workspaceParam = req.params[paramName] ?? '';
    const byId = workspaceRegistry.getByWorkspaceId(workspaceParam);
    if (byId) return byId;
    if (!path.isAbsolute(workspaceParam)) {
      res.status(400).json({
        error: `:${paramName} must decode to a workspace id or absolute path`,
      });
      return null;
    }
    let key: string;
    try {
      key = canonicalizeWorkspace(workspaceParam);
    } catch {
      sendWorkspaceMismatch(res, workspaceParam);
      return null;
    }
    const runtime = workspaceRegistry.getByWorkspaceCwd(key);
    if (!runtime) {
      sendWorkspaceMismatch(res, key);
      return null;
    }
    return runtime;
  };

  const sendAmbiguousSessionOwner = (
    res: Response,
    route: string,
    sessionId: string,
    runtimes: readonly WorkspaceRuntime[],
  ): void => {
    const workspaceIds = runtimes.map((runtime) => runtime.workspaceId);
    logSessionRoutingFailure(route, 'ambiguous', {
      sessionId,
      workspaceIds,
    });
    res.status(500).json({
      error: `Session owner is ambiguous for "${sessionId}"`,
      code: 'ambiguous_session_owner',
      sessionId,
      route,
      workspaceIds,
    });
  };
  const inFlightRestoreOwners = new Map<
    string,
    { workspaceCwd: string; count: number }
  >();

  const sendSessionWorkspaceConflict = (
    res: Response,
    route: string,
    sessionId: string,
    runtime: WorkspaceRuntime,
    liveRuntime: WorkspaceRuntime,
  ): void => {
    logSessionRoutingFailure(route, 'workspace_conflict', {
      sessionId,
      workspaceId: runtime.workspaceId,
      workspaceCwd: runtime.workspaceCwd,
      liveWorkspaceId: liveRuntime.workspaceId,
      liveWorkspaceCwd: liveRuntime.workspaceCwd,
    });
    res.status(409).json({
      error: `Session "${sessionId}" is already live or restoring in another workspace runtime.`,
      code: 'session_workspace_conflict',
      sessionId,
      workspaceCwd: runtime.workspaceCwd,
      workspaceId: runtime.workspaceId,
      liveWorkspaceCwd: liveRuntime.workspaceCwd,
      liveWorkspaceId: liveRuntime.workspaceId,
    });
  };

  const enterRestoreOwner = (
    res: Response,
    route: string,
    sessionId: string,
    runtime: WorkspaceRuntime,
  ): (() => void) | undefined => {
    const existing = inFlightRestoreOwners.get(sessionId);
    if (existing && existing.workspaceCwd !== runtime.workspaceCwd) {
      const existingRuntime =
        workspaceRegistry.getByWorkspaceCwd(existing.workspaceCwd) ??
        workspaceRegistry.primary;
      sendSessionWorkspaceConflict(
        res,
        route,
        sessionId,
        runtime,
        existingRuntime,
      );
      return undefined;
    }

    if (existing) {
      existing.count += 1;
    } else {
      inFlightRestoreOwners.set(sessionId, {
        workspaceCwd: runtime.workspaceCwd,
        count: 1,
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = inFlightRestoreOwners.get(sessionId);
      if (!current || current.workspaceCwd !== runtime.workspaceCwd) return;
      current.count -= 1;
      if (current.count <= 0) {
        inFlightRestoreOwners.delete(sessionId);
      }
    };
  };

  const resolveRuntimeForSessionRestore = (
    body: Record<string, unknown>,
    res: Response,
    route: string,
    sessionId: string,
  ): { runtime: WorkspaceRuntime; workspaceCwd: string } | undefined => {
    const cwd = parseOptionalWorkspaceCwd(body, boundWorkspace, res);
    if (cwd === undefined) return undefined;
    let key: string;
    try {
      key = canonicalizeWorkspace(cwd);
    } catch (err) {
      if (workspaceRegistry.list().length > 1 && 'cwd' in body) {
        logSessionRoutingFailure(route, 'workspace_mismatch', {
          requestedWorkspace: cwd,
        });
        sendWorkspaceMismatch(res, cwd);
        return undefined;
      }
      sendBridgeError(res, err, { route, sessionId });
      return undefined;
    }

    const runtime = workspaceRegistry.resolveWorkspaceCwd(
      'cwd' in body ? key : undefined,
    );
    if (!runtime) {
      logSessionRoutingFailure(route, 'workspace_mismatch', {
        requestedWorkspace: key,
      });
      sendWorkspaceMismatch(res, key);
      return undefined;
    }
    if (!runtime.primary && !runtime.trusted) {
      logSessionRoutingFailure(route, 'untrusted_workspace', {
        workspaceId: runtime.workspaceId,
        workspaceCwd: runtime.workspaceCwd,
      });
      res.status(403).json({
        error: `Workspace "${runtime.workspaceCwd}" is not trusted.`,
        code: 'untrusted_workspace',
        workspaceCwd: runtime.workspaceCwd,
        workspaceId: runtime.workspaceId,
      });
      return undefined;
    }

    const liveOwner = workspaceRegistry.resolveLiveSessionOwner(sessionId);
    if (liveOwner.kind === 'ambiguous') {
      sendAmbiguousSessionOwner(res, route, sessionId, liveOwner.runtimes);
      return undefined;
    }
    if (
      liveOwner.kind === 'found' &&
      liveOwner.runtime.workspaceCwd !== runtime.workspaceCwd
    ) {
      sendSessionWorkspaceConflict(
        res,
        route,
        sessionId,
        runtime,
        liveOwner.runtime,
      );
      return undefined;
    }

    return { runtime, workspaceCwd: runtime.workspaceCwd };
  };

  const resolveLiveSessionRuntime = (
    sessionId: string,
    res: Response,
    route: string,
  ): WorkspaceRuntime | undefined =>
    requireSessionRuntime({
      sessionId,
      route,
      res,
      workspaceRegistry,
      daemonLog,
    });

  const sendNonPrimarySessionRouteUnsupported = (
    res: Response,
    route: string,
    sessionId: string,
    runtime: WorkspaceRuntime,
  ): void => {
    res.status(400).json({
      error: `Route "${route}" is primary-only for non-primary workspace sessions in Phase 2a.`,
      code: 'non_primary_session_route_not_supported',
      sessionId,
      workspaceId: runtime.workspaceId,
      workspaceCwd: runtime.workspaceCwd,
      route,
    });
  };

  const withOwnerMutableSession =
    (
      route: string,
      handler: (
        req: Request,
        res: Response,
        sessionId: string,
        runtime: WorkspaceRuntime,
      ) => Promise<void> | void,
    ): RequestHandler =>
    async (req, res) => {
      const sessionId = requireSessionId(req, res);
      if (sessionId === null) return;
      try {
        const runtime = resolveLiveSessionRuntime(sessionId, res, route);
        if (!runtime) return;
        await archiveCoordinator.runSharedMany([sessionId], async () => {
          await handler(req, res, sessionId, runtime);
        });
      } catch (err) {
        sendBridgeError(res, err, { route, sessionId });
      }
    };

  const withOwnerReadSession =
    (
      route: string,
      handler: (
        req: Request,
        res: Response,
        sessionId: string,
        runtime: WorkspaceRuntime,
      ) => Promise<void> | void,
    ): RequestHandler =>
    async (req, res) => {
      const sessionId = requireSessionId(req, res);
      if (sessionId === null) return;
      try {
        const runtime = resolveLiveSessionRuntime(sessionId, res, route);
        if (!runtime) return;
        await handler(req, res, sessionId, runtime);
      } catch (err) {
        sendBridgeError(res, err, { route, sessionId });
      }
    };

  const parseSessionIdsBody = (
    req: Request,
    res: Response,
  ): string[] | undefined => {
    const body = safeBody(req);
    const sessionIds: unknown = body['sessionIds'];
    if (
      !Array.isArray(sessionIds) ||
      sessionIds.length === 0 ||
      sessionIds.length > 100 ||
      !sessionIds.every((id) => typeof id === 'string')
    ) {
      res.status(400).json({
        error: '`sessionIds` must be a non-empty string array (max 100)',
        code: 'invalid_request',
      });
      return undefined;
    }
    return [...new Set(sessionIds as string[])];
  };

  const serializeSessionErrors = (
    errors: Array<{ sessionId: string; error: unknown }>,
  ): Array<{ sessionId: string; error: string }> =>
    errors.map((e) => ({
      sessionId: e.sessionId,
      error: e.error instanceof Error ? e.error.message : String(e.error),
    }));

  const resolveWorkspaceParam = (
    req: Request,
    res: Response,
  ): string | null => {
    const workspaceCwd = req.params['id'] ?? '';
    if (!path.isAbsolute(workspaceCwd)) {
      res
        .status(400)
        .json({ error: '`:id` must decode to an absolute workspace path' });
      return null;
    }
    const key = canonicalizeWorkspace(workspaceCwd);
    if (key !== boundWorkspace) {
      res.status(400).json({
        error: `Workspace mismatch: daemon is bound to "${boundWorkspace}"`,
        code: 'workspace_mismatch',
        boundWorkspace,
        requestedWorkspace: key,
      });
      return null;
    }
    return key;
  };

  const withMutableSession =
    (
      route: string,
      handler: (
        req: Request,
        res: Response,
        sessionId: string,
      ) => Promise<void> | void,
    ): RequestHandler =>
    async (req, res) => {
      const sessionId = requireSessionId(req, res);
      if (sessionId === null) return;
      const runtime = resolveLiveSessionRuntime(sessionId, res, route);
      if (!runtime) return;
      if (!runtime.primary) {
        sendNonPrimarySessionRouteUnsupported(res, route, sessionId, runtime);
        return;
      }
      try {
        await archiveCoordinator.runSharedMany([sessionId], async () => {
          await handler(req, res, sessionId);
        });
      } catch (err) {
        sendBridgeError(res, err, { route, sessionId });
      }
    };

  app.post('/session', mutate(), async (req, res) => {
    const body = safeBody(req);
    const resolvedRuntime = resolveRuntimeForSessionCreation(body, res);
    if (resolvedRuntime === undefined) return;
    const { runtime, workspaceCwd } = resolvedRuntime;
    const modelServiceId =
      typeof body['modelServiceId'] === 'string'
        ? (body['modelServiceId'] as string)
        : undefined;
    // Per-request `sessionScope` override. Validate at the route
    // boundary so a 400 surfaces before touching the bridge.
    const rawSessionScope = body['sessionScope'];
    let sessionScope: 'single' | 'thread' | undefined;
    if (rawSessionScope !== undefined) {
      if (rawSessionScope !== 'single' && rawSessionScope !== 'thread') {
        res.status(400).json({
          error: '`sessionScope` must be "single" or "thread" when provided',
          code: 'invalid_session_scope',
        });
        return;
      }
      sessionScope = rawSessionScope;
    }
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const session = await runtime.bridge.spawnOrAttach({
        workspaceCwd,
        modelServiceId,
        ...(clientId !== undefined ? { clientId } : {}),
        ...(sessionScope !== undefined ? { sessionScope } : {}),
      });
      // Client may have disconnected during the 1–3s spawn window. If
      // so, the response can't be delivered. The session is otherwise
      // orphaned (in `byId` / `defaultEntry` with no client knowing the
      // id), and under churn this leaks one child per aborted request.
      //
      // Detect "can we still write the response?" via `res.writable`,
      // which stays true until the SOCKET destination side closes
      // (the right signal for our case). The legacy `req.aborted`
      // only flips while the request body is still being received,
      // so a client that completed the POST and then closed during
      // the spawn would slip past it. `req.destroyed` is too eager
      // — clients (incl. supertest) close their writable end after
      // sending the body even though they're still listening for the
      // response. `res.writable` is the documented signal for
      // "ServerResponse can still send to client".
      //
      // Combined with `!session.attached` we only reap when WE spawned
      // a fresh child for this request — if another client legitimately
      // attached, killing it would tear out their work mid-flight.
      // The disconnect-without-reap branch also needs to skip
      // `res.json` — writing to a closed socket would throw EPIPE
      // through Express's default error handler.
      if (daemonLog) {
        daemonLog.info(
          session.attached ? 'session attached' : 'session spawned',
          { sessionId: session.sessionId, clientId: session.clientId },
        );
      }
      if (!res.writable) {
        if (daemonLog) {
          daemonLog.warn(
            'session reaped (client disconnected before response)',
            {
              sessionId: session.sessionId,
              attached: session.attached,
            },
          );
        }
        if (!session.attached) {
          // `requireZeroAttaches: true` closes a race: if
          // a second client called `spawnOrAttach` for the same
          // workspace between our `await` resolving and this reap
          // dispatching, the bridge will see `attachCount > 0` and
          // skip the kill. Without the flag, that second client's
          // session would die mid-prompt.
          runtime.bridge
            .killSession(session.sessionId, { requireZeroAttaches: true })
            .catch(() => {
              // Best-effort cleanup; channel.exited will eventually reap.
            });
        } else {
          // When an attaching client disconnects
          // before its 200 response can be written, the
          // `attachCount` bump we did inside `spawnOrAttach` is
          // fictitious — there's no live attaching client. Roll the
          // counter back and let the bridge decide whether to reap
          // (it does if attachCount returns to 0 AND no live SSE
          // subscribers). Without this, both-coalesced-callers-
          // disconnect leaves an orphan agent child no client knows
          // the id of.
          runtime.bridge
            .detachClient(session.sessionId, session.clientId)
            .catch(() => {
              // Best-effort cleanup; channel.exited will eventually reap.
            });
        }
        return;
      }
      res.status(200).json(session);
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /session' });
    }
  });

  const restoreSessionHandler =
    (action: 'load' | 'resume') => async (req: Request, res: Response) => {
      const sessionId = requireSessionId(req, res);
      if (!sessionId) return;
      const body = safeBody(req);
      const route = `POST /session/:id/${action}`;
      let resolvedRuntime:
        | { runtime: WorkspaceRuntime; workspaceCwd: string }
        | undefined;
      try {
        resolvedRuntime = resolveRuntimeForSessionRestore(
          body,
          res,
          route,
          sessionId,
        );
      } catch (err) {
        sendBridgeError(res, err, { route, sessionId });
        return;
      }
      if (resolvedRuntime === undefined) return;
      const { runtime, workspaceCwd } = resolvedRuntime;
      const releaseRestoreOwner = enterRestoreOwner(
        res,
        route,
        sessionId,
        runtime,
      );
      if (!releaseRestoreOwner) return;
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) {
        releaseRestoreOwner();
        return;
      }
      try {
        const session = await archiveCoordinator.runSharedMany(
          [sessionId],
          async () => {
            await assertSessionLoadable(workspaceCwd, sessionId);
            return action === 'load'
              ? await runtime.bridge.loadSession({
                  sessionId,
                  workspaceCwd,
                  historyReplay: 'response',
                  ...(clientId !== undefined ? { clientId } : {}),
                })
              : await runtime.bridge.resumeSession({
                  sessionId,
                  workspaceCwd,
                  ...(clientId !== undefined ? { clientId } : {}),
                });
          },
        );
        if (daemonLog) {
          daemonLog.info(
            `session ${action}${session.attached ? ' (attached)' : ''}`,
            { sessionId: session.sessionId, clientId: session.clientId },
          );
        }
        // Mirror the `POST /session` disconnect-cleanup path (see the
        // long comment above the matching `if (!res.writable)` there
        // for the rationale around `res.writable` vs `req.aborted` /
        // `req.destroyed`, plus the `requireZeroAttaches` race
        // and the attach-rollback case). Restore needs the
        // same cleanup because a client that disconnects during a
        // multi-second `session/load` would otherwise leave a freshly
        // restored session in `byId` with no client holding its id.
        if (!res.writable) {
          if (!session.attached) {
            runtime.bridge
              .killSession(session.sessionId, { requireZeroAttaches: true })
              .catch(() => {
                // Best-effort cleanup; channel.exited will eventually reap.
              });
          } else {
            runtime.bridge
              .detachClient(session.sessionId, session.clientId)
              .catch(() => {
                // Best-effort cleanup; channel.exited will eventually reap.
              });
          }
          return;
        }
        res.status(200).json(session);
      } catch (err) {
        sendBridgeError(res, err, {
          route,
          sessionId,
        });
      } finally {
        releaseRestoreOwner();
      }
    };

  app.post('/session/:id/load', mutate(), restoreSessionHandler('load'));
  app.post('/session/:id/resume', mutate(), restoreSessionHandler('resume'));

  app.post(
    '/session/:id/branch',
    mutate(),
    withMutableSession(
      'POST /session/:id/branch',
      async (req, res, sessionId) => {
        const body = safeBody(req);
        let name =
          typeof body?.['name'] === 'string' ? body['name'] : undefined;
        if (name) {
          // eslint-disable-next-line no-control-regex
          name = name.replace(/[\x00-\x1F\x7F-\x9F]/g, '');
          if (name.length > 200) {
            name = name.slice(0, 200);
          }
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const result = await bridge.branchSession(
          sessionId,
          { name },
          { clientId },
        );
        if (!res.writable) {
          if (!result.attached) {
            bridge
              .killSession(result.sessionId, { requireZeroAttaches: true })
              .catch(() => {
                // Best-effort cleanup; channel.exited will eventually reap.
              });
          } else {
            bridge.detachClient(result.sessionId, result.clientId).catch(() => {
              // Best-effort cleanup; channel.exited will eventually reap.
            });
          }
          return;
        }
        res.status(201).json(result);
      },
    ),
  );

  app.post(
    '/session/:id/fork',
    mutate(),
    withMutableSession(
      'POST /session/:id/fork',
      async (req, res, sessionId) => {
        const body = safeBody(req);
        const directive = body['directive'];
        if (typeof directive !== 'string' || directive.trim().length === 0) {
          res.status(400).json({
            error: '`directive` is required and must be a non-empty string',
            code: 'missing_directive',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const result = await bridge.launchSessionForkAgent(
          sessionId,
          directive,
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(202).json(result);
      },
    ),
  );

  app.post(
    '/session/:id/cd',
    mutate(),
    withMutableSession('POST /session/:id/cd', async (req, res, sessionId) => {
      const body = safeBody(req);
      const targetPath = body['path'];
      if (
        typeof targetPath !== 'string' ||
        targetPath.length === 0 ||
        !path.isAbsolute(targetPath)
      ) {
        res.status(400).json({
          error: '`path` is required and must be an absolute path',
          code: 'invalid_path',
        });
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      const result = await bridge.changeSessionCwd(
        sessionId,
        { path: targetPath },
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json(result);
    }),
  );

  app.get('/session/:id/status', (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const runtime = resolveLiveSessionRuntime(
      sessionId,
      res,
      'GET /session/:id/status',
    );
    if (!runtime) return;
    try {
      res.status(200).json(runtime.bridge.getSessionSummary(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/status',
        sessionId,
      });
    }
  });

  app.get('/session/:id/export', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const rawFormat = req.query['format'];
    const format = parseSessionExportFormat(rawFormat);
    if (!format) {
      res.status(400).json({
        error: 'Invalid export format',
        code: 'invalid_export_format',
        format: typeof rawFormat === 'string' ? rawFormat : String(rawFormat),
        allowedFormats: sessionExportFormatValues(),
      });
      return;
    }
    try {
      const result = await archiveCoordinator.runSharedMany(
        [sessionId],
        async () => {
          await assertSessionLoadable(boundWorkspace, sessionId);
          return exportSessionTranscript({
            workspaceCwd: boundWorkspace,
            sessionId,
            format,
            config: { getChannel: () => 'daemon' },
          });
        },
      );
      const filename = result.filename.replace(/["\\\r\n]/g, '_');
      res
        .status(200)
        .set('Cache-Control', 'no-store')
        .set('X-Content-Type-Options', 'nosniff')
        .set('Content-Type', result.mimeType)
        .set('Content-Disposition', `attachment; filename="${filename}"`)
        .send(result.content);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/export',
        sessionId,
      });
    }
  });

  app.get(
    '/session/:id/context',
    withOwnerReadSession(
      'GET /session/:id/context',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(await runtime.bridge.getSessionContextStatus(sessionId));
      },
    ),
  );

  app.get(
    '/session/:id/context-usage',
    withOwnerReadSession(
      'GET /session/:id/context-usage',
      async (req, res, sessionId, runtime) => {
        res.status(200).json(
          await runtime.bridge.getSessionContextUsageStatus(sessionId, {
            detail: req.query['detail'] === 'true',
          }),
        );
      },
    ),
  );

  app.get(
    '/session/:id/stats',
    withOwnerReadSession(
      'GET /session/:id/stats',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(await runtime.bridge.getSessionStatsStatus(sessionId));
      },
    ),
  );

  app.get(
    '/session/:id/supported-commands',
    withOwnerReadSession(
      'GET /session/:id/supported-commands',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(
            await runtime.bridge.getSessionSupportedCommandsStatus(sessionId),
          );
      },
    ),
  );

  app.get(
    '/session/:id/tasks',
    withOwnerReadSession(
      'GET /session/:id/tasks',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(await runtime.bridge.getSessionTasksStatus(sessionId));
      },
    ),
  );

  app.get(
    '/session/:id/lsp',
    withOwnerReadSession(
      'GET /session/:id/lsp',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(await runtime.bridge.getSessionLspStatus(sessionId));
      },
    ),
  );

  // GET /session/:id/hooks — read-only session-scoped hook status.
  app.get(
    '/session/:id/hooks',
    withOwnerReadSession(
      'GET /session/:id/hooks',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(await runtime.bridge.getSessionHooksStatus(sessionId));
      },
    ),
  );

  app.get(
    '/session/:id/artifacts',
    withOwnerReadSession(
      'GET /session/:id/artifacts',
      async (_req, res, sessionId, runtime) => {
        res
          .status(200)
          .json(await runtime.bridge.getSessionArtifacts(sessionId));
      },
    ),
  );

  app.post(
    '/session/:id/artifacts',
    mutate({ strict: true }),
    withMutableSession(
      'POST /session/:id/artifacts',
      async (req, res, sessionId) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        try {
          const body = safeBody(req);
          const artifact: SessionArtifactInput = {
            title: body['title'] as SessionArtifactInput['title'],
            kind: body['kind'] as SessionArtifactInput['kind'],
            storage: body['storage'] as SessionArtifactInput['storage'],
            description: body[
              'description'
            ] as SessionArtifactInput['description'],
            workspacePath: body[
              'workspacePath'
            ] as SessionArtifactInput['workspacePath'],
            managedId: body['managedId'] as SessionArtifactInput['managedId'],
            url: body['url'] as SessionArtifactInput['url'],
            mimeType: body['mimeType'] as SessionArtifactInput['mimeType'],
            sizeBytes: body['sizeBytes'] as SessionArtifactInput['sizeBytes'],
            metadata: body['metadata'] as SessionArtifactInput['metadata'],
          };
          const result = await bridge.addSessionArtifact(
            sessionId,
            artifact,
            clientId !== undefined ? { clientId } : undefined,
          );
          res.status(200).json(result);
        } catch (err) {
          if (sendArtifactValidationError(res, err)) return;
          sendBridgeError(res, err, {
            route: 'POST /session/:id/artifacts',
            sessionId,
          });
        }
      },
    ),
  );

  app.delete(
    '/session/:id/artifacts/:artifactId',
    mutate({ strict: true }),
    withMutableSession(
      'DELETE /session/:id/artifacts/:artifactId',
      async (req, res, sessionId) => {
        const artifactId = req.params['artifactId'];
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        if (!artifactId) {
          res.status(400).json({
            v: 1,
            error: {
              code: 'VALIDATION_FAILED',
              message: '`artifactId` route parameter is required',
              field: 'artifactId',
            },
          });
          return;
        }
        try {
          const result = await bridge.removeSessionArtifact(
            sessionId,
            artifactId,
            clientId !== undefined ? { clientId } : undefined,
          );
          res.status(200).json(result);
        } catch (err) {
          sendBridgeError(res, err, {
            route: 'DELETE /session/:id/artifacts/:artifactId',
            sessionId,
          });
        }
      },
    ),
  );

  app.post(
    '/session/:id/tasks/:taskId/cancel',
    mutate({ strict: true }),
    withMutableSession(
      'POST /session/:id/tasks/:taskId/cancel',
      async (req, res, sessionId) => {
        const taskId = req.params['taskId'];
        if (!taskId) {
          res.status(400).json({
            error: '`taskId` route parameter is required',
          });
          return;
        }
        const body = safeBody(req);
        const kind = body['kind'];
        if (kind !== 'agent' && kind !== 'shell' && kind !== 'monitor') {
          res
            .status(400)
            .json({ error: '`kind` must be "agent", "shell", or "monitor"' });
          return;
        }
        res
          .status(200)
          .json(await bridge.cancelSessionTask(sessionId, taskId, kind));
      },
    ),
  );

  app.post(
    '/session/:id/goal/clear',
    mutate({ strict: true }),
    withMutableSession(
      'POST /session/:id/goal/clear',
      async (_req, res, sessionId) => {
        res.status(200).json(await bridge.clearSessionGoal(sessionId));
      },
    ),
  );

  app.post(
    '/session/:id/continue',
    mutate({ strict: true }),
    withMutableSession(
      'POST /session/:id/continue',
      async (req, res, sessionId) => {
        // Forward the originator and a generated promptId so the bridge can
        // attribute and correlate the continuation turn (it now runs through the
        // prompt-admission path, same as POST /session/:id/prompt). The accepted
        // response echoes promptId + lastEventId as the replay/correlation anchor.
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const promptId = crypto.randomUUID();
        res.status(200).json(
          await bridge.continueSession(sessionId, {
            ...(clientId !== undefined ? { clientId } : {}),
            promptId,
          }),
        );
      },
    ),
  );

  app.post(
    '/session/:id/prompt',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/prompt',
      async (req, res, sessionId, runtime) => {
        const ownerBridge = runtime.bridge;
        const body = safeBody(req);
        const prompt = body['prompt'];
        if (!Array.isArray(prompt) || prompt.length === 0) {
          res.status(400).json({
            error:
              '`prompt` is required and must be a non-empty array of content blocks',
          });
          return;
        }
        if (
          !prompt.every(
            (item: unknown) =>
              typeof item === 'object' && item !== null && !Array.isArray(item),
          )
        ) {
          res.status(400).json({
            error: 'each `prompt` element must be an object (content block)',
          });
          return;
        }
        const rawRequestDeadline = body['deadlineMs'];
        let requestDeadlineMs: number | undefined;
        if (rawRequestDeadline !== undefined && rawRequestDeadline !== null) {
          if (
            typeof rawRequestDeadline !== 'number' ||
            !Number.isFinite(rawRequestDeadline) ||
            !Number.isInteger(rawRequestDeadline) ||
            rawRequestDeadline <= 0
          ) {
            res.status(400).json({
              error: '`deadlineMs` must be a positive integer (milliseconds)',
              code: 'invalid_deadline_ms',
            });
            return;
          }
          requestDeadlineMs = rawRequestDeadline;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;

        const promptId = crypto.randomUUID();
        const forwardedBody = { ...body };
        delete forwardedBody['deadlineMs'];

        const lastEventId = ownerBridge.getSessionLastEventId(sessionId);
        addDaemonRequestAttribute('qwen-code.prompt_id', promptId);

        const abort = new AbortController();
        let responseFinished = false;
        const onResClose = () => {
          if (!responseFinished) abort.abort();
        };
        const onResFinish = () => {
          responseFinished = true;
          res.off('close', onResClose);
        };
        res.once('close', onResClose);
        res.once('finish', onResFinish);
        const effectiveDeadlineMs = resolvePromptDeadlineMs(
          promptDeadlineMs,
          requestDeadlineMs,
        );
        let deadlineTimer: NodeJS.Timeout | undefined;
        if (effectiveDeadlineMs !== undefined) {
          deadlineTimer = setTimeout(() => {
            if (!abort.signal.aborted) {
              abort.abort(new PromptDeadlineExceededError(effectiveDeadlineMs));
            }
          }, effectiveDeadlineMs);
          deadlineTimer.unref();
        }

        let promptPromise: ReturnType<AcpSessionBridge['sendPrompt']>;
        try {
          promptPromise = ownerBridge.sendPrompt(
            sessionId,
            {
              ...forwardedBody,
              sessionId,
              prompt,
            } as Parameters<AcpSessionBridge['sendPrompt']>[1],
            abort.signal,
            {
              ...(clientId !== undefined ? { clientId } : {}),
              promptId,
            },
          );
        } catch (err) {
          if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
          res.off('close', onResClose);
          res.off('finish', onResFinish);
          if (daemonLog && err instanceof PromptQueueFullError) {
            daemonLog.warn('prompt admission rejected: queue full', {
              sessionId,
              promptId,
              ...(clientId !== undefined ? { clientId } : {}),
              limit: err.limit,
              pendingCount: err.pendingCount,
            });
          }
          if (daemonLog && err instanceof InvalidClientIdError) {
            daemonLog.warn('prompt admission rejected: invalid client id', {
              sessionId,
              promptId,
              ...(clientId !== undefined ? { clientId } : {}),
            });
          }
          sendBridgeError(res, err, {
            route: 'POST /session/:id/prompt',
            sessionId,
          });
          return;
        }
        res.off('close', onResClose);

        promptPromise
          .then(
            () => {
              if (daemonLog) {
                daemonLog.info('prompt turn completed', {
                  sessionId,
                  promptId,
                  clientId,
                });
              }
            },
            (err) => {
              if (daemonLog) {
                const errName = err instanceof Error ? err.name : undefined;
                daemonLog.warn(
                  `prompt turn failed: ${errName ? `[${errName}] ` : ''}${err instanceof Error ? err.message : String(err)}`,
                  { sessionId, promptId, clientId },
                );
              }
            },
          )
          .finally(() => {
            if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
          })
          .catch(() => {});

        if (daemonLog) {
          daemonLog.info('prompt enqueued', { sessionId, promptId, clientId });
        }
        res.status(202).json({ promptId, lastEventId });
      },
    ),
  );

  app.post(
    '/session/:id/heartbeat',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/heartbeat',
      (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const result = runtime.bridge.recordHeartbeat(
          sessionId,
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(result);
      },
    ),
  );

  app.post(
    '/session/:id/detach',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/detach',
      async (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        await runtime.bridge.detachClient(sessionId, clientId);
        res.status(204).end();
      },
    ),
  );

  app.post(
    '/session/:id/cancel',
    mutate(),
    withOwnerMutableSession(
      'POST /session/:id/cancel',
      async (req, res, sessionId, runtime) => {
        const body = safeBody(req);
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        await runtime.bridge.cancelSession(
          sessionId,
          {
            ...(body as object),
            sessionId,
          } as Parameters<AcpSessionBridge['cancelSession']>[1],
          clientId !== undefined ? { clientId } : undefined,
        );
        if (daemonLog) {
          daemonLog.info('cancel sent', { sessionId, clientId });
        }
        res.status(204).end();
      },
    ),
  );

  app.delete('/session/:id', async (req, res) => {
    const sessionId = req.params['id'];
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    const runtime = resolveLiveSessionRuntime(
      sessionId,
      res,
      'DELETE /session/:id',
    );
    if (!runtime) return;
    try {
      // ACP session/close can fall back to a shared gate because it has
      // connection-local promptAbort state; REST close does not.
      await archiveCoordinator.runExclusiveMany([sessionId], async () =>
        runtime.bridge.closeSession(
          sessionId,
          clientId !== undefined ? { clientId } : undefined,
        ),
      );
      res.status(204).end();
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'DELETE /session/:id',
        sessionId,
      });
    }
  });

  app.post('/sessions/delete', mutate(), async (req, res) => {
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    const uniqueIds = parseSessionIdsBody(req, res);
    if (uniqueIds === undefined) return;
    try {
      const service = new SessionService(boundWorkspace);
      const result = await deleteDaemonSessions({
        sessionIds: uniqueIds,
        service,
        bridge,
        coordinator: archiveCoordinator,
        onError: ({ phase, sessionId, error }) => {
          writeStderrLine(
            `qwen serve: ${phase}Session failed for ${safeLogValue(sessionId)}: ${safeLogValue(error)}`,
          );
        },
      });
      res.status(200).json(result);
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /sessions/delete' });
    }
  });

  app.post('/sessions/archive', mutate(), async (req, res) => {
    const uniqueIds = parseSessionIdsBody(req, res);
    if (uniqueIds === undefined) return;

    const service = new SessionService(boundWorkspace, {
      onWarning: logSessionArchiveWarning,
    });

    try {
      const result = await archiveDaemonSessions({
        sessionIds: uniqueIds,
        service,
        bridge,
        coordinator: archiveCoordinator,
      });
      res.status(200).json({
        archived: result.archived,
        alreadyArchived: result.alreadyArchived,
        notFound: result.notFound,
        errors: serializeSessionErrors(result.errors),
      });
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /sessions/archive' });
    }
  });

  app.post('/sessions/unarchive', mutate(), async (req, res) => {
    const uniqueIds = parseSessionIdsBody(req, res);
    if (uniqueIds === undefined) return;

    const service = new SessionService(boundWorkspace, {
      onWarning: logSessionArchiveWarning,
    });

    try {
      const result = await unarchiveDaemonSessions({
        sessionIds: uniqueIds,
        service,
        coordinator: archiveCoordinator,
      });
      res.status(200).json({
        unarchived: result.unarchived,
        alreadyActive: result.alreadyActive,
        notFound: result.notFound,
        errors: serializeSessionErrors(result.errors),
      });
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /sessions/unarchive' });
    }
  });

  app.patch(
    '/session/:id/metadata',
    mutate({ strict: true }),
    withMutableSession('PATCH /session/:id/metadata', (req, res, sessionId) => {
      const body = safeBody(req);
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      const rawDisplayName = body['displayName'];
      if (rawDisplayName !== undefined && typeof rawDisplayName !== 'string') {
        res.status(400).json({
          error: '`displayName` must be a string',
          code: 'invalid_metadata',
          field: 'displayName',
        });
        return;
      }
      const displayName =
        typeof rawDisplayName === 'string'
          ? rawDisplayName.slice(0, 256)
          : undefined;
      const effective = bridge.updateSessionMetadata(
        sessionId,
        { displayName },
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json({ sessionId, ...effective });
    }),
  );

  app.patch('/session/:id/organization', mutate(), async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      await archiveCoordinator.runSharedMany([sessionId], async () => {
        // Organization is workspace-scoped sidecar state, not live-session
        // metadata. It intentionally applies to persisted and archived sessions.
        const sessionService = new SessionService(boundWorkspace);
        let exists = await sessionService.sessionExistsInAnyState(sessionId);
        if (!exists) {
          try {
            const summary = bridge.getSessionSummary(sessionId);
            exists = summary.workspaceCwd === boundWorkspace;
          } catch {
            exists = false;
          }
        }
        if (!exists) {
          res.status(404).json({
            error: `No session with id "${sessionId}"`,
            sessionId,
          });
          return;
        }

        const body = safeBody(req);
        const rawIsPinned = body['isPinned'];
        if (rawIsPinned !== undefined && typeof rawIsPinned !== 'boolean') {
          res.status(400).json({
            error: '`isPinned` must be a boolean',
            code: 'invalid_session_organization',
            field: 'isPinned',
          });
          return;
        }
        const rawGroupId = body['groupId'];
        if (
          rawGroupId !== undefined &&
          rawGroupId !== null &&
          typeof rawGroupId !== 'string'
        ) {
          res.status(400).json({
            error: '`groupId` must be a string or null',
            code: 'invalid_session_organization',
            field: 'groupId',
          });
          return;
        }
        const rawColor = body['color'];
        if (
          rawColor !== undefined &&
          rawColor !== null &&
          (typeof rawColor !== 'string' ||
            !GROUP_COLOR_OPTIONS.includes(rawColor as SessionGroupColor))
        ) {
          res.status(400).json({
            error: '`color` must be a supported color or null',
            code: 'invalid_session_organization',
            field: 'color',
          });
          return;
        }

        const organization = await createSessionOrganizationService(
          boundWorkspace,
        ).updateSessionOrganization(sessionId, {
          ...(rawIsPinned !== undefined ? { isPinned: rawIsPinned } : {}),
          ...(rawGroupId !== undefined
            ? { groupId: rawGroupId as string | null }
            : {}),
          ...(rawColor !== undefined
            ? { color: rawColor as SessionGroupColor | null }
            : {}),
        });
        res.status(200).json({ sessionId, ...organization });
      });
    } catch (err) {
      if (sendSessionOrganizationError(res, err)) return;
      sendBridgeError(res, err, {
        route: 'PATCH /session/:id/organization',
        sessionId,
      });
    }
  });

  app.get('/workspace/:id/session-groups', async (req, res) => {
    const key = resolveWorkspaceParam(req, res);
    if (key === null) return;
    try {
      res
        .status(200)
        .json(await createSessionOrganizationService(key).listGroups());
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /workspace/:id/session-groups',
      });
    }
  });

  app.post('/workspace/:id/session-groups', mutate(), async (req, res) => {
    const key = resolveWorkspaceParam(req, res);
    if (key === null) return;
    const body = safeBody(req);
    try {
      const group = await createSessionOrganizationService(key).createGroup({
        name: body['name'] as string,
        color: body['color'] as SessionGroupColor,
      });
      res.status(201).json({ group });
    } catch (err) {
      if (sendSessionOrganizationError(res, err)) return;
      sendBridgeError(res, err, {
        route: 'POST /workspace/:id/session-groups',
      });
    }
  });

  app.patch(
    '/workspace/:id/session-groups/:groupId',
    mutate(),
    async (req, res) => {
      const key = resolveWorkspaceParam(req, res);
      if (key === null) return;
      const body = safeBody(req);
      try {
        const group = await createSessionOrganizationService(key).updateGroup(
          req.params['groupId'] ?? '',
          {
            ...(Object.prototype.hasOwnProperty.call(body, 'name')
              ? { name: body['name'] as string }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(body, 'color')
              ? { color: body['color'] as SessionGroupColor }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(body, 'order')
              ? { order: body['order'] as number }
              : {}),
          },
        );
        res.status(200).json({ group });
      } catch (err) {
        if (sendSessionOrganizationError(res, err)) return;
        sendBridgeError(res, err, {
          route: 'PATCH /workspace/:id/session-groups/:groupId',
        });
      }
    },
  );

  app.delete(
    '/workspace/:id/session-groups/:groupId',
    mutate(),
    async (req, res) => {
      const key = resolveWorkspaceParam(req, res);
      if (key === null) return;
      try {
        const deleted = await createSessionOrganizationService(key).deleteGroup(
          req.params['groupId'] ?? '',
        );
        res.status(200).json({ deleted });
      } catch (err) {
        if (sendSessionOrganizationError(res, err)) return;
        sendBridgeError(res, err, {
          route: 'DELETE /workspace/:id/session-groups/:groupId',
        });
      }
    },
  );

  const listWorkspaceSessionsHandler =
    (paramName: string): RequestHandler =>
    async (req, res) => {
      const route =
        paramName === 'workspace'
          ? 'GET /workspaces/:workspace/sessions'
          : 'GET /workspace/:id/sessions';
      // Express decodes URL-encoded path params automatically; clients pass
      // the absolute workspace cwd encoded (e.g.
      // GET /workspace/%2Fwork%2Fa/sessions).
      const runtime = resolveRuntimeFromWorkspaceParam(req, res, paramName);
      if (runtime === null) return;
      if (!runtime.primary && !runtime.trusted) {
        logSessionRoutingFailure(route, 'untrusted_workspace', {
          workspaceId: runtime.workspaceId,
          workspaceCwd: runtime.workspaceCwd,
        });
        res.status(403).json({
          error: `Workspace "${runtime.workspaceCwd}" is not trusted.`,
          code: 'untrusted_workspace',
          workspaceCwd: runtime.workspaceCwd,
          workspaceId: runtime.workspaceId,
        });
        return;
      }
      const key = runtime.workspaceCwd;
      try {
        const cursor =
          typeof req.query['cursor'] === 'string'
            ? req.query['cursor']
            : undefined;
        const size = parseSessionPageSizeQuery(req.query['size']);
        const rawView = req.query['view'];
        let view: 'organized' | undefined;
        if (rawView !== undefined) {
          if (rawView !== 'organized') {
            res.status(400).json({
              error: '`view` must be "organized"',
              code: 'invalid_session_view',
            });
            return;
          }
          view = 'organized';
        }
        const group =
          typeof req.query['group'] === 'string'
            ? req.query['group']
            : undefined;
        if (group !== undefined && view !== 'organized') {
          res.status(400).json({
            error: '`group` requires `view=organized`',
            code: 'invalid_session_group_filter',
          });
          return;
        }
        const rawArchiveState = req.query['archiveState'];
        let archiveState: SessionArchiveState | undefined;
        if (rawArchiveState !== undefined) {
          if (
            typeof rawArchiveState !== 'string' ||
            (rawArchiveState !== 'active' && rawArchiveState !== 'archived')
          ) {
            res.status(400).json({
              error: '`archiveState` must be "active" or "archived"',
              code: 'invalid_archive_state',
            });
            return;
          }
          archiveState = rawArchiveState;
        }
        if (!runtime.primary && (archiveState === 'archived' || view)) {
          res.status(400).json({
            error:
              'Non-primary workspace session listing is live-only in Phase 2a.',
            code: 'non_primary_live_sessions_only',
          });
          return;
        }
        const options = {
          ...(cursor !== undefined ? { cursor } : {}),
          ...(size !== undefined ? { size } : {}),
          ...(archiveState !== undefined ? { archiveState } : {}),
          ...(view !== undefined ? { view } : {}),
          ...(group !== undefined ? { group } : {}),
        };
        const result = runtime.primary
          ? await listWorkspaceSessionsForResponse(runtime.bridge, key, options)
          : listLiveWorkspaceSessionsForResponse(runtime.bridge, key, options);
        res.status(200).json({
          sessions: result.sessions,
          ...(result.nextCursor != null
            ? { nextCursor: result.nextCursor }
            : {}),
          ...(result.liveMergeFailed ? { liveMergeFailed: true } : {}),
          ...(result.truncated ? { truncated: true } : {}),
        });
      } catch (err) {
        if (err instanceof InvalidCursorError) {
          res.status(400).json({
            error: err.message,
            code: 'invalid_cursor',
          });
          return;
        }
        if (sendSessionOrganizationError(res, err)) return;
        writeStderrLine(
          `qwen serve: failed to list sessions for workspace ${safeLogValue(
            key,
          )}: ${safeLogValue(err instanceof Error ? err.message : String(err))}`,
        );
        res.status(500).json({
          error: 'Failed to list sessions',
          code: 'session_list_failed',
        });
      }
    };

  app.get('/workspace/:id/sessions', listWorkspaceSessionsHandler('id'));
  app.get(
    '/workspaces/:workspace/sessions',
    listWorkspaceSessionsHandler('workspace'),
  );

  app.post(
    '/session/:id/model',
    mutate(),
    withMutableSession(
      'POST /session/:id/model',
      async (req, res, sessionId) => {
        const body = safeBody(req);
        const modelId = body['modelId'];
        if (typeof modelId !== 'string' || !modelId) {
          res.status(400).json({
            error: '`modelId` is required and must be a non-empty string',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const response = await bridge.setSessionModel(
          sessionId,
          {
            ...(body as object),
            sessionId,
            modelId,
          } as Parameters<AcpSessionBridge['setSessionModel']>[1],
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(response);
      },
    ),
  );

  app.post(
    '/session/:id/recap',
    mutate(),
    withMutableSession(
      'POST /session/:id/recap',
      async (req, res, sessionId) => {
        // Wraps `generateSessionRecap` so daemon clients can fetch a
        // one-sentence "where did I leave off" summary without a full
        // prompt turn. Best-effort — `recap: null` on short history or
        // transient model failure is a normal 200, not an error.
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const response = await bridge.generateSessionRecap(
          sessionId,
          clientId !== undefined ? { clientId } : undefined,
        );
        if (daemonLog) {
          const recap = response.recap;
          daemonLog.info(
            recap
              ? `recap generated len=${recap.length}`
              : 'recap returned null',
            { sessionId, clientId },
          );
        }
        res.status(200).json(response);
      },
    ),
  );

  app.post(
    '/session/:id/btw',
    mutate(),
    withMutableSession('POST /session/:id/btw', async (req, res, sessionId) => {
      const body = safeBody(req);
      const question = body['question'];
      if (
        typeof question !== 'string' ||
        question.trim().length === 0 ||
        question.length > BTW_MAX_INPUT_LENGTH
      ) {
        res.status(400).json({
          error: `\`question\` is required, must be a non-empty string, and at most ${BTW_MAX_INPUT_LENGTH} characters`,
        });
        return;
      }
      const abort = new AbortController();
      const onResClose = () => {
        if (!res.writableEnded) abort.abort();
      };
      res.once('close', onResClose);
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) {
        res.off('close', onResClose);
        return;
      }
      try {
        const result = await bridge.generateSessionBtw(
          sessionId,
          question.trim(),
          abort.signal,
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(result);
      } catch (err) {
        if (
          err instanceof DOMException &&
          err.name === 'AbortError' &&
          abort.signal.aborted
        ) {
          return;
        }
        sendBridgeError(res, err, {
          route: 'POST /session/:id/btw',
          sessionId,
        });
      } finally {
        res.off('close', onResClose);
      }
    }),
  );

  // Queue a user message typed while the session's turn is still running. The
  // ACP child drains it between tool batches (`craft/drainMidTurnQueue`) so the
  // model sees it before the turn ends, instead of waiting for the next turn.
  // Returns `{ accepted }`: `false` when the session is idle (or the per-session
  // queue is full), so the browser keeps the message in its own queue and sends
  // it as a normal next-turn prompt. Synchronous — the bridge only pushes onto
  // an in-memory queue.
  //
  // Per-message abuse guard. The sibling `/btw` caps its field; without this
  // only the global 10 MB body limit applies. Not a UX limit — a rejected
  // message stays in the browser's own queue and is sent as the (uncapped)
  // next-turn prompt — it only bounds how much a single mid-turn push can pin in
  // the in-memory queue (the queue DEPTH is bounded in `enqueueMidTurnMessage`).
  const MID_TURN_MESSAGE_MAX_LENGTH = 16 * 1024;
  app.post(
    '/session/:id/mid-turn-message',
    mutate(),
    withMutableSession(
      'POST /session/:id/mid-turn-message',
      (req, res, sessionId) => {
        const body = safeBody(req);
        const message = body['message'];
        // Validate (and length-check, and enqueue) the TRIMMED value — the bridge
        // stores the trimmed string, so checking the raw length would reject input
        // whose real content fits but is padded with whitespace.
        const trimmed = typeof message === 'string' ? message.trim() : '';
        if (trimmed.length === 0) {
          res.status(400).json({
            error: '`message` is required and must be a non-empty string',
          });
          return;
        }
        if (trimmed.length > MID_TURN_MESSAGE_MAX_LENGTH) {
          res.status(400).json({
            error: `\`message\` must be at most ${MID_TURN_MESSAGE_MAX_LENGTH} characters`,
          });
          return;
        }
        // Forward the client id so the bridge authorizes it against the session
        // (like `/prompt` and `/btw`) — a token-holding client bound to another
        // session must not push into this one — and records it as the message's
        // originator for SSE echo routing. `null` = malformed id (already answered).
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const result = bridge.enqueueMidTurnMessage(
          sessionId,
          trimmed,
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(result);
      },
    ),
  );

  // Pending prompt queue: list and remove.
  app.get('/session/:id/pending-prompts', (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    const runtime = resolveLiveSessionRuntime(
      sessionId,
      res,
      'GET /session/:id/pending-prompts',
    );
    if (!runtime) return;
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const pendingPrompts = runtime.bridge.getPendingPrompts(
        sessionId,
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json({ pendingPrompts });
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/pending-prompts',
        sessionId,
      });
    }
  });

  app.delete(
    '/session/:id/pending-prompts/:promptId',
    mutate(),
    withOwnerMutableSession(
      'DELETE /session/:id/pending-prompts/:promptId',
      (req, res, sessionId, runtime) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const promptId = req.params['promptId'];
        if (!promptId) {
          res
            .status(400)
            .json({ error: '`promptId` route parameter is required' });
          return;
        }
        const result = runtime.bridge.removePendingPrompt(
          sessionId,
          promptId,
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(result);
      },
    ),
  );

  app.post(
    '/session/:id/shell',
    mutate({ strict: true }),
    withMutableSession(
      'POST /session/:id/shell',
      async (req, res, sessionId) => {
        if (!sessionShellCommandEnabled) {
          sendBridgeError(res, new SessionShellDisabledError(), {
            route: 'POST /session/:id/shell',
            sessionId,
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) {
          return;
        }
        if (clientId === undefined) {
          sendBridgeError(res, new SessionShellClientRequiredError(), {
            route: 'POST /session/:id/shell',
            sessionId,
          });
          return;
        }
        const body = safeBody(req);
        const command = body['command'];
        if (typeof command !== 'string' || command.trim().length === 0) {
          res.status(400).json({
            error: '`command` is required and must be a non-empty string',
          });
          return;
        }
        const abort = new AbortController();
        const onResClose = () => {
          if (!res.writableEnded) abort.abort();
        };
        res.once('close', onResClose);
        try {
          const result = await bridge.executeShellCommand(
            sessionId,
            command.trim(),
            abort.signal,
            { clientId },
          );
          if (daemonLog) {
            daemonLog.info('shell command completed', {
              sessionId,
              clientId,
              exitCode: result.exitCode,
            });
          }
          res.status(200).json(result);
        } catch (err) {
          if (
            err instanceof DOMException &&
            err.name === 'AbortError' &&
            abort.signal.aborted
          ) {
            return;
          }
          sendBridgeError(res, err, {
            route: 'POST /session/:id/shell',
            sessionId,
          });
        } finally {
          res.off('close', onResClose);
        }
      },
    ),
  );

  app.get('/session/:id/rewind/snapshots', async (req, res) => {
    const sessionId = req.params['id'];
    if (!sessionId) {
      res
        .status(400)
        .json({ error: '`sessionId` route parameter is required' });
      return;
    }
    try {
      res.status(200).json(await bridge.getRewindSnapshots(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/rewind/snapshots',
        sessionId,
      });
    }
  });

  app.post(
    '/session/:id/rewind',
    mutate({ strict: true }),
    withMutableSession(
      'POST /session/:id/rewind',
      async (req, res, sessionId) => {
        const body = safeBody(req);
        const promptId = body['promptId'];
        if (typeof promptId !== 'string' || promptId.length === 0) {
          res.status(400).json({
            error: '`promptId` is required and must be a non-empty string',
            code: 'missing_prompt_id',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const response = await bridge.rewindSession(
          sessionId,
          { promptId, rewindFiles: body['rewindFiles'] !== false },
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(response);
      },
    ),
  );

  app.post(
    '/session/:id/approval-mode',
    mutate(),
    withMutableSession(
      'POST /session/:id/approval-mode',
      async (req, res, sessionId) => {
        // Validates `mode` against `APPROVAL_MODES` and an optional
        // `persist: boolean` flag.
        const body = safeBody(req);
        const mode = body['mode'];
        const persist = body['persist'];
        if (
          typeof mode !== 'string' ||
          !APPROVAL_MODES.includes(mode as ApprovalMode)
        ) {
          res.status(400).json({
            error: '`mode` is required and must be one of the allowed values',
            code: 'invalid_approval_mode',
            allowed: APPROVAL_MODES,
          });
          return;
        }
        if (persist !== undefined && typeof persist !== 'boolean') {
          res.status(400).json({
            error: '`persist` must be a boolean when provided',
            code: 'invalid_persist_flag',
          });
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const response = await bridge.setSessionApprovalMode(
          sessionId,
          mode as ApprovalMode,
          { persist: persist === true },
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(response);
      },
    ),
  );

  app.post(
    '/session/:id/language',
    mutate(),
    withMutableSession(
      'POST /session/:id/language',
      async (req, res, sessionId) => {
        const body = safeBody(req);
        const language = body['language'];
        const syncOutputLanguage = body['syncOutputLanguage'];

        if (
          typeof language !== 'string' ||
          !LANGUAGE_CODES.includes(language)
        ) {
          res.status(400).json({
            error:
              '`language` is required and must be one of: ' +
              LANGUAGE_CODES.join(', '),
            code: 'invalid_language',
            allowed: LANGUAGE_CODES,
          });
          return;
        }

        if (
          syncOutputLanguage !== undefined &&
          typeof syncOutputLanguage !== 'boolean'
        ) {
          res.status(400).json({
            error: '`syncOutputLanguage` must be a boolean when provided',
            code: 'invalid_sync_flag',
          });
          return;
        }

        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;

        const response = await bridge.setSessionLanguage(
          sessionId,
          {
            language,
            syncOutputLanguage: syncOutputLanguage === true,
          },
          clientId !== undefined ? { clientId } : undefined,
        );
        res.status(200).json(response);
      },
    ),
  );
}
