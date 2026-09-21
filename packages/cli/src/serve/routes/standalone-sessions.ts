/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  APPROVAL_MODES,
  MAX_CRON_TASK_ROUTING_ID_LENGTH,
  SESSION_TRANSCRIPT_MAX_LIMIT,
  SESSION_TRANSCRIPT_MAX_EXPANDED_PAGE_BYTES,
  SessionTranscriptPageTooLargeError,
  type ApprovalMode,
  type SessionArchiveState,
} from '@qwen-code/qwen-code-core';
import type { Application, Request, RequestHandler, Response } from 'express';
import type {
  CreateStandaloneSessionRequest,
  CreatedStandaloneSession,
  RestoreStandaloneSessionOptions,
  RestoredStandaloneSession,
  StandaloneSessionService,
} from '../conversations/standalone-session-service.js';
import { omitSkillDetailsFromReplayArrays } from '../skill-details-redaction.js';
import { redactWorkflowsFromReplayArrays } from '../workflow-session-gate.js';
import type { SendBridgeError } from '../server/error-response.js';
import { InvalidCursorError } from '../server/session-list.js';
import {
  parseSessionExportFormat,
  sessionExportFormatValues,
} from '../server/session-export.js';
import { parseClientIdHeader, safeBody } from '../server/request-helpers.js';

const MAX_PAGE_SIZE = 100;

// Chosen cap for one serialized transcript response, kept proportional to
// the core expanded-page ceiling so the two cannot drift arbitrarily.
const WORKSPACE_TRANSCRIPT_RESPONSE_MAX_BYTES =
  2 * SESSION_TRANSCRIPT_MAX_EXPANDED_PAGE_BYTES;
const WORKSPACE_TRANSCRIPT_CURSOR_MAX_BYTES = 64 * 1024;

function parseTranscriptLimitQuery(
  rawLimit: unknown,
  res: Response,
): number | undefined | null {
  if (rawLimit === undefined) return undefined;
  if (typeof rawLimit !== 'string' || rawLimit.trim() === '') {
    res.status(400).json({
      error: '`limit` must be a positive integer',
      code: 'invalid_transcript_limit',
    });
    return null;
  }
  if (!/^\d+$/.test(rawLimit)) {
    res.status(400).json({
      error: '`limit` must be a positive integer',
      code: 'invalid_transcript_limit',
    });
    return null;
  }
  const limit = Number(rawLimit);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > SESSION_TRANSCRIPT_MAX_LIMIT
  ) {
    res.status(400).json({
      error: `\`limit\` must be between 1 and ${SESSION_TRANSCRIPT_MAX_LIMIT}`,
      code: 'invalid_transcript_limit',
      maxLimit: SESSION_TRANSCRIPT_MAX_LIMIT,
    });
    return null;
  }
  return limit;
}

function parseTranscriptCursorQuery(
  rawCursor: unknown,
  res: Response,
): string | undefined | null {
  if (rawCursor === undefined) return undefined;
  if (typeof rawCursor !== 'string' || rawCursor.trim() === '') {
    res.status(400).json({
      error: '`cursor` must be a non-empty string',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return rawCursor;
}

function parseTranscriptSnapshotQuery(
  rawSnapshot: unknown,
  res: Response,
): string | undefined | null {
  if (rawSnapshot === undefined) return undefined;
  if (typeof rawSnapshot !== 'string' || rawSnapshot.trim() === '') {
    res.status(400).json({
      error: '`snapshot` must be a non-empty string',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return rawSnapshot;
}

function parseTranscriptStartQuery(
  rawStart: unknown,
  res: Response,
): number | undefined | null {
  if (rawStart === undefined) return undefined;
  if (typeof rawStart !== 'string' || !/^\d+$/.test(rawStart)) {
    res.status(400).json({
      error: '`start` must be a non-negative integer',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) {
    res.status(400).json({
      error: '`start` must be a non-negative safe integer',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return start;
}

function parseTranscriptRecordBoundaryQuery(
  rawBoundary: unknown,
  res: Response,
): string | undefined | null {
  if (rawBoundary === undefined) return undefined;
  if (
    typeof rawBoundary !== 'string' ||
    rawBoundary.trim() === '' ||
    rawBoundary.length > 200
  ) {
    res.status(400).json({
      error: '`beforeRecordId` must be a non-empty record id',
      code: 'invalid_transcript_cursor',
    });
    return null;
  }
  return rawBoundary;
}

function parseTranscriptTurnAnchorQuery(
  rawAnchor: unknown,
  res: Response,
): string | undefined | null {
  if (rawAnchor === undefined) return undefined;
  if (
    typeof rawAnchor !== 'string' ||
    rawAnchor.trim() === '' ||
    rawAnchor.length > 200
  ) {
    res.status(400).json({
      error: '`atRecordId` must be a non-empty record id',
      code: 'invalid_turn_anchor',
    });
    return null;
  }
  return rawAnchor;
}

function workspaceTranscriptCursorExceedsLimit(
  cursor: string,
  maxBytes = WORKSPACE_TRANSCRIPT_CURSOR_MAX_BYTES,
): boolean {
  return Buffer.byteLength(cursor) > maxBytes;
}

function serializeWorkspaceTranscriptResponse(
  result: unknown,
  sessionId: string,
  maxBytes = WORKSPACE_TRANSCRIPT_RESPONSE_MAX_BYTES,
): string {
  const serialized = JSON.stringify(result);
  const responseBytes = Buffer.byteLength(serialized);
  if (responseBytes > maxBytes) {
    throw new SessionTranscriptPageTooLargeError(
      sessionId,
      responseBytes,
      maxBytes,
    );
  }
  return serialized;
}

export interface RegisterStandaloneSessionRoutesDeps {
  service: StandaloneSessionService;
  mutate: (options?: { strict?: boolean }) => RequestHandler;
  sendBridgeError: SendBridgeError;
  isWorkspaceTrusted: () => boolean;
}

function sendInvalidRequest(res: Response, message: string): void {
  res.status(400).json({
    error: message,
    code: 'invalid_request',
    errorKind: 'invalid_request',
    retryable: false,
  });
}

function objectBody(
  req: Request,
  res: Response,
): Record<string, unknown> | undefined {
  if (req.body === undefined) return {};
  if (
    typeof req.body !== 'object' ||
    req.body === null ||
    Array.isArray(req.body)
  ) {
    sendInvalidRequest(res, 'The request body must be a JSON object.');
    return undefined;
  }
  return safeBody(req);
}

function hasOnlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(body).every((key) => allowedKeys.has(key));
}

function requireExactBody(
  req: Request,
  res: Response,
  allowed: readonly string[],
): Record<string, unknown> | undefined {
  if (
    req.body !== undefined &&
    typeof req.body === 'object' &&
    req.body !== null &&
    !Array.isArray(req.body) &&
    !hasOnlyKeys(req.body as Record<string, unknown>, allowed)
  ) {
    sendInvalidRequest(res, 'The request body contains unknown fields.');
    return undefined;
  }
  const body = objectBody(req, res);
  if (!body) return undefined;
  if (!hasOnlyKeys(body, allowed)) {
    sendInvalidRequest(res, 'The request body contains unknown fields.');
    return undefined;
  }
  return body;
}

function parseApprovalMode(value: unknown): ApprovalMode | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' &&
    APPROVAL_MODES.includes(value as ApprovalMode)
    ? (value as ApprovalMode)
    : null;
}

function parseRestoreOptions(
  req: Request,
  res: Response,
): RestoreStandaloneSessionOptions | undefined {
  const body = requireExactBody(req, res, [
    'historyPageSize',
    'liveReplayMode',
    'compactedReplayMode',
    'hideInheritedHistory',
    'approvalMode',
  ]);
  if (!body) return undefined;
  const clientId = parseClientIdHeader(req, res);
  if (clientId === null) return undefined;
  const historyPageSize = body['historyPageSize'];
  if (
    historyPageSize !== undefined &&
    (!Number.isSafeInteger(historyPageSize) ||
      (historyPageSize as number) < 1 ||
      (historyPageSize as number) > SESSION_TRANSCRIPT_MAX_LIMIT)
  ) {
    sendInvalidRequest(
      res,
      `\`historyPageSize\` must be between 1 and ${SESSION_TRANSCRIPT_MAX_LIMIT}.`,
    );
    return undefined;
  }
  const liveReplayMode = body['liveReplayMode'];
  if (
    liveReplayMode !== undefined &&
    liveReplayMode !== 'full' &&
    liveReplayMode !== 'summary'
  ) {
    sendInvalidRequest(res, '`liveReplayMode` must be `full` or `summary`.');
    return undefined;
  }
  const compactedReplayMode = body['compactedReplayMode'];
  if (
    compactedReplayMode !== undefined &&
    compactedReplayMode !== 'full' &&
    compactedReplayMode !== 'summary'
  ) {
    sendInvalidRequest(
      res,
      '`compactedReplayMode` must be `full` or `summary`.',
    );
    return undefined;
  }
  const hideInheritedHistory = body['hideInheritedHistory'];
  if (
    hideInheritedHistory !== undefined &&
    typeof hideInheritedHistory !== 'boolean'
  ) {
    sendInvalidRequest(res, '`hideInheritedHistory` must be a boolean.');
    return undefined;
  }
  const approvalMode = parseApprovalMode(body['approvalMode']);
  if (approvalMode === null) {
    sendInvalidRequest(res, '`approvalMode` must be a known approval mode.');
    return undefined;
  }
  return {
    ...(clientId !== undefined ? { clientId } : {}),
    ...(historyPageSize !== undefined
      ? { historyPageSize: historyPageSize as number }
      : {}),
    ...(liveReplayMode !== undefined ? { liveReplayMode } : {}),
    ...(compactedReplayMode !== undefined ? { compactedReplayMode } : {}),
    ...(hideInheritedHistory !== undefined ? { hideInheritedHistory } : {}),
    ...(approvalMode !== undefined ? { approvalMode } : {}),
  };
}

function parseBatchSessionIds(
  req: Request,
  res: Response,
): string[] | undefined {
  const body = requireExactBody(req, res, ['sessionIds']);
  if (!body) return undefined;
  const sessionIds = body['sessionIds'];
  if (
    !Array.isArray(sessionIds) ||
    sessionIds.length < 1 ||
    sessionIds.length > 100 ||
    !sessionIds.every((sessionId) => typeof sessionId === 'string')
  ) {
    sendInvalidRequest(
      res,
      '`sessionIds` must contain between 1 and 100 session id strings.',
    );
    return undefined;
  }
  return sessionIds;
}

function parseListOptions(
  req: Request,
  res: Response,
):
  | {
      cursor?: string;
      size?: number;
      archiveState?: SessionArchiveState;
      signal: AbortSignal;
    }
  | undefined {
  if (
    !Object.keys(req.query).every((key) =>
      ['cursor', 'size', 'archiveState'].includes(key),
    )
  ) {
    sendInvalidRequest(res, 'The request query contains unknown fields.');
    return undefined;
  }
  const cursor = req.query['cursor'];
  if (
    cursor !== undefined &&
    (typeof cursor !== 'string' || cursor.length === 0)
  ) {
    sendInvalidRequest(res, '`cursor` must be a non-empty string.');
    return undefined;
  }
  const rawSize = req.query['size'];
  let size: number | undefined;
  if (rawSize !== undefined) {
    if (typeof rawSize !== 'string' || !/^\d+$/u.test(rawSize)) {
      sendInvalidRequest(res, '`size` must be an integer between 1 and 100.');
      return undefined;
    }
    size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
      sendInvalidRequest(res, '`size` must be an integer between 1 and 100.');
      return undefined;
    }
  }
  const archiveState = req.query['archiveState'];
  if (
    archiveState !== undefined &&
    archiveState !== 'active' &&
    archiveState !== 'archived'
  ) {
    sendInvalidRequest(res, '`archiveState` must be `active` or `archived`.');
    return undefined;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableFinished) abort();
  });
  return {
    ...(cursor !== undefined ? { cursor } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(archiveState !== undefined ? { archiveState } : {}),
    signal: controller.signal,
  };
}

export function registerStandaloneSessionRoutes(
  app: Application,
  deps: RegisterStandaloneSessionRoutesDeps,
): void {
  const handle = async (
    route: string,
    req: Request,
    res: Response,
    operation: () => Promise<void>,
  ): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      deps.sendBridgeError(res, error, {
        route,
        ...(req.params['id'] ? { sessionId: req.params['id'] } : {}),
      });
    }
  };

  app.get('/standalone/session-options', (req, res) =>
    handle('GET /standalone/session-options', req, res, async () => {
      if (Object.keys(req.query).length > 0) {
        sendInvalidRequest(res, 'The request query contains unknown fields.');
        return;
      }
      res.status(200).json(await deps.service.getOptions());
    }),
  );

  app.post('/standalone/sessions', deps.mutate({ strict: true }), (req, res) =>
    handle('POST /standalone/sessions', req, res, async () => {
      const body = requireExactBody(req, res, [
        'sessionId',
        'modelServiceId',
        'approvalMode',
      ]);
      if (!body) return;
      if (typeof body['sessionId'] !== 'string') {
        sendInvalidRequest(res, '`sessionId` must be an RFC UUID v1-v5.');
        return;
      }
      if (
        body['modelServiceId'] !== undefined &&
        (typeof body['modelServiceId'] !== 'string' ||
          body['modelServiceId'].length === 0 ||
          body['modelServiceId'].length > MAX_CRON_TASK_ROUTING_ID_LENGTH)
      ) {
        sendInvalidRequest(
          res,
          `\`modelServiceId\` must be a non-empty string of at most ${MAX_CRON_TASK_ROUTING_ID_LENGTH} characters.`,
        );
        return;
      }
      const approvalMode = parseApprovalMode(body['approvalMode']);
      if (approvalMode === null) {
        sendInvalidRequest(
          res,
          '`approvalMode` must be a known approval mode.',
        );
        return;
      }
      const request: CreateStandaloneSessionRequest = {
        sessionId: body['sessionId'],
        ...(body['modelServiceId'] !== undefined
          ? { modelServiceId: body['modelServiceId'] as string }
          : {}),
        ...(approvalMode !== undefined ? { approvalMode } : {}),
      };
      let disconnected = req.aborted;
      let responseSession: CreatedStandaloneSession | undefined;
      let cleanup: Promise<void> | undefined;
      const cleanupResponseSession = (): Promise<void> | undefined => {
        if (!responseSession) return undefined;
        const created = responseSession;
        cleanup ??= (async () => {
          try {
            await deps.service.cleanupDisconnectedCreate(created);
          } catch {
            await deps.service.cleanupDisconnectedCreate(created);
          }
        })().catch((error: unknown) => {
          cleanup = undefined;
          throw error;
        });
        return cleanup;
      };
      const markDisconnected = () => {
        disconnected = true;
        void cleanupResponseSession()?.catch(() => undefined);
      };
      req.once('aborted', markDisconnected);
      res.once('close', () => {
        if (!res.writableFinished) markDisconnected();
      });
      const created = await deps.service.create(request);
      if (created.session.clientId !== undefined) {
        responseSession = created;
      }
      if (disconnected || !res.writable || res.destroyed) {
        await cleanupResponseSession()?.catch(() => undefined);
        return;
      }
      res.status(200).json({
        ...created.session,
        sourceType: 'standalone',
        context: { kind: 'standalone' },
        projectlessOutputDirectory: created.projectlessOutputDirectory,
        workingDirectory: created.workingDirectory,
      });
    }),
  );

  app.get('/standalone/sessions', (req, res) =>
    handle('GET /standalone/sessions', req, res, async () => {
      const options = parseListOptions(req, res);
      if (!options) return;
      try {
        const result = await deps.service.list(options);
        options.signal.throwIfAborted();
        if (res.destroyed || !res.writable) return;
        res.status(200).json(result);
      } catch (error) {
        if (options.signal.aborted || res.destroyed) return;
        if (error instanceof InvalidCursorError) {
          res.status(400).json({
            error: error.message,
            code: 'invalid_cursor',
          });
          return;
        }
        throw error;
      }
    }),
  );

  app.get('/standalone/sessions/:id', (req, res) =>
    handle('GET /standalone/sessions/:id', req, res, async () => {
      const result = await deps.service.get(req.params['id'] ?? '');
      res.status('state' in result ? 202 : 200).json(result);
    }),
  );

  for (const action of ['load', 'resume'] as const) {
    app.post(
      `/standalone/sessions/:id/${action}`,
      deps.mutate({ strict: true }),
      (req, res) =>
        handle(
          `POST /standalone/sessions/:id/${action}`,
          req,
          res,
          async () => {
            const options = parseRestoreOptions(req, res);
            if (!options) return;
            let disconnected = req.aborted;
            const responseState: {
              restored?: RestoredStandaloneSession;
            } = {};
            let cleanup: Promise<void> | undefined;
            const cleanupRestore = (): Promise<void> | undefined => {
              const response = responseState.restored;
              if (!response) return undefined;
              cleanup ??= (async () => {
                try {
                  await deps.service.cleanupDisconnectedRestore(response);
                } catch {
                  await deps.service.cleanupDisconnectedRestore(response);
                }
              })().catch((error: unknown) => {
                cleanup = undefined;
                throw error;
              });
              return cleanup;
            };
            const markDisconnected = () => {
              disconnected = true;
              void cleanupRestore()?.catch(() => undefined);
            };
            req.once('aborted', markDisconnected);
            res.once('close', () => {
              if (!res.writableFinished) markDisconnected();
            });
            const restored = await deps.service[action](
              req.params['id'] ?? '',
              options,
            );
            responseState.restored = restored;
            if (disconnected || !res.writable || res.destroyed) {
              await cleanupRestore()?.catch(() => undefined);
              return;
            }
            const shaped = omitSkillDetailsFromReplayArrays(restored);
            res
              .status(200)
              .json(
                deps.isWorkspaceTrusted()
                  ? shaped
                  : redactWorkflowsFromReplayArrays(shaped),
              );
          },
        ),
    );
  }

  app.post(
    '/standalone/sessions/:id/repair-directory',
    deps.mutate({ strict: true }),
    (req, res) =>
      handle(
        'POST /standalone/sessions/:id/repair-directory',
        req,
        res,
        async () => {
          const body = requireExactBody(req, res, []);
          if (!body) return;
          res
            .status(200)
            .json(await deps.service.repairDirectory(req.params['id'] ?? ''));
        },
      ),
  );

  app.patch(
    '/standalone/sessions/:id/metadata',
    deps.mutate({ strict: true }),
    (req, res) =>
      handle('PATCH /standalone/sessions/:id/metadata', req, res, async () => {
        const body = requireExactBody(req, res, ['displayName']);
        if (!body) return;
        if (typeof body['displayName'] !== 'string') {
          sendInvalidRequest(res, '`displayName` must be a string.');
          return;
        }
        const clientId = parseClientIdHeader(req, res);
        if (clientId === null) return;
        res
          .status(200)
          .json(
            await deps.service.rename(
              req.params['id'] ?? '',
              body['displayName'],
              clientId,
            ),
          );
      }),
  );

  app.get('/standalone/sessions/:id/export', (req, res) =>
    handle('GET /standalone/sessions/:id/export', req, res, async () => {
      if (!Object.keys(req.query).every((key) => key === 'format')) {
        sendInvalidRequest(res, 'The request query contains unknown fields.');
        return;
      }
      const format = parseSessionExportFormat(req.query['format']);
      if (!format) {
        sendInvalidRequest(
          res,
          `\`format\` must be one of ${sessionExportFormatValues().join(', ')}.`,
        );
        return;
      }
      const exported = await deps.service.export(
        req.params['id'] ?? '',
        format,
      );
      res.set('Content-Type', exported.mimeType);
      res.set(
        'Content-Disposition',
        `attachment; filename="${exported.filename}"`,
      );
      res.status(200).send(exported.content);
    }),
  );

  app.get('/standalone/sessions/:id/turn-index', (req, res) =>
    handle('GET /standalone/sessions/:id/turn-index', req, res, async () => {
      const limit = parseTranscriptLimitQuery(req.query['limit'], res);
      if (limit === null) return;
      const snapshot = parseTranscriptSnapshotQuery(req.query['snapshot'], res);
      if (snapshot === null) return;
      const start = parseTranscriptStartQuery(req.query['start'], res);
      if (start === null) return;
      if (start !== undefined && snapshot === undefined) {
        res.status(400).json({
          error: '`start` requires `snapshot`',
          code: 'invalid_transcript_cursor',
        });
        return;
      }
      if (
        snapshot !== undefined &&
        workspaceTranscriptCursorExceedsLimit(snapshot)
      ) {
        res.status(400).json({
          error: '`snapshot` exceeds the maximum size',
          code: 'invalid_transcript_cursor',
        });
        return;
      }
      const page = await deps.service.getTurnIndexPage(req.params['id'] ?? '', {
        ...(snapshot !== undefined ? { snapshot } : {}),
        ...(start !== undefined ? { start } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      res
        .status(200)
        .set('Cache-Control', 'no-store')
        .type('application/json')
        .send(serializeWorkspaceTranscriptResponse(page, page.sessionId));
    }),
  );

  app.get('/standalone/sessions/:id/transcript', (req, res) =>
    handle('GET /standalone/sessions/:id/transcript', req, res, async () => {
      const limit = parseTranscriptLimitQuery(req.query['limit'], res);
      if (limit === null) return;
      const cursor = parseTranscriptCursorQuery(req.query['cursor'], res);
      if (cursor === null) return;
      const beforeRecordId = parseTranscriptRecordBoundaryQuery(
        req.query['beforeRecordId'],
        res,
      );
      if (beforeRecordId === null) return;
      const atRecordId = parseTranscriptTurnAnchorQuery(
        req.query['atRecordId'],
        res,
      );
      if (atRecordId === null) return;
      const snapshot = parseTranscriptSnapshotQuery(req.query['snapshot'], res);
      if (snapshot === null) return;
      if (
        (cursor !== undefined &&
          (beforeRecordId !== undefined ||
            atRecordId !== undefined ||
            snapshot !== undefined)) ||
        (atRecordId !== undefined &&
          (beforeRecordId !== undefined || snapshot === undefined)) ||
        (snapshot !== undefined &&
          atRecordId === undefined &&
          beforeRecordId === undefined)
      ) {
        res.status(400).json({
          error: 'Invalid transcript cursor and anchor combination',
          code: 'invalid_transcript_cursor',
        });
        return;
      }
      if (
        (cursor !== undefined &&
          workspaceTranscriptCursorExceedsLimit(cursor)) ||
        (snapshot !== undefined &&
          workspaceTranscriptCursorExceedsLimit(snapshot))
      ) {
        res.status(400).json({
          error: 'Transcript cursor or snapshot exceeds the maximum size',
          code: 'invalid_transcript_cursor',
        });
        return;
      }
      const page = await deps.service.getTranscriptPage(
        req.params['id'] ?? '',
        {
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          ...(beforeRecordId !== undefined ? { beforeRecordId } : {}),
          ...(atRecordId !== undefined ? { atRecordId } : {}),
          ...(snapshot !== undefined ? { snapshot } : {}),
        },
      );
      res
        .status(200)
        .set('Cache-Control', 'no-store')
        .type('application/json')
        .send(serializeWorkspaceTranscriptResponse(page, page.sessionId));
    }),
  );

  const registerBatch = (action: 'archive' | 'unarchive' | 'delete'): void => {
    app.post(
      `/standalone/sessions/${action}`,
      deps.mutate({ strict: true }),
      (req, res) =>
        handle(`POST /standalone/sessions/${action}`, req, res, async () => {
          const sessionIds = parseBatchSessionIds(req, res);
          if (!sessionIds) return;
          res.status(200).json(await deps.service[action](sessionIds));
        }),
    );
  };
  registerBatch('archive');
  registerBatch('unarchive');
  registerBatch('delete');
}
