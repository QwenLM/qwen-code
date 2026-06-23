/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  isContentHash,
  type ContentHash,
  type WorkspaceFileSystemFactory,
  type WriteMode,
} from '../fs/index.js';
import {
  applyReadHeaders,
  sendFsError,
  workspaceRelative,
} from './workspace-file-read.js';

interface RegisterDeps {
  bridge: AcpSessionBridge;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  parseClientId: (req: Request, res: Response) => string | undefined | null;
  safeBody: (req: Request) => Record<string, unknown>;
}

function getFsFactory(
  req: Request,
  res: Response,
): WorkspaceFileSystemFactory | null {
  const factory = (req.app.locals as { fsFactory?: WorkspaceFileSystemFactory })
    .fsFactory;
  if (!factory) {
    applyReadHeaders(res);
    res.status(500).json({
      errorKind: 'internal_error',
      error: 'workspace filesystem factory is not configured',
      status: 500,
    });
    return null;
  }
  return factory;
}

function sendParseError(res: Response, _route: string, error: string): null {
  applyReadHeaders(res);
  res.status(400).json({
    errorKind: 'parse_error',
    error,
    status: 400,
  });
  return null;
}

function requireBodyString(
  body: Record<string, unknown>,
  key: string,
  res: Response,
  route: string,
): string | null {
  const value = body[key];
  if (typeof value !== 'string' || value.length === 0) {
    return sendParseError(res, route, `\`${key}\` must be a non-empty string`);
  }
  return value;
}

function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
  res: Response,
  route: string,
): boolean | undefined | null {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    return sendParseError(res, route, `\`${key}\` must be a boolean`);
  }
  return value;
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
  res: Response,
  route: string,
): string | undefined | null {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    return sendParseError(res, route, `\`${key}\` must be a non-empty string`);
  }
  return value;
}

function optionalLineEnding(
  body: Record<string, unknown>,
  res: Response,
  route: string,
): 'crlf' | 'lf' | undefined | null {
  const value = body['lineEnding'];
  if (value === undefined) return undefined;
  if (value !== 'crlf' && value !== 'lf') {
    return sendParseError(res, route, '`lineEnding` must be "lf" or "crlf"');
  }
  return value;
}

function requiredHash(
  body: Record<string, unknown>,
  res: Response,
  route: string,
): ContentHash | null {
  const value = body['expectedHash'];
  if (!isContentHash(value)) {
    return sendParseError(
      res,
      route,
      '`expectedHash` must match sha256:<64 lowercase hex chars>',
    );
  }
  return value;
}

function optionalHash(
  body: Record<string, unknown>,
  res: Response,
  route: string,
): ContentHash | undefined | null {
  const value = body['expectedHash'];
  if (value === undefined) return undefined;
  if (!isContentHash(value)) {
    return sendParseError(
      res,
      route,
      '`expectedHash` must match sha256:<64 lowercase hex chars>',
    );
  }
  return value;
}

function resolveOriginatorClientId(
  clientId: string | undefined,
  deps: RegisterDeps,
  res: Response,
): string | undefined | null {
  if (clientId === undefined) return undefined;
  if (!deps.bridge.knownClientIds().has(clientId)) {
    applyReadHeaders(res);
    res.status(400).json({
      error: `Client id "${clientId}" is not registered for this workspace`,
      code: 'invalid_client_id',
      clientId,
    });
    return null;
  }
  return clientId;
}

async function handlePostFileWrite(
  req: Request,
  res: Response,
  deps: RegisterDeps,
): Promise<void> {
  const ROUTE = 'POST /file/write';
  const factory = getFsFactory(req, res);
  if (!factory) return;
  const body = deps.safeBody(req);
  const queryPath = requireBodyString(body, 'path', res, ROUTE);
  if (queryPath === null) return;
  const content = body['content'];
  if (typeof content !== 'string') {
    sendParseError(res, ROUTE, '`content` must be a string');
    return;
  }
  const rawMode = body['mode'];
  if (rawMode !== 'create' && rawMode !== 'replace') {
    sendParseError(res, ROUTE, '`mode` must be "create" or "replace"');
    return;
  }
  const mode: WriteMode = rawMode;
  const expectedHash =
    mode === 'replace'
      ? requiredHash(body, res, ROUTE)
      : optionalHash(body, res, ROUTE);
  if (expectedHash === null) return;
  const bom = optionalBoolean(body, 'bom', res, ROUTE);
  if (bom === null) return;
  const encoding = optionalString(body, 'encoding', res, ROUTE);
  if (encoding === null) return;
  const lineEnding = optionalLineEnding(body, res, ROUTE);
  if (lineEnding === null) return;
  const clientId = deps.parseClientId(req, res);
  if (clientId === null) return;
  const originatorClientId = resolveOriginatorClientId(clientId, deps, res);
  if (originatorClientId === null) return;
  const fs = factory.forRequest({
    originatorClientId,
    route: ROUTE,
  });
  try {
    const resolved = await fs.resolve(queryPath, 'write');
    const out = await fs.writeTextAtomic(resolved, content, {
      mode,
      ...(expectedHash ? { expectedHash } : {}),
      ...(bom !== undefined ? { bom } : {}),
      ...(encoding !== undefined ? { encoding } : {}),
      ...(lineEnding !== undefined ? { lineEnding } : {}),
    });
    applyReadHeaders(res);
    res.status(out.created ? 201 : 200).json({
      kind: 'file_write',
      path: workspaceRelative(req, resolved),
      mode,
      created: out.created,
      sizeBytes: out.sizeBytes,
      hash: out.hash,
      encoding: out.meta.encoding ?? 'utf-8',
      bom: out.meta.bom === true,
      lineEnding: out.meta.lineEnding,
      matchedIgnore: out.meta.matchedIgnore ?? null,
    });
  } catch (err) {
    sendFsError(res, err, ROUTE);
  }
}

async function handlePostFileEdit(
  req: Request,
  res: Response,
  deps: RegisterDeps,
): Promise<void> {
  const ROUTE = 'POST /file/edit';
  const factory = getFsFactory(req, res);
  if (!factory) return;
  const body = deps.safeBody(req);
  const queryPath = requireBodyString(body, 'path', res, ROUTE);
  if (queryPath === null) return;
  const oldText = body['oldText'];
  if (typeof oldText !== 'string') {
    sendParseError(res, ROUTE, '`oldText` must be a string');
    return;
  }
  const newText = body['newText'];
  if (typeof newText !== 'string') {
    sendParseError(res, ROUTE, '`newText` must be a string');
    return;
  }
  const expectedHash = requiredHash(body, res, ROUTE);
  if (expectedHash === null) return;
  const clientId = deps.parseClientId(req, res);
  if (clientId === null) return;
  const originatorClientId = resolveOriginatorClientId(clientId, deps, res);
  if (originatorClientId === null) return;
  const fs = factory.forRequest({
    originatorClientId,
    route: ROUTE,
  });
  try {
    const resolved = await fs.resolve(queryPath, 'edit');
    const out = await fs.editAtomic(resolved, oldText, newText, {
      expectedHash,
    });
    applyReadHeaders(res);
    res.status(200).json({
      kind: 'file_edit',
      path: workspaceRelative(req, resolved),
      replacements: 1,
      sizeBytes: out.writtenBytes,
      hash: out.hash,
      encoding: out.meta?.encoding ?? 'utf-8',
      bom: out.meta?.bom === true,
      lineEnding: out.meta?.lineEnding ?? 'lf',
      matchedIgnore: out.meta?.matchedIgnore ?? null,
    });
  } catch (err) {
    sendFsError(res, err, ROUTE);
  }
}

export function registerWorkspaceFileWriteRoutes(
  app: Application,
  deps: RegisterDeps,
): void {
  app.post('/file/write', deps.mutate({ strict: true }), (req, res) =>
    handlePostFileWrite(req, res, deps),
  );
  app.post('/file/edit', deps.mutate({ strict: true }), (req, res) =>
    handlePostFileEdit(req, res, deps),
  );
}
