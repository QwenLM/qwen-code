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
  SessionService,
  addDaemonRequestAttribute,
  type ApprovalMode,
  type SessionArchiveState,
} from '@qwen-code/qwen-code-core';
import type { Application, Request, RequestHandler, Response } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  canonicalizeWorkspace,
  InvalidClientIdError,
  PromptQueueFullError,
  SessionNotFoundError,
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
  listWorkspaceSessionsForResponse,
  parseSessionPageSizeQuery,
} from '../server/session-list.js';
import {
  archiveDaemonSessions,
  assertSessionLoadable,
  logSessionArchiveWarning,
  type SessionArchiveCoordinator,
  unarchiveDaemonSessions,
} from '../server/session-archive.js';

interface RegisterSessionRoutesDeps {
  boundWorkspace: string;
  bridge: AcpSessionBridge;
  archiveCoordinator: SessionArchiveCoordinator;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  sendBridgeError: SendBridgeError;
  daemonLog?: DaemonLogger;
  promptDeadlineMs?: number;
  sessionShellCommandEnabled: boolean;
  languageCodes: string[];
}

export function registerSessionRoutes(
  app: Application,
  deps: RegisterSessionRoutesDeps,
): void {
  const {
    boundWorkspace,
    bridge,
    archiveCoordinator,
    mutate,
    sendBridgeError,
    daemonLog,
    promptDeadlineMs,
    sessionShellCommandEnabled,
  } = deps;
  const LANGUAGE_CODES = deps.languageCodes;

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
    const cwd = parseOptionalWorkspaceCwd(body, boundWorkspace, res);
    if (cwd === undefined) return;
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
      const session = await bridge.spawnOrAttach({
        workspaceCwd: cwd,
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
          bridge
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
          bridge.detachClient(session.sessionId, session.clientId).catch(() => {
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
      const cwd = parseOptionalWorkspaceCwd(body, boundWorkspace, res);
      if (cwd === undefined) return;
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      try {
        const session = await archiveCoordinator.runSharedMany(
          [sessionId],
          async () => {
            await assertSessionLoadable(cwd, sessionId);
            return action === 'load'
              ? await bridge.loadSession({
                  sessionId,
                  workspaceCwd: cwd,
                  ...(clientId !== undefined ? { clientId } : {}),
                })
              : await bridge.resumeSession({
                  sessionId,
                  workspaceCwd: cwd,
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
            bridge
              .killSession(session.sessionId, { requireZeroAttaches: true })
              .catch(() => {
                // Best-effort cleanup; channel.exited will eventually reap.
              });
          } else {
            bridge
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
          route: `POST /session/:id/${action}`,
          sessionId,
        });
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
    try {
      res.status(200).json(bridge.getSessionSummary(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/status',
        sessionId,
      });
    }
  });

  app.get('/session/:id/context', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      res.status(200).json(await bridge.getSessionContextStatus(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/context',
        sessionId,
      });
    }
  });

  app.get('/session/:id/context-usage', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      res.status(200).json(
        await bridge.getSessionContextUsageStatus(sessionId, {
          detail: req.query['detail'] === 'true',
        }),
      );
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/context-usage',
        sessionId,
      });
    }
  });

  app.get('/session/:id/stats', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      res.status(200).json(await bridge.getSessionStatsStatus(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/stats',
        sessionId,
      });
    }
  });

  app.get('/session/:id/supported-commands', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      res
        .status(200)
        .json(await bridge.getSessionSupportedCommandsStatus(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/supported-commands',
        sessionId,
      });
    }
  });

  app.get('/session/:id/tasks', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      res.status(200).json(await bridge.getSessionTasksStatus(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/tasks',
        sessionId,
      });
    }
  });

  app.get('/session/:id/lsp', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      res.status(200).json(await bridge.getSessionLspStatus(sessionId));
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'GET /session/:id/lsp',
        sessionId,
      });
    }
  });

  // GET /session/:id/hooks — read-only session-scoped hook status.
  app.get('/session/:id/hooks', async (req, res) => {
    const sessionId = requireSessionId(req, res);
    if (sessionId === null) return;
    try {
      res.status(200).json(await bridge.getSessionHooksStatus(sessionId));
    } catch (err) {
      sendBridgeError(res, err, { route: 'GET /session/:id/hooks', sessionId });
    }
  });

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
    withMutableSession(
      'POST /session/:id/prompt',
      async (req, res, sessionId) => {
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

        const lastEventId = bridge.getSessionLastEventId(sessionId);
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
          promptPromise = bridge.sendPrompt(
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
    withMutableSession('POST /session/:id/heartbeat', (req, res, sessionId) => {
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      const result = bridge.recordHeartbeat(
        sessionId,
        clientId !== undefined ? { clientId } : undefined,
      );
      res.status(200).json(result);
    }),
  );

  app.post(
    '/session/:id/detach',
    mutate(),
    withMutableSession(
      'POST /session/:id/detach',
      async (req, res, sessionId) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        await bridge.detachClient(sessionId, clientId);
        res.status(204).end();
      },
    ),
  );

  app.post(
    '/session/:id/cancel',
    mutate(),
    withMutableSession(
      'POST /session/:id/cancel',
      async (req, res, sessionId) => {
        const body = safeBody(req);
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        await bridge.cancelSession(
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
    try {
      await archiveCoordinator.runExclusiveMany([sessionId], async () =>
        bridge.closeSession(
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
      const closeErrors: Array<{ sessionId: string; error: string }> = [];
      const removed: string[] = [];
      const notFound: string[] = [];
      const removeErrors: Array<{ sessionId: string; error: string }> = [];
      await Promise.all(
        uniqueIds.map(async (id) => {
          try {
            // Keep each close+remove under one gate so a load/resume cannot
            // recreate that same live session between bridge close and
            // transcript deletion. Gate per id so one busy session does not
            // make the whole batch fail.
            await archiveCoordinator.runExclusiveMany([id], async () => {
              let shouldRemove = false;
              try {
                // Intentional: no clientId — batch delete bypasses per-tab ownership.
                await bridge.closeSession(id);
                shouldRemove = true;
              } catch (closeErr) {
                if (closeErr instanceof SessionNotFoundError) {
                  // Session not active in bridge — still attempt to remove its transcript file
                  shouldRemove = true;
                } else {
                  const msg =
                    closeErr instanceof Error
                      ? closeErr.message
                      : String(closeErr);
                  writeStderrLine(
                    `qwen serve: closeSession failed for ${safeLogValue(id)}: ${safeLogValue(msg)}`,
                  );
                  closeErrors.push({ sessionId: id, error: msg });
                }
              }
              if (!shouldRemove) return;
              try {
                if (await service.removeSession(id)) {
                  removed.push(id);
                } else {
                  notFound.push(id);
                }
              } catch (removeErr) {
                const msg =
                  removeErr instanceof Error
                    ? removeErr.message
                    : String(removeErr);
                writeStderrLine(
                  `qwen serve: removeSession failed for ${safeLogValue(id)}: ${safeLogValue(msg)}`,
                );
                removeErrors.push({ sessionId: id, error: msg });
              }
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            writeStderrLine(
              `qwen serve: deleteSession failed for ${safeLogValue(id)}: ${safeLogValue(message)}`,
            );
            closeErrors.push({ sessionId: id, error: message });
          }
        }),
      );
      res.status(200).json({
        removed,
        notFound,
        errors: [...closeErrors, ...removeErrors],
      });
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

  app.get('/workspace/:id/sessions', async (req, res) => {
    // Express decodes URL-encoded path params automatically; clients pass
    // the absolute workspace cwd encoded (e.g.
    // GET /workspace/%2Fwork%2Fa/sessions).
    const workspaceCwd = req.params['id'] ?? '';
    if (!path.isAbsolute(workspaceCwd)) {
      res
        .status(400)
        .json({ error: '`:id` must decode to an absolute workspace path' });
      return;
    }
    // Reject cross-workspace queries so orchestrators don't mistake
    // "no sessions here" for "workspace is idle".
    const key = canonicalizeWorkspace(workspaceCwd);
    if (key !== boundWorkspace) {
      res.status(400).json({
        error: `Workspace mismatch: daemon is bound to "${boundWorkspace}"`,
        code: 'workspace_mismatch',
        boundWorkspace,
        requestedWorkspace: key,
      });
      return;
    }
    try {
      const cursor =
        typeof req.query['cursor'] === 'string'
          ? req.query['cursor']
          : undefined;
      const size = parseSessionPageSizeQuery(req.query['size']);
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
      const result = await listWorkspaceSessionsForResponse(bridge, key, {
        cursor,
        size,
        archiveState,
      });
      res.status(200).json({
        sessions: result.sessions,
        ...(result.nextCursor != null ? { nextCursor: result.nextCursor } : {}),
      });
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        res.status(400).json({
          error: err.message,
          code: 'invalid_cursor',
        });
        return;
      }
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
  });

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
    const clientId = parseClientIdHeader(req, res);
    if (clientId === null) return;
    try {
      const pendingPrompts = bridge.getPendingPrompts(
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
    withMutableSession(
      'DELETE /session/:id/pending-prompts/:promptId',
      (req, res, sessionId) => {
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        const promptId = req.params['promptId'];
        if (!promptId) {
          res
            .status(400)
            .json({ error: '`promptId` route parameter is required' });
          return;
        }
        const result = bridge.removePendingPrompt(
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
    mutate({ strict: true }),
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
