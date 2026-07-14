/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Request, Response } from 'express';
import type { AcpSessionBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import { MAX_WORKSPACE_PATH_LENGTH } from '@qwen-code/acp-bridge/workspacePaths';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { WorkspaceRequestContext } from '../workspace-service/index.js';

export function sendJsonBodyParserError(res: Response, err: unknown): boolean {
  if (
    err instanceof SyntaxError &&
    'status' in err &&
    (err as { status: number }).status === 400
  ) {
    res.status(400).json({ error: 'Invalid JSON in request body' });
    return true;
  }
  // body-parser raises a typed error with `status: 413` when a
  // request body exceeds the `express.json({ limit: '10mb' })`
  // ceiling. Without this branch it falls through to the 500 path
  // and clients see a misleading "Internal server error" instead
  // of a clear "payload too large" — which is the kind of error
  // they can actually act on (chunk the request, raise the limit).
  if (
    err &&
    typeof err === 'object' &&
    'status' in err &&
    (err as { status: number }).status === 413
  ) {
    res.status(413).json({ error: 'Request body too large (max 10 MB)' });
    return true;
  }
  return false;
}

/**
 * Keys stripped by `safeBody` to defend against prototype-pollution
 * Routes downstream of `safeBody` spread
 * the filtered result into objects passed to the bridge / ACP SDK;
 * without this scrub a client could set
 * `{"__proto__": {"polluted": true}}` and pollute
 * `Object.prototype` via downstream spreads.
 *
 * **Cross-reference for route maintainers:** the POST `/session`
 * route distinguishes "absent" from "present" via `'cwd' in body`
 * against `safeBody`'s output. The semantics rely on this set NOT
 * overlapping with user-payload keys. If you ever add a key here
 * that a route's presence-check cares about (highly unlikely — this
 * set is the JS prototype-attack triple, plus a route would have
 * to deliberately name a property after one of these), the
 * presence-check needs to move to the pre-`safeBody` `req.body`
 * (with its own pollution guard) or `safeBody` needs to return a
 * separate "raw-keys" set alongside the filtered object.
 */
const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

export const CLIENT_ID_HEADER = 'x-qwen-client-id';
export const MAX_CLIENT_ID_LENGTH = 128;
export const MAX_TOOL_NAME_LENGTH = 256;
export const MAX_SKILL_NAME_LENGTH = 256;
export const MAX_SERVER_NAME_LENGTH = 256;
export const CLIENT_ID_RE = /^[A-Za-z0-9._:-]+$/;
const INVALID_PERMISSION_OUTCOME_ERROR =
  '`outcome` must be `{ outcome: "cancelled" }` or `{ outcome: "selected", optionId: string }`';

export interface DeferredRuntimeRequestTiming {
  startedAt: Date;
  path: 'started_on_request' | 'joined';
  waitMs?: number;
}

const deferredRuntimeTimingKey: unique symbol = Symbol(
  'deferredRuntimeRequestTiming',
);

type DeferredRuntimeTimedRequest = Request & {
  [deferredRuntimeTimingKey]?: DeferredRuntimeRequestTiming;
};

export function setDeferredRuntimeRequestTiming(
  req: Request,
  timing: DeferredRuntimeRequestTiming,
): void {
  (req as DeferredRuntimeTimedRequest)[deferredRuntimeTimingKey] = timing;
}

export function getDeferredRuntimeRequestTiming(
  req: Request,
): DeferredRuntimeRequestTiming | undefined {
  return (req as DeferredRuntimeTimedRequest)[deferredRuntimeTimingKey];
}

type PermissionVoteResponse = Parameters<
  AcpSessionBridge['respondToPermission']
>[1];

/**
 * Coerce `req.body` into a safe `Record<string, unknown>` for route
 * handlers.
 *
 * Strips the `PROTOTYPE_POLLUTION_KEYS` set before returning. Uses an
 * `Object.create(null)` target so the returned object itself has no
 * prototype either, blocking second-order spread-into-default-
 * prototype attacks.
 */
export function safeBody(req: Request): Record<string, unknown> {
  const raw = req.body;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return Object.create(null) as Record<string, unknown>;
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export function parseOptionalWorkspaceCwd(
  body: Record<string, unknown>,
  boundWorkspace: string,
  res: Response,
): string | undefined {
  const hasCwd = 'cwd' in body;
  if (hasCwd && typeof body['cwd'] !== 'string') {
    res
      .status(400)
      .json({ error: '`cwd` must be a string absolute path when provided' });
    return undefined;
  }
  if (hasCwd && (body['cwd'] as string).length > MAX_WORKSPACE_PATH_LENGTH) {
    res.status(400).json({
      error: `\`cwd\` exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`,
    });
    return undefined;
  }
  const cwd = hasCwd ? (body['cwd'] as string) : boundWorkspace;
  if (!path.isAbsolute(cwd)) {
    res
      .status(400)
      .json({ error: '`cwd` must be an absolute path when provided' });
    return undefined;
  }
  return cwd;
}

export function requireSessionId(req: Request, res: Response): string | null {
  const sessionId = req.params['id'];
  if (!sessionId) {
    res.status(400).json({ error: '`sessionId` route parameter is required' });
    return null;
  }
  return sessionId;
}

export function parseClientIdHeader(
  req: Request,
  res: Response,
): string | undefined | null {
  const raw = req.get(CLIENT_ID_HEADER);
  if (raw === undefined || raw === '') return undefined;
  if (raw.length > MAX_CLIENT_ID_LENGTH || !CLIENT_ID_RE.test(raw)) {
    res.status(400).json({
      error:
        '`X-Qwen-Client-Id` must be a non-empty token of 128 characters or fewer',
      code: 'invalid_client_id',
    });
    return null;
  }
  return raw;
}

/**
 * Decide whether a permission vote arrived from a loopback peer.
 *
 * Per RFC 1122 the entire `127.0.0.0/8` block is loopback (and the
 * IPv4-mapped IPv6 form `::ffff:127.0.0.0/104` mirrors that). IPv6
 * loopback is `::1` (single literal).
 *
 * **Security**: reads `req.socket.remoteAddress` only — does NOT
 * consult `X-Forwarded-For` or any HTTP header (forgeable). Fail-
 * CLOSED: unrecognized shapes return `false`.
 */
export function detectFromLoopback(req: {
  socket?: { remoteAddress?: string | undefined };
}): boolean {
  const addr = req.socket?.remoteAddress;
  if (typeof addr !== 'string') return false;
  // IPv6 loopback (single literal).
  if (addr === '::1') return true;
  // IPv4 loopback: 127.0.0.0/8.
  if (addr.startsWith('127.')) return true;
  // IPv4-mapped IPv6 loopback: ::ffff:127.0.0.0/104.
  if (addr.startsWith('::ffff:127.')) return true;
  return false;
}

/**
 * Validate that a server name from a route parameter is a non-empty
 * alphanumeric string within the length limit and not a reserved JS
 * property name. Emits a 400 JSON response and returns `false` on
 * validation failure.
 */
export function validateMcpRuntimeServerName(
  name: unknown,
  res: Response,
): name is string {
  if (typeof name !== 'string' || name.length === 0) {
    res.status(400).json({
      error: 'Server name is required and must be a non-empty string',
      code: 'invalid_server_name',
    });
    return false;
  }
  if (name.length > MAX_SERVER_NAME_LENGTH) {
    res.status(400).json({
      error: `Server name exceeds ${MAX_SERVER_NAME_LENGTH}-character limit`,
      code: 'invalid_server_name',
    });
    return false;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    res.status(400).json({
      error:
        'Server name must contain only alphanumeric characters, underscores, and hyphens',
      code: 'invalid_server_name',
    });
    return false;
  }
  if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
    res.status(400).json({
      error: 'Server name must not be a reserved JS property name',
      code: 'invalid_server_name',
    });
    return false;
  }
  return true;
}

/**
 * Workspace-level mutation routes validate the parsed `X-Qwen-Client-Id`
 * against the supplied bridge set so the `originatorClientId` stamped
 * onto fan-out events is grounded in a known identity. Returns the
 * validated client id (or `undefined` when no header was supplied),
 * `null` when a 400 has already been emitted.
 */
export function parseAndValidateWorkspaceClientId(
  req: Request,
  res: Response,
  bridge: AcpSessionBridge | readonly AcpSessionBridge[],
): string | undefined | null {
  const raw = parseClientIdHeader(req, res);
  if (raw === null || raw === undefined) return raw;
  const bridges = Array.isArray(bridge) ? bridge : [bridge];
  if (!bridges.some((candidate) => candidate.knownClientIds().has(raw))) {
    res.status(400).json({
      error: `Client id "${raw}" is not registered for this workspace`,
      code: 'invalid_client_id',
      clientId: raw,
    });
    return null;
  }
  return raw;
}

export function createBuildWorkspaceCtx(boundWorkspace: string) {
  return (route: string, clientId?: string): WorkspaceRequestContext => ({
    originatorClientId: clientId,
    route,
    workspaceCwd: boundWorkspace,
  });
}

export function parsePermissionVoteBody(
  req: Request,
  res: Response,
): PermissionVoteResponse | undefined {
  const body = safeBody(req);
  const outcome = body['outcome'];
  if (!isValidOutcome(outcome)) {
    res.status(400).json({ error: INVALID_PERMISSION_OUTCOME_ERROR });
    return undefined;
  }
  return {
    ...(body as object),
    outcome,
  } as PermissionVoteResponse;
}

function isValidOutcome(
  raw: unknown,
): raw is { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  if (obj['outcome'] === 'cancelled') return true;
  // `optionId` must be a non-empty string. An empty string is technically a
  // string but isn't a meaningful selection — letting it through would
  // forward malformed votes to the bridge and the agent would reject the
  // unknown option opaquely.
  return (
    obj['outcome'] === 'selected' &&
    typeof obj['optionId'] === 'string' &&
    (obj['optionId'] as string).length > 0
  );
}

/** Range bounds for the `?maxQueued=N` query param on `/session/:id/events`. */
const MIN_QUERY_MAX_QUEUED = 16;
const MAX_QUERY_MAX_QUEUED = 2048;

/**
 * Parse the optional `?maxQueued=N` query param on
 * `GET /session/:id/events`. Returns:
 *   - `undefined` — param absent, EventBus uses its default cap (256).
 *   - a positive integer in `[16, 2048]` — caller wants a custom cap.
 *   - `null` — malformed value; the function ALREADY sent a 400 JSON
 *     response and the route must short-circuit. (Pre-handshake 400
 *     is safer than half-opening an SSE stream and emitting a
 *     `stream_error` frame the client has to parse — `EventSource`
 *     auto-reconnects on the latter.)
 *
 * Cap range rationale: lower bound 16 (smaller is useless for any
 * replay backlog); upper bound 2048 (so a single subscriber can't
 * pin ~1 MB of queue memory just by asking).
 */
export function parseMaxQueuedQuery(
  raw: unknown,
  res: Response,
): number | undefined | null {
  // Absent param → undefined (use bus default). Present-but-empty
  // (`?maxQueued=` typed explicitly) → fail-CLOSED 400 — the API
  // documents fail-closed for any malformed value before opening
  // SSE, and an empty string is unambiguously malformed (real values
  // are positive integers in [16, 2048]).
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    // Sanitize via JSON.stringify so an attacker-controlled value
    // containing `\n` / `\r` / other control chars can't inject extra
    // log lines into stderr (line-based shipper like
    // journald/Loki/Splunk would otherwise treat the injected line as
    // a fresh entry). Matches the `workspace_mismatch` log style in
    // `sendBridgeError`.
    writeStderrLine(
      `qwen serve: rejected ?maxQueued ${safeLogValue(raw)} ` +
        `(not a decimal integer)`,
    );
    res.status(400).json({
      error: '`maxQueued` must be a decimal integer',
      code: 'invalid_max_queued',
    });
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (
    !Number.isFinite(n) ||
    n < MIN_QUERY_MAX_QUEUED ||
    n > MAX_QUERY_MAX_QUEUED
  ) {
    writeStderrLine(
      `qwen serve: rejected ?maxQueued ${safeLogValue(raw)} ` +
        `(outside [${MIN_QUERY_MAX_QUEUED}, ${MAX_QUERY_MAX_QUEUED}])`,
    );
    res.status(400).json({
      error: `\`maxQueued\` must be in [${MIN_QUERY_MAX_QUEUED}, ${MAX_QUERY_MAX_QUEUED}]`,
      code: 'invalid_max_queued',
    });
    return null;
  }
  return n;
}

/**
 * Wrap an attacker-controllable string for safe interpolation into a
 * stderr log line. `JSON.stringify` escapes control characters
 * (`\n`, `\r`, etc.) and wraps the result in quotes — any injection
 * attempt surfaces as visible-as-quoted-noise rather than a
 * forged log line. Truncated AFTER stringify to keep the budget
 * predictable even for control-heavy inputs.
 */
export function safeLogValue(raw: unknown): string {
  return JSON.stringify(String(raw)).slice(0, 82);
}

export function parseLastEventId(raw: unknown): number | undefined {
  // Stricter than Number.parseInt: only accept pure decimal digits to avoid
  // values like "1abc" or "1.5e10z" silently parsing to 1.
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    // BX9_I: log a breadcrumb for the operator when a non-empty
    // header is rejected. The client resumed from event 0 instead
    // of where they meant to — without this line, the loss of
    // every event buffered during their disconnect was invisible.
    // Skip the log for missing / empty headers (the common case of
    // "first connect, no resume").
    if (typeof raw === 'string' && raw.length > 0) {
      writeStderrLine(
        `qwen serve: rejected Last-Event-ID ${safeLogValue(raw)} ` +
          `(not a decimal integer)`,
      );
    }
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  // Reject values that lose precision as a JS `number`. The bus's monotonic
  // ids are bounded by `Number.MAX_SAFE_INTEGER` (2^53 - 1); a client that
  // tries to resume from beyond that is either malicious or broken.
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) {
    writeStderrLine(
      `qwen serve: rejected Last-Event-ID ${safeLogValue(raw)} ` +
        `(exceeds Number.MAX_SAFE_INTEGER)`,
    );
    return undefined;
  }
  return n;
}
