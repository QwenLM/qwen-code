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
  /** Workspace-relative path; only populated when QWEN_AUDIT_RAW_PATHS=1. */
  relPath?: string;
  sizeBytes?: number;
  truncated?: boolean;
  matchedIgnore?: 'file' | 'directory';
  durationMs: number;
}

export interface FsDeniedAuditPayload {
  kind: typeof FS_DENIED_EVENT_TYPE;
  intent: Intent;
  route: string;
  pathHash: string;
  relPath?: string;
  errorKind: FsErrorKind;
  hint?: string;
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
 * Compute the workspace-relative form of a path for the optional
 * `relPath` audit field. Returns the trailing path even when the
 * input lies outside `boundWorkspace` (the `denied` case): the
 * audit consumer wants to see what the caller asked for, not be
 * silently dropped.
 */
function relForAudit(raw: string, boundWorkspace: string): string {
  // For absolute inputs, compute relative; for relative, pass through.
  // Either way the operator gets a workspace-anchored view.
  return path.isAbsolute(raw) ? path.relative(boundWorkspace, raw) : raw;
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
      if (record.sizeBytes !== undefined) payload.sizeBytes = record.sizeBytes;
      if (record.truncated) payload.truncated = true;
      if (record.matchedIgnore) payload.matchedIgnore = record.matchedIgnore;
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
      if (record.hint) payload.hint = record.hint;
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
