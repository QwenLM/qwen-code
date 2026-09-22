// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/src/bridgeTypes.ts
init_esbuild_shims();
function parseBackgroundNotificationTurn(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return void 0;
  const record = value;
  const { turnId, taskId, kind, startedAt } = record;
  if (typeof turnId !== "string" || !turnId || turnId.length > 256 || typeof taskId !== "string" || !taskId || taskId.length > 256 || kind !== "agent" && kind !== "monitor" && kind !== "shell" && kind !== "workflow" || typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt < 0)
    return void 0;
  for (const key of ["toolUseId", "sourceTurnId", "label"]) {
    if (record[key] !== void 0 && (typeof record[key] !== "string" || record[key].length > 4096))
      return void 0;
  }
  return {
    turnId,
    taskId,
    kind,
    startedAt,
    ...record["toolUseId"] !== void 0 ? { toolUseId: record["toolUseId"] } : {},
    ...record["sourceTurnId"] !== void 0 ? { sourceTurnId: record["sourceTurnId"] } : {},
    ...record["label"] !== void 0 ? { label: record["label"] } : {}
  };
}
__name(parseBackgroundNotificationTurn, "parseBackgroundNotificationTurn");
var LOAD_REPLAY_MODE_META_KEY = "qwen.session.loadReplayMode";
var LOAD_REPLAY_META_KEY = "qwen.session.loadReplay";
var LOAD_REPLAY_PAGE_SIZE_META_KEY = "qwen.session.loadReplayPageSize";
var LOAD_REPLAY_HIDE_INHERITED_META_KEY = "qwen.session.loadReplayHideInherited";
var LOAD_REPLAY_BULK_MODE = "bulk";
var LOAD_REPLAY_VERSION = 1;
var LOAD_REPLAY_MAX_BYTES = 32 * 1024 * 1024;
var LOAD_REPLAY_MAX_UPDATES = 1e4;
var REQUESTED_SESSION_ID_META_KEY = "qwen-code/sessionId";
var SESSION_INITIALIZATION_DEADLINE_META_KEY = "qwen.daemon.sessionInitializationDeadlineMs";
var SESSION_INITIALIZATION_TIMEOUT_ERROR_KIND = "session_initialization_timeout";
var SESSION_MODEL_PERSIST_DEFAULT_META_KEY = "qwen.session.modelPersistDefault";
var CHANNEL_STARTUP_PROFILE_META_KEY = "qwen.daemon.channelStartupProfile";
var CHANNEL_STARTUP_PROFILE_VERSION = 1;
var CHANNEL_LIVENESS_META_KEY = "qwen.daemon.channelLiveness";
var CHANNEL_LIVENESS_VERSION = 1;
var ACTIVE_WORK_HEARTBEAT_META_KEY = "qwen.daemon.activeWorkHeartbeat";
var ACTIVE_WORK_HEARTBEAT_VERSION = 1;
var ACTIVE_WORK_HEARTBEAT_INTERVAL_MS = 15e3;
var ACTIVE_WORK_HEARTBEAT_MIN_INTERVAL_MS = 5e3;
var ACTIVE_WORK_HEARTBEAT_MAX_INTERVAL_MS = 6e4;
var ACTIVE_WORK_STALE_INTERVALS = 3;
var ACTIVE_WORK_NOTIFICATION_METHOD = "qwen/notify/channel/active-work";
var ACTIVE_WORK_CLOSE_IF_UNHELD_PARAM = "onlyIfUnheld";
var ACTIVE_WORK_CLOSE_TIMEOUT_MS = 1e4;
function sessionCloseDrainBudgetMs(outerWaitMs) {
  return Math.max(1, Math.floor(outerWaitMs * 0.8));
}
__name(sessionCloseDrainBudgetMs, "sessionCloseDrainBudgetMs");
var ACTIVE_WORK_CLOSE_RETRY_GRACE = 1;
var ACTIVE_WORK_CLOSE_RETRY_BASE_MS = 6e4;
var ACTIVE_WORK_CLOSE_RETRY_CEILING_MS = 36e5;
function activeWorkCloseRetryDelayMs(failures) {
  if (failures <= ACTIVE_WORK_CLOSE_RETRY_GRACE) return null;
  const exponent = failures - ACTIVE_WORK_CLOSE_RETRY_GRACE - 1;
  return Math.min(
    ACTIVE_WORK_CLOSE_RETRY_BASE_MS * 2 ** exponent,
    ACTIVE_WORK_CLOSE_RETRY_CEILING_MS
  );
}
__name(activeWorkCloseRetryDelayMs, "activeWorkCloseRetryDelayMs");
var ACTIVE_WORK_MAX_SNAPSHOT_SESSIONS = 1024;
var ACTIVE_WORK_MAX_SESSION_HOLDS = 1024;
var WORKTREE_MCP_DEFER_META_KEY = "qwen.session.deferMcpDiscovery";
var ACTIVE_WORK_LEGACY_HOLD_CATEGORIES = ["agent", "notification"];
var ACTIVE_WORK_HOLD_CATEGORIES = [
  "agent",
  "notification",
  "shell",
  "session",
  "workflow"
];
function clampActiveWorkIntervalMs(raw) {
  const value = typeof raw === "number" && Number.isFinite(raw) ? raw : NaN;
  if (Number.isNaN(value)) return ACTIVE_WORK_HEARTBEAT_INTERVAL_MS;
  return Math.min(
    ACTIVE_WORK_HEARTBEAT_MAX_INTERVAL_MS,
    Math.max(ACTIVE_WORK_HEARTBEAT_MIN_INTERVAL_MS, Math.round(value))
  );
}
__name(clampActiveWorkIntervalMs, "clampActiveWorkIntervalMs");
function gradeActiveWorkCoverage(totals) {
  if (totals.total === 0 || totals.covered === totals.total) return "full";
  return totals.onNegotiatedChannel === 0 ? "none" : "partial";
}
__name(gradeActiveWorkCoverage, "gradeActiveWorkCoverage");
var DAEMON_MODEL_PROMPT_META_KEY = "qwen.daemon.modelPrompt";
var DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY = "qwen.daemon.restoreAskUserQuestion";
var DAEMON_PERMISSION_CANCEL_REASON_META_KEY = "qwen.daemon.permissionCancelReason";
var DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY = "qwen.daemon.suppressRestoreAskUserQuestion";
var DAEMON_SUPPRESS_WORKTREE_CONTEXT_RESTORE_META_KEY = "qwen.daemon.suppressWorktreeContextRestore";
var DAEMON_ATTACHMENT_REFERENCES_META_KEY = "qwen.daemon.attachmentReferences";
var MAX_TRUSTED_MODEL_PROMPT_CHARS = 64 * 1024;
function isValidTrustedModelPrompt(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TRUSTED_MODEL_PROMPT_CHARS;
}
__name(isValidTrustedModelPrompt, "isValidTrustedModelPrompt");
var DAEMON_CHANNEL_DELIVERY_META_KEY = "qwen.daemon.channelDelivery";
var SUBMITTED_PROMPT_META_KEY = "qwen.submittedPrompt";
var DAEMON_SUBMITTED_PROMPT_META_KEY = "qwen.daemon.submittedPrompt";
var DAEMON_PROMPT_DISPLAY_TEXT_META_KEY = "qwen.daemon.promptDisplayText";
var CHANNEL_PROMPT_META_KEY = "qwen.channel.prompt";
var CHANNEL_OUTPUT_MODE_META_KEY = "qwen.channel.outputMode";
var MID_TURN_QUEUE_DRAIN_METHOD = "craft/drainMidTurnQueue";
var MID_TURN_RECONCILIATION_RING_SIZE = 200;
var TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD = "craft/claimTodoStopGuardContinuation";
var TODO_STOP_GUARD_QUEUE_RELEASE_METHOD = "craft/todoStopGuardQueueReleased";
var PROMPT_CANCEL_METHOD = "craft/cancelPendingPrompt";
var CLIENT_MCP_OVER_WS_CONFIG_FLAG = "__clientMcpOverWs";

export {
  parseBackgroundNotificationTurn,
  LOAD_REPLAY_MODE_META_KEY,
  LOAD_REPLAY_META_KEY,
  LOAD_REPLAY_PAGE_SIZE_META_KEY,
  LOAD_REPLAY_HIDE_INHERITED_META_KEY,
  LOAD_REPLAY_BULK_MODE,
  LOAD_REPLAY_VERSION,
  LOAD_REPLAY_MAX_BYTES,
  LOAD_REPLAY_MAX_UPDATES,
  REQUESTED_SESSION_ID_META_KEY,
  SESSION_INITIALIZATION_DEADLINE_META_KEY,
  SESSION_INITIALIZATION_TIMEOUT_ERROR_KIND,
  SESSION_MODEL_PERSIST_DEFAULT_META_KEY,
  CHANNEL_STARTUP_PROFILE_META_KEY,
  CHANNEL_STARTUP_PROFILE_VERSION,
  CHANNEL_LIVENESS_META_KEY,
  CHANNEL_LIVENESS_VERSION,
  ACTIVE_WORK_HEARTBEAT_META_KEY,
  ACTIVE_WORK_HEARTBEAT_VERSION,
  ACTIVE_WORK_HEARTBEAT_INTERVAL_MS,
  ACTIVE_WORK_STALE_INTERVALS,
  ACTIVE_WORK_NOTIFICATION_METHOD,
  ACTIVE_WORK_CLOSE_IF_UNHELD_PARAM,
  ACTIVE_WORK_CLOSE_TIMEOUT_MS,
  sessionCloseDrainBudgetMs,
  activeWorkCloseRetryDelayMs,
  ACTIVE_WORK_MAX_SNAPSHOT_SESSIONS,
  ACTIVE_WORK_MAX_SESSION_HOLDS,
  WORKTREE_MCP_DEFER_META_KEY,
  ACTIVE_WORK_LEGACY_HOLD_CATEGORIES,
  ACTIVE_WORK_HOLD_CATEGORIES,
  clampActiveWorkIntervalMs,
  gradeActiveWorkCoverage,
  DAEMON_MODEL_PROMPT_META_KEY,
  DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY,
  DAEMON_PERMISSION_CANCEL_REASON_META_KEY,
  DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY,
  DAEMON_SUPPRESS_WORKTREE_CONTEXT_RESTORE_META_KEY,
  DAEMON_ATTACHMENT_REFERENCES_META_KEY,
  isValidTrustedModelPrompt,
  DAEMON_CHANNEL_DELIVERY_META_KEY,
  SUBMITTED_PROMPT_META_KEY,
  DAEMON_SUBMITTED_PROMPT_META_KEY,
  DAEMON_PROMPT_DISPLAY_TEXT_META_KEY,
  CHANNEL_PROMPT_META_KEY,
  CHANNEL_OUTPUT_MODE_META_KEY,
  MID_TURN_QUEUE_DRAIN_METHOD,
  MID_TURN_RECONCILIATION_RING_SIZE,
  TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD,
  TODO_STOP_GUARD_QUEUE_RELEASE_METHOD,
  PROMPT_CANCEL_METHOD,
  CLIENT_MCP_OVER_WS_CONFIG_FLAG
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
