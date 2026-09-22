// Force strict mode and setup for ESM
"use strict";
import {
  MAX_WORKSPACE_PATH_LENGTH
} from "./chunk-6PLDPT2C.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/src/bridgeErrors.ts
init_esbuild_shims();
var NOT_CURRENTLY_GENERATING_CANCEL_MESSAGE = "Not currently generating";
var AcpChildCapacityExceededError = class extends Error {
  constructor(maxConcurrentChildren, committedAcpChildren) {
    super(
      "The service has reached its concurrent process limit. Try again later or cancel this operation."
    );
    this.maxConcurrentChildren = maxConcurrentChildren;
    this.committedAcpChildren = committedAcpChildren;
  }
  static {
    __name(this, "AcpChildCapacityExceededError");
  }
  name = "AcpChildCapacityExceededError";
  code = "acp_child_capacity_exhausted";
};
var StandaloneSessionSpawnError = class extends Error {
  constructor(dispatched, cause) {
    super("Daemon-owned standalone session creation failed", { cause });
    this.dispatched = dispatched;
  }
  static {
    __name(this, "StandaloneSessionSpawnError");
  }
  name = "StandaloneSessionSpawnError";
};
function isNotCurrentlyGeneratingCancelError(err) {
  if (!err || typeof err !== "object") return false;
  const maybe = err;
  if (isNotCurrentlyGeneratingText(maybe.message)) return true;
  if (!maybe.data || typeof maybe.data !== "object") return false;
  return isNotCurrentlyGeneratingText(
    maybe.data.details
  );
}
__name(isNotCurrentlyGeneratingCancelError, "isNotCurrentlyGeneratingCancelError");
function isNotCurrentlyGeneratingText(value) {
  return typeof value === "string" && /\bnot currently generating\b/i.test(value);
}
__name(isNotCurrentlyGeneratingText, "isNotCurrentlyGeneratingText");
var SessionNotFoundError = class extends Error {
  static {
    __name(this, "SessionNotFoundError");
  }
  sessionId;
  code;
  constructor(sessionId, extra, code = "session_not_found") {
    super(`No session with id "${sessionId}"` + (extra ? `. ${extra}` : ""));
    this.name = "SessionNotFoundError";
    this.sessionId = sessionId;
    this.code = code;
  }
};
var SessionArchivedError = class extends Error {
  static {
    __name(this, "SessionArchivedError");
  }
  sessionId;
  constructor(sessionId) {
    super(`Session "${sessionId}" is archived. Unarchive it before loading.`);
    this.name = "SessionArchivedError";
    this.sessionId = sessionId;
  }
};
var SessionNotArchivedError = class extends Error {
  static {
    __name(this, "SessionNotArchivedError");
  }
  sessionId;
  constructor(sessionId) {
    super(
      `Session "${sessionId}" is active. Archive it before exporting from archived storage.`
    );
    this.name = "SessionNotArchivedError";
    this.sessionId = sessionId;
  }
};
var SessionConflictError = class extends Error {
  static {
    __name(this, "SessionConflictError");
  }
  sessionId;
  constructor(sessionId) {
    super(
      `Session "${sessionId}" exists in both active and archived directories. Delete the session with POST /sessions/delete before loading.`
    );
    this.name = "SessionConflictError";
    this.sessionId = sessionId;
  }
};
var SessionArchivingError = class extends Error {
  static {
    __name(this, "SessionArchivingError");
  }
  sessionId;
  lockKind;
  constructor(sessionId, lockKind = "exclusive") {
    super(
      `Session "${sessionId}" is being archived or unarchived; retry later.`
    );
    this.name = "SessionArchivingError";
    this.sessionId = sessionId;
    this.lockKind = lockKind;
  }
};
var RESTORE_IN_PROGRESS_RETRY_AFTER_SECONDS = 5;
var RestoreInProgressError = class extends Error {
  static {
    __name(this, "RestoreInProgressError");
  }
  sessionId;
  activeAction;
  requestedAction;
  reason;
  retryAfterSeconds;
  constructor(sessionId, activeAction, requestedAction, opts) {
    const reason = opts?.reason ?? "restore_in_progress";
    const retryTarget = requestedAction === "spawn" ? "the spawn" : `session/${requestedAction}`;
    const activeTarget = activeAction === "spawn" ? "a caller-supplied-id spawn" : `session/${activeAction}`;
    super(
      reason === "awaiting_abandoned_cleanup" ? `Session "${sessionId}" timed out during ${activeTarget} and its abandoned registration has not settled yet; retry ${retryTarget} once cleanup completes` : activeAction === "spawn" ? `Session "${sessionId}" is already being registered by ${activeTarget}; retry ${retryTarget} after it completes` : `Session "${sessionId}" is already being restored via ${activeTarget}; retry ${retryTarget} after it completes`
    );
    this.name = "RestoreInProgressError";
    this.sessionId = sessionId;
    this.activeAction = activeAction;
    this.requestedAction = requestedAction;
    this.reason = reason;
    this.retryAfterSeconds = opts?.retryAfterSeconds ?? RESTORE_IN_PROGRESS_RETRY_AFTER_SECONDS;
  }
};
var InvalidSessionScopeError = class extends Error {
  static {
    __name(this, "InvalidSessionScopeError");
  }
  sessionScope;
  constructor(sessionScope) {
    super(
      `Invalid sessionScope: ${JSON.stringify(sessionScope)}. Expected 'single' or 'thread'.`
    );
    this.name = "InvalidSessionScopeError";
    this.sessionScope = sessionScope;
  }
};
var SessionLimitExceededError = class extends Error {
  static {
    __name(this, "SessionLimitExceededError");
  }
  limit;
  constructor(limit) {
    super(`Session limit reached (${limit})`);
    this.name = "SessionLimitExceededError";
    this.limit = limit;
  }
};
var TotalSessionLimitExceededError = class extends Error {
  static {
    __name(this, "TotalSessionLimitExceededError");
  }
  limit;
  scope = "total";
  constructor(limit) {
    super(`Total session limit reached (${limit})`);
    this.name = "TotalSessionLimitExceededError";
    this.limit = limit;
  }
};
var PromptQueueFullError = class extends Error {
  static {
    __name(this, "PromptQueueFullError");
  }
  limit;
  pendingCount;
  sessionId;
  constructor(limit, pendingCount, sessionId) {
    super(
      `Prompt queue full for session "${sessionId}" (${pendingCount}/${limit} pending)`
    );
    this.name = "PromptQueueFullError";
    this.limit = limit;
    this.pendingCount = pendingCount;
    this.sessionId = sessionId;
  }
};
var PromptDeadlineExceededError = class extends Error {
  static {
    __name(this, "PromptDeadlineExceededError");
  }
  deadlineMs;
  constructor(deadlineMs) {
    super(`prompt exceeded the ${deadlineMs}ms deadline`);
    this.name = "PromptDeadlineExceededError";
    this.deadlineMs = deadlineMs;
  }
};
var WorkspaceMismatchError = class extends Error {
  static {
    __name(this, "WorkspaceMismatchError");
  }
  bound;
  requested;
  constructor(bound, requested) {
    const safeRequested = requested.length > MAX_WORKSPACE_PATH_LENGTH ? `${requested.slice(0, MAX_WORKSPACE_PATH_LENGTH)}\u2026[truncated]` : requested;
    super(
      `Workspace mismatch: runtime is bound to "${bound}" but request asked for "${safeRequested}". Select a registered runtime for "${safeRequested}" or register it before retrying; this bridge will not fall back to the primary workspace.`
    );
    this.name = "WorkspaceMismatchError";
    this.bound = bound;
    this.requested = safeRequested;
  }
};
var InvalidClientIdError = class extends Error {
  static {
    __name(this, "InvalidClientIdError");
  }
  sessionId;
  clientId;
  constructor(sessionId, clientId) {
    super(`Client id "${clientId}" is not registered for session ${sessionId}`);
    this.name = "InvalidClientIdError";
    this.sessionId = sessionId;
    this.clientId = clientId;
  }
};
var SessionShellDisabledError = class extends Error {
  static {
    __name(this, "SessionShellDisabledError");
  }
  constructor() {
    super("Direct session shell is disabled for this daemon");
    this.name = "SessionShellDisabledError";
  }
};
var SessionShellClientRequiredError = class extends Error {
  static {
    __name(this, "SessionShellClientRequiredError");
  }
  constructor() {
    super("Direct session shell requires a session-bound client id");
    this.name = "SessionShellClientRequiredError";
  }
};
var InvalidPermissionOptionError = class extends Error {
  static {
    __name(this, "InvalidPermissionOptionError");
  }
  requestId;
  optionId;
  constructor(requestId, optionId) {
    super(
      `Permission ${requestId}: optionId "${optionId}" is not in the set of options the agent offered.`
    );
    this.name = "InvalidPermissionOptionError";
    this.requestId = requestId;
    this.optionId = optionId;
  }
};
var InvalidSessionMetadataError = class extends Error {
  static {
    __name(this, "InvalidSessionMetadataError");
  }
  field;
  constructor(field, reason) {
    super(`Invalid session metadata: ${field} ${reason}`);
    this.name = "InvalidSessionMetadataError";
    this.field = field;
  }
};
var PermissionPolicyNotImplementedError = class extends Error {
  static {
    __name(this, "PermissionPolicyNotImplementedError");
  }
  policy;
  constructor(policy) {
    super(
      `Permission policy "${policy}" is declared in the contract but not yet implemented in this daemon build.`
    );
    this.name = "PermissionPolicyNotImplementedError";
    this.policy = policy;
  }
};
var CancelSentinelCollisionError = class extends Error {
  static {
    __name(this, "CancelSentinelCollisionError");
  }
  requestId;
  sentinel;
  constructor(requestId, sentinel) {
    super(
      `Permission ${requestId}: agent-declared optionId set contains the cancel-vote sentinel "${sentinel}", which would prevent the daemon from disambiguating cancel intent from a real vote.`
    );
    this.name = "CancelSentinelCollisionError";
    this.requestId = requestId;
    this.sentinel = sentinel;
  }
};
var PermissionForbiddenError = class extends Error {
  static {
    __name(this, "PermissionForbiddenError");
  }
  requestId;
  sessionId;
  reason;
  constructor(requestId, sessionId, reason) {
    super(
      `Permission ${requestId} on session ${sessionId}: vote rejected by policy (${reason}).`
    );
    this.name = "PermissionForbiddenError";
    this.requestId = requestId;
    this.sessionId = sessionId;
    this.reason = reason;
  }
};
var WorkspaceInitConflictError = class extends Error {
  static {
    __name(this, "WorkspaceInitConflictError");
  }
  path;
  existingSize;
  constructor(path, existingSize) {
    super(
      `Workspace file ${path} already exists (${existingSize} bytes); pass {force: true} to overwrite.`
    );
    this.name = "WorkspaceInitConflictError";
    this.path = path;
    this.existingSize = existingSize;
  }
};
var WorkspaceInitPathEscapeError = class extends Error {
  static {
    __name(this, "WorkspaceInitPathEscapeError");
  }
  filename;
  boundWorkspace;
  constructor(filename, boundWorkspace) {
    super(
      `Configured workspace context filename ${JSON.stringify(filename)} resolves outside the bound workspace ${JSON.stringify(boundWorkspace)}. Refusing to write.`
    );
    this.name = "WorkspaceInitPathEscapeError";
    this.filename = filename;
    this.boundWorkspace = boundWorkspace;
  }
};
var WorkspaceInitSymlinkError = class extends Error {
  static {
    __name(this, "WorkspaceInitSymlinkError");
  }
  target;
  kind;
  constructor(target, kind, detail) {
    super(detail);
    this.name = "WorkspaceInitSymlinkError";
    this.target = target;
    this.kind = kind;
  }
};
var WorkspaceInitRaceError = class extends Error {
  static {
    __name(this, "WorkspaceInitRaceError");
  }
  target;
  kind;
  constructor(target, kind, detail) {
    super(detail);
    this.name = "WorkspaceInitRaceError";
    this.target = target;
    this.kind = kind;
  }
};
var McpServerNotFoundError = class extends Error {
  static {
    __name(this, "McpServerNotFoundError");
  }
  serverName;
  constructor(serverName) {
    super(`MCP server not configured: ${JSON.stringify(serverName)}`);
    this.name = "McpServerNotFoundError";
    this.serverName = serverName;
  }
};
var McpServerRestartFailedError = class extends Error {
  static {
    __name(this, "McpServerRestartFailedError");
  }
  serverName;
  mcpStatus;
  constructor(serverName, mcpStatus) {
    super(
      `MCP server ${JSON.stringify(serverName)} did not reach a connected state after restart (status: ${mcpStatus}).`
    );
    this.name = "McpServerRestartFailedError";
    this.serverName = serverName;
    this.mcpStatus = mcpStatus;
  }
};
var SessionBusyError = class extends Error {
  static {
    __name(this, "SessionBusyError");
  }
  sessionId;
  constructor(sessionId, message) {
    super(message ?? `Session ${sessionId} is busy (prompt running)`);
    this.name = "SessionBusyError";
    this.sessionId = sessionId;
  }
};
var WorkspaceDrainingError = class extends Error {
  static {
    __name(this, "WorkspaceDrainingError");
  }
  code = "workspace_draining";
  workspaceCwd;
  cause;
  constructor(workspaceCwd, cause) {
    super(`Workspace ${JSON.stringify(workspaceCwd)} is being removed`);
    this.name = "WorkspaceDrainingError";
    this.workspaceCwd = workspaceCwd;
    this.cause = cause;
  }
};
var BridgeChannelQuarantinedError = class extends Error {
  static {
    __name(this, "BridgeChannelQuarantinedError");
  }
  reason;
  /**
   * How long the caller should wait before retrying fresh session work. The
   * operation-budget-derived hint avoids polling these longer-lived states at
   * the ordinary 5-second cadence.
   */
  retryAfterSeconds;
  constructor(reason = "restore_cleanup_failed", retryAfterSeconds = RESTORE_IN_PROGRESS_RETRY_AFTER_SECONDS) {
    super(
      reason === "restore_settlement_overdue" ? "The ACP channel is unavailable for new sessions while an abandoned session restore has not settled" : reason === "new_session_settlement_overdue" ? "The ACP channel is unavailable for new sessions while an abandoned session initialization has not settled" : reason === "new_session_cleanup_failed" ? "The ACP channel is unavailable for new sessions while timed-out session initialization cleanup is pending" : "The ACP channel is unavailable for new sessions while timed-out restore cleanup is pending"
    );
    this.name = "BridgeChannelQuarantinedError";
    this.reason = reason;
    this.retryAfterSeconds = retryAfterSeconds;
  }
};
var InvalidRewindTargetError = class extends Error {
  static {
    __name(this, "InvalidRewindTargetError");
  }
  sessionId;
  constructor(sessionId, message) {
    super(
      message ?? `Cannot rewind to the requested turn (compressed or does not exist)`
    );
    this.name = "InvalidRewindTargetError";
    this.sessionId = sessionId;
  }
};
var BranchWhilePromptActiveError = class extends Error {
  static {
    __name(this, "BranchWhilePromptActiveError");
  }
  sessionId;
  constructor(sessionId) {
    super(`Cannot branch session ${sessionId}: a prompt is currently active`);
    this.name = "BranchWhilePromptActiveError";
    this.sessionId = sessionId;
  }
};
var CdWhilePromptActiveError = class extends Error {
  static {
    __name(this, "CdWhilePromptActiveError");
  }
  sessionId;
  constructor(sessionId) {
    super(
      `Cannot change directory for session ${sessionId}: a prompt is currently active`
    );
    this.name = "CdWhilePromptActiveError";
    this.sessionId = sessionId;
  }
};
var SessionResetPendingError = class extends Error {
  static {
    __name(this, "SessionResetPendingError");
  }
  sessionId;
  constructor(sessionId) {
    super(
      `Session ${sessionId} is mid worktree reset; prompt admission is closed until the reset completes`
    );
    this.name = "SessionResetPendingError";
    this.sessionId = sessionId;
  }
};
var McpAuthenticationInProgressError = class extends Error {
  static {
    __name(this, "McpAuthenticationInProgressError");
  }
  constructor() {
    super("Another MCP authentication is already in progress");
    this.name = "McpAuthenticationInProgressError";
  }
};

export {
  NOT_CURRENTLY_GENERATING_CANCEL_MESSAGE,
  AcpChildCapacityExceededError,
  StandaloneSessionSpawnError,
  isNotCurrentlyGeneratingCancelError,
  SessionNotFoundError,
  SessionArchivedError,
  SessionNotArchivedError,
  SessionConflictError,
  SessionArchivingError,
  RestoreInProgressError,
  InvalidSessionScopeError,
  SessionLimitExceededError,
  TotalSessionLimitExceededError,
  PromptQueueFullError,
  PromptDeadlineExceededError,
  WorkspaceMismatchError,
  InvalidClientIdError,
  SessionShellDisabledError,
  SessionShellClientRequiredError,
  InvalidPermissionOptionError,
  InvalidSessionMetadataError,
  PermissionPolicyNotImplementedError,
  CancelSentinelCollisionError,
  PermissionForbiddenError,
  WorkspaceInitConflictError,
  WorkspaceInitPathEscapeError,
  WorkspaceInitSymlinkError,
  WorkspaceInitRaceError,
  McpServerNotFoundError,
  McpServerRestartFailedError,
  SessionBusyError,
  WorkspaceDrainingError,
  BridgeChannelQuarantinedError,
  InvalidRewindTargetError,
  BranchWhilePromptActiveError,
  CdWhilePromptActiveError,
  SessionResetPendingError,
  McpAuthenticationInProgressError
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
