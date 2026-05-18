/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Application, Request, Response } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  isFsError,
  type FsError,
  type WorkspaceFileSystemFactory,
} from '../fs/index.js';

/**
 * Hard cap on entries returned from `GET /list`. The directory walk
 * runs in a single tick (`fsp.readdir`), so an unbounded listing of
 * a `node_modules`-style directory pins the event loop and the
 * resulting JSON payload (which the JSON.stringify pass already
 * holds in memory) is too large to be useful. 2000 is generous for
 * legitimate listings while staying well under the 10MB request
 * limit when each entry serializes to ~80 bytes.
 *
 * Ties into the response's `truncated: true` flag so SDK consumers
 * can ask the daemon to paginate (PR 19 emits the flag; pagination
 * itself is a future PR — this PR's job is to advertise the
 * truncation so the SDK doesn't quietly assume the full set).
 */
export const MAX_LIST_ENTRIES = 2000;

/**
 * Default cap when the caller omits `?maxResults` on `GET /glob`.
 * Mirrors the orchestrator's default behavior (no cap) clipped to a
 * concrete number so route consumers see consistent ceilings without
 * needing to know the orchestrator's defaults.
 */
export const DEFAULT_GLOB_MAX_RESULTS = 5000;

/**
 * Hard upper bound for caller-supplied `?maxResults` on `GET /glob`.
 * Anything above this rejects with `parse_error` rather than
 * silently capping; a caller asking for 1M results almost
 * certainly meant to stream.
 */
export const MAX_GLOB_MAX_RESULTS = 50_000;

/**
 * Privacy + correctness headers shared by every read route. The
 * `no-store` directive blocks intermediaries (browser caches,
 * forwarding proxies in development) from snapshotting workspace
 * file contents — even on a localhost daemon, a misconfigured CDN
 * or a developer browser extension that mirrors XHR responses to
 * disk would otherwise persist source contents past the request
 * lifetime. `nosniff` blocks MIME-sniffing fallbacks that would let
 * a UTF-8 source file render as HTML in a browser that loaded it
 * directly. Both are harmless on the SDK / curl path and
 * mandatory for any browser-adjacent client.
 */
function applyReadHeaders(res: Response): void {
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
}

/**
 * Common error envelope. Mirrors `sendBridgeError` in
 * `serve/server.ts` so SDK consumers see one shape across daemon
 * routes. `FsError` carries its own `status` from
 * `DEFAULT_STATUS_BY_KIND` (`fs/errors.ts`), so the route doesn't
 * re-derive it — that keeps the kind→status mapping authoritative
 * in a single place. Non-`FsError` paths log to stderr and 500;
 * the route's own try-catch should already have wrapped expected
 * boundary errors via `wrapAsFsError`.
 */
export function sendFsError(res: Response, err: unknown, route: string): void {
  applyReadHeaders(res);
  if (isFsError(err)) {
    const fs: FsError = err;
    res.status(fs.status).json({
      errorKind: fs.kind,
      error: fs.message,
      hint: fs.hint,
      status: fs.status,
    });
    return;
  }
  writeStderrLine(
    `qwen serve: ${route} unexpected error: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }`,
  );
  res.status(500).json({
    errorKind: 'internal_error',
    error: err instanceof Error ? err.message : String(err),
    status: 500,
  });
}

/**
 * Parse a positive-integer query value within `[min, max]`. Returns:
 *   - `undefined` when the param is absent (caller defaults).
 *   - `null` when the param is malformed/out-of-range — the route
 *     short-circuits with a 400 + `parse_error` envelope.
 *   - the parsed integer otherwise.
 *
 * Strict on `^\d+$` so `''`, `'abc'`, `'1.5'`, `'-3'` all reject —
 * the daemon's other range parsers (`parseMaxQueuedQuery`) use the
 * same regex shape, keeping query-validation behavior consistent.
 */
function parseIntInRange(
  raw: unknown,
  min: number,
  max: number,
): number | null | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/** Treat `'1'` and `'true'` as true; everything else (including absence) as false. */
function parseBoolFlag(raw: unknown): boolean {
  return raw === '1' || raw === 'true';
}

/**
 * Extract a required string query param. Returns the value or sends
 * a 400 envelope and returns `null`. Empty strings count as absent
 * — the daemon doesn't accept `?path=` as "the workspace root";
 * callers asking for the root pass `?path=.` explicitly.
 */
function requireStringQuery(
  res: Response,
  raw: unknown,
  name: string,
  route: string,
): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    applyReadHeaders(res);
    res.status(400).json({
      errorKind: 'parse_error',
      error: `${name} query parameter is required`,
      status: 400,
    });
    writeStderrLine(
      `qwen serve: ${route} rejected request missing required ?${name}`,
    );
    return null;
  }
  return raw;
}

/**
 * Pull `WorkspaceFileSystemFactory` off `app.locals` (set by
 * `createServeApp`). Returns `null` and sends a 500 envelope when
 * the factory is missing — that means `createServeApp` was bypassed
 * by a custom embed without injecting `deps.fsFactory`, which is a
 * deployment misconfiguration the route can't recover from.
 */
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

interface RegisterDeps {
  /**
   * Pulls the daemon-stamped client identity off the request. Re-used
   * from `serve/server.ts` so the X-Qwen-Client-Id validation lives
   * in one place; PR 19 routes thread the trusted id into the audit
   * context. Returning `null` means the helper already sent a 400
   * — the route must short-circuit.
   */
  parseClientId: (req: Request, res: Response) => string | undefined | null;
}

async function handleGetFile(
  req: Request,
  res: Response,
  _deps: RegisterDeps,
): Promise<void> {
  const ROUTE = 'GET /file';
  const factory = getFsFactory(req, res);
  if (!factory) return;
  const clientId = _deps.parseClientId(req, res);
  if (clientId === null) return;
  const queryPath = requireStringQuery(res, req.query['path'], 'path', ROUTE);
  if (queryPath === null) return;
  const maxBytes = parseIntInRange(req.query['maxBytes'], 1, 256 * 1024);
  if (maxBytes === null) {
    applyReadHeaders(res);
    res.status(400).json({
      errorKind: 'parse_error',
      error: '`maxBytes` must be a positive integer in [1, 262144]',
      status: 400,
    });
    return;
  }
  const line = parseIntInRange(req.query['line'], 1, Number.MAX_SAFE_INTEGER);
  if (line === null) {
    applyReadHeaders(res);
    res.status(400).json({
      errorKind: 'parse_error',
      error: '`line` must be a positive integer',
      status: 400,
    });
    return;
  }
  const limit = parseIntInRange(req.query['limit'], 1, MAX_LIST_ENTRIES);
  if (limit === null) {
    applyReadHeaders(res);
    res.status(400).json({
      errorKind: 'parse_error',
      error: '`limit` must be a positive integer in [1, 2000]',
      status: 400,
    });
    return;
  }
  const fs = factory.forRequest({
    originatorClientId: clientId ?? undefined,
    route: ROUTE,
  });
  try {
    const resolved = await fs.resolve(queryPath, 'read');
    const out = await fs.readText(resolved, { maxBytes, line, limit });
    applyReadHeaders(res);
    res.status(200).json({
      kind: 'file',
      path: workspaceRelative(req, resolved),
      content: out.content,
      encoding: out.meta.encoding ?? 'utf-8',
      bom: out.meta.bom === true,
      lineEnding: out.meta.lineEnding,
      sizeBytes: Buffer.byteLength(out.content, 'utf-8'),
      truncated: out.meta.truncated === true,
      matchedIgnore: out.meta.matchedIgnore ?? null,
      originalLineCount: out.meta.originalLineCount,
    });
  } catch (err) {
    sendFsError(res, err, ROUTE);
  }
}

async function handleGetStat(
  req: Request,
  res: Response,
  _deps: RegisterDeps,
): Promise<void> {
  const ROUTE = 'GET /stat';
  const factory = getFsFactory(req, res);
  if (!factory) return;
  const clientId = _deps.parseClientId(req, res);
  if (clientId === null) return;
  const queryPath = requireStringQuery(res, req.query['path'], 'path', ROUTE);
  if (queryPath === null) return;
  const fs = factory.forRequest({
    originatorClientId: clientId ?? undefined,
    route: ROUTE,
  });
  try {
    const resolved = await fs.resolve(queryPath, 'stat');
    const st = await fs.stat(resolved);
    applyReadHeaders(res);
    res.status(200).json({
      kind: 'stat',
      path: workspaceRelative(req, resolved),
      type: st.kind,
      sizeBytes: st.sizeBytes,
      modifiedMs: st.modifiedMs,
    });
  } catch (err) {
    sendFsError(res, err, ROUTE);
  }
}

async function handleGetList(
  req: Request,
  res: Response,
  _deps: RegisterDeps,
): Promise<void> {
  const ROUTE = 'GET /list';
  const factory = getFsFactory(req, res);
  if (!factory) return;
  const clientId = _deps.parseClientId(req, res);
  if (clientId === null) return;
  const queryPath = requireStringQuery(res, req.query['path'], 'path', ROUTE);
  if (queryPath === null) return;
  const includeIgnored = parseBoolFlag(req.query['includeIgnored']);
  const fs = factory.forRequest({
    originatorClientId: clientId ?? undefined,
    route: ROUTE,
  });
  try {
    const resolved = await fs.resolve(queryPath, 'list');
    const entries = await fs.list(resolved, { includeIgnored });
    let truncated = false;
    let returned = entries;
    if (returned.length > MAX_LIST_ENTRIES) {
      // Slice on the route side rather than passing a cap into
      // `list()` so the boundary's audit row reports the FULL
      // directory size (`sizeBytes` = entries.length) — operators
      // see the directory's true cardinality, not just what the
      // route handed back. PR 18's `list()` doesn't accept a cap
      // anyway; pagination support lives inside the route.
      returned = returned.slice(0, MAX_LIST_ENTRIES);
      truncated = true;
    }
    applyReadHeaders(res);
    res.status(200).json({
      kind: 'list',
      path: workspaceRelative(req, resolved),
      entries: returned,
      truncated,
      matchedIgnore: null,
    });
  } catch (err) {
    sendFsError(res, err, ROUTE);
  }
}

async function handleGetGlob(
  req: Request,
  res: Response,
  _deps: RegisterDeps,
): Promise<void> {
  const ROUTE = 'GET /glob';
  const factory = getFsFactory(req, res);
  if (!factory) return;
  const clientId = _deps.parseClientId(req, res);
  if (clientId === null) return;
  const pattern = requireStringQuery(
    res,
    req.query['pattern'],
    'pattern',
    ROUTE,
  );
  if (pattern === null) return;
  const includeIgnored = parseBoolFlag(req.query['includeIgnored']);
  const maxResults = parseIntInRange(
    req.query['maxResults'],
    1,
    MAX_GLOB_MAX_RESULTS,
  );
  if (maxResults === null) {
    applyReadHeaders(res);
    res.status(400).json({
      errorKind: 'parse_error',
      error: `\`maxResults\` must be a positive integer in [1, ${MAX_GLOB_MAX_RESULTS}]`,
      status: 400,
    });
    return;
  }
  const cwdRaw = req.query['cwd'];
  const cwdString =
    typeof cwdRaw === 'string' && cwdRaw.length > 0 ? cwdRaw : undefined;
  const fs = factory.forRequest({
    originatorClientId: clientId ?? undefined,
    route: ROUTE,
  });
  const start = performance.now();
  try {
    const cwdResolved = cwdString
      ? await fs.resolve(cwdString, 'glob')
      : undefined;
    const matches = await fs.glob(pattern, {
      cwd: cwdResolved,
      includeIgnored,
      maxResults: maxResults ?? DEFAULT_GLOB_MAX_RESULTS,
    });
    const boundWorkspace = (req.app.locals as { boundWorkspace?: string })
      .boundWorkspace;
    const relMatches = matches.map((m) =>
      boundWorkspace
        ? path.relative(boundWorkspace, m as string)
        : (m as string),
    );
    applyReadHeaders(res);
    res.status(200).json({
      kind: 'glob',
      pattern,
      cwd: cwdString ?? '',
      matches: relMatches,
      count: relMatches.length,
      truncated: relMatches.length === (maxResults ?? DEFAULT_GLOB_MAX_RESULTS),
      durationMs: Math.round(performance.now() - start),
    });
  } catch (err) {
    sendFsError(res, err, ROUTE);
  }
}

/**
 * Compute the workspace-relative form of a `ResolvedPath` for the
 * response payload. Falls back to the absolute path when
 * `boundWorkspace` is not on `app.locals` (older test embeds that
 * skipped the fixture); production always sets it via
 * `createServeApp`.
 */
function workspaceRelative(req: Request, resolved: string): string {
  const boundWorkspace = (req.app.locals as { boundWorkspace?: string })
    .boundWorkspace;
  if (!boundWorkspace) return resolved;
  const rel = path.relative(boundWorkspace, resolved);
  return rel === '' ? '.' : rel;
}

export function registerWorkspaceFileReadRoutes(
  app: Application,
  deps: RegisterDeps,
): void {
  app.get('/file', (req, res) => handleGetFile(req, res, deps));
  app.get('/stat', (req, res) => handleGetStat(req, res, deps));
  app.get('/list', (req, res) => handleGetList(req, res, deps));
  app.get('/glob', (req, res) => handleGetGlob(req, res, deps));
}
