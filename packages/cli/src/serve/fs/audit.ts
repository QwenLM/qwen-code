/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { EVENT_SCHEMA_VERSION, type BridgeEvent } from '../eventBus.js';
import type { FsErrorKind } from './errors.js';
import type { Intent, ResolvedPath } from './paths.js';

/**
 * Frame type for successful filesystem operations on the boundary.
 * Emitted from the orchestrator on the success path of `readText`,
 * `readBytes`, `list`, `glob`, `stat`, `writeText`, `edit`. PR 19/20
 * SSE consumers can fan it out to subscribed clients; PR 18 itself
 * has no consumer beyond unit tests, since no HTTP routes use the
 * boundary yet.
 */
export const FS_ACCESS_EVENT_TYPE = 'fs.access' as const;

/**
 * Frame type for boundary policy denials. Emitted whenever an
 * `FsError` propagates from the orchestrator. Always emitted, even
 * for transient ones that the route handler will surface to the
 * caller — the audit trail is the operator's tool, separate from
 * the client-visible response.
 */
export const FS_DENIED_EVENT_TYPE = 'fs.denied' as const;

/**
 * Request-scoped audit context. Bound to a `WorkspaceFileSystem`
 * instance by the factory's `forRequest(ctx)` call so individual
 * orchestrator methods don't need to thread these fields by hand.
 */
export interface AuditContext {
  /** Daemon-stamped client identity from PR 7 (#4231). */
  originatorClientId?: string;
  /** Optional ACP session id for cross-correlating audit + session events. */
  sessionId?: string;
  /** Route name like 'GET /file' — populated by PR 19/20 handlers. */
  route: string;
}

/**
 * Successful-access record. The hot path computes this lazily so a
 * disabled publisher (no subscribers, no flag) doesn't pay the
 * SHA-256 cost. Sized fields (`sizeBytes`) and outcome fields
 * (`truncated`) are present only when meaningful for the intent.
 *
 * The literal `kind` field discriminates this against
 * `FsDeniedAuditPayload` so SDK consumers can `switch` over a
 * `FsAccessAuditPayload | FsDeniedAuditPayload` union and have
 * the type narrow inside each branch — the `BridgeEvent.type`
 * envelope alone doesn't propagate type information into
 * `event.data: unknown`.
 */
export interface FsAccessAuditPayload {
  kind: typeof FS_ACCESS_EVENT_TYPE;
  intent: Intent;
  route: string;
  pathHash: string;
  /**
   * ACP session id from `AuditContext.sessionId`, when known.
   * Multi-session daemons need this to correlate audit events
   * back to the session that triggered them — `originatorClientId`
   * alone identifies the *client*, not the *session*. Always
   * present when the calling route is session-scoped (PR 19/20
   * routes that take `:sessionId`); absent on workspace-scoped
   * routes that have no session context.
   */
  sessionId?: string;
  /** Workspace-relative path; only populated when QWEN_AUDIT_RAW_PATHS=1. */
  relPath?: string;
  sizeBytes?: number;
  truncated?: boolean;
  matchedIgnore?: 'file' | 'directory';
  durationMs: number;
  /**
   * Literal glob pattern. Populated only for `intent === 'glob'`,
   * where `pathHash` would otherwise hash the bound workspace and
   * provide no per-call information. The pattern is recorded
   * verbatim (not hashed) because it does not carry path content
   * — the per-hit canonical paths are NOT logged here. Audit
   * consumers correlate the workspace via `pathHash` and the
   * specific call via `pattern`.
   */
  pattern?: string;
}

export interface FsDeniedAuditPayload {
  kind: typeof FS_DENIED_EVENT_TYPE;
  intent: Intent;
  route: string;
  pathHash: string;
  /** See `FsAccessAuditPayload.sessionId` — same semantics. */
  sessionId?: string;
  relPath?: string;
  errorKind: FsErrorKind;
  hint?: string;
  /**
   * Human-readable error message from the underlying `FsError`.
   * Audit consumers debugging a production incident need to see
   * the actual OS error (e.g. errno detail, byte counts) rather
   * than only `errorKind` + `hint`. Optional so privacy-sensitive
   * deployments can suppress it; populated by default by
   * `recordDenied` since the orchestrator already wraps every body
   * error into an `FsError` whose message we can quote.
   */
  message?: string;
  /** See `FsAccessAuditPayload.pattern` — same semantics. */
  pattern?: string;
}

/**
 * Boundary-side audit publisher. The orchestrator (commit 6) will
 * call `recordAccess` on success and `recordDenied` on `FsError`,
 * passing the resolved path so this module can normalize, hash,
 * and (optionally) attach the relative form.
 */
export interface AuditPublisher {
  recordAccess(
    ctx: AuditContext,
    record: Omit<
      FsAccessAuditPayload,
      'kind' | 'pathHash' | 'relPath' | 'route'
    > & {
      absolute: ResolvedPath | string;
    },
  ): void;
  recordDenied(
    ctx: AuditContext,
    record: Omit<
      FsDeniedAuditPayload,
      'kind' | 'pathHash' | 'relPath' | 'route'
    > & {
      /** Raw user input; the canonical form may not exist on disk. */
      input: string;
    },
  ): void;
}

// Why the request types `Omit` four fields and pass `pattern`
// through:
//
// `recordAccess` / `recordDenied` callers describe the event in
// domain terms (intent, durationMs, errorKind, ...); the publisher
// synthesizes the wire-shaped fields the schema needs: `kind`,
// `pathHash`, `relPath`, and `route`. Hiding those fields behind
// `Omit` prevents callers from fabricating values that do not match
// what the publisher serializes.
//
// `pattern` is the one optional field that survives the Omit: only
// the orchestrator's glob path knows the literal pattern, and the
// publisher cannot synthesize it from anything else.

/**
 * SHA-256 over the canonical absolute path, truncated to 16 hex
 * chars. The truncation matches claude-code's privacy model: long
 * enough to be unique within a workspace, short enough that an
 * audit log is human-scannable. Full hex (64 chars) buys nothing
 * here because the audit consumer never reverses the hash.
 */
function hashPath(absolute: string): string {
  return createHash('sha256').update(absolute).digest('hex').slice(0, 16);
}

/**
 * Sentinel returned when `path.relative` produces an absolute
 * path — happens on Windows when the input is on a different
 * drive than `boundWorkspace`. Without this guard, audit
 * consumers (even in raw-paths mode) would see something that
 * looks like a valid relative path but is actually a fully
 * qualified `D:\evil\...` leaking the attacker's drive letter +
 * directory structure. The sentinel lets a UI render
 * cross-drive denials distinctly without ambiguity over what's
 * relative vs absolute.
 */
const CROSS_DRIVE_RELPATH = '<cross-drive>' as const;

/**
 * Compute the workspace-relative form of a path for the optional
 * `relPath` audit field. Returns the trailing path even when the
 * input lies outside `boundWorkspace` (the `denied` case): the
 * audit consumer wants to see what the caller asked for, not be
 * silently dropped.
 *
 * On Windows, `path.relative` between paths on different drives
 * (`C:\\ws` vs `D:\\evil`) can't produce a relative form and
 * returns the absolute target — leaking the off-drive path into
 * the audit row. We detect that with `path.isAbsolute` on the
 * *result* and substitute `CROSS_DRIVE_RELPATH` so the field
 * stays a true relative-or-sentinel and the cross-drive case is
 * still visible (just not the absolute path content).
 */
function relForAudit(raw: string, boundWorkspace: string): string {
  // For absolute inputs, compute relative; for relative, pass through.
  // Either way the operator gets a workspace-anchored view.
  const rel = path.isAbsolute(raw) ? path.relative(boundWorkspace, raw) : raw;
  return path.isAbsolute(rel) ? CROSS_DRIVE_RELPATH : rel;
}

/**
 * Whether the env opt-in for raw paths is active. Read once per
 * factory invocation rather than per emit, so flipping the env
 * mid-process needs a daemon restart — predictable behavior for
 * operators tailing logs.
 */
function rawPathsEnabled(): boolean {
  return process.env['QWEN_AUDIT_RAW_PATHS'] === '1';
}

export interface CreateAuditPublisherDeps {
  /** Bridge-bound publisher into `EventBus.publish`. */
  emit: (event: BridgeEvent) => void;
  /** Canonical workspace root, for relPath computation. */
  boundWorkspace: string;
  /** Optional override for tests / privacy modes. */
  includeRawPaths?: boolean;
}

/**
 * Build an `AuditPublisher` whose emit method publishes typed
 * `BridgeEvent`s onto the daemon's per-session NDJSON stream. The
 * publisher takes care of:
 *
 * - hashing the path (always)
 * - computing relative path (only when `includeRawPaths` is on)
 * - synthesizing the `BridgeEvent.type` discriminator
 * - forwarding `originatorClientId` so the SSE fan-out can suppress
 *   self-echoes
 *
 * Publishers are cheap to construct and intended to live on a
 * `WorkspaceFileSystemFactory` for the daemon's process lifetime.
 */
export function createAuditPublisher(
  deps: CreateAuditPublisherDeps,
): AuditPublisher {
  const includeRawPaths = deps.includeRawPaths ?? rawPathsEnabled();
  const { emit, boundWorkspace } = deps;
  return {
    recordAccess(ctx, record) {
      const absolute = String(record.absolute);
      const payload: FsAccessAuditPayload = {
        kind: FS_ACCESS_EVENT_TYPE,
        intent: record.intent,
        route: ctx.route,
        pathHash: hashPath(absolute),
        durationMs: record.durationMs,
      };
      if (ctx.sessionId) payload.sessionId = ctx.sessionId;
      if (record.sizeBytes !== undefined) payload.sizeBytes = record.sizeBytes;
      if (record.truncated) payload.truncated = true;
      if (record.matchedIgnore) payload.matchedIgnore = record.matchedIgnore;
      // `pattern` shares the same privacy gate as `relPath` and
      // `message`. Glob patterns commonly embed workspace-relative
      // or absolute path fragments (`src/secrets/*.env`,
      // `/Users/alice/ws/**`), so emitting the literal pattern in
      // privacy mode would bypass the same redaction the other
      // path-bearing fields honor. Operators wanting full forensic
      // context opt in via `QWEN_AUDIT_RAW_PATHS=1`.
      if (record.pattern !== undefined && includeRawPaths) {
        payload.pattern = record.pattern;
      }
      if (includeRawPaths) {
        payload.relPath = relForAudit(absolute, boundWorkspace);
      }
      emit({
        v: EVENT_SCHEMA_VERSION,
        type: FS_ACCESS_EVENT_TYPE,
        data: payload,
        originatorClientId: ctx.originatorClientId,
      });
    },
    recordDenied(ctx, record) {
      const probe = path.isAbsolute(record.input)
        ? record.input
        : path.resolve(boundWorkspace, record.input);
      const payload: FsDeniedAuditPayload = {
        kind: FS_DENIED_EVENT_TYPE,
        intent: record.intent,
        route: ctx.route,
        pathHash: hashPath(probe),
        errorKind: record.errorKind,
      };
      if (ctx.sessionId) payload.sessionId = ctx.sessionId;
      if (record.hint) payload.hint = record.hint;
      // `message` carries the underlying `FsError.message`, which
      // many throw-sites embed `${p}` (absolute workspace path) or
      // user-supplied `oldText` snippets into. Privacy-mode
      // deployments that intentionally disabled raw-path logging
      // would otherwise see those paths leak through the message.
      // Gate the field on `includeRawPaths` so privacy mode means
      // privacy mode for ALL path-bearing audit content (relPath
      // AND message). Operators who want full forensic context
      // opt in via `QWEN_AUDIT_RAW_PATHS=1`.
      if (record.message && includeRawPaths) {
        payload.message = record.message;
      }
      // Same privacy gate as the success-path `pattern` above
      // (and as `relPath` / `message` here). Reject-pattern denials
      // (`../**`, `/etc/**`) are themselves path content; emitting
      // them in privacy mode would let the audit log echo exactly
      // what the operator opted out of seeing.
      if (record.pattern !== undefined && includeRawPaths) {
        payload.pattern = record.pattern;
      }
      if (includeRawPaths) {
        payload.relPath = relForAudit(record.input, boundWorkspace);
      }
      emit({
        v: EVENT_SCHEMA_VERSION,
        type: FS_DENIED_EVENT_TYPE,
        data: payload,
        originatorClientId: ctx.originatorClientId,
      });
    },
  };
}
