/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Centralized error taxonomy for ACP bridge operations.
 *
 * Each class is a structurally-distinct subclass of `Error` that the
 * HTTP route layer (and embedded callers) can `instanceof`-branch on
 * to map to a specific status code without text-matching the message.
 * The fields on each class (`sessionId`, `bound`/`requested`, `limit`,
 * etc.) are the structured payload that `sendBridgeError` surfaces in
 * the JSON body, so SDK consumers can render typed prompts (e.g.
 * "session limit reached, retry after N seconds") without parsing
 * free-form text.
 *
 *
 * The bridge package owns the error contract directly. The
 * 7 error classes server.ts imports + 1 each from workspaceAgents.ts
 * and workspaceMemory.ts continue to resolve through the
 * httpAcpBridge.ts re-export shim.
 */

import { MAX_WORKSPACE_PATH_LENGTH } from './workspacePaths.js';

export const NOT_CURRENTLY_GENERATING_CANCEL_MESSAGE =
  'Not currently generating' as const;

/**
 * ACP idle-cancel compatibility contract.
 *
 * The current CLI agent throws `NOT_CURRENTLY_GENERATING_CANCEL_MESSAGE`
 * when a client sends `cancel` while no prompt is active. Older ACP
 * surfaces may wrap that text in either `message` or `data.details`.
 * Treat harmless wording extensions such as
 * "Not currently generating (session idle)" as the same no-op cancel,
 * but keep this matcher narrow so unrelated cancel failures still
 * propagate to callers.
 */
export function isNotCurrentlyGeneratingCancelError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const maybe = err as { message?: unknown; data?: unknown };
  if (isNotCurrentlyGeneratingText(maybe.message)) return true;
  if (!maybe.data || typeof maybe.data !== 'object') return false;
  return isNotCurrentlyGeneratingText(
    (maybe.data as { details?: unknown }).details,
  );
}

function isNotCurrentlyGeneratingText(value: unknown): boolean {
  return (
    typeof value === 'string' && /\bnot currently generating\b/i.test(value)
  );
}

export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, extra?: string) {
    super(`No session with id "${sessionId}"` + (extra ? `. ${extra}` : ''));
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

export class RestoreInProgressError extends Error {
  readonly sessionId: string;
  readonly activeAction: 'load' | 'resume';
  readonly requestedAction: 'load' | 'resume';

  constructor(
    sessionId: string,
    activeAction: 'load' | 'resume',
    requestedAction: 'load' | 'resume',
  ) {
    super(
      `Session "${sessionId}" is already being restored via session/${activeAction}; retry session/${requestedAction} after it completes`,
    );
    this.name = 'RestoreInProgressError';
    this.sessionId = sessionId;
    this.activeAction = activeAction;
    this.requestedAction = requestedAction;
  }
}

/**
 * Thrown by `spawnOrAttach` when `req.sessionScope` is set to a value
 * outside the `'single' | 'thread'` enum. The HTTP route validates the
 * body field at the boundary first (so HTTP callers get a typed
 * `400 invalid_session_scope` before ever reaching the bridge); this
 * class exists for direct callers — tests, embeds, future entry points
 * — and so the route's catch-block can translate it back to the same
 * 400 shape rather than the generic 500 every other thrown `Error`
 * collapses to. Distinct type so routes can branch without
 * text-matching the message.
 */
export class InvalidSessionScopeError extends Error {
  readonly sessionScope: unknown;
  constructor(sessionScope: unknown) {
    super(
      `Invalid sessionScope: ${JSON.stringify(sessionScope)}. ` +
        `Expected 'single' or 'thread'.`,
    );
    this.name = 'InvalidSessionScopeError';
    this.sessionScope = sessionScope;
  }
}

/**
 * Thrown by `spawnOrAttach` when a fresh-spawn would push `sessionCount`
 * past `BridgeOptions.maxSessions`. The HTTP route maps this to 503
 * with a `Retry-After` hint. Attaches (same workspace under `single`
 * scope) never trip this — only NEW children. Distinct error type so
 * routes can branch without text-matching.
 */
export class SessionLimitExceededError extends Error {
  readonly limit: number;
  constructor(limit: number) {
    super(`Session limit reached (${limit})`);
    this.name = 'SessionLimitExceededError';
    this.limit = limit;
  }
}

/**
 * Thrown by `sendPrompt` when a session already has too many accepted
 * prompts waiting or running. The REST route maps this to 503 with
 * `Retry-After`; SDK clients can retry after observing a turn completion.
 */
export class PromptQueueFullError extends Error {
  readonly limit: number;
  readonly pendingCount: number;
  readonly sessionId: string;

  constructor(limit: number, pendingCount: number, sessionId: string) {
    super(
      `Prompt queue full for session "${sessionId}" ` +
        `(${pendingCount}/${limit} pending)`,
    );
    this.name = 'PromptQueueFullError';
    this.limit = limit;
    this.pendingCount = pendingCount;
    this.sessionId = sessionId;
  }
}

/**
 * Thrown by `spawnOrAttach` when the requested `workspaceCwd` doesn't
 * canonicalize to the daemon's bound workspace. Every
 * bridge instance is bound to exactly one workspace; cross-workspace
 * requests are rejected at the daemon boundary. The server route
 * translates this to a 400 response with `code: 'workspace_mismatch'`
 * and both paths in the body so clients can fall through to spawning
 * their own daemon / routing to a different one via an orchestrator.
 */
export class WorkspaceMismatchError extends Error {
  readonly bound: string;
  readonly requested: string;
  constructor(bound: string, requested: string) {
    // Truncate `requested` to PATH_MAX so a malicious or buggy client
    // can't amplify a multi-MB `cwd` body through this error.
    const safeRequested =
      requested.length > MAX_WORKSPACE_PATH_LENGTH
        ? `${requested.slice(0, MAX_WORKSPACE_PATH_LENGTH)}…[truncated]`
        : requested;
    super(
      `Workspace mismatch: daemon is bound to "${bound}" but ` +
        `request asked for "${safeRequested}". Each \`qwen serve\` ` +
        `daemon binds to exactly one workspace; start a separate ` +
        `daemon for "${safeRequested}" (or route the request to one ` +
        `via an orchestrator).`,
    );
    this.name = 'WorkspaceMismatchError';
    this.bound = bound;
    this.requested = safeRequested;
  }
}

/**
 * Thrown when an HTTP caller echoes a client id that this daemon did not
 * issue for the addressed live session. Create/attach calls may receive a
 * fresh id instead; state-changing session routes reject unknown ids so
 * originator metadata stays daemon-stamped rather than caller-asserted.
 */
export class InvalidClientIdError extends Error {
  readonly sessionId: string;
  readonly clientId: string;
  constructor(sessionId: string, clientId: string) {
    super(`Client id "${clientId}" is not registered for session ${sessionId}`);
    this.name = 'InvalidClientIdError';
    this.sessionId = sessionId;
    this.clientId = clientId;
  }
}

/**
 * Thrown by `bridge.respondToPermission` when the voter's
 * `optionId` isn't in the set of options the agent originally
 * offered. Server route catches this and returns 400 (distinct from
 * 404 unknown-requestId).
 */
export class InvalidPermissionOptionError extends Error {
  readonly requestId: string;
  readonly optionId: string;
  constructor(requestId: string, optionId: string) {
    super(
      `Permission ${requestId}: optionId "${optionId}" is not in the ` +
        `set of options the agent offered.`,
    );
    this.name = 'InvalidPermissionOptionError';
    this.requestId = requestId;
    this.optionId = optionId;
  }
}

export class InvalidSessionMetadataError extends Error {
  readonly field: string;
  constructor(field: string, reason: string) {
    super(`Invalid session metadata: ${field} ${reason}`);
    this.name = 'InvalidSessionMetadataError';
    this.field = field;
  }
}

/**
 * Typed error for unimplemented permission policies. Thrown by `MultiClientPermissionMediator.vote` when the
 * active policy is wired into the schema/registry but the mediator
 * implementation has not been built yet.
 *
 * **Currently unreachable in production** — the current code implements
 * all 4 policies in the frozen `PermissionPolicy` union. The class +
 * route-level 501 mapping in `server.ts:sendPermissionVoteError` are
 * RETAINED as forward-compat infrastructure: when a future PR adds a
 * 5th policy literal to `PermissionPolicy` and lands its mediator
 * implementation across multiple commits, the intermediate-build
 * stub can throw this typed error and the operator gets a clean 501
 * instead of a generic 500.
 *
 * Routes map this to HTTP 501 with a structured body so SDK clients
 * can render "your daemon is older than your settings expect;
 * upgrade".
 */
export class PermissionPolicyNotImplementedError extends Error {
  readonly policy: string;
  constructor(policy: string) {
    super(
      `Permission policy "${policy}" is declared in the contract but ` +
        'not yet implemented in this daemon build.',
    );
    this.name = 'PermissionPolicyNotImplementedError';
    this.policy = policy;
  }
}

/**
 * Collision defense. Thrown by `MultiClientPermissionMediator.request`
 * when an agent-declared `allowedOptionIds` set contains the
 * cancel-vote sentinel string. The bridge maps voter cancel intent
 * to that exact `optionId`; if the agent legitimately uses it as
 * an option label, the mediator can no longer disambiguate. We
 * fail loudly at request issue time so the operator sees a clear
 * misconfiguration rather than the silent "voter approval was
 * treated as cancel" semantic flip.
 *
 * Routes map this to HTTP 500 — it represents a contract violation
 * between agent and daemon, not a client mistake.
 */
export class CancelSentinelCollisionError extends Error {
  readonly requestId: string;
  readonly sentinel: string;
  constructor(requestId: string, sentinel: string) {
    super(
      `Permission ${requestId}: agent-declared optionId set contains ` +
        `the cancel-vote sentinel "${sentinel}", which would prevent ` +
        'the daemon from disambiguating cancel intent from a real vote.',
    );
    this.name = 'CancelSentinelCollisionError';
    this.requestId = requestId;
    this.sentinel = sentinel;
  }
}

/**
 * Permission forbidden error. Thrown by `bridge.respondToSessionPermission` /
 * `bridge.respondToPermission` when the active permission policy
 * rejects the vote (designated voter mismatch, or remote vote under
 * `local-only`). The bridge converts the mediator's
 * `PermissionVoteOutcome { kind: 'forbidden', reason: ... }` into
 * this typed error so the route layer can map to HTTP 403 without
 * pattern-matching on the error message.
 *
 * `reason` is forwarded verbatim from the mediator's outcome so SDK
 * clients can render a precise UI ("you weren't designated to
 * approve" vs "this daemon only accepts loopback approvals").
 */
export class PermissionForbiddenError extends Error {
  readonly requestId: string;
  readonly sessionId: string;
  readonly reason: 'designated_mismatch' | 'remote_not_allowed';
  constructor(
    requestId: string,
    sessionId: string,
    reason: 'designated_mismatch' | 'remote_not_allowed',
  ) {
    super(
      `Permission ${requestId} on session ${sessionId}: ` +
        `vote rejected by policy (${reason}).`,
    );
    this.name = 'PermissionForbiddenError';
    this.requestId = requestId;
    this.sessionId = sessionId;
    this.reason = reason;
  }
}

/**
 * Workspace init conflict. Thrown by `initWorkspace` when the target file
 * already exists with non-whitespace content and the caller did not
 * pass `force: true`. Translated to HTTP 409 by the route. The
 * `path` and `existingSize` fields let SDK clients render a clear
 * "file already exists; pass `force: true` to overwrite" prompt
 * without re-stat'ing the workspace.
 */
export class WorkspaceInitConflictError extends Error {
  readonly path: string;
  readonly existingSize: number;
  constructor(path: string, existingSize: number) {
    super(
      `Workspace file ${path} already exists ` +
        `(${existingSize} bytes); pass {force: true} to overwrite.`,
    );
    this.name = 'WorkspaceInitConflictError';
    this.path = path;
    this.existingSize = existingSize;
  }
}

/**
 * Path escape guard. Thrown by `initWorkspace` when
 * the configured `context.fileName` resolves outside the bound
 * workspace via path arithmetic (e.g. `../outside.md`). Translated
 * to HTTP 400 by the route — distinguishable from a generic 500 so
 * an operator sees "your workspace config is wrong" rather than
 * "the daemon is broken." The `filename` and `boundWorkspace`
 * fields let clients display a precise diagnostic.
 */
export class WorkspaceInitPathEscapeError extends Error {
  readonly filename: string;
  readonly boundWorkspace: string;
  constructor(filename: string, boundWorkspace: string) {
    super(
      `Configured workspace context filename ${JSON.stringify(filename)} ` +
        `resolves outside the bound workspace ${JSON.stringify(boundWorkspace)}. ` +
        `Refusing to write.`,
    );
    this.name = 'WorkspaceInitPathEscapeError';
    this.filename = filename;
    this.boundWorkspace = boundWorkspace;
  }
}

/**
 * Path escape guard. Thrown by `initWorkspace` when
 * the target file is itself a symlink, OR when the parent path
 * canonicalizes (via `realpath`) outside the bound workspace.
 * Translated to HTTP 400 by the route — same operator-clarity
 * rationale as `WorkspaceInitPathEscapeError`. `target` is the
 * resolved path the bridge attempted, `kind` distinguishes the two
 * symlink scenarios for diagnostics.
 */
export class WorkspaceInitSymlinkError extends Error {
  readonly target: string;
  readonly kind: 'target' | 'parent';
  constructor(target: string, kind: 'target' | 'parent', detail: string) {
    super(detail);
    this.name = 'WorkspaceInitSymlinkError';
    this.target = target;
    this.kind = kind;
  }
}

/**
 * Race condition guard. Thrown by
 * `initWorkspace` when the target file's inode misbehaved at write
 * time IN A NON-SYMLINK WAY — typically a TOCTOU race against a
 * concurrent writer:
 *   - `'eexist'`: a regular file (or symlink) appeared at the target
 *     path between the absence check and our atomic `'wx'` create.
 *   - `'enoent'`: the target was deleted between the content check
 *     and the `O_NOFOLLOW` overwrite (concurrent git checkout, editor
 *     save, etc.).
 *
 * Split out from `WorkspaceInitSymlinkError` so the HTTP error code
 * isn't misleading: an operator chasing a `workspace_init_race`
 * code knows it's a benign concurrent-modification window, not a
 * symlink attack vector. Same 400 mapping as the sibling class —
 * the route layer still recognizes both.
 */
export class WorkspaceInitRaceError extends Error {
  readonly target: string;
  readonly kind: 'eexist' | 'enoent';
  constructor(target: string, kind: 'eexist' | 'enoent', detail: string) {
    super(detail);
    this.name = 'WorkspaceInitRaceError';
    this.target = target;
    this.kind = kind;
  }
}

/**
 * MCP server not found. Thrown by `restartMcpServer` when the
 * caller asks for a server name that isn't in the daemon's
 * `McpServers` config. Translated to HTTP 404 + structured body by
 * the route — distinguishable from a generic 500 so a bad server
 * name doesn't look like an internal daemon failure.
 */
export class McpServerNotFoundError extends Error {
  readonly serverName: string;
  constructor(serverName: string) {
    super(`MCP server not configured: ${JSON.stringify(serverName)}`);
    this.name = 'McpServerNotFoundError';
    this.serverName = serverName;
  }
}

/**
 * MCP restart failure. Thrown by `restartMcpServer` when
 * `discoverMcpToolsForServer` resolves but the MCP client fails to
 * end up `CONNECTED` post-discover. The manager catches reconnect
 * errors and returns void, so without an explicit post-check the
 * route would report `restarted: true` while the server stays
 * disconnected. Translated to HTTP 502 + `errorKind:
 * 'protocol_error'` by the route.
 */
export class McpServerRestartFailedError extends Error {
  readonly serverName: string;
  readonly mcpStatus: string;
  constructor(serverName: string, mcpStatus: string) {
    super(
      `MCP server ${JSON.stringify(serverName)} did not reach a connected ` +
        `state after restart (status: ${mcpStatus}).`,
    );
    this.name = 'McpServerRestartFailedError';
    this.serverName = serverName;
    this.mcpStatus = mcpStatus;
  }
}

export class SessionBusyError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, message?: string) {
    super(message ?? `Session ${sessionId} is busy (prompt running)`);
    this.name = 'SessionBusyError';
    this.sessionId = sessionId;
  }
}

export class InvalidRewindTargetError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, message?: string) {
    super(
      message ??
        `Cannot rewind to the requested turn (compressed or does not exist)`,
    );
    this.name = 'InvalidRewindTargetError';
    this.sessionId = sessionId;
  }
}

export class BranchWhilePromptActiveError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`Cannot branch session ${sessionId}: a prompt is currently active`);
    this.name = 'BranchWhilePromptActiveError';
    this.sessionId = sessionId;
  }
}
