/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Application, Request, RequestHandler, Response } from 'express';
import express from 'express';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import {
  MAX_UPLOAD_BYTES,
  hasSuspiciousPathPattern,
  isContentHash,
  isFsError,
  type ContentHash,
  type ResolvedPath,
  type WorkspaceFileSystem,
  type WorkspaceFileSystemFactory,
  type WriteMode,
} from '../fs/index.js';
import {
  applyReadHeaders,
  sendFsError,
  workspaceRelative,
} from './workspace-file-read.js';
import {
  getWorkspaceRouteContext,
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
  setWorkspaceRouteContext,
} from '../workspace-route-runtime.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

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
  const context = getWorkspaceRouteContext(req);
  if (context) return context.runtime.routeFileSystemFactory;
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

function routeName(req: Request, legacyRoute: string): string {
  const context = getWorkspaceRouteContext(req);
  if (!context) return legacyRoute;
  return `${context.routePrefix}${legacyRoute.slice('POST '.length)}`;
}

function getBridge(req: Request, deps: RegisterDeps): AcpSessionBridge {
  return getWorkspaceRouteContext(req)?.runtime.bridge ?? deps.bridge;
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
  req?: Request,
): string | undefined | null {
  if (clientId === undefined) return undefined;
  const bridge = req ? getBridge(req, deps) : deps.bridge;
  if (!bridge.knownClientIds().has(clientId)) {
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
  const ROUTE = routeName(req, 'POST /file/write');
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
  const originatorClientId = resolveOriginatorClientId(
    clientId,
    deps,
    res,
    req,
  );
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
  const ROUTE = routeName(req, 'POST /file/edit');
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
  const originatorClientId = resolveOriginatorClientId(
    clientId,
    deps,
    res,
    req,
  );
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

export function registerWorkspaceQualifiedFileWriteRoutes(
  app: Application,
  deps: RegisterDeps & { workspaceRegistry: WorkspaceRegistry },
): void {
  const resolve = (req: Request, res: Response): boolean => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime) return false;
    if (!requireTrustedWorkspaceRuntime(runtime, res)) return false;
    setWorkspaceRouteContext(req, {
      runtime,
      routePrefix: 'POST /workspaces/:workspace',
    });
    return true;
  };
  app.post(
    '/workspaces/:workspace/file/write',
    deps.mutate({ strict: true }),
    (req, res) => {
      if (!resolve(req, res)) return;
      void handlePostFileWrite(req, res, deps);
    },
  );
  app.post(
    '/workspaces/:workspace/file/edit',
    deps.mutate({ strict: true }),
    (req, res) => {
      if (!resolve(req, res)) return;
      void handlePostFileEdit(req, res, deps);
    },
  );
}

// ---------------------------------------------------------------------------
// File upload (`POST /file/upload`)
//
// Binary ingress into the workspace. Uploads NEVER overwrite: an occupied
// name (file, directory, or in-workspace final-component symlink) is
// auto-numbered (`name (1).ext`, `name (2).ext`, ...). The fs layer only
// exposes a no-clobber byte create; the numbered-candidate policy lives here.
// ---------------------------------------------------------------------------

const MAX_CONCURRENT_UPLOADS = 4;
const MAX_UPLOAD_FILENAME_BYTES = 255;
const NUMBERED_CANDIDATE_CAP = 1000;
/**
 * Cap on the number of path components an upload may create recursively
 * (the missing parent directory is materialized by `mkdir -p` before the
 * body is buffered, so a single request must not be able to spin up an
 * unbounded directory tree ahead of the concurrency gate).
 */
const MAX_UPLOAD_DIR_DEPTH = 64;

interface UploadGateLease {
  handlerStarted: boolean;
  release(): void;
}

const uploadGateLeases = new WeakMap<Request, UploadGateLease>();

export interface UploadConcurrencyGate {
  tryAcquire(): boolean;
  release(): void;
}

export function createUploadConcurrencyGate(
  max: number = MAX_CONCURRENT_UPLOADS,
): UploadConcurrencyGate {
  let active = 0;
  return {
    tryAcquire() {
      if (active >= max) return false;
      active += 1;
      return true;
    },
    release() {
      if (active > 0) active -= 1;
    },
  };
}

interface UploadAdmission {
  route: string;
  fs: WorkspaceFileSystem;
  basename: string;
  resolvedDir: ResolvedPath;
  /**
   * The literal request directory admission validated with
   * `fs.resolve(dir, 'write')`. Candidates are re-resolved from THIS string,
   * never from the canonicalized `resolvedDir`: resolution re-runs
   * `hasSuspiciousPathPattern` on its whole input, so canonical segments the
   * client never wrote — the workspace root's own path when it trips the
   * pattern check, or a symlinked parent whose TARGET name does
   * (`docs -> aux`) — would otherwise fail every upload into the directory.
   */
  queryDir: string;
}

const uploadAdmissions = new WeakMap<Request, UploadAdmission>();

function splitStemExtension(basename: string): { stem: string; ext: string } {
  // A leading dot (`.env`) is part of the stem, not an extension separator.
  const lastDot = basename.lastIndexOf('.');
  if (lastDot <= 0) return { stem: basename, ext: '' };
  return { stem: basename.slice(0, lastDot), ext: basename.slice(lastDot) };
}

/**
 * Trim only the stem — on a Unicode code-point boundary — until
 * `stem + suffix + ext` fits `capBytes`. Never trims the extension and never
 * splits a UTF-8 sequence. Returns null when suffix + ext alone cannot fit.
 */
function fitFilenameToByteCap(
  stem: string,
  suffix: string,
  ext: string,
  capBytes: number,
): string | null {
  if (Buffer.byteLength(suffix + ext, 'utf-8') > capBytes) return null;
  let chars = Array.from(stem);
  while (Buffer.byteLength(chars.join('') + suffix + ext, 'utf-8') > capBytes) {
    if (chars.length === 0) return null;
    chars = chars.slice(0, -1);
  }
  return chars.join('') + suffix + ext;
}

function sendUploadTooLarge(res: Response): void {
  applyReadHeaders(res);
  res.status(413).json({
    errorKind: 'file_too_large',
    error: `Request body too large (max ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB)`,
    status: 413,
    maxBytes: MAX_UPLOAD_BYTES,
  });
}

function fileUploadConcurrencyGate(
  gate: UploadConcurrencyGate,
): RequestHandler {
  return (req, res, next) => {
    if (!gate.tryAcquire()) {
      applyReadHeaders(res);
      res.status(429).set('Retry-After', '1').json({
        errorKind: 'upload_busy',
        error: 'Too many uploads in progress',
        status: 429,
        retryAfterSeconds: 1,
      });
      return;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      gate.release();
      res.off('finish', releaseBeforeHandler);
      res.off('close', releaseBeforeHandler);
      uploadGateLeases.delete(req);
    };
    const releaseBeforeHandler = () => {
      if (!lease.handlerStarted) release();
    };
    const lease: UploadGateLease = { handlerStarted: false, release };
    uploadGateLeases.set(req, lease);
    res.once('finish', releaseBeforeHandler);
    res.once('close', releaseBeforeHandler);
    next();
  };
}

// `express.raw` rejects only when the buffered body EXCEEDS `limit`, so a body
// of exactly MAX_UPLOAD_BYTES passes and MAX_UPLOAD_BYTES+1 is rejected with
// the upload-specific 413 envelope below. Using MAX (not MAX+1) keeps both the
// parser and `writeBytesAtomic` on the same cap, so no body can slip past the
// parser and then surface a generic, `maxBytes`-less 413 from the fs layer.
export function fileUploadBodyParser(): RequestHandler {
  const raw = express.raw({
    type: 'application/octet-stream',
    limit: MAX_UPLOAD_BYTES,
    // The endpoint contract is raw octets: decoding a Content-Encoding would
    // publish bytes the client never sent (and hash/size of the decoded form).
    inflate: false,
  });
  return (req, res, next) => {
    raw(req, res, (err?: unknown) => {
      if (err) {
        const status = (err as { status?: number }).status;
        if (status === 413) {
          sendUploadTooLarge(res);
          return;
        }
        if (status === 415) {
          applyReadHeaders(res);
          res.status(415).json({
            errorKind: 'unsupported_media_type',
            error: 'File uploads do not support encoded request bodies',
            status: 415,
          });
          return;
        }
        // A client aborting mid-body is routine for large uploads; the gate
        // slot is already released by the pre-handler response-close
        // listener, so the abort must not surface as an unhandled error.
        if ((err as { code?: string }).code === 'ECONNABORTED' || req.aborted) {
          return;
        }
        next(err);
        return;
      }
      next();
    });
  };
}

function fileUploadAdmission(
  deps: RegisterDeps & { workspaceRegistry?: WorkspaceRegistry },
  opts: {
    qualified: boolean;
    isWorkspaceTrusted?: () => boolean;
  },
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const ROUTE = opts.qualified
        ? 'POST /workspaces/:workspace/file/upload'
        : 'POST /file/upload';
      try {
        if (opts.qualified) {
          const registry = deps.workspaceRegistry;
          if (!registry) {
            throw new Error('workspace registry is not configured');
          }
          const runtime = resolveWorkspaceRuntimeFromParam(registry, req, res);
          if (!runtime) return;
          if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
          setWorkspaceRouteContext(req, {
            runtime,
            routePrefix: 'POST /workspaces/:workspace',
          });
        } else if (opts.isWorkspaceTrusted?.() === false) {
          applyReadHeaders(res);
          res.status(403).json({
            errorKind: 'untrusted_workspace',
            error: 'workspace is not trusted; write operations are forbidden',
            status: 403,
          });
          return;
        }

        const contentType = (req.headers['content-type'] ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        if (contentType !== 'application/octet-stream') {
          applyReadHeaders(res);
          res.status(415).json({
            errorKind: 'unsupported_media_type',
            error: 'File uploads require application/octet-stream',
            status: 415,
          });
          return;
        }

        const queryPath = req.query['path'];
        if (typeof queryPath !== 'string' || queryPath.length === 0) {
          sendParseError(res, ROUTE, '`path` query parameter is required');
          return;
        }
        const dir = path.dirname(queryPath);
        const basename = path.basename(queryPath);
        // `path.dirname`/`path.basename` silently normalize a trailing slash,
        // so a directory-shaped path must be rejected before they run.
        if (
          queryPath.endsWith('/') ||
          basename.length === 0 ||
          basename === '.' ||
          basename === '..'
        ) {
          sendParseError(res, ROUTE, '`path` must name a file');
          return;
        }
        // The missing parent directory is created recursively before the
        // body is buffered; bound how much tree a single request may
        // materialize ahead of the concurrency gate.
        if (dir.split('/').filter(Boolean).length > MAX_UPLOAD_DIR_DEPTH) {
          sendParseError(
            res,
            ROUTE,
            `directory path exceeds ${MAX_UPLOAD_DIR_DEPTH} components`,
          );
          return;
        }
        // Reject statically detectable bad names before taking a gate slot
        // and buffering the body; fs.resolve would throw on them anyway.
        if (queryPath.includes('\0')) {
          sendParseError(res, ROUTE, 'path must not contain null bytes');
          return;
        }
        if (hasSuspiciousPathPattern(basename)) {
          sendParseError(res, ROUTE, 'filename contains a suspicious pattern');
          return;
        }
        if (Buffer.byteLength(basename, 'utf-8') > MAX_UPLOAD_FILENAME_BYTES) {
          sendParseError(
            res,
            ROUTE,
            `filename exceeds ${MAX_UPLOAD_FILENAME_BYTES} bytes`,
          );
          return;
        }

        const contentLength = req.headers['content-length'];
        if (contentLength !== undefined) {
          const declared = Number(contentLength);
          if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
            sendUploadTooLarge(res);
            return;
          }
        }

        const clientId = deps.parseClientId(req, res);
        if (clientId === null) return;
        const originatorClientId = resolveOriginatorClientId(
          clientId,
          deps,
          res,
          req,
        );
        if (originatorClientId === null) return;

        const factory = getFsFactory(req, res);
        if (!factory) return;
        const fs = factory.forRequest({
          originatorClientId,
          route: ROUTE,
        });

        const resolvedDir = await fs.resolve(dir, 'write');
        let dirStat;
        try {
          dirStat = await fs.stat(resolvedDir);
        } catch (err) {
          if (isFsError(err) && err.kind === 'path_not_found') {
            // The target directory may not exist yet (e.g. a configured
            // drop folder); create it, including missing parents.
            await fs.mkdir(resolvedDir, { recursive: true });
            dirStat = await fs.stat(resolvedDir);
          } else {
            throw err;
          }
        }
        if (dirStat.kind !== 'directory') {
          sendParseError(res, ROUTE, 'parent path is not a directory');
          return;
        }

        uploadAdmissions.set(req, {
          route: ROUTE,
          fs,
          basename,
          resolvedDir,
          queryDir: dir,
        });
        next();
      } catch (err) {
        sendFsError(
          res,
          err,
          opts.qualified
            ? 'POST /workspaces/:workspace/file/upload'
            : 'POST /file/upload',
        );
      }
    })();
  };
}

async function handlePostFileUpload(
  req: Request,
  res: Response,
): Promise<void> {
  const admission = uploadAdmissions.get(req);
  if (!admission) {
    applyReadHeaders(res);
    res.status(500).json({
      errorKind: 'internal_error',
      error: 'upload admission context is missing',
      status: 500,
    });
    return;
  }
  const { route, fs, basename, resolvedDir, queryDir } = admission;
  const { stem, ext } = splitStemExtension(basename);
  const lease = uploadGateLeases.get(req);
  if (lease) lease.handlerStarted = true;
  try {
    // A client disconnect during the async admission window lets the body
    // parser continue with `req.body === undefined`; writing anyway would
    // publish a phantom 0-byte file nobody requested.
    if (req.aborted || res.closed) return;
    const body = req.body;
    const data =
      body === undefined || body === null ? Buffer.alloc(0) : (body as Buffer);
    for (let n = 0; n < NUMBERED_CANDIDATE_CAP; n++) {
      const candidateBasename =
        n === 0
          ? basename
          : fitFilenameToByteCap(
              stem,
              ` (${n})`,
              ext,
              MAX_UPLOAD_FILENAME_BYTES,
            );
      if (candidateBasename === null) {
        sendParseError(
          res,
          route,
          `filename cannot fit within ${MAX_UPLOAD_FILENAME_BYTES} bytes`,
        );
        return;
      }
      const candidateAbs = path.join(resolvedDir as string, candidateBasename);
      let resolved: ResolvedPath;
      try {
        resolved = await fs.resolve(
          path.join(queryDir, candidateBasename),
          'write',
        );
      } catch (err) {
        // A symlink CYCLE occupying the candidate (ELOOP) is merely an
        // occupied name — number on like the other occupied cases. Boundary
        // escapes and other resolution failures stop the loop.
        if (
          isFsError(err) &&
          err.kind === 'symlink_escape' &&
          (err.cause as NodeJS.ErrnoException | undefined)?.code === 'ELOOP'
        ) {
          continue;
        }
        sendFsError(res, err, route);
        return;
      }
      if ((resolved as string) !== candidateAbs) {
        // An in-workspace symlink already occupies this name; number on.
        continue;
      }
      try {
        const out = await fs.writeBytesAtomic(resolved, data);
        applyReadHeaders(res);
        res.status(201).json({
          kind: 'file_upload',
          path: workspaceRelative(req, resolved as string),
          sizeBytes: out.sizeBytes,
          hash: out.hash,
        });
        return;
      } catch (err) {
        if (isFsError(err) && err.kind === 'file_already_exists') {
          continue;
        }
        sendFsError(res, err, route);
        return;
      }
    }
    applyReadHeaders(res);
    res.status(409).json({
      errorKind: 'file_already_exists',
      error: `could not allocate a free filename for "${basename}"`,
      status: 409,
    });
  } catch (err) {
    sendFsError(res, err, route);
  } finally {
    uploadAdmissions.delete(req);
    lease?.release();
  }
}

export interface FileUploadLegacyDeps extends RegisterDeps {
  uploadGate: UploadConcurrencyGate;
  isWorkspaceTrusted?: () => boolean;
}

export interface FileUploadQualifiedDeps extends RegisterDeps {
  uploadGate: UploadConcurrencyGate;
  workspaceRegistry: WorkspaceRegistry;
}

export function registerWorkspaceFileUploadRoutes(
  app: Application,
  deps: FileUploadLegacyDeps,
): void {
  app.post(
    '/file/upload',
    deps.mutate({ strict: true }),
    fileUploadAdmission(deps, {
      qualified: false,
      isWorkspaceTrusted: deps.isWorkspaceTrusted,
    }),
    fileUploadConcurrencyGate(deps.uploadGate),
    fileUploadBodyParser(),
    (req, res) => {
      void handlePostFileUpload(req, res);
    },
  );
}

export function registerWorkspaceQualifiedFileUploadRoutes(
  app: Application,
  deps: FileUploadQualifiedDeps,
): void {
  app.post(
    '/workspaces/:workspace/file/upload',
    deps.mutate({ strict: true }),
    fileUploadAdmission(deps, { qualified: true }),
    fileUploadConcurrencyGate(deps.uploadGate),
    fileUploadBodyParser(),
    (req, res) => {
      void handlePostFileUpload(req, res);
    },
  );
}
