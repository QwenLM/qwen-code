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
 * Lifted from `packages/cli/src/serve/httpAcpBridge.ts` in #4175 PR
 * 22b/1 so the bridge package owns the error contract directly. The
 * 7 error classes server.ts imports + 1 each from workspaceAgents.ts
 * and workspaceMemory.ts continue to resolve through the
 * httpAcpBridge.ts re-export shim.
 */

import { MAX_WORKSPACE_PATH_LENGTH } from './workspacePaths.js';

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
 * Thrown by `spawnOrAttach` when the requested `workspaceCwd` doesn't
 * canonicalize to the daemon's bound workspace. Per #3803 §02 every
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
 * T1.3 (#4514). Thrown by `bridge.compressSession` when another compress
 * call is already mid-flight on the same session. The chat history is
 * single-threaded; two concurrent compress calls would race the
 * `setHistory` write inside `GeminiChat.tryCompress` (which
 * `GeminiClient.tryCompressChat` invokes). Routes map this to HTTP 409
 * with code `compaction_in_flight` so the caller can distinguish
 * "concurrent compress" from "concurrent prompt" (`PromptInFlightError`)
 * — both are 409 but require different remediation by the client.
 */
export class CompactionInFlightError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(
      `Compress on session ${sessionId}: another compress is already ` +
        'mid-flight on this session.',
    );
    this.name = 'CompactionInFlightError';
    this.sessionId = sessionId;
  }
}

/**
 * T1.3 (#4514, PR #4516 review I1). Thrown by `bridge.compressSession`
 * when the ACP child reports a `*_FAILED_*` compaction status (the
 * agent's `tryCompressChat` translates the core `CompressionStatus`
 * enum to a string and re-raises as `RequestError(-32004, …,
 * {errorKind: 'compress_failed'})`). The bridge catches the JSON-RPC
 * shape on the wire and reconstructs THIS typed class so the route
 * layer can pattern-match with `instanceof` and map to a stable
 * `500 {code: 'compress_failed', compressionStatus}` response
 * (mirrors the `TrustGateError` reconstruction at the same site).
 *
 * Without this typed reconstruction, the catch-all 500 in
 * `sendBridgeError` would surface the JSON-RPC error verbatim
 * (`code: -32004`), breaking the documented wire shape and SDK
 * consumers that branch on `body.code === 'compress_failed'`.
 *
 * `compressionStatus` carries the specific failure flavor (e.g.,
 * `'COMPRESSION_FAILED_INFLATED_TOKEN_COUNT'`) when the agent
 * provides it; falls back to `'UNKNOWN'` for non-enum values.
 */
export class CompressFailedError extends Error {
  readonly sessionId: string;
  readonly compressionStatus: string;
  constructor(sessionId: string, compressionStatus: string, message?: string) {
    super(
      message ??
        `Compress on session ${sessionId} failed with status ${compressionStatus}.`,
    );
    this.name = 'CompressFailedError';
    this.sessionId = sessionId;
    this.compressionStatus = compressionStatus;
  }
}

/**
 * T1.3 (#4514). Thrown by `bridge.compressSession` when a prompt is
 * active on the session (`entry.activePromptOriginatorClientId` is set).
 * The agent's own `sendMessageStream` calls `tryCompress(force=false)`
 * as a pre-send threshold gate; overlapping a daemon-driven compress
 * with that path would race two concurrent compresses against the same
 * chat object — once at the agent's pre-send gate, once from the daemon
 * extMethod handler. Routes map this to HTTP 409 with code
 * `prompt_in_flight`.
 *
 * v1 limitation: this only fences compress START. A prompt that STARTS
 * after the daemon's `compressInFlight` flag is set can still trigger
 * the agent's pre-send `tryCompress`; in practice that path either
 * NOOPs (history already compressed) or re-compresses to the same
 * result. Hard prompt-side serialization is deferred to a follow-up.
 */
export class PromptInFlightError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(
      `Compress on session ${sessionId}: a prompt is currently active. ` +
        'Daemon-driven compress is refused while a prompt is in flight to ' +
        "avoid racing the agent's own pre-send tryCompress call.",
    );
    this.name = 'PromptInFlightError';
    this.sessionId = sessionId;
  }
}

/**
 * T1.4 (#4514). Thrown by `bridge.setSessionMeta` when a key in the
 * incoming `meta` bag fails the validation regex
 * `^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$`. Routes map this to HTTP 400 with
 * code `invalid_meta_key`.
 */
export class InvalidMetaKeyError extends Error {
  readonly sessionId: string;
  readonly key: string;
  constructor(sessionId: string, key: string) {
    super(
      `Session ${sessionId} _meta: key "${key}" does not match the ` +
        'allowed pattern (alphanumeric + dot/underscore/dash, ' +
        '1–64 chars, must start with a letter).',
    );
    this.name = 'InvalidMetaKeyError';
    this.sessionId = sessionId;
    this.key = key;
  }
}

/**
 * T1.4 (#4514). Thrown by `bridge.setSessionMeta` when a key in the
 * incoming `meta` bag starts with the reserved `qwen.` prefix.
 * Reserved for future daemon-owned keys (e.g. `qwen.lastSeenAt`,
 * `qwen.audit.*`); rejecting client writes today keeps the namespace
 * clean. Routes map this to HTTP 400 with code `reserved_meta_key`.
 */
export class ReservedMetaKeyError extends Error {
  readonly sessionId: string;
  readonly key: string;
  constructor(sessionId: string, key: string) {
    super(
      `Session ${sessionId} _meta: key "${key}" starts with the reserved ` +
        '"qwen." prefix. This namespace is reserved for daemon-owned keys.',
    );
    this.name = 'ReservedMetaKeyError';
    this.sessionId = sessionId;
    this.key = key;
  }
}

/**
 * T1.4 (#4514). Thrown by `bridge.setSessionMeta` when the resulting
 * serialized bag would exceed the per-session size cap (8 KB). Routes
 * map this to HTTP 413 with code `meta_too_large`.
 */
export class MetaTooLargeError extends Error {
  readonly sessionId: string;
  readonly byteSize: number;
  readonly limitBytes: number;
  constructor(sessionId: string, byteSize: number, limitBytes: number) {
    super(
      `Session ${sessionId} _meta: serialized size ${byteSize} bytes ` +
        `exceeds the per-session cap of ${limitBytes} bytes.`,
    );
    this.name = 'MetaTooLargeError';
    this.sessionId = sessionId;
    this.byteSize = byteSize;
    this.limitBytes = limitBytes;
  }
}

/**
 * #4175 F3. Thrown by `MultiClientPermissionMediator.vote` when the
 * active policy is wired into the schema/registry but the mediator
 * implementation has not been built yet.
 *
 * **Currently unreachable in production** — F3 Commit 4 implemented
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
 * #4175 F3 Commit 1. Thrown by `MultiClientPermissionMediator.request`
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
 * #4175 F3 Commit 2. Thrown by `bridge.respondToSessionPermission` /
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
 * #4175 Wave 4 PR 17. Thrown by `initWorkspace` when the target file
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
 * #4297 fold-in 1 (16:32:44-round S1). Thrown by `initWorkspace` when
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
 * #4297 fold-in 1 (16:32:44-round S1). Thrown by `initWorkspace` when
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
 * #4297 fold-in 10 (qwen-latest, addresses #3263954690). Thrown by
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
 * #4282 fold-in 1 (gpt-5.5 C5). Thrown by `restartMcpServer` when the
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
 * #4282 fold-in 1 (gpt-5.5 C4). Thrown by `restartMcpServer` when
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
