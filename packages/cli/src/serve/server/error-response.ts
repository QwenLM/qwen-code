/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  emitDaemonLog,
  InvalidSessionTranscriptCursorError,
  recordDaemonBridgeError,
  recordDaemonError,
  SessionTranscriptPageTooLargeError,
  SessionTranscriptSnapshotUnavailableError,
  SessionTranscriptTooLargeError,
  TrustGateError,
} from '@qwen-code/qwen-code-core';
import type { Response } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  BranchWhilePromptActiveError,
  CancelSentinelCollisionError,
  CdWhilePromptActiveError,
  InvalidClientIdError,
  InvalidPermissionOptionError,
  InvalidRewindTargetError,
  InvalidSessionMetadataError,
  InvalidSessionScopeError,
  McpServerNotFoundError,
  McpServerRestartFailedError,
  PermissionForbiddenError,
  PermissionPolicyNotImplementedError,
  PromptQueueFullError,
  RestoreInProgressError,
  SessionArtifactAuthorizationError,
  SessionArchivedError,
  SessionArchivingError,
  SessionBusyError,
  SessionConflictError,
  SessionLimitExceededError,
  SessionNotFoundError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
  WorkspaceInitConflictError,
  WorkspaceInitPathEscapeError,
  WorkspaceInitRaceError,
  WorkspaceInitSymlinkError,
  WorkspaceMismatchError,
  TotalSessionLimitExceededError,
} from '../acp-session-bridge.js';
import type { DaemonLogger } from '../daemon-logger.js';

export type BridgeErrorContext = {
  route?: string;
  sessionId?: string;
  [key: string]: string | number | boolean | undefined;
};

export type SendBridgeError = (
  res: Response,
  err: unknown,
  ctx?: BridgeErrorContext,
) => void;

function bridgeErrorExtraContext(
  ctx: BridgeErrorContext | undefined,
): Record<string, string | number | boolean> {
  const extra: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(ctx ?? {})) {
    if (key === 'route' || key === 'sessionId' || value === undefined) {
      continue;
    }
    extra[key] = value;
  }
  return extra;
}

export function sendPermissionVoteError(
  res: Response,
  err: unknown,
  ctx: { route: string; sessionId?: string },
  daemonLog?: DaemonLogger,
): void {
  // BkwQI: voter's `optionId` wasn't in the option set the agent
  // originally offered (e.g. forging `ProceedAlways*` when the
  // prompt's `hideAlwaysAllow` policy suppressed it). 400, not
  // 404 — the requestId IS known, but the chosen option isn't.
  if (err instanceof InvalidPermissionOptionError) {
    res.status(400).json({
      error: err.message,
      code: 'invalid_option_id',
      requestId: err.requestId,
      optionId: err.optionId,
    });
    return;
  }
  // Designated voter mismatch / `local-only` remote
  // rejection. 403 because the request is well-formed and the voter
  // was authenticated; the policy refuses their vote.
  if (err instanceof PermissionForbiddenError) {
    res.status(403).json({
      error: err.message,
      code: 'permission_forbidden',
      requestId: err.requestId,
      sessionId: err.sessionId,
      reason: err.reason,
    });
    return;
  }
  // Operator configured a permission policy whose
  // implementation has not landed in this build yet. 501 (not 500)
  // so the SDK can render "your daemon is older than your settings
  // expect; upgrade" rather than a generic Internal Server Error.
  if (err instanceof PermissionPolicyNotImplementedError) {
    res.status(501).json({
      error: err.message,
      code: 'permission_policy_not_implemented',
      policy: err.policy,
    });
    return;
  }
  // Agent declared an `allowedOptionIds` set that
  // includes the cancel-vote sentinel. This is a contract violation
  // between agent and daemon (not a client mistake), so 500 is the
  // right shape; structured `code` lets the SDK distinguish from
  // unrelated 500s.
  if (err instanceof CancelSentinelCollisionError) {
    res.status(500).json({
      error: err.message,
      code: 'cancel_sentinel_collision',
      requestId: err.requestId,
      sentinel: err.sentinel,
    });
    return;
  }
  sendBridgeError(res, err, ctx, daemonLog);
}

/**
 * Map a thrown bridge error to an HTTP response.
 *
 * `ctx` is operator-facing: route + sessionId folded into the stderr
 * log line so a bare `ECONNRESET` / `ENOMEM` stack trace is
 * attributable to a specific session and request without having to
 * timestamp-correlate against client logs. Pass via the route handlers
 * — see how they call `sendBridgeError(res, err, { route: 'POST
 * /session/:id/prompt', sessionId })`. Optional so test/dev call
 * sites that don't care about the log can omit it.
 */
export function sendBridgeError(
  res: Response,
  err: unknown,
  ctx?: BridgeErrorContext,
  daemonLog?: DaemonLogger,
): void {
  if (err instanceof InvalidSessionTranscriptCursorError) {
    res.status(400).json({
      error: err.message,
      code: 'invalid_transcript_cursor',
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
    });
    return;
  }
  if (err instanceof SessionTranscriptSnapshotUnavailableError) {
    res.status(409).json({
      error: err.message,
      code: 'transcript_snapshot_unavailable',
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
    });
    return;
  }
  if (err instanceof SessionTranscriptPageTooLargeError) {
    res.status(413).json({
      error: err.message,
      code: 'transcript_page_too_large',
      sessionId: err.sessionId,
      pageBytes: err.pageBytes,
      maxBytes: err.maxBytes,
    });
    return;
  }
  if (err instanceof SessionTranscriptTooLargeError) {
    res.status(413).json({
      error: err.message,
      code: 'transcript_too_large',
      sessionId: err.sessionId,
      snapshotSize: err.snapshotSize,
      maxBytes: err.maxBytes,
    });
    return;
  }
  if (err instanceof WorkspaceInitConflictError) {
    // The target file already exists with non-
    // whitespace content and the caller did not pass `force: true`.
    // Body carries the resolved path + size so SDK clients can render
    // a "file already exists; pass force: true to overwrite" prompt
    // without re-stat'ing the workspace.
    res.status(409).json({
      error: err.message,
      code: 'workspace_init_conflict',
      path: err.path,
      existingSize: err.existingSize,
    });
    return;
  }
  if (err instanceof WorkspaceInitPathEscapeError) {
    // The configured `context.fileName` resolves outside the bound
    // workspace. 400 because this is a fixable misconfiguration.
    res.status(400).json({
      error: err.message,
      code: 'workspace_init_path_escape',
      filename: err.filename,
      boundWorkspace: err.boundWorkspace,
    });
    return;
  }
  if (err instanceof WorkspaceInitSymlinkError) {
    // Either the target file is a symlink, or a parent directory is
    // a symlink that escapes the workspace.
    res.status(400).json({
      error: err.message,
      code: 'workspace_init_symlink',
      target: err.target,
      kind: err.kind,
    });
    return;
  }
  if (err instanceof WorkspaceInitRaceError) {
    // Race-condition: EEXIST after absence check or ENOENT after
    // content check (concurrent writer). Distinct
    // `code: 'workspace_init_race'` for dashboard classification.
    res.status(400).json({
      error: err.message,
      code: 'workspace_init_race',
      target: err.target,
      kind: err.kind,
    });
    return;
  }
  if (err instanceof McpServerNotFoundError) {
    // Stable 404 for "MCP server name not in config".
    res.status(404).json({
      error: err.message,
      code: 'mcp_server_not_found',
      serverName: err.serverName,
    });
    return;
  }
  if (err instanceof McpServerRestartFailedError) {
    // 502 because the MCP server failed to come back online.
    res.status(502).json({
      error: err.message,
      code: 'mcp_server_restart_failed',
      errorKind: 'protocol_error',
      serverName: err.serverName,
      mcpStatus: err.mcpStatus,
    });
    return;
  }
  if (err instanceof BranchWhilePromptActiveError) {
    res.status(409).json({
      error: err.message,
      code: 'branch_while_prompt_active',
      sessionId: err.sessionId,
    });
    return;
  }
  if (err instanceof CdWhilePromptActiveError) {
    res.status(409).json({
      error: err.message,
      code: 'cd_while_prompt_active',
      sessionId: err.sessionId,
    });
    return;
  }
  if (err instanceof TrustGateError) {
    // Trust-folder rejection. 403 because the workspace's trust posture
    // forbids the privileged mode.
    res.status(403).json({
      error: err.message,
      code: 'trust_gate',
      errorKind: 'auth_env_error',
    });
    return;
  }
  if (err instanceof SessionNotFoundError) {
    res.status(404).json({ error: err.message, sessionId: err.sessionId });
    return;
  }
  if (err instanceof SessionArchivedError) {
    res.status(409).json({
      error: err.message,
      code: 'session_archived',
      sessionId: err.sessionId,
    });
    return;
  }
  if (err instanceof SessionConflictError) {
    res.status(409).json({
      error: err.message,
      code: 'session_conflict',
      sessionId: err.sessionId,
    });
    return;
  }
  if (err instanceof SessionArchivingError) {
    res.set('Retry-After', '5');
    res.status(409).json({
      error: err.message,
      code: 'session_archiving',
      sessionId: err.sessionId,
    });
    return;
  }
  if (err instanceof InvalidClientIdError) {
    res.status(400).json({
      error: err.message,
      code: 'invalid_client_id',
      sessionId: err.sessionId,
      clientId: err.clientId,
    });
    return;
  }
  if (err instanceof SessionArtifactAuthorizationError) {
    res.status(403).json({
      error: err.message,
      code: 'session_artifact_forbidden',
      sessionId: err.sessionId,
      artifactId: err.artifactId,
    });
    return;
  }
  if (err instanceof SessionShellDisabledError) {
    res.status(403).json({
      error: err.message,
      code: 'session_shell_disabled',
      errorKind: 'session_shell_disabled',
    });
    return;
  }
  if (err instanceof SessionShellClientRequiredError) {
    res.status(403).json({
      error: err.message,
      code: 'client_id_required',
      errorKind: 'client_id_required',
    });
    return;
  }
  if (err instanceof WorkspaceMismatchError) {
    // Single-workspace mode: the daemon binds to one workspace at
    // boot; cross-workspace POSTs are rejected here.
    // 400 (not 404 — the daemon is "fine", the client just picked
    // the wrong daemon for their workspace). Body includes both
    // paths so orchestrator-aware clients can route to the right
    // daemon / spawn a new one.
    //
    // Operator log line: unlike SessionNotFoundError (per-session
    // 404 with rich URL context), workspace_mismatch indicates an
    // orchestration / deployment drift (operator booted with the
    // wrong workspace, or client is routing to the wrong daemon).
    // Without a breadcrumb the daemon's log looks healthy while
    // every client request silently 400s. Limited to authenticated
    // requests by the upstream bearer-token gate, so probing-DoS
    // log noise stays bounded.
    // SECURITY: `err.requested` is derived from the request body
    // (`req.workspaceCwd` → `canonicalizeWorkspace` → here). `path.resolve`
    // + `realpathSync.native` both preserve control characters inside
    // path segments — they only normalize separators / `..` / `.` and
    // walk symlinks. A body like `{"cwd": "/legit/path\nqwen serve:
    // FAKE LOG LINE"}` would otherwise emit two valid-looking daemon
    // log lines, weaponizing line-based log shippers (Splunk / Loki /
    // journald → SIEM). `JSON.stringify` escapes control chars and
    // wraps in quotes so any injection attempt surfaces as
    // visible-as-quoted-noise rather than forged-line. `err.bound` is
    // safe (canonicalized at boot from operator-controlled
    // `--workspace` / `process.cwd()`) but quoted symmetrically for
    // readability.
    writeStderrLine(
      `qwen serve: workspace_mismatch (POST /session): ` +
        `daemon bound to ${JSON.stringify(err.bound)}, ` +
        `rejected ${JSON.stringify(err.requested)}`,
    );
    res.status(400).json({
      error: err.message,
      code: 'workspace_mismatch',
      boundWorkspace: err.bound,
      requestedWorkspace: err.requested,
    });
    return;
  }
  if (err instanceof InvalidSessionScopeError) {
    // Same wire shape as the route-layer 400 (`server.ts` validates
    // body['sessionScope'] before calling the bridge). A direct embed
    // / test caller bypassing the route would otherwise see a generic
    // 500 — the typed translation keeps both layers in agreement so
    // SDK clients can branch on `code` regardless of which layer
    // surfaced the rejection.
    res.status(400).json({
      error: err.message,
      code: 'invalid_session_scope',
    });
    return;
  }
  if (err instanceof InvalidSessionMetadataError) {
    res.status(400).json({
      error: err.message,
      code: 'invalid_metadata',
      field: err.field,
    });
    return;
  }
  if (err instanceof SessionLimitExceededError) {
    // 503 Service Unavailable + `Retry-After` is the canonical
    // "we'd serve you, but we're full right now" shape. The hint
    // is intentionally conservative (5s) because a session that
    // finishes a prompt frees a slot quickly under normal load;
    // a client that backs off too aggressively wastes capacity.
    res.set('Retry-After', '5');
    res.status(503).json({
      error: err.message,
      code: 'session_limit_exceeded',
      limit: err.limit,
      scope: 'workspace',
    });
    return;
  }
  if (err instanceof TotalSessionLimitExceededError) {
    const totalSessionError = err as TotalSessionLimitExceededError & {
      operation?: string;
      workspaceCwd?: string;
      sourceSessionId?: string;
    };
    daemonLog?.warn('total session admission rejected', {
      ...(ctx?.route ? { route: ctx.route } : {}),
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
      limit: totalSessionError.limit,
      scope: totalSessionError.scope,
      ...(totalSessionError.operation
        ? { operation: totalSessionError.operation }
        : {}),
      ...(totalSessionError.workspaceCwd
        ? { workspaceCwd: totalSessionError.workspaceCwd }
        : {}),
      ...(totalSessionError.sourceSessionId
        ? { sourceSessionId: totalSessionError.sourceSessionId }
        : {}),
    });
    res.set('Retry-After', '5');
    res.status(503).json({
      error: err.message,
      code: 'session_limit_exceeded',
      limit: err.limit,
      scope: err.scope,
    });
    return;
  }
  if (err instanceof PromptQueueFullError) {
    res.set('Retry-After', '5');
    res.status(503).json({
      error: err.message,
      code: 'prompt_queue_full',
      sessionId: err.sessionId,
      limit: err.limit,
      pendingCount: err.pendingCount,
    });
    return;
  }
  if (err instanceof RestoreInProgressError) {
    // Match `SessionLimitExceededError`'s 5s hint (above) — the
    // underlying restore can take up to `initTimeoutMs` (default
    // 10s) on the agent side, so a 1s retry hint pushed clients
    // into tight loops that kept hitting the same 409.
    res.set('Retry-After', '5');
    res.status(409).json({
      error: err.message,
      code: 'restore_in_progress',
      sessionId: err.sessionId,
      activeAction: err.activeAction,
      requestedAction: err.requestedAction,
    });
    return;
  }
  if (err instanceof SessionBusyError) {
    res.set('Retry-After', '5');
    res.status(409).json({
      error: err.message,
      code: 'session_busy',
      sessionId: err.sessionId,
    });
    return;
  }
  if (err instanceof InvalidRewindTargetError) {
    res.status(400).json({
      error: err.message,
      code: 'invalid_rewind_target',
      sessionId: err.sessionId,
    });
    return;
  }
  // Errors from the ACP child with `data.errorKind` carry structured
  // error semantics. Map known kinds to stable HTTP status codes.
  if (err && typeof err === 'object') {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === 'object') {
      const kind = (data as { errorKind?: unknown }).errorKind;
      if (kind === 'mcp_budget_would_exceed') {
        const d = data as { serverName?: string };
        res.status(409).json({
          error: errorMessage(err),
          code: 'mcp_budget_would_exceed',
          serverName: d.serverName,
        });
        return;
      }
      if (kind === 'mcp_server_spawn_failed') {
        const d = data as {
          errorKind: string;
          serverName?: string;
          exitCode?: number | null;
          stderr?: string;
          timeout?: boolean;
        };
        res.status(502).json({
          error: errorMessage(err),
          code: 'mcp_server_spawn_failed',
          serverName: d.serverName,
          exitCode: d.exitCode,
          stderr: d.stderr,
          ...(d.timeout !== undefined ? { timeout: d.timeout } : {}),
        });
        return;
      }
      if (kind === 'invalid_config') {
        const d = data as { serverName?: string; reason?: string };
        res.status(400).json({
          error: errorMessage(err),
          code: 'invalid_config',
          serverName: d.serverName,
          reason: d.reason,
        });
        return;
      }
      if (kind === 'acp_channel_unavailable') {
        res.status(503).json({
          error: errorMessage(err),
          code: 'acp_channel_unavailable',
        });
        return;
      }
      if (kind === 'restrictive_sandbox') {
        res.status(403).json({
          error: errorMessage(err),
          code: 'restrictive_sandbox',
        });
        return;
      }
      if (kind === 'directory_not_found') {
        const d = data as { path?: string };
        res.status(400).json({
          error: errorMessage(err),
          code: 'directory_not_found',
          path: d.path,
        });
        return;
      }
      if (kind === 'directory_not_trusted') {
        const d = data as { path?: string };
        res.status(403).json({
          error: errorMessage(err),
          code: 'directory_not_trusted',
          path: d.path,
        });
        return;
      }
      if (kind === 'invalid_transcript_cursor') {
        res.status(400).json({
          error: errorMessage(err),
          code: 'invalid_transcript_cursor',
        });
        return;
      }
      if (kind === 'invalid_transcript_limit') {
        res.status(400).json({
          error: errorMessage(err),
          code: 'invalid_transcript_limit',
        });
        return;
      }
      if (kind === 'transcript_snapshot_unavailable') {
        const d = data as { sessionId?: string };
        res.status(409).json({
          error: errorMessage(err),
          code: 'transcript_snapshot_unavailable',
          ...(d.sessionId ? { sessionId: d.sessionId } : {}),
        });
        return;
      }
      if (kind === 'transcript_too_large') {
        const d = data as {
          sessionId?: string;
          snapshotSize?: number;
          maxBytes?: number;
        };
        res.status(413).json({
          error: errorMessage(err),
          code: 'transcript_too_large',
          ...(d.sessionId ? { sessionId: d.sessionId } : {}),
          ...(typeof d.snapshotSize === 'number'
            ? { snapshotSize: d.snapshotSize }
            : {}),
          ...(typeof d.maxBytes === 'number' ? { maxBytes: d.maxBytes } : {}),
        });
        return;
      }
    }
  }
  // 5xx is the kind of error operators need to see in their daemon log
  // — bridge ENOMEM, agent stack trace, unexpected throw, etc. Without
  // logging here every 500 disappears once the caller consumes the
  // response body. When `daemonLog` is provided, route through the
  // structured daemon logger (which tees to stderr + log file). When
  // absent (tests, direct embeds), fall back to the legacy stderr-only
  // `writeStderrLine` path.
  recordDaemonBridgeError(err);
  const extraContext = bridgeErrorExtraContext(ctx);
  recordDaemonError(undefined, err, {
    ...(ctx?.route ? { 'http.route': ctx.route } : {}),
    ...(ctx?.sessionId ? { 'session.id': ctx.sessionId } : {}),
  });
  emitDaemonLog('Daemon bridge error.', {
    ...(ctx?.route ? { 'http.route': ctx.route } : {}),
    ...(ctx?.sessionId ? { 'session.id': ctx.sessionId } : {}),
    ...extraContext,
    'error.type': err instanceof Error ? err.name : typeof err,
    'error.message': (err instanceof Error ? err.message : String(err)).slice(
      0,
      1024,
    ),
  });
  if (daemonLog) {
    daemonLog.error(
      err instanceof Error ? err.message : String(err),
      err instanceof Error ? err : undefined,
      {
        ...(ctx?.route ? { route: ctx.route } : {}),
        ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
        ...extraContext,
      },
    );
  } else {
    const ctxParts = [
      ctx?.route,
      ctx?.sessionId ? `session=${ctx.sessionId}` : undefined,
      ...Object.entries(extraContext).map(([key, value]) => `${key}=${value}`),
    ].filter(Boolean);
    const ctxStr = ctxParts.length > 0 ? ` (${ctxParts.join(' ')})` : '';
    writeStderrLine(
      `qwen serve: bridge error${ctxStr}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  }
  res.status(500).json(errorPayload(err));
}

/**
 * Coerce an arbitrary thrown value to a useful string. Plain `String(err)`
 * yields `[object Object]` for JSON-RPC-shaped errors (`{code, message,
 * data}`) which are exactly what the ACP SDK forwards from the agent. Try
 * the `message` field first, fall back to JSON-stringify, then `String`.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const maybe = (err as { message?: unknown }).message;
    if (typeof maybe === 'string' && maybe.length > 0) return maybe;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

/**
 * Build the JSON body for a 5xx response. The ACP SDK forwards
 * JSON-RPC-shaped errors like `{code: -32000, message: "Internal error",
 * data: {reason: "model quota exceeded"}}` — discarding `code`/`data`
 * collapses every distinct failure (quota / rate-limit / auth /
 * crash) to the same opaque `"Internal error"` string at the client.
 * Forward both fields so callers can triage from response body alone.
 * `error` stays as the human-readable string for backward compatibility
 * with clients that only consumed `error` in the original shape.
 *
 * BSA0G acknowledged: forwarding `data` verbatim leaks per-error
 * detail (file paths in upstream tool failures, partial API response
 * snippets, etc.) to every authenticated SSE subscriber that
 * observes 5xx responses. In Stage 1's single-user / small-team
 * trust model (every authenticated client is the same human or
 * collaborators they trust) this is acceptable — and the triage
 * value of the rich error is high. Stage 2 multi-tenant deployments
 * will need an opt-in `--redact-errors` flag (or per-deployment
 * policy hook) that strips `data` and replaces it with an
 * error-class identifier.
 */
function errorPayload(err: unknown): {
  error: string;
  code?: unknown;
  data?: unknown;
} {
  const out: { error: string; code?: unknown; data?: unknown } = {
    error: errorMessage(err),
  };
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if ('code' in obj) out.code = obj['code'];
    if ('data' in obj) out.data = obj['data'];
  }
  return out;
}
