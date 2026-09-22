// Force strict mode and setup for ESM
"use strict";
import {
  DEFAULT_RING_SIZE,
  EVENT_SCHEMA_VERSION,
  EventBus,
  isSummaryReplayEvent,
  logEventSizingFailed,
  serializedBridgeEventByteLength,
  summarizeReplay,
  summarizeReplayEvent
} from "./chunk-KWYTSSTJ.js";
import {
  JOURNAL_GROWTH_HARD_CAP_BYTES,
  normalizeCompactedReplayMaxBytes,
  normalizeJournalGrowthPoolBytes,
  normalizeMaxJournalBytes,
  normalizeMaxJournalEvents
} from "./chunk-WCCLLK7X.js";
import {
  MCP_RESTART_SERVER_DEADLINE_MS
} from "./chunk-OCPBI7J5.js";
import {
  channelFactoryForwardsChildEnv,
  defaultSpawnChannelFactory
} from "./chunk-YYNEF4AU.js";
import {
  BridgeChannelClosedError,
  BridgeTimeoutError,
  SERVE_CONTROL_EXT_METHODS,
  SERVE_STATUS_EXT_METHODS,
  STATUS_SCHEMA_VERSION,
  SessionRestoreTimeoutError,
  createIdleWorkspaceExtensionsStatus,
  createIdleWorkspaceHooksStatus
} from "./chunk-SIUR4U2P.js";
import {
  ACTIVE_WORK_CLOSE_IF_UNHELD_PARAM,
  ACTIVE_WORK_CLOSE_TIMEOUT_MS,
  ACTIVE_WORK_HEARTBEAT_INTERVAL_MS,
  ACTIVE_WORK_HEARTBEAT_META_KEY,
  ACTIVE_WORK_HEARTBEAT_VERSION,
  ACTIVE_WORK_HOLD_CATEGORIES,
  ACTIVE_WORK_MAX_SESSION_HOLDS,
  ACTIVE_WORK_MAX_SNAPSHOT_SESSIONS,
  ACTIVE_WORK_NOTIFICATION_METHOD,
  ACTIVE_WORK_STALE_INTERVALS,
  CHANNEL_LIVENESS_META_KEY,
  CHANNEL_LIVENESS_VERSION,
  CHANNEL_OUTPUT_MODE_META_KEY,
  CHANNEL_PROMPT_META_KEY,
  CHANNEL_STARTUP_PROFILE_META_KEY,
  CHANNEL_STARTUP_PROFILE_VERSION,
  DAEMON_ATTACHMENT_REFERENCES_META_KEY,
  DAEMON_CHANNEL_DELIVERY_META_KEY,
  DAEMON_MODEL_PROMPT_META_KEY,
  DAEMON_PERMISSION_CANCEL_REASON_META_KEY,
  DAEMON_PROMPT_DISPLAY_TEXT_META_KEY,
  DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY,
  DAEMON_SUBMITTED_PROMPT_META_KEY,
  DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY,
  DAEMON_SUPPRESS_WORKTREE_CONTEXT_RESTORE_META_KEY,
  LOAD_REPLAY_BULK_MODE,
  LOAD_REPLAY_HIDE_INHERITED_META_KEY,
  LOAD_REPLAY_MAX_UPDATES,
  LOAD_REPLAY_META_KEY,
  LOAD_REPLAY_MODE_META_KEY,
  LOAD_REPLAY_PAGE_SIZE_META_KEY,
  LOAD_REPLAY_VERSION,
  MID_TURN_QUEUE_DRAIN_METHOD,
  MID_TURN_RECONCILIATION_RING_SIZE,
  PROMPT_CANCEL_METHOD,
  REQUESTED_SESSION_ID_META_KEY,
  SESSION_INITIALIZATION_DEADLINE_META_KEY,
  SESSION_INITIALIZATION_TIMEOUT_ERROR_KIND,
  SESSION_MODEL_PERSIST_DEFAULT_META_KEY,
  SUBMITTED_PROMPT_META_KEY,
  TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD,
  TODO_STOP_GUARD_QUEUE_RELEASE_METHOD,
  WORKTREE_MCP_DEFER_META_KEY,
  activeWorkCloseRetryDelayMs,
  clampActiveWorkIntervalMs,
  isValidTrustedModelPrompt,
  parseBackgroundNotificationTurn,
  sessionCloseDrainBudgetMs
} from "./chunk-RN6A53UJ.js";
import {
  BranchWhilePromptActiveError,
  BridgeChannelQuarantinedError,
  CancelSentinelCollisionError,
  CdWhilePromptActiveError,
  InvalidClientIdError,
  InvalidPermissionOptionError,
  InvalidRewindTargetError,
  InvalidSessionMetadataError,
  InvalidSessionScopeError,
  McpAuthenticationInProgressError,
  PermissionForbiddenError,
  PromptDeadlineExceededError,
  PromptQueueFullError,
  RestoreInProgressError,
  SessionBusyError,
  SessionLimitExceededError,
  SessionNotFoundError,
  SessionResetPendingError,
  SessionShellClientRequiredError,
  SessionShellDisabledError,
  StandaloneSessionSpawnError,
  WorkspaceMismatchError,
  isNotCurrentlyGeneratingCancelError
} from "./chunk-YXHY6BKS.js";
import {
  canonicalizeWorkspace,
  translateAndCheckAbsoluteWorkspacePath
} from "./chunk-6PLDPT2C.js";
import {
  CHANNEL_DELIVERY_ERROR_CODES,
  LIVE_TASK_TOOL_NAMES,
  MAX_LIVE_SCREEN_CONTEXT_TEXT_CHARS,
  MAX_LIVE_SPEAK_TO_USER_MESSAGE_CHARS,
  MAX_SUB_SESSION_NAME_CHARS
} from "./chunk-UDG5EZJI.js";
import {
  EXTERNAL_TOOL_GUARD_READY_META_KEY,
  EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
  isValidExternalToolGuardDenialReason
} from "./chunk-3VUENPWF.js";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError
} from "./chunk-IJOS26LH.js";
import {
  PRIVATE_CONVERSATIONS_RUNTIME_ENABLE,
  PRIVATE_CONVERSATIONS_RUNTIME_ENV
} from "./chunk-32CM56LO.js";
import {
  MAX_SUB_SESSION_PROMPT_CHARS
} from "./chunk-LJZSMWOH.js";
import {
  MAX_DIRECTORY_ARTIFACT_DEPTH,
  MAX_DIRECTORY_ARTIFACT_FILES,
  collectRecordableWorkspaceFiles,
  isOfficeDocumentExtension,
  isRecordableDerivedChild,
  pathHasSkippedDirectoryComponent
} from "./chunk-FXPP7VLM.js";
import {
  SESSION_PR_LIST_LIMIT,
  SESSION_PR_URL_MAX_LENGTH,
  SESSION_TRANSCRIPT_MAX_LIMIT,
  ShellExecutionService,
  TURN_RESULT_CODE_TEXT_TRUNCATED,
  TURN_RESULT_TEXT_MAX_CHARS,
  TrustGateError,
  canonicalSessionPrUrl,
  normalizeTurnResultError,
  toSessionPrInfo
} from "./chunk-MRTRBONQ.js";
import {
  isUnverifiableIdentityError,
  openNoFollow
} from "./chunk-HEOH7JZY.js";
import {
  PUBLISHED_CONTENT_SHA256_METADATA_KEY,
  SESSION_ARTIFACT_PERSISTENCE_VERSION,
  WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY,
  WORKSPACE_CONTENT_SHA256_METADATA_KEY,
  WORKSPACE_CONTENT_SIZE_BYTES_METADATA_KEY,
  deleteArtifactSnapshot,
  getWebPreviewSnapshotId,
  isAdoptableContentFingerprintKey,
  isPrototypeMetadataKey,
  isReservedWorkspaceMetadataKey,
  metadataBudgetBytes,
  normalizeSnapshotPayload,
  retainArtifactSnapshot,
  stableSessionArtifactId
} from "./chunk-ANKISCKU.js";
import {
  MAX_CRON_TASK_ROUTING_ID_LENGTH,
  isValidCronTaskRoutingId
} from "./chunk-C4FISGDN.js";
import {
  SessionSourceError,
  validateSessionSourceInput
} from "./chunk-ELRMZTPF.js";
import {
  APPROVAL_MODES
} from "./chunk-JX6XHPTX.js";
import {
  DAEMON_TRACEPARENT_META_KEY,
  DAEMON_TRACESTATE_META_KEY
} from "./chunk-GVTAFLWB.js";
import {
  INVOCATION_CONTEXT_META_KEY,
  PRIVATE_ACP_CAPABILITY_ENV,
  PRIVATE_PARENT_CAPABILITY_META_KEY
} from "./chunk-5ETULJLP.js";
import {
  getSpecificMimeType
} from "./chunk-25FMWESU.js";
import {
  Storage
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/src/bridge.ts
init_esbuild_shims();

// packages/acp-bridge/src/channel-harness.ts
init_esbuild_shims();

// packages/acp-bridge/src/channel-connection.ts
init_esbuild_shims();
import { inspect } from "node:util";
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord, "isRecord");
var LogSafeAcpRequestError = class extends RequestError {
  constructor(code, message, data, reservePreparedResponse) {
    super(code, message, data);
    this.reservePreparedResponse = reservePreparedResponse;
  }
  static {
    __name(this, "LogSafeAcpRequestError");
  }
  toResult() {
    const result = super.toResult();
    if ("error" in result) {
      Object.defineProperty(result.error, inspect.custom, {
        configurable: true,
        value: /* @__PURE__ */ __name(() => ({ code: result.error.code, payloadOmitted: true }), "value")
      });
      try {
        this.reservePreparedResponse?.(result.error);
      } catch {
      }
    }
    return result;
  }
};
var MAX_LOG_SAFE_ACP_ERROR_DETAILS_CHARS = 1024;
var MAX_LOG_SAFE_ACP_ERROR_KIND_CHARS = 128;
var MAX_LOG_SAFE_ACP_ERROR_HINT_CHARS = 512;
function logSafeAcpErrorDetails(error) {
  const details = error instanceof Error ? error.message : isRecord(error) && typeof error["message"] === "string" ? error["message"] : void 0;
  if (!details) return void 0;
  return {
    details: details.length <= MAX_LOG_SAFE_ACP_ERROR_DETAILS_CHARS ? details : `${details.slice(0, MAX_LOG_SAFE_ACP_ERROR_DETAILS_CHARS)}\u2026`
  };
}
__name(logSafeAcpErrorDetails, "logSafeAcpErrorDetails");
function boundedAcpErrorString(value, maxChars) {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\u2026`;
}
__name(boundedAcpErrorString, "boundedAcpErrorString");
function logSafeRequestErrorMessage(code) {
  switch (code) {
    case -32700:
      return "Parse error";
    case -32600:
      return "Invalid request";
    case -32601:
      return "Method not found";
    case -32602:
      return "Invalid params";
    case -32603:
      return "Internal error";
    case -32e3:
      return "Authentication required";
    case -32002:
      return "Resource not found";
    default:
      return "ACP client request failed";
  }
}
__name(logSafeRequestErrorMessage, "logSafeRequestErrorMessage");
function logSafeRequestErrorData(data) {
  if (!isRecord(data) || typeof data["errorKind"] !== "string") {
    return void 0;
  }
  const status = data["status"];
  const hint = data["hint"];
  return {
    errorKind: boundedAcpErrorString(
      data["errorKind"],
      MAX_LOG_SAFE_ACP_ERROR_KIND_CHARS
    ),
    ...typeof status === "number" && Number.isFinite(status) ? { status } : {},
    ...typeof hint === "string" ? {
      hint: boundedAcpErrorString(hint, MAX_LOG_SAFE_ACP_ERROR_HINT_CHARS)
    } : {}
  };
}
__name(logSafeRequestErrorData, "logSafeRequestErrorData");
var AcpInboundHandlerLimitError = class extends Error {
  constructor(maxActiveHandlers, maxActiveHandlerBytes, requiredBytes, availableBytes) {
    super("ACP inbound handler capacity exceeded");
    this.maxActiveHandlers = maxActiveHandlers;
    this.maxActiveHandlerBytes = maxActiveHandlerBytes;
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
    this.name = "AcpInboundHandlerLimitError";
  }
  static {
    __name(this, "AcpInboundHandlerLimitError");
  }
  code = "acp_handler_limit_exceeded";
};
function estimateAcpHandlerBytes(value, limitBytes) {
  let bytes = 0;
  const stack = [value];
  const seen = /* @__PURE__ */ new WeakSet();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null) {
      bytes += 4;
    } else if (typeof current === "string") {
      bytes += Buffer.byteLength(current) + 2;
    } else if (typeof current === "number") {
      bytes += 24;
    } else if (typeof current === "boolean") {
      bytes += 5;
    } else if (Array.isArray(current)) {
      if (seen.has(current)) return limitBytes + 1;
      seen.add(current);
      bytes += 2 + Math.max(0, current.length - 1);
      if (bytes + current.length > limitBytes) return limitBytes + 1;
      for (let index = current.length - 1; index >= 0; index--) {
        stack.push(current[index]);
      }
    } else if (isRecord(current)) {
      if (seen.has(current)) return limitBytes + 1;
      seen.add(current);
      const entries = Object.entries(current);
      bytes += 2 + Math.max(0, entries.length - 1);
      for (const [key, entryValue] of entries) {
        bytes += Buffer.byteLength(key) + 3;
        stack.push(entryValue);
      }
    } else {
      bytes += 4;
    }
    if (bytes > limitBytes) return limitBytes + 1;
  }
  return Math.max(1, bytes);
}
__name(estimateAcpHandlerBytes, "estimateAcpHandlerBytes");
var AcpInboundHandlerAdmission = class {
  constructor(guard) {
    this.guard = guard;
  }
  static {
    __name(this, "AcpInboundHandlerAdmission");
  }
  activeHandlers = 0;
  activeBytes = 0;
  async run(params, operation) {
    const envelopeBytes = Math.min(2048, this.guard.maxActiveHandlerBytes);
    const requiredBytes = envelopeBytes + estimateAcpHandlerBytes(
      params,
      Math.max(0, this.guard.maxActiveHandlerBytes - envelopeBytes)
    );
    const availableBytes = Math.max(
      0,
      this.guard.maxActiveHandlerBytes - this.activeBytes
    );
    if (this.activeHandlers >= this.guard.maxActiveHandlers || requiredBytes > availableBytes) {
      const error = new AcpInboundHandlerLimitError(
        this.guard.maxActiveHandlers,
        this.guard.maxActiveHandlerBytes,
        requiredBytes,
        availableBytes
      );
      this.guard.fail(error);
      throw error;
    }
    this.activeHandlers++;
    this.activeBytes += requiredBytes;
    try {
      return await operation();
    } finally {
      this.activeHandlers--;
      this.activeBytes -= requiredBytes;
    }
  }
};
async function withLogSafeAcpError(operation, reservePreparedResponse) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RequestError) {
      const code = Number.isFinite(error.code) ? error.code : -32603;
      throw new LogSafeAcpRequestError(
        code,
        logSafeRequestErrorMessage(code),
        logSafeRequestErrorData(error.data),
        reservePreparedResponse
      );
    }
    throw new LogSafeAcpRequestError(
      -32603,
      "Internal error",
      logSafeAcpErrorDetails(error),
      reservePreparedResponse
    );
  }
}
__name(withLogSafeAcpError, "withLogSafeAcpError");
function createLogSafeAcpClient(client, transportGuard) {
  const admission = new AcpInboundHandlerAdmission(transportGuard);
  const runNotification = /* @__PURE__ */ __name((params, operation) => withLogSafeAcpError(() => admission.run(params, operation)), "runNotification");
  const runRequest = /* @__PURE__ */ __name((params, operation) => withLogSafeAcpError(
    () => admission.run(params, async () => {
      const result = await operation();
      transportGuard.reservePreparedResponse(result ?? null);
      return result;
    }),
    transportGuard.reservePreparedResponse
  ), "runRequest");
  return {
    requestPermission: /* @__PURE__ */ __name((params) => runRequest(params, () => client.requestPermission(params)), "requestPermission"),
    sessionUpdate: /* @__PURE__ */ __name((params) => runNotification(params, () => client.sessionUpdate(params)), "sessionUpdate"),
    writeTextFile: client.writeTextFile ? (params) => runRequest(params, () => client.writeTextFile(params)) : void 0,
    readTextFile: client.readTextFile ? (params) => runRequest(params, () => client.readTextFile(params)) : void 0,
    createTerminal: client.createTerminal ? (params) => runRequest(params, () => client.createTerminal(params)) : void 0,
    terminalOutput: client.terminalOutput ? (params) => runRequest(params, () => client.terminalOutput(params)) : void 0,
    releaseTerminal: client.releaseTerminal ? (params) => runRequest(
      params,
      async () => await client.releaseTerminal(params) ?? {}
    ) : void 0,
    waitForTerminalExit: client.waitForTerminalExit ? (params) => runRequest(params, () => client.waitForTerminalExit(params)) : void 0,
    killTerminal: client.killTerminal ? (params) => runRequest(
      params,
      async () => await client.killTerminal(params) ?? {}
    ) : void 0,
    extMethod: client.extMethod ? (method, params) => runRequest(params, () => client.extMethod(method, params)) : void 0,
    extNotification: client.extNotification ? (method, params) => runNotification(params, () => client.extNotification(method, params)) : void 0
  };
}
__name(createLogSafeAcpClient, "createLogSafeAcpClient");
var OUTBOUND_GUARDED_CONNECTION_METHODS = /* @__PURE__ */ new Set([
  "initialize",
  "newSession",
  "loadSession",
  "unstable_forkSession",
  "unstable_listSessions",
  "unstable_resumeSession",
  "setSessionMode",
  "unstable_setSessionModel",
  "setSessionConfigOption",
  "authenticate",
  "prompt",
  "cancel",
  "extMethod",
  "extNotification"
]);
function createOutboundGuardedConnection(connection, transportGuard) {
  const wrappers = /* @__PURE__ */ new Map();
  return new Proxy(connection, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function" || !OUTBOUND_GUARDED_CONNECTION_METHODS.has(property)) {
        return value;
      }
      let wrapper = wrappers.get(property);
      if (!wrapper) {
        wrapper = /* @__PURE__ */ __name(async (...args) => {
          const release = transportGuard.reserveOutboundOperation(args);
          try {
            return await Reflect.apply(value, target, args);
          } finally {
            release();
          }
        }, "wrapper");
        wrappers.set(property, wrapper);
      }
      return wrapper;
    }
  });
}
__name(createOutboundGuardedConnection, "createOutboundGuardedConnection");
function createHarnessConnection(client, channel) {
  const rawConnection = new ClientSideConnection(
    () => channel.transportGuard ? createLogSafeAcpClient(client, channel.transportGuard) : client,
    channel.stream
  );
  return channel.transportGuard ? createOutboundGuardedConnection(rawConnection, channel.transportGuard) : rawConnection;
}
__name(createHarnessConnection, "createHarnessConnection");

// packages/acp-bridge/src/channel-lifecycle.ts
init_esbuild_shims();
function createChannelLifecycle() {
  let channelInfo;
  const aliveChannels = /* @__PURE__ */ new Set();
  let inFlightChannelSpawn;
  return {
    get current() {
      return channelInfo;
    },
    get starting() {
      return inFlightChannelSpawn;
    },
    get size() {
      return aliveChannels.size;
    },
    has(info) {
      return aliveChannels.has(info);
    },
    values() {
      return aliveChannels.values();
    },
    track(info) {
      aliveChannels.add(info);
    },
    publish(info) {
      channelInfo = info;
    },
    remove(info) {
      aliveChannels.delete(info);
      if (channelInfo === info) channelInfo = void 0;
    },
    startSpawn(spawn) {
      return inFlightChannelSpawn ??= spawn();
    },
    finishSpawn() {
      inFlightChannelSpawn = void 0;
    }
  };
}
__name(createChannelLifecycle, "createChannelLifecycle");

// packages/acp-bridge/src/channel-startup.ts
init_esbuild_shims();
import { randomBytes, randomUUID } from "node:crypto";

// packages/acp-bridge/src/channel-handshake.ts
init_esbuild_shims();
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord2, "isRecord");
function createChannelInitializeRequest(privateParentCapability, delegateReadTextFileToClient) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    _meta: {
      [ACTIVE_WORK_HEARTBEAT_META_KEY]: {
        v: ACTIVE_WORK_HEARTBEAT_VERSION,
        intervalMs: ACTIVE_WORK_HEARTBEAT_INTERVAL_MS,
        categories: [...ACTIVE_WORK_HOLD_CATEGORIES]
      },
      [CHANNEL_STARTUP_PROFILE_META_KEY]: {
        v: CHANNEL_STARTUP_PROFILE_VERSION
      },
      [CHANNEL_LIVENESS_META_KEY]: {
        v: CHANNEL_LIVENESS_VERSION
      },
      [PRIVATE_PARENT_CAPABILITY_META_KEY]: privateParentCapability
    },
    clientCapabilities: {
      _meta: { "qwen.goalProposals": true },
      fs: {
        readTextFile: delegateReadTextFileToClient,
        writeTextFile: true
      }
    },
    clientInfo: { name: "qwen-serve-bridge", version: "0" }
  };
}
__name(createChannelInitializeRequest, "createChannelInitializeRequest");
function negotiateChannelCapabilities(response, requireExternalToolGuard) {
  if (requireExternalToolGuard) {
    const guardAck = response._meta?.[EXTERNAL_TOOL_GUARD_READY_META_KEY];
    if (guardAck !== EXTERNAL_TOOL_GUARD_REQUIRED_VALUE) {
      throw new Error(
        `ACP child did not acknowledge the required external tool guard (received: ${JSON.stringify(guardAck)}).`
      );
    }
  }
  let activeWork;
  const activeWorkCapability = isRecord2(response._meta) ? response._meta[ACTIVE_WORK_HEARTBEAT_META_KEY] : void 0;
  if (isRecord2(activeWorkCapability) && activeWorkCapability["v"] === ACTIVE_WORK_HEARTBEAT_VERSION) {
    const advertised = activeWorkCapability["categories"];
    activeWork = {
      intervalMs: clampActiveWorkIntervalMs(activeWorkCapability["intervalMs"]),
      categories: Array.isArray(advertised) ? ACTIVE_WORK_HOLD_CATEGORIES.filter(
        (category) => advertised.includes(category)
      ) : []
    };
  }
  const channelLivenessCapability = isRecord2(response._meta) ? response._meta[CHANNEL_LIVENESS_META_KEY] : void 0;
  return {
    activeWork,
    channelLiveness: isRecord2(channelLivenessCapability) && channelLivenessCapability["v"] === CHANNEL_LIVENESS_VERSION
  };
}
__name(negotiateChannelCapabilities, "negotiateChannelCapabilities");

// packages/acp-bridge/src/channel-transport.ts
init_esbuild_shims();

// packages/acp-bridge/src/with-timeout.ts
init_esbuild_shims();
async function withTimeout(p, ms, label) {
  let timer;
  const timeoutP = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new BridgeTimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([p, timeoutP]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
__name(withTimeout, "withTimeout");

// packages/acp-bridge/src/channel-transport.ts
async function terminateChannel(channel, timeoutMs, context) {
  try {
    await withTimeout(channel.kill(), timeoutMs, `${context} teardown`);
  } catch (error) {
    try {
      channel.killSync();
    } catch (forceError) {
      throw new AggregateError(
        [error, forceError],
        `ACP channel teardown failed (${context})`
      );
    }
    throw error;
  }
}
__name(terminateChannel, "terminateChannel");
function channelUnavailableReject(channel, context) {
  const unavailable = channel.transportFailed ? Promise.race([channel.exited, channel.transportFailed]) : channel.exited;
  const reject = /* @__PURE__ */ __name(() => {
    throw new BridgeChannelClosedError(context);
  }, "reject");
  return unavailable.then(reject, reject);
}
__name(channelUnavailableReject, "channelUnavailableReject");

// packages/acp-bridge/src/channel-liveness.ts
init_esbuild_shims();
import { performance as performance2 } from "node:perf_hooks";
var CHANNEL_LIVENESS_INTERVAL_MS = 15e3;
var CHANNEL_LIVENESS_PROBE_TIMEOUT_MS = 1e4;
var CHANNEL_LIVENESS_FAILURE_THRESHOLD = 2;
var CHANNEL_LIVENESS_TIMER_LATE_TOLERANCE_MS = 1e3;
var CHANNEL_LIVENESS_TIMEOUT_CODE = "acp_channel_liveness_timeout";
var CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE = "acp_channel_liveness_protocol_error";
var ChannelLivenessFailure = class extends Error {
  constructor(code) {
    super(
      code === CHANNEL_LIVENESS_TIMEOUT_CODE ? "ACP channel failed consecutive liveness probes" : "ACP channel returned an invalid liveness response"
    );
    this.code = code;
    this.name = "ChannelLivenessFailure";
  }
  static {
    __name(this, "ChannelLivenessFailure");
  }
};
function isValidResponse(response, nonce) {
  return typeof response === "object" && response !== null && !Array.isArray(response) && response["v"] === CHANNEL_LIVENESS_VERSION && response["nonce"] === nonce;
}
__name(isValidResponse, "isValidResponse");
function startChannelLivenessMonitor(options) {
  const now = options.now ?? (() => performance2.now());
  let stopped = false;
  let timer;
  let consecutiveTimeouts = 0;
  let nextNonce = 0;
  let resolveStopped;
  const stoppedOutcome = new Promise((resolve2) => {
    resolveStopped = resolve2;
  });
  const isActive = /* @__PURE__ */ __name(() => !stopped && options.isActive(), "isActive");
  const stop = /* @__PURE__ */ __name(() => {
    stopped = true;
    if (timer !== void 0) {
      clearTimeout(timer);
      timer = void 0;
    }
    resolveStopped({ kind: "stopped" });
  }, "stop");
  const fail = /* @__PURE__ */ __name((error) => {
    if (!isActive()) return;
    stop();
    options.onFailure(error);
  }, "fail");
  const timerWasLate = /* @__PURE__ */ __name((expectedAt) => now() > expectedAt + CHANNEL_LIVENESS_TIMER_LATE_TOLERANCE_MS, "timerWasLate");
  const runProbe = /* @__PURE__ */ __name(async () => {
    if (!isActive()) return;
    const nonce = nextNonce;
    nextNonce = nonce === Number.MAX_SAFE_INTEGER ? 0 : Math.max(0, nonce + 1);
    const response = Promise.resolve().then(() => options.probe(nonce)).then(
      (value) => ({ kind: "response", response: value }),
      () => ({ kind: "rejected" })
    );
    let outcome;
    while (true) {
      const expectedAt = now() + CHANNEL_LIVENESS_PROBE_TIMEOUT_MS;
      const timeout = new Promise((resolve2) => {
        timer = setTimeout(() => {
          timer = void 0;
          resolve2(
            timerWasLate(expectedAt) ? { kind: "local_delay" } : { kind: "timeout" }
          );
        }, CHANNEL_LIVENESS_PROBE_TIMEOUT_MS);
        timer.unref();
      });
      outcome = await Promise.race([response, timeout, stoppedOutcome]);
      if (timer !== void 0) {
        clearTimeout(timer);
        timer = void 0;
      }
      if (outcome.kind === "stopped" || !isActive()) return;
      if (outcome.kind !== "local_delay") break;
      consecutiveTimeouts = 0;
    }
    if (outcome.kind === "response") {
      if (!isValidResponse(outcome.response, nonce)) {
        fail(new ChannelLivenessFailure(CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE));
        return;
      }
      consecutiveTimeouts = 0;
      schedule(CHANNEL_LIVENESS_INTERVAL_MS);
      return;
    }
    if (outcome.kind === "rejected") {
      await Promise.resolve();
      fail(new ChannelLivenessFailure(CHANNEL_LIVENESS_PROTOCOL_ERROR_CODE));
      return;
    }
    consecutiveTimeouts++;
    if (consecutiveTimeouts >= CHANNEL_LIVENESS_FAILURE_THRESHOLD) {
      fail(new ChannelLivenessFailure(CHANNEL_LIVENESS_TIMEOUT_CODE));
      return;
    }
    void runProbe();
  }, "runProbe");
  function schedule(delayMs) {
    if (!isActive()) return;
    const expectedAt = now() + delayMs;
    timer = setTimeout(() => {
      timer = void 0;
      if (!isActive()) return;
      if (timerWasLate(expectedAt)) {
        consecutiveTimeouts = 0;
        schedule(CHANNEL_LIVENESS_INTERVAL_MS);
        return;
      }
      void runProbe();
    }, delayMs);
    timer.unref();
  }
  __name(schedule, "schedule");
  schedule(CHANNEL_LIVENESS_INTERVAL_MS);
  return { stop };
}
__name(startChannelLivenessMonitor, "startChannelLivenessMonitor");

// packages/acp-bridge/src/channel-startup-profile.ts
init_esbuild_shims();
var MAX_PROFILE_DURATION_MS = 6e5;
var ATTRIBUTE_PREFIX = "qwen-code.daemon.acp_startup";
function isRecord3(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
__name(isRecord3, "isRecord");
function readDuration(source, key) {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_PROFILE_DURATION_MS ? value : void 0;
}
__name(readDuration, "readDuration");
function readDurations(source, keys) {
  if (!isRecord3(source)) {
    return { values: {}, complete: false };
  }
  const values = {};
  let complete = true;
  for (const key of keys) {
    const value = readDuration(source, key);
    if (value === void 0) {
      complete = false;
    } else {
      values[key] = value;
    }
  }
  return { values, complete };
}
__name(readDurations, "readDurations");
function addDurationAttributes(attributes, group, values) {
  for (const [key, value] of Object.entries(values)) {
    if (group === "phase" && key === "unattributedMs") continue;
    const attributeKey = key.replace(
      /[A-Z]/g,
      (letter) => `_${letter.toLowerCase()}`
    );
    attributes[`${ATTRIBUTE_PREFIX}.${group}.${attributeKey}`] = value;
  }
}
__name(addDurationAttributes, "addDurationAttributes");
var PHASE_KEYS = [
  "processToProfilerReadyMs",
  "geminiImportMs",
  "argsParseMs",
  "settingsLoadMs",
  "configConstructionMs",
  "appInitializationMs",
  "acpImportMs",
  "bootstrapConfigInitializationMs",
  "transportSetupMs",
  "initializeHandlerMs",
  "unattributedMs"
];
var CONFIG_KEYS = [
  "extensionsInitialMs",
  "hooksMs",
  "skillsMs",
  "extensionsFinalMs",
  "hierarchicalMemoryMs",
  "toolRegistryMs",
  "ripgrepProbeMs",
  "toolWarmupMs",
  "otherMs"
];
function getChannelStartupProfileAttributes(response, receivedAtEpochMs, initializeTimeoutMs) {
  if (!isRecord3(response) || !isRecord3(response["_meta"])) {
    return void 0;
  }
  const profile = response["_meta"][CHANNEL_STARTUP_PROFILE_META_KEY];
  if (!isRecord3(profile) || profile["v"] !== CHANNEL_STARTUP_PROFILE_VERSION) {
    return void 0;
  }
  const phases = readDurations(profile["phases"], PHASE_KEYS);
  const config = readDurations(profile["config"], CONFIG_KEYS);
  const processToResponseMs = readDuration(profile, "processToResponseMs");
  const responseBuiltAtEpochMs = profile["responseBuiltAtEpochMs"];
  const childComplete = profile["complete"] === true;
  const validResponseEpoch = typeof responseBuiltAtEpochMs === "number" && Number.isFinite(responseBuiltAtEpochMs) && responseBuiltAtEpochMs >= 0;
  const effectiveComplete = childComplete && phases.complete && config.complete && processToResponseMs !== void 0 && validResponseEpoch;
  const attributes = {
    [`${ATTRIBUTE_PREFIX}.profile.version`]: CHANNEL_STARTUP_PROFILE_VERSION,
    [`${ATTRIBUTE_PREFIX}.profile.complete`]: effectiveComplete
  };
  if (processToResponseMs !== void 0) {
    attributes[`${ATTRIBUTE_PREFIX}.child.process_to_response_ms`] = processToResponseMs;
  }
  if (phases.values["unattributedMs"] !== void 0) {
    attributes[`${ATTRIBUTE_PREFIX}.child.unattributed_ms`] = phases.values["unattributedMs"];
  }
  addDurationAttributes(attributes, "phase", phases.values);
  addDurationAttributes(attributes, "config", config.values);
  if (validResponseEpoch) {
    const transportMs = receivedAtEpochMs - responseBuiltAtEpochMs;
    if (Number.isFinite(transportMs) && transportMs >= 0 && transportMs <= initializeTimeoutMs) {
      attributes[`${ATTRIBUTE_PREFIX}.response_transport_ms`] = transportMs;
    }
  }
  return attributes;
}
__name(getChannelStartupProfileAttributes, "getChannelStartupProfileAttributes");

// packages/acp-bridge/src/internal/stderrLine.ts
init_esbuild_shims();
function writeStderrLine(message) {
  process.stderr.write(message.endsWith("\n") ? message : `${message}
`);
}
__name(writeStderrLine, "writeStderrLine");

// packages/acp-bridge/src/channel-startup.ts
function isRecord4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord4, "isRecord");
function safeTransportFailureCode(error) {
  if (!isRecord4(error)) return void 0;
  const code = error["code"];
  return typeof code === "string" && /^[a-z0-9_.-]{1,64}$/iu.test(code) ? code : void 0;
}
__name(safeTransportFailureCode, "safeTransportFailureCode");
function safeTransportFailureDetail(error) {
  if (!isRecord4(error) || error["code"] !== "ndjson_queue_limit_exceeded") {
    return void 0;
  }
  const queueError = error;
  const budget = typeof queueError.budget === "string" && /^[a-z0-9_.-]{1,64}$/iu.test(queueError.budget) ? queueError.budget : "unknown";
  const numbers = [];
  for (const value of [
    queueError.requiredBytes,
    queueError.availableBytes,
    queueError.maxQueuedBytes
  ]) {
    numbers.push(
      typeof value === "number" && Number.isFinite(value) ? String(Math.max(0, Math.floor(value))) : "?"
    );
  }
  return `${budget}:required=${numbers[0]}:available=${numbers[1]}:cap=${numbers[2]}`;
}
__name(safeTransportFailureDetail, "safeTransportFailureDetail");
function createChannelStartup({
  channelFactory,
  boundWorkspace,
  childEnvOverrides,
  initTimeoutMs,
  telemetry,
  channelLifecycle,
  initialRuntimeEpoch,
  runtimeEpochSource,
  delegateReadTextFileToClient,
  isExternalToolGuardRequired,
  isShuttingDown,
  constructHarnessChannel,
  handleChannelTransportUnavailable,
  handleChannelExit,
  killChannelWithLog,
  sessionCount
}) {
  let runtimeEpoch = initialRuntimeEpoch;
  async function start() {
    const privateParentCapability = randomBytes(32).toString("base64url");
    const acpChannelId = randomUUID();
    const startupStartedAt = Date.now();
    const startupAbort = new AbortController();
    const startup = {};
    const factoryPromise = telemetry.withSpan(
      "channel.spawn",
      {
        "qwen-code.daemon.bridge.operation": "channel.spawn",
        "qwen-code.daemon.channel.reused": false,
        "qwen-code.daemon.acp_channel.id": acpChannelId
      },
      async () => await channelFactory(
        boundWorkspace,
        {
          ...childEnvOverrides,
          [PRIVATE_ACP_CAPABILITY_ENV]: privateParentCapability
        },
        startupAbort.signal,
        startup
      )
    );
    let channel;
    try {
      channel = await withTimeout(
        factoryPromise,
        initTimeoutMs,
        "channel factory"
      );
    } catch (error) {
      const failure = error instanceof BridgeTimeoutError ? startup.getTimeoutError?.() ?? error : error;
      startupAbort.abort(failure);
      void factoryPromise.then(
        (lateChannel) => terminateChannel(
          lateChannel,
          initTimeoutMs,
          "late channel factory result"
        ).catch((teardownError) => {
          writeStderrLine(
            `qwen serve: late ACP channel teardown failed: ${String(teardownError)}`
          );
        }),
        () => void 0
      );
      throw failure;
    }
    let info;
    try {
      info = constructHarnessChannel(channel, acpChannelId);
    } catch (error) {
      try {
        channel.killSync();
      } catch {
      }
      try {
        await Promise.race([
          channel.exited.then(() => void 0),
          terminateChannel(
            channel,
            initTimeoutMs,
            "channel construction failure"
          )
        ]);
      } catch (teardownError) {
        throw new AggregateError(
          [error, teardownError],
          "ACP channel construction and teardown failed"
        );
      }
      throw error;
    }
    const { connection } = info;
    const markTransportFailed = /* @__PURE__ */ __name((error) => {
      if (!info.isDying) {
        info.transportFailureInitiatedTeardown = true;
      }
      info.transportFailed = true;
      info.transportFailureCode = safeTransportFailureCode(error);
      info.transportFailureDetail = safeTransportFailureDetail(error);
      info.isDying = true;
      info.channelLiveness?.stop();
      handleChannelTransportUnavailable(info);
    }, "markTransportFailed");
    void channel.transportFailed?.then(
      markTransportFailed,
      markTransportFailed
    );
    channelLifecycle.track(info);
    if (channelLifecycle.size > 2) {
      writeStderrLine(
        `qwen serve: WARNING aliveChannels.size=${channelLifecycle.size} (expected 1, max 2 during killSession-then-spawnOrAttach overlap) \u2014 possible channel leak; check that prior channels' channel.exited fired and the handler ran cleanup.`
      );
    }
    void channel.exited.then((exitInfo) => {
      handleChannelExit(info, exitInfo);
    });
    let channelLivenessNegotiated = false;
    try {
      await telemetry.withSpan(
        "channel.initialize",
        {
          "qwen-code.daemon.bridge.operation": "channel.initialize",
          "qwen-code.daemon.acp_channel.id": acpChannelId
        },
        async () => {
          const remainingStartupMs = Math.max(
            1,
            initTimeoutMs - (Date.now() - startupStartedAt)
          );
          const response = await withTimeout(
            Promise.race([
              connection.initialize(
                createChannelInitializeRequest(
                  privateParentCapability,
                  delegateReadTextFileToClient
                )
              ),
              channelUnavailableReject(channel, "during initialize")
            ]),
            remainingStartupMs,
            "initialize"
          );
          const capabilities = negotiateChannelCapabilities(
            response,
            isExternalToolGuardRequired()
          );
          if (capabilities.activeWork) {
            info.activeWork = { ...capabilities.activeWork, seq: 0 };
          }
          channelLivenessNegotiated = capabilities.channelLiveness;
          try {
            const attributes = getChannelStartupProfileAttributes(
              response,
              Date.now(),
              initTimeoutMs
            );
            if (attributes && telemetry.setActiveSpanAttributes) {
              telemetry.setActiveSpanAttributes(attributes);
            }
          } catch {
          }
          return response;
        }
      );
    } catch (err) {
      info.isDying = true;
      startupAbort.abort(err);
      await terminateChannel(
        channel,
        initTimeoutMs,
        "channel initialization failure"
      ).catch(() => void 0);
      throw err;
    }
    if (info.isDying) {
      await channel.kill().catch(() => {
      });
      throw new BridgeChannelClosedError("during initialize");
    }
    if (isShuttingDown()) {
      info.isDying = true;
      startupAbort.abort(new Error("AcpSessionBridge is shutting down"));
      await terminateChannel(channel, initTimeoutMs, "late shutdown").catch(
        () => void 0
      );
      throw new Error("AcpSessionBridge is shutting down");
    }
    if (!channelLifecycle.has(info)) {
      info.isDying = true;
      const error = new BridgeChannelClosedError(
        "during channel initialization"
      );
      startupAbort.abort(error);
      await terminateChannel(
        channel,
        initTimeoutMs,
        "exited during initialization"
      ).catch(() => void 0);
      throw error;
    }
    const previousRuntimeEpoch = runtimeEpochSource.current();
    const nextRuntimeEpoch = runtimeEpochSource.allocate();
    if (!Number.isSafeInteger(previousRuntimeEpoch) || previousRuntimeEpoch < runtimeEpoch || !Number.isSafeInteger(nextRuntimeEpoch) || nextRuntimeEpoch <= previousRuntimeEpoch) {
      info.isDying = true;
      const epochError = new Error(
        `Runtime epoch source must increase monotonically (local=${runtimeEpoch}, current=${previousRuntimeEpoch}, next=${nextRuntimeEpoch}).`
      );
      startupAbort.abort(epochError);
      await terminateChannel(
        channel,
        initTimeoutMs,
        "invalid runtime epoch"
      ).catch(() => void 0);
      throw epochError;
    }
    runtimeEpoch = nextRuntimeEpoch;
    info.lastUsedAt = Date.now();
    channelLifecycle.publish(info);
    info.handshakeComplete = true;
    if (channelLivenessNegotiated) {
      const failChannelLiveness = /* @__PURE__ */ __name((error) => {
        if (info.isDying || !channelLifecycle.has(info)) return;
        markTransportFailed(error);
        telemetry.event("channel.liveness_failed", {
          "qwen-code.daemon.acp_channel.id": info.id,
          "qwen-code.daemon.channel.session_count": sessionCount(info),
          "qwen-code.daemon.channel.transport_error_code": error.code
        });
        writeStderrLine(
          `qwen serve: channel liveness failed (${error.code}); killing channel`
        );
        if (info.channel.transportGuard) {
          info.channel.transportGuard.fail(error);
        } else {
          void killChannelWithLog(info, "channel liveness failure");
        }
      }, "failChannelLiveness");
      info.channelLiveness = startChannelLivenessMonitor({
        probe: /* @__PURE__ */ __name((nonce) => info.connection.extMethod(SERVE_STATUS_EXT_METHODS.channelPing, {
          v: CHANNEL_LIVENESS_VERSION,
          nonce
        }), "probe"),
        onFailure: failChannelLiveness,
        isActive: /* @__PURE__ */ __name(() => channelLifecycle.current === info && channelLifecycle.has(info) && !info.isDying && !isShuttingDown(), "isActive")
      });
    }
    telemetry.metrics?.channelLifecycle("spawn");
    return info;
  }
  __name(start, "start");
  return {
    get epoch() {
      return runtimeEpoch;
    },
    start
  };
}
__name(createChannelStartup, "createChannelStartup");

// packages/acp-bridge/src/channel-harness.ts
function isRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord5, "isRecord");
function createChannelHarness(options) {
  const {
    initTimeoutMs,
    telemetry,
    isShuttingDown,
    hasNoSessionWork,
    hasNoWorkspaceWork,
    channelShouldReapWhenIdle,
    sessionCount
  } = options;
  const channelLifecycle = createChannelLifecycle();
  let keepAliveUntil = 0;
  let runtimeOperationReservations = 0;
  const pendingKeepAliveDeadlines = /* @__PURE__ */ new Map();
  let idleTimer;
  function liveHarnessChannel() {
    const channel = channelLifecycle.current;
    return channel && !channel.isDying ? channel : void 0;
  }
  __name(liveHarnessChannel, "liveHarnessChannel");
  function hasNoChannelWork(ci, exclusions) {
    if (!hasNoSessionWork(ci, exclusions)) return false;
    if (ci.retireWhenSessionsDrain) return true;
    return ci.workspaceControlInFlight === 0 && hasNoWorkspaceWork(ci) && runtimeOperationReservations === 0;
  }
  __name(hasNoChannelWork, "hasNoChannelWork");
  function cancelIdleTimer() {
    if (idleTimer !== void 0) {
      clearTimeout(idleTimer);
      idleTimer = void 0;
    }
  }
  __name(cancelIdleTimer, "cancelIdleTimer");
  async function killChannelWithLog(ci, context) {
    ci.isDying = true;
    ci.channelLiveness?.stop();
    await terminateChannel(
      ci.channel,
      initTimeoutMs,
      context ?? "channel kill"
    ).catch((err) => {
      writeStderrLine(
        `qwen serve: channel kill failed${context ? ` (${context})` : ""}: ${String(err)}`
      );
    });
  }
  __name(killChannelWithLog, "killChannelWithLog");
  async function retireChannelAfterSessionsDrain(ci, context) {
    if (ci.isDying) return;
    if (hasNoSessionWork(ci)) {
      await killChannelWithLog(ci, context);
      return;
    }
    ci.retireWhenSessionsDrain = true;
    writeStderrLine(
      `qwen serve: ${context}; deferring channel retirement until ${sessionCount(ci)} active session(s) drain`
    );
  }
  __name(retireChannelAfterSessionsDrain, "retireChannelAfterSessionsDrain");
  async function retireChannelOnTimeout(ci, error, context) {
    if (error instanceof BridgeTimeoutError && !ci.isDying) {
      await retireChannelAfterSessionsDrain(ci, context);
    }
  }
  __name(retireChannelOnTimeout, "retireChannelOnTimeout");
  function configuredChannelIdleTimeoutMs() {
    const raw = options.getChannelIdleTimeoutMs();
    return raw !== void 0 && Number.isFinite(raw) && raw > 0 ? Math.min(raw, 2147483647) : 0;
  }
  __name(configuredChannelIdleTimeoutMs, "configuredChannelIdleTimeoutMs");
  function resolvedChannelIdleTimeoutMs() {
    const configured = configuredChannelIdleTimeoutMs();
    const now = Date.now();
    let pendingKeepAliveMs = 0;
    for (const deadline of pendingKeepAliveDeadlines.values()) {
      pendingKeepAliveMs = Math.max(pendingKeepAliveMs, deadline - now);
    }
    return Math.max(configured, keepAliveUntil - now, pendingKeepAliveMs);
  }
  __name(resolvedChannelIdleTimeoutMs, "resolvedChannelIdleTimeoutMs");
  async function startIdleTimer(ci, context) {
    if (ci.isDying || liveHarnessChannel() !== ci) return;
    const timeoutMs = resolvedChannelIdleTimeoutMs();
    if (timeoutMs <= 0) {
      await killChannelWithLog(ci, context);
      return;
    }
    cancelIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = void 0;
      if (hasNoChannelWork(ci)) {
        writeStderrLine(
          `qwen serve: idle timeout (${timeoutMs}ms) expired, killing channel`
        );
        void killChannelWithLog(ci, "idle timeout");
      }
    }, timeoutMs);
    idleTimer.unref();
  }
  __name(startIdleTimer, "startIdleTimer");
  async function reapPendingEmptyChannel(ci, opts) {
    if (!channelShouldReapWhenIdle(ci) || !hasNoChannelWork(ci, opts)) return;
    ci.emptyReapPending = false;
    ci.isDying = true;
    ci.channelLiveness?.stop();
    await terminateChannel(
      ci.channel,
      initTimeoutMs,
      "pending empty channel"
    ).catch(() => {
    });
  }
  __name(reapPendingEmptyChannel, "reapPendingEmptyChannel");
  async function withWorkspaceControl(ci, fn, recordUse = true) {
    if (liveHarnessChannel() === ci) cancelIdleTimer();
    if (recordUse) ci.lastUsedAt = Date.now();
    ci.workspaceControlInFlight++;
    try {
      return await fn();
    } catch (error) {
      await retireChannelOnTimeout(ci, error, "workspace control timeout");
      throw error;
    } finally {
      if (recordUse) ci.lastUsedAt = Date.now();
      ci.workspaceControlInFlight = Math.max(
        0,
        ci.workspaceControlInFlight - 1
      );
      await reapPendingEmptyChannel(ci);
      if (!ci.isDying && liveHarnessChannel() === ci && hasNoChannelWork(ci)) {
        await startIdleTimer(ci, "workspace control");
      }
    }
  }
  __name(withWorkspaceControl, "withWorkspaceControl");
  async function settleReleasedRuntimeWork(context, armIdleTimer = true) {
    for (const ci2 of Array.from(channelLifecycle.values())) {
      await reapPendingEmptyChannel(ci2);
    }
    if (!armIdleTimer) return;
    const ci = liveHarnessChannel();
    if (ci && hasNoChannelWork(ci)) {
      await startIdleTimer(ci, context);
    }
  }
  __name(settleReleasedRuntimeWork, "settleReleasedRuntimeWork");
  async function releaseRuntimeOperationReservation(context) {
    runtimeOperationReservations = Math.max(
      0,
      runtimeOperationReservations - 1
    );
    await settleReleasedRuntimeWork(context);
  }
  __name(releaseRuntimeOperationReservation, "releaseRuntimeOperationReservation");
  async function ensureChannel() {
    if (isShuttingDown()) {
      throw new Error("AcpSessionBridge is shutting down");
    }
    cancelIdleTimer();
    if (channelLifecycle.current && !channelLifecycle.current.isDying)
      return channelLifecycle.current;
    if (channelLifecycle.starting) return await channelLifecycle.starting;
    const promise = channelLifecycle.startSpawn(channelStartup.start);
    try {
      return await promise;
    } finally {
      channelLifecycle.finishSpawn();
    }
  }
  __name(ensureChannel, "ensureChannel");
  const preheat = /* @__PURE__ */ __name(async (options2) => {
    if (isShuttingDown()) {
      throw new Error("AcpSessionBridge is shutting down");
    }
    runtimeOperationReservations++;
    const rawKeepAliveMs = options2?.keepAliveMs;
    const keepAliveMs = rawKeepAliveMs !== void 0 && Number.isFinite(rawKeepAliveMs) && rawKeepAliveMs > 0 ? Math.min(rawKeepAliveMs, 2147483647) : void 0;
    const pendingKeepAliveToken = keepAliveMs === void 0 ? void 0 : Symbol();
    if (pendingKeepAliveToken && keepAliveMs !== void 0) {
      pendingKeepAliveDeadlines.set(
        pendingKeepAliveToken,
        Date.now() + keepAliveMs
      );
    }
    try {
      await telemetry.withSpan(
        "channel.preheat",
        { "qwen-code.daemon.bridge.operation": "channel.preheat" },
        async () => {
          const info = await ensureChannel();
          info.lastUsedAt = Date.now();
          if (keepAliveMs !== void 0) {
            keepAliveUntil = Math.max(keepAliveUntil, Date.now() + keepAliveMs);
          }
        }
      );
    } finally {
      if (pendingKeepAliveToken) {
        pendingKeepAliveDeadlines.delete(pendingKeepAliveToken);
      }
      runtimeOperationReservations = Math.max(
        0,
        runtimeOperationReservations - 1
      );
      await settleReleasedRuntimeWork(
        "channel preheat",
        resolvedChannelIdleTimeoutMs() > 0
      );
    }
  }, "preheat");
  const channelStartup = createChannelStartup({
    ...options,
    channelLifecycle,
    killChannelWithLog,
    handleChannelExit(info, exitInfo) {
      info.channelLiveness?.stop();
      options.handleChannelTransportUnavailable(info);
      if (channelLifecycle.current === info) cancelIdleTimer();
      options.beforeChannelExit(info);
      channelLifecycle.remove(info);
      options.handleChannelExit(info, exitInfo);
    }
  });
  return {
    get current() {
      return channelLifecycle.current;
    },
    get starting() {
      return channelLifecycle.starting;
    },
    get epoch() {
      return channelStartup.epoch;
    },
    get runtimeOperationReservations() {
      return runtimeOperationReservations;
    },
    get pendingKeepAliveCount() {
      return pendingKeepAliveDeadlines.size;
    },
    createConnection: createHarnessConnection,
    withWorktreeInitialization(request, worktree) {
      return worktree ? {
        ...request,
        _meta: {
          ...isRecord5(request._meta) ? request._meta : {},
          [WORKTREE_MCP_DEFER_META_KEY]: true
        }
      } : request;
    },
    changeSessionCwd(channel, sessionId, req) {
      return channel.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionCd, {
        sessionId,
        path: req.path,
        ...req.allowedRoots ? { allowedRoots: req.allowedRoots } : {},
        ...req.managedRelocation ? { managedRelocation: req.managedRelocation } : {},
        ...req.conversationDirectoryExpectation ? {
          conversationDirectoryExpectation: req.conversationDirectoryExpectation
        } : {}
      });
    },
    executeShell(command, cwd, onOutput, signal) {
      return ShellExecutionService.execute(
        command,
        cwd,
        onOutput,
        signal,
        false,
        { terminalWidth: 120, terminalHeight: 40 },
        { streamStdout: true }
      );
    },
    values: channelLifecycle.values,
    has: channelLifecycle.has,
    ensure: ensureChannel,
    configuredChannelIdleTimeoutMs,
    cancelIdleTimer,
    startIdleTimer,
    killChannelWithLog,
    retireChannelAfterSessionsDrain,
    retireChannelOnTimeout,
    hasNoChannelWork,
    reapPendingEmptyChannel,
    withWorkspaceControl,
    reserveRuntimeOperation() {
      runtimeOperationReservations++;
    },
    releaseRuntimeOperationReservation,
    settleReleasedRuntimeWork,
    preheat,
    reclaimIdleChannel(info) {
      info.isDying = true;
      cancelIdleTimer();
      keepAliveUntil = 0;
      info.channelLiveness?.stop();
      writeStderrLine(`qwen serve: reclaiming idle ACP channel ${info.id}`);
      return terminateChannel(
        info.channel,
        initTimeoutMs,
        "capacity reclamation"
      );
    },
    markDying(channels) {
      for (const ci of channels) {
        ci.isDying = true;
        ci.channelLiveness?.stop();
      }
    },
    killAllSync(channels) {
      for (const info of channels) {
        info.channelLiveness?.stop();
        try {
          info.channel.killSync();
        } catch {
        }
      }
    },
    terminate(channel) {
      return terminateChannel(
        channel.channel,
        initTimeoutMs,
        "bridge shutdown"
      );
    }
  };
}
__name(createChannelHarness, "createChannelHarness");

// packages/acp-bridge/src/session-control-plane.ts
init_esbuild_shims();
import { randomUUID as randomUUID3 } from "node:crypto";
import * as path4 from "node:path";

// packages/acp-bridge/src/compactionEngine.ts
init_esbuild_shims();
var TURN_BOUNDARY_TYPES = /* @__PURE__ */ new Set(["turn_complete", "turn_error"]);
var TRANSIENT_TYPES = /* @__PURE__ */ new Set([
  "history_truncated",
  "slow_client_warning",
  "client_evicted",
  "replay_complete",
  "stream_error"
]);
var LATEST_WINS_UPDATES = /* @__PURE__ */ new Set([
  "available_commands_update",
  "current_mode_update"
]);
var REPLAY_SEGMENT_COMPACT_THRESHOLD = 64;
var LIVE_JOURNAL_TEXT_CHUNKS_PER_EVENT = 256;
function createLiveJournalState() {
  return {
    entries: [],
    entryBytes: [],
    entryEvents: [],
    totalBytes: 0,
    totalEvents: 0,
    truncatedEvents: 0
  };
}
__name(createLiveJournalState, "createLiveJournalState");
function replayRecordId(event) {
  if (event.type !== "session_update") return void 0;
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    return void 0;
  const update = data["update"];
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return void 0;
  }
  const meta = update["_meta"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return void 0;
  }
  const recordId = meta["qwen.session.recordId"];
  return typeof recordId === "string" ? recordId : void 0;
}
__name(replayRecordId, "replayRecordId");
function lastRecordIdIn(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const id = replayRecordId(events[i]);
    if (id !== void 0) return id;
  }
  return void 0;
}
__name(lastRecordIdIn, "lastRecordIdIn");
function lastSummaryRecordIdIn(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (!isSummaryReplayEvent(events[i])) continue;
    const id = replayRecordId(events[i]);
    if (id !== void 0) return id;
  }
  return void 0;
}
__name(lastSummaryRecordIdIn, "lastSummaryRecordIdIn");
var JOURNAL_GROWTH_REASK_INTERVAL_MS = 1e4;
var JOURNAL_GROWTH_MAX_GRANTS_PER_BREACH = 64;
var TurnBoundaryCompactionEngine = class {
  static {
    __name(this, "TurnBoundaryCompactionEngine");
  }
  maxReplayBytes;
  // Mutable: adaptive growth (see `maybeGrowJournalLimits`) raises these
  // in place when the advisor grants headroom.
  maxJournalEvents;
  maxJournalBytes;
  onJournalGrowth;
  now;
  journalGrowthDeniedAt;
  onReplayWindowEviction;
  replaySegments = [];
  replaySegmentStart = 0;
  replayBytes = 0;
  fullJournal = createLiveJournalState();
  summaryJournal = createLiveJournalState();
  lastEventId = 0;
  closed = false;
  truncatedEvents = 0;
  truncatedTurns = 0;
  // Most recent `qwen.session.recordId` observed on an ingested or seeded
  // `session_update`. Surfaced on the `history_truncated` marker emitted by
  // `snapshot()` so clients that lost every turn-boundary event from their
  // retained window (e.g. a live-journal truncation during a single long
  // in-flight turn) still have an anchor for `beforeRecordId` transcript
  // pagination. Undefined until at least one recordId has been observed;
  // omitted from the marker in that case.
  activeRecordId;
  summaryRecordId;
  // Pagination anchor for the replay-path `history_truncated` marker,
  // frozen at the first replay-window eviction. Prefers the first
  // retained recordId (the eviction boundary, so `beforeRecordId`
  // fetches exactly the dropped records with no overlap); falls back to
  // the last dropped recordId when the retained window carries no
  // recordId. Deliberately NOT `activeRecordId` — that one is advanced
  // by `ingest()` on every turn boundary and, when a retained segment
  // carries the last seed recordId, would place the anchor inside the
  // retained window and re-fetch records the client already displays.
  replayAnchorRecordId;
  slots = [];
  toolSlotIndex = /* @__PURE__ */ new Map();
  textSlotIndex = {
    text: /* @__PURE__ */ new Map(),
    thought: /* @__PURE__ */ new Map()
  };
  constructor(opts = {}) {
    this.maxReplayBytes = normalizeCompactedReplayMaxBytes(opts.maxReplayBytes);
    this.maxJournalEvents = normalizeMaxJournalEvents(opts.maxJournalEvents);
    this.maxJournalBytes = normalizeMaxJournalBytes(opts.maxJournalBytes);
    this.onJournalGrowth = opts.onJournalGrowth;
    this.now = opts.now ?? (() => performance.now());
    this.onReplayWindowEviction = opts.onReplayWindowEviction;
  }
  /** Current journal caps — may have grown past the configured baseline. */
  journalLimits() {
    return { maxEvents: this.maxJournalEvents, maxBytes: this.maxJournalBytes };
  }
  ingest(event, byteLength) {
    if (this.closed) return;
    if (event.id !== void 0) {
      this.lastEventId = event.id;
    }
    if (TRANSIENT_TYPES.has(event.type)) return;
    const summaryEvent = summarizeReplayEvent(event);
    const seenRecordId = replayRecordId(event);
    if (seenRecordId !== void 0) {
      this.activeRecordId = seenRecordId;
      if (summaryEvent) this.summaryRecordId = seenRecordId;
    }
    this.appendLiveJournal(this.fullJournal, event, byteLength);
    if (summaryEvent) {
      this.appendLiveJournal(
        this.summaryJournal,
        summaryEvent,
        summaryEvent === event ? byteLength : void 0
      );
    }
    if (TURN_BOUNDARY_TYPES.has(event.type)) {
      this.compactCurrentTurn(event);
      return;
    }
    if (event.type === "session_update") {
      this.classifySessionUpdate(event);
      return;
    }
    this.slots.push({ kind: "misc", event });
  }
  snapshot(liveReplayMode = "full") {
    const compactedTurns = this.flattenReplaySegments();
    if (this.truncatedEvents > 0) {
      compactedTurns.unshift(
        this.makeHistoryTruncatedEvent(compactedTurns.length)
      );
    }
    return {
      compactedTurns,
      liveJournal: this.liveJournalSnapshot(liveReplayMode),
      lastEventId: this.lastEventId
    };
  }
  /**
   * Snapshot of only the in-flight live journal — the events ingested
   * since the last turn boundary (a boundary folds its turn into the
   * replay window and resets the journal). Cheaper than `snapshot()`:
   * no replay-window flatten.
   */
  liveJournalSnapshot(liveReplayMode = "full") {
    const journal = liveReplayMode === "summary" ? this.summaryJournal : this.fullJournal;
    const journalRecordId = liveReplayMode === "summary" ? this.summaryRecordId : this.activeRecordId;
    const liveJournal = journal.entries.map(
      (entry) => isLiveJournalTextSegment(entry) ? mergeLiveJournalTextEvent(
        entry.firstEvent,
        entry.lastEvent,
        entry.chunks
      ) : entry
    );
    if (journal.truncatedEvents > 0) {
      liveJournal.unshift({
        v: EVENT_SCHEMA_VERSION,
        type: "history_truncated",
        data: {
          reason: "replay_window_exceeded",
          scope: "live_journal",
          truncatedEvents: journal.truncatedEvents,
          retainedEvents: journal.totalEvents,
          maxBytes: this.maxJournalBytes,
          maxEvents: this.maxJournalEvents,
          // Pagination anchor — see makeHistoryTruncatedEvent.
          ...journalRecordId !== void 0 ? { recordId: journalRecordId } : {},
          fullTranscriptAvailable: true
        }
      });
    }
    return liveJournal;
  }
  seed(snapshot) {
    if (this.closed) return;
    this.resetReplayWindow();
    this.lastEventId = snapshot.lastEventId;
    this.activeRecordId = void 0;
    this.summaryRecordId = void 0;
    this.activeRecordId = lastRecordIdIn(snapshot.compactedTurns);
    this.summaryRecordId = lastSummaryRecordIdIn(snapshot.compactedTurns);
    for (const event of snapshot.compactedTurns) {
      if (TRANSIENT_TYPES.has(event.type)) continue;
      this.addReplaySegment([event], 0);
    }
    this.resetJournal();
    this.slots = [];
    this.toolSlotIndex.clear();
    this.clearTextSlotIndex();
  }
  seedReplayEvents(events) {
    if (this.closed) return;
    this.resetReplayWindow();
    this.activeRecordId = void 0;
    this.summaryRecordId = void 0;
    this.activeRecordId = lastRecordIdIn(events);
    this.summaryRecordId = lastSummaryRecordIdIn(events);
    let recordEvents = [];
    let recordId;
    const flushRecord = /* @__PURE__ */ __name(() => {
      this.addReplaySegment(recordEvents, 0);
      recordEvents = [];
      recordId = void 0;
    }, "flushRecord");
    for (const event of events) {
      this.recordLastEventId(event);
      if (TRANSIENT_TYPES.has(event.type)) continue;
      const nextRecordId = replayRecordId(event);
      if (nextRecordId === void 0) {
        flushRecord();
        this.addReplaySegment([event], 0);
        continue;
      }
      if (recordId !== void 0 && recordId !== nextRecordId) {
        flushRecord();
      }
      recordId = nextRecordId;
      recordEvents.push(event);
    }
    flushRecord();
    this.resetJournal();
    this.slots = [];
    this.toolSlotIndex.clear();
    this.clearTextSlotIndex();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.resetReplayWindow();
    this.resetJournal();
    this.activeRecordId = void 0;
    this.summaryRecordId = void 0;
    this.slots = [];
    this.toolSlotIndex.clear();
    this.clearTextSlotIndex();
  }
  appendLiveJournal(journal, event, byteLength) {
    const bytes = byteLength ?? serializedBridgeEventByteLength(event) ?? 0;
    const textChunk = liveJournalTextChunk(event);
    const current = journal.textSegment;
    const currentIndex = journal.entries.length - 1;
    if (textChunk && current && journal.entries[currentIndex] === current && current.chunks.length < LIVE_JOURNAL_TEXT_CHUNKS_PER_EVENT && journal.entryBytes[currentIndex] + bytes <= this.maxJournalBytes && current.sessionUpdate === textChunk.sessionUpdate && current.parentToolCallId === textChunk.parentToolCallId && stringArraysEqual(current.sourceRecordIds, textChunk.sourceRecordIds) && current.promptId === event.promptId && current.originatorClientId === event.originatorClientId && current.sessionId === captureSessionId(event) && hasOnlyTimestampEnvelopeMeta(current.lastEvent._meta) && hasOnlyTimestampEnvelopeMeta(event._meta)) {
      current.chunks.push(textChunk.text);
      current.lastEvent = event;
      journal.entryBytes[currentIndex] += bytes;
      journal.entryEvents[currentIndex] += 1;
      journal.totalBytes += bytes;
      journal.totalEvents += 1;
    } else {
      let entry = event;
      if (textChunk) {
        const segment = {
          sessionUpdate: textChunk.sessionUpdate,
          chunks: [textChunk.text],
          sourceRecordIds: textChunk.sourceRecordIds,
          parentToolCallId: textChunk.parentToolCallId,
          promptId: event.promptId,
          originatorClientId: event.originatorClientId,
          sessionId: captureSessionId(event),
          firstEvent: event,
          lastEvent: event
        };
        entry = segment;
        journal.textSegment = segment;
      } else {
        journal.textSegment = void 0;
      }
      journal.entries.push(entry);
      journal.entryBytes.push(bytes);
      journal.entryEvents.push(1);
      journal.totalBytes += bytes;
      journal.totalEvents += 1;
    }
    if (!TURN_BOUNDARY_TYPES.has(event.type) && (journal.entries.length > this.maxJournalEvents || journal.totalBytes > this.maxJournalBytes && journal.entries.length > 1)) {
      this.maybeGrowJournalLimits(journal);
    }
    while (journal.entries.length > this.maxJournalEvents || journal.totalBytes > this.maxJournalBytes && journal.entries.length > 1) {
      const dropped = journal.entries.shift();
      journal.totalBytes -= journal.entryBytes.shift() ?? 0;
      const droppedEvents = journal.entryEvents.shift() ?? 0;
      journal.totalEvents -= droppedEvents;
      journal.truncatedEvents += droppedEvents;
      if (dropped === journal.textSegment) {
        journal.textSegment = void 0;
      }
    }
  }
  /**
   * Consults the growth advisor once the journal breaches its caps and
   * applies a grant in place, so the eviction loop below only drops what
   * still exceeds the (possibly raised) caps. An intermediate grant that
   * does not yet retain an extra entry is still applied tentatively —
   * each applied cap is what the next ask reports and is charged for —
   * and the walk continues until a grant retains strictly more than the
   * pre-breach caps, the advisor refuses, or the step budget runs out. A
   * walk that never improves retention rolls back to the original caps
   * and counts as a refusal, so the pool is never charged for growth that
   * preserves no replay. Never throws: a misbehaving advisor degrades to
   * plain eviction, matching the engine's best-effort contract.
   */
  maybeGrowJournalLimits(journal) {
    const advisor = this.onJournalGrowth;
    if (!advisor || this.closed) return;
    const now = this.now();
    if (this.journalGrowthDeniedAt !== void 0) {
      const sinceDenialMs = now - this.journalGrowthDeniedAt;
      if (sinceDenialMs >= 0 && sinceDenialMs < JOURNAL_GROWTH_REASK_INTERVAL_MS) {
        return;
      }
    }
    const originalEvents = this.maxJournalEvents;
    const originalBytes = this.maxJournalBytes;
    const originalRetained = this.retainedTailCount(
      journal,
      originalEvents,
      originalBytes
    );
    for (let step = 0; step < JOURNAL_GROWTH_MAX_GRANTS_PER_BREACH; step++) {
      let grant;
      try {
        grant = advisor({
          maxEvents: this.maxJournalEvents,
          maxBytes: this.maxJournalBytes
        });
      } catch {
        grant = void 0;
      }
      if (!grant || !Number.isSafeInteger(grant.maxBytes) || !Number.isSafeInteger(grant.maxEvents) || grant.maxBytes <= this.maxJournalBytes || grant.maxEvents < this.maxJournalEvents) {
        break;
      }
      this.maxJournalBytes = grant.maxBytes;
      this.maxJournalEvents = grant.maxEvents;
      if (this.retainedTailCount(journal, grant.maxEvents, grant.maxBytes) > originalRetained) {
        this.journalGrowthDeniedAt = void 0;
        return;
      }
    }
    this.maxJournalEvents = originalEvents;
    this.maxJournalBytes = originalBytes;
    this.journalGrowthDeniedAt = now;
  }
  /** Entries of the newest-first tail the eviction loop would retain. */
  retainedTailCount(journal, maxEvents, maxBytes) {
    let count = 0;
    let bytes = 0;
    for (let i = journal.entries.length - 1; i >= 0; i--) {
      const entryBytes = journal.entryBytes[i] ?? 0;
      if (count + 1 > maxEvents) break;
      if (count >= 1 && bytes + entryBytes > maxBytes) break;
      count += 1;
      bytes += entryBytes;
    }
    return count;
  }
  classifySessionUpdate(event) {
    const data = event.data;
    const updateType = data?.update?.sessionUpdate;
    if (!updateType) {
      this.slots.push({ kind: "misc", event });
      return;
    }
    switch (updateType) {
      case "agent_message_chunk": {
        if (hasDiscreteMessageMeta(data?.update?._meta)) {
          this.slots.push({ kind: "misc", event });
          break;
        }
        this.mergeTextSlot("text", event, data);
        break;
      }
      case "agent_thought_chunk": {
        if (hasDiscreteMessageMeta(data?.update?._meta)) {
          this.slots.push({ kind: "misc", event });
          break;
        }
        this.mergeTextSlot("thought", event, data);
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        const toolCallId = data?.update?.toolCallId;
        if (!toolCallId) {
          this.slots.push({ kind: "misc", event });
          break;
        }
        const existingIdx = this.toolSlotIndex.get(toolCallId);
        if (existingIdx !== void 0) {
          const slot = this.slots[existingIdx];
          slot.event = mergeToolCallEvent(slot.event, event);
        } else {
          const normalizedEvent = normalizeToolCallType(event);
          this.toolSlotIndex.set(toolCallId, this.slots.length);
          this.slots.push({
            kind: "tool",
            toolCallId,
            event: normalizedEvent
          });
          const toolParent = extractParentToolCallIdFromMeta(
            data?.update?._meta
          );
          if (toolParent) {
            this.textSlotIndex.text.delete(toolParent);
            this.textSlotIndex.thought.delete(toolParent);
          }
        }
        break;
      }
      default: {
        if (LATEST_WINS_UPDATES.has(updateType)) {
          const existingIdx = this.slots.findIndex(
            (s) => s.kind === "latestWins" && s.key === updateType
          );
          if (existingIdx !== -1) {
            this.slots[existingIdx].event = event;
          } else {
            this.slots.push({ kind: "latestWins", key: updateType, event });
          }
        } else {
          this.slots.push({ kind: "misc", event });
        }
        break;
      }
    }
  }
  mergeTextSlot(kind, event, data) {
    const text = data?.update?.content?.text ?? "";
    const meta = data?.update?._meta;
    const parentToolCallId = extractParentToolCallIdFromMeta(meta);
    const sourceRecordIds = extractSourceRecordIdsFromMeta(meta);
    if (parentToolCallId != null) {
      const entries = this.textSlotIndex[kind].get(parentToolCallId) ?? [];
      const existingIdx = entries.find(
        (entry) => stringArraysEqual(entry.sourceRecordIds, sourceRecordIds)
      )?.index;
      if (existingIdx !== void 0) {
        const slot = this.slots[existingIdx];
        slot.chunks.push(text);
        if (event.id !== void 0) slot.lastEventId = event.id;
        slot.lastMeta = mergeTranscriptUpdateMeta(slot.lastMeta, meta);
        slot.lastEnvelopeMeta = event._meta ?? slot.lastEnvelopeMeta;
        slot.lastTurn = captureTurnFields(event, slot.lastTurn);
        slot.lastSessionId = captureSessionId(event) ?? slot.lastSessionId;
      } else {
        entries.push({ sourceRecordIds, index: this.slots.length });
        this.textSlotIndex[kind].set(parentToolCallId, entries);
        this.slots.push({
          kind,
          parentToolCallId,
          chunks: [text],
          sourceRecordIds,
          lastEventId: event.id ?? 0,
          lastMeta: meta,
          lastEnvelopeMeta: event._meta,
          lastTurn: captureTurnFields(event),
          lastSessionId: captureSessionId(event)
        });
      }
    } else {
      const lastSlot = this.slots[this.slots.length - 1];
      if (lastSlot && lastSlot.kind === kind && lastSlot.parentToolCallId == null && stringArraysEqual(lastSlot.sourceRecordIds, sourceRecordIds)) {
        lastSlot.chunks.push(text);
        if (event.id !== void 0) lastSlot.lastEventId = event.id;
        lastSlot.lastMeta = mergeTranscriptUpdateMeta(lastSlot.lastMeta, meta);
        lastSlot.lastEnvelopeMeta = event._meta ?? lastSlot.lastEnvelopeMeta;
        lastSlot.lastTurn = captureTurnFields(event, lastSlot.lastTurn);
        lastSlot.lastSessionId = captureSessionId(event) ?? lastSlot.lastSessionId;
      } else {
        this.slots.push({
          kind,
          parentToolCallId: void 0,
          chunks: [text],
          sourceRecordIds,
          lastEventId: event.id ?? 0,
          lastMeta: meta,
          lastEnvelopeMeta: event._meta,
          lastTurn: captureTurnFields(event),
          lastSessionId: captureSessionId(event)
        });
      }
    }
  }
  compactCurrentTurn(boundaryEvent) {
    const compacted = [];
    for (const slot of this.slots) {
      switch (slot.kind) {
        case "text":
        case "thought":
          compacted.push(
            makeMergedSessionUpdateEvent(
              slot.kind === "text" ? "agent_message_chunk" : "agent_thought_chunk",
              slot.chunks.join(""),
              slot.lastEventId,
              slot.lastMeta,
              slot.lastEnvelopeMeta,
              slot.lastTurn,
              slot.lastSessionId
            )
          );
          break;
        case "tool":
        case "misc":
        case "latestWins":
          compacted.push(slot.event);
          break;
        default:
          break;
      }
    }
    compacted.push(boundaryEvent);
    this.addReplaySegment(compacted, 1);
    this.resetJournal();
    this.slots = [];
    this.toolSlotIndex.clear();
    this.clearTextSlotIndex();
  }
  recordLastEventId(event) {
    if (event.id !== void 0) {
      this.lastEventId = event.id;
    }
  }
  resetJournal() {
    this.fullJournal = createLiveJournalState();
    this.summaryJournal = createLiveJournalState();
    this.journalGrowthDeniedAt = void 0;
  }
  addReplaySegment(events, turnCount) {
    if (events.length === 0) return;
    const bytes = events.reduce(
      // Live events passed the publish-time serializability gate, but the
      // seed paths (persisted transcripts) bypass it — log a diagnostic
      // and count 0 so a single unserializable record can't wedge the
      // replay-window accounting.
      (sum, event) => {
        const size = serializedBridgeEventByteLength(event);
        if (size === void 0) {
          logEventSizingFailed(event.type);
          return sum;
        }
        return sum + size;
      },
      0
    );
    this.replaySegments.push({ events: events.slice(), bytes, turnCount });
    this.replayBytes += bytes;
    this.enforceReplayWindow();
  }
  enforceReplayWindow() {
    let droppedSegmentCount = 0;
    let droppedBytes = 0;
    let droppedEvents = 0;
    let droppedTurns = 0;
    let lastDroppedRecordId;
    while (this.replayBytes > this.maxReplayBytes && this.activeReplaySegmentCount() > 1) {
      const dropped = this.replaySegments[this.replaySegmentStart];
      this.replaySegmentStart += 1;
      droppedSegmentCount += 1;
      droppedBytes += dropped.bytes;
      droppedEvents += dropped.events.length;
      droppedTurns += dropped.turnCount;
      this.replayBytes -= dropped.bytes;
      this.truncatedEvents += dropped.events.length;
      this.truncatedTurns += dropped.turnCount;
      const droppedRecordId = lastRecordIdIn(dropped.events);
      if (droppedRecordId !== void 0) {
        lastDroppedRecordId = droppedRecordId;
      }
    }
    if (droppedSegmentCount > 0) {
      this.replayAnchorRecordId ??= this.firstRetainedReplayRecordId() ?? lastDroppedRecordId;
      this.compactReplaySegmentQueueIfNeeded();
      this.notifyReplayWindowEviction({
        droppedBytes,
        droppedEvents,
        droppedSegments: droppedSegmentCount,
        droppedTurns,
        maxBytes: this.maxReplayBytes,
        retainedBytes: this.replayBytes,
        retainedEvents: this.flattenReplaySegments().length
      });
    }
  }
  firstRetainedReplayRecordId() {
    for (let i = this.replaySegmentStart; i < this.replaySegments.length; i++) {
      const recordId = lastRecordIdIn(this.replaySegments[i].events);
      if (recordId !== void 0) return recordId;
    }
    return void 0;
  }
  flattenReplaySegments() {
    return this.replaySegments.slice(this.replaySegmentStart).flatMap((segment) => segment.events);
  }
  activeReplaySegmentCount() {
    return this.replaySegments.length - this.replaySegmentStart;
  }
  compactReplaySegmentQueueIfNeeded() {
    if (this.replaySegmentStart < REPLAY_SEGMENT_COMPACT_THRESHOLD) return;
    this.replaySegments.splice(0, this.replaySegmentStart);
    this.replaySegmentStart = 0;
  }
  notifyReplayWindowEviction(eviction) {
    try {
      this.onReplayWindowEviction?.(eviction);
    } catch {
    }
  }
  makeHistoryTruncatedEvent(retainedEvents) {
    return {
      v: EVENT_SCHEMA_VERSION,
      type: "history_truncated",
      data: {
        reason: "replay_window_exceeded",
        truncatedEvents: this.truncatedEvents,
        retainedEvents,
        maxBytes: this.maxReplayBytes,
        ...this.truncatedTurns > 0 ? { truncatedTurns: this.truncatedTurns } : {},
        // Pagination anchor for clients whose retained window lost every
        // turn-boundary event (e.g. live-journal truncation during one
        // long in-flight turn). Uses the eviction-time anchor, not
        // `activeRecordId`, so a post-seed `ingest()` can't push it past
        // records the client already displays. Undefined when no recordId
        // was observed before the first eviction — the field is
        // intentionally omitted in that case so old clients continue to
        // validate the marker shape.
        ...this.replayAnchorRecordId !== void 0 ? { recordId: this.replayAnchorRecordId } : {},
        fullTranscriptAvailable: true
      }
    };
  }
  resetReplayWindow() {
    this.replaySegments = [];
    this.replaySegmentStart = 0;
    this.replayBytes = 0;
    this.truncatedEvents = 0;
    this.truncatedTurns = 0;
    this.replayAnchorRecordId = void 0;
  }
  clearTextSlotIndex() {
    this.textSlotIndex.text.clear();
    this.textSlotIndex.thought.clear();
  }
};
function isLiveJournalTextSegment(entry) {
  return "firstEvent" in entry;
}
__name(isLiveJournalTextSegment, "isLiveJournalTextSegment");
function liveJournalTextChunk(event) {
  if (event.type !== "session_update") return void 0;
  const data = event.data;
  const sessionUpdate = data?.update?.sessionUpdate;
  if (sessionUpdate !== "agent_message_chunk" && sessionUpdate !== "agent_thought_chunk") {
    return void 0;
  }
  if (!hasOnlyModeledChunkKeys(data)) {
    return void 0;
  }
  if (hasDiscreteMessageMeta(data?.update?._meta) || hasUnmodeledTextMeta(data?.update?._meta)) {
    return void 0;
  }
  const content = data?.update?.content;
  if (content?.type !== "text" || typeof content.text !== "string") {
    return void 0;
  }
  return {
    sessionUpdate,
    text: content.text,
    sourceRecordIds: extractSourceRecordIdsFromMeta(data?.update?._meta),
    parentToolCallId: extractParentToolCallIdFromMeta(data?.update?._meta)
  };
}
__name(liveJournalTextChunk, "liveJournalTextChunk");
function hasOnlyModeledChunkKeys(data) {
  if (!data || !data.update) return false;
  const content = data.update.content;
  return Object.keys(data).every((key) => key === "sessionId" || key === "update") && Object.keys(data.update).every(
    (key) => key === "sessionUpdate" || key === "content" || key === "_meta"
  ) && (content === void 0 || typeof content === "object" && content !== null && Object.keys(content).every((key) => key === "type" || key === "text"));
}
__name(hasOnlyModeledChunkKeys, "hasOnlyModeledChunkKeys");
function mergeLiveJournalTextEvent(existing, incoming, chunks) {
  const existingData = existing.data;
  const incomingData = incoming.data;
  return {
    ...existing,
    ...incoming,
    data: {
      ...existingData,
      ...incomingData,
      update: {
        ...existingData.update,
        ...incomingData.update,
        content: { type: "text", text: chunks.join("") }
      }
    }
  };
}
__name(mergeLiveJournalTextEvent, "mergeLiveJournalTextEvent");
function makeMergedSessionUpdateEvent(sessionUpdate, text, eventId, meta, envelopeMeta, turn, sessionId) {
  return {
    id: eventId || void 0,
    v: EVENT_SCHEMA_VERSION,
    type: "session_update",
    // Re-stamp prompt/originator attribution captured from the source
    // chunks — clients rebuilding state from a compacted snapshot need
    // them for prompt correlation and originator filtering. Present only
    // when the source events carried them ("present only if set" style).
    ...turn?.promptId !== void 0 ? { promptId: turn.promptId } : {},
    ...turn?.originatorClientId !== void 0 ? { originatorClientId: turn.originatorClientId } : {},
    ...envelopeMeta !== void 0 ? { _meta: envelopeMeta } : {},
    data: {
      ...sessionId !== void 0 ? { sessionId } : {},
      update: {
        sessionUpdate,
        content: { type: "text", text },
        ...meta != null ? { _meta: meta } : {}
      }
    }
  };
}
__name(makeMergedSessionUpdateEvent, "makeMergedSessionUpdateEvent");
function captureTurnFields(event, previous) {
  const promptId = event.promptId ?? previous?.promptId;
  const originatorClientId = event.originatorClientId ?? previous?.originatorClientId;
  if (promptId === void 0 && originatorClientId === void 0) {
    return void 0;
  }
  return {
    ...promptId !== void 0 ? { promptId } : {},
    ...originatorClientId !== void 0 ? { originatorClientId } : {}
  };
}
__name(captureTurnFields, "captureTurnFields");
function captureSessionId(event) {
  const sessionId = event.data?.sessionId;
  return typeof sessionId === "string" ? sessionId : void 0;
}
__name(captureSessionId, "captureSessionId");
function normalizeToolCallType(event) {
  const data = event.data;
  if (data?.update?.sessionUpdate === "tool_call_update") {
    return {
      ...event,
      data: {
        ...data,
        update: { ...data.update, sessionUpdate: "tool_call" }
      }
    };
  }
  return event;
}
__name(normalizeToolCallType, "normalizeToolCallType");
function extractParentToolCallIdFromMeta(meta) {
  if (typeof meta === "object" && meta !== null) {
    const val = meta["parentToolCallId"];
    return typeof val === "string" && val.length > 0 ? val : void 0;
  }
  return void 0;
}
__name(extractParentToolCallIdFromMeta, "extractParentToolCallIdFromMeta");
function extractSourceRecordIdsFromMeta(meta) {
  if (typeof meta !== "object" || meta === null) return void 0;
  const transcript = meta["qwenTranscript"];
  if (typeof transcript !== "object" || transcript === null) return void 0;
  const ids = transcript["sourceRecordIds"];
  if (!Array.isArray(ids)) return void 0;
  const normalized = [
    ...new Set(ids.filter((id) => typeof id === "string"))
  ];
  return normalized.length > 0 ? normalized : void 0;
}
__name(extractSourceRecordIdsFromMeta, "extractSourceRecordIdsFromMeta");
function stringArraysEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
__name(stringArraysEqual, "stringArraysEqual");
function hasDiscreteMessageMeta(meta) {
  return typeof meta === "object" && meta !== null && meta["qwenDiscreteMessage"] === true;
}
__name(hasDiscreteMessageMeta, "hasDiscreteMessageMeta");
function hasOnlyTimestampEnvelopeMeta(meta) {
  if (meta === void 0) return true;
  if (typeof meta !== "object" || meta === null) return false;
  return Object.keys(meta).every(
    (key) => key === "timestamp" || key === "serverTimestamp"
  );
}
__name(hasOnlyTimestampEnvelopeMeta, "hasOnlyTimestampEnvelopeMeta");
function hasUnmodeledTextMeta(meta) {
  if (meta === void 0) return false;
  if (typeof meta !== "object" || meta === null) return true;
  const record = meta;
  for (const [key, value] of Object.entries(record)) {
    if (key === "timestamp" || key === "serverTimestamp") {
      continue;
    }
    if (key === "parentToolCallId") {
      if (typeof value !== "string") return true;
      continue;
    }
    if (key === "subagentType") {
      if (typeof value !== "string") return true;
      continue;
    }
    if (key === "qwenTranscript") {
      if (typeof value !== "object" || value === null) return true;
      const transcript = value;
      for (const [field, fieldValue] of Object.entries(transcript)) {
        if (field === "sourceRecordIds") {
          if (!Array.isArray(fieldValue) || fieldValue.some((id) => typeof id !== "string")) {
            return true;
          }
          continue;
        }
        if (field === "planToolCallId") {
          if (typeof fieldValue !== "string") return true;
          continue;
        }
        return true;
      }
      continue;
    }
    return true;
  }
  return false;
}
__name(hasUnmodeledTextMeta, "hasUnmodeledTextMeta");
function mergeToolCallEvent(existing, incoming) {
  const existingData = existing.data;
  const incomingData = incoming.data;
  const existingUpdate = existingData?.update ?? {};
  const incomingUpdate = incomingData?.update ?? {};
  const merged = { ...existingUpdate };
  for (const [key, value] of Object.entries(incomingUpdate)) {
    if (value !== void 0 && value !== null) {
      merged[key] = value;
    }
  }
  const updateMeta = mergeTranscriptUpdateMeta(
    existingUpdate["_meta"],
    incomingUpdate["_meta"]
  );
  if (updateMeta !== void 0) merged["_meta"] = updateMeta;
  merged["sessionUpdate"] = "tool_call";
  const mergedMeta = existing._meta || incoming._meta ? { ...existing._meta ?? {}, ...incoming._meta ?? {} } : void 0;
  const promptId = incoming.promptId ?? existing.promptId;
  const originatorClientId = incoming.originatorClientId ?? existing.originatorClientId;
  return {
    id: incoming.id ?? existing.id,
    v: EVENT_SCHEMA_VERSION,
    type: "session_update",
    ...promptId !== void 0 ? { promptId } : {},
    ...originatorClientId !== void 0 ? { originatorClientId } : {},
    ...mergedMeta ? { _meta: mergedMeta } : {},
    data: {
      ...existingData,
      ...incomingData,
      update: merged
    }
  };
}
__name(mergeToolCallEvent, "mergeToolCallEvent");
function mergeTranscriptUpdateMeta(existing, incoming) {
  const existingRecord = typeof existing === "object" && existing !== null ? existing : void 0;
  const incomingRecord = typeof incoming === "object" && incoming !== null ? incoming : void 0;
  if (!existingRecord && !incomingRecord) return void 0;
  const sourceRecordIds = [
    .../* @__PURE__ */ new Set([
      ...extractSourceRecordIdsFromMeta(existingRecord) ?? [],
      ...extractSourceRecordIdsFromMeta(incomingRecord) ?? []
    ])
  ];
  const existingTranscript = extractTranscriptMeta(existingRecord);
  const incomingTranscript = extractTranscriptMeta(incomingRecord);
  return {
    ...existingRecord ?? {},
    ...incomingRecord ?? {},
    ...existingTranscript || incomingTranscript || sourceRecordIds.length > 0 ? {
      qwenTranscript: {
        ...existingTranscript ?? {},
        ...incomingTranscript ?? {},
        ...sourceRecordIds.length > 0 ? { sourceRecordIds } : {}
      }
    } : {}
  };
}
__name(mergeTranscriptUpdateMeta, "mergeTranscriptUpdateMeta");
function extractTranscriptMeta(meta) {
  const transcript = meta?.["qwenTranscript"];
  return typeof transcript === "object" && transcript !== null ? transcript : void 0;
}
__name(extractTranscriptMeta, "extractTranscriptMeta");

// packages/acp-bridge/src/journalGrowthPolicy.ts
init_esbuild_shims();
function createJournalGrowthPolicy(opts) {
  const hardCapEvents = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(
      opts.baselineEvents,
      Math.ceil(opts.hardCapBytes / opts.baselineBytes * opts.baselineEvents)
    )
  );
  return {
    grant(request) {
      if (request.currentMaxBytes >= opts.hardCapBytes) return void 0;
      const extraGranted = request.allSessionLimits.reduce(
        (sum, session) => sum + Math.max(0, session.limitBytes - session.baselineBytes),
        0
      );
      const available = opts.poolBytes - extraGranted;
      if (available <= 0) return void 0;
      const maxBytes = Math.min(
        request.currentMaxBytes * 2,
        request.currentMaxBytes + available,
        opts.hardCapBytes
      );
      if (maxBytes <= request.currentMaxBytes) return void 0;
      const maxEvents = Math.min(
        Math.max(
          request.currentMaxEvents,
          Math.ceil(maxBytes / opts.baselineBytes * opts.baselineEvents)
        ),
        hardCapEvents
      );
      return { maxBytes, maxEvents };
    }
  };
}
__name(createJournalGrowthPolicy, "createJournalGrowthPolicy");

// packages/acp-bridge/src/session-restore-timeout.ts
init_esbuild_shims();
var DEFAULT_SESSION_RESTORE_TIMEOUT_MS = 6e4;
var MAX_SESSION_RESTORE_TIMEOUT_MS = 2147483647;
var MIN_RESTORE_RETRY_AFTER_SECONDS = 5;
var MAX_RESTORE_RETRY_AFTER_SECONDS = 120;
function restoreRetryAfterSeconds(timeoutMs) {
  return Math.min(
    MAX_RESTORE_RETRY_AFTER_SECONDS,
    Math.max(MIN_RESTORE_RETRY_AFTER_SECONDS, Math.ceil(timeoutMs / 1e3))
  );
}
__name(restoreRetryAfterSeconds, "restoreRetryAfterSeconds");
function assertValidTimeoutMs(field, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SESSION_RESTORE_TIMEOUT_MS) {
    throw new TypeError(
      `Invalid ${field}: ${timeoutMs}. Must be a positive integer no greater than ${MAX_SESSION_RESTORE_TIMEOUT_MS}.`
    );
  }
}
__name(assertValidTimeoutMs, "assertValidTimeoutMs");
function resolveSessionRestoreTimeoutMs(opts) {
  if (opts.sessionRestoreTimeoutMs !== void 0) {
    assertValidTimeoutMs(
      "sessionRestoreTimeoutMs",
      opts.sessionRestoreTimeoutMs
    );
    return opts.sessionRestoreTimeoutMs;
  }
  if (opts.initializeTimeoutMs !== void 0) {
    assertValidTimeoutMs("initializeTimeoutMs", opts.initializeTimeoutMs);
    return Math.max(
      opts.initializeTimeoutMs,
      DEFAULT_SESSION_RESTORE_TIMEOUT_MS
    );
  }
  return DEFAULT_SESSION_RESTORE_TIMEOUT_MS;
}
__name(resolveSessionRestoreTimeoutMs, "resolveSessionRestoreTimeoutMs");

// packages/acp-bridge/src/session-source.ts
init_esbuild_shims();
var SESSION_SOURCE_META_KEY = "qwen.session.source";
var SESSION_SOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
var MAX_SESSION_SOURCE_ID_LENGTH = 256;
var STANDALONE_SESSION_SOURCE_TYPE = "standalone";
var DAEMON_OWNED_STANDALONE_CREATION_KEY = "daemonOwnedStandaloneCreation";
function isReservedStandaloneSessionSourceType(sourceType) {
  return sourceType === STANDALONE_SESSION_SOURCE_TYPE;
}
__name(isReservedStandaloneSessionSourceType, "isReservedStandaloneSessionSourceType");
var SCHEDULED_TASK_RUN_SOURCE_TYPE = "default";
var SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX = "scheduled_task_run:";
function isScheduledTaskRunSource(source) {
  return source.sourceType === SCHEDULED_TASK_RUN_SOURCE_TYPE && source.sourceId?.startsWith(SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX) === true;
}
__name(isScheduledTaskRunSource, "isScheduledTaskRunSource");
function parseSessionSource(sourceType, sourceId) {
  if (sourceType === void 0 && sourceId === void 0) return {};
  if (typeof sourceType !== "string" || !SESSION_SOURCE_TYPE_PATTERN.test(sourceType)) {
    return {
      error: "`sourceType` must match [a-z][a-z0-9_-]{0,63} when provided"
    };
  }
  if (sourceId === void 0) return { sourceType };
  if (typeof sourceId !== "string" || sourceId.length === 0 || sourceId.length > MAX_SESSION_SOURCE_ID_LENGTH || [...sourceId].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) {
    return {
      error: `\`sourceId\` must be a non-empty string of at most ${MAX_SESSION_SOURCE_ID_LENGTH} characters without control characters`
    };
  }
  return { sourceType, sourceId };
}
__name(parseSessionSource, "parseSessionSource");

// packages/acp-bridge/src/sessionAttachments.ts
init_esbuild_shims();
import { constants as fsConstants, promises as fs, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
var SESSION_ATTACHMENT_MAX_ITEM_BYTES = 8 * 1024 * 1024;
var SESSION_ATTACHMENT_MAX_NAME_BYTES = 255;
var SUPPORTED_IMAGE_MIME_TYPES = /* @__PURE__ */ new Set([
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp"
]);
function hasVerifiableInode(ino) {
  return Number.isSafeInteger(ino) && ino > 0;
}
__name(hasVerifiableInode, "hasVerifiableInode");
async function openDurableAttachmentDirectory(directory, openedHandle) {
  const handle = openedHandle ?? await fs.open(
    directory,
    fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const opened = await handle.stat();
    const current = await fs.stat(directory);
    const openedInodeVerifiable = hasVerifiableInode(opened.ino);
    const currentInodeVerifiable = hasVerifiableInode(current.ino);
    if (!opened.isDirectory() || !current.isDirectory() || opened.dev !== current.dev || openedInodeVerifiable !== currentInodeVerifiable || openedInodeVerifiable && opened.ino !== current.ino) {
      throw new Error("Session attachment parent directory changed.");
    }
    return {
      path: directory,
      handle,
      dev: opened.dev,
      ino: opened.ino,
      inodeVerifiable: openedInodeVerifiable
    };
  } catch (error) {
    await handle.close().catch(() => void 0);
    throw error;
  }
}
__name(openDurableAttachmentDirectory, "openDurableAttachmentDirectory");
async function openDurableAttachmentDirectoryIfPresent(directory) {
  let handle;
  try {
    handle = await fs.open(
      directory,
      fsConstants.O_RDONLY | (process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW ?? 0)
    );
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
  return openDurableAttachmentDirectory(directory, handle);
}
__name(openDurableAttachmentDirectoryIfPresent, "openDurableAttachmentDirectoryIfPresent");
async function syncDurableAttachmentDirectory(expected) {
  const opened = await expected.handle.stat();
  const openedInodeVerifiable = hasVerifiableInode(opened.ino);
  const current = await fs.stat(expected.path);
  const currentInodeVerifiable = hasVerifiableInode(current.ino);
  if (!opened.isDirectory() || !current.isDirectory() || opened.dev !== expected.dev || openedInodeVerifiable !== expected.inodeVerifiable || expected.inodeVerifiable && opened.ino !== expected.ino || current.dev !== expected.dev || currentInodeVerifiable !== expected.inodeVerifiable || expected.inodeVerifiable && current.ino !== expected.ino) {
    throw new Error("Session attachment parent directory changed.");
  }
  try {
    await expected.handle.sync();
  } catch (error) {
    if (process.platform !== "win32" || !["EACCES", "EINVAL", "EPERM"].includes(
      error.code ?? ""
    )) {
      throw error;
    }
  }
  const after = await fs.stat(expected.path);
  const afterInodeVerifiable = hasVerifiableInode(after.ino);
  if (!after.isDirectory() || after.dev !== expected.dev || afterInodeVerifiable !== expected.inodeVerifiable || expected.inodeVerifiable && after.ino !== expected.ino) {
    throw new Error("Session attachment parent directory changed.");
  }
}
__name(syncDurableAttachmentDirectory, "syncDurableAttachmentDirectory");
var SESSION_ATTACHMENT_UNAVAILABLE_TEXT = "[Attachment is no longer available]";
var SessionAttachmentReferenceError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "SessionAttachmentReferenceError";
  }
  static {
    __name(this, "SessionAttachmentReferenceError");
  }
};
function isSessionAttachmentReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value;
  return (record["type"] === "image" || record["type"] === "resource") && typeof record["attachmentId"] === "string" && record["attachmentId"].length > 0 && typeof record["mimeType"] === "string" && record["mimeType"].length > 0 && (record["type"] !== "image" || record["mimeType"].startsWith("image/")) && typeof record["size"] === "number" && Number.isSafeInteger(record["size"]) && record["size"] >= 0 && (record["type"] !== "image" || record["size"] > 0);
}
__name(isSessionAttachmentReference, "isSessionAttachmentReference");
function safeAttachmentName(name) {
  const safeName = path.basename(name.replaceAll("\\", "/")).trim();
  const isWindowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safeName);
  const hasInvalidCharacter = Array.from(safeName).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== void 0 && (codePoint <= 31 || codePoint === 127 || codePoint >= 55296 && codePoint <= 57343);
  });
  return !safeName || safeName === "." || safeName === ".." || safeName.endsWith(".") || isWindowsReserved || /[<>:"|?*]/.test(safeName) || hasInvalidCharacter || Buffer.byteLength(safeName) > SESSION_ATTACHMENT_MAX_NAME_BYTES ? void 0 : safeName;
}
__name(safeAttachmentName, "safeAttachmentName");
function truncateUtf8(value, maxBytes) {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
__name(truncateUtf8, "truncateUtf8");
function deduplicatedName(name, suffix) {
  if (suffix === 0) return name;
  const extension = path.extname(name);
  const suffixText = ` (${suffix})`;
  const stem = name.slice(0, -extension.length || void 0);
  const extensionBudget = SESSION_ATTACHMENT_MAX_NAME_BYTES - Buffer.byteLength(suffixText) - 1;
  const safeExtension = truncateUtf8(extension, extensionBudget).replace(
    /[. ]+$/u,
    ""
  );
  const stemBudget = SESSION_ATTACHMENT_MAX_NAME_BYTES - Buffer.byteLength(suffixText) - Buffer.byteLength(safeExtension);
  return `${truncateUtf8(stem, stemBudget)}${suffixText}${safeExtension}`;
}
__name(deduplicatedName, "deduplicatedName");
function imageName(mimeType) {
  const extension = mimeType.slice("image/".length).split(/[;+]/, 1)[0];
  return `image.${extension === "jpg" ? "jpeg" : extension || "img"}`;
}
__name(imageName, "imageName");
function mimeTypeForName(name) {
  if ([".ts", ".mts", ".cts", ".tsx"].includes(path.extname(name).toLowerCase())) {
    return "text/plain";
  }
  return getSpecificMimeType(name) ?? "application/octet-stream";
}
__name(mimeTypeForName, "mimeTypeForName");
function isSupportedImageMimeType(mimeType) {
  return SUPPORTED_IMAGE_MIME_TYPES.has(mimeType);
}
__name(isSupportedImageMimeType, "isSupportedImageMimeType");
function isTextMimeType(mimeType) {
  return mimeType.startsWith("text/") || mimeType === "application/json" || mimeType.endsWith("+json") || mimeType === "application/xml" || mimeType.endsWith("+xml") || mimeType === "application/javascript" || mimeType === "application/typescript" || mimeType === "application/yaml" || mimeType === "application/x-yaml" || mimeType === "application/toml";
}
__name(isTextMimeType, "isTextMimeType");
function isTextAttachment(data, mimeType) {
  if (isTextMimeType(mimeType)) return true;
  if (mimeType.startsWith("image/") || mimeType.startsWith("audio/") || mimeType.startsWith("video/") || mimeType.startsWith("font/") || mimeType === "application/pdf" || data.includes(0)) {
    return false;
  }
  return Buffer.from(data.toString("utf8"), "utf8").equals(data);
}
__name(isTextAttachment, "isTextAttachment");
function statSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return void 0;
  }
}
__name(statSize, "statSize");
function statSizeStrict(filePath) {
  try {
    return statSync(filePath).size;
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
__name(statSizeStrict, "statSizeStrict");
function withAttachmentDegradationMarker(blocks) {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type === "text") {
      if (block.text.endsWith(SESSION_ATTACHMENT_UNAVAILABLE_TEXT)) {
        return [...blocks];
      }
      const next = [...blocks];
      next[i] = {
        type: "text",
        text: `${block.text}
${SESSION_ATTACHMENT_UNAVAILABLE_TEXT}`
      };
      return next;
    }
  }
  return [
    ...blocks,
    { type: "text", text: SESSION_ATTACHMENT_UNAVAILABLE_TEXT }
  ];
}
__name(withAttachmentDegradationMarker, "withAttachmentDegradationMarker");
var SessionAttachmentStore = class {
  constructor(directoryRoot, sessionId, fallbackDirectoryRoot) {
    this.directoryRoot = directoryRoot;
    if (!directoryRoot || !sessionId) return;
    this.persistentDirectory = path.join(
      directoryRoot,
      `session-${encodeURIComponent(sessionId)}`
    );
    if (fallbackDirectoryRoot) {
      this.persistentFallbackDirectory = path.join(
        fallbackDirectoryRoot,
        `session-${encodeURIComponent(sessionId)}`
      );
    }
  }
  static {
    __name(this, "SessionAttachmentStore");
  }
  directoryPromise;
  persistentDirectory;
  persistentFallbackDirectory;
  activeDirectory;
  pendingItems = 0;
  pendingNames = /* @__PURE__ */ new Map();
  removingNames = /* @__PURE__ */ new Set();
  pendingDrainWaiters = [];
  copyDrainWaiters = [];
  copying = false;
  closing = false;
  closed = false;
  async putAttachment(data, mimeType, name) {
    const isImage = isSupportedImageMimeType(mimeType);
    const safeName = safeAttachmentName(
      name ?? (isImage ? imageName(mimeType) : "")
    );
    if (!safeName) {
      throw new TypeError("Session attachment name is invalid");
    }
    const storedMimeType = mimeTypeForName(safeName);
    if (isImage && storedMimeType !== mimeType || isSupportedImageMimeType(storedMimeType) && !isImage) {
      throw new TypeError("Attachment name and Content-Type do not match");
    }
    if (this.closed || this.closing) {
      throw new Error("Session attachment store is closed");
    }
    if (this.copying) throw new Error("Session attachments are being copied");
    if (isImage && data.byteLength === 0 || data.byteLength > SESSION_ATTACHMENT_MAX_ITEM_BYTES) {
      throw new RangeError(
        `Session attachment must be at most ${SESSION_ATTACHMENT_MAX_ITEM_BYTES} bytes and images cannot be empty`
      );
    }
    let filePath;
    let pendingName = safeName;
    let removeFileOnFailure = false;
    this.pendingItems += 1;
    this.reservePendingName(safeName);
    try {
      const directory = await this.directory();
      let suffix = 0;
      for (; ; ) {
        const candidateName = deduplicatedName(safeName, suffix);
        if (safeAttachmentName(candidateName) !== candidateName) {
          throw new TypeError("Session attachment name is invalid");
        }
        if (this.removingNames.has(candidateName)) {
          suffix += 1;
          continue;
        }
        if (this.persistentFallbackDirectory && statSizeStrict(
          path.join(this.persistentFallbackDirectory, candidateName)
        ) !== void 0) {
          suffix += 1;
          continue;
        }
        if (pendingName !== candidateName) {
          if (pendingName) this.releasePendingName(pendingName);
          this.reservePendingName(candidateName);
          pendingName = candidateName;
        }
        filePath = path.join(directory, candidateName);
        removeFileOnFailure = true;
        try {
          await fs.writeFile(filePath, data, { flag: "wx" });
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          removeFileOnFailure = false;
          this.releasePendingName(candidateName);
          pendingName = void 0;
          filePath = void 0;
          suffix += 1;
        }
      }
      if (this.closed || this.closing) {
        throw new Error("Session attachment store is closed");
      }
      const name2 = path.basename(filePath);
      const storedMimeType2 = mimeTypeForName(name2);
      const reference = {
        type: isSupportedImageMimeType(storedMimeType2) ? "image" : "resource",
        attachmentId: name2,
        mimeType: storedMimeType2,
        size: data.byteLength
      };
      return reference;
    } catch (error) {
      if (removeFileOnFailure && filePath) {
        await fs.rm(filePath, { force: true }).catch(() => {
        });
      }
      throw error;
    } finally {
      if (pendingName) this.releasePendingName(pendingName);
      if (!this.closed) {
        this.pendingItems -= 1;
        if (this.pendingItems === 0) {
          this.resolvePendingDrainWaiters();
        }
      }
    }
  }
  // Validate one block against the store. Ordinary ACP content passes through
  // untouched, matching `assertReferences`.
  assertReference(block) {
    if (!block || typeof block !== "object" || Array.isArray(block) || !("attachmentId" in block)) {
      return;
    }
    if (!isSessionAttachmentReference(block)) {
      throw new SessionAttachmentReferenceError(
        "Invalid session attachment reference",
        "invalid_session_attachment_reference"
      );
    }
    this.assertStored(block);
  }
  assertReferences(content) {
    const seenIds = /* @__PURE__ */ new Set();
    for (const block of content) {
      if (!block || typeof block !== "object" || Array.isArray(block) || !("attachmentId" in block)) {
        continue;
      }
      if (!isSessionAttachmentReference(block)) {
        throw new SessionAttachmentReferenceError(
          "Invalid session attachment reference",
          "invalid_session_attachment_reference"
        );
      }
      const id = block.attachmentId;
      if (seenIds.has(id)) {
        throw new SessionAttachmentReferenceError(
          `Session attachment referenced more than once: ${id}`,
          "invalid_session_attachment_reference"
        );
      }
      seenIds.add(id);
      this.assertStored(block);
    }
  }
  async resolveContent(content, memo) {
    const pendingById = memo ?? /* @__PURE__ */ new Map();
    return await Promise.all(
      content.map(async (block) => {
        if (!isSessionAttachmentReference(block)) return block;
        const id = block.attachmentId;
        let pending = pendingById.get(id);
        if (!pending) {
          const created = this.resolve(block);
          pendingById.set(id, created);
          void created.catch(() => {
            if (pendingById.get(id) === created) {
              pendingById.delete(id);
            }
          });
          pending = created;
        }
        return await pending;
      })
    );
  }
  // Per-block variant of `resolveContent` for degrade paths: one unresolvable
  // reference drops only itself, keeping the sibling blocks a wholesale
  // fallback would discard. Other errors still propagate.
  async resolveContentDegrading(content, memo) {
    const retainedBlocks = [];
    const resolvedBlocks = [];
    let degraded = 0;
    for (const block of content) {
      if (!isSessionAttachmentReference(block)) {
        retainedBlocks.push(block);
        resolvedBlocks.push(block);
        continue;
      }
      try {
        const [resolved] = await this.resolveContent([block], memo);
        if (resolved) resolvedBlocks.push(resolved);
        retainedBlocks.push(block);
      } catch (error) {
        if (!(error instanceof SessionAttachmentReferenceError)) throw error;
        degraded += 1;
      }
    }
    return { retainedBlocks, resolvedBlocks, degraded };
  }
  async read(attachmentId) {
    const name = safeAttachmentName(attachmentId);
    if (!name || name !== attachmentId) return void 0;
    let primary;
    try {
      primary = await this.tryRead(await this.peekDirectory(), name);
    } catch (error) {
      if (!this.persistentFallbackDirectory) throw error;
      primary = void 0;
    }
    if (primary) return primary;
    return await this.tryRead(this.persistentFallbackDirectory, name);
  }
  async tryRead(directory, name) {
    if (!directory) return void 0;
    try {
      return {
        data: await fs.readFile(path.join(directory, name)),
        mimeType: mimeTypeForName(name)
      };
    } catch (error) {
      if (error.code === "ENOENT") return void 0;
      throw error;
    }
  }
  async list() {
    const found = [];
    const directories = [
      this.persistentDirectory ?? this.activeDirectory,
      this.persistentFallbackDirectory
    ].filter((directory) => Boolean(directory));
    const foundNames = /* @__PURE__ */ new Set();
    let directoryRead = false;
    let directoryError;
    for (const directory of directories) {
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (error.code !== "ENOENT") {
          directoryError ??= error;
        }
        continue;
      }
      directoryRead = true;
      for (const entry of entries) {
        if (!entry.isFile() || this.pendingNames.has(entry.name) || this.removingNames.has(entry.name) || foundNames.has(entry.name)) {
          continue;
        }
        const name = safeAttachmentName(entry.name);
        if (!name || name !== entry.name) continue;
        try {
          const stat = await fs.stat(path.join(directory, entry.name));
          const mimeType = mimeTypeForName(entry.name);
          found.push({
            reference: {
              type: isSupportedImageMimeType(mimeType) ? "image" : "resource",
              attachmentId: entry.name,
              mimeType,
              size: stat.size
            },
            mtimeMs: stat.mtimeMs
          });
          foundNames.add(entry.name);
        } catch {
        }
      }
    }
    if (!directoryRead && directoryError !== void 0) {
      throw directoryError;
    }
    found.sort(
      (a, b) => a.mtimeMs - b.mtimeMs || a.reference.attachmentId.localeCompare(b.reference.attachmentId)
    );
    return found.map(({ reference }) => reference);
  }
  async copyFrom(source) {
    if (source === this) return;
    if (this.closed || this.closing) {
      throw new Error("Session attachment store is closed");
    }
    if (this.copying) throw new Error("Session attachments are being copied");
    if (source.closed || source.closing) {
      throw new Error("Session attachment store is closed");
    }
    if (source.copying) {
      throw new Error("Session attachments are being copied");
    }
    this.copying = true;
    source.copying = true;
    try {
      if (this.pendingItems > 0) {
        await new Promise(
          (resolve2) => this.pendingDrainWaiters.push(resolve2)
        );
      }
      if (source.pendingItems > 0) {
        await new Promise(
          (resolve2) => source.pendingDrainWaiters.push(resolve2)
        );
      }
      if (this.closed) throw new Error("Session attachment store is closed");
      const sourceDirectories = [
        source.persistentDirectory ?? source.activeDirectory,
        source.persistentFallbackDirectory
      ].filter((directory) => Boolean(directory));
      if (sourceDirectories.length === 0) return;
      const targetDirectory = await this.directory();
      const copiedNames = /* @__PURE__ */ new Set();
      let sourceDirectoryRead = false;
      let sourceDirectoryError;
      for (const sourceDirectory of sourceDirectories) {
        let entries;
        try {
          entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
        } catch (error) {
          if (error.code === "ENOENT") continue;
          sourceDirectoryError ??= error;
          continue;
        }
        sourceDirectoryRead = true;
        await Promise.all(
          entries.filter(
            (entry) => entry.isFile() && !source.pendingNames.has(entry.name) && !source.removingNames.has(entry.name) && !copiedNames.has(entry.name)
          ).map(async (entry) => {
            const sourcePath = path.join(sourceDirectory, entry.name);
            try {
              await fs.copyFile(
                sourcePath,
                path.join(targetDirectory, entry.name)
              );
              copiedNames.add(entry.name);
            } catch (error) {
              if (error.code === "ENOENT") {
                try {
                  await fs.stat(sourcePath);
                } catch (sourceError) {
                  if (sourceError.code === "ENOENT") {
                    return;
                  }
                }
              }
              throw error;
            }
          })
        );
      }
      if (!sourceDirectoryRead && sourceDirectoryError !== void 0) {
        throw sourceDirectoryError;
      }
    } finally {
      source.copying = false;
      this.copying = false;
      source.resolveCopyDrainWaiters();
      this.resolveCopyDrainWaiters();
    }
  }
  async remove(attachmentId) {
    const name = safeAttachmentName(attachmentId);
    if (!name || name !== attachmentId || this.copying || this.pendingNames.has(name) || this.removingNames.has(name)) {
      return false;
    }
    this.removingNames.add(name);
    try {
      const primaryDirectory = await this.peekDirectory();
      const [fallbackExists, primaryExists] = await Promise.all([
        this.hasAttachment(this.persistentFallbackDirectory, name),
        this.hasAttachment(primaryDirectory, name)
      ]);
      const fallbackHit = fallbackExists && await this.tryUnlink(this.persistentFallbackDirectory, name) === true;
      const primaryHit = primaryExists && await this.tryUnlink(primaryDirectory, name) === true;
      return primaryHit || fallbackHit;
    } finally {
      this.removingNames.delete(name);
    }
  }
  async hasAttachment(directory, name) {
    if (!directory) return false;
    try {
      await fs.stat(path.join(directory, name));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }
  async tryUnlink(directory, name) {
    if (!directory) return void 0;
    try {
      await fs.unlink(path.join(directory, name));
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return void 0;
      throw error;
    }
  }
  async close() {
    this.closing = true;
    await this.waitForCopy();
    if (this.closed) return;
    this.closed = true;
    this.pendingItems = 0;
    this.pendingNames.clear();
    this.resolvePendingDrainWaiters();
    if (this.persistentDirectory || !this.directoryPromise) return;
    const directory = await this.directoryPromise.catch(() => void 0);
    if (!directory) return;
    await fs.rm(directory, { recursive: true, force: true });
  }
  async delete(options = {}) {
    options.assertCanCommit?.();
    this.closing = true;
    await this.waitForCopy();
    options.assertCanCommit?.();
    if (!this.closed) {
      this.closed = true;
      this.pendingItems = 0;
      this.pendingNames.clear();
      this.resolvePendingDrainWaiters();
    }
    let fallbackError;
    if (this.persistentFallbackDirectory) {
      try {
        await this.removeDirectoryDurably(
          this.persistentFallbackDirectory,
          options.assertCanCommit
        );
      } catch (error) {
        fallbackError = error;
      }
    }
    const directory = this.persistentDirectory ?? await this.directoryPromise?.catch(() => void 0);
    if (directory) {
      await this.removeDirectoryDurably(directory, options.assertCanCommit);
    }
    if (fallbackError !== void 0) throw fallbackError;
  }
  /**
   * Delete `directory` through a fixed-name tombstone while holding an open
   * handle to its parent, re-checking the parent's identity and syncing it
   * after each mutation. The FIXED tombstone name lets a deletion interrupted
   * between the rename and the removal resume on the next call instead of
   * leaking the tombstone, and a successor directory recreated at the
   * original path after the rename is never swept up by the removal.
   */
  async removeDirectoryDurably(directory, assertCanCommit) {
    assertCanCommit?.();
    const parent = await openDurableAttachmentDirectoryIfPresent(
      path.dirname(directory)
    );
    if (!parent) return;
    const tombstone = path.join(
      path.dirname(directory),
      `.${path.basename(directory)}.deleting`
    );
    try {
      assertCanCommit?.();
      let tombstoneExists = false;
      try {
        const stats = await fs.lstat(tombstone);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
          throw new Error("Session attachment tombstone is not a directory.");
        }
        tombstoneExists = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (tombstoneExists) {
        assertCanCommit?.();
        await fs.rm(tombstone, { recursive: true, force: true });
        await syncDurableAttachmentDirectory(parent);
        return;
      }
      assertCanCommit?.();
      try {
        await fs.rename(directory, tombstone);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        try {
          const stats = await fs.lstat(tombstone);
          if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new Error("Session attachment tombstone is not a directory.");
          }
          assertCanCommit?.();
          await fs.rm(tombstone, { recursive: true, force: true });
        } catch (tombstoneError) {
          if (tombstoneError.code !== "ENOENT") {
            throw tombstoneError;
          }
        }
        await syncDurableAttachmentDirectory(parent);
        return;
      }
      await fs.rm(tombstone, { recursive: true, force: true });
      await syncDurableAttachmentDirectory(parent);
    } finally {
      await parent.handle.close().catch(() => void 0);
    }
  }
  assertStored(reference) {
    const id = reference.attachmentId;
    const name = safeAttachmentName(id);
    let size;
    const directory = this.persistentDirectory ?? this.activeDirectory;
    if (name && name === id && directory) {
      size = statSize(path.join(directory, name));
      if (size === void 0 && this.persistentFallbackDirectory) {
        size = statSize(path.join(this.persistentFallbackDirectory, name));
      }
    }
    const storedMimeType = name ? mimeTypeForName(name) : void 0;
    const storedType = storedMimeType ? isSupportedImageMimeType(storedMimeType) ? "image" : "resource" : void 0;
    if (size !== reference.size || storedMimeType !== reference.mimeType || storedType !== reference.type) {
      throw new SessionAttachmentReferenceError(
        `Unknown or unavailable session attachment: ${id}`,
        "session_attachment_gone"
      );
    }
  }
  releasePendingName(name) {
    const count = this.pendingNames.get(name) ?? 0;
    if (count <= 1) this.pendingNames.delete(name);
    else this.pendingNames.set(name, count - 1);
  }
  reservePendingName(name) {
    this.pendingNames.set(name, (this.pendingNames.get(name) ?? 0) + 1);
  }
  async waitForCopy() {
    while (this.copying) {
      await new Promise((resolve2) => this.copyDrainWaiters.push(resolve2));
    }
  }
  resolveCopyDrainWaiters() {
    for (const resolve2 of this.copyDrainWaiters.splice(0)) resolve2();
  }
  resolvePendingDrainWaiters() {
    for (const resolve2 of this.pendingDrainWaiters.splice(0)) resolve2();
  }
  async resolve(reference) {
    const id = reference.attachmentId;
    const attachment = await this.read(id);
    if (!attachment) {
      throw new SessionAttachmentReferenceError(
        `Unknown or unavailable session attachment: ${id}`,
        "session_attachment_gone"
      );
    }
    if (reference.type === "resource") {
      const resource = {
        uri: `attachment:///${encodeURIComponent(reference.attachmentId)}`,
        mimeType: attachment.mimeType,
        ...isTextAttachment(attachment.data, attachment.mimeType) ? { text: attachment.data.toString("utf8") } : { blob: attachment.data.toString("base64") }
      };
      return {
        type: "resource",
        resource
      };
    }
    return {
      type: "image",
      data: attachment.data.toString("base64"),
      mimeType: attachment.mimeType
    };
  }
  // The storage directory without forcing creation: reads and removes must
  // degrade to the fallback when the configured root is unavailable, not
  // fail on a forced mkdir of a degraded volume.
  async peekDirectory() {
    const established = await this.directoryPromise?.catch(() => void 0);
    return established ?? this.persistentDirectory;
  }
  async directory() {
    if (!this.directoryPromise) {
      const pending = this.persistentDirectory ? fs.mkdir(this.persistentDirectory, {
        recursive: true,
        mode: 448
      }).then(() => this.persistentDirectory) : this.directoryRoot ? fs.mkdir(this.directoryRoot, { recursive: true, mode: 448 }).then(
        () => fs.mkdtemp(
          path.join(this.directoryRoot, "session-attachment-")
        )
      ) : fs.mkdtemp(path.join(tmpdir(), "qwen-session-attachment-"));
      const directoryPromise = pending.then((directory) => {
        this.activeDirectory = directory;
        return directory;
      });
      this.directoryPromise = directoryPromise;
      void directoryPromise.catch(() => {
        if (this.directoryPromise === directoryPromise)
          this.directoryPromise = void 0;
      });
    }
    return await this.directoryPromise;
  }
};

// packages/acp-bridge/src/bridgeClient.ts
init_esbuild_shims();
import { randomUUID as randomUUID2 } from "node:crypto";
import { promises as fs2 } from "node:fs";
import * as path2 from "node:path";

// packages/acp-bridge/src/daemonEventTypes.ts
init_esbuild_shims();
var MID_TURN_MESSAGE_INJECTED_EVENT = "mid_turn_message_injected";

// packages/acp-bridge/src/permissionMediator.ts
init_esbuild_shims();

// packages/acp-bridge/src/permission.ts
init_esbuild_shims();

// packages/acp-bridge/src/permissionMediator.ts
var CANCEL_VOTE_SENTINEL = "__cancelled__";
var MAX_RESOLVED_PERMISSION_RECORDS = 512;
function stringifyError(err) {
  try {
    if (err instanceof Error) return `${err.name}: ${err.message}`;
    return String(err);
  } catch {
    return "[unstringifiable error]";
  }
}
__name(stringifyError, "stringifyError");
function createNoOpPermissionAuditPublisher() {
  return {
    recordRequested() {
    },
    recordVoted() {
    },
    recordForbidden() {
    },
    recordResolved() {
    },
    recordTimeout() {
    }
  };
}
__name(createNoOpPermissionAuditPublisher, "createNoOpPermissionAuditPublisher");
var MultiClientPermissionMediator = class {
  static {
    __name(this, "MultiClientPermissionMediator");
  }
  policy;
  deps;
  pending = /* @__PURE__ */ new Map();
  resolved = /* @__PURE__ */ new Map();
  resolvedOrder = [];
  /**
   * Dedup flag for the
   * unanimity-required stderr breadcrumb. Without this, every
   * permission request on a 2-client consensus session would emit
   * an identical line (the unanimity condition is the NORMAL
   * operating mode for M=2, not a rare edge); a busy session with
   * many tool calls would produce dozens of duplicate stderr lines
   * within seconds. One emit per mediator (= per bridge/runtime lifetime
   * since each bridge constructs one) is enough to make the
   * configuration visible without spam.
   */
  unanimityBreadcrumbEmitted = false;
  constructor(policy, deps) {
    this.policy = policy;
    this.deps = deps;
  }
  /**
   * Register a fresh permission request from the agent.
   *
   * **Promise contract — once the Promise is returned, it never
   * rejects.** All runtime failure modes (timeout, session closure,
   * voter cancel, emit/audit publisher exceptions) are encoded as
   * `PermissionResolution { kind:'cancelled', reason:... }`.
   * Consumers can `await` the returned Promise and forward the
   * result without a `.catch()` block.
   *
   * **Synchronous-throw exception**:
   * when the agent's `allowedOptionIds` contains the
   * cancel-vote sentinel string, this method throws
   * `CancelSentinelCollisionError` synchronously BEFORE constructing
   * the Promise. The synchronous shape is intentional — a
   * never-settling Promise alongside a thrown error would be worse
   * than a clean fail-fast — but callers must wrap this method
   * itself in `try/catch` (or call it from an `async` function so
   * the throw bubbles via the function's own Promise machinery).
   * `bridgeClient.ts` currently has its own pre-check at the bridge
   * layer; embedded callers must do the same. See `@throws` below.
   *
   * **Synchronous-register invariant**: pending entry, audit
   * record, and timer setup all happen inside the Promise executor
   * without `await`. The bridge's `publish → mediator.request → await`
   * sequence relies on this — a `forgetSession` between publish and
   * await would otherwise miss the new pending and leak it until
   * timeout.
   *
   * @throws `CancelSentinelCollisionError` SYNCHRONOUSLY (not as a
   *   Promise rejection) if `record.allowedOptionIds` contains the
   *   cancel-vote sentinel string. This is a contract violation
   *   between agent and daemon and fails loudly at issue time
   *   rather than silently miscounting votes downstream. Callers
   *   inside an `async` function get the thrown error through the
   *   function's own Promise; synchronous callers must use
   *   `try/catch`.
   */
  request(record, timeoutMs) {
    if (record.allowedOptionIds.has(CANCEL_VOTE_SENTINEL)) {
      throw new CancelSentinelCollisionError(
        record.requestId,
        CANCEL_VOTE_SENTINEL
      );
    }
    return new Promise((resolve2) => {
      const policy = this.policy;
      const votersAtIssue = this.deps.votersForSession(record.sessionId);
      const pending = {
        requestId: record.requestId,
        sessionId: record.sessionId,
        promptId: record.promptId,
        policy,
        originatorClientId: record.originatorClientId,
        allowedOptionIds: record.allowedOptionIds,
        issuedAtMs: record.issuedAtMs,
        timeoutMs,
        resolve: resolve2,
        tallies: /* @__PURE__ */ new Map(),
        votersAtIssue,
        timer: void 0,
        consensusQuorumCapNoted: false
      };
      this.pending.set(record.requestId, pending);
      this.safeAudit(
        () => this.deps.audit.recordRequested(record, policy, votersAtIssue)
      );
      const unresolvedWithoutDecision = timeoutMs > 0 ? `voter cancellation, session cancellation, or permissionTimeoutMs (${timeoutMs}ms)` : "voter or session cancellation because permissionTimeoutMs is disabled";
      if (policy === "consensus" && votersAtIssue.size === 0) {
        try {
          process.stderr.write(
            `permissionMediator: consensus request ${record.requestId} for session ${record.sessionId} issued with empty votersAtIssue; can only resolve via ${unresolvedWithoutDecision}
`
          );
        } catch {
        }
      }
      if (policy === "consensus" && this.deps.consensusQuorum === void 0 && votersAtIssue.size >= 2 && Math.floor(votersAtIssue.size / 2) + 1 === votersAtIssue.size && !this.unanimityBreadcrumbEmitted) {
        this.unanimityBreadcrumbEmitted = true;
        try {
          process.stderr.write(
            `permissionMediator: consensus request ${record.requestId} for session ${record.sessionId} requires unanimity (votersAtIssue.size=${votersAtIssue.size}, default quorum=floor(M/2)+1=${votersAtIssue.size}); split votes will only resolve via ${unresolvedWithoutDecision}. This breadcrumb fires once per mediator lifetime; subsequent unanimity-required requests are silent.
`
          );
        } catch {
        }
      }
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.pending.get(record.requestId) !== pending) return;
          const firedAtMs = this.deps.now();
          try {
            process.stderr.write(
              `qwen serve: permission ${record.requestId} (session ${record.sessionId}) timed out after ${timeoutMs}ms
`
            );
          } catch {
          }
          this.safeAudit(() => this.deps.audit.recordTimeout(record));
          this.resolveEntry(
            pending,
            { kind: "cancelled", reason: "timeout" },
            {
              type: "timeout",
              issuedAtMs: pending.issuedAtMs,
              timeoutMs: pending.timeoutMs,
              firedAtMs
            },
            void 0
          );
        }, timeoutMs);
        const t = pending.timer;
        if (t && typeof t === "object" && "unref" in t) {
          t.unref();
        }
      }
    });
  }
  vote(vote) {
    const pending = this.pending.get(vote.requestId);
    if (!pending) {
      const prior = this.resolved.get(vote.requestId);
      if (prior && prior.sessionId === vote.sessionId) {
        const optionId = prior.resolution.kind === "option" ? prior.resolution.optionId : CANCEL_VOTE_SENTINEL;
        this.safeEmit(prior.sessionId, {
          type: "permission_already_resolved",
          ...prior.promptId ? { promptId: prior.promptId } : {},
          data: {
            requestId: prior.requestId,
            sessionId: prior.sessionId,
            outcome: this.toAcpOutcome(prior.resolution)
          }
        });
        return { kind: "already_resolved", resolvedOptionId: optionId };
      }
      return { kind: "unknown_request" };
    }
    if (pending.sessionId !== vote.sessionId) {
      return { kind: "unknown_request" };
    }
    if (vote.optionId === CANCEL_VOTE_SENTINEL) {
      const outcome = {
        kind: "resolved",
        resolvedOptionId: CANCEL_VOTE_SENTINEL
      };
      this.safeAudit(
        () => this.deps.audit.recordVoted(this.toRecord(pending), vote, outcome)
      );
      this.resolveEntry(
        pending,
        { kind: "cancelled", reason: "agent_cancelled" },
        {
          type: "voter-cancelled",
          resolverClientId: vote.clientId
        },
        vote.clientId
      );
      return outcome;
    }
    if (!pending.allowedOptionIds.has(vote.optionId)) {
      throw new InvalidPermissionOptionError(vote.requestId, vote.optionId);
    }
    switch (pending.policy) {
      case "first-responder":
        return this.voteFirstResponder(pending, vote);
      case "designated":
        return this.voteDesignated(pending, vote);
      case "consensus":
        return this.voteConsensus(pending, vote);
      case "local-only":
        return this.voteLocalOnly(pending, vote);
      default: {
        const _exhaustive = pending.policy;
        void _exhaustive;
        throw new Error(`Unknown permission policy "${pending.policy}"`);
      }
    }
  }
  forgetSession(sessionId) {
    const requestIds = [];
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) requestIds.push(id);
    }
    for (const id of requestIds) {
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.resolveEntry(
        pending,
        { kind: "cancelled", reason: "session_closed" },
        { type: "session-closed" },
        void 0
      );
    }
  }
  /**
   * Per-turn sibling of `forgetSession`: resolves every pending request
   * whose `(sessionId, promptId)` matches as agent-cancelled. A background
   * notification turn can end (or be aborted) while its approval is still
   * outstanding; the bridge attributes those requests to the turn's id, so
   * finishing the turn cancels exactly them and leaves a concurrently live
   * user prompt's requests pending.
   */
  cancelForPrompt(sessionId, promptId) {
    const requestIds = [];
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId && pending.promptId === promptId)
        requestIds.push(id);
    }
    for (const id of requestIds) {
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.resolveEntry(
        pending,
        { kind: "cancelled", reason: "agent_cancelled" },
        { type: "agent-cancelled" },
        void 0
      );
    }
  }
  /**
   * Lookup the sessionId for a given requestId. Used by the legacy
   * `bridge.respondToPermission(requestId, ...)` route which doesn't
   * carry a sessionId in the URL. NOT part of the
   * `PermissionMediator` interface contract — bridge holds the
   * concrete class reference and calls this directly.
   */
  peekSessionFor(requestId) {
    const pending = this.pending.get(requestId);
    if (pending) return pending.sessionId;
    const prior = this.resolved.get(requestId);
    return prior?.sessionId;
  }
  /**
   * Daemon-wide in-flight pending count for diagnostics. The bridge
   * exposes this through its `pendingPermissionCount` getter so
   * operators can spot stuck FIFOs without reaching into mediator
   * internals. NOT part of the `PermissionMediator` interface
   * contract.
   */
  get pendingCount() {
    return this.pending.size;
  }
  // ===========================================================
  // Per-policy vote handlers
  // ===========================================================
  voteFirstResponder(pending, vote) {
    return this.resolveWithVote(pending, vote, {
      type: "first-responder",
      resolverClientId: vote.clientId
    });
  }
  voteDesignated(pending, vote) {
    if (pending.originatorClientId === void 0) {
      return this.voteFirstResponder(pending, vote);
    }
    if (vote.clientId !== pending.originatorClientId) {
      return this.rejectForbidden(
        pending,
        vote,
        "designated_mismatch",
        "designated_mismatch (voter is not the prompt originator)"
      );
    }
    return this.resolveWithVote(pending, vote, {
      type: "designated-originator",
      originatorClientId: pending.originatorClientId
    });
  }
  voteConsensus(pending, vote) {
    if (vote.clientId === void 0 || !pending.votersAtIssue.has(vote.clientId)) {
      return this.rejectForbidden(
        pending,
        vote,
        "designated_mismatch",
        "designated_mismatch (voter not in consensus votersAtIssue snapshot)"
      );
    }
    for (const [originalOptionId, set] of pending.tallies.entries()) {
      if (vote.clientId !== void 0 && set.has(vote.clientId)) {
        const outcome2 = {
          kind: "recorded",
          votesNeeded: this.votesNeededFor(pending)
        };
        this.safeAudit(
          () => this.deps.audit.recordVoted(
            this.toRecord(pending),
            { ...vote, optionId: originalOptionId },
            outcome2
          )
        );
        return outcome2;
      }
    }
    let bucket = pending.tallies.get(vote.optionId);
    if (!bucket) {
      bucket = /* @__PURE__ */ new Set();
      pending.tallies.set(vote.optionId, bucket);
    }
    bucket.add(vote.clientId);
    const quorum = this.consensusQuorumFor(pending);
    if (bucket.size >= quorum) {
      return this.resolveWithVote(pending, vote, {
        type: "consensus-quorum",
        resolvedOptionId: vote.optionId,
        quorum,
        tally: bucket.size
      });
    }
    const outcome = {
      kind: "recorded",
      votesNeeded: this.votesNeededFor(pending)
    };
    this.safeAudit(
      () => this.deps.audit.recordVoted(this.toRecord(pending), vote, outcome)
    );
    this.safeEmit(pending.sessionId, {
      type: "permission_partial_vote",
      ...pending.promptId ? { promptId: pending.promptId } : {},
      data: {
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        votesReceived: this.totalTalliedFor(pending),
        votesNeeded: outcome.votesNeeded,
        quorum,
        optionTallies: this.optionTalliesFor(pending)
      },
      ...pending.originatorClientId !== void 0 ? { originatorClientId: pending.originatorClientId } : {}
    });
    return outcome;
  }
  /**
   * Vote dispatch for `local-only` policy: only `fromLoopback: true`
   * voters can resolve a permission.
   *
   * **Cancel-sentinel asymmetry** (cancel-sentinel note).
   * `vote()` recognizes the cancel sentinel BEFORE calling this
   * method (cross-policy escape hatch — see the
   * `CANCEL_VOTE_SENTINEL` JSDoc for the rationale), so a remote
   * voter under `local-only` CAN abort a pending permission via
   * `{outcome:'cancelled'}` even though they cannot RESOLVE one. The
   * settings-side description for `local-only` and the design doc call
   * out this gap explicitly. Operators who want strict-cancel-too
   * semantics must (a) deploy a dedicated daemon process at
   * loopback bind, OR (b) wait for the follow-up PR that lifts
   * cancel into per-policy gating; This version keeps the current
   * cross-policy cancel for consistency with first-responder /
   * designated / consensus.
   */
  voteLocalOnly(pending, vote) {
    if (!vote.fromLoopback) {
      return this.rejectForbidden(
        pending,
        vote,
        "remote_not_allowed",
        "remote_not_allowed (local-only policy; vote not from loopback)"
      );
    }
    return this.resolveWithVote(pending, vote, {
      type: "local-only-loopback",
      resolverClientId: vote.clientId
    });
  }
  // ===========================================================
  // Shared vote-resolution helpers
  // ===========================================================
  resolveWithVote(pending, vote, decisionReason) {
    const outcome = {
      kind: "resolved",
      resolvedOptionId: vote.optionId
    };
    this.safeAudit(
      () => this.deps.audit.recordVoted(this.toRecord(pending), vote, outcome)
    );
    this.resolveEntry(
      pending,
      {
        kind: "option",
        optionId: vote.optionId,
        ...vote.metadata ? { metadata: vote.metadata } : {}
      },
      decisionReason,
      vote.clientId
    );
    return outcome;
  }
  rejectForbidden(pending, vote, reason, stderrDetail) {
    this.safeAudit(
      () => this.deps.audit.recordForbidden(this.toRecord(pending), vote, reason)
    );
    this.safeEmit(pending.sessionId, {
      type: "permission_forbidden",
      ...pending.promptId ? { promptId: pending.promptId } : {},
      data: {
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        ...vote.clientId !== void 0 ? { clientId: vote.clientId } : {},
        reason
      },
      ...pending.originatorClientId !== void 0 ? { originatorClientId: pending.originatorClientId } : {}
    });
    this.writeForbiddenStderr(pending, vote, stderrDetail);
    return { kind: "forbidden", reason };
  }
  // ===========================================================
  // Consensus tally helpers
  // ===========================================================
  /**
   * Compute the quorum size for a `consensus` request. Default
   * `floor(M/2) + 1` of `votersAtIssue.size`; overridden by
   * `deps.consensusQuorum` when set, capped to `M` so an operator
   * misconfig (N > M) can't deadlock.
   *
   * When the cap fires, write
   * a one-time stderr breadcrumb per request so operators don't
   * have to diff their `policy.consensusQuorum` against
   * `votersAtIssue.size` manually to understand why a quorum
   * resolved sooner than configured. Tracked on `MediatorPending`
   * so the breadcrumb fires once even though `consensusQuorumFor`
   * may be called multiple times per request (vote tally + final
   * resolution).
   */
  consensusQuorumFor(pending) {
    const m = pending.votersAtIssue.size;
    const override = this.deps.consensusQuorum;
    if (override !== void 0) {
      const capped = Math.min(override, Math.max(m, 1));
      if (capped < override && !pending.consensusQuorumCapNoted) {
        pending.consensusQuorumCapNoted = true;
        try {
          process.stderr.write(
            `permissionMediator: consensusQuorum override ${override} capped to ${capped} (votersAtIssue.size=${m}) for request ${pending.requestId} session ${pending.sessionId}
`
          );
        } catch {
        }
      }
      return capped;
    }
    return Math.max(1, Math.floor(m / 2) + 1);
  }
  totalTalliedFor(pending) {
    let total = 0;
    for (const set of pending.tallies.values()) total += set.size;
    return total;
  }
  /**
   * `votesNeeded` = `quorum - max(tally per option)`. When no
   * option has any votes (degenerate; `permission_partial_vote`
   * is only emitted AFTER the first vote, so this should never
   * appear on the wire), returns `quorum` itself. Always ≥ 1
   * because the resolved-on-quorum path returns before this
   * helper runs.
   */
  votesNeededFor(pending) {
    const quorum = this.consensusQuorumFor(pending);
    let max = 0;
    for (const set of pending.tallies.values()) {
      if (set.size > max) max = set.size;
    }
    return Math.max(quorum - max, 1);
  }
  optionTalliesFor(pending) {
    const out = {};
    for (const [optionId, set] of pending.tallies) {
      out[optionId] = set.size;
    }
    return out;
  }
  // ===========================================================
  // Resolution + cleanup
  // ===========================================================
  /**
   * Settle a pending entry. Cleanup order is hardened (cleanup-order invariant):
   *   1. clearTimeout (so a timer can never fire on a half-cleaned entry).
   *   2. Delete from `pending` (state-first half — entry no longer
   *      reachable for new votes).
   *   3. emit wire `permission_resolved` (best-effort — emit failures
   *      do not block the Promise settle). MUST come before step 4
   *      so a re-entrant subscriber synchronously casting another
   *      vote during emit sees `pending === undefined && resolved
   *      === undefined` (silent false), matching the previous ordering.
   *
   *   4. write to `resolved` (the second half of state move — late
   *      voters arriving after this see `permission_already_resolved`).
   *   5. audit.recordResolved (best-effort, same).
   *   6. Settle the Promise (LAST — callbacks running re-entrantly
   *      see consistent state).
   *
   * Previously the spec bundled
   * "delete pending + write resolved" into step 2 ahead of emit,
   * which contradicted the code. The fix
   * splits the two halves of the state move around the emit so
   * the spec faithfully describes the ordering invariant.
   *
   * @param resolverClientId  wire compat: the
   *   `permission_resolved` SSE frame stamps this as
   *   `originatorClientId`. The previous `resolvePending` in
   *   `httpAcpBridge.ts:1518-1523` filled it from the voter's
   *   trusted clientId. We preserve byte-for-byte; vote-driven
   *   paths pass `vote.clientId` (which may be undefined for
   *   loopback no-header voters); timer + session-closed paths
   *   pass undefined (no voter).
   */
  resolveEntry(pending, resolution, decisionReason, resolverClientId) {
    if (this.pending.get(pending.requestId) !== pending) {
      return;
    }
    if (pending.timer !== void 0) {
      clearTimeout(pending.timer);
      pending.timer = void 0;
    }
    this.pending.delete(pending.requestId);
    this.safeEmit(pending.sessionId, {
      type: "permission_resolved",
      ...pending.promptId ? { promptId: pending.promptId } : {},
      data: {
        requestId: pending.requestId,
        outcome: this.toAcpOutcome(resolution),
        // Note: `voterClientId` is the canonical,
        // unambiguous name for "who cast the resolving vote". The envelope
        // `originatorClientId` below carries the SAME value for wire
        // compat (it is semantically the voter on `permission_resolved`,
        // unlike on `permission_request` where it is the prompt originator).
        // Both are optional and omitted together for no-voter resolutions
        // (timer expiry / session-closed / loopback voter with no clientId).
        ...resolverClientId !== void 0 ? { voterClientId: resolverClientId } : {}
      },
      // Preserve pre-extraction behavior: voter's clientId is stamped
      // here (not the prompt originator's). Documented inconsistency
      // with `permission_request.originatorClientId` (which IS the
      // prompt originator); we do not fix the inconsistency to
      // avoid breaking the wire shape. A4 keeps it as a deprecated
      // alias of `data.voterClientId`.
      ...resolverClientId !== void 0 ? { originatorClientId: resolverClientId } : {}
    });
    this.rememberResolved({
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      promptId: pending.promptId,
      resolution,
      resolverClientId
    });
    if (decisionReason !== void 0) {
      this.safeAudit(
        () => this.deps.audit.recordResolved(
          this.toRecord(pending),
          resolution,
          decisionReason
        )
      );
    }
    pending.resolve(resolution);
  }
  rememberResolved(record) {
    if (!this.resolved.has(record.requestId)) {
      this.resolvedOrder.push(record.requestId);
    }
    this.resolved.set(record.requestId, record);
    while (this.resolvedOrder.length > MAX_RESOLVED_PERMISSION_RECORDS) {
      const oldest2 = this.resolvedOrder.shift();
      if (oldest2 !== void 0) this.resolved.delete(oldest2);
    }
  }
  safeEmit(sessionId, event) {
    try {
      this.deps.emit(sessionId, event);
    } catch (err) {
      try {
        process.stderr.write(
          `permissionMediator: emit failed for session=${JSON.stringify(sessionId)} type=${JSON.stringify(event.type)}: ${stringifyError(err)}
`
        );
      } catch {
      }
    }
  }
  /**
   * Emit a stderr breadcrumb
   * for every vote rejection (the three forbidden paths in
   * voteDesignated / voteConsensus / voteLocalOnly). Mirrors the
   * timeout breadcrumb pattern: audit ring + SSE event are
   * transient observability surfaces (no v1 query route, SSE drops
   * on disconnect), so an operator tailing daemon stderr would see
   * zero indication of permission rejections without this.
   *
   * Wrapped in `try/catch` because `process.stderr.write` can
   * synchronously throw on EPIPE during shutdown — a stderr
   * unavailability must not propagate up through `safeEmit` /
   * `safeAudit` and break the resolveEntry cleanup ladder. Mirrors
   * the safeEmit/safeAudit defensive posture (see the
   * matching hang scenario in safeEmit).
   */
  writeForbiddenStderr(pending, vote, reasonDetail) {
    try {
      const voterDescriptor = vote.clientId === void 0 ? "<anonymous>" : JSON.stringify(vote.clientId);
      process.stderr.write(
        `qwen serve: permission ${pending.requestId} (session ${pending.sessionId}): vote rejected (${reasonDetail}) by client ${voterDescriptor}
`
      );
    } catch {
    }
  }
  /**
   * Run an audit-publisher call defensively. The audit ring is
   * best-effort observability — a publisher exception (ring full,
   * host bug, transient I/O) MUST NOT throw out of `request()`,
   * `vote()`, or the timer callback. Without this guard, the
   * Promise the agent is awaiting would be left unsettled and the
   * pending entry would leak.
   *
   * Single helper used at all five audit call sites so the
   * "audit is best-effort" invariant is uniformly enforced (the
   * pre-fix asymmetric `try/catch` at 2 of 5 sites was a real
   * silent-failure hole.
   *
   * doc placement — JSDoc was previously
   * stacked above `writeForbiddenStderr` so IDE hover and API
   * doc generation showed the wrong attribution. Moved adjacent
   * to its actual definition.
   */
  safeAudit(fn) {
    try {
      fn();
    } catch (err) {
      try {
        process.stderr.write(
          `permissionMediator: audit publisher threw: ${stringifyError(err)}
`
        );
      } catch {
      }
    }
  }
  toRecord(pending) {
    return {
      requestId: pending.requestId,
      sessionId: pending.sessionId,
      ...pending.promptId ? { promptId: pending.promptId } : {},
      originatorClientId: pending.originatorClientId,
      allowedOptionIds: pending.allowedOptionIds,
      issuedAtMs: pending.issuedAtMs
    };
  }
  toAcpOutcome(resolution) {
    if (resolution.kind === "option") {
      return { outcome: "selected", optionId: resolution.optionId };
    }
    return { outcome: "cancelled" };
  }
};

// packages/acp-bridge/src/bridgeClient.ts
var MAX_SCHEDULED_TASK_CRON_CHARS = 200;
var MAX_SCHEDULED_TASK_PROMPT_CHARS = 1e5;
var SCHEDULED_TASK_RUN_CONTEXT_HEADROOM_CHARS = 1024;
function parseActiveWorkSnapshot(params) {
  const seq = params["seq"];
  const sessions = params["sessions"];
  if (params["v"] !== ACTIVE_WORK_HEARTBEAT_VERSION || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0 || !Array.isArray(sessions) || sessions.length > ACTIVE_WORK_MAX_SNAPSHOT_SESSIONS) {
    return void 0;
  }
  const parsed = [];
  for (const raw of sessions) {
    if (typeof raw !== "object" || raw === null) return void 0;
    const entry = raw;
    const sessionId = entry["sessionId"];
    const holds = entry["holds"];
    if (typeof sessionId !== "string" || !Array.isArray(holds) || holds.length > ACTIVE_WORK_MAX_SESSION_HOLDS) {
      return void 0;
    }
    const finishedBackgroundTurnId = entry["finishedBackgroundTurnId"];
    if (finishedBackgroundTurnId !== void 0 && (typeof finishedBackgroundTurnId !== "string" || !finishedBackgroundTurnId || finishedBackgroundTurnId.length > 256))
      return void 0;
    const parsedHolds = [];
    for (const rawHold of holds) {
      if (typeof rawHold !== "object" || rawHold === null) return void 0;
      const hold = rawHold;
      const category = hold["category"];
      const id = hold["id"];
      if (typeof id !== "string" || typeof category !== "string" || !ACTIVE_WORK_HOLD_CATEGORIES.includes(
        category
      )) {
        return void 0;
      }
      parsedHolds.push({
        category,
        id
      });
    }
    parsed.push({
      sessionId,
      holds: parsedHolds,
      ...finishedBackgroundTurnId ? { finishedBackgroundTurnId } : {},
      ...typeof entry["hasRunningBackgroundTasks"] === "boolean" ? { hasRunningBackgroundTasks: entry["hasRunningBackgroundTasks"] } : {}
    });
  }
  return { v: ACTIVE_WORK_HEARTBEAT_VERSION, seq, sessions: parsed };
}
__name(parseActiveWorkSnapshot, "parseActiveWorkSnapshot");
var PUBLISH_ARTIFACT_TOOL_NAME = "artifact";
var MAX_CHANNEL_DELIVERY_TEXT_CHARS = 1e5;
var MAX_CHANNEL_DELIVERY_FIELD_CHARS = 2048;
var MAX_CHANNEL_DELIVERY_ERROR_CHARS = 500;
function isFsErrorShape(err) {
  return err instanceof Error && err.name === "FsError" && typeof err.kind === "string";
}
__name(isFsErrorShape, "isFsErrorShape");
function isExistingSessionScheduledTaskCreateErrorShape(err) {
  if (!(err instanceof Error)) return false;
  const status = err.status;
  const code = err.code;
  return err.name === "ExistingSessionScheduledTaskCreateError" && typeof status === "number" && Number.isFinite(status) && typeof code === "string" && code.length > 0;
}
__name(isExistingSessionScheduledTaskCreateErrorShape, "isExistingSessionScheduledTaskCreateErrorShape");
function isRecord6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord6, "isRecord");
function normalizeExternalToolGuardResult(value) {
  if (!isRecord6(value)) {
    throw new Error("External tool guard handler returned an invalid result.");
  }
  const keys = Object.keys(value);
  if (value["allowed"] === true && keys.length === 1 && keys[0] === "allowed") {
    return { allowed: true };
  }
  if (value["allowed"] !== false || keys.some((key) => key !== "allowed" && key !== "reason")) {
    throw new Error("External tool guard handler returned an invalid result.");
  }
  if (!Object.hasOwn(value, "reason")) return { allowed: false };
  const reason = value["reason"];
  if (!isValidExternalToolGuardDenialReason(reason)) {
    throw new Error("External tool guard handler returned an invalid result.");
  }
  return { allowed: false, reason };
}
__name(normalizeExternalToolGuardResult, "normalizeExternalToolGuardResult");
function isBoundedChannelDeliveryString(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_CHANNEL_DELIVERY_FIELD_CHARS;
}
__name(isBoundedChannelDeliveryString, "isBoundedChannelDeliveryString");
function isChannelDeliveryTarget(value) {
  if (!isRecord6(value)) return false;
  return isBoundedChannelDeliveryString(value["channelName"]) && (value["type"] === "user" || value["type"] === "chat") && isBoundedChannelDeliveryString(value["id"]) && Object.keys(value).every(
    (key) => key === "channelName" || key === "type" || key === "id"
  );
}
__name(isChannelDeliveryTarget, "isChannelDeliveryTarget");
function normalizeChannelDeliveryHostResult(value) {
  if (value.status === "delivered") return { status: "delivered" };
  if (value.status === "skipped") return { status: "skipped" };
  const code = CHANNEL_DELIVERY_ERROR_CODES.has(value.code) ? value.code : "channel_delivery_failed";
  const error = typeof value.error === "string" && value.error.length > 0 ? value.error.slice(0, MAX_CHANNEL_DELIVERY_ERROR_CHARS) : "Channel delivery failed.";
  return { status: "failed", code, error };
}
__name(normalizeChannelDeliveryHostResult, "normalizeChannelDeliveryHostResult");
function pendingInteractionOptions(options) {
  return options.map((option) => ({
    optionId: String(option.optionId ?? ""),
    ...typeof option.name === "string" ? { label: option.name } : {},
    ...typeof option.kind === "string" ? { kind: option.kind } : {}
  }));
}
__name(pendingInteractionOptions, "pendingInteractionOptions");
function pendingInteractionFromRequest(requestId, params) {
  const toolCall = params.toolCall;
  const meta = isRecord6(toolCall["_meta"]) ? toolCall["_meta"] : void 0;
  const rawInput = toolCall["rawInput"];
  const options = pendingInteractionOptions(
    Array.isArray(params.options) ? params.options : []
  );
  const isUserQuestion = meta?.["qwenInteractionKind"] === "user_question";
  if (isUserQuestion) {
    const rawQuestions = Array.isArray(meta?.["qwenQuestions"]) ? meta["qwenQuestions"] : isRecord6(rawInput) && Array.isArray(rawInput["questions"]) ? rawInput["questions"] : [];
    return {
      requestId,
      kind: "user_question",
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      ...typeof toolCall["title"] === "string" ? { title: toolCall["title"] } : {},
      questions: rawQuestions.flatMap(
        (question, index) => isRecord6(question) ? [{ ...question, answerKey: String(index) }] : []
      ),
      options
    };
  }
  return {
    requestId,
    kind: "permission",
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    action: {
      ...typeof toolCall["kind"] === "string" ? { type: toolCall["kind"] } : {},
      ...typeof toolCall["title"] === "string" ? { title: toolCall["title"] } : {},
      ...toolCall["content"] !== void 0 ? { content: toolCall["content"] } : {},
      ...toolCall["locations"] !== void 0 ? { locations: toolCall["locations"] } : {},
      ...rawInput !== void 0 ? { input: rawInput } : {}
    },
    options
  };
}
__name(pendingInteractionFromRequest, "pendingInteractionFromRequest");
function fallbackPendingPermissionInteraction(requestId, options) {
  return {
    requestId,
    kind: "permission",
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    action: {},
    options: pendingInteractionOptions(options)
  };
}
__name(fallbackPendingPermissionInteraction, "fallbackPendingPermissionInteraction");
function artifactPayloadFields(artifact) {
  return {
    title: artifact["title"],
    kind: artifact["kind"],
    storage: artifact["storage"],
    description: artifact["description"],
    workspacePath: artifact["workspacePath"],
    managedId: artifact["managedId"],
    url: artifact["url"],
    mimeType: artifact["mimeType"],
    sizeBytes: artifact["sizeBytes"],
    metadata: artifact["metadata"],
    retention: artifact["retention"]
  };
}
__name(artifactPayloadFields, "artifactPayloadFields");
function extractCappedArtifactInputs(rawArtifacts, limit, sessionId, source, toInput) {
  const artifacts = [];
  for (let index = 0; index < rawArtifacts.length; index++) {
    const artifact = rawArtifacts[index];
    if (!isRecord6(artifact)) {
      writeStderrLine(
        `[artifacts] session=${sessionId} action=dropped reason=malformed source=${source} index=${index}`
      );
      continue;
    }
    if (artifacts.length >= limit) {
      writeStderrLine(
        `[artifacts] session=${sessionId} action=dropped reason="artifact batch limit exceeded" source=${source} dropped=${rawArtifacts.length - index}`
      );
      break;
    }
    artifacts.push(toInput(artifact));
  }
  return artifacts;
}
__name(extractCappedArtifactInputs, "extractCappedArtifactInputs");
function artifactIngestionErrorReason(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack?.split("\n").slice(0, 4).join("\n")
  };
}
__name(artifactIngestionErrorReason, "artifactIngestionErrorReason");
function extractSessionUpdateArtifacts(params, updateMeta, limit, sessionId) {
  const rawArtifacts = updateMeta?.["artifacts"];
  if (!Array.isArray(rawArtifacts)) {
    return [];
  }
  const update = params.update;
  if (update.sessionUpdate !== "tool_call_update" || update.status !== "completed" && update.status !== "failed" && update.status !== "cancelled") {
    return [];
  }
  const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : void 0;
  const toolName = typeof updateMeta?.["toolName"] === "string" ? updateMeta["toolName"] : void 0;
  return extractCappedArtifactInputs(
    rawArtifacts,
    limit,
    sessionId,
    "tool",
    (artifact) => ({
      ...artifactPayloadFields(artifact),
      source: "tool",
      toolCallId,
      toolName
    })
  );
}
__name(extractSessionUpdateArtifacts, "extractSessionUpdateArtifacts");
function sanitizeSessionUpdateArtifacts(params, updateMeta) {
  if (!Array.isArray(updateMeta?.["artifacts"])) {
    return params;
  }
  const sanitizedMeta = { ...updateMeta };
  delete sanitizedMeta["artifacts"];
  const update = {
    ...params.update,
    _meta: sanitizedMeta
  };
  return {
    ...params,
    update
  };
}
__name(sanitizeSessionUpdateArtifacts, "sanitizeSessionUpdateArtifacts");
function isTrustedArtifactToolUpdate(params, updateMeta) {
  const update = params.update;
  return update.sessionUpdate === "tool_call_update" && update.status === "completed" && updateMeta?.["toolName"] === PUBLISH_ARTIFACT_TOOL_NAME;
}
__name(isTrustedArtifactToolUpdate, "isTrustedArtifactToolUpdate");
function preserveFsErrorOverAcp(err) {
  if (isFsErrorShape(err)) {
    const code = err.kind === "parse_error" ? -32602 : -32603;
    throw new RequestError(code, err.message, {
      errorKind: err.kind,
      ...err.hint !== void 0 ? { hint: err.hint } : {},
      ...err.status !== void 0 ? { status: err.status } : {}
    });
  }
  throw err;
}
__name(preserveFsErrorOverAcp, "preserveFsErrorOverAcp");
function preserveScheduledTaskCreateErrorOverAcp(err) {
  if (isExistingSessionScheduledTaskCreateErrorShape(err)) {
    throw new RequestError(err.status >= 500 ? -32603 : -32602, err.message, {
      errorKind: err.code,
      status: err.status,
      hint: err.message
    });
  }
  throw err;
}
__name(preserveScheduledTaskCreateErrorOverAcp, "preserveScheduledTaskCreateErrorOverAcp");
function resolutionToAcpResponse(resolution) {
  if (resolution.kind === "option") {
    return {
      outcome: { outcome: "selected", optionId: resolution.optionId },
      ...resolution.metadata ?? {}
    };
  }
  return {
    outcome: { outcome: "cancelled" },
    _meta: {
      [DAEMON_PERMISSION_CANCEL_REASON_META_KEY]: resolution.reason
    }
  };
}
__name(resolutionToAcpResponse, "resolutionToAcpResponse");
var MAX_EARLY_EVENT_SESSIONS = 64;
var MAX_EARLY_EVENTS_PER_SESSION = 32;
var MAX_SUGGESTION_LENGTH = 500;
var EARLY_EVENT_TTL_MS = 6e4;
var KNOWN_APPROVAL_MODES = new Set(
  APPROVAL_MODES
);
function describeStatKind(stats) {
  if (stats.isDirectory()) return "directory";
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isCharacterDevice()) return "character device";
  if (stats.isBlockDevice()) return "block device";
  if (stats.isFIFO()) return "named pipe (FIFO)";
  if (stats.isSocket()) return "socket";
  return "non-regular file";
}
__name(describeStatKind, "describeStatKind");
function sliceLineRange(content, startLine, endLine) {
  let offset = 0;
  for (let i = 0; i < startLine; i++) {
    const nl = content.indexOf("\n", offset);
    if (nl === -1) return "";
    offset = nl + 1;
  }
  if (endLine === void 0) return content.slice(offset);
  let end = offset;
  const want = endLine - startLine;
  for (let i = 0; i < want; i++) {
    const nl = content.indexOf("\n", end);
    if (nl === -1) return content.slice(offset);
    end = nl + 1;
  }
  return content.slice(offset, end > offset ? end - 1 : end);
}
__name(sliceLineRange, "sliceLineRange");
function currentTurnMetadata(entry) {
  const background = entry?.promptActive ? void 0 : entry?.backgroundTurn;
  const promptId = background?.turnId ?? entry?.activePromptId;
  return {
    ...promptId ? { promptId } : {},
    ...!background && entry?.activePromptOriginatorClientId ? { originatorClientId: entry.activePromptOriginatorClientId } : {}
  };
}
__name(currentTurnMetadata, "currentTurnMetadata");
function ownsActivePrompt(entry, promptId) {
  return entry.backgroundTurn?.turnId === promptId || entry.promptActive === true && entry.activePromptId === promptId;
}
__name(ownsActivePrompt, "ownsActivePrompt");
var BridgeClient = class {
  constructor(resolveEntry, resolvePendingRestoreEvents, mediator, permissionTimeoutMs, maxPendingPerSession, fileSystem, onModelPromoted, onModePromoted, clientMcpSender, ownsSession = () => true, onTokenUsage, onCreateSubSession, onGenerationEvent, onWorkspaceGenerationEvent, onChannelDelivery, hasSessionSpawnInFlight = () => false, getLiveScreenContextCaptureHandler = () => void 0, getLiveTaskToolRequestHandler = () => void 0, getLiveSpeakToUserHandler = () => void 0, externalToolGuard, onActiveWork, onSessionCatalogChanged, onAutomaticTurnEnded, onCreateCurrentSessionScheduledTask, onBackgroundTurnStart) {
    this.resolveEntry = resolveEntry;
    this.resolvePendingRestoreEvents = resolvePendingRestoreEvents;
    this.mediator = mediator;
    this.permissionTimeoutMs = permissionTimeoutMs;
    this.maxPendingPerSession = maxPendingPerSession;
    this.fileSystem = fileSystem;
    this.onModelPromoted = onModelPromoted;
    this.onModePromoted = onModePromoted;
    this.clientMcpSender = clientMcpSender;
    this.ownsSession = ownsSession;
    this.onTokenUsage = onTokenUsage;
    this.onCreateSubSession = onCreateSubSession;
    this.onGenerationEvent = onGenerationEvent;
    this.onWorkspaceGenerationEvent = onWorkspaceGenerationEvent;
    this.onChannelDelivery = onChannelDelivery;
    this.hasSessionSpawnInFlight = hasSessionSpawnInFlight;
    this.getLiveScreenContextCaptureHandler = getLiveScreenContextCaptureHandler;
    this.getLiveTaskToolRequestHandler = getLiveTaskToolRequestHandler;
    this.getLiveSpeakToUserHandler = getLiveSpeakToUserHandler;
    this.externalToolGuard = externalToolGuard;
    this.onActiveWork = onActiveWork;
    this.onSessionCatalogChanged = onSessionCatalogChanged;
    this.onAutomaticTurnEnded = onAutomaticTurnEnded;
    this.onCreateCurrentSessionScheduledTask = onCreateCurrentSessionScheduledTask;
    this.onBackgroundTurnStart = onBackgroundTurnStart;
  }
  static {
    __name(this, "BridgeClient");
  }
  async requestPermission(params) {
    const entry = this.resolveEntry(params.sessionId);
    if (!entry) return { outcome: { outcome: "cancelled" } };
    const explicitBackgroundTurn = parseBackgroundNotificationTurn(
      params._meta?.["backgroundTurn"]
    );
    if (explicitBackgroundTurn && entry.backgroundTurn?.turnId !== explicitBackgroundTurn.turnId) {
      return { outcome: { outcome: "cancelled" } };
    }
    const backgroundTurn = explicitBackgroundTurn ?? (entry.promptActive ? void 0 : entry.backgroundTurn);
    const permissionPromptId = backgroundTurn?.turnId ?? entry.activePromptId;
    const permissionOriginator = backgroundTurn ? void 0 : entry.activePromptOriginatorClientId;
    if (entry.pendingPermissionIds.size >= this.maxPendingPerSession) {
      writeStderrLine(
        `qwen serve: session ${entry.sessionId} exceeded maxPendingPermissionsPerSession (${this.maxPendingPerSession}) \u2014 resolving new permission as cancelled.`
      );
      return { outcome: { outcome: "cancelled" } };
    }
    const options = Array.isArray(params.options) ? params.options : [];
    const allowedOptionIds = new Set(
      options.map((o) => String(o.optionId ?? ""))
    );
    allowedOptionIds.delete("");
    const requestId = randomUUID2();
    if (allowedOptionIds.has(CANCEL_VOTE_SENTINEL)) {
      throw new CancelSentinelCollisionError(requestId, CANCEL_VOTE_SENTINEL);
    }
    const published = entry.events.publish({
      type: "permission_request",
      ...permissionPromptId ? { promptId: permissionPromptId } : {},
      data: {
        ...backgroundTurn ? { backgroundTurn } : {},
        requestId,
        sessionId: entry.sessionId,
        toolCall: params.toolCall,
        options
      },
      ...permissionOriginator ? { originatorClientId: permissionOriginator } : {}
    });
    if (!published) return { outcome: { outcome: "cancelled" } };
    let interaction;
    try {
      interaction = pendingInteractionFromRequest(requestId, {
        ...params,
        options
      });
    } catch (error) {
      writeStderrLine(
        `qwen serve: failed to snapshot pending interaction ${requestId}: ${error instanceof Error ? error.message : String(error)}`
      );
      interaction = fallbackPendingPermissionInteraction(requestId, options);
    }
    entry.pendingPermissionIds.add(requestId);
    if (interaction) entry.pendingInteractions.set(requestId, interaction);
    try {
      const record = {
        requestId,
        sessionId: entry.sessionId,
        promptId: permissionPromptId,
        originatorClientId: permissionOriginator,
        allowedOptionIds,
        issuedAtMs: Date.now()
      };
      const resolution = await this.mediator.request(
        record,
        this.permissionTimeoutMs
      );
      return resolutionToAcpResponse(resolution);
    } finally {
      entry.pendingPermissionIds.delete(requestId);
      entry.pendingInteractions.delete(requestId);
    }
  }
  async sessionUpdate(params) {
    if (this.abandonedRestoreIds.has(params.sessionId)) {
      return;
    }
    if (!this.ownsSession(params.sessionId) && !this.inFlightRestoreIds.has(params.sessionId)) {
      writeStderrLine(
        `[demux] session=${params.sessionId} type=session_update action=dropped reason=session_not_owned`
      );
      return;
    }
    const entry = this.resolveEntry(params.sessionId);
    const events = entry?.events ?? this.resolvePendingRestoreEvents(params.sessionId);
    if (!events) return;
    const prepared = this.prepareSessionUpdateFrames(params, entry);
    for (const frame of prepared.frames) {
      events.publish(frame);
    }
    try {
      this.recordLiveTokenUsage(params, entry);
    } catch {
    }
    if (entry && prepared.artifacts.length > 0) {
      await this.upsertAndPublishArtifacts(
        entry,
        prepared.artifacts,
        {
          trustedPublisher: prepared.trustedPublisher
        },
        prepared.turn
      );
    }
  }
  prepareSessionUpdateFrames(params, entry) {
    const executionMeta = params.update._meta;
    const taskCompleted = executionMeta?.["source"] === "background_task_completed";
    const backgroundTurn = parseBackgroundNotificationTurn(
      executionMeta?.["backgroundTurn"]
    );
    const promptId = taskCompleted ? void 0 : backgroundTurn?.turnId ?? entry?.activePromptId;
    const turn = {
      ...promptId ? { promptId } : {},
      ...!taskCompleted && !backgroundTurn && (entry?.promptActive || !entry?.backgroundTurn) && entry?.activePromptOriginatorClientId ? { originatorClientId: entry.activePromptOriginatorClientId } : {}
    };
    const frames = [];
    const a2ui = extractA2uiToolUpdate(params);
    if (a2ui) {
      for (const surface of a2ui.surfaces) {
        frames.push({
          type: "session_update",
          data: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: "a2ui",
              a2ui: {
                surfaceId: surface.surfaceId,
                callId: a2ui.callId,
                commands: surface.commands
              },
              _meta: { serverTimestamp: Date.now(), source: "a2ui-bridge" }
            }
          },
          ...turn
        });
      }
      params = a2ui.sanitizedParams;
    }
    const updateMeta = params.update._meta;
    const originalTs = updateMeta?.["serverTimestamp"] ?? updateMeta?.["timestamp"];
    const serverTimestamp = typeof originalTs === "number" && Number.isFinite(originalTs) ? originalTs : void 0;
    const artifacts = entry?.artifacts ? extractSessionUpdateArtifacts(
      params,
      updateMeta,
      entry.artifacts.inputBatchLimit(),
      entry.sessionId
    ) : [];
    const publishParams = sanitizeSessionUpdateArtifacts(params, updateMeta);
    frames.push({
      type: "session_update",
      data: publishParams,
      ...turn,
      ...serverTimestamp !== void 0 ? { _meta: { serverTimestamp } } : {}
    });
    return {
      frames,
      artifacts,
      trustedPublisher: isTrustedArtifactToolUpdate(params, updateMeta),
      turn
    };
  }
  async seedSessionUpdates(entry, updates, options = {}) {
    const frames = [];
    const artifactBatches = [];
    for (const update of updates) {
      const prepared = this.prepareSessionUpdateFrames(
        { sessionId: entry.sessionId, update },
        entry
      );
      frames.push(...prepared.frames);
      if (options.ingestArtifacts !== false && prepared.artifacts.length > 0) {
        artifactBatches.push({
          artifacts: prepared.artifacts,
          trustedPublisher: prepared.trustedPublisher,
          turn: prepared.turn
        });
      }
    }
    entry.events.seedReplayEvents(frames);
    for (const batch of artifactBatches) {
      await this.upsertAndPublishArtifacts(
        entry,
        batch.artifacts,
        {
          trustedPublisher: batch.trustedPublisher
        },
        batch.turn
      );
    }
  }
  async ingestSessionUpdateArtifactsReady(entry, updates) {
    for (const update of updates) {
      const prepared = this.prepareSessionUpdateFrames(
        { sessionId: entry.sessionId, update },
        entry
      );
      if (prepared.artifacts.length === 0) continue;
      const ingested = await this.upsertAndPublishArtifactsReady(
        entry,
        prepared.artifacts,
        { trustedPublisher: prepared.trustedPublisher },
        prepared.turn
      );
      if (!ingested) throw new Error("Artifact ingestion failed.");
    }
  }
  async drainDeferredSessionArtifacts(entry) {
    while (entry.deferredArtifactBatches.length > 0) {
      const batch = entry.deferredArtifactBatches[0];
      const ingested = await this.upsertAndPublishArtifactsReady(
        entry,
        batch.artifacts,
        batch.options,
        batch.turn
      );
      if (!ingested) throw new Error("Deferred artifact ingestion failed.");
      entry.deferredArtifactBatches.shift();
      entry.deferredArtifactInputCount -= batch.artifacts.length;
    }
  }
  /**
   * Daemon token-burn accounting for LIVE model turns. Called only from
   * `sessionUpdate` (the live session/update fan-in), never from
   * `seedSessionUpdates` — so batch load-replay never lands historical usage in
   * the current metrics window. Additionally guarded on a live `entry`: a stray
   * pending-restore frame (entry not yet registered) is skipped too, so replayed
   * history can't post a phantom burn spike with no model call.
   *
   * Usage rides an otherwise-empty `agent_message_chunk` as `update._meta.usage`
   * with per-round camelCase increments; subagent frames carry their own usage
   * (tagged `parentToolCallId`) and are independent turns, so counting each
   * frame once is the correct total. `_meta`/`usage` are optional and untyped.
   */
  recordLiveTokenUsage(params, entry) {
    if (!this.onTokenUsage || !entry) return;
    const updateMeta = params.update._meta;
    const usage = updateMeta?.["usage"];
    if (usage === null || typeof usage !== "object") return;
    const inputTokens = usage.inputTokens;
    const outputTokens = usage.outputTokens;
    if (typeof inputTokens !== "number" && typeof outputTokens !== "number") {
      return;
    }
    const durationMs = updateMeta?.["durationMs"];
    const apiErrors = updateMeta?.["apiErrors"];
    const apiRetries = updateMeta?.["apiRetries"];
    this.onTokenUsage(
      typeof inputTokens === "number" ? inputTokens : 0,
      typeof outputTokens === "number" ? outputTokens : 0,
      typeof durationMs === "number" ? durationMs : void 0,
      typeof apiErrors === "number" ? apiErrors : 0,
      typeof apiRetries === "number" ? apiRetries : 0
    );
  }
  /**
   * Bounded early-event buffer. The map is scoped to this BridgeClient and
   * therefore to one channel; a stale channel cannot seed a fresh channel's
   * future session. Frames are keyed by sessionId; each entry tracks its
   * `expiresAt` for lazy TTL-based eviction in `bufferEarlyEvent`. Drained by
   * `drainEarlyEvents` whenever the bridge registers a session with a matching
   * id. See MAX_EARLY_EVENT_* constants for capacity bounds.
   */
  earlyEvents = /* @__PURE__ */ new Map();
  /**
   * Tombstone for closed/killed session ids. Prevents late
   * `extNotification` from a dying child from leaking into the
   * early-event buffer and being replayed onto a future session
   * that reuses the same id via `session/load` or `session/resume`.
   *
   * Tombstone semantics:
   * - Marked when the bridge removes a sessionId from `byId` (kill
   *   path, channel.exited handler, closeSession).
   * - Concurrently purges any in-flight `earlyEvents[id]`.
   * - `bufferEarlyEvent` rejects tombstoned ids.
   * - `drainEarlyEvents` clears the tombstone — a fresh
   *   `createSessionEntry` for the same id is a legitimate
   *   "load/resume of a persisted session id" case.
   * - TTL = `EARLY_EVENT_TTL_MS` (60s) — same as the early-event
   *   buffer, so by the time a tombstone expires there can be no
   *   stale frame for that id anywhere in the system.
   */
  tombstonedSessionIds = /* @__PURE__ */ new Map();
  /** Restore ownership for `sessionUpdate` and artifact demultiplexing. */
  inFlightRestoreIds = /* @__PURE__ */ new Set();
  /**
   * Registrations allowed to buffer early extended notifications through an
   * ordinary close tombstone. This includes restores and caller-supplied-id
   * spawns, and lasts only until their ACP registration attempt settles.
   */
  inFlightSessionRegistrationIds = /* @__PURE__ */ new Set();
  /**
   * Restore ids whose caller timed out while the non-cancellable ACP request
   * continues.
   */
  abandonedRestoreIds = /* @__PURE__ */ new Set();
  finishBackgroundTurn(sessionId, turnId, reason) {
    const entry = this.resolveEntry(sessionId);
    if (!entry || !this.ownsSession(sessionId) || entry.backgroundTurn?.turnId !== turnId)
      return;
    const backgroundTurn = entry.backgroundTurn;
    delete entry.backgroundTurn;
    this.mediator.cancelForPrompt(sessionId, turnId);
    entry.events.publish({
      type: "turn_complete",
      promptId: turnId,
      data: {
        sessionId,
        promptId: turnId,
        stopReason: reason,
        backgroundTurn
      }
    });
    entry.events.publish({
      type: "background_notification_turn_complete",
      promptId: turnId,
      data: { sessionId, reason, turnId }
    });
    this.onAutomaticTurnEnded?.(sessionId);
  }
  /**
   * Handle child->bridge ACP `extMethod` requests (calls that expect a
   * response, unlike `extNotification`). Served methods:
   * `qwen/control/client_mcp/message` (reverse tool channel),
   * `qwen/control/create-sub-session` (the `create_sub_session` tool → daemon
   * spawns a sub-session and, for `'first-turn'`, returns its first-turn
   * result), and `craft/drainMidTurnQueue`: the ACP child calls the last one
   * between tool batches to pull any messages the browser queued mid-turn. We splice the per-session
   * queue, return them to the child as the response, and — when non-empty —
   * publish a `mid_turn_message_injected` SSE frame so the browser can move
   * those messages out of its pending queue and render the immediate echo.
   * Unknown methods reject with ACP `methodNotFound` (-32601), matching
   * the SDK's
   * default for an unimplemented client surface; the child's drain caller
   * treats that as "drain unsupported" and stops asking.
   */
  async extMethod(method, params) {
    if (method === "_qwencode/start_turn") {
      const sessionId2 = params["sessionId"];
      const turn = parseBackgroundNotificationTurn(params);
      const afterPromptId = params["afterPromptId"];
      if (typeof sessionId2 !== "string" || !this.ownsSession(sessionId2) || params["source"] !== "background_notification" || !turn || afterPromptId !== void 0 && typeof afterPromptId !== "string")
        return { accepted: false };
      const entry2 = this.resolveEntry(sessionId2);
      if (!entry2) return { accepted: false };
      const alreadyStarted = entry2.backgroundTurn?.turnId === turn.turnId;
      if (this.onBackgroundTurnStart) {
        if (!await this.onBackgroundTurnStart(sessionId2, turn, afterPromptId))
          return { accepted: false };
      } else {
        if (!alreadyStarted && (entry2.promptActive || entry2.goalTurnActive || entry2.backgroundTurn))
          return { accepted: false };
        entry2.backgroundTurn = turn;
      }
      if (alreadyStarted) return { accepted: true };
      entry2.events.publish({
        type: "session_update",
        promptId: turn.turnId,
        data: {
          sessionId: sessionId2,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: turn.label ?? turn.taskId },
            _meta: {
              source: "background_notification_turn_started",
              qwenDiscreteMessage: true,
              backgroundTurn: turn
            }
          }
        }
      });
      return { accepted: true };
    }
    if (method === SERVE_CONTROL_EXT_METHODS.clientMcpMessage) {
      return this.handleClientMcpMessage(params);
    }
    if (method === SERVE_CONTROL_EXT_METHODS.createSubSession) {
      return this.handleCreateSubSession(params);
    }
    if (method === SERVE_CONTROL_EXT_METHODS.createCurrentSessionScheduledTask) {
      return this.handleCreateCurrentSessionScheduledTask(params);
    }
    if (method === SERVE_CONTROL_EXT_METHODS.liveCaptureScreenContext) {
      return this.handleLiveScreenContextCapture(params);
    }
    if (method === SERVE_CONTROL_EXT_METHODS.liveTaskTool) {
      return this.handleLiveTaskTool(params);
    }
    if (method === SERVE_CONTROL_EXT_METHODS.liveSpeakToUser) {
      return this.handleLiveSpeakToUser(params);
    }
    if (method === SERVE_CONTROL_EXT_METHODS.channelDelivery) {
      return this.handleChannelDelivery(params);
    }
    if (method === SERVE_CONTROL_EXT_METHODS.externalToolGuardPrepare) {
      return this.handleExternalToolGuardPrepare(params);
    }
    if (method === TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD) {
      return this.handleTodoStopGuardContinuationClaim(params);
    }
    if (method !== MID_TURN_QUEUE_DRAIN_METHOD) {
      throw RequestError.methodNotFound(method);
    }
    const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : void 0;
    if (!sessionId) return { messages: [], items: [], hasQueuedPrompt: false };
    if (!this.ownsSession(sessionId)) {
      return { messages: [], items: [], hasQueuedPrompt: false };
    }
    const entry = this.resolveEntry(sessionId);
    if (!entry) return { messages: [], items: [], hasQueuedPrompt: false };
    const requestedPromptId = params["promptId"];
    if (requestedPromptId !== void 0 && (typeof requestedPromptId !== "string" || !ownsActivePrompt(entry, requestedPromptId) || entry.promptActive === true && requestedPromptId !== entry.activePromptId)) {
      return { messages: [], items: [], hasQueuedPrompt: false };
    }
    const promptId = requestedPromptId ?? currentTurnMetadata(entry).promptId;
    const drained = entry.midTurnMessageQueue.splice(0);
    if (drained.length > 0) {
      for (const item of drained) {
        entry.settledMidTurnMessageIds.push(item.messageId);
      }
      if (entry.settledMidTurnMessageIds.length > MID_TURN_RECONCILIATION_RING_SIZE) {
        entry.settledMidTurnMessageIds.splice(
          0,
          entry.settledMidTurnMessageIds.length - MID_TURN_RECONCILIATION_RING_SIZE
        );
      }
    }
    const attachmentMemo = /* @__PURE__ */ new Map();
    const serializedAttachmentIds = /* @__PURE__ */ new Set();
    const items = [];
    try {
      for (const item of drained) {
        let degraded = 0;
        const planned = (item.content ?? []).filter((block) => {
          if (!isSessionAttachmentReference(block)) return true;
          if (serializedAttachmentIds.has(block.attachmentId)) {
            degraded += 1;
            return false;
          }
          serializedAttachmentIds.add(block.attachmentId);
          return true;
        });
        let resolvedBlocks;
        let attachmentReferences;
        try {
          resolvedBlocks = await entry.attachments.resolveContent(
            planned,
            attachmentMemo
          );
          attachmentReferences = planned.filter(isSessionAttachmentReference);
        } catch (error) {
          if (!(error instanceof SessionAttachmentReferenceError)) throw error;
          writeStderrLine(
            `[mid-turn] session=${JSON.stringify(entry.sessionId)} degraded attachment for message ${JSON.stringify(item.messageId)}: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`
          );
          const perBlock = await entry.attachments.resolveContentDegrading(
            planned,
            attachmentMemo
          );
          resolvedBlocks = perBlock.resolvedBlocks;
          attachmentReferences = perBlock.retainedBlocks.filter(
            isSessionAttachmentReference
          );
          degraded += perBlock.degraded;
        }
        let content = [
          ...item.text ? [{ type: "text", text: item.text }] : [],
          ...resolvedBlocks
        ];
        if (degraded > 0) content = withAttachmentDegradationMarker(content);
        items.push({
          messageId: item.messageId,
          displayText: item.text,
          content,
          ...attachmentReferences.length > 0 ? { attachmentReferences } : {}
        });
      }
    } catch (error) {
      const requeued = new Set(drained.map((queued) => queued.messageId));
      const ring = entry.settledMidTurnMessageIds;
      const kept = ring.filter((id) => !requeued.has(id));
      ring.splice(0, ring.length, ...kept);
      entry.midTurnMessageQueue.unshift(...drained);
      writeStderrLine(
        `[mid-turn] session=${JSON.stringify(entry.sessionId)} drain failed, requeued ${drained.length} message(s): ${JSON.stringify(error instanceof Error ? error.message : String(error))}`
      );
      throw error;
    }
    const echoed = drained.filter((item) => !item.queueOnly);
    const messages = drained.map((item) => item.text);
    const hasQueuedPrompt = entry.pendingPromptList.some(
      (prompt) => prompt.state === "queued" && !prompt.abortController.signal.aborted
    );
    if (echoed.length > 0) {
      const published = entry.events.publish({
        type: MID_TURN_MESSAGE_INJECTED_EVENT,
        ...promptId ? { promptId } : {},
        data: {
          sessionId: entry.sessionId,
          messages: echoed.map((item) => item.text),
          messageIds: echoed.map((item) => item.messageId),
          // Carry the structured `items` twin (content blocks per message) so
          // the browser-side echo renderer can show attached images alongside
          // the message text. Older consumers that don't read this field keep
          // working unchanged.
          items: echoed.map((item) => ({
            ...item.content && item.content.length > 0 ? { content: item.content } : {}
          }))
        }
      });
      writeStderrLine(
        published ? `[mid-turn] session=${entry.sessionId} drained=${messages.length} echoed=${echoed.length} injected into running turn` : `[mid-turn] session=${entry.sessionId} drained=${messages.length} echoed=${echoed.length} echo frame dropped (bus closed); reconciliation required`
      );
    }
    return { messages, items, hasQueuedPrompt };
  }
  async handleExternalToolGuardPrepare(params) {
    if (!this.externalToolGuard) {
      throw RequestError.methodNotFound(
        SERVE_CONTROL_EXT_METHODS.externalToolGuardPrepare
      );
    }
    const sessionId = params["sessionId"];
    const promptId = params["promptId"];
    const toolCallId = params["toolCallId"];
    const toolName = params["toolName"];
    const args = params["arguments"];
    if (typeof sessionId !== "string" || sessionId.length === 0 || promptId !== void 0 && (typeof promptId !== "string" || promptId.length === 0) || typeof toolCallId !== "string" || toolCallId.length === 0 || typeof toolName !== "string" || toolName.length === 0 || !isRecord6(args)) {
      throw RequestError.invalidParams(
        void 0,
        "Invalid external tool guard request"
      );
    }
    const promptScoped = promptId !== void 0;
    if (!this.ownsSession(sessionId)) {
      throw RequestError.invalidParams(
        void 0,
        "External tool guard session is not owned by this connection"
      );
    }
    const entry = this.resolveEntry(sessionId);
    if (!entry || promptScoped && !ownsActivePrompt(entry, promptId)) {
      throw RequestError.invalidParams(
        void 0,
        "External tool guard prompt is not the active prompt"
      );
    }
    const invocationCwd = params["invocationCwd"];
    const decision = await this.externalToolGuard({
      sessionId: entry.sessionId,
      ...promptScoped ? { promptId } : {},
      toolCallId,
      toolName,
      arguments: args,
      effectiveCwd: entry.effectiveCwd,
      // Forwarded verbatim and explicitly untrusted: the host policy decides
      // whether it can establish this scope from state it owns.
      ...typeof invocationCwd === "string" && invocationCwd.length > 0 ? { invocationCwd } : {}
    });
    const currentEntry = this.resolveEntry(sessionId);
    if (!this.ownsSession(sessionId) || currentEntry !== entry || promptScoped && !ownsActivePrompt(currentEntry, promptId)) {
      throw RequestError.invalidParams(
        void 0,
        "External tool guard prompt is no longer active"
      );
    }
    return normalizeExternalToolGuardResult(decision);
  }
  handleTodoStopGuardContinuationClaim(params) {
    const sessionId = typeof params["sessionId"] === "string" && params["sessionId"].length > 0 ? params["sessionId"] : void 0;
    if (!sessionId) return { claimed: false, hasQueuedPrompt: false };
    if (!this.ownsSession(sessionId)) {
      return { claimed: false, hasQueuedPrompt: false };
    }
    const entry = this.resolveEntry(sessionId);
    if (!entry) return { claimed: false, hasQueuedPrompt: false };
    const livePrompts = entry.pendingPromptList.filter(
      (prompt) => !prompt.abortController.signal.aborted
    );
    const promptId = typeof params["promptId"] === "string" && params["promptId"].length > 0 ? params["promptId"] : void 0;
    if (promptId) {
      const ownsRunningPrompt = entry.backgroundTurn?.turnId === promptId || entry.activePromptId === promptId && livePrompts.some(
        (prompt) => prompt.promptId === promptId && prompt.state === "running"
      );
      const hasCompetingRunningPrompt = livePrompts.some(
        (prompt) => prompt.promptId !== promptId && prompt.state === "running"
      );
      if (!ownsRunningPrompt || hasCompetingRunningPrompt) {
        return { claimed: false, hasQueuedPrompt: false };
      }
      const hasQueuedPrompt = livePrompts.some(
        (prompt) => prompt.state === "queued"
      );
      if (hasQueuedPrompt) {
        entry.todoStopGuardAwaitingQueuedPromptOwnerPromptId = promptId;
        return { claimed: false, hasQueuedPrompt: true };
      }
      if (entry.todoStopGuardAwaitingQueuedPromptOwnerPromptId === promptId) {
        delete entry.todoStopGuardAwaitingQueuedPromptOwnerPromptId;
      }
      return { claimed: true, hasQueuedPrompt: false };
    }
    if (entry.promptActive || entry.backgroundTurn || livePrompts.length > 0) {
      return { claimed: false, hasQueuedPrompt: false };
    }
    return { claimed: true, hasQueuedPrompt: false };
  }
  async handleChannelDelivery(params) {
    if (!this.onChannelDelivery) {
      throw RequestError.methodNotFound(
        SERVE_CONTROL_EXT_METHODS.channelDelivery
      );
    }
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string" || sessionId.length === 0 || !this.ownsSession(sessionId)) {
      throw RequestError.invalidParams(
        void 0,
        "`sessionId` must name a session owned by this connection"
      );
    }
    const entry = this.resolveEntry(sessionId);
    if (!entry) {
      throw RequestError.invalidParams(void 0, "Unknown `sessionId`");
    }
    const deliveryId = params["deliveryId"];
    const source = params["source"];
    const text = params["text"];
    const rawTarget = params["target"];
    if (!isBoundedChannelDeliveryString(deliveryId) || source !== "prompt" && source !== "scheduled" || typeof text !== "string" || text.length > MAX_CHANNEL_DELIVERY_TEXT_CHARS || !isChannelDeliveryTarget(rawTarget)) {
      throw RequestError.invalidParams(
        void 0,
        "Invalid channel delivery request"
      );
    }
    const promptId = params["promptId"];
    const taskId = params["taskId"];
    const firedAt = params["firedAt"];
    const allowedKeys = source === "prompt" ? /* @__PURE__ */ new Set([
      "sessionId",
      "deliveryId",
      "source",
      "target",
      "text",
      "promptId"
    ]) : /* @__PURE__ */ new Set([
      "sessionId",
      "deliveryId",
      "source",
      "target",
      "text",
      "taskId",
      "firedAt"
    ]);
    const correlationValid = source === "prompt" ? isBoundedChannelDeliveryString(promptId) && promptId === deliveryId : isBoundedChannelDeliveryString(taskId) && typeof firedAt === "number" && Number.isFinite(firedAt) && deliveryId === `${taskId}:${firedAt}`;
    if (!correlationValid || !Object.keys(params).every((key) => allowedKeys.has(key))) {
      throw RequestError.invalidParams(
        void 0,
        "Invalid channel delivery correlation"
      );
    }
    const info = {
      sessionId,
      deliveryId,
      source,
      target: rawTarget,
      text,
      ...source === "prompt" ? { promptId } : {},
      ...source === "scheduled" ? { taskId, firedAt } : {}
    };
    let result;
    try {
      result = normalizeChannelDeliveryHostResult(
        await this.onChannelDelivery(info)
      );
    } catch {
      result = {
        status: "failed",
        code: "channel_delivery_failed",
        error: "Channel delivery failed."
      };
    }
    try {
      entry.events.publish({
        type: "channel_delivery_result",
        ...source === "prompt" ? { promptId } : {},
        data: {
          sessionId,
          deliveryId,
          source,
          status: result.status,
          ...source === "prompt" ? { promptId } : {},
          ...source === "scheduled" ? { taskId, firedAt } : {},
          ...result.status === "failed" ? { code: result.code, error: result.error } : {}
        }
      });
    } catch {
    }
    return result;
  }
  /**
   * Reverse tool channel (issue #5626, Phase 2) — answer the child's
   * `qwen/control/client_mcp/message` ext-method. The child's session
   * `McpClientManager` calls this when its agent drives a client-hosted
   * (extension) MCP server: `params` carries the advertised `server` name and
   * the JSON-RPC `payload` (initialize / tools/list / tools/call / a
   * notification). We resolve the per-WS-connection sender via the injected
   * `clientMcpSender` lookup, deliver the payload over the daemon WS, and
   * return the correlated response as `{ payload }`.
   *
   * Rejects with ACP `methodNotFound` when no `clientMcpSender` is wired (Mode
   * A / tests can't host a client MCP server), and `invalidParams` when the
   * frame is malformed or the named server is no longer hosted (e.g. the
   * extension disconnected mid-turn) — the agent's `SdkControlClientTransport`
   * surfaces that as a transport error rather than hanging.
   */
  async handleClientMcpMessage(params) {
    if (!this.clientMcpSender) {
      throw RequestError.methodNotFound(
        SERVE_CONTROL_EXT_METHODS.clientMcpMessage
      );
    }
    const server = params["server"];
    if (typeof server !== "string" || server.length === 0) {
      throw RequestError.invalidParams(
        void 0,
        "`server` must be a non-empty string"
      );
    }
    const payload = params["payload"];
    if (payload === null || typeof payload !== "object") {
      throw RequestError.invalidParams(
        void 0,
        "`payload` must be a JSON-RPC message object"
      );
    }
    const send = this.clientMcpSender(server);
    if (!send) {
      throw RequestError.invalidParams(
        void 0,
        `client-hosted MCP server '${server}' is not currently connected`
      );
    }
    const sessionId = params["sessionId"];
    if (sessionId !== void 0 && (typeof sessionId !== "string" || sessionId.length === 0)) {
      throw RequestError.invalidParams(
        void 0,
        "`sessionId` must be a non-empty string when provided"
      );
    }
    const ownsSession = typeof sessionId === "string" && this.ownsSession(sessionId);
    if (typeof sessionId === "string" && !ownsSession && !this.hasSessionSpawnInFlight()) {
      throw RequestError.invalidParams(
        void 0,
        `Session not owned by this channel: ${sessionId}`
      );
    }
    if (typeof sessionId === "string" && !ownsSession) {
      writeStderrLine(
        `[demux] session=${sessionId} type=client_mcp_message action=forwarded_without_session reason=session_registration_pending`
      );
    }
    const response = await send(
      payload,
      typeof sessionId === "string" && ownsSession ? { sessionId } : void 0
    );
    return { payload: response };
  }
  /**
   * Handle the `create_sub_session` tool's request: validate, then forward to
   * the daemon-host `onCreateSubSession` callback (which spawns a fresh
   * top-level sub-session and, for `'first-turn'`, waits for its first turn and
   * returns the result). No host wired → `methodNotFound`, which the tool
   * surfaces as "daemon-only".
   */
  async handleCreateSubSession(params) {
    if (!this.onCreateSubSession) {
      throw RequestError.methodNotFound(
        SERVE_CONTROL_EXT_METHODS.createSubSession
      );
    }
    const prompt = params["prompt"];
    if (typeof prompt !== "string" || prompt.length === 0) {
      throw RequestError.invalidParams(
        void 0,
        "`prompt` must be a non-empty string"
      );
    }
    const source = parseSessionSource(params["sourceType"], params["sourceId"]);
    if ("error" in source) {
      throw RequestError.invalidParams(void 0, source.error);
    }
    if (source.sourceType !== void 0 && source.sourceType !== SCHEDULED_TASK_RUN_SOURCE_TYPE) {
      throw RequestError.invalidParams(
        void 0,
        "`sourceType` is not settable on a sub-session"
      );
    }
    const promptLimit = isScheduledTaskRunSource(source) ? MAX_SUB_SESSION_PROMPT_CHARS + SCHEDULED_TASK_RUN_CONTEXT_HEADROOM_CHARS : MAX_SUB_SESSION_PROMPT_CHARS;
    if (prompt.length > promptLimit) {
      throw RequestError.invalidParams(
        void 0,
        `\`prompt\` exceeds the ${promptLimit}-character limit`
      );
    }
    const completion = params["completion"];
    if (completion !== "sent" && completion !== "first-turn") {
      throw RequestError.invalidParams(
        void 0,
        "`completion` must be 'sent' or 'first-turn'"
      );
    }
    const name = params["name"];
    if (typeof name === "string" && name.length > MAX_SUB_SESSION_NAME_CHARS) {
      throw RequestError.invalidParams(
        void 0,
        `\`name\` exceeds the ${MAX_SUB_SESSION_NAME_CHARS}-character limit`
      );
    }
    const callerSessionId = params["callerSessionId"];
    if (typeof callerSessionId !== "string" || callerSessionId.length === 0 || !this.ownsSession(callerSessionId)) {
      throw RequestError.invalidParams(
        void 0,
        "`callerSessionId` is required and must name a session owned by this connection"
      );
    }
    const model = params["model"];
    const groupId = params["groupId"];
    if (model !== void 0 && !isValidCronTaskRoutingId(model)) {
      throw RequestError.invalidParams(
        void 0,
        `\`model\` must be a non-empty string of at most ${MAX_CRON_TASK_ROUTING_ID_LENGTH} characters without control characters`
      );
    }
    if (groupId !== void 0 && (!isScheduledTaskRunSource(source) || !isValidCronTaskRoutingId(groupId))) {
      throw RequestError.invalidParams(
        void 0,
        `\`groupId\` must be a non-empty string of at most ${MAX_CRON_TASK_ROUTING_ID_LENGTH} characters without control characters and is only supported for scheduled-task runs`
      );
    }
    const result = await this.onCreateSubSession({
      prompt,
      completion,
      ...typeof model === "string" ? { model } : {},
      ...typeof groupId === "string" ? { groupId } : {},
      ...typeof name === "string" && name.length > 0 ? { name } : {},
      ...source,
      callerSessionId
    });
    return {
      sessionId: result.sessionId,
      ...result.result !== void 0 ? { result: result.result } : {},
      ...result.stopReason !== void 0 ? { stopReason: result.stopReason } : {},
      ...result.parentSessionPersisted !== void 0 ? { parentSessionPersisted: result.parentSessionPersisted } : {}
    };
  }
  async handleCreateCurrentSessionScheduledTask(params) {
    if (!this.onCreateCurrentSessionScheduledTask) {
      throw RequestError.methodNotFound(
        SERVE_CONTROL_EXT_METHODS.createCurrentSessionScheduledTask
      );
    }
    const callerSessionId = params["callerSessionId"];
    const promptId = params["promptId"];
    const cron = params["cron"];
    const prompt = params["prompt"];
    const recurring = params["recurring"];
    if (typeof callerSessionId !== "string" || callerSessionId.length === 0 || !this.ownsSession(callerSessionId)) {
      throw RequestError.invalidParams(
        void 0,
        "`callerSessionId` must name a session owned by this connection"
      );
    }
    if (typeof promptId !== "string" || promptId.length === 0) {
      throw RequestError.invalidParams(
        void 0,
        "`promptId` must be a non-empty string"
      );
    }
    if (typeof cron !== "string" || cron.length === 0 || cron.length > MAX_SCHEDULED_TASK_CRON_CHARS) {
      throw RequestError.invalidParams(
        void 0,
        `\`cron\` must be a non-empty string within the ${MAX_SCHEDULED_TASK_CRON_CHARS}-character limit`
      );
    }
    if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > MAX_SCHEDULED_TASK_PROMPT_CHARS) {
      throw RequestError.invalidParams(
        void 0,
        `\`prompt\` must be non-empty and within the ${MAX_SCHEDULED_TASK_PROMPT_CHARS}-character limit`
      );
    }
    if (typeof recurring !== "boolean") {
      throw RequestError.invalidParams(
        void 0,
        "`recurring` must be a boolean"
      );
    }
    const entry = this.resolveEntry(callerSessionId);
    if (!entry || entry.sessionId !== callerSessionId || !ownsActivePrompt(entry, promptId)) {
      throw RequestError.invalidParams(
        void 0,
        "The caller session does not own the active prompt"
      );
    }
    if (entry.parentSessionId !== void 0 || entry.sourceId !== void 0 || entry.sourceType !== void 0 && entry.sourceType !== "default") {
      throw RequestError.invalidParams(
        void 0,
        "The caller session source cannot own a scheduled task"
      );
    }
    const result = await this.onCreateCurrentSessionScheduledTask({
      callerSessionId,
      promptId,
      cron,
      prompt,
      recurring,
      assertCallerPromptActive: /* @__PURE__ */ __name(() => {
        const currentEntry = this.resolveEntry(callerSessionId);
        if (currentEntry !== entry || !ownsActivePrompt(currentEntry, promptId)) {
          throw RequestError.invalidParams(
            void 0,
            "The caller session no longer owns the active prompt"
          );
        }
      }, "assertCallerPromptActive")
    }).catch(
      (error) => preserveScheduledTaskCreateErrorOverAcp(error)
    );
    if (typeof result.id !== "string" || result.id.length === 0 || typeof result.cron !== "string" || result.cron.length === 0) {
      throw RequestError.internalError(
        void 0,
        "Scheduled-task host returned an invalid result"
      );
    }
    return { id: result.id, cron: result.cron };
  }
  async handleLiveScreenContextCapture(params) {
    const handler = this.getLiveScreenContextCaptureHandler();
    if (!handler) {
      throw RequestError.methodNotFound(
        SERVE_CONTROL_EXT_METHODS.liveCaptureScreenContext
      );
    }
    const callerSessionId = params["callerSessionId"];
    if (typeof callerSessionId !== "string" || callerSessionId.length === 0 || !this.ownsSession(callerSessionId)) {
      throw RequestError.invalidParams(
        void 0,
        "`callerSessionId` is required and must name a session owned by this connection"
      );
    }
    const result = await handler({ callerSessionId });
    if (result.appName.length === 0 || result.appName.length > 512 || result.windowTitle !== void 0 && result.windowTitle.length > 2048 || result.accessibilityText.length > MAX_LIVE_SCREEN_CONTEXT_TEXT_CHARS || result.screenshotPath.length === 0 || result.screenshotPath.length > 4096) {
      throw RequestError.internalError(void 0, "Invalid Appshot result.");
    }
    return {
      appName: result.appName,
      ...result.windowTitle ? { windowTitle: result.windowTitle } : {},
      accessibilityText: result.accessibilityText,
      screenshotPath: result.screenshotPath
    };
  }
  async handleLiveTaskTool(params) {
    const handler = this.getLiveTaskToolRequestHandler();
    if (!handler) {
      throw RequestError.methodNotFound(SERVE_CONTROL_EXT_METHODS.liveTaskTool);
    }
    const callerSessionId = params["callerSessionId"];
    const name = params["name"];
    const args = params["arguments"];
    if (typeof callerSessionId !== "string" || callerSessionId.length === 0 || !this.ownsSession(callerSessionId) || typeof name !== "string" || !LIVE_TASK_TOOL_NAMES.includes(
      name
    ) || typeof args !== "object" || args === null || Array.isArray(args)) {
      throw RequestError.invalidParams(
        void 0,
        "Invalid Live task-tool request."
      );
    }
    return handler({
      callerSessionId,
      name,
      arguments: args
    });
  }
  async handleLiveSpeakToUser(params) {
    const handler = this.getLiveSpeakToUserHandler();
    if (!handler) {
      throw RequestError.methodNotFound(
        SERVE_CONTROL_EXT_METHODS.liveSpeakToUser
      );
    }
    const callerSessionId = params["callerSessionId"];
    const message = params["message"];
    if (typeof callerSessionId !== "string" || callerSessionId.length === 0 || !this.ownsSession(callerSessionId) || typeof message !== "string" || message.trim().length === 0 || message.length > MAX_LIVE_SPEAK_TO_USER_MESSAGE_CHARS) {
      throw RequestError.invalidParams(
        void 0,
        "Invalid Live speak-to-user request."
      );
    }
    await handler({ callerSessionId, message });
    return { accepted: true };
  }
  /**
   * Handle child->bridge ACP `extNotification` calls. Recognized methods are
   * `qwen/notify/session/model-update`,
   * `qwen/notify/session/mode-update`,
   * `qwen/notify/session/title-update` (auto/in-process session titles),
   * `qwen/notify/session/recording-degraded`,
   * `qwen/notify/session/prompt-suggestion` (followup assist),
   * `qwen/notify/session/artifact-event` (hook artifacts),
   * `qwen/notify/session/terminal-sequence`,
   * `qwen/notify/session/pr-binding` (shell-detected `gh pr create`
   * bindings — catalog mark only, the child persists the sidecar), and
   * `_qwencode/end_turn` (background-notification and goal turns), and
   * `qwen/notify/session/mcp-budget-event` — each translated into a
   * session-scoped SSE frame. Unknown methods are dropped silently for
   * forward-compat.
   */
  async extNotification(method, params) {
    const notificationSessionId = params["sessionId"];
    if (typeof notificationSessionId === "string" && this.abandonedRestoreIds.has(notificationSessionId)) {
      return;
    }
    if (method === "qwen/notify/session/sources-changed") {
      const sessionId2 = params["sessionId"];
      const revision = params["revision"];
      if (typeof sessionId2 !== "string" || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0 || !this.ownsSession(sessionId2))
        return;
      const entry = this.resolveEntry(sessionId2);
      if (!entry) return;
      entry.events.publish({
        type: "source_changed",
        data: { sessionId: sessionId2, revision }
      });
      return;
    }
    if (method === ACTIVE_WORK_NOTIFICATION_METHOD) {
      const snapshot = parseActiveWorkSnapshot(params);
      if (snapshot) {
        this.onActiveWork?.({
          v: ACTIVE_WORK_HEARTBEAT_VERSION,
          seq: snapshot.seq,
          sessions: snapshot.sessions.filter(
            (session) => this.ownsSession(session.sessionId) || this.hasSessionSpawnInFlight()
          )
        });
      }
      return;
    }
    if (method === "_qwencode/start_turn") {
      const sessionId2 = params["sessionId"];
      if (typeof sessionId2 !== "string" || sessionId2.length === 0 || params["source"] !== "goal") {
        return;
      }
      const entry = this.resolveEntry(sessionId2);
      if (!entry || !this.ownsSession(sessionId2)) return;
      entry.goalTurnActive = true;
      return;
    }
    if (method === "_qwencode/end_turn") {
      const sessionId2 = params["sessionId"];
      const reason = params["reason"];
      const source = params["source"];
      if (typeof sessionId2 !== "string" || sessionId2.length === 0 || typeof reason !== "string" || reason.length === 0 || reason.length > 128 || source !== "background_notification" && source !== "goal") {
        return;
      }
      const entry = this.resolveEntry(sessionId2);
      if (!entry || !this.ownsSession(sessionId2)) return;
      if (source === "goal") {
        entry.goalTurnActive = false;
        this.onAutomaticTurnEnded?.(sessionId2);
        const promptId = params["promptId"];
        if (typeof promptId !== "string" || promptId.length === 0 || promptId.length > 256) {
          return;
        }
        entry.events.publish({
          type: "turn_complete",
          promptId,
          data: { sessionId: sessionId2, stopReason: reason, promptId }
        });
        return;
      }
      const turnId = params["turnId"];
      if (turnId !== void 0) {
        if (typeof turnId !== "string" || entry.backgroundTurn?.turnId !== turnId)
          return;
        this.finishBackgroundTurn(sessionId2, turnId, reason);
        return;
      }
      if (entry.backgroundTurn) return;
      entry.events.publish({
        type: "background_notification_turn_complete",
        data: { sessionId: sessionId2, reason }
      });
      return;
    }
    if (method === "qwen/notify/session/generation/event") {
      const sessionId2 = params["sessionId"];
      const requestId = params["requestId"];
      const event = params["event"];
      if (params["v"] !== 1 || typeof sessionId2 !== "string" || typeof requestId !== "string" || !event || typeof event !== "object" || Array.isArray(event)) {
        return;
      }
      const record = event;
      if (record["type"] === "started") {
        const model = record["model"];
        const modelSource = record["modelSource"];
        if (typeof model !== "string" || modelSource !== "fast" && modelSource !== "main") {
          return;
        }
        this.onGenerationEvent?.(sessionId2, {
          type: "started",
          requestId,
          model,
          modelSource
        });
        return;
      }
      if (record["type"] === "thinking") {
        this.onGenerationEvent?.(sessionId2, {
          type: "thinking",
          requestId
        });
        return;
      }
      if (record["type"] === "delta") {
        const seq = record["seq"];
        const text = record["text"];
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || typeof text !== "string" || text.length === 0) {
          return;
        }
        this.onGenerationEvent?.(sessionId2, {
          type: "delta",
          requestId,
          seq,
          text
        });
        return;
      }
      return;
    }
    if (method === "qwen/notify/workspace/generation/event") {
      const requestId = params["requestId"];
      const event = params["event"];
      if (params["v"] !== 1 || typeof requestId !== "string" || !event || typeof event !== "object" || Array.isArray(event)) {
        return;
      }
      const record = event;
      if (record["type"] === "started") {
        const model = record["model"];
        const modelSource = record["modelSource"];
        if (typeof model !== "string" || modelSource !== "fast" && modelSource !== "main") {
          return;
        }
        this.onWorkspaceGenerationEvent?.({
          type: "started",
          requestId,
          model,
          modelSource
        });
        return;
      }
      if (record["type"] === "thinking") {
        this.onWorkspaceGenerationEvent?.({ type: "thinking", requestId });
        return;
      }
      if (record["type"] === "delta") {
        const seq = record["seq"];
        const text = record["text"];
        if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || typeof text !== "string" || text.length === 0) {
          return;
        }
        this.onWorkspaceGenerationEvent?.({
          type: "delta",
          requestId,
          seq,
          text
        });
        return;
      }
      return;
    }
    if (method === "qwen/notify/session/model-update") {
      this.handleInSessionModelUpdate(params);
      return;
    }
    if (method === "qwen/notify/session/mode-update") {
      this.handleInSessionModeUpdate(params);
      return;
    }
    if (method === "qwen/notify/session/title-update") {
      const sessionId2 = params["sessionId"];
      const title = params["title"];
      if (typeof sessionId2 !== "string" || typeof title !== "string" || !title)
        return;
      const entry = this.resolveEntry(sessionId2);
      if (!entry) return;
      this.onSessionCatalogChanged?.();
      try {
        entry.events.publish({
          type: "session_metadata_updated",
          data: {
            sessionId: sessionId2,
            displayName: title,
            ...typeof params["titleSource"] === "string" ? { titleSource: params["titleSource"] } : {}
          }
        });
      } catch {
      }
      return;
    }
    if (method === "qwen/notify/session/pr-binding") {
      const sessionId2 = params["sessionId"];
      const pr = params["pr"];
      if (params["v"] !== 1 || typeof sessionId2 !== "string" || sessionId2.length === 0 || pr === null || typeof pr !== "object" || Array.isArray(pr)) {
        return;
      }
      const record = pr;
      const number = record["number"];
      const url = record["url"];
      if (typeof number !== "number" || !Number.isInteger(number) || number <= 0 || typeof url !== "string" || url.length === 0 || url.length > SESSION_PR_URL_MAX_LENGTH || !/^https?:\/\//i.test(url) || // Mirrors the bridge's hasControlCharacter: the url lands in an
      // audit line, so control characters would forge log lines.
      Array.from(url).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || code === 127;
      })) {
        return;
      }
      const entry = this.resolveEntry(sessionId2);
      if (!entry || !this.ownsSession(sessionId2)) return;
      this.onSessionCatalogChanged?.();
      return;
    }
    if (method === "qwen/notify/session/recording-degraded") {
      const sessionId2 = params["sessionId"];
      if (params["v"] !== 1 || typeof sessionId2 !== "string" || sessionId2.length === 0 || params["reason"] !== "write_failed") {
        writeStderrLine(
          `[demux] session=${typeof sessionId2 === "string" ? sessionId2 : "<missing>"} type=session_recording_degraded action=dropped reason=malformed`
        );
        return;
      }
      const entry = this.resolveEntry(sessionId2);
      if (entry && !this.ownsSession(sessionId2)) {
        writeStderrLine(
          `[demux] session=${sessionId2} type=session_recording_degraded action=dropped reason=session_not_owned`
        );
        return;
      }
      if (entry) entry.recordingDegraded = true;
      this.publishExtNotification(sessionId2, "session_recording_degraded", {
        sessionId: sessionId2,
        reason: "write_failed"
      });
      return;
    }
    if (method === "qwen/notify/session/prompt-suggestion") {
      const sessionId2 = params["sessionId"];
      const suggestion = params["suggestion"];
      const promptId = params["promptId"];
      if (typeof sessionId2 !== "string" || typeof suggestion !== "string" || suggestion.length === 0 || suggestion.length > MAX_SUGGESTION_LENGTH || typeof promptId !== "string") {
        writeStderrLine(
          `[demux] session=${typeof sessionId2 === "string" ? sessionId2 : "<missing>"} type=prompt_suggestion action=dropped reason=malformed`
        );
        return;
      }
      const entry = this.resolveEntry(sessionId2);
      if (!entry) return;
      entry.events.publish({
        type: "followup_suggestion",
        data: { sessionId: sessionId2, suggestion, promptId }
      });
      return;
    }
    if (method === "qwen/notify/session/terminal-sequence") {
      const sessionId2 = params["sessionId"];
      if (typeof sessionId2 !== "string") return;
      const { v: _v2, sessionId: _sid2, ...rest2 } = params;
      void _v2;
      void _sid2;
      this.publishExtNotification(sessionId2, "terminal_sequence", rest2, true);
      return;
    }
    if (method === "qwen/notify/session/artifact-event") {
      await this.handleArtifactEvent(params);
      return;
    }
    if (method !== "qwen/notify/session/mcp-budget-event") return;
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string") return;
    const kind = params["kind"];
    let type;
    if (kind === "budget_warning") {
      type = "mcp_budget_warning";
    } else if (kind === "refused_batch") {
      type = "mcp_child_refused_batch";
    } else {
      return;
    }
    const { v: _v, sessionId: _sid, kind: _kind, ...rest } = params;
    void _v;
    void _sid;
    void _kind;
    this.publishExtNotification(sessionId, type, rest);
  }
  async handleArtifactEvent(params) {
    const sessionId = params["sessionId"];
    const rawArtifacts = params["artifacts"];
    if (typeof sessionId !== "string" || !Array.isArray(rawArtifacts)) {
      writeStderrLine(
        `[demux] session=${typeof sessionId === "string" ? sessionId : "<missing>"} type=artifact_event action=dropped reason=malformed`
      );
      return;
    }
    if (!this.ownsSession(sessionId) && !this.inFlightRestoreIds.has(sessionId)) {
      writeStderrLine(
        `[demux] session=${sessionId} type=artifact_event action=dropped reason=session_not_owned`
      );
      return;
    }
    const entry = this.resolveEntry(sessionId);
    if (!entry) {
      writeStderrLine(
        `[demux] session=${sessionId} type=artifact_event action=dropped reason=session_not_found`
      );
      return;
    }
    const hookEventName = typeof params["hookEventName"] === "string" ? params["hookEventName"] : void 0;
    const toolName = typeof params["toolName"] === "string" ? params["toolName"] : void 0;
    const toolCallId = typeof params["toolCallId"] === "string" ? params["toolCallId"] : void 0;
    const artifacts = extractCappedArtifactInputs(
      rawArtifacts,
      entry.artifacts.inputBatchLimit(),
      entry.sessionId,
      "hook",
      (artifact) => ({
        ...artifactPayloadFields(artifact),
        source: "hook",
        hookEventName,
        toolName,
        toolCallId
      })
    );
    const turn = currentTurnMetadata(entry);
    await this.upsertAndPublishArtifacts(entry, artifacts, void 0, turn);
  }
  async upsertAndPublishArtifacts(entry, artifacts, options, turn = {}) {
    if (!entry.artifactWorkspaceReady) {
      this.deferArtifactBatch(entry, artifacts, options, turn);
      writeStderrLine(
        `[artifacts] session=${entry.sessionId} action=deferred reason=workspace_not_bound`
      );
      return;
    }
    try {
      await entry.prepareArtifactWorkspace?.();
    } catch {
      this.deferArtifactBatch(entry, artifacts, options, turn);
      writeStderrLine(
        `[artifacts] session=${entry.sessionId} action=deferred reason=workspace_prepare_failed`
      );
      return;
    }
    await this.upsertAndPublishArtifactsReady(entry, artifacts, options, turn);
  }
  deferArtifactBatch(entry, artifacts, options, turn) {
    if (artifacts.length === 0) return;
    entry.deferredArtifactBatches.push({ artifacts, options, turn });
    entry.deferredArtifactInputCount += artifacts.length;
    const limit = entry.artifacts.inputBatchLimit();
    let truncated = false;
    while (entry.deferredArtifactInputCount > limit) {
      const first = entry.deferredArtifactBatches[0];
      if (!first) break;
      const overflow = entry.deferredArtifactInputCount - limit;
      if (first.artifacts.length <= overflow) {
        entry.deferredArtifactBatches.shift();
        entry.deferredArtifactInputCount -= first.artifacts.length;
      } else {
        first.artifacts = first.artifacts.slice(overflow);
        entry.deferredArtifactInputCount -= overflow;
      }
      truncated = true;
    }
    if (truncated) {
      writeStderrLine(
        `[artifacts] session=${entry.sessionId} action=deferred_truncated reason=workspace_not_bound`
      );
    }
  }
  async upsertAndPublishArtifactsReady(entry, artifacts, options, turn = {}) {
    try {
      const result = await entry.artifacts.upsertMany(artifacts, options);
      for (const warning of result.warnings ?? []) {
        writeStderrLine(
          `[artifacts] session=${entry.sessionId} action=warning reason=${JSON.stringify(
            warning
          )}`
        );
      }
      this.publishArtifactChanges(entry, result.changes, turn);
      return true;
    } catch (error) {
      writeStderrLine(
        `[artifacts] session=${entry.sessionId} action=dropped reason=${JSON.stringify(
          artifactIngestionErrorReason(error)
        )}`
      );
      return false;
    }
  }
  publishArtifactChanges(entry, changes, turn) {
    for (const change of changes) {
      entry.events.publish({
        type: "artifact_changed",
        data: { sessionId: entry.sessionId, change },
        ...turn
      });
    }
  }
  publishExtNotification(sessionId, type, data, turnScoped = false) {
    if (this.abandonedRestoreIds.has(sessionId)) {
      return;
    }
    const entry = this.resolveEntry(sessionId);
    const { promptId, ...originator } = currentTurnMetadata(entry);
    const frame = {
      type,
      data,
      ...originator,
      ...turnScoped && promptId ? { promptId } : {}
    };
    if (entry) {
      entry.events.publish(frame);
      return;
    }
    this.bufferEarlyEvent(sessionId, frame);
  }
  /**
   * Promote an in-session `current_model_update` extNotification to a
   * `model_switched` bus event. Suppressed while the bridge is driving
   * its own model roundtrip (`entry.modelRoundtripInFlight`) — there the
   * bridge publishes the authoritative `model_switched`, so promoting
   * here too would double-publish. A structured log records the decision
   * so the `dropped` case is observable.
   */
  handleInSessionModelUpdate(params) {
    const sessionId = params["sessionId"];
    const currentModelId = params["currentModelId"];
    if (typeof sessionId !== "string" || typeof currentModelId !== "string") {
      return;
    }
    const entry = this.resolveEntry(sessionId);
    if (!entry) {
      writeStderrLine(
        `[demux] session=${sessionId} type=current_model_update action=dropped reason=no_entry`
      );
      return;
    }
    if (entry.modelRoundtripInFlight) {
      writeStderrLine(
        `[demux] session=${sessionId} type=current_model_update action=suppressed reason=bridge_roundtrip_in_flight`
      );
      return;
    }
    if (this.onModelPromoted) {
      this.onModelPromoted(
        entry,
        currentModelId,
        entry.activePromptOriginatorClientId
      );
    } else {
      entry.events.publish({
        type: "model_switched",
        ...currentTurnMetadata(entry),
        data: { sessionId, modelId: currentModelId }
      });
    }
    writeStderrLine(
      `[demux] session=${sessionId} type=current_model_update action=promoted model=${currentModelId}`
    );
  }
  /**
   * A2: promote an in-session `current_mode_update` extNotification to
   * `approval_mode_changed`. Uses the same suppression pattern as
   * `handleInSessionModelUpdate` — suppressed while the bridge is driving
   * its own approval-mode roundtrip (`entry.approvalModeRoundtripInFlight`)
   * — but diverges with two additions the model handler lacks: enum
   * validation against `KNOWN_APPROVAL_MODES`, and a legacy
   * `session_update{current_mode_update}` dual-emit for IDE companion
   * compat (transition — see §6 of the design doc), itself deduped via the
   * `legacyFrameSent` flag.
   */
  handleInSessionModeUpdate(params) {
    const sessionId = params["sessionId"];
    const currentModeId = params["currentModeId"];
    if (typeof sessionId !== "string" || typeof currentModeId !== "string") {
      return;
    }
    if (!KNOWN_APPROVAL_MODES.has(currentModeId)) {
      writeStderrLine(
        `[demux] session=${sessionId} type=current_mode_update action=dropped reason=unknown_mode mode=${currentModeId}`
      );
      return;
    }
    const selected = params["planExecutionMode"];
    const planExecutionMode = currentModeId === "plan" && typeof selected === "string" && selected !== "plan" && KNOWN_APPROVAL_MODES.has(selected) ? selected : void 0;
    const entry = this.resolveEntry(sessionId);
    if (!entry) {
      writeStderrLine(
        `[demux] session=${sessionId} type=current_mode_update action=dropped reason=no_entry`
      );
      return;
    }
    if (entry.approvalModeRoundtripInFlight) {
      writeStderrLine(
        `[demux] session=${sessionId} type=current_mode_update action=suppressed reason=bridge_roundtrip_in_flight`
      );
      return;
    }
    if (this.onModePromoted) {
      this.onModePromoted(
        entry,
        currentModeId,
        entry.activePromptOriginatorClientId,
        planExecutionMode
      );
    } else {
      entry.events.publish({
        type: "approval_mode_changed",
        ...currentTurnMetadata(entry),
        data: {
          sessionId,
          previous: "default",
          next: currentModeId,
          persisted: false,
          ...planExecutionMode ? { planExecutionMode } : {}
        }
      });
    }
    if (params["legacyFrameSent"] === true) {
      writeStderrLine(
        `[demux] session=${sessionId} type=current_mode_update action=promoted mode=${currentModeId} legacy_frame=skipped`
      );
      return;
    }
    entry.events.publish({
      type: "session_update",
      ...currentTurnMetadata(entry),
      data: {
        sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId
        }
      }
    });
    writeStderrLine(
      `[demux] session=${sessionId} type=current_mode_update action=promoted mode=${currentModeId}`
    );
  }
  /**
   * Enqueue `frame` for `sessionId`. Lazy TTL sweep runs first so
   * caller doesn't pay for stale entries before deciding whether
   * the session-cap is reached. New sessionIds past
   * `MAX_EARLY_EVENT_SESSIONS` are dropped (defense against a
   * malicious / buggy child fanning out fake sessionIds); same-
   * sessionId frames past `MAX_EARLY_EVENTS_PER_SESSION` are
   * dropped to bound per-session memory.
   */
  bufferEarlyEvent(sessionId, frame) {
    if (this.abandonedRestoreIds.has(sessionId)) {
      return;
    }
    const now = Date.now();
    this.sweepExpiredTombstones(now);
    if (this.tombstonedSessionIds.has(sessionId) && !this.inFlightSessionRegistrationIds.has(sessionId)) {
      writeStderrLine(
        `qwen serve: dropping early extNotification for tombstoned session ${JSON.stringify(sessionId)} (post-close stale event)`
      );
      return;
    }
    this.sweepExpiredEarlyEvents(now);
    let buf = this.earlyEvents.get(sessionId);
    if (!buf) {
      if (this.earlyEvents.size >= MAX_EARLY_EVENT_SESSIONS) {
        writeStderrLine(
          `qwen serve: dropping early extNotification \u2014 early-event buffer at MAX_EARLY_EVENT_SESSIONS (${MAX_EARLY_EVENT_SESSIONS}); possible session-id fanout abuse`
        );
        return;
      }
      buf = { frames: [], expiresAt: now + EARLY_EVENT_TTL_MS };
      this.earlyEvents.set(sessionId, buf);
    }
    if (buf.frames.length >= MAX_EARLY_EVENTS_PER_SESSION) {
      writeStderrLine(
        `qwen serve: dropping early extNotification for session ${JSON.stringify(sessionId)} \u2014 per-session cap (${MAX_EARLY_EVENTS_PER_SESSION}) reached`
      );
      return;
    }
    buf.frames.push(frame);
  }
  sweepExpiredEarlyEvents(now) {
    for (const [sid, buf] of this.earlyEvents) {
      if (buf.expiresAt <= now) this.earlyEvents.delete(sid);
    }
  }
  sweepExpiredTombstones(now) {
    for (const [sid, expiresAt] of this.tombstonedSessionIds) {
      if (expiresAt <= now) this.tombstonedSessionIds.delete(sid);
    }
  }
  /**
   * Mark a sessionId as closed so a late `extNotification` from the
   * dying child can't leak into the early-event buffer. Bridge factory
   * calls this from every `byId.delete(sid)` site (kill path,
   * channel.exited handler, closeSession). Idempotent on already-
   * tombstoned ids — refreshes the TTL so a recently-killed id stays
   * dead long enough for any in-flight stale frames to expire.
   */
  markSessionClosed(sessionId) {
    const now = Date.now();
    this.sweepExpiredTombstones(now);
    this.tombstonedSessionIds.set(sessionId, now + EARLY_EVENT_TTL_MS);
    this.earlyEvents.delete(sessionId);
  }
  /**
   * Mark a sessionId as currently being restored via `session/load` /
   * `session/resume`. While in this set, `bufferEarlyEvent` accepts
   * frames for the id even if it's tombstoned — so restore-time
   * early events from the freshly-restored child reach
   * `drainEarlyEvents` instead of being rejected by the tombstone.
   *
   * Bridge factory calls this BEFORE awaiting the ACP restore call.
   * `clearRestoreInFlight` is paired in the matching `finally` so a
   * failed restore doesn't leave a dangling allow-list entry.
   */
  markRestoreInFlight(sessionId) {
    this.markSessionRegistrationInFlight(sessionId);
    this.inFlightRestoreIds.add(sessionId);
  }
  /**
   * Transfer an id from closed/abandoned ownership to a new registration
   * attempt before its ACP call starts. The in-flight allow-list is what lets
   * legitimate early notifications bypass the ordinary close tombstone until
   * `createSessionEntry` can drain them.
   */
  markSessionRegistrationInFlight(sessionId) {
    this.clearAbandonedRestoreFence(sessionId);
    this.inFlightSessionRegistrationIds.add(sessionId);
  }
  /**
   * Drop the abandoned-restore fence for `sessionId`.
   *
   * The fence has no TTL and suppresses session updates, guardrail events,
   * and child notifications, so it must not outlive the abandoned attempt it
   * was raised for. The bridge clears it whenever a legitimate owner takes
   * the id — a new restore, or `createSessionEntry` registering a session
   * from any other route.
   */
  clearAbandonedRestoreFence(sessionId) {
    this.abandonedRestoreIds.delete(sessionId);
  }
  /**
   * Companion to `markRestoreInFlight`. Bridge factory calls this when
   * the restore IIFE settles — after `createSessionEntry` runs
   * (success) or after the ACP restore call fails (error). Cleared to
   * prevent the Set from growing forever under high restore churn.
   */
  clearRestoreInFlight(sessionId) {
    this.inFlightRestoreIds.delete(sessionId);
    this.clearSessionRegistrationInFlight(sessionId);
  }
  clearSessionRegistrationInFlight(sessionId) {
    this.inFlightSessionRegistrationIds.delete(sessionId);
  }
  markRestoreAbandoned(sessionId) {
    this.inFlightRestoreIds.delete(sessionId);
    this.inFlightSessionRegistrationIds.delete(sessionId);
    this.abandonedRestoreIds.add(sessionId);
    this.earlyEvents.delete(sessionId);
  }
  /**
   * Drain any frames buffered for `sessionId` onto `entry.events`.
   * Bridge calls this immediately after `byId.set(sessionId, entry)`
   * in `createSessionEntry`. The frames were captured before the
   * entry existed (e.g. MCP discovery during the child's `newSession`
   * handler), so draining them now lands them in the replay ring as
   * the FIRST events of this session.
   *
   * Public so the bridge factory can call it directly. Idempotent on
   * unknown sessionIds.
   */
  drainEarlyEvents(sessionId, entry) {
    this.tombstonedSessionIds.delete(sessionId);
    const buf = this.earlyEvents.get(sessionId);
    if (!buf) return;
    for (const frame of buf.frames) {
      if (frame.type === "session_recording_degraded") {
        entry.recordingDegraded = true;
      }
      entry.events.publish(frame);
    }
    this.earlyEvents.delete(sessionId);
  }
  async writeTextFile(params) {
    if (this.fileSystem) {
      try {
        return await this.fileSystem.writeText(params);
      } catch (err) {
        preserveFsErrorOverAcp(err);
      }
    }
    let realTarget = params.path;
    try {
      realTarget = await fs2.realpath(params.path);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? err.code : void 0;
      if (code !== "ENOENT") throw err;
      try {
        const linkTarget = await fs2.readlink(params.path);
        realTarget = path2.resolve(path2.dirname(params.path), linkTarget);
      } catch {
      }
    }
    const tmp = `${realTarget}.${process.pid}.${Date.now()}.${randomUUID2()}.tmp`;
    let preserveMode;
    try {
      const targetStat = await fs2.stat(realTarget);
      preserveMode = {
        mode: targetStat.mode & 4095,
        uid: targetStat.uid,
        gid: targetStat.gid
      };
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? err.code : void 0;
      if (code !== "ENOENT") throw err;
    }
    try {
      await fs2.writeFile(tmp, params.content, {
        encoding: "utf8",
        flag: "wx",
        mode: preserveMode?.mode ?? 384
      });
      if (preserveMode) {
        await fs2.chmod(tmp, preserveMode.mode).catch(() => {
        });
        await fs2.chown(tmp, preserveMode.uid, preserveMode.gid).catch(() => {
        });
      }
      await fs2.rename(tmp, realTarget);
    } catch (err) {
      await fs2.unlink(tmp).catch(() => {
      });
      throw err;
    }
    return {};
  }
  async readTextFile(params) {
    if (this.fileSystem) {
      try {
        return await this.fileSystem.readText(params);
      } catch (err) {
        preserveFsErrorOverAcp(err);
      }
    }
    if (typeof params.limit === "number" && params.limit <= 0) {
      return { content: "" };
    }
    if (typeof params.limit === "number" && params.limit > 0 && !Number.isSafeInteger(params.limit)) {
      throw RequestError.invalidParams(
        void 0,
        `\`limit\` must be a positive integer, got ${params.limit}`
      );
    }
    if (typeof params.line === "number" && params.line > 0 && !Number.isSafeInteger(params.line)) {
      throw RequestError.invalidParams(
        void 0,
        `\`line\` must be a positive integer, got ${params.line}`
      );
    }
    const READ_FILE_SIZE_CAP = 100 * 1024 * 1024;
    const stats = await fs2.stat(params.path);
    if (!stats.isFile()) {
      throw new Error(
        `readTextFile: ${params.path} is not a regular file (reported as ${describeStatKind(stats)}). Pipe / device / proc-like inputs can produce unbounded data and aren't supported by the bridge fs proxy.`
      );
    }
    if (stats.size > READ_FILE_SIZE_CAP) {
      throw new Error(
        `readTextFile: ${params.path} is ${stats.size} bytes, exceeds the ${READ_FILE_SIZE_CAP}-byte daemon cap. Tail/grep externally and feed the relevant slice instead.`
      );
    }
    const content = await fs2.readFile(params.path, "utf8");
    if (typeof params.line === "number" || typeof params.limit === "number") {
      const startLine = params.line ?? 1;
      const start = startLine > 0 ? startLine - 1 : 0;
      const end = params.limit != null ? start + params.limit : void 0;
      return { content: sliceLineRange(content, start, end) };
    }
    return { content };
  }
};
var A2UI_TOOL_RE = /(^|__)(present_ui|present_choices|a2ui_action)$/;
function isA2uiToolMeta(meta) {
  if (!meta) return false;
  if (typeof meta.serverId === "string" && meta.serverId.toLowerCase().includes("a2ui"))
    return true;
  return typeof meta.toolName === "string" && A2UI_TOOL_RE.test(meta.toolName);
}
__name(isA2uiToolMeta, "isA2uiToolMeta");
function splitA2uiText(raw) {
  const s = raw.replace(/^\s+/, "");
  if (s[0] !== "[") return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  try {
    const arr = JSON.parse(s.slice(0, end));
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return [arr, s.slice(end).trim()];
  } catch {
    return null;
  }
}
__name(splitA2uiText, "splitA2uiText");
function surfaceIdOf(c) {
  const cmd = c;
  return cmd?.createSurface?.surfaceId ?? cmd?.updateComponents?.surfaceId ?? cmd?.updateDataModel?.surfaceId ?? cmd?.deleteSurface?.surfaceId;
}
__name(surfaceIdOf, "surfaceIdOf");
function extractA2uiToolUpdate(params) {
  const update = params.update;
  if (!update || update["sessionUpdate"] !== "tool_call_update") return null;
  const meta = update["_meta"];
  if (!isA2uiToolMeta(meta)) return null;
  const content = update["content"];
  if (!Array.isArray(content)) return null;
  let split = null;
  let hitIndex = -1;
  for (let i = 0; i < content.length; i++) {
    const inner = content[i]?.content;
    if (typeof inner?.text === "string") {
      split = splitA2uiText(inner.text);
      if (split) {
        hitIndex = i;
        break;
      }
    }
  }
  if (!split) return null;
  const [commands, fallback] = split;
  const order = [];
  const grouped = /* @__PURE__ */ new Map();
  for (const c of commands) {
    const sid = surfaceIdOf(c);
    if (!sid) {
      const shape = c && typeof c === "object" ? Object.keys(c).join(",") || "empty object" : typeof c;
      writeStderrLine(
        `a2ui: dropping command with unrecognized shape (${shape})`
      );
      continue;
    }
    if (!grouped.has(sid)) {
      grouped.set(sid, []);
      order.push(sid);
    }
    grouped.get(sid).push(c);
  }
  const surfaces = order.map((sid) => ({
    surfaceId: sid,
    commands: grouped.get(sid)
  }));
  const sanitizedText = fallback || "[A2UI surface rendered]";
  const sanitizedContent = content.map(
    (block, i) => i === hitIndex ? {
      ...block,
      content: {
        ...block.content ?? {},
        text: sanitizedText
      }
    } : block
  );
  const sanitizedUpdate = {
    ...update,
    content: sanitizedContent
  };
  if (typeof update["rawOutput"] === "string") {
    sanitizedUpdate["rawOutput"] = sanitizedText;
  }
  return {
    surfaces,
    callId: typeof update["toolCallId"] === "string" ? update["toolCallId"] : void 0,
    sanitizedParams: {
      ...params,
      update: sanitizedUpdate
    }
  };
}
__name(extractA2uiToolUpdate, "extractA2uiToolUpdate");

// packages/acp-bridge/src/generation-stream.ts
init_esbuild_shims();
var GenerationStreamQueue = class {
  constructor(capacity) {
    this.capacity = capacity;
  }
  static {
    __name(this, "GenerationStreamQueue");
  }
  values = [];
  waiter;
  closed = false;
  failure;
  push(value) {
    if (this.closed) return false;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = void 0;
      waiter.resolve({ value, done: false });
      return true;
    }
    if (this.values.length >= this.capacity) return false;
    this.values.push(value);
    return true;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.settleWaiter();
  }
  fail(error) {
    if (this.closed) return;
    this.failure = error;
    this.closed = true;
    this.settleWaiter();
  }
  settleWaiter() {
    if (!this.waiter) return;
    const waiter = this.waiter;
    this.waiter = void 0;
    if (this.failure !== void 0) waiter.reject(this.failure);
    else waiter.resolve({ value: void 0, done: true });
  }
  next() {
    if (this.values.length > 0) {
      return Promise.resolve({ value: this.values.shift(), done: false });
    }
    if (this.failure !== void 0) return Promise.reject(this.failure);
    if (this.closed) {
      return Promise.resolve({ value: void 0, done: true });
    }
    if (this.waiter) {
      return Promise.reject(
        new Error("GenerationStreamQueue supports only one pending reader")
      );
    }
    return new Promise((resolve2, reject) => {
      this.waiter = { resolve: resolve2, reject };
    });
  }
  [Symbol.asyncIterator]() {
    return {
      next: /* @__PURE__ */ __name(() => this.next(), "next"),
      return: /* @__PURE__ */ __name(async () => {
        this.close();
        return { value: void 0, done: true };
      }, "return")
    };
  }
};

// packages/acp-bridge/src/sessionArtifacts.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import { promises as fs3 } from "node:fs";
import path3 from "node:path";
var SOURCE_RESERVATIONS = {
  tool: 100,
  client: 50,
  hook: 50
};
var WORKSPACE_STATUS_REFRESH_TTL_MS = 5e3;
var WORKSPACE_STATUS_REFRESH_BATCH_SIZE = 20;
var SNAPSHOT_AFTER_DURABLE_EVENTS = 50;
var MAX_SNAPSHOT_BACKOFF_MULTIPLIER = 4;
var MAX_TOMBSTONED_IDS = 500;
var MAX_STICKY_EPHEMERAL_IDS = 500;
var MAX_WORKSPACE_HASH_BYTES = 100 * 1024 * 1024;
var SECRET_TOKEN_VALUE_PATTERN = /(?:^|\s)(?:bearer\s+\S{8,}|sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_/-]{12,}|[a-f0-9]{40,}|[A-Za-z0-9+/]{48,}={0,2})(?:$|\s)/i;
var RESTORE_FAILED_WARNING_PREFIX = "artifact snapshot restore failed";
var RESTORE_PARTIAL_FAILED_WARNING_PREFIX = "artifact snapshot restore partially failed";
function isArtifactRestoreFailureWarning(warning) {
  return warning.startsWith(RESTORE_FAILED_WARNING_PREFIX) || warning.startsWith(RESTORE_PARTIAL_FAILED_WARNING_PREFIX);
}
__name(isArtifactRestoreFailureWarning, "isArtifactRestoreFailureWarning");
var SessionArtifactValidationError = class extends Error {
  constructor(message, field) {
    super(message);
    this.field = field;
    this.name = "SessionArtifactValidationError";
  }
  static {
    __name(this, "SessionArtifactValidationError");
  }
  code = "VALIDATION_FAILED";
};
var SessionArtifactAuthorizationError = class extends Error {
  constructor(sessionId, artifactId, ownerClientId, requesterClientId) {
    super(`artifact ${artifactId} is owned by a different client`);
    this.sessionId = sessionId;
    this.artifactId = artifactId;
    this.ownerClientId = ownerClientId;
    this.requesterClientId = requesterClientId;
    this.name = "SessionArtifactAuthorizationError";
  }
  static {
    __name(this, "SessionArtifactAuthorizationError");
  }
  code = "SESSION_ARTIFACT_FORBIDDEN";
};
var SessionArtifactStore = class {
  static {
    __name(this, "SessionArtifactStore");
  }
  sessionId;
  workspaceCwd;
  runtimeBaseDir;
  maxArtifacts;
  persistence;
  artifacts = /* @__PURE__ */ new Map();
  receivedSeq = 0;
  insertSeq = 0;
  persistenceSeq = 0;
  durableEventsSinceSnapshot = 0;
  consecutiveSnapshotFailures = 0;
  realWorkspaceCwdPromise;
  operationQueue = Promise.resolve();
  tombstonedIds = /* @__PURE__ */ new Set();
  tombstonedClientIds = /* @__PURE__ */ new Map();
  stickyEphemeralIds = /* @__PURE__ */ new Set();
  markerArtifacts = /* @__PURE__ */ new Map();
  // Failed removals or partial restores can leave ownership without a live record.
  pendingSnapshotRemovals = /* @__PURE__ */ new Set();
  lastRestoreWarnings = [];
  lastRestoreWarningDetails = [];
  constructor(options) {
    this.sessionId = options.sessionId;
    this.workspaceCwd = options.workspaceCwd;
    this.runtimeBaseDir = options.runtimeBaseDir ?? Storage.getRuntimeBaseDir();
    this.maxArtifacts = options.maxArtifacts ?? 200;
    this.persistence = options.persistence;
  }
  inputBatchLimit() {
    return this.maxArtifacts * 2;
  }
  resetWorkspaceResolutionCache() {
    this.realWorkspaceCwdPromise = void 0;
  }
  async list() {
    return this.enqueue(async () => {
      await this.refreshWorkspaceStatuses();
      await this.forgetVanishedAutoRecordedArtifacts();
      return {
        v: 1,
        sessionId: this.sessionId,
        artifacts: Array.from(this.artifacts.values()).sort((a, b) => a.insertSeq - b.insertSeq).map(toPublicArtifact),
        generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        limits: { maxArtifacts: this.maxArtifacts },
        ...this.lastRestoreWarnings.length > 0 ? { warnings: [...this.lastRestoreWarnings] } : {},
        ...this.lastRestoreWarningDetails.length > 0 ? { warningDetails: [...this.lastRestoreWarningDetails] } : {}
      };
    });
  }
  async get(artifactId) {
    return this.enqueue(async () => {
      const artifact = this.artifacts.get(artifactId);
      if (!artifact) return void 0;
      if (artifact.workspacePath && needsWorkspaceStatusRefresh(artifact, Date.now())) {
        await this.refreshWorkspaceStatus(artifact, { onError: "missing" });
      }
      if (isVanishedAutoRecordedWorkspaceArtifact(artifact)) {
        await this.forgetVanishedAutoRecordedArtifacts([artifact]);
        const kept = this.artifacts.get(artifactId);
        return kept ? toPublicArtifact(kept) : void 0;
      }
      return toPublicArtifact(artifact);
    });
  }
  async upsertMany(inputs, options = {}) {
    return this.enqueue(async () => {
      const validationStrict = options.validationStrict ?? options.strict;
      const persistenceStrict = options.persistenceStrict ?? options.strict;
      const before = this.cloneState();
      const normalizedResults = [];
      const warnings = [];
      const warningDetails = [];
      for (const input of inputs) {
        try {
          const expanded = await this.expandWorkspaceDirectoryInput(input);
          for (const item of expanded.inputs) {
            try {
              normalizedResults.push(
                await this.normalizeInput(
                  item,
                  ++this.receivedSeq,
                  options.trustedPublisher === true
                )
              );
            } catch (error) {
              if (validationStrict) {
                throw error;
              }
              const message = error instanceof Error ? error.message : String(error);
              writeStderrLine(
                `[artifacts] session=${this.sessionId} action=dropped reason=${JSON.stringify(
                  message
                )}`
              );
            }
          }
          if (expanded.warning) {
            warnings.push(expanded.warning);
          }
        } catch (error) {
          if (validationStrict) {
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          writeStderrLine(
            `[artifacts] session=${this.sessionId} action=dropped reason=${JSON.stringify(
              message
            )}`
          );
        }
      }
      const changes = [];
      let rollbackArtifacts = [];
      const rollback = /* @__PURE__ */ __name(async () => {
        this.restoreState(before);
        await this.reclaimSnapshotFiles(rollbackArtifacts);
      }, "rollback");
      try {
        for (const normalized of coalesceByIdentity(normalizedResults)) {
          const artifact = this.applyStickyEphemeralOverride(normalized);
          if (this.shouldSuppressTombstonedUpsert(artifact)) {
            writeStderrLine(
              `[artifacts] session=${this.sessionId} action=tombstone_replay_suppressed artifactId=${artifact.id}`
            );
            continue;
          }
          const existing = this.artifacts.get(artifact.id) ?? this.findPublishedUpgradeTarget(artifact) ?? this.findPublishedWorkspaceTarget(artifact);
          if (!existing) {
            const stored = {
              ...artifact,
              insertSeq: ++this.insertSeq
            };
            this.artifacts.set(stored.id, stored);
            changes.push({
              action: "created",
              artifactId: stored.id,
              artifact: toPublicArtifact(stored)
            });
            continue;
          }
          try {
            this.denyCrossClientMutation("upsert", existing.id, existing, {
              clientId: artifact.clientId
            });
          } catch (error) {
            if (validationStrict) {
              throw error;
            }
            if (error instanceof SessionArtifactAuthorizationError) {
              warnings.push(error.message);
              continue;
            }
            throw error;
          }
          const updated = mergeArtifact(existing, artifact);
          if (updated.changed) {
            if (updated.artifact.id !== existing.id) {
              const removeChange = {
                action: "removed",
                artifactId: existing.id,
                artifact: toRemovedPublicArtifact(existing),
                reason: "explicit",
                durableTombstoneRequired: existing.durableTombstoneRequired || existing.persistedAt !== void 0,
                removedClientId: existing.clientId
              };
              changes.push(removeChange);
              this.artifacts.delete(existing.id);
            } else if (shouldRecordEphemeralUnpin(existing, artifact)) {
              changes.push({
                action: "removed",
                artifactId: existing.id,
                artifact: toRemovedPublicArtifact(existing),
                reason: "unpin_to_ephemeral",
                durableTombstoneRequired: true
              });
            }
            this.artifacts.set(updated.artifact.id, updated.artifact);
            changes.push({
              action: "updated",
              artifactId: updated.artifact.id,
              artifact: toPublicArtifact(updated.artifact)
            });
          }
        }
        const createdIds = new Set(
          changes.filter((change) => change.action === "created").map((change) => change.artifactId)
        );
        rollbackArtifacts = changes.flatMap(
          (change) => change.action !== "removed" && change.artifact ? [change.artifact] : []
        );
        for (const artifact of rollbackArtifacts) {
          try {
            await retainArtifactSnapshot(
              artifact,
              this.runtimeBaseDir,
              this.sessionId
            );
          } catch (error) {
            if (validationStrict || persistenceStrict) throw error;
            warnings.push(
              `artifact ${artifact.id} kept without retaining its snapshot: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
        const overflowRemoved = await this.evictOverflow(
          createdIds,
          changes,
          persistenceStrict
        );
        changes.push(...overflowRemoved.removed);
        if (overflowRemoved.droppedCreated > 0) {
          warnings.push(
            `dropped ${overflowRemoved.droppedCreated} newly created artifacts because the store is full`
          );
        }
        const hasStrictDurableTransition = changes.some(
          shouldCommitBeforeDurablePersistence
        );
        let persistenceWarnings;
        if (hasStrictDurableTransition && !persistenceStrict) {
          try {
            persistenceWarnings = await this.persistChanges(changes, true);
          } catch (error) {
            await rollback();
            const artifactIds = changes.filter(shouldCommitBeforeDurablePersistence).map((change) => change.artifactId);
            const warning = "artifact durable removal not persisted; live changes rolled back";
            writeStderrLine(
              `[artifacts] session=${this.sessionId} action=upsert_rollback warning=${JSON.stringify(
                warning
              )} artifactIds=${JSON.stringify(artifactIds)} error=${JSON.stringify(
                error instanceof Error ? error.message : String(error)
              )}`
            );
            return {
              v: 1,
              sessionId: this.sessionId,
              changes: [],
              warnings: [warning],
              warningDetails: [
                persistenceFailureDetail({
                  message: warning,
                  operation: "upsert",
                  artifactIds,
                  error
                })
              ]
            };
          }
        } else {
          persistenceWarnings = await this.persistChanges(
            changes,
            persistenceStrict
          );
        }
        warnings.push(...persistenceWarnings);
        warningDetails.push(
          ...detailsForPersistenceWarnings(
            persistenceWarnings,
            changes,
            "upsert"
          )
        );
        stripDurableTombstoneMarkers(changes);
        await this.reclaimSnapshotFiles([
          ...changes.filter(
            (change) => change.action === "removed" && change.reason === "eviction"
          ).map((change) => change.artifact),
          ...overflowRemoved.droppedArtifacts
        ]);
      } catch (error) {
        if (validationStrict || persistenceStrict || error instanceof SessionArtifactAuthorizationError) {
          await rollback();
        }
        throw error;
      }
      return {
        v: 1,
        sessionId: this.sessionId,
        changes,
        ...warnings.length > 0 ? { warnings } : {},
        ...warningDetails.length > 0 ? { warningDetails } : {}
      };
    });
  }
  findPublishedUpgradeTarget(artifact) {
    if (artifact.storage !== "published" || !artifact.trustedPublisher || !artifact.managedId || !artifact.url) {
      return void 0;
    }
    const byUrl = this.artifacts.get(
      stableSessionArtifactId(this.sessionId, `url:${artifact.url}`)
    );
    if (byUrl && (byUrl.storage !== "published" || byUrl.managedId === artifact.managedId)) {
      return byUrl;
    }
    for (const existing of this.artifacts.values()) {
      if (existing.storage === "workspace" && existing.workspacePath && artifact.managedId === managedIdForWorkspacePath(
        this.workspaceCwd,
        existing.workspacePath
      ) || existing.storage === "published" && existing.managedId === artifact.managedId) {
        return existing;
      }
    }
    return void 0;
  }
  findPublishedWorkspaceTarget(artifact) {
    if (artifact.storage !== "workspace" || !artifact.workspacePath) {
      return void 0;
    }
    const managedId = managedIdForWorkspacePath(
      this.workspaceCwd,
      artifact.workspacePath
    );
    for (const existing of this.artifacts.values()) {
      if (existing.storage === "published" && existing.managedId === managedId) {
        return existing;
      }
    }
    return void 0;
  }
  async remove(artifactId, options) {
    return this.enqueue(async () => {
      const existing = this.artifacts.get(artifactId);
      if (!existing) {
        return { v: 1, sessionId: this.sessionId, changes: [] };
      }
      this.denyCrossClientMutation("remove", artifactId, existing, options);
      const removedAt = (/* @__PURE__ */ new Date()).toISOString();
      const removeChange = {
        action: "removed",
        artifactId,
        artifact: toRemovedPublicArtifact(existing, removedAt),
        reason: "explicit",
        durableTombstoneRequired: existing.durableTombstoneRequired || existing.retention !== "ephemeral" ? true : void 0,
        removedClientId: existing.clientId
      };
      const changes = [removeChange];
      const needsDurableTombstone = removeChange.durableTombstoneRequired === true;
      if (needsDurableTombstone) {
        const before = this.cloneState();
        this.artifacts.delete(artifactId);
        try {
          await this.persistChanges(changes, true);
        } catch (error) {
          this.restoreState(before);
          const warning = "artifact removal not persisted; live artifact kept";
          return {
            v: 1,
            sessionId: this.sessionId,
            changes: [],
            warnings: [warning],
            warningDetails: [
              persistenceFailureDetail({
                message: warning,
                operation: "remove",
                artifactIds: [artifactId],
                error
              })
            ]
          };
        }
      }
      if (!needsDurableTombstone) {
        this.artifacts.delete(artifactId);
      }
      const warnings = needsDurableTombstone ? [] : await this.persistChanges(changes, false);
      stripDurableTombstoneMarkers(changes);
      await this.reclaimSnapshotFiles([removeChange.artifact]);
      const warningDetails = detailsForPersistenceWarnings(
        warnings,
        changes,
        "remove"
      );
      return {
        v: 1,
        sessionId: this.sessionId,
        changes,
        ...warnings.length > 0 ? { warnings } : {},
        ...warningDetails.length > 0 ? { warningDetails } : {}
      };
    });
  }
  async restore(snapshot, options = {}) {
    if (!snapshot) return [];
    return this.enqueue(async () => {
      const warnings = [...snapshot?.warnings ?? []];
      const baselineWarnings = [...warnings];
      const previousState = this.cloneState();
      const preservedLiveEphemeralArtifacts = options.preserveLiveEphemeral ? Array.from(this.artifacts.values()).filter((artifact) => artifact.retention === "ephemeral").map(cloneStoredArtifact) : [];
      let restoredCount = 0;
      this.artifacts.clear();
      this.tombstonedIds.clear();
      this.tombstonedClientIds.clear();
      this.stickyEphemeralIds.clear();
      this.markerArtifacts.clear();
      if (snapshot) {
        this.insertSeq = 0;
        this.persistenceSeq = snapshot.sequence;
        this.durableEventsSinceSnapshot = 0;
        this.consecutiveSnapshotFailures = 0;
        for (const id of snapshot.tombstonedIds) {
          this.tombstonedIds.add(id);
        }
        for (const id of snapshot.stickyEphemeralIds.slice(
          -MAX_STICKY_EPHEMERAL_IDS
        )) {
          this.stickyEphemeralIds.add(id);
        }
        const markerIds = /* @__PURE__ */ new Set([
          ...this.tombstonedIds,
          ...this.stickyEphemeralIds
        ]);
        for (const artifact of snapshot.markerArtifacts ?? []) {
          if (!markerIds.has(artifact.id)) continue;
          const markerArtifact = await this.normalizeRestoredMarkerArtifact(
            artifact,
            warnings,
            options.workspaceAccess === "metadata-only"
          );
          if (markerArtifact)
            this.markerArtifacts.set(artifact.id, markerArtifact);
        }
      }
      for (const artifact of snapshot?.artifacts ?? []) {
        try {
          const input = persistedArtifactToInput(artifact);
          if (input.retention === "pinned") {
            input.retention = "restorable";
            warnings.push(
              `pinned artifact ${artifact.id} downgraded to restorable; runtime does not support pinned retention`
            );
          }
          let normalized = await this.normalizeInput(
            input,
            ++this.receivedSeq,
            artifact.storage === "published" && (!isFileArtifactUrl(artifact.url) || Boolean(getWebPreviewSnapshotId(artifact))),
            {
              metadataBudget: "persisted",
              workspaceExpected: workspaceExpectedFromArtifact(artifact),
              hashWorkspaceContent: false,
              ...options.workspaceAccess === "metadata-only" ? {
                workspaceAccess: "metadata-only",
                workspaceStatus: artifact.status
              } : {}
            }
          );
          if (this.stickyEphemeralIds.has(normalized.id) && normalized.retention !== "ephemeral") {
            normalized = {
              ...normalized,
              retention: "ephemeral",
              persistenceWarning: "sticky_override_active"
            };
          }
          const stickyApplied = normalized.persistenceWarning === "sticky_override_active";
          if (normalized.id !== artifact.id) {
            warnings.push(`skipped artifact with mismatched id ${artifact.id}`);
            continue;
          }
          const retention = normalized.retention;
          let persistenceWarning;
          if (stickyApplied) {
            persistenceWarning = "sticky_override_active";
          } else if (normalized.status !== "available") {
            persistenceWarning = "metadata_only_restore";
          }
          const stored = {
            ...normalized,
            retention,
            clientRetained: artifact.clientRetained,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
            persistedAt: artifact.persistedAt,
            status: normalized.status,
            restoreState: "restored",
            persistenceWarning,
            durableTombstoneRequired: retention !== "ephemeral" ? true : void 0,
            insertSeq: ++this.insertSeq
          };
          try {
            await retainArtifactSnapshot(
              stored,
              this.runtimeBaseDir,
              this.sessionId
            );
          } catch (error) {
            warnings.push(
              `restored artifact ${stored.id} without retaining its snapshot: ${error instanceof Error ? error.message : String(error)}`
            );
          }
          this.artifacts.set(stored.id, stored);
          restoredCount++;
        } catch (error) {
          warnings.push(
            `skipped artifact restore: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      if (snapshot.artifacts.length > 0 && restoredCount === 0) {
        this.restoreState(previousState);
        const rollbackWarnings = [
          ...baselineWarnings,
          `${RESTORE_FAILED_WARNING_PREFIX}; kept existing live artifacts`
        ];
        this.setLastRestoreWarnings(rollbackWarnings);
        return rollbackWarnings;
      }
      if (previousState.artifacts.size > 0 && baselineWarnings.some(isArtifactSnapshotCompletenessWarning)) {
        this.restoreState(previousState);
        const rollbackWarnings = [
          ...baselineWarnings,
          restoredCount === 0 ? `${RESTORE_FAILED_WARNING_PREFIX}; kept existing live artifacts` : `${RESTORE_PARTIAL_FAILED_WARNING_PREFIX}; kept existing live artifacts`
        ];
        this.setLastRestoreWarnings(rollbackWarnings);
        return rollbackWarnings;
      }
      for (const artifact of preservedLiveEphemeralArtifacts) {
        if (this.artifacts.has(artifact.id) || this.tombstonedIds.has(artifact.id)) {
          continue;
        }
        this.artifacts.set(artifact.id, {
          ...artifact,
          insertSeq: ++this.insertSeq
        });
      }
      if (!warnings.some(isArtifactSnapshotCompletenessWarning)) {
        this.pendingSnapshotRemovals.clear();
      }
      const evicted = await this.evictOverflow(/* @__PURE__ */ new Set(), []);
      if (evicted.removed.length > 0) {
        warnings.push("restored artifact list pruned to live limit");
        const persistenceWarnings = await this.persistChanges(
          evicted.removed,
          false
        );
        warnings.push(...persistenceWarnings);
        if (persistenceWarnings.length === 0) {
          await this.reclaimSnapshotFiles(
            evicted.removed.map((change) => change.artifact)
          );
        }
      }
      const restoredIds = /* @__PURE__ */ new Set([
        ...snapshot.artifacts.map((artifact) => artifact.id),
        ...preservedLiveEphemeralArtifacts.map((artifact) => artifact.id)
      ]);
      const discarded = [...previousState.artifacts.values()].filter(
        (artifact) => !restoredIds.has(artifact.id)
      );
      if (warnings.some(isArtifactSnapshotCompletenessWarning)) {
        for (const artifact of previousState.artifacts.values()) {
          const id = getWebPreviewSnapshotId(artifact);
          if (id) this.pendingSnapshotRemovals.add(id);
        }
      } else {
        await this.reclaimSnapshotFiles(discarded);
      }
      this.setLastRestoreWarnings(warnings);
      return warnings;
    });
  }
  async recordSnapshot() {
    const persistence = this.persistence;
    if (!persistence) {
      return [
        "artifact persistence unavailable; restored artifacts not snapshotted"
      ];
    }
    return this.enqueue(async () => {
      const recordedAt = (/* @__PURE__ */ new Date()).toISOString();
      const sequence = this.persistenceSeq + 1;
      try {
        await persistence.recordSnapshot(
          this.buildSnapshotPayload(recordedAt, sequence)
        );
        this.persistenceSeq = sequence;
        this.durableEventsSinceSnapshot = 0;
        this.consecutiveSnapshotFailures = 0;
        this.pendingSnapshotRemovals.clear();
        return [];
      } catch (error) {
        writeStderrLine(
          `[artifacts] session=${this.sessionId} action=snapshot_failed reason=${JSON.stringify(
            error instanceof Error ? error.message : String(error)
          )}`
        );
        return ["artifact snapshot not persisted"];
      }
    });
  }
  async normalizeRestoredMarkerArtifact(artifact, warnings, metadataOnly = false) {
    try {
      const input = persistedArtifactToInput(artifact);
      if (input.retention === "pinned") {
        input.retention = "restorable";
        warnings.push(
          `pinned marker artifact ${artifact.id} downgraded to restorable; runtime does not support pinned retention`
        );
      }
      const normalized = await this.normalizeInput(
        input,
        ++this.receivedSeq,
        artifact.storage === "published" && (!isFileArtifactUrl(artifact.url) || Boolean(getWebPreviewSnapshotId(artifact))),
        {
          metadataBudget: "persisted",
          workspaceExpected: workspaceExpectedFromArtifact(artifact),
          hashWorkspaceContent: false,
          ...metadataOnly ? {
            workspaceAccess: "metadata-only",
            workspaceStatus: artifact.status
          } : {}
        }
      );
      if (normalized.id !== artifact.id) {
        warnings.push(
          `skipped marker artifact with mismatched id ${artifact.id}`
        );
        return void 0;
      }
      return toPersistedArtifact(
        {
          ...normalized,
          clientRetained: artifact.clientRetained,
          createdAt: artifact.createdAt,
          updatedAt: artifact.updatedAt,
          persistedAt: artifact.persistedAt
        },
        artifact.persistedAt ?? artifact.updatedAt
      );
    } catch (error) {
      warnings.push(
        `skipped marker artifact ${artifact.id}: ${error instanceof Error ? error.message : String(error)}`
      );
      return void 0;
    }
  }
  cloneState() {
    return {
      artifacts: new Map(
        Array.from(this.artifacts.entries()).map(([id, artifact]) => [
          id,
          cloneStoredArtifact(artifact)
        ])
      ),
      receivedSeq: this.receivedSeq,
      insertSeq: this.insertSeq,
      persistenceSeq: this.persistenceSeq,
      durableEventsSinceSnapshot: this.durableEventsSinceSnapshot,
      consecutiveSnapshotFailures: this.consecutiveSnapshotFailures,
      tombstonedIds: new Set(this.tombstonedIds),
      tombstonedClientIds: new Map(this.tombstonedClientIds),
      stickyEphemeralIds: new Set(this.stickyEphemeralIds),
      markerArtifacts: new Map(this.markerArtifacts),
      pendingSnapshotRemovals: new Set(this.pendingSnapshotRemovals),
      lastRestoreWarnings: [...this.lastRestoreWarnings],
      lastRestoreWarningDetails: [...this.lastRestoreWarningDetails]
    };
  }
  restoreState(state) {
    this.artifacts.clear();
    for (const [id, artifact] of state.artifacts) {
      this.artifacts.set(id, cloneStoredArtifact(artifact));
    }
    this.receivedSeq = state.receivedSeq;
    this.insertSeq = state.insertSeq;
    this.persistenceSeq = state.persistenceSeq;
    this.durableEventsSinceSnapshot = state.durableEventsSinceSnapshot;
    this.consecutiveSnapshotFailures = state.consecutiveSnapshotFailures;
    this.tombstonedIds.clear();
    for (const id of state.tombstonedIds) {
      this.tombstonedIds.add(id);
    }
    this.tombstonedClientIds.clear();
    for (const [id, clientId] of state.tombstonedClientIds) {
      this.tombstonedClientIds.set(id, clientId);
    }
    this.stickyEphemeralIds.clear();
    for (const id of state.stickyEphemeralIds) {
      this.stickyEphemeralIds.add(id);
    }
    this.markerArtifacts.clear();
    for (const [id, artifact] of state.markerArtifacts) {
      this.markerArtifacts.set(id, artifact);
    }
    this.pendingSnapshotRemovals.clear();
    for (const id of state.pendingSnapshotRemovals) {
      this.pendingSnapshotRemovals.add(id);
    }
    this.setLastRestoreWarnings(state.lastRestoreWarnings);
    this.lastRestoreWarningDetails = [...state.lastRestoreWarningDetails];
  }
  async persistChanges(changes, strict = false) {
    const durableChanges = changes.filter(isDurablePersistenceChange);
    if (durableChanges.length === 0) {
      return [];
    }
    if (!this.persistence) {
      if (strict) {
        throw new SessionArtifactValidationError(
          "artifact persistence is unavailable",
          "retention"
        );
      }
      const warnings = this.downgradeDurableChanges(durableChanges);
      this.applyDurableMarkers(durableChanges);
      return warnings;
    }
    const recordedAt = (/* @__PURE__ */ new Date()).toISOString();
    for (const change of durableChanges) {
      if (change.action === "removed") continue;
      const stored = this.artifacts.get(change.artifactId);
      if (!stored) continue;
      const artifact = {
        ...toPublicArtifact(stored),
        persistedAt: recordedAt
      };
      change.artifact = artifact;
    }
    const sequence = this.persistenceSeq + 1;
    const payload = {
      v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
      sessionId: this.sessionId,
      sequence,
      recordedAt,
      changes: durableChanges.map(
        (change) => toPersistedChange(change, recordedAt)
      )
    };
    try {
      await this.persistence.recordEvent(payload);
      this.persistenceSeq = sequence;
      for (const change of durableChanges) {
        const snapshotId = change.artifact && getWebPreviewSnapshotId(change.artifact);
        if (snapshotId) this.pendingSnapshotRemovals.delete(snapshotId);
        if (change.action === "removed") continue;
        const stored = this.artifacts.get(change.artifactId);
        if (!stored) continue;
        stored.persistedAt = recordedAt;
        stored.durableTombstoneRequired = true;
        change.artifact = toPublicArtifact(stored);
      }
      this.applyDurableMarkers(durableChanges);
      await this.maybeRecordSnapshot(recordedAt);
      return [];
    } catch (error) {
      if (strict) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const artifactIds = durableChanges.map((change) => change.artifactId);
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=persist_failed sequence=${payload.sequence} artifactIds=${JSON.stringify(
          artifactIds
        )} reason=${JSON.stringify(reason)}`
      );
      const warnings = this.downgradeDurableChanges(durableChanges);
      this.applyDurableMarkers(durableChanges);
      return warnings;
    }
  }
  async maybeRecordSnapshot(recordedAt) {
    if (!this.persistence) return;
    this.durableEventsSinceSnapshot++;
    const snapshotThreshold = SNAPSHOT_AFTER_DURABLE_EVENTS * Math.min(
      MAX_SNAPSHOT_BACKOFF_MULTIPLIER,
      2 ** this.consecutiveSnapshotFailures
    );
    if (this.durableEventsSinceSnapshot < snapshotThreshold) {
      return;
    }
    const sequence = this.persistenceSeq + 1;
    try {
      await this.persistence.recordSnapshot(
        this.buildSnapshotPayload(recordedAt, sequence)
      );
      this.persistenceSeq = sequence;
      this.durableEventsSinceSnapshot = 0;
      this.consecutiveSnapshotFailures = 0;
      this.pendingSnapshotRemovals.clear();
    } catch (error) {
      this.consecutiveSnapshotFailures = Math.min(
        this.consecutiveSnapshotFailures + 1,
        Math.log2(MAX_SNAPSHOT_BACKOFF_MULTIPLIER)
      );
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=snapshot_failed reason=${JSON.stringify(
          error instanceof Error ? error.message : String(error)
        )}`
      );
    }
  }
  buildSnapshotPayload(recordedAt, sequence) {
    const artifacts = Array.from(this.artifacts.values()).filter((artifact) => artifact.retention !== "ephemeral").sort((a, b) => a.insertSeq - b.insertSeq).map((artifact) => toPersistedArtifact(artifact, recordedAt));
    const stickyEphemeralIds = Array.from(this.stickyEphemeralIds).filter(
      (id) => this.artifacts.has(id) || this.markerArtifacts.has(id)
    );
    const markerArtifacts = this.buildMarkerArtifacts(
      recordedAt,
      stickyEphemeralIds
    );
    return {
      v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
      sessionId: this.sessionId,
      sequence,
      recordedAt,
      artifacts,
      tombstonedIds: Array.from(this.tombstonedIds),
      stickyEphemeralIds,
      ...markerArtifacts.length > 0 ? { markerArtifacts } : {}
    };
  }
  buildMarkerArtifacts(recordedAt, stickyEphemeralIds) {
    const markerIds = [...this.tombstonedIds, ...stickyEphemeralIds];
    const artifacts = [];
    const seen = /* @__PURE__ */ new Set();
    for (const id of markerIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const live = this.artifacts.get(id);
      if (live) {
        artifacts.push(toPersistedArtifact(toPublicArtifact(live), recordedAt));
        continue;
      }
      const markerArtifact = this.markerArtifacts.get(id);
      if (markerArtifact) {
        artifacts.push(markerArtifact);
      }
    }
    return artifacts;
  }
  downgradeDurableChanges(changes) {
    let downgraded = false;
    let removalNotPersisted = false;
    for (const change of changes) {
      if (change.action === "removed") {
        removalNotPersisted = true;
        const snapshotId = change.artifact && getWebPreviewSnapshotId(change.artifact);
        if (snapshotId) this.pendingSnapshotRemovals.add(snapshotId);
        if (change.reason === "explicit") {
          this.rememberTombstone(change);
          this.stickyEphemeralIds.delete(change.artifactId);
        }
        continue;
      }
      const stored = this.artifacts.get(change.artifactId);
      if (!stored) continue;
      stored.retention = "ephemeral";
      stored.persistenceWarning = "persistence_unavailable";
      stored.durableTombstoneRequired = stored.durableTombstoneRequired || stored.persistedAt !== void 0;
      delete stored.persistedAt;
      change.artifact = toPublicArtifact(stored);
      downgraded = true;
    }
    const warnings = [];
    if (downgraded) {
      warnings.push(
        "artifact persistence unavailable; durable artifacts kept ephemeral"
      );
    }
    if (removalNotPersisted) {
      warnings.push("artifact removal not persisted; live removal kept");
    }
    return warnings;
  }
  applyDurableMarkers(changes) {
    for (const change of changes) {
      if (change.action === "removed") {
        if (change.reason === "explicit") {
          this.rememberTombstone(change);
          this.stickyEphemeralIds.delete(change.artifactId);
        } else if (change.reason === "eviction") {
          this.stickyEphemeralIds.delete(change.artifactId);
          this.markerArtifacts.delete(change.artifactId);
        } else if (change.reason === "unpin_to_ephemeral") {
          this.rememberStickyEphemeral(change);
        }
        continue;
      }
      if (change.artifact && change.artifact.retention !== "ephemeral") {
        this.tombstonedIds.delete(change.artifactId);
        this.tombstonedClientIds.delete(change.artifactId);
        this.stickyEphemeralIds.delete(change.artifactId);
        this.markerArtifacts.delete(change.artifactId);
      }
    }
  }
  rememberStickyEphemeral(change) {
    const artifactId = change.artifactId;
    this.stickyEphemeralIds.delete(artifactId);
    this.stickyEphemeralIds.add(artifactId);
    if (change.artifact) {
      this.markerArtifacts.set(
        artifactId,
        toPersistedArtifact(change.artifact, change.artifact.updatedAt)
      );
    }
    while (this.stickyEphemeralIds.size > MAX_STICKY_EPHEMERAL_IDS) {
      const oldest2 = this.stickyEphemeralIds.values().next().value;
      if (oldest2 === void 0) break;
      this.stickyEphemeralIds.delete(oldest2);
      this.markerArtifacts.delete(oldest2);
    }
  }
  rememberTombstone(change) {
    this.tombstonedIds.delete(change.artifactId);
    this.tombstonedIds.add(change.artifactId);
    this.tombstonedClientIds.set(
      change.artifactId,
      change.removedClientId ?? this.artifacts.get(change.artifactId)?.clientId
    );
    if (change.artifact) {
      this.markerArtifacts.set(
        change.artifactId,
        toPersistedArtifact(change.artifact, change.artifact.updatedAt)
      );
    }
    while (this.tombstonedIds.size > MAX_TOMBSTONED_IDS) {
      const oldest2 = this.tombstonedIds.values().next().value;
      if (oldest2 === void 0) break;
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=tombstone_evicted artifactId=${JSON.stringify(
          oldest2
        )} limit=${MAX_TOMBSTONED_IDS}`
      );
      this.tombstonedIds.delete(oldest2);
      this.tombstonedClientIds.delete(oldest2);
      this.markerArtifacts.delete(oldest2);
    }
  }
  setLastRestoreWarnings(warnings) {
    this.lastRestoreWarnings = [...warnings];
    this.lastRestoreWarningDetails = detailsForRestoreWarnings(warnings);
  }
  enqueue(operation) {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => void 0,
      () => void 0
    );
    return result;
  }
  denyCrossClientMutation(action, artifactId, existing, options) {
    if (existing.source !== "client" || existing.clientId === void 0 || existing.clientId === options?.clientId) {
      return;
    }
    writeStderrLine(
      `[artifacts] session=${this.sessionId} action=${action}_denied artifactId=${artifactId} owner=${existing.clientId} requester=${options?.clientId ?? "<anonymous>"}`
    );
    throw new SessionArtifactAuthorizationError(
      this.sessionId,
      artifactId,
      existing.clientId,
      options?.clientId
    );
  }
  async expandWorkspaceDirectoryInput(input) {
    const workspacePath = typeof input.workspacePath === "string" ? input.workspacePath.trim() : void 0;
    if (!workspacePath) {
      return { inputs: [input] };
    }
    const realWorkspace = await this.getRealWorkspaceCwdForValidation();
    const normalizedPath = normalizeWorkspacePath(workspacePath, realWorkspace);
    const absolutePath = path3.resolve(realWorkspace, normalizedPath);
    let stat;
    try {
      stat = await fs3.lstat(absolutePath);
    } catch (error) {
      if (isNotFoundError(error)) {
        return { inputs: [input] };
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new SessionArtifactValidationError(
        `workspacePath could not be inspected: ${reason}`,
        "workspacePath"
      );
    }
    let walkDir = absolutePath;
    let walkRelative = normalizedPath;
    if (stat.isSymbolicLink()) {
      let realPath;
      try {
        realPath = await fs3.realpath(absolutePath);
      } catch {
        return { inputs: [input] };
      }
      let realStat;
      try {
        realStat = await fs3.lstat(realPath);
      } catch (error) {
        if (isNotFoundError(error)) {
          return { inputs: [input] };
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new SessionArtifactValidationError(
          `workspacePath could not be inspected: ${reason}`,
          "workspacePath"
        );
      }
      if (!realStat.isDirectory()) {
        return { inputs: [input] };
      }
      walkDir = realPath;
      walkRelative = normalizedPath;
    } else if (!stat.isDirectory()) {
      return { inputs: [input] };
    } else {
      try {
        walkDir = await fs3.realpath(absolutePath);
      } catch (error) {
        if (isNotFoundError(error)) {
          return { inputs: [input] };
        }
        const reason = error instanceof Error ? error.message : String(error);
        throw new SessionArtifactValidationError(
          `workspacePath could not be inspected: ${reason}`,
          "workspacePath"
        );
      }
    }
    const resolvedRelative = path3.relative(realWorkspace, walkDir);
    if (!resolvedRelative || isOutsidePath(resolvedRelative)) {
      throw new SessionArtifactValidationError(
        "workspacePath must stay inside the workspace",
        "workspacePath"
      );
    }
    if (pathHasSkippedDirectoryComponent(
      resolvedRelative.split(path3.sep).join("/")
    ) || walkRelative && pathHasSkippedDirectoryComponent(walkRelative)) {
      throw new SessionArtifactValidationError(
        "workspacePath is a skipped directory and cannot be recorded",
        "workspacePath"
      );
    }
    if (input.metadata !== void 0 && !isPlainMetadataObject(input.metadata)) {
      throw new SessionArtifactValidationError(
        "metadata must be an object",
        "metadata"
      );
    }
    const childMetadata = {
      ...isPlainMetadataObject(input.metadata) ? input.metadata : {},
      expandedFromDirectory: true
    };
    if (Buffer.byteLength(JSON.stringify(childMetadata), "utf8") > 4096) {
      throw new SessionArtifactValidationError(
        "metadata is too large to expand a directory",
        "metadata"
      );
    }
    const parentTitle = normalizeString(input.title, "title", 200, true);
    const parentDescription = normalizeString(
      input.description,
      "description",
      1e3,
      false
    );
    let collected;
    try {
      collected = await collectRecordableWorkspaceFiles(
        walkDir,
        walkRelative,
        realWorkspace,
        (filePath) => isRecordableDerivedChild(path3.posix.basename(filePath), filePath)
      );
    } catch (error) {
      if (isNotFoundError(error)) {
        return { inputs: [input] };
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new SessionArtifactValidationError(
        `workspacePath could not be inspected: ${reason}`,
        "workspacePath"
      );
    }
    if (collected.files.length === 0) {
      throw new SessionArtifactValidationError(
        collected.depthLimited ? `workspacePath is a directory whose recordable files are deeper than ${MAX_DIRECTORY_ARTIFACT_DEPTH} levels` : "workspacePath is a directory with no recordable files",
        "workspacePath"
      );
    }
    const warnings = [];
    if (collected.truncated) {
      warnings.push(
        `workspacePath "${normalizedPath}" contained more than ${MAX_DIRECTORY_ARTIFACT_FILES} files; recorded the first ${collected.files.length}`
      );
    }
    if (collected.depthLimited) {
      warnings.push(
        `workspacePath "${normalizedPath}" exceeded ${MAX_DIRECTORY_ARTIFACT_DEPTH} directory levels; some files were not recorded`
      );
    }
    if (collected.unreadable) {
      warnings.push(
        `workspacePath "${normalizedPath}" contained subdirectories that could not be read`
      );
    }
    if (collected.skippedUnrecordable > 0) {
      warnings.push(
        `workspacePath "${normalizedPath}" skipped ${collected.skippedUnrecordable} files whose names cannot be recorded as artifact titles`
      );
    }
    return {
      inputs: collected.files.map((filePath) => {
        const title = path3.posix.basename(filePath).trim();
        const description = parentDescription || (parentTitle && parentTitle !== title ? parentTitle : void 0);
        return {
          ...input,
          title,
          workspacePath: filePath,
          kind: void 0,
          mimeType: void 0,
          sizeBytes: void 0,
          metadata: childMetadata,
          ...description ? { description } : { description: void 0 }
        };
      }),
      ...warnings.length > 0 ? { warning: warnings.join("; ") } : {}
    };
  }
  async normalizeInput(input, receivedSeq, trustedPublisherFromCaller, options = {}) {
    if (!input || typeof input !== "object") {
      throw new SessionArtifactValidationError("Artifact must be an object");
    }
    const title = normalizeString(input.title, "title", 200, true);
    const description = normalizeString(
      input.description,
      "description",
      1e3,
      false
    );
    const source = input.source ?? "tool";
    if (source !== "tool" && source !== "hook" && source !== "client") {
      throw new SessionArtifactValidationError(
        "source must be tool, hook, or client",
        "source"
      );
    }
    const trustedPublisher = trustedPublisherFromCaller;
    const workspacePath = input.workspacePath ? normalizeWorkspacePath(
      input.workspacePath,
      options.workspaceAccess === "metadata-only" ? this.workspaceCwd : await this.getRealWorkspaceCwdForValidation()
    ) : void 0;
    const managedId = normalizeManagedId(input.managedId);
    const rawStorage = input.storage;
    const storage = inferStorage(rawStorage, {
      workspacePath,
      managedId,
      url: input.url,
      trustedPublisher
    });
    const url = input.url ? normalizeArtifactUrl(input.url, trustedPublisher) : void 0;
    validateLocator(storage, {
      workspacePath,
      managedId,
      url,
      trustedPublisher
    });
    const retention = normalizeRetention(input.retention, {
      persistenceAvailable: this.persistence !== void 0
    });
    const workspaceStatus = workspacePath ? options.workspaceAccess === "metadata-only" ? {
      status: options.workspaceStatus ?? "missing",
      ...options.workspaceExpected?.sizeBytes !== void 0 ? { sizeBytes: options.workspaceExpected.sizeBytes } : {}
    } : await this.getInitialWorkspaceStatus(
      workspacePath,
      options.workspaceExpected,
      { hashContent: options.hashWorkspaceContent !== false }
    ) : void 0;
    if (workspaceStatus?.escaped) {
      throw new SessionArtifactValidationError(
        "workspacePath must stay inside the workspace",
        "workspacePath"
      );
    }
    const metadata = withWorkspaceContentHashMetadata(
      normalizeMetadata(input.metadata, {
        budget: options.metadataBudget ?? "user",
        trustedPublisher
      }),
      workspaceStatus
    );
    const kind = normalizeKind(
      input.kind ?? inferKind({ storage, workspacePath, url })
    );
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const identityKey = buildIdentityKey({
      storage,
      workspacePath,
      managedId,
      url
    });
    const id = stableSessionArtifactId(this.sessionId, identityKey);
    return {
      id,
      identityKey,
      receivedSeq,
      retentionExplicit: input.retention !== void 0,
      retentionSource: source,
      trustedPublisher,
      kind,
      storage,
      source,
      status: workspaceStatus?.status ?? "available",
      ...workspacePath && options.workspaceAccess !== "metadata-only" ? { lastStatAt: Date.now() } : {},
      title,
      description,
      workspacePath,
      managedId,
      url,
      mimeType: normalizeString(input.mimeType, "mimeType", 120, false),
      sizeBytes: workspaceStatus?.sizeBytes !== void 0 ? workspaceStatus.sizeBytes : input.sizeBytes !== void 0 ? normalizeSizeBytes(input.sizeBytes) : void 0,
      metadata,
      retention,
      restoreState: "live",
      ...this.persistence === void 0 && retention !== "ephemeral" ? { persistenceWarning: "persistence_unavailable" } : {},
      clientRetained: source === "client" && (input.clientRetained !== void 0 ? input.clientRetained === true : true),
      createdAt: now,
      updatedAt: now,
      toolCallId: normalizeString(input.toolCallId, "toolCallId", 200, false),
      toolName: normalizeString(input.toolName, "toolName", 200, false),
      hookEventName: normalizeString(
        input.hookEventName,
        "hookEventName",
        200,
        false
      ),
      clientId: normalizeString(input.clientId, "clientId", 200, false)
    };
  }
  shouldSuppressTombstonedUpsert(artifact) {
    if (!this.tombstonedIds.has(artifact.id)) {
      return false;
    }
    const tombstonedClientId = this.tombstonedClientIds.get(artifact.id);
    if (artifact.source !== "client") {
      return false;
    }
    return !(artifact.retentionExplicit && artifact.clientId !== void 0 && artifact.clientId === tombstonedClientId);
  }
  async refreshWorkspaceStatuses() {
    const now = Date.now();
    const staleWorkspaceArtifacts = Array.from(this.artifacts.values()).filter((artifact) => artifact.workspacePath).filter((artifact) => needsWorkspaceStatusRefresh(artifact, now));
    await runInBatches(
      staleWorkspaceArtifacts,
      WORKSPACE_STATUS_REFRESH_BATCH_SIZE,
      (artifact) => this.refreshWorkspaceStatus(artifact, {
        onError: "missing",
        now
      })
    );
  }
  applyStickyEphemeralOverride(artifact) {
    if (!this.stickyEphemeralIds.has(artifact.id) || artifact.retentionExplicit || artifact.retention === "ephemeral") {
      return artifact;
    }
    return {
      ...artifact,
      retention: "ephemeral",
      retentionExplicit: true,
      persistenceWarning: "sticky_override_active"
    };
  }
  async getInitialWorkspaceStatus(workspacePath, expected, options = { hashContent: true }) {
    try {
      return await getWorkspaceStatus(
        workspacePath,
        this.getRealWorkspaceCwd(),
        expected,
        options
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SessionArtifactValidationError(
        `workspacePath could not be inspected: ${reason}`,
        "workspacePath"
      );
    }
  }
  async refreshWorkspaceStatus(artifact, options) {
    if (!artifact.workspacePath) {
      return;
    }
    const previousStatus = artifact.status;
    const previousSizeBytes = artifact.sizeBytes;
    try {
      const status = await getWorkspaceStatus(
        artifact.workspacePath,
        this.getRealWorkspaceCwd(),
        {
          sizeBytes: recordedWorkspaceSizeBytes(artifact),
          mtimeMs: artifact.metadata?.[WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY],
          sha256: artifact.metadata?.[WORKSPACE_CONTENT_SHA256_METADATA_KEY]
        }
      );
      const contentChanged = isWorkspaceContentChanged(artifact, status);
      artifact.status = contentChanged ? "changed" : status.status;
      artifact.missingFromStatError = void 0;
      if (status.escaped) {
        artifact.status = "missing";
        artifact.sizeBytes = void 0;
        artifact.hideWorkspacePath = true;
      } else if (status.status === "missing") {
        artifact.sizeBytes = void 0;
      } else if (status.sizeBytes !== void 0) {
        if (artifact.status === "changed" && artifact.metadata?.[WORKSPACE_CONTENT_SIZE_BYTES_METADATA_KEY] === void 0) {
          const baseline = recordedWorkspaceSizeBytes(artifact);
          if (baseline !== void 0) {
            artifact.metadata = {
              ...artifact.metadata,
              [WORKSPACE_CONTENT_SIZE_BYTES_METADATA_KEY]: baseline
            };
          }
        }
        artifact.sizeBytes = status.sizeBytes;
      }
      if (artifact.status === "available" && !status.escaped) {
        artifact.metadata = withWorkspaceContentHashMetadata(
          artifact.metadata,
          {
            status: "available",
            sha256: status.sha256,
            mtimeMs: status.mtimeMs,
            sizeBytes: status.sizeBytes
          }
        );
      }
      artifact.lastStatAt = options.now ?? Date.now();
      const observationChanged = !status.escaped && status.status !== "missing" && recordWorkspaceObservation(artifact, status);
      if (artifact.status !== previousStatus || artifact.sizeBytes !== previousSizeBytes || observationChanged) {
        artifact.updatedAt = new Date(artifact.lastStatAt).toISOString();
      }
    } catch (error) {
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=status_refresh_failed artifactId=${artifact.id} reason=${JSON.stringify(
          error instanceof Error ? error.message : String(error)
        )}`
      );
      if (options.onError === "missing") {
        artifact.status = "missing";
        artifact.sizeBytes = void 0;
        artifact.missingFromStatError = true;
        artifact.lastStatAt = options.now ?? Date.now();
        if (previousStatus !== "missing" || previousSizeBytes !== void 0) {
          artifact.updatedAt = new Date(artifact.lastStatAt).toISOString();
        }
      }
      return;
    }
  }
  async forgetVanishedAutoRecordedArtifacts(candidates) {
    const vanished = (candidates ?? Array.from(this.artifacts.values())).filter(
      isVanishedAutoRecordedWorkspaceArtifact
    );
    if (vanished.length === 0) {
      return;
    }
    const removedAt = (/* @__PURE__ */ new Date()).toISOString();
    const changes = vanished.map(
      (existing) => ({
        action: "removed",
        artifactId: existing.id,
        artifact: toRemovedPublicArtifact(existing, removedAt),
        reason: "eviction",
        durableTombstoneRequired: existing.durableTombstoneRequired || existing.retention !== "ephemeral" ? true : void 0,
        removedClientId: existing.clientId
      })
    );
    const needsDurableTombstone = changes.some(
      (change) => change.durableTombstoneRequired === true
    );
    const before = this.cloneState();
    for (const artifact of vanished) {
      this.artifacts.delete(artifact.id);
    }
    try {
      await this.persistChanges(changes, needsDurableTombstone);
    } catch (error) {
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=vanish_forget_failed artifactIds=${JSON.stringify(
          vanished.map((artifact) => artifact.id)
        )} reason=${JSON.stringify(
          error instanceof Error ? error.message : String(error)
        )}`
      );
      this.restoreState(before);
    }
  }
  getRealWorkspaceCwd() {
    if (!this.realWorkspaceCwdPromise) {
      const promise = fs3.realpath(this.workspaceCwd).catch((error) => {
        if (this.realWorkspaceCwdPromise === promise) {
          this.realWorkspaceCwdPromise = void 0;
        }
        throw error;
      });
      this.realWorkspaceCwdPromise = promise;
    }
    return this.realWorkspaceCwdPromise;
  }
  async getRealWorkspaceCwdForValidation() {
    try {
      return await this.getRealWorkspaceCwd();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new SessionArtifactValidationError(
        `workspacePath could not be inspected: ${reason}`,
        "workspacePath"
      );
    }
  }
  async reclaimSnapshotFiles(artifacts) {
    for (const artifact of artifacts) {
      if (!artifact) continue;
      const id = getWebPreviewSnapshotId(artifact);
      if (!id || this.pendingSnapshotRemovals.has(id) || [...this.artifacts.values()].some(
        (kept) => getWebPreviewSnapshotId(kept) === id
      ))
        continue;
      try {
        await deleteArtifactSnapshot(
          artifact,
          this.runtimeBaseDir,
          this.sessionId
        );
      } catch {
      }
    }
  }
  async evictOverflow(createdIds, changes, strict = false) {
    const removed = [];
    const droppedArtifacts = [];
    if (this.artifacts.size <= this.maxArtifacts) {
      return { removed, droppedCreated: 0, droppedArtifacts };
    }
    const createdInThisBatch = new Set(createdIds);
    const candidates = Array.from(this.artifacts.values()).filter(
      (artifact) => !createdInThisBatch.has(artifact.id)
    );
    const now = Date.now();
    const staleWorkspaceCandidates = candidates.filter((artifact) => artifact.workspacePath).filter((artifact) => needsWorkspaceStatusRefresh(artifact, now));
    await runInBatches(
      staleWorkspaceCandidates,
      WORKSPACE_STATUS_REFRESH_BATCH_SIZE,
      (artifact) => this.refreshWorkspaceStatus(artifact, { onError: "preserve", now })
    );
    const sourceCounts = countByRetentionSource(this.artifacts.values());
    while (this.artifacts.size > this.maxArtifacts) {
      const artifact = selectEvictionCandidate(candidates, sourceCounts);
      if (!artifact) break;
      this.artifacts.delete(artifact.id);
      candidates.splice(candidates.indexOf(artifact), 1);
      sourceCounts[artifact.retentionSource]--;
      removePriorChange(changes, artifact.id);
      removed.push({
        action: "removed",
        artifactId: artifact.id,
        artifact: toRemovedPublicArtifact(artifact),
        durableTombstoneRequired: artifact.durableTombstoneRequired,
        reason: "eviction"
      });
    }
    const overflowCreated = Array.from(this.artifacts.values()).filter((artifact) => createdInThisBatch.has(artifact.id)).sort((a, b) => b.receivedSeq - a.receivedSeq);
    if (strict && overflowCreated.length > 0 && this.artifacts.size > this.maxArtifacts) {
      throw new SessionArtifactValidationError(
        "artifact store is full; no eviction candidate is available",
        "artifactId"
      );
    }
    let droppedCreated = 0;
    for (const artifact of overflowCreated) {
      if (this.artifacts.size <= this.maxArtifacts) {
        break;
      }
      this.artifacts.delete(artifact.id);
      droppedCreated++;
      droppedArtifacts.push(toPublicArtifact(artifact));
      writeStderrLine(
        `[artifacts] session=${this.sessionId} action=dropped reason="max artifacts exceeded" artifactId=${artifact.id}`
      );
      removePriorChange(changes, artifact.id);
    }
    return { removed, droppedCreated, droppedArtifacts };
  }
};
function coalesceByIdentity(artifacts) {
  const byId = /* @__PURE__ */ new Map();
  for (const artifact of artifacts) {
    const existing = byId.get(artifact.id);
    if (!existing) {
      byId.set(artifact.id, artifact);
      continue;
    }
    byId.set(artifact.id, mergeBatchArtifact(existing, artifact));
  }
  return Array.from(byId.values()).sort(
    (a, b) => a.receivedSeq - b.receivedSeq
  );
}
__name(coalesceByIdentity, "coalesceByIdentity");
function mergeBatchArtifact(existing, next) {
  const publishedUpgrade = existing.storage !== "published" && next.storage === "published" && next.trustedPublisher;
  if (publishedUpgrade) {
    const merged = {
      ...existing,
      id: next.id,
      identityKey: next.identityKey,
      kind: next.kind,
      storage: "published",
      status: next.status,
      title: next.title,
      description: next.description,
      managedId: next.managedId ?? existing.managedId,
      url: next.url ?? existing.url,
      mimeType: next.mimeType ?? existing.mimeType,
      sizeBytes: next.sizeBytes ?? existing.sizeBytes,
      metadata: mergeMetadata(existing, next),
      trustedPublisher: true,
      createdAt: existing.createdAt,
      receivedSeq: existing.receivedSeq,
      retentionExplicit: existing.retentionExplicit || next.retentionExplicit,
      retentionSource: existing.retentionSource,
      retention: mergeRetention(existing, next),
      restoreState: "live",
      persistenceWarning: existing.persistenceWarning ?? next.persistenceWarning,
      persistedAt: existing.persistedAt ?? next.persistedAt,
      clientRetained: existing.clientRetained || next.clientRetained,
      lastStatAt: void 0
    };
    delete merged.workspacePath;
    return merged;
  }
  const refreshDisplay = existing.storage === "workspace" && next.storage === "workspace" && shouldRefreshWorkspaceDisplay(next, existing);
  const metadata = mergeMetadata(existing, next);
  return {
    ...existing,
    title: refreshDisplay ? next.title : existing.title,
    description: refreshDisplay ? next.description ?? existing.description : existing.description,
    toolName: refreshDisplay ? next.toolName : existing.toolName,
    source: refreshDisplay ? next.source : existing.source,
    hookEventName: refreshDisplay ? next.hookEventName : existing.hookEventName,
    toolCallId: refreshDisplay ? next.toolCallId : existing.toolCallId,
    status: next.status,
    sizeBytes: mergeSizeBytes(existing, next),
    metadata: refreshDisplay ? stripExpandedFromDirectoryMarker(metadata) : metadata,
    clientRetained: existing.clientRetained || next.clientRetained,
    trustedPublisher: existing.trustedPublisher || next.trustedPublisher,
    retentionExplicit: existing.retentionExplicit || next.retentionExplicit,
    retention: mergeRetention(existing, next),
    lastStatAt: next.lastStatAt ?? existing.lastStatAt
  };
}
__name(mergeBatchArtifact, "mergeBatchArtifact");
function mergeArtifact(existing, incoming) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const publishedUpgrade = existing.storage !== "published" && incoming.storage === "published" && incoming.trustedPublisher;
  const publishedRefresh = existing.storage === "published" && incoming.storage === "published" && incoming.trustedPublisher && incoming.managedId !== void 0 && incoming.managedId === existing.managedId;
  const publishedUpdate = publishedUpgrade || publishedRefresh;
  const next = {
    ...existing,
    id: publishedUpdate ? incoming.id : existing.id,
    identityKey: publishedUpdate ? incoming.identityKey : existing.identityKey,
    kind: publishedUpdate ? incoming.kind : existing.kind,
    storage: publishedUpgrade ? "published" : existing.storage,
    status: existing.storage === "published" && !publishedUpdate ? existing.status : incoming.status,
    managedId: publishedUpdate ? incoming.managedId ?? existing.managedId : existing.managedId,
    url: publishedUpdate ? incoming.url ?? existing.url : existing.url,
    workspacePath: publishedUpdate || existing.storage === "published" ? void 0 : existing.workspacePath ?? incoming.workspacePath,
    hideWorkspacePath: publishedUpdate || existing.storage === "published" || incoming.workspacePath ? void 0 : existing.hideWorkspacePath,
    mimeType: publishedUpdate ? incoming.mimeType ?? existing.mimeType : existing.mimeType,
    sizeBytes: existing.storage === "published" && !publishedUpdate ? existing.sizeBytes : mergeSizeBytes(existing, incoming),
    metadata: existing.storage === "published" && !publishedUpdate ? existing.metadata : mergeMetadata(existing, incoming),
    retention: mergeRetention(existing, incoming),
    restoreState: "live",
    persistenceWarning: incoming.retentionExplicit && incoming.retention !== "ephemeral" ? incoming.persistenceWarning : existing.persistenceWarning ?? incoming.persistenceWarning,
    persistedAt: incoming.retentionExplicit && incoming.retention === "ephemeral" ? void 0 : existing.persistedAt ?? incoming.persistedAt,
    source: existing.source,
    retentionSource: existing.retentionSource,
    trustedPublisher: existing.trustedPublisher || incoming.trustedPublisher,
    clientRetained: existing.clientRetained || incoming.clientRetained,
    lastStatAt: publishedUpdate || existing.storage === "published" ? void 0 : incoming.lastStatAt ?? existing.lastStatAt,
    updatedAt: existing.updatedAt,
    lastObservedSha256: void 0,
    lastObservedSizeBytes: void 0,
    lastObservedMtimeMs: void 0
  };
  if (publishedUpdate) {
    next.title = incoming.title;
    next.description = incoming.description;
    delete next.workspacePath;
    delete next.hideWorkspacePath;
  } else if (existing.storage === "workspace" && incoming.storage === "workspace" && shouldRefreshWorkspaceDisplay(incoming, existing)) {
    next.title = incoming.title;
    next.description = incoming.description ?? existing.description;
    next.toolCallId = incoming.toolCallId;
    next.toolName = incoming.toolName;
    next.source = incoming.source;
    next.hookEventName = incoming.hookEventName;
    next.metadata = stripExpandedFromDirectoryMarker(next.metadata);
  }
  const changed = !publicArtifactsEqual(
    toPublicArtifact(existing),
    toPublicArtifact(next)
  );
  if (changed) {
    next.updatedAt = now;
  }
  return { artifact: changed ? next : existing, changed };
}
__name(mergeArtifact, "mergeArtifact");
function shouldRecordEphemeralUnpin(existing, incoming) {
  return incoming.retentionExplicit && incoming.retention === "ephemeral" && (existing.retention !== "ephemeral" || existing.persistedAt !== void 0 || existing.durableTombstoneRequired === true);
}
__name(shouldRecordEphemeralUnpin, "shouldRecordEphemeralUnpin");
function stripExpandedFromDirectoryMarker(metadata) {
  if (metadata?.["expandedFromDirectory"] !== true) {
    return metadata;
  }
  const { expandedFromDirectory: _dropped, ...rest } = metadata;
  return Object.keys(rest).length > 0 ? rest : void 0;
}
__name(stripExpandedFromDirectoryMarker, "stripExpandedFromDirectoryMarker");
function shouldRefreshWorkspaceDisplay(incoming, existing) {
  if (incoming.metadata?.["expandedFromDirectory"] === true) {
    return false;
  }
  if (incoming.toolName === "record_artifact" && incoming.source !== "hook") {
    return true;
  }
  if (!incoming.toolName) {
    return true;
  }
  return incoming.toolName === existing.toolName && incoming.source === existing.source && incoming.hookEventName === existing.hookEventName;
}
__name(shouldRefreshWorkspaceDisplay, "shouldRefreshWorkspaceDisplay");
function publicArtifactsEqual(a, b) {
  return a.id === b.id && a.kind === b.kind && a.storage === b.storage && a.source === b.source && a.status === b.status && a.title === b.title && a.description === b.description && a.workspacePath === b.workspacePath && a.managedId === b.managedId && a.url === b.url && a.mimeType === b.mimeType && a.sizeBytes === b.sizeBytes && metadataEqual(a.metadata, b.metadata) && a.retention === b.retention && a.restoreState === b.restoreState && a.persistenceWarning === b.persistenceWarning && a.persistedAt === b.persistedAt && a.clientRetained === b.clientRetained && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt && a.toolCallId === b.toolCallId && a.toolName === b.toolName && a.hookEventName === b.hookEventName && a.clientId === b.clientId;
}
__name(publicArtifactsEqual, "publicArtifactsEqual");
function metadataEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}
__name(metadataEqual, "metadataEqual");
function mergeSizeBytes(existing, incoming) {
  if (incoming.sizeBytes !== void 0) {
    return incoming.sizeBytes;
  }
  if (incoming.workspacePath && incoming.status === "missing") {
    return void 0;
  }
  return existing.sizeBytes;
}
__name(mergeSizeBytes, "mergeSizeBytes");
function strongestRetention(a, b) {
  const rank = {
    ephemeral: 0,
    restorable: 1
  };
  return rank[b] > rank[a] ? b : a;
}
__name(strongestRetention, "strongestRetention");
function mergeRetention(existing, incoming) {
  if (incoming.retentionExplicit && incoming.retention === "ephemeral") {
    return "ephemeral";
  }
  if (existing.retentionExplicit && existing.retention === "ephemeral" && !incoming.retentionExplicit) {
    return "ephemeral";
  }
  return strongestRetention(existing.retention, incoming.retention);
}
__name(mergeRetention, "mergeRetention");
function mergeMetadata(existing, incoming) {
  if (!incoming.metadata || incoming.source === "hook" || incoming.source !== existing.source) {
    return existing.metadata;
  }
  const merged = { ...existing.metadata ?? {} };
  let changed = false;
  for (const [key, value] of Object.entries(incoming.metadata)) {
    if (isAdoptableContentFingerprintKey(key) && merged[key] !== value) {
      merged[key] = value;
      changed = true;
    } else if (!Object.hasOwn(merged, key)) {
      merged[key] = value;
      changed = true;
    }
  }
  if (!changed) {
    return existing.metadata;
  }
  if (!isMetadataWithinLimit(merged)) {
    writeStderrLine(
      `[artifacts] action=metadata_merge_dropped artifactId=${incoming.id} reason="metadata limit exceeded"`
    );
    return existing.metadata;
  }
  return merged;
}
__name(mergeMetadata, "mergeMetadata");
function isMetadataWithinLimit(metadata) {
  return metadataBudgetBytes(metadata, "persisted") <= 4096;
}
__name(isMetadataWithinLimit, "isMetadataWithinLimit");
function countByRetentionSource(artifacts) {
  const counts = {
    tool: 0,
    client: 0,
    hook: 0
  };
  for (const artifact of artifacts) {
    counts[artifact.retentionSource]++;
  }
  return counts;
}
__name(countByRetentionSource, "countByRetentionSource");
function isVanishedAutoRecordedWorkspaceArtifact(artifact) {
  return artifact.toolName === "write_file" && artifact.workspacePath !== void 0 && artifact.status === "missing" && artifact.missingFromStatError !== true && artifact.hideWorkspacePath !== true;
}
__name(isVanishedAutoRecordedWorkspaceArtifact, "isVanishedAutoRecordedWorkspaceArtifact");
function shouldRefreshWorkspaceStatus(artifact, now) {
  return artifact.lastStatAt === void 0 || now - artifact.lastStatAt >= WORKSPACE_STATUS_REFRESH_TTL_MS;
}
__name(shouldRefreshWorkspaceStatus, "shouldRefreshWorkspaceStatus");
function needsWorkspaceStatusRefresh(artifact, now) {
  return shouldRefreshWorkspaceStatus(artifact, now) || shouldRecheckWriteFilePresence(artifact);
}
__name(needsWorkspaceStatusRefresh, "needsWorkspaceStatusRefresh");
function shouldRecheckWriteFilePresence(artifact) {
  return artifact.toolName === "write_file" && (artifact.status === "available" || artifact.status === "missing" && artifact.missingFromStatError !== true && artifact.hideWorkspacePath !== true);
}
__name(shouldRecheckWriteFilePresence, "shouldRecheckWriteFilePresence");
function selectEvictionCandidate(candidates, sourceCounts) {
  return oldest(
    candidates,
    (artifact) => artifact.status === "missing" && artifact.missingFromStatError !== true && !artifact.clientRetained
  ) ?? oldest(
    candidates,
    (artifact) => !artifact.clientRetained && sourceCounts[artifact.retentionSource] > SOURCE_RESERVATIONS[artifact.retentionSource]
  ) ?? oldest(candidates, (artifact) => !artifact.clientRetained) ?? oldest(candidates);
}
__name(selectEvictionCandidate, "selectEvictionCandidate");
function oldest(artifacts, predicate = () => true) {
  let selected;
  for (const artifact of artifacts) {
    if (!predicate(artifact)) {
      continue;
    }
    if (!selected || compareOldest(artifact, selected) < 0) {
      selected = artifact;
    }
  }
  return selected;
}
__name(oldest, "oldest");
function compareOldest(a, b) {
  const created = a.createdAt.localeCompare(b.createdAt);
  if (created !== 0) return created;
  return a.insertSeq - b.insertSeq;
}
__name(compareOldest, "compareOldest");
function removePriorChange(changes, artifactId) {
  const index = changes.findIndex((change) => change.artifactId === artifactId);
  if (index >= 0) {
    changes.splice(index, 1);
  }
}
__name(removePriorChange, "removePriorChange");
function toPublicArtifact(artifact) {
  const hideWorkspacePath = "hideWorkspacePath" in artifact && artifact.hideWorkspacePath === true;
  const {
    id,
    kind,
    storage,
    source,
    status,
    title,
    description,
    workspacePath,
    managedId,
    url,
    mimeType,
    sizeBytes,
    metadata,
    retention,
    restoreState,
    persistenceWarning,
    persistedAt,
    clientRetained,
    createdAt,
    updatedAt,
    toolCallId,
    toolName,
    hookEventName
  } = artifact;
  return {
    id,
    kind,
    storage,
    source,
    status,
    title,
    ...description ? { description } : {},
    ...workspacePath && !hideWorkspacePath ? { workspacePath } : {},
    ...managedId ? { managedId } : {},
    ...url ? { url } : {},
    ...mimeType ? { mimeType } : {},
    ...sizeBytes !== void 0 ? { sizeBytes } : {},
    ...metadata ? { metadata } : {},
    retention,
    ...restoreState ? { restoreState } : {},
    ...persistenceWarning ? { persistenceWarning } : {},
    ...persistedAt ? { persistedAt } : {},
    clientRetained,
    createdAt,
    updatedAt,
    ...toolCallId ? { toolCallId } : {},
    ...toolName ? { toolName } : {},
    ...hookEventName ? { hookEventName } : {}
  };
}
__name(toPublicArtifact, "toPublicArtifact");
function toRemovedPublicArtifact(artifact, removedAt = (/* @__PURE__ */ new Date()).toISOString()) {
  return { ...toPublicArtifact(artifact), updatedAt: removedAt };
}
__name(toRemovedPublicArtifact, "toRemovedPublicArtifact");
function persistedArtifactToInput(artifact) {
  return {
    title: artifact.title,
    kind: artifact.kind,
    storage: artifact.storage,
    description: artifact.description,
    workspacePath: artifact.workspacePath,
    managedId: artifact.managedId,
    url: artifact.url,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    metadata: artifact.metadata,
    source: artifact.source,
    retention: artifact.retention,
    clientRetained: artifact.clientRetained,
    toolCallId: artifact.toolCallId,
    toolName: artifact.toolName,
    hookEventName: artifact.hookEventName
  };
}
__name(persistedArtifactToInput, "persistedArtifactToInput");
function workspaceExpectedFromArtifact(artifact) {
  if (!artifact.workspacePath) {
    return void 0;
  }
  return {
    sizeBytes: recordedWorkspaceSizeBytes(artifact),
    mtimeMs: artifact.metadata?.[WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY],
    sha256: artifact.metadata?.[WORKSPACE_CONTENT_SHA256_METADATA_KEY]
  };
}
__name(workspaceExpectedFromArtifact, "workspaceExpectedFromArtifact");
function toPersistedChange(change, recordedAt) {
  return {
    action: change.action,
    artifactId: change.artifactId,
    ...change.artifact ? { artifact: toPersistedArtifact(change.artifact, recordedAt) } : {},
    ...change.reason ? { reason: change.reason } : {}
  };
}
__name(toPersistedChange, "toPersistedChange");
function toPersistedArtifact(artifact, recordedAt) {
  return {
    id: artifact.id,
    kind: artifact.kind,
    storage: artifact.storage,
    source: artifact.source,
    status: artifact.status === "changed" ? "available" : artifact.status,
    title: artifact.title,
    ...artifact.description ? { description: artifact.description } : {},
    ...artifact.workspacePath ? { workspacePath: artifact.workspacePath } : {},
    ...artifact.managedId ? { managedId: artifact.managedId } : {},
    ...artifact.url ? { url: artifact.url } : {},
    ...artifact.mimeType ? { mimeType: artifact.mimeType } : {},
    ...artifact.sizeBytes !== void 0 ? { sizeBytes: artifact.sizeBytes } : {},
    ...artifact.metadata ? { metadata: artifact.metadata } : {},
    retention: artifact.retention,
    clientRetained: artifact.clientRetained,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    persistedAt: artifact.persistedAt ?? recordedAt,
    ...artifact.toolCallId ? { toolCallId: artifact.toolCallId } : {},
    ...artifact.toolName ? { toolName: artifact.toolName } : {},
    ...artifact.hookEventName ? { hookEventName: artifact.hookEventName } : {}
  };
}
__name(toPersistedArtifact, "toPersistedArtifact");
function isFileArtifactUrl(raw) {
  if (typeof raw !== "string") return false;
  try {
    return new URL(raw).protocol === "file:";
  } catch {
    return false;
  }
}
__name(isFileArtifactUrl, "isFileArtifactUrl");
function isArtifactSnapshotCompletenessWarning(warning) {
  if (warning.startsWith("skipped stale event sequence ")) return false;
  return warning.startsWith("skipped ") || warning.includes(" list truncated to ");
}
__name(isArtifactSnapshotCompletenessWarning, "isArtifactSnapshotCompletenessWarning");
function shouldCommitBeforeDurablePersistence(change) {
  return change.action === "removed" && change.durableTombstoneRequired === true;
}
__name(shouldCommitBeforeDurablePersistence, "shouldCommitBeforeDurablePersistence");
function isDurablePersistenceChange(change) {
  if (change.action === "removed" && change.durableTombstoneRequired === true) {
    return true;
  }
  if (!change.artifact) return false;
  return change.artifact.retention !== "ephemeral" || change.artifact.persistenceWarning === "persistence_unavailable";
}
__name(isDurablePersistenceChange, "isDurablePersistenceChange");
function stripDurableTombstoneMarkers(changes) {
  for (const change of changes) {
    delete change.durableTombstoneRequired;
    delete change.removedClientId;
  }
}
__name(stripDurableTombstoneMarkers, "stripDurableTombstoneMarkers");
function detailsForRestoreWarnings(warnings) {
  return warnings.map((warning) => {
    if (warning.startsWith(RESTORE_FAILED_WARNING_PREFIX)) {
      return {
        code: "ARTIFACT_RESTORE_FAILED",
        operation: "restore",
        durability: "unavailable",
        retryable: true,
        message: warning
      };
    }
    if (warning.startsWith(RESTORE_PARTIAL_FAILED_WARNING_PREFIX)) {
      return {
        code: "ARTIFACT_RESTORE_PARTIAL_FAILED",
        operation: "restore",
        durability: "live_only",
        retryable: true,
        message: warning
      };
    }
    return {
      code: "ARTIFACT_WARNING",
      operation: "restore",
      message: warning
    };
  });
}
__name(detailsForRestoreWarnings, "detailsForRestoreWarnings");
function detailsForPersistenceWarnings(warnings, changes, operation) {
  if (warnings.length === 0) return [];
  const artifactIds = changes.filter(isDurablePersistenceChange).map((change) => change.artifactId);
  return warnings.map((warning) => {
    if (warning === "artifact persistence unavailable; durable artifacts kept ephemeral") {
      return {
        code: "ARTIFACT_PERSISTENCE_UNAVAILABLE",
        operation,
        artifactIds,
        durability: "live_only",
        retryable: false,
        message: warning
      };
    }
    if (warning === "artifact removal not persisted; live removal kept") {
      return {
        code: "ARTIFACT_REMOVAL_NOT_PERSISTED",
        operation,
        artifactIds,
        durability: "live_only",
        retryable: true,
        message: warning
      };
    }
    return {
      code: "ARTIFACT_WARNING",
      operation,
      artifactIds,
      message: warning
    };
  });
}
__name(detailsForPersistenceWarnings, "detailsForPersistenceWarnings");
function persistenceFailureDetail(options) {
  const unavailable = options.error instanceof SessionArtifactValidationError && options.error.message === "artifact persistence is unavailable";
  return {
    code: unavailable ? "ARTIFACT_PERSISTENCE_UNAVAILABLE" : "ARTIFACT_PERSISTENCE_WRITE_FAILED",
    operation: options.operation,
    artifactIds: options.artifactIds,
    durability: "unavailable",
    retryable: !unavailable,
    message: options.message
  };
}
__name(persistenceFailureDetail, "persistenceFailureDetail");
function cloneStoredArtifact(artifact) {
  return {
    ...artifact,
    ...artifact.metadata ? { metadata: { ...artifact.metadata } } : {}
  };
}
__name(cloneStoredArtifact, "cloneStoredArtifact");
function inferStorage(requested, locators) {
  if (requested !== void 0 && typeof requested !== "string") {
    throw new SessionArtifactValidationError(
      "storage must be a string",
      "storage"
    );
  }
  if (requested) {
    if (requested !== "workspace" && requested !== "external_url" && requested !== "managed" && requested !== "published") {
      throw new SessionArtifactValidationError(
        "storage must be workspace, external_url, managed, or published",
        "storage"
      );
    }
    return requested;
  }
  if (locators.workspacePath) return "workspace";
  if (locators.managedId) return "managed";
  if (locators.url && locators.trustedPublisher) return "published";
  return "external_url";
}
__name(inferStorage, "inferStorage");
function normalizeKind(kind) {
  if (kind === "file" || kind === "link" || kind === "html" || kind === "image" || kind === "video" || kind === "audio" || kind === "pdf" || kind === "notebook" || kind === "document" || kind === "other") {
    return kind;
  }
  throw new SessionArtifactValidationError(
    "kind must be a supported artifact kind",
    "kind"
  );
}
__name(normalizeKind, "normalizeKind");
function validateLocator(storage, locators) {
  if (storage === "published") {
    if (!locators.trustedPublisher) {
      throw new SessionArtifactValidationError(
        "published artifacts are reserved for trusted publishers",
        "storage"
      );
    }
    if (!locators.url) {
      throw new SessionArtifactValidationError(
        "published artifacts require url",
        "url"
      );
    }
    if (locators.workspacePath) {
      throw new SessionArtifactValidationError(
        "published artifacts cannot include workspacePath",
        "workspacePath"
      );
    }
    return;
  }
  const locatorCount = [
    locators.workspacePath,
    locators.managedId,
    locators.url
  ].filter(Boolean).length;
  if (locatorCount !== 1) {
    throw new SessionArtifactValidationError(
      "provide exactly one of workspacePath, managedId, or url"
    );
  }
  if (storage === "workspace" && !locators.workspacePath) {
    throw new SessionArtifactValidationError(
      "workspace storage requires workspacePath",
      "workspacePath"
    );
  }
  if (storage === "managed" && !locators.managedId) {
    throw new SessionArtifactValidationError(
      "managed storage requires managedId",
      "managedId"
    );
  }
  if (storage === "external_url" && !locators.url) {
    throw new SessionArtifactValidationError(
      "external_url storage requires url",
      "url"
    );
  }
}
__name(validateLocator, "validateLocator");
function buildIdentityKey(input) {
  if (input.workspacePath) return `workspace:${input.workspacePath}`;
  if (input.managedId) return `managed:${input.managedId}`;
  if (input.url) return `url:${input.url}`;
  throw new SessionArtifactValidationError(
    "artifact identity requires workspacePath, managedId, or url"
  );
}
__name(buildIdentityKey, "buildIdentityKey");
function managedIdForWorkspacePath(workspaceCwd, workspacePath) {
  return createHash("sha1").update(path3.resolve(workspaceCwd, workspacePath)).digest("hex").slice(0, 16);
}
__name(managedIdForWorkspacePath, "managedIdForWorkspacePath");
function normalizeString(value, field, maxLength, required) {
  if (value === void 0 || value === null) {
    if (required) {
      throw new SessionArtifactValidationError(`${field} is required`, field);
    }
    return void 0;
  }
  if (typeof value !== "string") {
    throw new SessionArtifactValidationError(
      `${field} must be a string`,
      field
    );
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) {
      throw new SessionArtifactValidationError(`${field} is required`, field);
    }
    return void 0;
  }
  if (trimmed.length > maxLength) {
    throw new SessionArtifactValidationError(
      `${field} exceeds ${maxLength} characters`,
      field
    );
  }
  if (hasControlCharacter(trimmed, field === "description")) {
    throw new SessionArtifactValidationError(
      `${field} contains control characters`,
      field
    );
  }
  if (isDisplayField(field) && hasUnsafeDisplayPayload(trimmed)) {
    throw new SessionArtifactValidationError(
      `${field} contains unsafe markup`,
      field
    );
  }
  return trimmed;
}
__name(normalizeString, "normalizeString");
function normalizeManagedId(value) {
  const managedId = normalizeString(value, "managedId", 200, false);
  if (!managedId) return void 0;
  if (managedId.includes("/") || managedId.includes("\\") || managedId.includes("..") || path3.isAbsolute(managedId) || path3.win32.isAbsolute(managedId)) {
    throw new SessionArtifactValidationError(
      "managedId must be an opaque managed resource id",
      "managedId"
    );
  }
  return managedId;
}
__name(normalizeManagedId, "normalizeManagedId");
function isDisplayField(field) {
  return field === "title" || field === "description" || field === "mimeType" || field === "workspacePath" || field === "managedId";
}
__name(isDisplayField, "isDisplayField");
function hasControlCharacter(value, allowLineWhitespace = false) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (allowLineWhitespace && (code === 9 || code === 10 || code === 13)) {
      continue;
    }
    if (code <= 31 || code === 127 || code >= 8203 && code <= 8207 || code === 8232 || code === 8233 || code >= 8234 && code <= 8238 || code >= 8294 && code <= 8297 || code === 65279) {
      return true;
    }
  }
  return false;
}
__name(hasControlCharacter, "hasControlCharacter");
function hasUnsafeDisplayPayload(value) {
  return /<\s*\/?[a-z!]|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);|javascript\s*:|data\s*:\s*(?:text\/(?:html|javascript)|application\/javascript|image\/svg\+xml)/i.test(
    value
  ) || /(?:^|[\s"'`<])on[a-z][a-z0-9-]*\s*=/i.test(value);
}
__name(hasUnsafeDisplayPayload, "hasUnsafeDisplayPayload");
function normalizeWorkspacePath(raw, workspaceCwd) {
  const trimmed = normalizeString(raw, "workspacePath", 500, true);
  if (path3.isAbsolute(trimmed)) {
    throw new SessionArtifactValidationError(
      "workspacePath must be relative to the workspace",
      "workspacePath"
    );
  }
  const absolute = path3.resolve(workspaceCwd, trimmed);
  const relative = path3.relative(workspaceCwd, absolute);
  if (!relative || isOutsidePath(relative)) {
    throw new SessionArtifactValidationError(
      "workspacePath must stay inside the workspace",
      "workspacePath"
    );
  }
  return relative.split(path3.sep).join("/");
}
__name(normalizeWorkspacePath, "normalizeWorkspacePath");
function normalizeArtifactUrl(raw, allowFile) {
  const trimmed = normalizeString(raw, "url", 2048, true);
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new SessionArtifactValidationError("url must be valid", "url");
  }
  if (parsed.username || parsed.password) {
    throw new SessionArtifactValidationError(
      "url must not include credentials",
      "url"
    );
  }
  if (hasSecretLikeUrlComponent(parsed)) {
    throw new SessionArtifactValidationError(
      "url must not include secret-like components",
      "url"
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && !(allowFile && parsed.protocol === "file:")) {
    throw new SessionArtifactValidationError(
      allowFile ? "url must use http, https, or file" : "url must use http or https",
      "url"
    );
  }
  return parsed.href;
}
__name(normalizeArtifactUrl, "normalizeArtifactUrl");
function hasSecretLikeUrlComponent(parsed) {
  for (const [key, value] of parsed.searchParams) {
    if (isSecretLikeUrlText(key) || isSecretLikeUrlValue(value)) {
      return true;
    }
  }
  for (const segment of parsed.pathname.split("/").filter(Boolean)) {
    let decodedSegment = segment;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
    }
    if (isSecretLikeUrlValue(decodedSegment)) {
      return true;
    }
  }
  const fragment = parsed.hash.slice(1);
  return hasSecretLikeUrlFragment(fragment);
}
__name(hasSecretLikeUrlComponent, "hasSecretLikeUrlComponent");
function hasSecretLikeUrlFragment(fragment) {
  if (!fragment) return false;
  const candidates = /* @__PURE__ */ new Set([fragment]);
  try {
    candidates.add(decodeURIComponent(fragment));
  } catch {
  }
  for (const candidate of candidates) {
    if (isSecretLikeUrlText(candidate) || isSecretLikeUrlValue(candidate)) {
      return true;
    }
    for (const [key, value] of new URLSearchParams(candidate)) {
      if (isSecretLikeUrlText(key) || isSecretLikeUrlValue(value)) {
        return true;
      }
    }
  }
  return false;
}
__name(hasSecretLikeUrlFragment, "hasSecretLikeUrlFragment");
function isSecretLikeUrlText(value) {
  const normalized = value.replace(/([a-z])([A-Z])/g, "$1-$2");
  return /(?:^|[-_.])(token|secret|password|passwd|pwd|cookie|authorization|credential|signature|sig|api[-_]?key|access[-_]?key)(?:$|[-_.=&#])/i.test(
    normalized
  );
}
__name(isSecretLikeUrlText, "isSecretLikeUrlText");
function isSecretLikeUrlValue(value) {
  return SECRET_TOKEN_VALUE_PATTERN.test(value.trim());
}
__name(isSecretLikeUrlValue, "isSecretLikeUrlValue");
function isSecretLikeMetadataValue(value) {
  return /^(?:bearer\s+\S{8,}|sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_/-]{12,})$/i.test(
    value.trim()
  );
}
__name(isSecretLikeMetadataValue, "isSecretLikeMetadataValue");
function normalizeMetadata(metadata, options = {}) {
  if (metadata === void 0) {
    return void 0;
  }
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new SessionArtifactValidationError(
      "metadata must be an object",
      "metadata"
    );
  }
  const normalized = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isPrototypeMetadataKey(key)) {
      continue;
    }
    if (options.budget !== "persisted") {
      if (isReservedWorkspaceMetadataKey(key)) {
        continue;
      }
      if (key === PUBLISHED_CONTENT_SHA256_METADATA_KEY && options.trustedPublisher !== true) {
        continue;
      }
    }
    if (!key) {
      throw new SessionArtifactValidationError(
        "metadata keys must not be empty",
        "metadata"
      );
    }
    if (key.length > 120) {
      throw new SessionArtifactValidationError(
        "metadata keys must be 120 characters or fewer",
        "metadata"
      );
    }
    if (hasControlCharacter(key) || hasUnsafeDisplayPayload(key)) {
      throw new SessionArtifactValidationError(
        "metadata keys contain unsafe content",
        "metadata"
      );
    }
    if (isSecretLikeUrlText(key)) {
      throw new SessionArtifactValidationError(
        "metadata keys must not contain secret-like names",
        "metadata"
      );
    }
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new SessionArtifactValidationError(
        "metadata values must be primitive",
        "metadata"
      );
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new SessionArtifactValidationError(
        "metadata numbers must be finite",
        "metadata"
      );
    }
    if (typeof value === "string" && (hasControlCharacter(value) || hasUnsafeDisplayPayload(value))) {
      throw new SessionArtifactValidationError(
        "metadata string values contain unsafe content",
        "metadata"
      );
    }
    if (typeof value === "string" && !isReservedWorkspaceMetadataKey(key) && isSecretLikeMetadataValue(value)) {
      throw new SessionArtifactValidationError(
        "metadata string values must not contain secret-like tokens",
        "metadata"
      );
    }
    normalized[key] = value;
  }
  if (Object.keys(normalized).length === 0) {
    return void 0;
  }
  if (metadataBudgetBytes(normalized, options.budget ?? "user") > 4096) {
    throw new SessionArtifactValidationError(
      "metadata must be 4096 bytes or fewer",
      "metadata"
    );
  }
  return normalized;
}
__name(normalizeMetadata, "normalizeMetadata");
function normalizeRetention(value, options) {
  if (value === void 0) {
    return options.persistenceAvailable ? "restorable" : "ephemeral";
  }
  if (value === "ephemeral" || value === "restorable") {
    return value;
  }
  if (value === "pinned") {
    throw new SessionArtifactValidationError(
      "pinned retention is not supported by session_artifacts_persistence",
      "retention"
    );
  }
  throw new SessionArtifactValidationError(
    "retention must be ephemeral or restorable",
    "retention"
  );
}
__name(normalizeRetention, "normalizeRetention");
function normalizeSizeBytes(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SessionArtifactValidationError(
      "sizeBytes must be a non-negative safe integer",
      "sizeBytes"
    );
  }
  return value;
}
__name(normalizeSizeBytes, "normalizeSizeBytes");
function inferKind(input) {
  if (input.storage === "published") return "html";
  if (input.url) return "link";
  const ext = input.workspacePath ? path3.extname(input.workspacePath).toLowerCase() : "";
  if (ext === ".html" || ext === ".htm") return "html";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) {
    return "image";
  }
  if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".m4a", ".ogg"].includes(ext)) return "audio";
  if (ext === ".pdf") return "pdf";
  if (ext === ".ipynb") return "notebook";
  if (isOfficeDocumentExtension(ext)) return "document";
  return input.workspacePath ? "file" : "other";
}
__name(inferKind, "inferKind");
async function getWorkspaceStatus(workspacePath, realWorkspaceCwd, expected, options = { hashContent: true }) {
  const realWorkspace = await realWorkspaceCwd;
  const absolutePath = path3.resolve(realWorkspace, workspacePath);
  try {
    const realPath = await fs3.realpath(absolutePath);
    const relative = path3.relative(realWorkspace, realPath);
    if (!relative || isOutsidePath(relative)) {
      return { status: "missing", escaped: true };
    }
    const preOpenStat = await fs3.lstat(realPath, { bigint: true });
    const handle = await openNoFollow(realPath);
    try {
      if (!isSameFile(preOpenStat, await handle.stat({ bigint: true }))) {
        return { status: "missing", escaped: true };
      }
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw new Error("path is not a regular file");
      }
      const expectedMtimeMs = typeof expected?.mtimeMs === "number" ? expected.mtimeMs : void 0;
      const expectedSha256 = typeof expected?.sha256 === "string" ? expected.sha256 : void 0;
      const unchanged = expected?.sizeBytes === stat.size && expectedMtimeMs === stat.mtimeMs;
      const sizeChanged = expected?.sizeBytes !== void 0 && expected.sizeBytes !== stat.size;
      if (sizeChanged) {
        return {
          status: "changed",
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs
        };
      }
      if (unchanged) {
        return {
          status: "available",
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs
        };
      }
      if (stat.size > MAX_WORKSPACE_HASH_BYTES) {
        return {
          status: expectedSha256 ? "changed" : "available",
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs
        };
      }
      if (!options.hashContent) {
        return {
          status: expectedSha256 ? "changed" : "available",
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs
        };
      }
      const sha256 = await hashFile(handle);
      if (expectedSha256 && sha256 !== expectedSha256) {
        return {
          status: "changed",
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256
        };
      }
      return {
        status: "available",
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isNoFollowSymlinkError(error)) {
      return { status: "missing", escaped: true };
    }
    if (isUnverifiableIdentityError(error)) {
      return { status: "missing" };
    }
    if (!isNotFoundError(error)) {
      throw error;
    }
    if (await danglingSymlinkEscapesWorkspace(absolutePath, realWorkspace)) {
      return { status: "missing", escaped: true };
    }
    return { status: "missing" };
  }
}
__name(getWorkspaceStatus, "getWorkspaceStatus");
function isSameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino;
}
__name(isSameFile, "isSameFile");
async function hashFile(handle) {
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ start: 0 })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}
__name(hashFile, "hashFile");
function withWorkspaceContentHashMetadata(metadata, workspaceStatus) {
  if (workspaceStatus?.status !== "available" || workspaceStatus.sha256 === void 0 && workspaceStatus.sizeBytes === void 0) {
    return metadata;
  }
  const next = {
    ...metadata ?? {},
    ...workspaceStatus.sha256 ? { [WORKSPACE_CONTENT_SHA256_METADATA_KEY]: workspaceStatus.sha256 } : {},
    ...workspaceStatus.mtimeMs !== void 0 ? { [WORKSPACE_CONTENT_MTIME_MS_METADATA_KEY]: workspaceStatus.mtimeMs } : {},
    ...workspaceStatus.sizeBytes !== void 0 ? {
      [WORKSPACE_CONTENT_SIZE_BYTES_METADATA_KEY]: workspaceStatus.sizeBytes
    } : {}
  };
  return next;
}
__name(withWorkspaceContentHashMetadata, "withWorkspaceContentHashMetadata");
function recordedWorkspaceSizeBytes(artifact) {
  const recorded = artifact.metadata?.[WORKSPACE_CONTENT_SIZE_BYTES_METADATA_KEY];
  if (typeof recorded === "number" && Number.isFinite(recorded)) {
    return recorded;
  }
  return artifact.sizeBytes;
}
__name(recordedWorkspaceSizeBytes, "recordedWorkspaceSizeBytes");
function recordWorkspaceObservation(artifact, status) {
  const hadObservation = artifact.lastObservedSha256 !== void 0 || artifact.lastObservedSizeBytes !== void 0 || artifact.lastObservedMtimeMs !== void 0;
  let changed = false;
  if (hadObservation) {
    if (status.sha256 !== void 0 && artifact.lastObservedSha256 !== void 0) {
      changed = status.sha256 !== artifact.lastObservedSha256;
    } else {
      changed = status.sizeBytes !== artifact.lastObservedSizeBytes || status.mtimeMs !== artifact.lastObservedMtimeMs;
    }
  }
  artifact.lastObservedSha256 = status.sha256;
  artifact.lastObservedSizeBytes = status.sizeBytes;
  artifact.lastObservedMtimeMs = status.mtimeMs;
  return changed;
}
__name(recordWorkspaceObservation, "recordWorkspaceObservation");
function isWorkspaceContentChanged(artifact, status) {
  if (status.status !== "available") {
    return false;
  }
  const expectedSha256 = artifact.metadata?.[WORKSPACE_CONTENT_SHA256_METADATA_KEY];
  const expectedSize = recordedWorkspaceSizeBytes(artifact);
  if (expectedSize !== void 0 && status.sizeBytes !== void 0 && status.sizeBytes !== expectedSize) {
    return true;
  }
  return typeof expectedSha256 === "string" && status.sha256 !== void 0 && status.sha256 !== expectedSha256;
}
__name(isWorkspaceContentChanged, "isWorkspaceContentChanged");
async function danglingSymlinkEscapesWorkspace(absolutePath, realWorkspace) {
  try {
    const stat = await fs3.lstat(absolutePath);
    if (!stat.isSymbolicLink()) {
      return false;
    }
    const target = await fs3.readlink(absolutePath);
    const parent = await fs3.realpath(path3.dirname(absolutePath));
    const targetPath = path3.resolve(parent, target);
    return isOutsidePath(path3.relative(realWorkspace, targetPath));
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}
__name(danglingSymlinkEscapesWorkspace, "danglingSymlinkEscapesWorkspace");
async function runInBatches(items, batchSize, fn) {
  for (let index = 0; index < items.length; index += batchSize) {
    await Promise.all(items.slice(index, index + batchSize).map(fn));
  }
}
__name(runInBatches, "runInBatches");
function isNotFoundError(error) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = error.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
__name(isNotFoundError, "isNotFoundError");
function isPlainMetadataObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isPlainMetadataObject, "isPlainMetadataObject");
function isNoFollowSymlinkError(error) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return error.code === "ELOOP";
}
__name(isNoFollowSymlinkError, "isNoFollowSymlinkError");
function isOutsidePath(relative) {
  return relative === ".." || relative.startsWith(`..${path3.sep}`) || path3.isAbsolute(relative);
}
__name(isOutsidePath, "isOutsidePath");

// packages/acp-bridge/src/session-control-plane.ts
var NOOP_BRIDGE_TELEMETRY = {
  captureContext: /* @__PURE__ */ __name(() => void 0, "captureContext"),
  runWithContext(_captured, fn) {
    return fn();
  },
  withSpan(_operation, _attributes, fn) {
    return fn();
  },
  event() {
  },
  injectPromptContext(request) {
    const meta = request._meta;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      return request;
    }
    const record = meta;
    if (!(DAEMON_TRACEPARENT_META_KEY in record) && !(DAEMON_TRACESTATE_META_KEY in record)) {
      return request;
    }
    const nextMeta = { ...record };
    delete nextMeta[DAEMON_TRACEPARENT_META_KEY];
    delete nextMeta[DAEMON_TRACESTATE_META_KEY];
    return { ...request, _meta: nextMeta };
  }
};
var KNOWN_SESSION_UPDATE_TYPES = /* @__PURE__ */ new Set([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "usage_update"
]);
function isRecord7(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord7, "isRecord");
function sessionSourceRequestMeta(sourceType, sourceId, daemonOwnedStandaloneCreation = false) {
  return sourceType ? {
    [SESSION_SOURCE_META_KEY]: {
      sourceType,
      ...sourceId !== void 0 ? { sourceId } : {},
      ...daemonOwnedStandaloneCreation ? { [DAEMON_OWNED_STANDALONE_CREATION_KEY]: true } : {}
    }
  } : {};
}
__name(sessionSourceRequestMeta, "sessionSourceRequestMeta");
function sameConversationDirectoryExpectation(left, right) {
  return left.canonicalSessionId === right.canonicalSessionId && left.root.canonicalPath === right.root.canonicalPath && left.root.device === right.root.device && left.root.inode === right.root.inode && left.child.name === right.child.name && left.child.canonicalPath === right.child.canonicalPath && left.child.device === right.child.device && left.child.inode === right.child.inode;
}
__name(sameConversationDirectoryExpectation, "sameConversationDirectoryExpectation");
function standaloneWorkingDirectoryMissingError() {
  return new RequestError(
    -32004,
    "The standalone working directory is missing.",
    { errorKind: "working_directory_missing" }
  );
}
__name(standaloneWorkingDirectoryMissingError, "standaloneWorkingDirectoryMissingError");
function getChannelPromptDisplayText(entry, displayText) {
  return entry.sourceType === "channel" && typeof displayText === "string" ? displayText : void 0;
}
__name(getChannelPromptDisplayText, "getChannelPromptDisplayText");
function hasInFlightPromptActivity(entry) {
  return entry.promptActive || entry.goalTurnActive === true || !!entry.backgroundTurn || (entry.deferredRestoreAskUserQuestionPrompts?.size ?? 0) > 0;
}
__name(hasInFlightPromptActivity, "hasInFlightPromptActivity");
function isDefinitiveAcpRequestError(error) {
  if (error instanceof RequestError) return true;
  if (!isRecord7(error)) return false;
  return typeof error["code"] === "number" && Number.isInteger(error["code"]) && typeof error["message"] === "string";
}
__name(isDefinitiveAcpRequestError, "isDefinitiveAcpRequestError");
function getCanonicalModelId(response, fallback) {
  if (!isRecord7(response) || !isRecord7(response["_meta"])) return fallback;
  const modelSwitch = response["_meta"]["qwenModelSwitch"];
  if (!isRecord7(modelSwitch)) return fallback;
  const modelId = modelSwitch["modelId"];
  return typeof modelId === "string" ? modelId : fallback;
}
__name(getCanonicalModelId, "getCanonicalModelId");
function isBulkReplayUpdate(value) {
  if (!isRecord7(value)) return false;
  const updateType = value["sessionUpdate"];
  return typeof updateType === "string" && KNOWN_SESSION_UPDATE_TYPES.has(updateType);
}
__name(isBulkReplayUpdate, "isBulkReplayUpdate");
function describeLoadReplayValue(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}
__name(describeLoadReplayValue, "describeLoadReplayValue");
function extractLoadReplayResponse(state) {
  const meta = isRecord7(state._meta) ? state._meta : void 0;
  const replay = meta?.[LOAD_REPLAY_META_KEY];
  if (replay === void 0) return { state, updates: [] };
  if (!isRecord7(replay) || replay["v"] !== LOAD_REPLAY_VERSION) {
    const version = isRecord7(replay) ? replay["v"] : void 0;
    throw new Error(
      `Invalid qwen.session.loadReplay payload (type=${describeLoadReplayValue(replay)}, version=${JSON.stringify(version)})`
    );
  }
  const rawUpdates = replay["updates"];
  if (!Array.isArray(rawUpdates)) {
    throw new Error(
      `Invalid qwen.session.loadReplay updates (version=${LOAD_REPLAY_VERSION}, count=not-array)`
    );
  }
  if (rawUpdates.length > LOAD_REPLAY_MAX_UPDATES) {
    throw new Error(
      `qwen.session.loadReplay updates exceed limit (${rawUpdates.length} > ${LOAD_REPLAY_MAX_UPDATES})`
    );
  }
  const partial = replay["partial"];
  if (partial !== void 0 && partial !== true) {
    throw new Error(
      `Invalid qwen.session.loadReplay partial (version=${LOAD_REPLAY_VERSION}, partial=${JSON.stringify(partial)})`
    );
  }
  const replayError = replay["replayError"];
  if (replayError !== void 0 && typeof replayError !== "string") {
    throw new Error(
      `Invalid qwen.session.loadReplay replayError (version=${LOAD_REPLAY_VERSION}, replayError=${describeLoadReplayValue(replayError)})`
    );
  }
  const hasMore = replay["hasMore"];
  if (hasMore !== void 0 && typeof hasMore !== "boolean") {
    throw new Error(
      `Invalid qwen.session.loadReplay hasMore (version=${LOAD_REPLAY_VERSION}, hasMore=${describeLoadReplayValue(hasMore)})`
    );
  }
  const anchorRecordId = replay["anchorRecordId"];
  if (anchorRecordId !== void 0 && typeof anchorRecordId !== "string") {
    throw new Error(
      `Invalid qwen.session.loadReplay anchorRecordId (version=${LOAD_REPLAY_VERSION}, anchorRecordId=${describeLoadReplayValue(anchorRecordId)})`
    );
  }
  const invalidUpdateIndex = rawUpdates.findIndex(
    (update) => !isBulkReplayUpdate(update)
  );
  if (invalidUpdateIndex !== -1) {
    const invalidUpdate = rawUpdates[invalidUpdateIndex];
    const discriminator = isRecord7(invalidUpdate) ? invalidUpdate["sessionUpdate"] : void 0;
    throw new Error(
      `Invalid qwen.session.loadReplay update at index ${invalidUpdateIndex} (version=${LOAD_REPLAY_VERSION}, count=${rawUpdates.length}, sessionUpdate=${JSON.stringify(discriminator)})`
    );
  }
  const nextMeta = { ...meta ?? {} };
  delete nextMeta[LOAD_REPLAY_META_KEY];
  const cleanState = { ...state };
  if (Object.keys(nextMeta).length > 0) {
    cleanState._meta = nextMeta;
  } else {
    delete cleanState._meta;
  }
  return {
    state: cleanState,
    updates: rawUpdates,
    ...typeof anchorRecordId === "string" ? { anchorRecordId } : {},
    ...partial === true ? { partial: true } : {},
    ...typeof replayError === "string" ? { replayError } : {},
    ...hasMore === true ? { hasMore: true } : {}
  };
}
__name(extractLoadReplayResponse, "extractLoadReplayResponse");
function takeRestoreAskUserQuestionHint(state) {
  const meta = isRecord7(state._meta) ? state._meta : void 0;
  const hint = meta?.[DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY] === true;
  if (!hint || !meta) return { hint: false, state };
  const nextMeta = { ...meta };
  delete nextMeta[DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY];
  const next = { ...state };
  if (Object.keys(nextMeta).length > 0) {
    next._meta = nextMeta;
  } else {
    delete next._meta;
  }
  return { hint: true, state: next };
}
__name(takeRestoreAskUserQuestionHint, "takeRestoreAskUserQuestionHint");
function isServeDebugLoggingEnabled() {
  const value = process.env["QWEN_SERVE_DEBUG"];
  if (!value) return false;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}
__name(isServeDebugLoggingEnabled, "isServeDebugLoggingEnabled");
function writeServeDebugLine(message) {
  if (!isServeDebugLoggingEnabled()) return;
  writeStderrLine(`qwen serve debug: ${message}`);
}
__name(writeServeDebugLine, "writeServeDebugLine");
var MAX_DISPLAY_NAME_LENGTH = 256;
var MAX_ECHO_CONTENT_BLOCKS = 256;
function extractPermissionResponseMetadata(response) {
  if (response === null || typeof response !== "object") return void 0;
  const metadata = {};
  const answers = response.answers;
  if (answers !== null && typeof answers === "object" && !Array.isArray(answers)) {
    const entries = Object.entries(answers);
    if (entries.every(([, v]) => typeof v === "string")) {
      metadata["answers"] = answers;
    }
  }
  const expectedPlanExecutionMode = response.expectedPlanExecutionMode;
  if (typeof expectedPlanExecutionMode === "string") {
    metadata["expectedPlanExecutionMode"] = expectedPlanExecutionMode;
  }
  return Object.keys(metadata).length > 0 ? metadata : void 0;
}
__name(extractPermissionResponseMetadata, "extractPermissionResponseMetadata");
function parseWorkspaceMemoryRememberResult(response) {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Malformed workspace memory remember response");
  }
  const record = response;
  const summary = record["summary"];
  const filesTouched = record["filesTouched"];
  const touchedScopes = record["touchedScopes"];
  if (summary !== void 0 && typeof summary !== "string" || !Array.isArray(filesTouched) || !filesTouched.every((file) => typeof file === "string") || !Array.isArray(touchedScopes) || !touchedScopes.every((scope) => scope === "user" || scope === "project")) {
    throw new Error("Malformed workspace memory remember response");
  }
  return {
    ...summary === void 0 ? {} : { summary },
    filesTouched,
    touchedScopes
  };
}
__name(parseWorkspaceMemoryRememberResult, "parseWorkspaceMemoryRememberResult");
function isBridgeAutoMemoryTopic(value) {
  return value === "user" || value === "feedback" || value === "project" || value === "reference";
}
__name(isBridgeAutoMemoryTopic, "isBridgeAutoMemoryTopic");
function touchedScopesFromTopics(topics) {
  const scopes = /* @__PURE__ */ new Set();
  for (const topic of topics) {
    scopes.add(topic === "user" || topic === "feedback" ? "user" : "project");
  }
  return ["user", "project"].filter((scope) => scopes.has(scope));
}
__name(touchedScopesFromTopics, "touchedScopesFromTopics");
function isBridgeMemoryScope(value) {
  return value === "user" || value === "project";
}
__name(isBridgeMemoryScope, "isBridgeMemoryScope");
function parseWorkspaceMemoryForgetMatch(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value;
  if (!isBridgeAutoMemoryTopic(record["topic"]) || typeof record["summary"] !== "string" || typeof record["filePath"] !== "string") {
    return null;
  }
  return {
    topic: record["topic"],
    summary: record["summary"],
    filePath: record["filePath"]
  };
}
__name(parseWorkspaceMemoryForgetMatch, "parseWorkspaceMemoryForgetMatch");
function parseWorkspaceMemoryForgetResult(response) {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Malformed workspace memory forget response");
  }
  const record = response;
  const summary = record["summary"];
  const removedEntries = record["removedEntries"];
  const touchedTopics = record["touchedTopics"];
  const touchedScopes = record["touchedScopes"];
  const parsedRemovedEntries = Array.isArray(removedEntries) ? removedEntries.map(parseWorkspaceMemoryForgetMatch) : [];
  if (summary !== void 0 && typeof summary !== "string" || !Array.isArray(removedEntries) || parsedRemovedEntries.some((entry) => entry === null) || !Array.isArray(touchedTopics) || !touchedTopics.every(isBridgeAutoMemoryTopic) || touchedScopes !== void 0 && (!Array.isArray(touchedScopes) || !touchedScopes.every(isBridgeMemoryScope))) {
    throw new Error("Malformed workspace memory forget response");
  }
  const parsedTouchedTopics = touchedTopics;
  return {
    ...summary === void 0 ? {} : { summary },
    removedEntries: parsedRemovedEntries,
    touchedTopics: parsedTouchedTopics,
    touchedScopes: touchedScopes === void 0 ? touchedScopesFromTopics(parsedTouchedTopics) : touchedScopes
  };
}
__name(parseWorkspaceMemoryForgetResult, "parseWorkspaceMemoryForgetResult");
function parseWorkspaceMemoryDreamResult(response) {
  if (response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Malformed workspace memory dream response");
  }
  const record = response;
  const summary = record["summary"];
  const touchedTopics = record["touchedTopics"];
  const dedupedEntries = record["dedupedEntries"];
  if (summary !== void 0 && typeof summary !== "string" || !Array.isArray(touchedTopics) || !touchedTopics.every(isBridgeAutoMemoryTopic) || typeof dedupedEntries !== "number" || !Number.isFinite(dedupedEntries)) {
    throw new Error("Malformed workspace memory dream response");
  }
  return {
    ...summary === void 0 ? {} : { summary },
    touchedTopics,
    dedupedEntries
  };
}
__name(parseWorkspaceMemoryDreamResult, "parseWorkspaceMemoryDreamResult");
function pickUserInputEchoMeta(meta) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const inputAnnotations = meta["inputAnnotations"];
  return Array.isArray(inputAnnotations) ? { inputAnnotations } : {};
}
__name(pickUserInputEchoMeta, "pickUserInputEchoMeta");
function echoPromptToSessionBus(entry, req, promptId, originatorClientId, displayText) {
  const prompt = req.prompt;
  if (!Array.isArray(prompt) || prompt.length === 0) return;
  let displayTextPublished = false;
  const serverTimestamp = Date.now();
  const echoPrompt = prompt.slice(0, MAX_ECHO_CONTENT_BLOCKS);
  if (displayText && !echoPrompt.some((part) => isRecord7(part) && part["type"] === "text")) {
    const textPart = prompt.slice(MAX_ECHO_CONTENT_BLOCKS).find((part) => isRecord7(part) && part["type"] === "text");
    if (textPart) echoPrompt[echoPrompt.length - 1] = textPart;
  }
  const blockCount = echoPrompt.length;
  for (let i = 0; i < blockCount; i += 1) {
    const part = echoPrompt[i];
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    let displayPart = part;
    if (displayText !== void 0 && part.type === "text") {
      if (displayTextPublished) continue;
      displayTextPublished = true;
      if (!displayText) continue;
      displayPart = { ...part, text: displayText };
    }
    try {
      entry.events.publish({
        type: "session_update",
        promptId,
        data: {
          sessionId: req.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            content: displayPart,
            // `_meta` lives inside the `update` object rather than at
            // envelope level. `_meta` is a standard JSON-RPC/MCP extension
            // field permitted alongside spec fields, the SDK normalizer
            // reads it from `update._meta`/`data._meta`, and every other
            // agent-emitted session_update carries `_meta` the same way.
            _meta: {
              ...pickUserInputEchoMeta(req._meta),
              serverTimestamp,
              source: "bridge-echo"
            }
          }
        },
        ...originatorClientId ? { originatorClientId } : {}
      });
    } catch {
    }
  }
}
__name(echoPromptToSessionBus, "echoPromptToSessionBus");
function broadcastPromptCancelled(entry, sessionId, promptId, originatorClientId, reason) {
  try {
    entry.events.publish({
      type: "prompt_cancelled",
      ...promptId ? { promptId } : {},
      data: { sessionId, ...reason ? { reason } : {} },
      ...originatorClientId ? { originatorClientId } : {}
    });
  } catch {
  }
}
__name(broadcastPromptCancelled, "broadcastPromptCancelled");
function broadcastPromptCancelledOnce(entry, sessionId, promptId, originatorClientId, reason) {
  if (promptId !== void 0 && entry.cancelBroadcastPromptId === promptId || promptId === void 0 && entry.cancelBroadcastWithoutPrompt === true) {
    writeStderrLine(
      `broadcastPromptCancelledOnce: suppressed duplicate cancel for session ${sessionId} prompt=${promptId ?? "none"}`
    );
    return;
  }
  if (promptId === void 0) {
    entry.cancelBroadcastWithoutPrompt = true;
  } else {
    entry.cancelBroadcastPromptId = promptId;
  }
  broadcastPromptCancelled(
    entry,
    sessionId,
    promptId,
    originatorClientId,
    reason
  );
}
__name(broadcastPromptCancelledOnce, "broadcastPromptCancelledOnce");
function broadcastTurnComplete(entry, sessionId, promptResult, promptId, originatorClientId, mutateTurnState) {
  try {
    const meta = promptResult["_meta"] && typeof promptResult["_meta"] === "object" ? promptResult["_meta"] : void 0;
    const rawBranchPoint = meta?.["qwen.branchPoint"] && typeof meta["qwen.branchPoint"] === "object" ? meta["qwen.branchPoint"] : void 0;
    const branchPoint = promptResult.stopReason === "end_turn" && typeof rawBranchPoint?.["assistantRecordUuid"] === "string" && CHAT_RECORD_UUID_RE.test(rawBranchPoint["assistantRecordUuid"]) && typeof rawBranchPoint["checkpointUuid"] === "string" && CHAT_RECORD_UUID_RE.test(rawBranchPoint["checkpointUuid"]) ? {
      assistantRecordUuid: rawBranchPoint["assistantRecordUuid"],
      checkpointUuid: rawBranchPoint["checkpointUuid"]
    } : void 0;
    const rawPromptCancelled = meta?.["qwen.promptCancelled"] && typeof meta["qwen.promptCancelled"] === "object" ? meta["qwen.promptCancelled"] : void 0;
    const promptCancelled = promptResult.stopReason === "cancelled" && typeof rawPromptCancelled?.["cancelledAt"] === "number" && Number.isFinite(rawPromptCancelled["cancelledAt"]) && typeof rawPromptCancelled["elapsedMs"] === "number" && Number.isFinite(rawPromptCancelled["elapsedMs"]) && rawPromptCancelled["elapsedMs"] >= 0 ? {
      cancelledAt: rawPromptCancelled["cancelledAt"],
      elapsedMs: rawPromptCancelled["elapsedMs"]
    } : void 0;
    const published = entry.events.publish({
      type: "turn_complete",
      ...promptId ? { promptId } : {},
      data: {
        sessionId,
        stopReason: promptResult.stopReason ?? "end_turn",
        ...promptId ? { promptId } : {},
        ...branchPoint ? { branchPoint } : {},
        ...promptCancelled ? { promptCancelled } : {}
      },
      ...originatorClientId ? { originatorClientId } : {}
    });
    if (mutateTurnState && published !== void 0)
      entry.turnErrorEvent = void 0;
  } catch {
  }
}
__name(broadcastTurnComplete, "broadcastTurnComplete");
function extractErrorMessage(err) {
  if (err instanceof Error) {
    const data = err.data;
    const detail = extractJsonRpcErrorDetail(data);
    return detail ?? err.message;
  }
  if (typeof err === "object" && err !== null) {
    const obj = err;
    const detail = extractJsonRpcErrorDetail(obj["data"]);
    if (detail) return detail;
    const msg = obj["message"];
    if (typeof msg === "string") return msg;
  }
  return String(err);
}
__name(extractErrorMessage, "extractErrorMessage");
function extractJsonRpcErrorDetail(data) {
  if (typeof data === "string" && data.length > 0) return data;
  if (typeof data === "object" && data !== null) {
    const details = data["details"];
    if (typeof details === "string" && details.length > 0) return details;
    const message = data["message"];
    if (typeof message === "string" && message.length > 0) return message;
    return extractNestedErrorDetail(data["error"]);
  }
  return void 0;
}
__name(extractJsonRpcErrorDetail, "extractJsonRpcErrorDetail");
function extractNestedErrorDetail(error) {
  if (typeof error === "string" && error.length > 0) return error;
  if (typeof error === "object" && error !== null) {
    const message = error["message"];
    if (typeof message === "string" && message.length > 0) return message;
  }
  return void 0;
}
__name(extractNestedErrorDetail, "extractNestedErrorDetail");
function extractJsonRpcErrorField(err, field) {
  if (typeof err !== "object" || err === null) return void 0;
  const data = err.data;
  if (typeof data !== "object" || data === null) return void 0;
  const value = data[field];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
__name(extractJsonRpcErrorField, "extractJsonRpcErrorField");
function extractErrorCode(err) {
  if (typeof err !== "object" || err === null || !("code" in err))
    return void 0;
  const raw = err["code"];
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  return void 0;
}
__name(extractErrorCode, "extractErrorCode");
var REFRESH_APPEND_BOOKKEEPING_EVENT_TYPES = /* @__PURE__ */ new Set([
  "pending_prompt_added",
  "pending_prompt_completed",
  "prompt_cancelled",
  "model_switched",
  "model_switch_failed",
  "approval_mode_changed",
  "language_changed",
  "session_metadata_updated",
  "session_cwd_changed",
  "artifact_changed",
  "source_changed",
  "settings_changed",
  "extensions_changed",
  "mcp_server_changed",
  "mcp_server_added",
  "mcp_server_removed",
  "user_shell_command",
  "user_shell_result",
  // Workspace-level fan-out (workspace service, git watcher, memory /
  // agent CRUD, device-flow registry) reaches every session bus via
  // `publishWorkspaceEvent` while idle. The `auth_device_flow_*` members
  // mirror the closed `DeviceFlowEventEmission` union — audit that union
  // when it grows.
  "tool_toggled",
  "workspace_initialized",
  "mcp_server_restarted",
  "mcp_server_restart_refused",
  "settings_reloaded",
  "trust_change_requested",
  "memory_changed",
  "agent_changed",
  "git_status_changed",
  "git_branch_changed",
  "github_setup_completed",
  "auth_device_flow_started",
  "auth_device_flow_throttled",
  "auth_device_flow_authorized",
  "auth_device_flow_failed",
  "auth_device_flow_cancelled"
]);
function isIdleBookkeepingSessionUpdate(event) {
  if (event.type !== "session_update") return false;
  const data = event.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const update = data["update"];
  if (!update || typeof update !== "object" || Array.isArray(update))
    return false;
  const updateRecord = update;
  const subtype = updateRecord["sessionUpdate"];
  if (subtype === "available_commands_update" || subtype === "current_mode_update" || subtype === "session_info_update") {
    return true;
  }
  const meta = updateRecord["_meta"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  return meta["source"] === "user-shell";
}
__name(isIdleBookkeepingSessionUpdate, "isIdleBookkeepingSessionUpdate");
function isRefreshAppendTurnContent(event) {
  if (event.type === "history_truncated") return false;
  if (REFRESH_APPEND_BOOKKEEPING_EVENT_TYPES.has(event.type)) return false;
  return !isIdleBookkeepingSessionUpdate(event);
}
__name(isRefreshAppendTurnContent, "isRefreshAppendTurnContent");
function classifyTurnErrorKind(message) {
  return message.trim().toLowerCase() === "terminated" ? "model_stream_interrupted" : void 0;
}
__name(classifyTurnErrorKind, "classifyTurnErrorKind");
function broadcastTurnError(entry, sessionId, err, promptId, originatorClientId, mutateTurnState) {
  const message = extractErrorMessage(err);
  const structuredErrorKind = extractJsonRpcErrorField(err, "errorKind");
  const errorKind = structuredErrorKind ?? classifyTurnErrorKind(message);
  const code = structuredErrorKind !== void 0 ? extractJsonRpcErrorField(err, "code") ?? extractErrorCode(err) : extractErrorCode(err);
  const loopType = extractJsonRpcErrorField(err, "loopType");
  if (errorKind) {
    writeServeDebugLine(
      `turn_error classified session=${JSON.stringify(sessionId)} message=${JSON.stringify(message)} errorKind=${JSON.stringify(errorKind)}` + (code ? ` code=${JSON.stringify(code)}` : "") + (promptId ? ` promptId=${JSON.stringify(promptId)}` : "")
    );
  }
  if (mutateTurnState) {
    entry.retryAllowed = true;
    entry.turnError = {
      message,
      ...code ? { code } : {},
      ...errorKind ? { errorKind } : {}
    };
  }
  try {
    const published = entry.events.publish({
      type: "turn_error",
      ...promptId ? { promptId } : {},
      data: {
        sessionId,
        message,
        ...code ? { code } : {},
        ...errorKind ? { errorKind } : {},
        ...loopType ? { loopType } : {},
        ...promptId ? { promptId } : {}
      },
      ...originatorClientId ? { originatorClientId } : {}
    });
    if (mutateTurnState) {
      entry.turnErrorEvent = published;
    }
  } catch {
  }
}
__name(broadcastTurnError, "broadcastTurnError");
var TERMINAL_TURN_STATUS_OVERLAY_LIMIT = 64;
function truncateTurnText(text) {
  const truncated = text.length > TURN_RESULT_TEXT_MAX_CHARS;
  return {
    text: truncated ? text.slice(0, TURN_RESULT_TEXT_MAX_CHARS) : text,
    truncated
  };
}
__name(truncateTurnText, "truncateTurnText");
function rememberTerminalTurnStatus(entry, pending, terminal) {
  const promptText = truncateTurnText(pending.text);
  const shared = {
    sessionId: entry.sessionId,
    promptId: pending.promptId,
    promptText: promptText.text,
    ...promptText.truncated ? { promptTextTruncated: true } : {},
    queuedAt: pending.queuedAt,
    ...pending.startedAt !== void 0 ? { startedAt: pending.startedAt } : {},
    endedAt: Date.now(),
    ...pending.originatorClientId !== void 0 ? { originatorClientId: pending.originatorClientId } : {}
  };
  const status = terminal.kind === "complete" ? {
    ...shared,
    state: terminal.result.stopReason === "cancelled" ? "cancelled" : "completed",
    ...terminal.result.stopReason !== void 0 ? { stopReason: terminal.result.stopReason } : {}
  } : terminal.kind === "cancelled" ? { ...shared, state: "cancelled", stopReason: "cancelled" } : {
    ...shared,
    state: "error",
    error: normalizeTurnResultError(terminal.err)
  };
  entry.terminalTurnStatuses.set(pending.promptId, status);
  entry.enrichedTerminalPromptIds.delete(pending.promptId);
  while (entry.terminalTurnStatuses.size > TERMINAL_TURN_STATUS_OVERLAY_LIMIT) {
    const oldest2 = entry.terminalTurnStatuses.keys().next().value;
    if (oldest2 === void 0) break;
    entry.terminalTurnStatuses.delete(oldest2);
    entry.enrichedTerminalPromptIds.delete(oldest2);
  }
}
__name(rememberTerminalTurnStatus, "rememberTerminalTurnStatus");
function rememberEnrichedTerminalTurnStatus(entry, promptId, status) {
  entry.terminalTurnStatuses.set(promptId, status);
  entry.enrichedTerminalPromptIds.add(promptId);
  while (entry.terminalTurnStatuses.size > TERMINAL_TURN_STATUS_OVERLAY_LIMIT) {
    const oldest2 = entry.terminalTurnStatuses.keys().next().value;
    if (oldest2 === void 0) break;
    entry.terminalTurnStatuses.delete(oldest2);
    entry.enrichedTerminalPromptIds.delete(oldest2);
  }
}
__name(rememberEnrichedTerminalTurnStatus, "rememberEnrichedTerminalTurnStatus");
function advanceTurnActivity(entry) {
  const createdAtMs = Date.parse(entry.createdAt);
  const previous = entry.lastTurnEndedAtMs ?? (Number.isFinite(createdAtMs) ? createdAtMs : void 0);
  entry.lastTurnEndedAtMs = previous === void 0 ? Date.now() : Math.max(Date.now(), previous + 1);
}
__name(advanceTurnActivity, "advanceTurnActivity");
function appendPromptLedgerBestEffort(entry, record) {
  const ledger = entry.promptLedger;
  if (!ledger) return;
  try {
    ledger.appendSync(entry.sessionId, record);
  } catch (error) {
    writeStderrLine(
      `qwen serve: prompt ledger append failed for session=${entry.sessionId} promptId=${record.promptId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
__name(appendPromptLedgerBestEffort, "appendPromptLedgerBestEffort");
function promptLedgerTerminalRecord(pendingEntry, terminal) {
  const at = Date.now();
  if (terminal.kind === "complete") {
    if (terminal.result.stopReason === "cancelled") {
      return {
        v: 1,
        promptId: pendingEntry.promptId,
        terminal: "cancelled",
        at
      };
    }
    return {
      v: 1,
      promptId: pendingEntry.promptId,
      terminal: "completed",
      ...terminal.result.stopReason !== void 0 ? { stopReason: terminal.result.stopReason } : {},
      at
    };
  }
  if (terminal.kind === "cancelled") {
    return { v: 1, promptId: pendingEntry.promptId, terminal: "cancelled", at };
  }
  const normalized = normalizeTurnResultError(terminal.err);
  return {
    v: 1,
    promptId: pendingEntry.promptId,
    terminal: "error",
    ...normalized.code !== void 0 ? { code: normalized.code } : {},
    at
  };
}
__name(promptLedgerTerminalRecord, "promptLedgerTerminalRecord");
function publishPromptTerminal(entry, pendingEntry, terminal) {
  if (pendingEntry.terminalPublished) {
    writeServeDebugLine(
      `publishPromptTerminal: suppressed duplicate ${terminal.kind} terminal for prompt ${pendingEntry.promptId} (session ${entry.sessionId})`
    );
    return;
  }
  pendingEntry.terminalPublished = true;
  appendPromptLedgerBestEffort(
    entry,
    promptLedgerTerminalRecord(pendingEntry, terminal)
  );
  rememberTerminalTurnStatus(entry, pendingEntry, terminal);
  const originatorClientId = pendingEntry.originatorClientId;
  const mutateTurnState = pendingEntry.state === "running";
  if (mutateTurnState) {
    advanceTurnActivity(entry);
  }
  if (!mutateTurnState && entry.turnErrorEvent) {
    const journal = entry.events.liveJournalSnapshot() ?? [];
    if (journal.some(isRefreshAppendTurnContent)) {
      entry.turnErrorEvent = void 0;
    }
  }
  if (terminal.kind === "complete") {
    broadcastTurnComplete(
      entry,
      entry.sessionId,
      terminal.result,
      pendingEntry.promptId,
      originatorClientId,
      mutateTurnState
    );
  } else if (terminal.kind === "cancelled") {
    broadcastTurnComplete(
      entry,
      entry.sessionId,
      { stopReason: "cancelled" },
      pendingEntry.promptId,
      originatorClientId,
      mutateTurnState
    );
  } else {
    broadcastTurnError(
      entry,
      entry.sessionId,
      terminal.err,
      pendingEntry.promptId,
      originatorClientId,
      mutateTurnState
    );
  }
  if (entry.activePromptTerminal?.promptId === pendingEntry.promptId) {
    entry.activePromptTerminal.resolve();
  }
}
__name(publishPromptTerminal, "publishPromptTerminal");
function flushPromptTerminals(entry, code, message) {
  for (const pending of [...entry.pendingPromptList]) {
    publishPromptTerminal(entry, pending, {
      kind: "error",
      err: { code, message }
    });
    try {
      pending.abortController.abort(
        new DOMException("Prompt aborted", "AbortError")
      );
    } catch {
    }
  }
}
__name(flushPromptTerminals, "flushPromptTerminals");
function hasControlCharacter2(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}
__name(hasControlCharacter2, "hasControlCharacter");
function extractPromptText(prompt) {
  if (!Array.isArray(prompt)) return "";
  let hasImage = false;
  for (const block of prompt) {
    const record = block;
    if (record["type"] === "image") {
      hasImage = true;
    }
    if (record["type"] === "text" && typeof record["text"] === "string" && record["text"].length > 0) {
      return record["text"];
    }
  }
  return hasImage ? "[image]" : "";
}
__name(extractPromptText, "extractPromptText");
function liveTurnStatus(sessionId, pending) {
  const promptText = truncateTurnText(pending.text);
  return {
    sessionId,
    state: pending.state === "running" ? "running" : "queued",
    promptId: pending.promptId,
    promptText: promptText.text,
    ...promptText.truncated ? { promptTextTruncated: true } : {},
    queuedAt: pending.queuedAt,
    ...pending.startedAt !== void 0 ? { startedAt: pending.startedAt } : {},
    ...pending.originatorClientId !== void 0 ? { originatorClientId: pending.originatorClientId } : {}
  };
}
__name(liveTurnStatus, "liveTurnStatus");
function findLiveTurnStatus(entry, promptId) {
  const live = entry.pendingPromptList.filter(
    (pending) => !pending.terminalPublished && (!pending.removed || pending.state === "running")
  );
  if (promptId !== void 0) {
    const match = live.find((pending) => pending.promptId === promptId);
    return match ? liveTurnStatus(entry.sessionId, match) : void 0;
  }
  const running = live.find((pending) => pending.state === "running");
  if (running) return liveTurnStatus(entry.sessionId, running);
  const queued = live.find((pending) => pending.state === "queued");
  return queued ? liveTurnStatus(entry.sessionId, queued) : void 0;
}
__name(findLiveTurnStatus, "findLiveTurnStatus");
function settledTurnStatus(sessionId, record) {
  return {
    sessionId,
    state: record.state,
    promptId: record.promptId,
    ...record.stopReason !== void 0 ? { stopReason: record.stopReason } : {},
    ...record.error !== void 0 ? { error: record.error } : {},
    ...record.startedAt !== void 0 ? { startedAt: record.startedAt } : {},
    endedAt: record.endedAt,
    ...record.promptText !== void 0 ? { promptText: record.promptText } : {},
    ...record.promptTextTruncated !== void 0 ? { promptTextTruncated: record.promptTextTruncated } : {},
    ...record.resultText !== void 0 ? { resultText: record.resultText } : {},
    ...record.resultTruncated !== void 0 ? { resultTruncated: record.resultTruncated } : {},
    ...record.resultTruncated === true ? { resultCode: record.resultCode ?? TURN_RESULT_CODE_TEXT_TRUNCATED } : {},
    ...record.originatorClientId !== void 0 ? { originatorClientId: record.originatorClientId } : {}
  };
}
__name(settledTurnStatus, "settledTurnStatus");
function enrichTerminalTurnStatus(terminal, persisted) {
  return {
    ...terminal,
    // The bridge's display projection is trusted; the child-recorded text
    // only backfills when the terminal has none, so hidden channel context
    // the child derived from raw blocks never replaces it.
    ...terminal.promptText === void 0 && persisted.promptText !== void 0 ? { promptText: persisted.promptText } : {},
    ...terminal.promptTextTruncated === void 0 && persisted.promptTextTruncated !== void 0 ? { promptTextTruncated: persisted.promptTextTruncated } : {},
    ...persisted.resultText !== void 0 ? { resultText: persisted.resultText } : {},
    ...persisted.resultTruncated !== void 0 ? { resultTruncated: persisted.resultTruncated } : {},
    ...persisted.resultCode !== void 0 ? { resultCode: persisted.resultCode } : {},
    ...terminal.originatorClientId === void 0 && persisted.originatorClientId !== void 0 ? { originatorClientId: persisted.originatorClientId } : {}
  };
}
__name(enrichTerminalTurnStatus, "enrichTerminalTurnStatus");
function mergeTerminalWithPersisted(terminal, persisted) {
  if (terminal.state === "error" && persisted.state !== "error") {
    return {
      ...persisted,
      ...terminal.promptText !== void 0 ? { promptText: terminal.promptText } : {},
      ...terminal.promptTextTruncated !== void 0 ? { promptTextTruncated: terminal.promptTextTruncated } : {}
    };
  }
  return enrichTerminalTurnStatus(terminal, persisted);
}
__name(mergeTerminalWithPersisted, "mergeTerminalWithPersisted");
function latestTerminalTurnStatus(entry) {
  let latest;
  for (const status of entry.terminalTurnStatuses.values()) {
    if ((status.endedAt ?? 0) >= (latest?.endedAt ?? 0)) latest = status;
  }
  return latest;
}
__name(latestTerminalTurnStatus, "latestTerminalTurnStatus");
function extractMediaBlocks(prompt) {
  if (!Array.isArray(prompt)) return void 0;
  const media = [];
  for (const block of prompt) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "image" || block.type === "audio" || block.type === "resource" && "attachmentId" in block) {
      media.push(block);
    }
  }
  return media.length > 0 ? media : void 0;
}
__name(extractMediaBlocks, "extractMediaBlocks");
var DEFAULT_INIT_TIMEOUT_MS = 1e4;
var PERSIST_TIMEOUT_MS = 5e3;
var MAX_PARENT_PERSIST_ATTEMPTS = 3;
var MCP_RESTART_TIMEOUT_MS = 3e5;
var WORKSPACE_MEMORY_REMEMBER_TIMEOUT_MS = 3e5;
var MCP_OAUTH_TIMEOUT_MS = 6e5;
var DAEMON_RETRY_META_KEY = "qwen.daemon.retry";
var DAEMON_CONTINUE_META_KEY = "qwen.daemon.continueLastTurn";
var SESSION_RECAP_TIMEOUT_MS = 6e4;
var SESSION_GENERATION_TIMEOUT_MS = 65e3;
var GENERATION_STREAM_QUEUE_CAPACITY = 128;
var SESSION_BTW_TIMEOUT_MS = 6e4;
var SESSION_TRANSCRIPT_TIMEOUT_MS = 6e4;
var MAX_EMPTY_TRANSCRIPT_PAGES = 20;
var SHELL_COMMAND_TIMEOUT_MS = 12e4;
var MAX_SHELL_OUTPUT_FOR_HISTORY = 1e4;
var MAX_MID_TURN_QUEUE_DEPTH = 20;
var MAX_QUEUED_INLINE_ATTACHMENT_BYTES = 100 * 1024 * 1024;
function inlineAttachmentBlockBytes(blocks) {
  let total = 0;
  for (const block of blocks) {
    if (block.type === "image" && "data" in block) {
      total += Buffer.byteLength(block.data);
      continue;
    }
    if (block.type !== "resource" || !("resource" in block)) continue;
    const resource = block.resource;
    if ("blob" in resource) total += Buffer.byteLength(resource.blob);
    else if ("text" in resource) total += Buffer.byteLength(resource.text);
  }
  return total;
}
__name(inlineAttachmentBlockBytes, "inlineAttachmentBlockBytes");
var DEFAULT_MAX_SESSIONS = 32;
var DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5;
var CHAT_RECORD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var MAX_EVENT_RING_SIZE = 1e6;
var DEFAULT_PERMISSION_TIMEOUT_MS = 0;
var DEFAULT_MAX_PENDING_PER_SESSION = 64;
var DEFAULT_SESSION_REAP_INTERVAL_MS = 6e4;
var DEFAULT_SESSION_IDLE_TIMEOUT_MS = 30 * 6e4;
var DEFAULT_SESSION_PROMPT_SETTLED_CLOSE_GRACE_MS = 0;
function createSessionControlPlane(opts, createHarness) {
  let liveScreenContextCaptureHandler;
  let liveTaskToolRequestHandler;
  let liveSpeakToUserHandler;
  const defaultSessionScope = opts.sessionScope ?? "single";
  const delegateReadTextFileToClient = opts.delegateReadTextFileToClient ?? true;
  let maxSessions;
  if (opts.maxSessions === void 0) {
    maxSessions = DEFAULT_MAX_SESSIONS;
  } else if (Number.isNaN(opts.maxSessions)) {
    throw new TypeError(
      `Invalid maxSessions: NaN. Must be a number >= 0 (0 / Infinity = unlimited).`
    );
  } else if (opts.maxSessions < 0) {
    throw new TypeError(
      `Invalid maxSessions: ${opts.maxSessions}. Must be >= 0 (0 / Infinity = unlimited).`
    );
  } else if (opts.maxSessions === 0 || opts.maxSessions === Infinity) {
    maxSessions = Infinity;
  } else {
    maxSessions = opts.maxSessions;
  }
  const freshSessionBlocker = /* @__PURE__ */ __name(() => {
    for (const ci of channelInfos()) {
      if (ci.harness.isDying) continue;
      if (ci.isQuarantined) {
        return { channel: ci, reason: "restore_cleanup_failed" };
      }
      if (ci.overdueAbandonedRestores.size > 0) {
        return { channel: ci, reason: "restore_settlement_overdue" };
      }
      if (ci.newSessionCleanupFailed) {
        return { channel: ci, reason: "new_session_cleanup_failed" };
      }
      if (ci.overdueAbandonedNewSessions.size > 0) {
        return { channel: ci, reason: "new_session_settlement_overdue" };
      }
    }
    return void 0;
  }, "freshSessionBlocker");
  const assertFreshSessionsAvailable = /* @__PURE__ */ __name(() => {
    const blocker = freshSessionBlocker();
    if (blocker) {
      throw new BridgeChannelQuarantinedError(
        blocker.reason,
        blocker.reason.startsWith("new_session_") ? abandonedNewSessionRetryAfterSeconds : abandonedRestoreRetryAfterSeconds
      );
    }
  }, "assertFreshSessionsAvailable");
  const reserveFreshSession = /* @__PURE__ */ __name((context) => {
    assertFreshSessionsAvailable();
    return opts.freshSessionAdmission?.(context);
  }, "reserveFreshSession");
  const releaseFreshSessionReservation = /* @__PURE__ */ __name((reservation) => {
    if (!reservation) return;
    try {
      reservation.release();
    } catch (err) {
      opts.onDiagnosticLine?.(
        `qwen serve: fresh session admission release failed: ${err instanceof Error ? err.message : String(err)}`,
        "warn"
      );
    }
  }, "releaseFreshSessionReservation");
  const sessionCatalogGeneration = randomUUID3();
  let sessionCatalogRevision = 0;
  const getSessionCatalogVersion = /* @__PURE__ */ __name(() => ({
    generation: sessionCatalogGeneration,
    revision: sessionCatalogRevision
  }), "getSessionCatalogVersion");
  const markSessionCatalogChanged = /* @__PURE__ */ __name(() => {
    sessionCatalogRevision += 1;
  }, "markSessionCatalogChanged");
  const emitSessionLifecycle = /* @__PURE__ */ __name((event) => {
    markSessionCatalogChanged();
    try {
      opts.sessionLifecycle?.(event);
    } catch (err) {
      const message = `qwen serve: session lifecycle callback failed: ${err instanceof Error ? err.message : String(err)}`;
      opts.onDiagnosticLine?.(message, "warn");
      writeStderrLine(message);
    }
  }, "emitSessionLifecycle");
  if (defaultSessionScope !== "single" && defaultSessionScope !== "thread") {
    throw new TypeError(
      `Invalid sessionScope: ${JSON.stringify(defaultSessionScope)}. Expected 'single' or 'thread'.`
    );
  }
  const eventRingSize = opts.eventRingSize ?? DEFAULT_RING_SIZE;
  if (!Number.isInteger(eventRingSize) || eventRingSize < 1 || eventRingSize > MAX_EVENT_RING_SIZE) {
    throw new TypeError(
      `Invalid eventRingSize: ${opts.eventRingSize}. Must be a positive integer in [1, ${MAX_EVENT_RING_SIZE}].`
    );
  }
  const compactedReplayMaxBytes = normalizeCompactedReplayMaxBytes(
    opts.compactedReplayMaxBytes
  );
  const maxJournalEvents = normalizeMaxJournalEvents(opts.maxJournalEvents);
  const maxJournalBytes = normalizeMaxJournalBytes(opts.maxJournalBytes);
  const journalGrowthPoolBytes = normalizeJournalGrowthPoolBytes(
    opts.journalGrowthPoolBytes
  );
  const journalGrowthPolicy = journalGrowthPoolBytes !== void 0 ? createJournalGrowthPolicy({
    baselineEvents: maxJournalEvents,
    baselineBytes: maxJournalBytes,
    poolBytes: journalGrowthPoolBytes,
    hardCapBytes: JOURNAL_GROWTH_HARD_CAP_BYTES
  }) : void 0;
  const journalGrowthSessionLimits = opts.journalGrowthSessionLimits;
  const channelFactory = opts.channelFactory ?? defaultSpawnChannelFactory;
  const childEnvOverrides = opts.childEnvOverrides ? Object.freeze({ ...opts.childEnvOverrides }) : Object.freeze({});
  const mandatoryLeaseAttested = childEnvOverrides[PRIVATE_CONVERSATIONS_RUNTIME_ENV] === PRIVATE_CONVERSATIONS_RUNTIME_ENABLE && channelFactoryForwardsChildEnv(channelFactory);
  const initTimeoutMs = opts.initializeTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
  if (!Number.isInteger(initTimeoutMs) || initTimeoutMs <= 0) {
    throw new TypeError(
      `Invalid initializeTimeoutMs: ${initTimeoutMs}. Must be a positive integer.`
    );
  }
  if (initTimeoutMs > 2147483647) {
    throw new TypeError(
      `Invalid initializeTimeoutMs: ${initTimeoutMs}. Must not exceed the supported timer range.`
    );
  }
  const newSessionSettlementGraceMs = initTimeoutMs;
  const abandonedNewSessionRetryAfterSeconds = restoreRetryAfterSeconds(initTimeoutMs);
  let localRuntimeEpoch = 0;
  const runtimeEpochSource = opts.runtimeEpochSource ?? {
    current: /* @__PURE__ */ __name(() => localRuntimeEpoch, "current"),
    allocate: /* @__PURE__ */ __name(() => ++localRuntimeEpoch, "allocate")
  };
  const initialRuntimeEpoch = runtimeEpochSource.current();
  if (!Number.isSafeInteger(initialRuntimeEpoch) || initialRuntimeEpoch < 0) {
    throw new TypeError(
      `Invalid initial runtime epoch: ${initialRuntimeEpoch}.`
    );
  }
  const sessionRestoreTimeoutMs = resolveSessionRestoreTimeoutMs(opts);
  const restoreSettlementGraceMs = sessionRestoreTimeoutMs;
  const abandonedRestoreRetryAfterSeconds = restoreRetryAfterSeconds(
    sessionRestoreTimeoutMs
  );
  const permissionTimeoutRaw = opts.permissionResponseTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  const permissionTimeoutMs = permissionTimeoutRaw > 0 && Number.isFinite(permissionTimeoutRaw) ? (
    // Clamp to 2^31-1: Node treats setTimeout delays larger than
    // this as 1ms (TimeoutOverflowWarning), which would make a
    // huge "effectively never" timeout cancel prompts almost
    // immediately — the opposite of intent. Mirrors the sibling
    // `resolvePositiveFiniteMs` / `resolvedChannelIdleTimeoutMs`.
    Math.min(permissionTimeoutRaw, 2147483647)
  ) : 0;
  const maxPendingRaw = opts.maxPendingPermissionsPerSession ?? DEFAULT_MAX_PENDING_PER_SESSION;
  const maxPendingPerSession = maxPendingRaw > 0 && Number.isFinite(maxPendingRaw) ? maxPendingRaw : Infinity;
  const maxPendingPromptsRaw = opts.maxPendingPromptsPerSession ?? DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION;
  let maxPendingPromptsPerSession;
  if (maxPendingPromptsRaw === 0 || maxPendingPromptsRaw === Number.POSITIVE_INFINITY) {
    maxPendingPromptsPerSession = Infinity;
  } else if (!Number.isInteger(maxPendingPromptsRaw) || maxPendingPromptsRaw < 0) {
    throw new TypeError(
      `Invalid maxPendingPromptsPerSession: ${maxPendingPromptsRaw}. Must be a non-negative integer (0 / Infinity = unlimited).`
    );
  } else {
    maxPendingPromptsPerSession = maxPendingPromptsRaw;
  }
  if (!path4.isAbsolute(opts.boundWorkspace)) {
    throw new TypeError(
      `Invalid boundWorkspace: "${opts.boundWorkspace}". Must be an absolute path.`
    );
  }
  const boundWorkspace = opts.boundWorkspace;
  const persistApprovalMode = opts.persistApprovalMode;
  const telemetry = opts.telemetry ?? NOOP_BRIDGE_TELEMETRY;
  let defaultEntry;
  const sessionChannels = /* @__PURE__ */ new WeakMap();
  const getChannelInfo = /* @__PURE__ */ __name((channel) => sessionChannels.get(channel), "getChannelInfo");
  const currentChannelInfo = /* @__PURE__ */ __name(() => {
    const channel = harness.current;
    return channel ? getChannelInfo(channel) : void 0;
  }, "currentChannelInfo");
  function* channelInfos() {
    for (const channel of harness.values()) yield getChannelInfo(channel);
  }
  __name(channelInfos, "channelInfos");
  let workspaceMcpStatusCache;
  const workspaceMcpToolsCache = /* @__PURE__ */ new Map();
  const workspaceMcpResourcesCache = /* @__PURE__ */ new Map();
  const sessionReapIntervalMs = resolvePositiveFiniteMs(
    opts.sessionReapIntervalMs,
    DEFAULT_SESSION_REAP_INTERVAL_MS
  );
  const sessionIdleTimeoutMs = resolvePositiveFiniteMs(
    opts.sessionIdleTimeoutMs,
    DEFAULT_SESSION_IDLE_TIMEOUT_MS
  );
  const sessionPromptSettledCloseGraceMs = resolvePositiveFiniteMs(
    opts.sessionPromptSettledCloseGraceMs,
    DEFAULT_SESSION_PROMPT_SETTLED_CLOSE_GRACE_MS
  );
  let sessionReaper;
  let lastActivityTimestamp = null;
  let activePromptCounter = 0;
  function touchActivity() {
    lastActivityTimestamp = Date.now();
    if (harness.current && !harness.current.isDying) {
      harness.current.lastUsedAt = lastActivityTimestamp;
    }
  }
  __name(touchActivity, "touchActivity");
  function entryHasLocalWork(entry) {
    return entry.pendingPromptCount > 0 || entry.pendingAgentNotificationCount > 0 || !!entry.backgroundTurn;
  }
  __name(entryHasLocalWork, "entryHasLocalWork");
  function childHoldsAreFresh(entry, capability) {
    if (entry.childHoldsAt === null) return false;
    return Date.now() - entry.childHoldsAt <= capability.intervalMs * ACTIVE_WORK_STALE_INTERVALS;
  }
  __name(childHoldsAreFresh, "childHoldsAreFresh");
  function childReportsHeldWork(entry) {
    const owner = channelInfoForEntry(entry);
    if (!owner?.harness.activeWork) return false;
    if (!childHoldsAreFresh(entry, owner.harness.activeWork)) return false;
    return entry.childHolds !== null && entry.childHolds.size > 0;
  }
  __name(childReportsHeldWork, "childReportsHeldWork");
  function childWorkIsUnknown(entry) {
    const owner = channelInfoForEntry(entry);
    if (!owner?.harness.activeWork) return false;
    return !childHoldsAreFresh(entry, owner.harness.activeWork);
  }
  __name(childWorkIsUnknown, "childWorkIsUnknown");
  function entryHasActiveWork(entry) {
    return entryHasLocalWork(entry) || childReportsHeldWork(entry) || childWorkIsUnknown(entry);
  }
  __name(entryHasActiveWork, "entryHasActiveWork");
  function entryActiveWorkState(entry) {
    if (entryHasLocalWork(entry) || childReportsHeldWork(entry)) {
      return "active";
    }
    const capability = channelInfoForEntry(entry)?.harness.activeWork;
    if (!capability) return "unsupported";
    if (childWorkIsUnknown(entry) || ACTIVE_WORK_HOLD_CATEGORIES.some(
      (category) => !capability.categories.includes(category)
    )) {
      return "unknown";
    }
    return "idle";
  }
  __name(entryActiveWorkState, "entryActiveWorkState");
  function entryIsAutoCloseCandidate(entry) {
    if (byId.get(entry.sessionId) !== entry) return false;
    if (isClosingOrAuthorizingClose(entry)) return false;
    if (entry.events.subscriberCount > 0) return false;
    if (entryHasLocalWork(entry)) return false;
    const owner = channelInfoForEntry(entry);
    if (owner?.pendingRestoreIds.has(entry.sessionId)) return false;
    const capability = owner?.harness.activeWork;
    if (capability && childCloseNeedsRoundTrip(owner) && ACTIVE_WORK_HOLD_CATEGORIES.some(
      (category) => !capability.categories.includes(category)
    )) {
      return false;
    }
    if (childCloseNeedsRoundTrip(owner) && entry.activeWorkCloseRetryAt !== null && Date.now() < entry.activeWorkCloseRetryAt) {
      return false;
    }
    if (entry.promptSettledAt !== null && sessionPromptSettledCloseGraceMs > 0 && Date.now() - entry.promptSettledAt < sessionPromptSettledCloseGraceMs) {
      return false;
    }
    return !childReportsHeldWork(entry);
  }
  __name(entryIsAutoCloseCandidate, "entryIsAutoCloseCandidate");
  function isClosingOrAuthorizingClose(entry) {
    return entry.closing || entry.activeWorkCloseInFlight;
  }
  __name(isClosingOrAuthorizingClose, "isClosingOrAuthorizingClose");
  function schedulePromptSettledClose(entry) {
    if (entry.promptSettledCloseTimer !== void 0) {
      clearTimeout(entry.promptSettledCloseTimer);
      entry.promptSettledCloseTimer = void 0;
    }
    entry.promptSettledAt = Date.now();
    if (sessionPromptSettledCloseGraceMs <= 0) {
      entry.promptSettledAt = null;
      void maybeCloseIdleSession(entry, "prompt_settled");
      return;
    }
    entry.promptSettledCloseTimer = setTimeout(() => {
      entry.promptSettledCloseTimer = void 0;
      entry.promptSettledAt = null;
      void maybeCloseIdleSession(entry, "prompt_settled");
    }, sessionPromptSettledCloseGraceMs);
    entry.promptSettledCloseTimer.unref?.();
  }
  __name(schedulePromptSettledClose, "schedulePromptSettledClose");
  function clearPromptSettledClose(entry) {
    if (entry.promptSettledCloseTimer !== void 0) {
      clearTimeout(entry.promptSettledCloseTimer);
      entry.promptSettledCloseTimer = void 0;
    }
    entry.promptSettledAt = null;
  }
  __name(clearPromptSettledClose, "clearPromptSettledClose");
  function cancelPromptSettledTimer(entry) {
    if (entry.promptSettledCloseTimer !== void 0) {
      clearTimeout(entry.promptSettledCloseTimer);
      entry.promptSettledCloseTimer = void 0;
    }
  }
  __name(cancelPromptSettledTimer, "cancelPromptSettledTimer");
  function rearmPromptSettledClose(entry) {
    if (entry.promptSettledAt === null) return;
    if (entry.promptSettledCloseTimer !== void 0) return;
    const elapsed = Date.now() - entry.promptSettledAt;
    const remaining = sessionPromptSettledCloseGraceMs - elapsed;
    if (remaining <= 0) {
      entry.promptSettledAt = null;
      void maybeCloseIdleSession(entry, "prompt_settled");
      return;
    }
    entry.promptSettledCloseTimer = setTimeout(() => {
      entry.promptSettledCloseTimer = void 0;
      entry.promptSettledAt = null;
      void maybeCloseIdleSession(entry, "prompt_settled");
    }, remaining);
    entry.promptSettledCloseTimer.unref?.();
  }
  __name(rearmPromptSettledClose, "rearmPromptSettledClose");
  async function maybeCloseIdleSession(entry, reason) {
    if (byId.get(entry.sessionId) === entry && !isClosingOrAuthorizingClose(entry) && entry.spawnOwnerWantedKill && entry.attachCount === 0) {
      writeStderrLine(
        `qwen serve: completing deferred kill of session ${JSON.stringify(entry.sessionId)} (${reason})`
      );
      await bridgeApi.killSession(entry.sessionId).catch(() => {
      });
      return;
    }
    if (!entryIsAutoCloseCandidate(entry)) return;
    if (entry.clientIds.size > 0) return;
    await closeIfChildUnheld(entry, {
      trigger: reason,
      closeReason: "last_client_detached"
    });
  }
  __name(maybeCloseIdleSession, "maybeCloseIdleSession");
  async function closeIfChildUnheld(entry, opts2) {
    entry.activeWorkCloseInFlight = true;
    try {
      if (!await confirmChildUnheld(entry)) return;
      if (byId.get(entry.sessionId) !== entry) return;
      const condemnedOwner = channelInfoForEntry(entry);
      const agentCloseTimeoutMs = condemnedOwner !== void 0 && channelIsCondemned(condemnedOwner) ? ACTIVE_WORK_CLOSE_TIMEOUT_MS : void 0;
      await closeSessionImpl(entry.sessionId, void 0, {
        reason: opts2.closeReason,
        ...agentCloseTimeoutMs !== void 0 ? { agentCloseTimeoutMs } : {}
      }).catch((err) => {
        writeStderrLine(
          `qwen serve: deferred close (${opts2.trigger}) failed for ${JSON.stringify(entry.sessionId)}: ${err instanceof Error ? err.stack ?? err.message : extractErrorMessage(err)}`
        );
      });
    } finally {
      entry.activeWorkCloseInFlight = false;
    }
  }
  __name(closeIfChildUnheld, "closeIfChildUnheld");
  async function confirmChildUnheld(entry) {
    const info = channelInfoForEntry(entry);
    if (!info?.harness.activeWork) return true;
    if (info.harness.isDying) return false;
    if (channelIsCondemned(info)) {
      return true;
    }
    try {
      const response = await withTimeout(
        entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionClose, {
          sessionId: entry.sessionId,
          [ACTIVE_WORK_CLOSE_IF_UNHELD_PARAM]: true,
          drainTimeoutMs: sessionCloseDrainBudgetMs(
            ACTIVE_WORK_CLOSE_TIMEOUT_MS
          )
        }),
        ACTIVE_WORK_CLOSE_TIMEOUT_MS,
        SERVE_CONTROL_EXT_METHODS.sessionClose
      );
      entry.activeWorkCloseFailures = 0;
      entry.activeWorkCloseRetryAt = null;
      if (response["closed"] === true) {
        return true;
      }
      const holds = response["holds"];
      if (Array.isArray(holds) && holds.length <= ACTIVE_WORK_MAX_SESSION_HOLDS) {
        const adopted = /* @__PURE__ */ new Map();
        for (const hold of holds) {
          if (typeof hold !== "object" || hold === null) continue;
          const record = hold;
          const id = record["id"];
          const category = record["category"];
          if (typeof id === "string" && typeof category === "string" && ACTIVE_WORK_HOLD_CATEGORIES.includes(
            category
          )) {
            adopted.set(id, category);
          }
        }
        entry.childHolds = adopted;
        entry.childHoldsAt = Date.now();
      }
      return false;
    } catch (err) {
      entry.activeWorkCloseFailures++;
      const delayMs = activeWorkCloseRetryDelayMs(
        entry.activeWorkCloseFailures
      );
      entry.activeWorkCloseRetryAt = delayMs === null ? null : Date.now() + delayMs;
      writeStderrLine(
        `qwen serve: close-if-unheld for session ${JSON.stringify(entry.sessionId)} did not resolve (${extractErrorMessage(err)}); ` + (delayMs === null ? `leaving it in place for the next snapshot to settle` : `leaving it in place and deferring the next probe by ${delayMs}ms after ${entry.activeWorkCloseFailures} consecutive failures`)
      );
      return false;
    }
  }
  __name(confirmChildUnheld, "confirmChildUnheld");
  function applyActiveWorkSnapshot(info, snapshot) {
    if (!info.harness.activeWork || info.harness.isDying) return;
    if (snapshot.seq <= info.harness.activeWork.seq) return;
    info.harness.activeWork.seq = snapshot.seq;
    const now = Date.now();
    const reportedHolds = /* @__PURE__ */ new Map();
    for (const session of snapshot.sessions) {
      const holds = /* @__PURE__ */ new Map();
      for (const hold of session.holds) holds.set(hold.id, hold.category);
      reportedHolds.set(session.sessionId, holds);
    }
    info.harness.activeWork.snapshot = {
      receivedAt: now,
      sessions: reportedHolds
    };
    const reported = new Map(
      snapshot.sessions.map((session) => [session.sessionId, session])
    );
    for (const sessionId of Array.from(info.sessionIds)) {
      const entry = byId.get(sessionId);
      if (!entry || entry.channel !== info.channel) continue;
      const report = reported.get(sessionId);
      if (report?.finishedBackgroundTurnId) {
        info.client.finishBackgroundTurn(
          sessionId,
          report.finishedBackgroundTurnId,
          "end_turn"
        );
      }
      const holds = new Map(
        report?.holds.map((hold) => [hold.id, hold.category])
      );
      const previouslyHeld = entry.childHolds ? entry.childHolds.size > 0 : void 0;
      const running = report ? report.hasRunningBackgroundTasks : entry.hasRunningBackgroundTasks === void 0 ? void 0 : false;
      if (entry.hasRunningBackgroundTasks !== running) {
        entry.hasRunningBackgroundTasks = running;
        markSessionCatalogChanged();
      }
      entry.childHolds = holds;
      entry.childHoldsAt = now;
      if (previouslyHeld !== void 0 && previouslyHeld !== holds.size > 0) {
        touchActivity();
      }
      if (holds.size === 0) {
        if (!reported.has(sessionId)) {
          entry.activeWorkCloseFailures = 0;
          entry.activeWorkCloseRetryAt = null;
        }
        void maybeCloseIdleSession(
          entry,
          reported.has(sessionId) ? "child_idle" : "child_dropped"
        );
      } else {
        entry.activeWorkCloseFailures = 0;
        entry.activeWorkCloseRetryAt = null;
      }
    }
  }
  __name(applyActiveWorkSnapshot, "applyActiveWorkSnapshot");
  function settleActivePromptState(entry, promptId) {
    if (entry.activePromptId !== promptId) return;
    entry.events.setEventDetailMode("full");
    delete entry.activePromptId;
    delete entry.activePromptOriginatorClientId;
    if (entry.promptActive) {
      entry.promptActive = false;
      activePromptCounter--;
      entry.sessionLastSeenAt = Date.now();
      touchActivity();
    }
  }
  __name(settleActivePromptState, "settleActivePromptState");
  function resolvePositiveFiniteMs(raw, fallback) {
    if (raw === void 0) return fallback;
    return raw > 0 && Number.isFinite(raw) ? Math.min(raw, 2147483647) : 0;
  }
  __name(resolvePositiveFiniteMs, "resolvePositiveFiniteMs");
  function hasNoSessionWork(ci, opts2) {
    const inFlightSpawnCount = ci.sessionSpawnsInFlight - (opts2?.ignoreCurrentSessionSpawn === true ? 1 : 0);
    const ignoredRestoreIds = new Set(ci.unsettledAbandonedRestores);
    if (opts2?.ignoreRestoreId !== void 0) {
      ignoredRestoreIds.add(opts2.ignoreRestoreId);
    }
    const pendingRestoreCount = [...ci.pendingRestoreIds].filter(
      (sessionId) => !ignoredRestoreIds.has(sessionId)
    ).length;
    const outerRestoreCount = [...inFlightRestores.keys()].filter(
      (sessionId) => !ignoredRestoreIds.has(sessionId)
    ).length;
    return ci.sessionIds.size === 0 && pendingRestoreCount === 0 && inFlightSpawnCount === 0 && outerRestoreCount <= 0;
  }
  __name(hasNoSessionWork, "hasNoSessionWork");
  function beginWorkspaceMcpDiscovery(ci) {
    workspaceMcpStatusCache = void 0;
    workspaceMcpToolsCache.clear();
    workspaceMcpResourcesCache.clear();
    ci.workspaceMcpDiscoveryInFlight = true;
    if (ci.workspaceMcpDiscoveryTimer) {
      clearTimeout(ci.workspaceMcpDiscoveryTimer);
    }
    ci.workspaceMcpDiscoveryTimer = setTimeout(() => {
      ci.workspaceMcpDiscoveryTimer = void 0;
      if (ci.harness.isDying) return;
      void harness.retireChannelAfterSessionsDrain(
        ci.harness,
        "workspace MCP discovery timeout"
      );
    }, MCP_RESTART_TIMEOUT_MS);
    ci.workspaceMcpDiscoveryTimer.unref();
  }
  __name(beginWorkspaceMcpDiscovery, "beginWorkspaceMcpDiscovery");
  function finishWorkspaceMcpDiscovery(ci) {
    ci.harness.lastUsedAt = Date.now();
    ci.workspaceMcpDiscoveryInFlight = false;
    if (ci.workspaceMcpDiscoveryTimer) {
      clearTimeout(ci.workspaceMcpDiscoveryTimer);
      ci.workspaceMcpDiscoveryTimer = void 0;
    }
  }
  __name(finishWorkspaceMcpDiscovery, "finishWorkspaceMcpDiscovery");
  function invalidateWorkspaceMcpDetailCache(serverName) {
    workspaceMcpToolsCache.delete(serverName);
    workspaceMcpResourcesCache.delete(serverName);
  }
  __name(invalidateWorkspaceMcpDetailCache, "invalidateWorkspaceMcpDetailCache");
  function channelShouldReapWhenIdle(ci) {
    return ci.harness.emptyReapPending || ci.harness.retireWhenSessionsDrain || ci.unsettledAbandonedRestores.size > 0 || ci.unsettledAbandonedNewSessions.size > 0 || ci.isQuarantined || ci.newSessionCleanupFailed;
  }
  __name(channelShouldReapWhenIdle, "channelShouldReapWhenIdle");
  function channelIsCondemned(ci) {
    return ci.isQuarantined || ci.overdueAbandonedRestores.size > 0 || ci.newSessionCleanupFailed || ci.overdueAbandonedNewSessions.size > 0;
  }
  __name(channelIsCondemned, "channelIsCondemned");
  function childCloseNeedsRoundTrip(owner) {
    return owner !== void 0 && owner.harness.activeWork !== void 0 && !channelIsCondemned(owner);
  }
  __name(childCloseNeedsRoundTrip, "childCloseNeedsRoundTrip");
  function armRestoreSettlementGrace(ci, sessionId, action) {
    if (ci.restoreSettlementTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      ci.restoreSettlementTimers.delete(sessionId);
      if (!ci.unsettledAbandonedRestores.has(sessionId)) return;
      if (ci.harness.isDying || !harness.has(ci.harness)) return;
      ci.overdueAbandonedRestores.add(sessionId);
      writeStderrLine(
        `qwen serve: abandoned session/${action} for ${JSON.stringify(sessionId)} has not settled ${restoreSettlementGraceMs}ms after its deadline; refusing fresh sessions on channel ${ci.id} until it settles or drains`
      );
      telemetry.event("session.restore.settlement_overdue", {
        "qwen-code.daemon.session_restore.action": action,
        "qwen-code.daemon.session_restore.timeout_ms": sessionRestoreTimeoutMs,
        "qwen-code.daemon.session_restore.settlement_grace_ms": restoreSettlementGraceMs,
        "qwen-code.daemon.acp_channel.id": ci.id,
        "session.id": sessionId
      });
      void harness.reapPendingEmptyChannel(ci.harness, {
        ignoreRestoreId: sessionId
      });
    }, restoreSettlementGraceMs);
    timer.unref();
    ci.restoreSettlementTimers.set(sessionId, timer);
  }
  __name(armRestoreSettlementGrace, "armRestoreSettlementGrace");
  function armNewSessionSettlementGrace(ci, token, requestedSessionId) {
    if (ci.newSessionSettlementTimers.has(token)) return;
    const timer = setTimeout(() => {
      ci.newSessionSettlementTimers.delete(token);
      if (!ci.unsettledAbandonedNewSessions.has(token)) return;
      if (ci.harness.isDying || !harness.has(ci.harness)) return;
      ci.overdueAbandonedNewSessions.add(token);
      writeStderrLine(
        `qwen serve: abandoned newSession${requestedSessionId ? ` for ${JSON.stringify(requestedSessionId)}` : ""} has not settled ${newSessionSettlementGraceMs}ms after its deadline; refusing fresh sessions on channel ${ci.id} until it settles or drains`
      );
      telemetry.event("session.new.settlement_overdue", {
        "qwen-code.daemon.session_new.timeout_ms": initTimeoutMs,
        "qwen-code.daemon.session_new.settlement_grace_ms": newSessionSettlementGraceMs,
        "qwen-code.daemon.acp_channel.id": ci.id,
        ...requestedSessionId ? { "session.id": requestedSessionId } : {}
      });
      void harness.reapPendingEmptyChannel(ci.harness);
    }, newSessionSettlementGraceMs);
    timer.unref();
    ci.newSessionSettlementTimers.set(token, timer);
  }
  __name(armNewSessionSettlementGrace, "armNewSessionSettlementGrace");
  async function withEnsuredWorkspaceControl(fn) {
    harness.reserveRuntimeOperation();
    try {
      const ci = getChannelInfo(await harness.ensure());
      return await harness.withWorkspaceControl(ci.harness, () => fn(ci));
    } finally {
      await harness.releaseRuntimeOperationReservation("workspace control");
    }
  }
  __name(withEnsuredWorkspaceControl, "withEnsuredWorkspaceControl");
  function withWorkspaceStatusRead(ci, fn) {
    return harness.withWorkspaceControl(ci.harness, fn, false);
  }
  __name(withWorkspaceStatusRead, "withWorkspaceStatusRead");
  function startSessionReaper() {
    if (sessionReapIntervalMs <= 0) return;
    writeStderrLine(
      `qwen serve: session reaper started (interval ${sessionReapIntervalMs}ms, idle threshold ${sessionIdleTimeoutMs}ms)`
    );
    sessionReaper = setInterval(() => {
      if (shuttingDown) return;
      const now = Date.now();
      for (const [id, entry] of byId) {
        if (sessionIdleTimeoutMs <= 0) break;
        if (!entryIsAutoCloseCandidate(entry)) continue;
        const lastActive = entry.sessionLastSeenAt ?? Date.parse(entry.createdAt);
        const idle = now - lastActive;
        if (idle < sessionIdleTimeoutMs) continue;
        writeStderrLine(
          `qwen serve: reaping idle session ${JSON.stringify(id)} (idle for ${Math.round(idle / 1e3)}s, threshold ${Math.round(sessionIdleTimeoutMs / 1e3)}s)`
        );
        void closeIfChildUnheld(entry, {
          trigger: "idle_timeout",
          closeReason: "idle_timeout"
        });
      }
    }, sessionReapIntervalMs);
    sessionReaper.unref();
  }
  __name(startSessionReaper, "startSessionReaper");
  function stopSessionReaper() {
    if (sessionReaper !== void 0) {
      clearInterval(sessionReaper);
      sessionReaper = void 0;
    }
  }
  __name(stopSessionReaper, "stopSessionReaper");
  const byId = /* @__PURE__ */ new Map();
  const forwardRunningPromptCancel = /* @__PURE__ */ __name(async (entry, pending, notification) => {
    if (pending.cancelForwardInitial) {
      return pending.cancelForwardInitial;
    }
    const initial = (async () => {
      try {
        const extension = entry.connection.extMethod(PROMPT_CANCEL_METHOD, notification).then((result2) => ({ kind: "result", result: result2 }));
        const outcome = await Promise.race([
          extension,
          getTransportClosedReject(entry),
          ...pending.cancelForwardDeadline ? [
            pending.cancelForwardDeadline.then(() => ({
              kind: "deadline"
            }))
          ] : []
        ]);
        if (outcome.kind === "deadline") return;
        const { result } = outcome;
        if (typeof result["cancelled"] !== "boolean") {
          throw new Error(
            `${PROMPT_CANCEL_METHOD} returned an invalid acknowledgement`
          );
        }
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === -32601 || isNotCurrentlyGeneratingCancelError(error)) {
          await Promise.race([
            entry.connection.cancel(notification),
            getTransportClosedReject(entry),
            ...pending.cancelForwardDeadline ? [pending.cancelForwardDeadline] : []
          ]);
          return;
        }
        throw error;
      }
    })().catch((error) => {
      if (pending.cancelForwardInitial === initial) {
        delete pending.cancelForwardInitial;
      }
      throw error;
    });
    pending.cancelForwardInitial = initial;
    pending.cancelForwardDrain = initial;
    void initial.catch(() => {
    });
    return initial;
  }, "forwardRunningPromptCancel");
  const generationRequests = /* @__PURE__ */ new Map();
  const workspaceGenerationRequests = /* @__PURE__ */ new Map();
  const inFlightExtensionRefreshes = /* @__PURE__ */ new Map();
  const clearInFlightExtensionRefreshes = /* @__PURE__ */ __name((connection) => {
    for (const [sessionId, refresh] of inFlightExtensionRefreshes) {
      if (refresh.connection === connection) {
        refresh.rejectUnavailable();
        inFlightExtensionRefreshes.delete(sessionId);
      }
    }
  }, "clearInFlightExtensionRefreshes");
  const toSessionSummary = /* @__PURE__ */ __name((entry) => {
    let isWaitingForPermission = false;
    let isWaitingForUserQuestion = false;
    for (const interaction of entry.pendingInteractions.values()) {
      if (interaction.kind === "user_question") {
        isWaitingForUserQuestion = true;
      } else {
        isWaitingForPermission = true;
      }
    }
    return {
      sessionId: entry.sessionId,
      workspaceCwd: entry.workspaceCwd,
      createdAt: entry.createdAt,
      ...entry.lastTurnEndedAtMs !== void 0 ? { updatedAt: new Date(entry.lastTurnEndedAtMs).toISOString() } : {},
      displayName: entry.displayName,
      ...entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {},
      ...entry.sourceType ? { sourceType: entry.sourceType } : {},
      ...entry.sourceId !== void 0 ? { sourceId: entry.sourceId } : {},
      clientCount: entry.clientIds.size,
      hasActivePrompt: hasInFlightPromptActivity(entry),
      activeWorkState: entryActiveWorkState(entry),
      hasRunningBackgroundTasks: entry.hasRunningBackgroundTasks,
      ...entry.backgroundTurn ? { backgroundTurn: entry.backgroundTurn } : {},
      isWaitingForPermission,
      isWaitingForUserQuestion,
      pendingInteractionCount: entry.pendingInteractions.size,
      hasTurnError: entry.turnError !== void 0,
      ...entry.turnError !== void 0 ? { turnError: entry.turnError } : {},
      pendingInteractions: [...entry.pendingInteractions.values()],
      ...entry.worktree ? { worktree: entry.worktree } : {},
      ...entry.branch ? { branch: entry.branch } : {},
      ...entry.prs && entry.prs.length > 0 ? { prs: entry.prs } : {}
    };
  }, "toSessionSummary");
  const permissionConsensusQuorum = opts.permissionConsensusQuorum;
  if (permissionConsensusQuorum !== void 0 && (!Number.isInteger(permissionConsensusQuorum) || permissionConsensusQuorum < 1)) {
    throw new Error(
      `BridgeOptions.permissionConsensusQuorum must be a positive integer; got ${String(permissionConsensusQuorum)}`
    );
  }
  const permissionAudit = opts.permissionAudit ?? createNoOpPermissionAuditPublisher();
  const permissionMediator = new MultiClientPermissionMediator(
    opts.permissionPolicy ?? "first-responder",
    {
      emit: /* @__PURE__ */ __name((sessionId, event) => {
        const sessionEntry = byId.get(sessionId);
        sessionEntry?.events.publish(event);
      }, "emit"),
      audit: permissionAudit,
      ...permissionConsensusQuorum !== void 0 ? { consensusQuorum: permissionConsensusQuorum } : {},
      now: /* @__PURE__ */ __name(() => Date.now(), "now"),
      votersForSession: /* @__PURE__ */ __name((sessionId) => {
        const sessionEntry = byId.get(sessionId);
        if (!sessionEntry) return /* @__PURE__ */ new Set();
        return new Set(sessionEntry.clientIds.keys());
      }, "votersForSession")
    }
  );
  let shuttingDown = false;
  let shutdownPromise;
  const teeServeDebugLine = /* @__PURE__ */ __name((message) => {
    writeServeDebugLine(message);
    if (opts.onDiagnosticLine && isServeDebugLoggingEnabled()) {
      opts.onDiagnosticLine(`qwen serve debug: ${message}`, "info");
    }
  }, "teeServeDebugLine");
  const inFlightSpawns = /* @__PURE__ */ new Map();
  const abandonedNewSessionSettlements = /* @__PURE__ */ new Set();
  const inFlightSessionIdReservations = /* @__PURE__ */ new Map();
  const abandonedSessionIdReservations = /* @__PURE__ */ new Set();
  const inFlightRestores = /* @__PURE__ */ new Map();
  const resetPendingSessions = /* @__PURE__ */ new Set();
  function assertSessionResetNotPending(sessionId) {
    if (resetPendingSessions.has(sessionId)) {
      throw new SessionResetPendingError(sessionId);
    }
  }
  __name(assertSessionResetNotPending, "assertSessionResetNotPending");
  const pendingRestoreEvents = /* @__PURE__ */ new Map();
  const journalSessionLimits = /* @__PURE__ */ __name(() => {
    const limits = [...byId.values()].map((entry) => ({
      limitBytes: entry.events.journalLimitBytes() ?? maxJournalBytes,
      baselineBytes: maxJournalBytes
    }));
    for (const [restoreId, bus] of pendingRestoreEvents) {
      if (!byId.has(restoreId)) {
        limits.push({
          limitBytes: bus.journalLimitBytes() ?? maxJournalBytes,
          baselineBytes: maxJournalBytes
        });
      }
    }
    return limits;
  }, "journalSessionLimits");
  const unregisterJournalGrowthSessionLimits = journalGrowthPolicy !== void 0 && opts.registerJournalGrowthSessionLimits !== void 0 ? opts.registerJournalGrowthSessionLimits(journalSessionLimits) : void 0;
  const createClientId = /* @__PURE__ */ __name(() => `client_${randomUUID3()}`, "createClientId");
  const registerClient = /* @__PURE__ */ __name((entry, requestedClientId) => {
    if (requestedClientId && entry.clientIds.has(requestedClientId)) {
      entry.clientIds.set(
        requestedClientId,
        (entry.clientIds.get(requestedClientId) ?? 0) + 1
      );
      return requestedClientId;
    }
    const clientId = createClientId();
    entry.clientIds.set(clientId, 1);
    return clientId;
  }, "registerClient");
  const unregisterClient = /* @__PURE__ */ __name((entry, clientId) => {
    if (clientId === void 0) return;
    const count = entry.clientIds.get(clientId);
    if (count === void 0) return;
    if (count <= 1) {
      entry.clientIds.delete(clientId);
      entry.clientLastSeenAt.delete(clientId);
    } else {
      entry.clientIds.set(clientId, count - 1);
    }
  }, "unregisterClient");
  const recordAttachRef = /* @__PURE__ */ __name((entry, clientId) => {
    entry.attachRefs.set(clientId, (entry.attachRefs.get(clientId) ?? 0) + 1);
  }, "recordAttachRef");
  const releaseAttachRef = /* @__PURE__ */ __name((entry, clientId) => {
    const refs = entry.attachRefs.get(clientId);
    if (refs === void 0 || refs <= 0) return false;
    if (refs === 1) {
      entry.attachRefs.delete(clientId);
    } else {
      entry.attachRefs.set(clientId, refs - 1);
    }
    return true;
  }, "releaseAttachRef");
  const rollbackAttachRegistration = /* @__PURE__ */ __name(async (entry, clientId, attachCountDelta = 1) => {
    const released = releaseAttachRef(entry, clientId) ? 1 : 0;
    entry.attachCount = Math.max(
      0,
      entry.attachCount - (released + (attachCountDelta - 1))
    );
    unregisterClient(entry, clientId);
    await maybeCloseIdleSession(entry, "attach_rollback");
  }, "rollbackAttachRegistration");
  const resolveTrustedClientId = /* @__PURE__ */ __name((entry, clientId) => {
    if (clientId === void 0) return void 0;
    if (!entry.clientIds.has(clientId)) {
      throw new InvalidClientIdError(entry.sessionId, clientId);
    }
    return clientId;
  }, "resolveTrustedClientId");
  function constructChannelInfo(channel, acpChannelId) {
    const sessionIds = /* @__PURE__ */ new Set();
    const infoRef = {};
    const client = new BridgeClient(
      // BfFut: ACP today carries a sessionId on every per-session
      // notification / request, so the no-sessionId branch is
      // technically unreachable. But the channel is multi-session
      // (Stage 1.5 multiplex), so if ACP ever grows a no-sessionId
      // call we'd silently drop it on a multi-session channel
      // instead of throwing. Surface that ambiguity loudly.
      (sessionId) => {
        if (sessionId) return byId.get(sessionId);
        if (currentChannelInfo() && currentChannelInfo().sessionIds.size > 1) {
          throw new Error(
            "BridgeClient: ACP call without sessionId on a multi-session channel cannot be routed \u2014 workspace=" + boundWorkspace
          );
        }
        return void 0;
      },
      (sessionId) => sessionId ? pendingRestoreEvents.get(sessionId) : void 0,
      permissionMediator,
      permissionTimeoutMs,
      maxPendingPerSession,
      // Forward the optional `BridgeFileSystem` injection so
      // production `qwen serve` can wire the `WorkspaceFileSystem`
      // adapter into BridgeClient's fs proxy methods. Tests + Mode A
      // consumers + channels / IDE companion omit it; BridgeClient
      // falls back to its inline fs proxy.
      opts.fileSystem,
      // §2.3: centralised model_switched publish — keeps cache + generation
      // update atomic. BridgeClient calls this instead of inlining publish.
      (entry, modelId, originator) => publishModelSwitched(entry, modelId, originator),
      // A2: centralised approval_mode_changed publish on in-session mode
      // promotion. `previous` is read from the bridge state cache.
      (entry, modeId, originator, planExecutionMode) => {
        const se = entry;
        publishApprovalModeChanged(
          se,
          {
            previous: se.currentApprovalMode ?? "default",
            next: modeId,
            persisted: false,
            planExecutionMode
          },
          originator
        );
      },
      // Reverse tool channel (issue #5626, Phase 2): forward the optional
      // client-hosted-MCP sender lookup so `BridgeClient.extMethod` can
      // answer `qwen/control/client_mcp/message` from the child by reaching
      // the per-WS-connection `ClientMcpRegistrar`. Omitted callers (tests,
      // Mode A) never host a client MCP server, so the method stays
      // unreachable.
      opts.clientMcpSender,
      (sessionId) => sessionIds.has(sessionId),
      // Daemon token-burn accounting: forward per-round token usage observed
      // at the session/update fan-in to the daemon host's metrics ring via
      // the telemetry seam. Optional-chained so non-daemon callers (tests,
      // Mode A) that wire no `tokenUsage` metric are a silent no-op.
      (inputTokens, outputTokens, durationMs, apiErrors, apiRetries) => telemetry.metrics?.tokenUsage?.(
        inputTokens,
        outputTokens,
        durationMs,
        apiErrors,
        apiRetries
      ),
      // `create_sub_session` tool: forward the request/response hook so a child
      // tool can ask the daemon to spawn a sub-session and (for 'first-turn')
      // return its result. Omitted → the method reports daemon-only.
      opts.onCreateSubSession,
      (sessionId, event) => {
        const request = generationRequests.get(event.requestId);
        if (!request || request.sessionId !== sessionId) return;
        if (request.queue.push(event)) return;
        request.settled = true;
        generationRequests.delete(event.requestId);
        request.queue.fail(new Error("Generation stream consumer too slow"));
        void request.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionGenerationCancel, {
          sessionId,
          requestId: event.requestId
        }).catch(() => void 0);
      },
      (event) => {
        const request = workspaceGenerationRequests.get(event.requestId);
        if (!request) return;
        if (request.queue.push(event)) return;
        request.settled = true;
        workspaceGenerationRequests.delete(event.requestId);
        request.queue.fail(new Error("Generation stream consumer too slow"));
        void request.connection?.extMethod(SERVE_CONTROL_EXT_METHODS.workspaceGenerationCancel, {
          requestId: event.requestId
        }).catch(() => void 0);
      },
      opts.onChannelDelivery,
      () => currentChannelInfo()?.sessionIds === sessionIds && currentChannelInfo().sessionSpawnsInFlight > 0,
      () => liveScreenContextCaptureHandler,
      () => liveTaskToolRequestHandler,
      () => liveSpeakToUserHandler,
      opts.externalToolGuard,
      (snapshot) => {
        const currentInfo = infoRef.current;
        if (!currentInfo) return;
        applyActiveWorkSnapshot(currentInfo, snapshot);
      },
      // Child-side automatic title updates change persisted catalog
      // metadata the bridge never sees; forward the catalog-clock mark.
      markSessionCatalogChanged,
      // A Goal turn drains the mid-turn queue but owns no prompt slot, so
      // nothing else would settle what its last drain missed.
      settleMidTurnQueueAfterAutomaticTurn,
      opts.onCreateCurrentSessionScheduledTask,
      async (sessionId, turn, afterPromptId) => {
        const entry = byId.get(sessionId);
        if (!entry || entry.closing || resetPendingSessions.has(sessionId) || entry.backgroundStartsSuspended || entry.goalTurnActive)
          return false;
        if (entry.backgroundTurn)
          return entry.backgroundTurn.turnId === turn.turnId;
        const epoch = entry.backgroundAdmissionEpoch;
        const preceding = entry.activePromptTerminal;
        if (entry.promptActive && preceding?.promptId !== afterPromptId)
          return false;
        if (preceding && preceding.promptId === afterPromptId)
          await preceding.promise;
        if (byId.get(sessionId) !== entry || entry.closing || resetPendingSessions.has(sessionId) || entry.backgroundAdmissionEpoch !== epoch || entry.backgroundTurn || entry.goalTurnActive || entry.pendingPromptList.some((p) => !p.terminalPublished))
          return false;
        entry.backgroundTurn = turn;
        delete entry.cancelBroadcastWithoutPrompt;
        clearPromptSettledClose(entry);
        entry.sessionLastSeenAt = Date.now();
        touchActivity();
        return true;
      }
    );
    const connection = harness.createConnection(client, channel);
    const physical = {
      id: acpChannelId,
      lastUsedAt: Date.now(),
      channel,
      connection,
      workspaceControlInFlight: 0,
      retireWhenSessionsDrain: false,
      emptyReapPending: false,
      transportFailed: false,
      transportFailureInitiatedTeardown: false,
      isDying: false,
      handshakeComplete: false
    };
    const info = {
      harness: physical,
      id: acpChannelId,
      channel,
      connection,
      client,
      sessionIds,
      pendingRestoreIds: /* @__PURE__ */ new Set(),
      sessionSpawnsInFlight: 0,
      workspaceMcpDiscoveryInFlight: false,
      workspaceMcpDiscoveryRequested: false,
      workspaceMcpAuthenticationServerNames: /* @__PURE__ */ new Set(),
      workspaceMcpAuthenticationTimers: /* @__PURE__ */ new Map(),
      workspaceMcpAuthenticationReleases: /* @__PURE__ */ new Map(),
      unsettledAbandonedRestores: /* @__PURE__ */ new Set(),
      overdueAbandonedRestores: /* @__PURE__ */ new Set(),
      restoreSettlementTimers: /* @__PURE__ */ new Map(),
      unsettledAbandonedNewSessions: /* @__PURE__ */ new Set(),
      overdueAbandonedNewSessions: /* @__PURE__ */ new Set(),
      newSessionSettlementTimers: /* @__PURE__ */ new Map(),
      newSessionCleanupFailed: false,
      isQuarantined: false
    };
    infoRef.current = info;
    sessionChannels.set(physical, info);
    return physical;
  }
  __name(constructChannelInfo, "constructChannelInfo");
  function beforeChannelExit(info) {
    if (info.workspaceMcpDiscoveryTimer) {
      clearTimeout(info.workspaceMcpDiscoveryTimer);
      info.workspaceMcpDiscoveryTimer = void 0;
    }
    for (const timer of info.workspaceMcpAuthenticationTimers.values()) {
      clearTimeout(timer);
    }
    info.workspaceMcpAuthenticationTimers.clear();
    info.workspaceMcpAuthenticationServerNames.clear();
    for (const release of info.workspaceMcpAuthenticationReleases.values()) {
      release();
    }
    info.workspaceMcpAuthenticationReleases.clear();
    for (const timer of info.restoreSettlementTimers.values()) {
      clearTimeout(timer);
    }
    info.restoreSettlementTimers.clear();
    for (const timer of info.newSessionSettlementTimers.values()) {
      clearTimeout(timer);
    }
    info.newSessionSettlementTimers.clear();
  }
  __name(beforeChannelExit, "beforeChannelExit");
  function handleChannelExit(info, exitInfo) {
    const sessions = Array.from(info.sessionIds);
    info.sessionIds.clear();
    const channelExitExpected = shuttingDown || info.harness.isDying && !info.harness.transportFailureInitiatedTeardown;
    if (info.harness.handshakeComplete) {
      telemetry.metrics?.channelLifecycle("exit", channelExitExpected);
    }
    if (!shuttingDown) {
      telemetry.event("channel.exited", {
        "qwen-code.daemon.channel.exit_code": exitInfo?.exitCode ?? -1,
        "qwen-code.daemon.channel.session_count": sessions.length,
        "qwen-code.daemon.channel.transport_failed": info.harness.transportFailed,
        "qwen-code.daemon.channel.transport_failure_initiated_teardown": info.harness.transportFailureInitiatedTeardown,
        ...info.harness.transportFailureCode ? {
          "qwen-code.daemon.channel.transport_error_code": info.harness.transportFailureCode
        } : {},
        ...info.harness.transportFailureDetail ? {
          "qwen-code.daemon.channel.transport_error_detail": info.harness.transportFailureDetail
        } : {},
        ...exitInfo?.signalCode ? { "qwen-code.daemon.channel.signal": exitInfo.signalCode } : {}
      });
      writeStderrLine(
        `qwen serve: channel exited (code=${exitInfo?.exitCode ?? "none"}, signal=${exitInfo?.signalCode ?? "none"}, transport=${info.harness.transportFailed ? info.harness.transportFailureCode ?? "failed" : "ok"}${info.harness.transportFailureDetail ? `, transport_detail=${info.harness.transportFailureDetail}` : ""}, ${sessions.length} session(s) torn down)`
      );
    }
    for (const sid of sessions) {
      const sessEntry = byId.get(sid);
      if (!sessEntry) continue;
      cancelPendingForSession(sid);
      flushPromptTerminals(
        sessEntry,
        "channel_closed",
        "agent channel exited before the prompt completed"
      );
      try {
        sessEntry.events.publish({
          type: "session_died",
          data: {
            sessionId: sid,
            reason: "channel_closed",
            // BX9_P: thread exitCode/signalCode through.
            exitCode: exitInfo?.exitCode ?? null,
            signalCode: exitInfo?.signalCode ?? null
          }
        });
      } catch {
      }
      if (sessEntry.promptActive) {
        sessEntry.promptActive = false;
        activePromptCounter--;
        touchActivity();
      }
      byId.delete(sid);
      void sessEntry.attachments.close().catch((error) => {
        writeStderrLine(
          `qwen serve: failed to close attachments for closed channel session ${JSON.stringify(sid)}: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      telemetry.metrics?.sessionLifecycle("die");
      emitSessionLifecycle({
        type: "removed",
        sessionId: sid,
        workspaceCwd: sessEntry.workspaceCwd,
        reason: "channel_closed"
      });
      info.client.markSessionClosed(sid);
      if (defaultEntry === sessEntry) defaultEntry = void 0;
      sessEntry.events.close();
    }
  }
  __name(handleChannelExit, "handleChannelExit");
  function handleChannelTransportUnavailable(info) {
    clearInFlightExtensionRefreshes(info.connection);
  }
  __name(handleChannelTransportUnavailable, "handleChannelTransportUnavailable");
  const harness = createHarness({
    channelFactory,
    boundWorkspace,
    childEnvOverrides,
    initTimeoutMs,
    telemetry,
    initialRuntimeEpoch,
    runtimeEpochSource,
    delegateReadTextFileToClient,
    isExternalToolGuardRequired: /* @__PURE__ */ __name(() => !!opts.externalToolGuard, "isExternalToolGuardRequired"),
    isShuttingDown: /* @__PURE__ */ __name(() => shuttingDown, "isShuttingDown"),
    constructHarnessChannel: constructChannelInfo,
    handleChannelTransportUnavailable: /* @__PURE__ */ __name((channel) => handleChannelTransportUnavailable(getChannelInfo(channel)), "handleChannelTransportUnavailable"),
    beforeChannelExit: /* @__PURE__ */ __name((channel) => beforeChannelExit(getChannelInfo(channel)), "beforeChannelExit"),
    handleChannelExit: /* @__PURE__ */ __name((channel, exitInfo) => handleChannelExit(getChannelInfo(channel), exitInfo), "handleChannelExit"),
    sessionCount: /* @__PURE__ */ __name((channel) => getChannelInfo(channel).sessionIds.size, "sessionCount"),
    hasNoSessionWork: /* @__PURE__ */ __name((channel, exclusions) => hasNoSessionWork(getChannelInfo(channel), exclusions), "hasNoSessionWork"),
    hasNoWorkspaceWork: /* @__PURE__ */ __name((channel) => {
      const info = getChannelInfo(channel);
      return !info.workspaceMcpDiscoveryInFlight && info.workspaceMcpAuthenticationServerNames.size === 0;
    }, "hasNoWorkspaceWork"),
    channelShouldReapWhenIdle: /* @__PURE__ */ __name((channel) => channelShouldReapWhenIdle(getChannelInfo(channel)), "channelShouldReapWhenIdle"),
    getChannelIdleTimeoutMs: /* @__PURE__ */ __name(() => opts.channelIdleTimeoutMs, "getChannelIdleTimeoutMs")
  });
  function recordNewSessionPublicTimeout(ci, requestedSessionId) {
    const channelWasEmpty = harness.hasNoChannelWork(ci.harness, {
      ignoreCurrentSessionSpawn: true
    });
    telemetry.event("session.new.public_result", {
      "qwen-code.daemon.session_new.result": "timeout",
      "qwen-code.daemon.session_new.timeout_ms": initTimeoutMs,
      "qwen-code.daemon.acp_channel.id": ci.id,
      "qwen-code.daemon.session_new.channel_was_empty": channelWasEmpty,
      ...requestedSessionId ? { "session.id": requestedSessionId } : {}
    });
    writeStderrLine(
      `qwen serve: newSession timed out after ${initTimeoutMs}ms${requestedSessionId ? ` for ${JSON.stringify(requestedSessionId)}` : ""} on channel ${ci.id}; decision=${channelWasEmpty ? "kill_empty" : "fence_shared"}`
    );
    return channelWasEmpty;
  }
  __name(recordNewSessionPublicTimeout, "recordNewSessionPublicTimeout");
  async function settleAbandonedNewSession(ci, token, lateSessionId, requestedSessionId) {
    telemetry.event("session.new.late_result", {
      "qwen-code.daemon.session_new.result": lateSessionId ? "success" : "failure",
      "qwen-code.daemon.session_new.timeout_ms": initTimeoutMs,
      "qwen-code.daemon.acp_channel.id": ci.id,
      ...lateSessionId ? { "session.id": lateSessionId } : requestedSessionId ? { "session.id": requestedSessionId } : {}
    });
    let cleanupReservation;
    let resolveCleanupReservation;
    try {
      if (!lateSessionId) return;
      while (!byId.has(lateSessionId)) {
        const restoreOwner = inFlightRestores.get(lateSessionId);
        if (restoreOwner) {
          await restoreOwner.settlementPromise.catch(() => void 0);
          continue;
        }
        const spawnOwner = inFlightSessionIdReservations.get(lateSessionId);
        if (spawnOwner && lateSessionId !== requestedSessionId) {
          await spawnOwner.settlementPromise;
          continue;
        }
        if (!spawnOwner) {
          cleanupReservation = Symbol(lateSessionId);
          const cleanupSettlement = new Promise((resolve2) => {
            resolveCleanupReservation = resolve2;
          });
          inFlightSessionIdReservations.set(lateSessionId, {
            token: cleanupReservation,
            settlementPromise: cleanupSettlement
          });
          abandonedSessionIdReservations.add(cleanupReservation);
        }
        break;
      }
      if (byId.has(lateSessionId)) {
        writeStderrLine(
          `qwen serve: skipping abandoned newSession cleanup for ${JSON.stringify(lateSessionId)}: the id is owned by a live session`
        );
        telemetry.event("session.new.cleanup", {
          "qwen-code.daemon.session_new.cleanup_result": "id_reclaimed",
          "qwen-code.daemon.session_new.timeout_ms": initTimeoutMs,
          "qwen-code.daemon.acp_channel.id": ci.id,
          "session.id": lateSessionId
        });
        return;
      }
      if (ci.harness.isDying || !harness.has(ci.harness)) {
        await ci.channel.exited;
        telemetry.event("session.new.cleanup", {
          "qwen-code.daemon.session_new.cleanup_result": "transport_closed",
          "qwen-code.daemon.session_new.timeout_ms": initTimeoutMs,
          "qwen-code.daemon.acp_channel.id": ci.id,
          "session.id": lateSessionId
        });
        return;
      }
      try {
        const closeResult = await Promise.race([
          withTimeout(
            ci.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionClose, {
              sessionId: lateSessionId,
              drainTimeoutMs: sessionCloseDrainBudgetMs(initTimeoutMs)
            }),
            initTimeoutMs,
            "abandonedNewSessionClose"
          ),
          getChannelClosedReject(ci)
        ]);
        if (!isRecord7(closeResult) || closeResult["closed"] !== true) {
          throw new Error("ACP child refused abandoned newSession cleanup");
        }
        telemetry.event("session.new.cleanup", {
          "qwen-code.daemon.session_new.cleanup_result": "closed",
          "qwen-code.daemon.session_new.timeout_ms": initTimeoutMs,
          "qwen-code.daemon.acp_channel.id": ci.id,
          "session.id": lateSessionId
        });
      } catch (error) {
        if (isAcpSessionResourceNotFound(error, lateSessionId)) {
          telemetry.event("session.new.cleanup", {
            "qwen-code.daemon.session_new.cleanup_result": "not_found",
            "qwen-code.daemon.session_new.timeout_ms": initTimeoutMs,
            "qwen-code.daemon.acp_channel.id": ci.id,
            "session.id": lateSessionId
          });
          return;
        }
        if (ci.harness.isDying || !harness.has(ci.harness)) {
          await ci.channel.exited;
          telemetry.event("session.new.cleanup", {
            "qwen-code.daemon.session_new.cleanup_result": "transport_closed",
            "qwen-code.daemon.session_new.timeout_ms": initTimeoutMs,
            "qwen-code.daemon.acp_channel.id": ci.id,
            "session.id": lateSessionId
          });
          return;
        }
        ci.newSessionCleanupFailed = true;
        writeStderrLine(
          `qwen serve: quarantining ACP channel after timed-out newSession cleanup failed for ${JSON.stringify(lateSessionId)}: ${extractErrorMessage(error)}`
        );
        telemetry.event("session.new.cleanup", {
          "qwen-code.daemon.session_new.cleanup_result": "quarantined",
          "qwen-code.daemon.session_new.timeout_ms": initTimeoutMs,
          "qwen-code.daemon.acp_channel.id": ci.id,
          "session.id": lateSessionId
        });
        if (harness.hasNoChannelWork(ci.harness)) {
          void harness.killChannelWithLog(
            ci.harness,
            "abandoned newSession cleanup"
          );
        }
        await ci.channel.exited;
      } finally {
        ci.client.markSessionClosed(lateSessionId);
      }
    } finally {
      if (cleanupReservation !== void 0) {
        if (lateSessionId !== void 0 && inFlightSessionIdReservations.get(lateSessionId)?.token === cleanupReservation) {
          inFlightSessionIdReservations.delete(lateSessionId);
        }
        abandonedSessionIdReservations.delete(cleanupReservation);
        resolveCleanupReservation?.();
      }
      ci.unsettledAbandonedNewSessions.delete(token);
      ci.overdueAbandonedNewSessions.delete(token);
      const graceTimer = ci.newSessionSettlementTimers.get(token);
      if (graceTimer !== void 0) {
        clearTimeout(graceTimer);
        ci.newSessionSettlementTimers.delete(token);
      }
      void harness.reapPendingEmptyChannel(ci.harness);
    }
  }
  __name(settleAbandonedNewSession, "settleAbandonedNewSession");
  async function doSpawn(modelServiceId, effectiveScope, approvalMode, requestedClientId, onSessionRegistered, parentSessionId, sourceType, sourceId, worktree, branch, requestedSessionId, daemonOwnedStandaloneCreation = false, onNewSessionDispatch, onNewSessionAbandoned) {
    const channelPath = currentChannelInfo() && !currentChannelInfo().harness.isDying ? "reused" : harness.starting ? "joined" : "spawned_on_request";
    const ci = getChannelInfo(
      await telemetry.withSpan(
        "channel.wait",
        {
          "qwen-code.daemon.bridge.operation": "channel.wait",
          "qwen-code.daemon.channel.path": channelPath
        },
        harness.ensure
      )
    );
    if (ci.harness.isDying) {
      throw new BridgeChannelClosedError("before newSession");
    }
    ci.sessionSpawnsInFlight++;
    if (requestedSessionId !== void 0) {
      ci.client.markSessionRegistrationInFlight(requestedSessionId);
    }
    let sessionRegistered = false;
    let sessionRemovedDuringInitialization = false;
    let emptyFailureTeardownStarted = false;
    let initializedSessionId;
    const abandonedToken = Symbol(requestedSessionId ?? "newSession");
    let newSessionResp;
    try {
      try {
        newSessionResp = await telemetry.withSpan(
          "session.new",
          {
            "qwen-code.daemon.bridge.operation": "session.new",
            "qwen-code.daemon.session_scope": effectiveScope,
            "qwen-code.daemon.channel.path": channelPath,
            "qwen-code.daemon.acp_channel.id": ci.id
          },
          async () => {
            const request = telemetry.injectPromptContext({
              cwd: boundWorkspace,
              mcpServers: [],
              _meta: {
                ...sessionSourceRequestMeta(
                  sourceType,
                  sourceId,
                  daemonOwnedStandaloneCreation
                ),
                ...requestedSessionId ? {
                  [REQUESTED_SESSION_ID_META_KEY]: requestedSessionId
                } : {},
                [SESSION_INITIALIZATION_DEADLINE_META_KEY]: Date.now() + initTimeoutMs
              }
            });
            const newSessionRequest = harness.withWorktreeInitialization(
              request,
              !!worktree
            );
            onNewSessionDispatch?.();
            const rawNewSession = Promise.race([
              ci.connection.newSession(newSessionRequest),
              channelUnavailableReject(ci.channel, "during newSession")
            ]);
            const lifecycle = { phase: "active" };
            const response = await new Promise(
              (resolve2, reject) => {
                const timer = setTimeout(() => {
                  if (lifecycle.phase !== "active") return;
                  lifecycle.phase = "abandoned";
                  ci.unsettledAbandonedNewSessions.add(abandonedToken);
                  const settlement = new Promise((resolveSettlement) => {
                    lifecycle.resolveSettlement = resolveSettlement;
                  });
                  abandonedNewSessionSettlements.add(settlement);
                  void settlement.finally(() => {
                    abandonedNewSessionSettlements.delete(settlement);
                  });
                  onNewSessionAbandoned?.(settlement);
                  const channelWasEmpty = recordNewSessionPublicTimeout(
                    ci,
                    requestedSessionId
                  );
                  if (!channelWasEmpty) {
                    armNewSessionSettlementGrace(
                      ci,
                      abandonedToken,
                      requestedSessionId
                    );
                  }
                  reject(new BridgeTimeoutError("newSession", initTimeoutMs));
                }, initTimeoutMs);
                timer.unref();
                void rawNewSession.then(
                  (value) => {
                    if (lifecycle.phase === "active") {
                      clearTimeout(timer);
                      resolve2(value);
                      return;
                    }
                    void settleAbandonedNewSession(
                      ci,
                      abandonedToken,
                      value.sessionId,
                      requestedSessionId
                    ).then(
                      () => lifecycle.resolveSettlement?.(),
                      () => lifecycle.resolveSettlement?.()
                    );
                  },
                  (error) => {
                    if (lifecycle.phase === "active") {
                      clearTimeout(timer);
                      if (extractJsonRpcErrorField(error, "errorKind") === SESSION_INITIALIZATION_TIMEOUT_ERROR_KIND) {
                        recordNewSessionPublicTimeout(ci, requestedSessionId);
                        reject(
                          new BridgeTimeoutError("newSession", initTimeoutMs)
                        );
                      } else {
                        reject(error);
                      }
                      return;
                    }
                    void settleAbandonedNewSession(
                      ci,
                      abandonedToken,
                      void 0,
                      requestedSessionId
                    ).then(
                      () => lifecycle.resolveSettlement?.(),
                      () => lifecycle.resolveSettlement?.()
                    );
                  }
                );
              }
            );
            telemetry.event("session.new.completed", {
              "session.id": response.sessionId,
              "qwen-code.daemon.acp_channel.id": ci.id
            });
            return response;
          }
        );
      } catch (err) {
        if (harness.hasNoChannelWork(ci.harness, {
          ignoreCurrentSessionSpawn: true
        })) {
          emptyFailureTeardownStarted = true;
          void harness.killChannelWithLog(
            ci.harness,
            "empty newSession failure"
          );
        } else {
          ci.harness.emptyReapPending = true;
        }
        throw err;
      }
      await Promise.resolve();
      if (ci.harness.isDying) {
        throw new BridgeChannelClosedError("after newSession");
      }
      if (shuttingDown) {
        throw new Error("AcpSessionBridge is shutting down");
      }
      const entry = createSessionEntry(
        ci,
        newSessionResp.sessionId,
        boundWorkspace,
        void 0,
        { parentSessionId, sourceType, sourceId, worktree, branch }
      );
      initializedSessionId = entry.sessionId;
      sessionRegistered = true;
      onSessionRegistered?.();
      seedSnapshotCaches(entry, newSessionResp);
      const clientId = registerClient(entry, requestedClientId);
      let parentSessionPersisted;
      if (entry.parentSessionId) {
        const parentDeadline = Date.now() + initTimeoutMs;
        let lastParentErr;
        for (let attempt = 1; attempt <= MAX_PARENT_PERSIST_ATTEMPTS; attempt++) {
          const remaining = parentDeadline - Date.now();
          if (remaining <= 0) {
            parentSessionPersisted = false;
            lastParentErr = "deadline exceeded";
            break;
          }
          try {
            const parentResult = await Promise.race([
              withTimeout(
                entry.connection.extMethod(
                  SERVE_CONTROL_EXT_METHODS.sessionParent,
                  {
                    sessionId: entry.sessionId,
                    parentSessionId: entry.parentSessionId
                  }
                ),
                remaining,
                "sessionParent"
              ),
              getTransportClosedReject(entry)
            ]);
            parentSessionPersisted = parentResult?.persisted === true;
            break;
          } catch (err) {
            lastParentErr = err instanceof Error ? err.message : String(err);
            const terminal = err instanceof BridgeTimeoutError || err instanceof BridgeChannelClosedError || attempt === MAX_PARENT_PERSIST_ATTEMPTS;
            if (terminal) {
              parentSessionPersisted = false;
              break;
            }
          }
        }
        if (parentSessionPersisted === false) {
          writeStderrLine(
            `qwen serve: parentSessionId for ${entry.sessionId} was not persisted (${lastParentErr ?? "unknown"}) \u2014 the parent link is live-only until restart (reported to the caller via parentSessionPersisted=false)`
          );
        }
      }
      let sourcePersisted;
      if (entry.sourceType) {
        sourcePersisted = await persistSessionSource(
          entry,
          entry.sessionId,
          daemonOwnedStandaloneCreation
        );
      }
      let modelApplied;
      if (modelServiceId) {
        modelApplied = await applyModelServiceId(
          entry,
          modelServiceId,
          initTimeoutMs,
          clientId
        ).then(
          () => true,
          () => false
        );
      }
      if (approvalMode) {
        try {
          await applyApprovalMode(entry, approvalMode, false, clientId);
        } catch (err) {
          try {
            await closeSessionImpl(entry.sessionId, void 0, {
              reason: "approval_mode_initialization_failed"
            });
            sessionRemovedDuringInitialization = true;
          } catch {
          }
          throw err;
        }
      }
      if (!byId.has(entry.sessionId)) {
        throw new Error(
          `Session ${entry.sessionId} died during session initialization`
        );
      }
      if (effectiveScope === "single" && !defaultEntry) defaultEntry = entry;
      return {
        sessionId: entry.sessionId,
        workspaceCwd: entry.workspaceCwd,
        attached: false,
        clientId,
        createdAt: entry.createdAt,
        ...entry.sourceType ? { sourceType: entry.sourceType } : {},
        ...entry.sourceId !== void 0 ? { sourceId: entry.sourceId } : {},
        ...entry.sourceType ? { sourcePersisted: sourcePersisted === true } : {},
        ...entry.parentSessionId ? { parentSessionPersisted: parentSessionPersisted === true } : {},
        ...modelApplied !== void 0 ? { modelApplied } : {},
        ...entry.worktree ? { worktree: entry.worktree } : {},
        ...entry.branch ? { branch: entry.branch } : {}
      };
    } finally {
      if (requestedSessionId !== void 0) {
        ci.client.clearSessionRegistrationInFlight(requestedSessionId);
        if (initializedSessionId !== requestedSessionId && !byId.has(requestedSessionId)) {
          ci.client.markSessionClosed(requestedSessionId);
        }
      }
      ci.sessionSpawnsInFlight = Math.max(0, ci.sessionSpawnsInFlight - 1);
      if (!sessionRegistered) {
        if (!emptyFailureTeardownStarted) {
          await harness.reapPendingEmptyChannel(ci.harness);
        }
      } else if (sessionRemovedDuringInitialization && harness.hasNoChannelWork(ci.harness)) {
        await harness.reapPendingEmptyChannel(ci.harness);
        if (!ci.harness.isDying) {
          await harness.startIdleTimer(
            ci.harness,
            `approval-mode initialization failure "${initializedSessionId}"`
          );
        }
      } else if (sessionRegistered && harness.hasNoChannelWork(ci.harness) && !ci.harness.isDying) {
        await harness.startIdleTimer(
          ci.harness,
          `session orphaned during initialization "${initializedSessionId}"`
        );
      }
    }
  }
  __name(doSpawn, "doSpawn");
  async function applyModelServiceId(entry, modelId, timeoutMs, originatorClientId) {
    const conn = entry.connection;
    const transportClosed = getTransportClosedReject(entry);
    const work = entry.modelChangeQueue.then(async () => {
      entry.modelRoundtripInFlight = true;
      let succeeded = false;
      try {
        const persistDefault = !isScheduledTaskRunSource({
          sourceType: entry.sourceType,
          sourceId: entry.sourceId
        });
        const result = await Promise.race([
          withTimeout(
            conn.unstable_setSessionModel({
              sessionId: entry.sessionId,
              modelId,
              ...!persistDefault ? {
                _meta: {
                  [SESSION_MODEL_PERSIST_DEFAULT_META_KEY]: false
                }
              } : {}
            }),
            timeoutMs,
            "setSessionModel"
          ),
          transportClosed
        ]);
        publishModelSwitched(entry, modelId, originatorClientId);
        if (persistDefault && !isReservedStandaloneSessionSourceType(entry.sourceType)) {
          broadcastWorkspaceEvent({
            type: "settings_changed",
            data: {
              key: "model.name",
              value: getCanonicalModelId(result, modelId)
            },
            ...originatorClientId ? { originatorClientId } : {}
          });
        }
        succeeded = true;
      } catch (err) {
        entry.events.publish({
          type: "model_switch_failed",
          data: {
            sessionId: entry.sessionId,
            requestedModelId: modelId,
            error: extractErrorMessage(err)
          },
          ...originatorClientId ? { originatorClientId } : {}
        });
        throw err;
      } finally {
        entry.modelRoundtripInFlight = false;
        if (succeeded) {
          void reconcileAfterRoundtrip(entry, "model");
        } else {
          writeStderrLine(
            `[reconcile] session=${entry.sessionId} target=model action=skipped reason=roundtrip_failed`
          );
        }
      }
    });
    entry.modelChangeQueue = work.then(
      () => void 0,
      () => void 0
    );
    return work;
  }
  __name(applyModelServiceId, "applyModelServiceId");
  async function applyApprovalMode(entry, mode, persist, originatorClientId, planMode) {
    if (persist && !persistApprovalMode) {
      throw new Error(
        "setSessionApprovalMode called with `persist: true` but no `persistApprovalMode` callback wired in BridgeOptions. runQwenServe wires the production callback; direct embeds and tests must opt in or omit `persist`."
      );
    }
    const approvalWork = entry.approvalModeQueue.then(async () => {
      entry.approvalModeRoundtripInFlight = true;
      let succeeded = false;
      try {
        const response = await Promise.race([
          withTimeout(
            entry.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.sessionApprovalMode,
              {
                sessionId: entry.sessionId,
                mode,
                ...planMode !== void 0 ? { planMode } : {}
              }
            ),
            initTimeoutMs,
            SERVE_CONTROL_EXT_METHODS.sessionApprovalMode
          ),
          getTransportClosedReject(entry)
        ]);
        if (typeof response.current !== "string" || !KNOWN_APPROVAL_MODES.has(response.current)) {
          throw new Error(
            `Agent returned unknown approval mode: ${JSON.stringify(response.current)}`
          );
        }
        if (response.planExecutionMode !== void 0 && (response.planExecutionMode === "plan" || !KNOWN_APPROVAL_MODES.has(response.planExecutionMode))) {
          throw new Error("Agent returned an invalid plan execution mode");
        }
        const planExecutionMode = response.current === "plan" ? response.planExecutionMode : void 0;
        let persisted = false;
        if (persist) {
          try {
            await withTimeout(
              persistApprovalMode?.(boundWorkspace, mode) ?? Promise.resolve(),
              PERSIST_TIMEOUT_MS,
              "persistApprovalMode"
            );
            persisted = persistApprovalMode !== void 0;
          } catch (err) {
            writeStderrLine(
              `setSessionApprovalMode: persist failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        publishApprovalModeChanged(
          entry,
          {
            previous: response.previous,
            next: response.current,
            persisted,
            planExecutionMode
          },
          originatorClientId
        );
        if (persisted && planMode === void 0) {
          broadcastWorkspaceEvent(
            {
              type: "approval_mode_changed",
              data: {
                sessionId: entry.sessionId,
                previous: response.previous,
                next: response.current,
                persisted
              },
              ...originatorClientId ? { originatorClientId } : {}
            },
            entry.sessionId
          );
          for (const peer of byId.values()) {
            if (peer.sessionId === entry.sessionId) {
              continue;
            }
            peer.currentApprovalMode = response.current;
            peer.planExecutionMode = void 0;
          }
        }
        succeeded = true;
        return {
          sessionId: entry.sessionId,
          mode: response.current,
          previous: response.previous,
          persisted,
          ...planExecutionMode ? { planExecutionMode } : {}
        };
      } finally {
        entry.approvalModeRoundtripInFlight = false;
        if (succeeded) {
          void reconcileAfterRoundtrip(entry, "approvalMode");
        } else {
          writeStderrLine(
            `[reconcile] session=${entry.sessionId} target=approvalMode action=skipped reason=roundtrip_failed`
          );
        }
      }
    });
    entry.approvalModeQueue = approvalWork.then(
      () => void 0,
      () => void 0
    );
    try {
      return await approvalWork;
    } catch (err) {
      const data = err?.data;
      if (data && typeof data === "object" && "errorKind" in data && data.errorKind === "trust_gate") {
        const rawMessage = err?.message;
        const message = typeof rawMessage === "string" ? rawMessage : "Trust-gate rejection from ACP child";
        throw new TrustGateError(message);
      }
      throw err;
    }
  }
  __name(applyApprovalMode, "applyApprovalMode");
  async function applyApprovalModeForAttach(entry, mode, clientId) {
    try {
      const result = await applyApprovalMode(entry, mode, false, clientId);
      return result.previous;
    } catch (err) {
      await rollbackAttachRegistration(entry, clientId);
      throw err;
    }
  }
  __name(applyApprovalModeForAttach, "applyApprovalModeForAttach");
  async function rollbackApprovalModeForRejectedAttach(entry, previous, clientId) {
    if (byId.get(entry.sessionId) !== entry) return;
    try {
      await applyApprovalMode(entry, previous, false, clientId);
    } catch (err) {
      writeStderrLine(
        `attach: failed to restore approval mode for session ${entry.sessionId}: ${extractErrorMessage(err)}`
      );
    }
  }
  __name(rollbackApprovalModeForRejectedAttach, "rollbackApprovalModeForRejectedAttach");
  const cancelPendingForSession = /* @__PURE__ */ __name((sessionId) => {
    permissionMediator.forgetSession(sessionId);
    byId.get(sessionId)?.pendingPermissionIds.clear();
    byId.get(sessionId)?.pendingInteractions.clear();
  }, "cancelPendingForSession");
  const getTransportClosedReject = /* @__PURE__ */ __name((entry) => {
    if (!entry.transportClosedReject) {
      entry.transportClosedReject = channelUnavailableReject(
        entry.channel,
        `mid-request (session ${entry.sessionId})`
      );
    }
    return entry.transportClosedReject;
  }, "getTransportClosedReject");
  const resolveWorkspaceKey = /* @__PURE__ */ __name((rawWorkspaceCwd) => {
    const workspaceCwd = translateAndCheckAbsoluteWorkspacePath(rawWorkspaceCwd);
    if (workspaceCwd === null) {
      throw new Error(
        `workspaceCwd must be an absolute path; got "${rawWorkspaceCwd}"`
      );
    }
    const workspaceKey = workspaceCwd === boundWorkspace ? boundWorkspace : canonicalizeWorkspace(workspaceCwd);
    if (workspaceKey !== boundWorkspace) {
      throw new WorkspaceMismatchError(boundWorkspace, workspaceKey);
    }
    return workspaceKey;
  }, "resolveWorkspaceKey");
  const liveChannelInfo = /* @__PURE__ */ __name(() => {
    if (!currentChannelInfo() || currentChannelInfo().harness.isDying)
      return void 0;
    return currentChannelInfo();
  }, "liveChannelInfo");
  const channelInfoForEntry = /* @__PURE__ */ __name((entry) => {
    if (currentChannelInfo()?.channel === entry.channel)
      return currentChannelInfo();
    for (const info of channelInfos()) {
      if (info.channel === entry.channel) return info;
    }
    return void 0;
  }, "channelInfoForEntry");
  const assertAttachableSessionEntry = /* @__PURE__ */ __name((sessionId, entry) => {
    if (byId.get(sessionId) !== entry) {
      throw new SessionNotFoundError(
        sessionId,
        "The session channel is unavailable; retry after teardown completes"
      );
    }
    if (isClosingOrAuthorizingClose(entry)) {
      throw new SessionNotFoundError(
        sessionId,
        "The session is closing; retry after close completes",
        "session_closing"
      );
    }
    const owner = channelInfoForEntry(entry);
    if (!owner || owner.harness.isDying) {
      throw new SessionNotFoundError(
        sessionId,
        "The session channel is unavailable; retry after teardown completes"
      );
    }
  }, "assertAttachableSessionEntry");
  const assertLivePromptEntry = /* @__PURE__ */ __name((sessionId, entry) => {
    const info = channelInfoForEntry(entry);
    if (byId.get(sessionId) !== entry || !info || info.harness.isDying) {
      throw new SessionNotFoundError(sessionId);
    }
    return info;
  }, "assertLivePromptEntry");
  const getChannelClosedReject = /* @__PURE__ */ __name((info) => {
    if (!info.harness.statusClosedReject) {
      info.harness.statusClosedReject = channelUnavailableReject(
        info.channel,
        "mid-request (workspace status)"
      );
    }
    return info.harness.statusClosedReject;
  }, "getChannelClosedReject");
  const cacheWorkspaceMcpDetails = /* @__PURE__ */ __name(async (info, status) => {
    if (!Array.isArray(status.servers)) return;
    const serverNames = status.servers.flatMap(
      (server) => isRecord7(server) && typeof server["name"] === "string" && server["mcpStatus"] === "connected" ? [server["name"]] : []
    );
    const cacheDetail = /* @__PURE__ */ __name(async (serverName, method, cache) => {
      try {
        const result = await withTimeout(
          Promise.race([
            info.connection.extMethod(method, {
              serverName,
              cwd: boundWorkspace
            }),
            getChannelClosedReject(info)
          ]),
          initTimeoutMs,
          method
        );
        cache.set(serverName, result);
      } catch (error) {
        await harness.retireChannelOnTimeout(
          info.harness,
          error,
          `workspace MCP detail timeout for ${serverName}`
        );
      }
    }, "cacheDetail");
    await Promise.all(
      serverNames.flatMap((serverName) => [
        cacheDetail(
          serverName,
          SERVE_STATUS_EXT_METHODS.workspaceMcpTools,
          workspaceMcpToolsCache
        ),
        cacheDetail(
          serverName,
          SERVE_STATUS_EXT_METHODS.workspaceMcpResources,
          workspaceMcpResourcesCache
        )
      ])
    );
  }, "cacheWorkspaceMcpDetails");
  const mergeManagedWorkspaceMcpStatus = /* @__PURE__ */ __name((serverNames, previous, current) => {
    if (Array.isArray(current.servers) && previous?.discoveryState === "completed" && previous.runtimeEpoch === current.runtimeEpoch && current.discoveryState === "not_started") {
      if (current.servers.length === 0) {
        return {
          ...previous,
          runtimeEpoch: current.runtimeEpoch,
          source: current.source
        };
      }
      const currentServers = new Map(
        current.servers.map((server) => [server.name, server])
      );
      const previousNames = new Set(
        previous.servers.map((server) => server.name)
      );
      const servers = previous.servers.map(
        (server) => serverNames.has(server.name) ? currentServers.get(server.name) ?? server : server
      );
      for (const server of current.servers) {
        if (serverNames.has(server.name) && !previousNames.has(server.name)) {
          servers.push(server);
        }
      }
      return {
        ...previous,
        runtimeEpoch: current.runtimeEpoch,
        source: current.source,
        discoveryState: "completed",
        servers
      };
    }
    return current;
  }, "mergeManagedWorkspaceMcpStatus");
  const requestWorkspaceStatus = /* @__PURE__ */ __name(async (method, idle, params = {}, managedServerNames) => {
    const info = liveChannelInfo();
    if (!info) {
      if (method === SERVE_STATUS_EXT_METHODS.workspaceMcp && workspaceMcpStatusCache) {
        return {
          ...workspaceMcpStatusCache,
          source: "cache"
        };
      }
      return idle();
    }
    const requestRuntimeEpoch = harness.epoch;
    return await withWorkspaceStatusRead(info, async () => {
      let response = await withTimeout(
        Promise.race([
          info.connection.extMethod(method, {
            ...params,
            cwd: boundWorkspace
          }),
          getChannelClosedReject(info)
        ]),
        initTimeoutMs,
        method
      );
      if (isRecord7(response) && (method === SERVE_STATUS_EXT_METHODS.workspaceSkills || method === SERVE_STATUS_EXT_METHODS.workspaceMcp || method === SERVE_STATUS_EXT_METHODS.workspaceMcpTools || method === SERVE_STATUS_EXT_METHODS.workspaceMcpResources)) {
        response = {
          ...response,
          runtimeEpoch: requestRuntimeEpoch,
          ...method === SERVE_STATUS_EXT_METHODS.workspaceMcp ? { source: "live" } : {}
        };
      }
      if (method === SERVE_STATUS_EXT_METHODS.workspaceMcp) {
        const rawStatus = response;
        if (!Array.isArray(rawStatus.servers)) {
          return response;
        }
        const rawServers = rawStatus.servers;
        const effectiveManagedServerNames = /* @__PURE__ */ new Set([
          ...info.workspaceMcpAuthenticationServerNames,
          ...managedServerNames ?? []
        ]);
        if (effectiveManagedServerNames.size > 0) {
          response = mergeManagedWorkspaceMcpStatus(
            effectiveManagedServerNames,
            workspaceMcpStatusCache,
            rawStatus
          );
        }
        const status = response;
        if (status.discoveryState === "completed") {
          await cacheWorkspaceMcpDetails(
            info,
            effectiveManagedServerNames.size > 0 ? {
              servers: rawServers.filter(
                (server) => effectiveManagedServerNames.has(server.name)
              )
            } : status
          );
        }
        if (info.workspaceMcpDiscoveryInFlight && (status.discoveryState === "completed" || Array.isArray(status.errors) && status.errors.length > 0)) {
          finishWorkspaceMcpDiscovery(info);
        }
        if (status.discoveryState === "completed") {
          info.workspaceMcpDiscoveryRequested = true;
        } else if (status.discoveryState === "in_progress") {
          info.workspaceMcpDiscoveryRequested = true;
        } else if (Array.isArray(status.errors) && status.errors.length > 0) {
          info.workspaceMcpDiscoveryRequested = false;
        }
        for (const serverName of info.workspaceMcpAuthenticationServerNames) {
          const server = rawServers.find(
            (candidate) => candidate.name === serverName
          );
          if (server !== void 0 && server.authenticationState !== "pending") {
            info.workspaceMcpAuthenticationServerNames.delete(serverName);
            info.harness.lastUsedAt = Date.now();
            const timer = info.workspaceMcpAuthenticationTimers.get(serverName);
            if (timer) clearTimeout(timer);
            info.workspaceMcpAuthenticationTimers.delete(serverName);
            info.workspaceMcpAuthenticationReleases.get(serverName)?.();
            info.workspaceMcpAuthenticationReleases.delete(serverName);
          }
        }
        workspaceMcpStatusCache = response;
      }
      return response;
    });
  }, "requestWorkspaceStatus");
  const expireWorkspaceMcpAuthentication = /* @__PURE__ */ __name(async (info, serverName, timer) => {
    if (info.harness.isDying || liveChannelInfo() !== info || info.workspaceMcpAuthenticationTimers.get(serverName) !== timer) {
      return;
    }
    try {
      await requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceMcp,
        () => void 0,
        {},
        /* @__PURE__ */ new Set([serverName])
      );
    } catch {
    }
    if (info.harness.isDying || liveChannelInfo() !== info || info.workspaceMcpAuthenticationTimers.get(serverName) !== timer || !info.workspaceMcpAuthenticationServerNames.has(serverName)) {
      return;
    }
    await harness.retireChannelAfterSessionsDrain(
      info.harness,
      `workspace MCP authentication timeout for ${serverName}`
    );
  }, "expireWorkspaceMcpAuthentication");
  const MAX_CHILD_HEAP_UNCLASSIFIED_NAMES = 64;
  const MAX_CHILD_HEAP_SPACE_NAME_LENGTH = 64;
  const parseChildHeapReport = /* @__PURE__ */ __name((value) => {
    if (typeof value !== "object" || value === null) return void 0;
    const raw = value;
    const counts = [
      "peakOldGenerationBytes",
      "peakLiveSetBytes",
      "peakTotalHeapBytes",
      "majorGcCount",
      "majorGcMs"
    ];
    const parsed = {};
    for (const key of counts) {
      const n = raw[key];
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
        return void 0;
      }
      parsed[key] = n;
    }
    const names = raw["unclassifiedSpaceNames"];
    if (!Array.isArray(names) || names.length > MAX_CHILD_HEAP_UNCLASSIFIED_NAMES || names.some(
      (name) => typeof name !== "string" || name.length > MAX_CHILD_HEAP_SPACE_NAME_LENGTH
    )) {
      return void 0;
    }
    return {
      peakOldGenerationBytes: parsed["peakOldGenerationBytes"],
      peakLiveSetBytes: parsed["peakLiveSetBytes"],
      peakTotalHeapBytes: parsed["peakTotalHeapBytes"],
      majorGcCount: parsed["majorGcCount"],
      majorGcMs: parsed["majorGcMs"],
      unclassifiedSpaceNames: names
    };
  }, "parseChildHeapReport");
  const STALE_CHILD_RESOURCE_MS = 3e4;
  let childResourceRefreshing = false;
  const refreshChildResource = /* @__PURE__ */ __name(async () => {
    if (childResourceRefreshing) return;
    const info = liveChannelInfo();
    if (!info) return;
    childResourceRefreshing = true;
    try {
      const res = await requestWorkspaceStatus(SERVE_STATUS_EXT_METHODS.workspaceResource, () => ({}));
      if (liveChannelInfo() !== info) return;
      if (typeof res.rssBytes === "number" && Number.isFinite(res.rssBytes)) {
        info.harness.childRssBytes = res.rssBytes;
      }
      if (typeof res.cpuPercent === "number" && Number.isFinite(res.cpuPercent)) {
        info.harness.childCpuPercent = Math.min(
          100,
          Math.max(0, res.cpuPercent)
        );
      }
      const heap = parseChildHeapReport(res.heap);
      if (heap) info.harness.childHeap = heap;
      info.harness.childResourceAt = Date.now();
    } catch (err) {
      teeServeDebugLine(
        `child-resource refresh failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      childResourceRefreshing = false;
    }
  }, "refreshChildResource");
  const getChildResourceSnapshot = /* @__PURE__ */ __name(() => {
    const info = liveChannelInfo();
    if (!info || info.harness.childResourceAt === void 0) return void 0;
    const ageMs = Date.now() - info.harness.childResourceAt;
    if (ageMs > STALE_CHILD_RESOURCE_MS) {
      return void 0;
    }
    return {
      rssBytes: info.harness.childRssBytes ?? 0,
      cpuPercent: info.harness.childCpuPercent ?? 0,
      // Deliberately not defaulted. Unlike rss/cpu, where 0 is a plausible
      // reading, a zeroed heap report would assert the child needed no old
      // generation — the one conclusion that must never be manufactured.
      heap: info.harness.childHeap,
      // Bounded by the guard above, so a caller summing several children's
      // readings can say how far apart they were taken. Without it a sum of
      // readings up to `STALE_CHILD_RESOURCE_MS` apart looks instantaneous.
      ageMs
    };
  }, "getChildResourceSnapshot");
  const requestSessionStatus = /* @__PURE__ */ __name(async (sessionId, method, params = {}, timeoutMs = initTimeoutMs) => {
    const entry = byId.get(sessionId);
    if (!entry) throw new SessionNotFoundError(sessionId);
    const info = channelInfoForEntry(entry);
    if (!info || info.harness.isDying)
      throw new SessionNotFoundError(sessionId);
    const response = await Promise.race([
      withTimeout(
        entry.connection.extMethod(method, { ...params, sessionId }),
        timeoutMs,
        method
      ),
      getTransportClosedReject(entry)
    ]);
    return response;
  }, "requestSessionStatus");
  const requestSessionSources = /* @__PURE__ */ __name(async (sessionId, method, params = {}) => {
    const result = await requestSessionStatus(sessionId, method, params);
    if (result.sourceError) {
      throw new SessionSourceError(
        result.sourceError.code,
        result.sourceError.message
      );
    }
    return result;
  }, "requestSessionSources");
  const notifyAgentSessionClose = /* @__PURE__ */ __name(async (entry, ci, label, opts2) => {
    if (!ci || ci.channel !== entry.channel) {
      if (opts2?.throwOnFailure === true) {
        writeStderrLine(
          `qwen serve: ${label} ACP session close channel unavailable for session ${JSON.stringify(entry.sessionId)}; agent close skipped`
        );
        throw new Error(
          `ACP session close channel unavailable for ${entry.sessionId}`
        );
      }
      return false;
    }
    try {
      const closeRequest = entry.connection.extMethod(
        SERVE_CONTROL_EXT_METHODS.sessionClose,
        {
          sessionId: entry.sessionId,
          drainTimeoutMs: sessionCloseDrainBudgetMs(
            opts2?.timeoutMs ?? initTimeoutMs
          ),
          ...opts2?.requireFlush === true ? { requireFlush: true } : {}
        }
      );
      const observedCloseRequest = opts2?.timeoutMs ? withTimeout(closeRequest, opts2.timeoutMs, label) : closeRequest;
      const response = await Promise.race([
        opts2?.throwOnFailure === true ? observedCloseRequest : withTimeout(
          observedCloseRequest,
          initTimeoutMs,
          SERVE_CONTROL_EXT_METHODS.sessionClose
        ),
        getTransportClosedReject(entry)
      ]);
      return response["closed"] === true;
    } catch (err) {
      writeStderrLine(
        `qwen serve: ${label} ACP session close notification failed for session ${JSON.stringify(entry.sessionId)}: ${extractErrorMessage(
          err
        )}`
      );
      if (opts2?.throwOnFailure === true) {
        throw err;
      }
      return false;
    }
  }, "notifyAgentSessionClose");
  const broadcastWorkspaceEvent = /* @__PURE__ */ __name((envelope, skipSessionId) => {
    const sessions = Array.from(byId.values());
    let successCount = 0;
    let failureCount = 0;
    let skippedCount = 0;
    for (const entry of sessions) {
      if (skipSessionId !== void 0 && entry.sessionId === skipSessionId) {
        skippedCount += 1;
        continue;
      }
      try {
        const published = entry.events.publish(envelope);
        if (published === void 0) {
          failureCount += 1;
          teeServeDebugLine(
            `broadcastWorkspaceEvent: publish on session ${entry.sessionId} no-op (bus closed or unserializable)`
          );
        } else {
          successCount += 1;
        }
      } catch (err) {
        failureCount += 1;
        const detail = `broadcastWorkspaceEvent: bus publish failed for session ${JSON.stringify(entry.sessionId)} (type=${envelope.type}): ${err instanceof Error ? err.message : String(err)}`;
        if (shuttingDown) {
          teeServeDebugLine(detail);
        } else {
          writeStderrLine(`qwen serve: ${detail}`);
        }
      }
    }
    const eligible = sessions.length - skippedCount;
    if (eligible > 0 && successCount === 0 && !shuttingDown) {
      writeStderrLine(
        `qwen serve: broadcastWorkspaceEvent type=${envelope.type} dropped on ALL ${failureCount} session bus(es); SSE subscribers will miss this event (GET fallback still authoritative)`
      );
    }
  }, "broadcastWorkspaceEvent");
  const createSessionEventBus = /* @__PURE__ */ __name((sessionId) => new EventBus(
    eventRingSize,
    void 0,
    new TurnBoundaryCompactionEngine({
      maxReplayBytes: compactedReplayMaxBytes,
      maxJournalEvents,
      maxJournalBytes,
      onReplayWindowEviction: /* @__PURE__ */ __name((eviction) => {
        teeServeDebugLine(
          `replay window evicted ${JSON.stringify(eviction)}`
        );
      }, "onReplayWindowEviction"),
      // Adaptive growth: the engine asks before evicting past its caps.
      // The policy accounts growth across this bridge's live sessions
      // from every session's CURRENT journal cap (stateless — no ledger
      // to reconcile when a session is reaped), so granted headroom dies
      // with its session.
      ...journalGrowthPolicy ? {
        onJournalGrowth: /* @__PURE__ */ __name((current) => {
          const allSessionLimits = journalGrowthSessionLimits ? [...journalGrowthSessionLimits()] : journalSessionLimits();
          if (!byId.has(sessionId) && !pendingRestoreEvents.has(sessionId)) {
            allSessionLimits.push({
              limitBytes: current.maxBytes,
              baselineBytes: maxJournalBytes
            });
          }
          const grant = journalGrowthPolicy.grant({
            currentMaxEvents: current.maxEvents,
            currentMaxBytes: current.maxBytes,
            allSessionLimits
          });
          if (grant) {
            teeServeDebugLine(
              `live journal growth session=${JSON.stringify(sessionId)}: ${current.maxBytes} -> ${grant.maxBytes} bytes, ${current.maxEvents} -> ${grant.maxEvents} entries`
            );
          }
          return grant;
        }, "onJournalGrowth")
      } : {}
    }),
    {
      // Fired once, on the FIRST ingest/seed failure (the bus keeps the
      // degraded flag set silently afterwards). The bus doesn't know its
      // session, so the sessionId context is injected here.
      onCompactionError: /* @__PURE__ */ __name((err) => {
        writeStderrLine(
          `qwen serve: compaction degraded for session=${JSON.stringify(sessionId)}; replay snapshot may lag behind live events: ${err instanceof Error ? err.message : String(err)}`
        );
      }, "onCompactionError")
    }
  ), "createSessionEventBus");
  const publishModelSwitched = /* @__PURE__ */ __name((entry, modelId, originatorClientId) => {
    entry.currentModelId = modelId;
    entry.modelPublishGeneration++;
    entry.events.publish({
      type: "model_switched",
      ...entry.activePromptId ? { promptId: entry.activePromptId } : {},
      data: { sessionId: entry.sessionId, modelId },
      ...originatorClientId ? { originatorClientId } : {}
    });
  }, "publishModelSwitched");
  const publishApprovalModeChanged = /* @__PURE__ */ __name((entry, payload, originatorClientId) => {
    entry.currentApprovalMode = payload.next;
    entry.planExecutionMode = payload.next === "plan" ? payload.planExecutionMode : void 0;
    entry.approvalModePublishGeneration++;
    entry.events.publish({
      type: "approval_mode_changed",
      ...entry.activePromptId ? { promptId: entry.activePromptId } : {},
      data: {
        sessionId: entry.sessionId,
        previous: payload.previous,
        next: payload.next,
        persisted: payload.persisted,
        ...entry.planExecutionMode ? { planExecutionMode: entry.planExecutionMode } : {}
      },
      ...originatorClientId ? { originatorClientId } : {}
    });
  }, "publishApprovalModeChanged");
  const reconcileAfterRoundtrip = /* @__PURE__ */ __name(async (entry, target) => {
    const flagKey = target === "model" ? "modelReconciliationInFlight" : "approvalModeReconciliationInFlight";
    const genOf = /* @__PURE__ */ __name(() => target === "model" ? entry.modelPublishGeneration : entry.approvalModePublishGeneration, "genOf");
    if (entry[flagKey]) return;
    entry[flagKey] = true;
    const genBefore = genOf();
    let rerun = false;
    try {
      const status = await requestSessionStatus(
        entry.sessionId,
        SERVE_STATUS_EXT_METHODS.sessionContext
      );
      if (genOf() !== genBefore) {
        rerun = true;
        writeStderrLine(
          `[reconcile] session=${entry.sessionId} target=${target} action=skipped reason=generation_changed genBefore=${genBefore} genAfter=${genOf()}`
        );
        return;
      }
      if (target === "model") {
        const actual = status?.state?.models?.currentModelId;
        if (typeof actual === "string" && actual && actual !== entry.currentModelId) {
          writeStderrLine(
            `[reconcile] session=${entry.sessionId} target=model action=corrected cached=${entry.currentModelId ?? "<unset>"} actual=${actual}`
          );
          publishModelSwitched(entry, actual, void 0);
        }
      } else {
        const modes = status?.state?.modes;
        const actual = modes?.currentModeId;
        const selected = modes?._meta?.["planExecutionMode"];
        const planExecutionMode = actual === "plan" && typeof selected === "string" && selected !== "plan" && KNOWN_APPROVAL_MODES.has(selected) ? selected : void 0;
        if (actual && !KNOWN_APPROVAL_MODES.has(actual)) {
          writeStderrLine(
            `[reconcile] session=${entry.sessionId} target=approvalMode action=dropped reason=unknown_mode mode=${actual}`
          );
        } else if (actual && (actual !== entry.currentApprovalMode || planExecutionMode !== entry.planExecutionMode)) {
          writeStderrLine(
            `[reconcile] session=${entry.sessionId} target=approvalMode action=corrected cached=${entry.currentApprovalMode ?? "<unset>"} actual=${actual}`
          );
          publishApprovalModeChanged(
            entry,
            {
              previous: entry.currentApprovalMode ?? "default",
              next: actual,
              persisted: false,
              planExecutionMode
            },
            void 0
          );
        }
      }
    } catch (err) {
      writeStderrLine(
        `[reconcile] session=${entry.sessionId} target=${target} action=failed error=${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      entry[flagKey] = false;
      if (rerun) void reconcileAfterRoundtrip(entry, target);
    }
  }, "reconcileAfterRoundtrip");
  const createSessionEntry = /* @__PURE__ */ __name((ci, sessionId, workspaceCwd, events = createSessionEventBus(sessionId), options = {}) => {
    const childSnapshot = ci.harness.activeWork?.snapshot;
    const reportedChildHolds = childSnapshot?.sessions.get(sessionId);
    const entry = {
      sessionId,
      workspaceCwd,
      effectiveCwd: workspaceCwd,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      ...options.parentSessionId ? { parentSessionId: options.parentSessionId } : {},
      ...options.sourceType ? { sourceType: options.sourceType } : {},
      ...options.sourceId !== void 0 ? { sourceId: options.sourceId } : {},
      ...options.worktree ? { worktree: options.worktree } : {},
      ...options.branch ? { branch: options.branch } : {},
      channel: ci.channel,
      connection: ci.connection,
      events,
      artifacts: new SessionArtifactStore({
        sessionId,
        workspaceCwd,
        runtimeBaseDir: opts.artifactSnapshotRuntimeBaseDir,
        persistence: createSessionArtifactPersistence(ci.connection, sessionId)
      }),
      artifactWorkspaceCwd: workspaceCwd,
      artifactWorkspaceReady: !isReservedStandaloneSessionSourceType(
        options.sourceType
      ),
      deferredArtifactBatches: [],
      deferredArtifactInputCount: 0,
      attachments: new SessionAttachmentStore(
        opts.sessionAttachmentsRoot,
        sessionId,
        opts.sessionAttachmentsFallbackRoot
      ),
      recordingDegraded: false,
      closing: false,
      cwdChangeQueue: Promise.resolve(),
      promptQueue: Promise.resolve(),
      pendingPromptCount: 0,
      cancelGeneration: 0,
      pendingAgentNotificationCount: 0,
      ...opts.promptLedger ? { promptLedger: opts.promptLedger } : {},
      pendingPromptList: [],
      terminalTurnStatuses: /* @__PURE__ */ new Map(),
      enrichedTerminalPromptIds: /* @__PURE__ */ new Set(),
      rewindGeneration: 0,
      midTurnMessageQueue: [],
      settledMidTurnMessageIds: [],
      promotedMidTurnMessageIds: [],
      modelChangeQueue: Promise.resolve(),
      approvalModeQueue: Promise.resolve(),
      modelPublishGeneration: 0,
      approvalModePublishGeneration: 0,
      pendingPermissionIds: /* @__PURE__ */ new Set(),
      pendingInteractions: /* @__PURE__ */ new Map(),
      clientIds: /* @__PURE__ */ new Map(),
      clientLastSeenAt: /* @__PURE__ */ new Map(),
      attachCount: 0,
      attachRefs: /* @__PURE__ */ new Map(),
      spawnOwnerWantedKill: false,
      promptActive: false,
      childHolds: reportedChildHolds ?? null,
      childHoldsAt: childSnapshot && reportedChildHolds !== void 0 ? childSnapshot.receivedAt : null,
      activeWorkCloseInFlight: false,
      activeWorkCloseFailures: 0,
      activeWorkCloseRetryAt: null,
      retryAllowed: false,
      promptSettledAt: null,
      promptSettledCloseTimer: void 0
    };
    if (isReservedStandaloneSessionSourceType(options.sourceType)) {
      entry.prepareArtifactWorkspace = () => prepareStandaloneArtifactWorkspace(entry);
    }
    ci.sessionIds.add(entry.sessionId);
    byId.set(entry.sessionId, entry);
    ci.client.clearAbandonedRestoreFence(entry.sessionId);
    touchActivity();
    telemetry.metrics?.sessionLifecycle("spawn");
    emitSessionLifecycle({
      type: "registered",
      sessionId: entry.sessionId,
      workspaceCwd: entry.workspaceCwd,
      reason: options.lifecycleReason ?? "spawn"
    });
    if (options.drainEarlyEvents !== false) {
      ci.client.drainEarlyEvents(entry.sessionId, entry);
    }
    return entry;
  }, "createSessionEntry");
  async function persistSessionSource(entry, logContext, daemonOwnedStandaloneCreation = false) {
    try {
      const sourceResult = await Promise.race([
        withTimeout(
          entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionSource, {
            sessionId: entry.sessionId,
            sourceType: entry.sourceType,
            ...entry.sourceId !== void 0 ? { sourceId: entry.sourceId } : {},
            ...daemonOwnedStandaloneCreation ? { [DAEMON_OWNED_STANDALONE_CREATION_KEY]: true } : {}
          }),
          initTimeoutMs,
          "sessionSource"
        ),
        getTransportClosedReject(entry)
      ]);
      return sourceResult?.persisted === true;
    } catch (err) {
      writeStderrLine(
        `qwen serve: source metadata for ${logContext} was not persisted (${err instanceof Error ? err.message : String(err)}) \u2014 the source is live-only until restart (reported to the caller via sourcePersisted=false)`
      );
      return false;
    }
  }
  __name(persistSessionSource, "persistSessionSource");
  async function applyRestoreSourceIfMissing(entry, req) {
    if (entry.sourceType !== void 0 || req.sourceType === void 0) {
      return void 0;
    }
    entry.sourceType = req.sourceType;
    if (req.sourceId !== void 0) {
      entry.sourceId = req.sourceId;
    } else {
      delete entry.sourceId;
    }
    markSessionCatalogChanged();
    return await persistSessionSource(
      entry,
      `${entry.sessionId} during session restore`
    );
  }
  __name(applyRestoreSourceIfMissing, "applyRestoreSourceIfMissing");
  const prepareStandaloneArtifactWorkspace = /* @__PURE__ */ __name(async (entry) => {
    if (!entry.artifactWorkspaceReady) {
      throw standaloneWorkingDirectoryMissingError();
    }
    if (entry.artifactWorkspacePreparation) {
      return entry.artifactWorkspacePreparation;
    }
    const owner = channelInfoForEntry(entry);
    if (!owner) throw standaloneWorkingDirectoryMissingError();
    const preparation = (async () => {
      const pending = entry.pendingArtifactRestore;
      if (pending) {
        delete entry.pendingArtifactRestore;
        try {
          await owner.client.ingestSessionUpdateArtifactsReady(
            entry,
            pending.replayUpdates
          );
        } catch (error) {
          entry.pendingArtifactRestore = pending;
          throw error;
        }
      }
      await owner.client.drainDeferredSessionArtifacts(entry);
    })();
    entry.artifactWorkspacePreparation = preparation;
    try {
      await preparation;
    } finally {
      if (entry.artifactWorkspacePreparation === preparation) {
        entry.artifactWorkspacePreparation = void 0;
      }
    }
  }, "prepareStandaloneArtifactWorkspace");
  const publishArtifactChanges = /* @__PURE__ */ __name((entry, changes, originatorClientId) => {
    for (const change of changes) {
      entry.events.publish({
        type: "artifact_changed",
        data: { sessionId: entry.sessionId, change },
        ...originatorClientId ? { originatorClientId } : {}
      });
    }
  }, "publishArtifactChanges");
  const artifactReseedChanges = /* @__PURE__ */ __name((before, after) => {
    const beforeById = new Map(
      before.map((artifact) => [artifact.id, artifact])
    );
    const afterById = new Map(after.map((artifact) => [artifact.id, artifact]));
    const changes = [];
    for (const artifact of before) {
      if (!afterById.has(artifact.id)) {
        changes.push({
          action: "removed",
          artifactId: artifact.id,
          artifact,
          reason: "eviction"
        });
      }
    }
    for (const artifact of after) {
      const previous = beforeById.get(artifact.id);
      if (!previous) {
        changes.push({
          action: "created",
          artifactId: artifact.id,
          artifact
        });
        continue;
      }
      if (!publicArtifactsEqual(previous, artifact)) {
        changes.push({
          action: "updated",
          artifactId: artifact.id,
          artifact
        });
      }
    }
    return changes;
  }, "artifactReseedChanges");
  const makeClientArtifactInput = /* @__PURE__ */ __name((artifact, clientId) => {
    const input = {
      title: artifact.title,
      kind: artifact.kind,
      storage: artifact.storage,
      description: artifact.description,
      workspacePath: artifact.workspacePath,
      managedId: artifact.managedId,
      url: artifact.url,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      metadata: artifact.metadata,
      retention: artifact.retention,
      clientRetained: artifact.clientRetained,
      source: "client"
    };
    if (clientId) {
      input.clientId = clientId;
    }
    return input;
  }, "makeClientArtifactInput");
  function createSessionArtifactPersistence(connection, sessionId) {
    return {
      recordEvent: /* @__PURE__ */ __name(async (payload) => {
        await connection.extMethod(
          SERVE_CONTROL_EXT_METHODS.sessionArtifactsPersist,
          {
            sessionId,
            kind: "event",
            payload
          }
        );
      }, "recordEvent"),
      recordSnapshot: /* @__PURE__ */ __name(async (payload) => {
        await connection.extMethod(
          SERVE_CONTROL_EXT_METHODS.sessionArtifactsPersist,
          {
            sessionId,
            kind: "snapshot",
            payload
          }
        );
      }, "recordSnapshot")
    };
  }
  __name(createSessionArtifactPersistence, "createSessionArtifactPersistence");
  const seedSnapshotCaches = /* @__PURE__ */ __name((entry, resp) => {
    const model = resp.models?.currentModelId;
    if (typeof model === "string" && model.length > 0) {
      entry.currentModelId = model;
    } else if (model != null) {
      writeStderrLine(
        `[seed] session=${entry.sessionId} target=model action=dropped value=${JSON.stringify(model)} reason=invalid_type`
      );
    }
    const mode = resp.modes?.currentModeId;
    if (typeof mode === "string" && KNOWN_APPROVAL_MODES.has(mode)) {
      entry.currentApprovalMode = mode;
      const selected = resp.modes?._meta?.["planExecutionMode"];
      entry.planExecutionMode = mode === "plan" && typeof selected === "string" && selected !== "plan" && KNOWN_APPROVAL_MODES.has(selected) ? selected : void 0;
    } else if (mode != null) {
      writeStderrLine(
        `[seed] session=${entry.sessionId} target=approvalMode action=dropped value=${JSON.stringify(mode)} reason=${typeof mode !== "string" ? "invalid_type" : "unknown_mode"}`
      );
    }
  }, "seedSnapshotCaches");
  const isAcpSessionResourceNotFound = /* @__PURE__ */ __name((err, sessionId) => {
    if (!err || typeof err !== "object") return false;
    const maybe = err;
    if (maybe.code !== -32002) return false;
    const expectedUri = `session:${sessionId}`;
    if (maybe.data && typeof maybe.data === "object" && maybe.data.uri === expectedUri) {
      return true;
    }
    return typeof maybe.message === "string" && maybe.message === `Resource not found: ${expectedUri}`;
  }, "isAcpSessionResourceNotFound");
  const replayFieldsFor = /* @__PURE__ */ __name((entry, action, liveReplayMode = "full") => {
    const replayStatus = action === "load" && entry.restoreReplayPartial === true ? {
      partial: true,
      ...typeof entry.restoreReplayError === "string" ? { replayError: entry.restoreReplayError } : {}
    } : {};
    const eventEpoch = entry.events.epoch;
    const snapshot = entry.events.snapshotReplay(liveReplayMode);
    if (!snapshot) {
      return {
        lastEventId: entry.events.lastEventId,
        eventEpoch,
        ...replayStatus,
        ...action === "load" && entry.restoreHistoryAnchorRecordId !== void 0 ? { historyAnchorRecordId: entry.restoreHistoryAnchorRecordId } : {}
      };
    }
    if (action === "load") {
      const liveJournal = snapshot.liveJournal.map((event) => {
        if (!entry.activePromptId || event.type !== "history_truncated" || !event.data || typeof event.data !== "object" || event.data.scope !== "live_journal") {
          return event;
        }
        return { ...event, promptId: entry.activePromptId };
      });
      return {
        compactedReplay: snapshot.compactedTurns,
        liveJournal,
        lastEventId: snapshot.lastEventId,
        eventEpoch,
        ...replayStatus,
        ...snapshot.degraded ? { replayDegraded: true } : {},
        ...entry.restoreHistoryHasMore === true ? { historyHasMore: true } : {},
        ...entry.restoreHistoryAnchorRecordId !== void 0 ? { historyAnchorRecordId: entry.restoreHistoryAnchorRecordId } : {}
      };
    }
    return { lastEventId: snapshot.lastEventId, eventEpoch, ...replayStatus };
  }, "replayFieldsFor");
  const restoredArtifactSnapshotFromState = /* @__PURE__ */ __name((state) => {
    const candidate = state.artifactSnapshot;
    const warnings = [];
    const snapshot = normalizeSnapshotPayload(candidate, warnings);
    if (!snapshot) return void 0;
    const snapshotWarnings = isRecord7(candidate) && Array.isArray(candidate["warnings"]) ? candidate["warnings"].filter(
      (warning) => typeof warning === "string" && warning.length <= 1e3
    ).slice(-500) : [];
    return {
      v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
      sessionId: snapshot.sessionId,
      sequence: snapshot.sequence,
      artifacts: snapshot.artifacts,
      ...snapshot.markerArtifacts ? { markerArtifacts: snapshot.markerArtifacts } : {},
      tombstonedIds: snapshot.tombstonedIds ?? [],
      stickyEphemeralIds: snapshot.stickyEphemeralIds ?? [],
      warnings: [...warnings, ...snapshotWarnings]
    };
  }, "restoredArtifactSnapshotFromState");
  const artifactSnapshotUnavailableReason = /* @__PURE__ */ __name((state) => {
    const reason = state.artifactSnapshotUnavailable;
    return typeof reason === "string" && reason ? reason : void 0;
  }, "artifactSnapshotUnavailableReason");
  const publicRestoreState = /* @__PURE__ */ __name((state) => {
    const {
      artifactSnapshot: _artifactSnapshot,
      artifactSnapshotUnavailable: _artifactSnapshotUnavailable,
      ...publicState
    } = state;
    return publicState;
  }, "publicRestoreState");
  async function requestSessionTranscriptPage(req) {
    try {
      const response = await withEnsuredWorkspaceControl(
        (info) => withTimeout(
          Promise.race([
            info.connection.extMethod(
              SERVE_STATUS_EXT_METHODS.sessionTranscript,
              { ...req, cwd: boundWorkspace }
            ),
            getChannelClosedReject(info)
          ]),
          Math.max(initTimeoutMs, SESSION_TRANSCRIPT_TIMEOUT_MS),
          SERVE_STATUS_EXT_METHODS.sessionTranscript
        )
      );
      return response;
    } catch (err) {
      if (isAcpSessionResourceNotFound(err, req.sessionId)) {
        throw new SessionNotFoundError(req.sessionId);
      }
      throw err;
    }
  }
  __name(requestSessionTranscriptPage, "requestSessionTranscriptPage");
  async function requestSessionTurnIndexPage(req) {
    try {
      const response = await withEnsuredWorkspaceControl(
        (info) => withTimeout(
          Promise.race([
            info.connection.extMethod(
              SERVE_STATUS_EXT_METHODS.sessionTurnIndex,
              { ...req, cwd: boundWorkspace }
            ),
            getChannelClosedReject(info)
          ]),
          Math.max(initTimeoutMs, SESSION_TRANSCRIPT_TIMEOUT_MS),
          SERVE_STATUS_EXT_METHODS.sessionTurnIndex
        )
      );
      return response;
    } catch (err) {
      if (isAcpSessionResourceNotFound(err, req.sessionId)) {
        throw new SessionNotFoundError(req.sessionId);
      }
      throw err;
    }
  }
  __name(requestSessionTurnIndexPage, "requestSessionTurnIndexPage");
  async function refreshedReplayFieldsFor(entry, historyPageSize, liveReplayMode) {
    if (entry.pendingInteractions.size > 0) {
      return replayFieldsFor(entry, "load", liveReplayMode);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const lastEventId = entry.events.lastEventId;
        const eventEpoch = entry.events.epoch;
        const seenCursors = /* @__PURE__ */ new Set();
        let emptyPageCount = 0;
        let cursor;
        let page;
        do {
          page = await requestSessionTranscriptPage({
            sessionId: entry.sessionId,
            ...cursor ? { cursor } : { direction: "backward" },
            limit: historyPageSize
          });
          const nextCursor = page.nextCursor;
          if (page.events.length === 0 && page.hasMore && (nextCursor === void 0 || seenCursors.has(nextCursor))) {
            throw new Error("Transcript cursor did not advance");
          }
          if (page.events.length === 0 && page.hasMore && ++emptyPageCount >= MAX_EMPTY_TRANSCRIPT_PAGES) {
            throw new Error("Transcript empty-page limit exceeded");
          }
          cursor = nextCursor;
          if (cursor !== void 0) seenCursors.add(cursor);
        } while (page.events.length === 0 && page.hasMore && cursor !== void 0 && page.partial !== true && page.replayError === void 0);
        if (byId.get(entry.sessionId) === entry && !entry.promptActive && !entry.backgroundTurn && entry.events.epoch === eventEpoch && entry.events.lastEventId === lastEventId) {
          let compactedReplay = page.events;
          const turnErrorEvent = entry.turnErrorEvent;
          if (turnErrorEvent) {
            const journal = entry.events.liveJournalSnapshot() ?? [];
            const hasNewerTurnContent = journal.some(
              isRefreshAppendTurnContent
            );
            if (!hasNewerTurnContent) {
              compactedReplay = [...page.events, turnErrorEvent];
            }
          }
          return {
            compactedReplay,
            liveJournal: [],
            lastEventId,
            eventEpoch,
            ...page.partial === true ? { partial: true } : {},
            ...page.replayError !== void 0 ? { replayError: page.replayError } : {},
            ...page.hasMore ? { historyHasMore: true } : {}
          };
        }
        if (entry.pendingInteractions.size > 0) break;
      } catch {
        break;
      }
    }
    return replayFieldsFor(entry, "load", liveReplayMode);
  }
  __name(refreshedReplayFieldsFor, "refreshedReplayFieldsFor");
  function transcriptEventRecordId(event) {
    if (event.type !== "session_update") return void 0;
    const data = event.data;
    if (!data || typeof data !== "object" || Array.isArray(data))
      return void 0;
    const rec = data;
    const update = rec["update"];
    const meta = update && typeof update === "object" && !Array.isArray(update) ? update["_meta"] : rec["_meta"];
    if (!meta || typeof meta !== "object" || Array.isArray(meta))
      return void 0;
    const recordId = meta["qwen.session.recordId"];
    return typeof recordId === "string" ? recordId : void 0;
  }
  __name(transcriptEventRecordId, "transcriptEventRecordId");
  async function resolveHistoryAnchorRecordId(entry, replayFields) {
    const events = [
      ...replayFields.compactedReplay ?? [],
      ...replayFields.liveJournal ?? []
    ];
    const hasMarker = events.some((e) => e.type === "history_truncated");
    if (!hasMarker) return void 0;
    const hasRecordId = events.some(
      (e) => transcriptEventRecordId(e) !== void 0 || e.type === "history_truncated" && isRecord7(e.data) && typeof e.data["recordId"] === "string"
    );
    if (hasRecordId) return void 0;
    try {
      const page = await requestSessionTranscriptPage({
        sessionId: entry.sessionId,
        direction: "backward",
        limit: 50
      });
      for (const event of page.events) {
        const recordId = transcriptEventRecordId(event);
        if (recordId !== void 0) return recordId;
      }
    } catch {
    }
    return void 0;
  }
  __name(resolveHistoryAnchorRecordId, "resolveHistoryAnchorRecordId");
  const sendTrackedPrompt = { fn: void 0 };
  const maybeFireRestoreAskUserQuestionPrompt = /* @__PURE__ */ __name((entry, restoreAskUserQuestionHint, requestedClientId, registeredClientId, options) => {
    if (opts.restoreAskUserQuestion !== true || restoreAskUserQuestionHint !== true || // Nobody can answer the re-hung question without an attached client;
    // internal restores (boot rehydrate, keepalive, sub-session resume)
    // pass no clientId and must not fabricate an unbounded permission wait.
    requestedClientId === void 0 || options.suppressRestorePrompt === true || // Admission-time busy check: pendingPromptCount flips synchronously
    // when a prompt is accepted, before the queue callback sets
    // promptActive; Goal turns never set promptActive at all.
    entry.promptActive || entry.pendingPromptCount > 0 || entry.goalTurnActive === true || entry.backgroundTurn !== void 0) {
      return false;
    }
    let restorePrompt;
    try {
      restorePrompt = sendTrackedPrompt.fn?.(
        entry.sessionId,
        { sessionId: entry.sessionId, prompt: [] },
        void 0,
        { clientId: registeredClientId, restoreAskUserQuestion: true }
      );
    } catch (err) {
      teeServeDebugLine(
        `restoreAskUserQuestion: restore prompt admission failed for ${entry.sessionId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
    restorePrompt?.catch((err) => {
      teeServeDebugLine(
        `restoreAskUserQuestion: restore prompt failed for ${entry.sessionId}: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    return true;
  }, "maybeFireRestoreAskUserQuestionPrompt");
  const deferOrFireRestoreAskUserQuestionPrompt = /* @__PURE__ */ __name((entry, restoreAskUserQuestionHint, requestedClientId, registeredClientId, options) => {
    if (options.deferRestorePrompt === true && restoreAskUserQuestionHint && requestedClientId !== void 0 && options.suppressRestorePrompt !== true) {
      entry.deferredRestoreAskUserQuestionPrompts ??= /* @__PURE__ */ new Map();
      entry.deferredRestoreAskUserQuestionPrompts.set(
        registeredClientId,
        requestedClientId
      );
      return false;
    }
    return maybeFireRestoreAskUserQuestionPrompt(
      entry,
      restoreAskUserQuestionHint,
      requestedClientId,
      registeredClientId,
      options
    );
  }, "deferOrFireRestoreAskUserQuestionPrompt");
  async function restoreSession(action, req, options = {}) {
    if (req.compactedReplayMode !== void 0 && req.compactedReplayMode !== "full" && req.compactedReplayMode !== "summary") {
      throw RequestError.invalidParams(
        void 0,
        "Invalid compactedReplayMode; expected full or summary"
      );
    }
    const restored = await restoreSessionWithReplay(action, req, options);
    return action === "load" && req.compactedReplayMode === "summary" && restored.compactedReplay ? {
      ...restored,
      compactedReplay: summarizeReplay(restored.compactedReplay)
    } : restored;
  }
  __name(restoreSession, "restoreSession");
  async function restoreSessionWithReplay(action, req, options = {}) {
    if (shuttingDown) {
      throw new Error("AcpSessionBridge is shutting down");
    }
    const daemonOwnedStandaloneRestore = options.daemonOwnedStandaloneRestore === true;
    if (isReservedStandaloneSessionSourceType(req.sourceType) && !daemonOwnedStandaloneRestore) {
      throw new InvalidSessionMetadataError(
        "sourceType",
        "`standalone` is reserved for daemon-owned session restore"
      );
    }
    const workspaceKey = resolveWorkspaceKey(req.workspaceCwd);
    if (req.approvalMode !== void 0 && !KNOWN_APPROVAL_MODES.has(req.approvalMode)) {
      throw new Error(
        `Invalid approvalMode: ${JSON.stringify(req.approvalMode)}`
      );
    }
    const historyReplay = action === "load" ? req.historyReplay ?? "stream" : "stream";
    const historyPageSize = action === "load" && historyReplay === "response" ? req.historyPageSize : void 0;
    const requestedLiveReplayMode = req.liveReplayMode;
    if (requestedLiveReplayMode !== void 0 && requestedLiveReplayMode !== "full" && requestedLiveReplayMode !== "summary") {
      throw new Error(
        `Invalid liveReplayMode: ${JSON.stringify(requestedLiveReplayMode)}`
      );
    }
    const liveReplayMode = action === "load" ? requestedLiveReplayMode ?? "full" : "full";
    if (historyPageSize !== void 0 && (!Number.isSafeInteger(historyPageSize) || historyPageSize < 1 || historyPageSize > SESSION_TRANSCRIPT_MAX_LIMIT)) {
      throw new Error(
        `Invalid historyPageSize; expected 1..${SESSION_TRANSCRIPT_MAX_LIMIT}`
      );
    }
    const hideInheritedHistory = action === "load" && req.hideInheritedHistory === true;
    const existing = byId.get(req.sessionId);
    if (existing) {
      assertAttachableSessionEntry(req.sessionId, existing);
      const replayFields = historyPageSize !== void 0 ? await refreshedReplayFieldsFor(
        existing,
        historyPageSize,
        liveReplayMode
      ) : replayFieldsFor(existing, action, liveReplayMode);
      const historyAnchorRecordId = action === "load" ? await resolveHistoryAnchorRecordId(existing, replayFields) : void 0;
      assertAttachableSessionEntry(req.sessionId, existing);
      existing.attachCount++;
      const clientId = registerClient(existing, req.clientId);
      recordAttachRef(existing, clientId);
      let previousApprovalMode;
      if (req.approvalMode) {
        previousApprovalMode = await applyApprovalModeForAttach(
          existing,
          req.approvalMode,
          clientId
        );
        try {
          assertAttachableSessionEntry(req.sessionId, existing);
        } catch (error) {
          await rollbackApprovalModeForRejectedAttach(
            existing,
            previousApprovalMode,
            clientId
          );
          await rollbackAttachRegistration(existing, clientId);
          throw error;
        }
      }
      const sourcePersisted = await applyRestoreSourceIfMissing(existing, req);
      try {
        assertAttachableSessionEntry(req.sessionId, existing);
      } catch (error) {
        if (previousApprovalMode !== void 0) {
          await rollbackApprovalModeForRejectedAttach(
            existing,
            previousApprovalMode,
            clientId
          );
        }
        await rollbackAttachRegistration(existing, clientId);
        throw error;
      }
      return {
        sessionId: existing.sessionId,
        workspaceCwd: existing.workspaceCwd,
        ...existing.effectiveCwd !== existing.workspaceCwd ? { currentCwd: existing.effectiveCwd } : {},
        attached: true,
        clientId,
        createdAt: existing.createdAt,
        ...existing.sourceType ? { sourceType: existing.sourceType } : {},
        ...existing.sourceId !== void 0 ? { sourceId: existing.sourceId } : {},
        // Late attachers get the same ACP state the original restore
        // caller saw; spawn-only sessions don't carry a state payload.
        state: existing.restoreState ?? {},
        hasRunningBackgroundTasks: existing.hasRunningBackgroundTasks,
        hasActivePrompt: existing.promptActive || existing.goalTurnActive === true || !!existing.backgroundTurn,
        ...existing.backgroundTurn ? { backgroundTurn: existing.backgroundTurn } : {},
        ...sourcePersisted !== void 0 ? { sourcePersisted } : {},
        ...replayFields,
        ...historyAnchorRecordId !== void 0 ? { historyAnchorRecordId } : {}
      };
    }
    if (inFlightSessionIdReservations.has(req.sessionId)) {
      const owner = inFlightSessionIdReservations.get(req.sessionId);
      throw new RestoreInProgressError(
        req.sessionId,
        "spawn",
        action,
        owner !== void 0 && abandonedSessionIdReservations.has(owner.token) ? {
          reason: "awaiting_abandoned_cleanup",
          retryAfterSeconds: abandonedNewSessionRetryAfterSeconds
        } : void 0
      );
    }
    const inFlight = inFlightRestores.get(req.sessionId);
    if (inFlight) {
      if (inFlight.lifecycle.phase === "abandoned" || action !== inFlight.action || historyReplay !== inFlight.historyReplay || historyPageSize !== inFlight.historyPageSize || inFlight.liveReplayMode === "summary" && liveReplayMode === "full" || hideInheritedHistory !== inFlight.hideInheritedHistory) {
        const abandoned = inFlight.lifecycle.phase === "abandoned";
        throw new RestoreInProgressError(
          req.sessionId,
          inFlight.action,
          action,
          abandoned ? {
            reason: "awaiting_abandoned_cleanup",
            retryAfterSeconds: abandonedRestoreRetryAfterSeconds
          } : void 0
        );
      }
      inFlight.coalesceState.count++;
      let restored;
      try {
        restored = await inFlight.publicPromise;
      } catch (err) {
        inFlight.coalesceState.count--;
        throw err;
      }
      const entry = byId.get(restored.sessionId);
      if (!entry) {
        inFlight.coalesceState.count--;
        throw new SessionNotFoundError(
          restored.sessionId,
          "the agent child likely crashed during session restore \u2014 retry to restore the session"
        );
      }
      try {
        assertAttachableSessionEntry(restored.sessionId, entry);
      } catch (error) {
        inFlight.coalesceState.count--;
        entry.attachCount = Math.max(0, entry.attachCount - 1);
        throw error;
      }
      const waiterReplayFields = liveReplayMode !== inFlight.liveReplayMode ? historyPageSize !== void 0 ? await refreshedReplayFieldsFor(
        entry,
        historyPageSize,
        liveReplayMode
      ) : replayFieldsFor(entry, action, liveReplayMode) : void 0;
      try {
        assertAttachableSessionEntry(restored.sessionId, entry);
      } catch (error) {
        inFlight.coalesceState.count--;
        entry.attachCount = Math.max(0, entry.attachCount - 1);
        throw error;
      }
      const clientId = registerClient(entry, req.clientId);
      recordAttachRef(entry, clientId);
      let previousApprovalMode;
      if (req.approvalMode) {
        previousApprovalMode = await applyApprovalModeForAttach(
          entry,
          req.approvalMode,
          clientId
        );
        try {
          assertAttachableSessionEntry(restored.sessionId, entry);
        } catch (error) {
          await rollbackApprovalModeForRejectedAttach(
            entry,
            previousApprovalMode,
            clientId
          );
          await rollbackAttachRegistration(entry, clientId);
          throw error;
        }
      }
      const sourcePersisted = await applyRestoreSourceIfMissing(entry, req);
      try {
        assertAttachableSessionEntry(restored.sessionId, entry);
      } catch (error) {
        if (previousApprovalMode !== void 0) {
          await rollbackApprovalModeForRejectedAttach(
            entry,
            previousApprovalMode,
            clientId
          );
        }
        await rollbackAttachRegistration(entry, clientId);
        throw error;
      }
      return {
        ...restored,
        attached: true,
        clientId,
        createdAt: entry.createdAt,
        // Unlike the owner-side restore responses, the waiter has no
        // `restorePromptAdmitted` term; a prompt the owner parked while the
        // restore was in flight must still read as active here so the
        // waiter's caller never relocates or resets under a deferred prompt.
        hasActivePrompt: hasInFlightPromptActivity(entry),
        hasRunningBackgroundTasks: entry.hasRunningBackgroundTasks,
        ...entry.backgroundTurn ? { backgroundTurn: entry.backgroundTurn } : {},
        ...entry.sourceType ? { sourceType: entry.sourceType } : {},
        ...entry.sourceId !== void 0 ? { sourceId: entry.sourceId } : {},
        ...sourcePersisted !== void 0 ? { sourcePersisted } : {},
        ...waiterReplayFields ?? {}
      };
    }
    assertFreshSessionsAvailable();
    if (byId.size + inFlightSpawns.size + inFlightRestores.size + abandonedNewSessionSettlements.size >= maxSessions) {
      throw new SessionLimitExceededError(maxSessions);
    }
    const restoreEvents = createSessionEventBus(req.sessionId);
    let registeredEntry;
    let ci;
    const coalesceState = { count: 0 };
    const admission = options.skipFreshSessionAdmission === true ? void 0 : reserveFreshSession({
      operation: action,
      workspaceCwd: workspaceKey,
      sessionId: req.sessionId
    });
    let admissionReleased = false;
    const releaseAdmissionOnce = /* @__PURE__ */ __name(() => {
      if (admissionReleased) return;
      admissionReleased = true;
      releaseFreshSessionReservation(admission);
    }, "releaseAdmissionOnce");
    let resolveSettlement;
    const settlementPromise = new Promise((resolve2) => {
      resolveSettlement = resolve2;
    });
    const restoreLifecycle = {
      phase: "active"
    };
    const settleAbandonedRestore = /* @__PURE__ */ __name(async (channel, lateResult) => {
      telemetry.event("session.restore.late_result", {
        "qwen-code.daemon.session_restore.action": action,
        "qwen-code.daemon.session_restore.result": lateResult,
        "qwen-code.daemon.session_restore.timeout_ms": sessionRestoreTimeoutMs,
        "qwen-code.daemon.acp_channel.id": channel.id,
        "session.id": req.sessionId
      });
      const usurper = byId.get(req.sessionId);
      if (usurper) {
        writeStderrLine(
          `qwen serve: skipping abandoned session/${action} cleanup for ${JSON.stringify(req.sessionId)}: the id is now owned by a live session`
        );
        telemetry.event("session.restore.cleanup", {
          "qwen-code.daemon.session_restore.action": action,
          "qwen-code.daemon.session_restore.cleanup_result": "id_reclaimed",
          "qwen-code.daemon.session_restore.timeout_ms": sessionRestoreTimeoutMs,
          "qwen-code.daemon.acp_channel.id": channel.id,
          "session.id": req.sessionId
        });
        channel.unsettledAbandonedRestores.delete(req.sessionId);
        const reclaimedTimer = channel.restoreSettlementTimers.get(
          req.sessionId
        );
        if (reclaimedTimer !== void 0) {
          clearTimeout(reclaimedTimer);
          channel.restoreSettlementTimers.delete(req.sessionId);
        }
        channel.overdueAbandonedRestores.delete(req.sessionId);
        releaseAdmissionOnce();
        resolveSettlement();
        return;
      }
      try {
        if (channel.harness.isDying || !harness.has(channel.harness)) {
          await channel.channel.exited;
          telemetry.event("session.restore.cleanup", {
            "qwen-code.daemon.session_restore.action": action,
            "qwen-code.daemon.session_restore.cleanup_result": "transport_closed",
            "qwen-code.daemon.session_restore.timeout_ms": sessionRestoreTimeoutMs,
            "qwen-code.daemon.acp_channel.id": channel.id,
            "session.id": req.sessionId
          });
          return;
        }
        try {
          const closeResult = await Promise.race([
            withTimeout(
              channel.connection.extMethod(
                SERVE_CONTROL_EXT_METHODS.sessionClose,
                {
                  sessionId: req.sessionId,
                  drainTimeoutMs: sessionCloseDrainBudgetMs(initTimeoutMs)
                }
              ),
              initTimeoutMs,
              "abandonedRestoreClose"
            ),
            getChannelClosedReject(channel)
          ]);
          if (!isRecord7(closeResult) || closeResult["closed"] !== true) {
            throw new Error("ACP child refused abandoned restore cleanup");
          }
          telemetry.event("session.restore.cleanup", {
            "qwen-code.daemon.session_restore.action": action,
            "qwen-code.daemon.session_restore.cleanup_result": "closed",
            "qwen-code.daemon.session_restore.timeout_ms": sessionRestoreTimeoutMs,
            "qwen-code.daemon.acp_channel.id": channel.id,
            "session.id": req.sessionId
          });
        } catch (error) {
          if (isAcpSessionResourceNotFound(error, req.sessionId)) {
            telemetry.event("session.restore.cleanup", {
              "qwen-code.daemon.session_restore.action": action,
              "qwen-code.daemon.session_restore.cleanup_result": "not_found",
              "qwen-code.daemon.session_restore.timeout_ms": sessionRestoreTimeoutMs,
              "qwen-code.daemon.acp_channel.id": channel.id,
              "session.id": req.sessionId
            });
            return;
          }
          if (channel.harness.isDying || !harness.has(channel.harness)) {
            await channel.channel.exited;
            telemetry.event("session.restore.cleanup", {
              "qwen-code.daemon.session_restore.action": action,
              "qwen-code.daemon.session_restore.cleanup_result": "transport_closed",
              "qwen-code.daemon.session_restore.timeout_ms": sessionRestoreTimeoutMs,
              "qwen-code.daemon.acp_channel.id": channel.id,
              "session.id": req.sessionId
            });
            return;
          }
          channel.isQuarantined = true;
          writeStderrLine(
            `qwen serve: quarantining ACP channel after timed-out session/${action} cleanup failed for ${JSON.stringify(req.sessionId)}: ${extractErrorMessage(error)}`
          );
          telemetry.event("session.restore.cleanup", {
            "qwen-code.daemon.session_restore.action": action,
            "qwen-code.daemon.session_restore.cleanup_result": "quarantined",
            "qwen-code.daemon.session_restore.timeout_ms": sessionRestoreTimeoutMs,
            "qwen-code.daemon.acp_channel.id": channel.id,
            "session.id": req.sessionId
          });
          if (harness.hasNoChannelWork(channel.harness, {
            ignoreRestoreId: req.sessionId
          })) {
            void harness.killChannelWithLog(
              channel.harness,
              `abandoned session/${action} cleanup`
            );
          }
          await channel.channel.exited;
        }
      } finally {
        channel.client.markSessionClosed(req.sessionId);
        channel.unsettledAbandonedRestores.delete(req.sessionId);
        const graceTimer = channel.restoreSettlementTimers.get(req.sessionId);
        if (graceTimer !== void 0) {
          clearTimeout(graceTimer);
          channel.restoreSettlementTimers.delete(req.sessionId);
        }
        channel.overdueAbandonedRestores.delete(req.sessionId);
        releaseAdmissionOnce();
        resolveSettlement();
      }
    }, "settleAbandonedRestore");
    const promise = (async () => {
      pendingRestoreEvents.set(req.sessionId, restoreEvents);
      const restoreChannel = getChannelInfo(await harness.ensure());
      if (restoreChannel.harness.isDying) {
        throw new BridgeChannelClosedError(`before session/${action}`);
      }
      ci = restoreChannel;
      restoreChannel.pendingRestoreIds.add(req.sessionId);
      restoreChannel.client.markRestoreInFlight(req.sessionId);
      const transportClosed = channelUnavailableReject(
        restoreChannel.channel,
        `during session/${action}`
      );
      transportClosed.catch(() => {
      });
      let state;
      let replayUpdates = [];
      let replayPartial;
      let replayError;
      let replayHasMore;
      let replayAnchorRecordId;
      let restoreAskUserQuestionHint = false;
      try {
        const rawRestore = telemetry.withSpan(
          "session.restore",
          {
            "qwen-code.daemon.bridge.operation": `session.${action}`,
            "qwen-code.daemon.session_restore.action": action,
            "qwen-code.daemon.acp_channel.id": restoreChannel.id,
            "qwen-code.daemon.session_restore.timeout_ms": sessionRestoreTimeoutMs,
            "session.id": req.sessionId
          },
          async () => {
            if (action === "load") {
              const request2 = telemetry.injectPromptContext({
                sessionId: req.sessionId,
                cwd: workspaceKey,
                // Restore path drops per-request `mcpServers` (matches
                // `doSpawn`); daemon-wide MCP comes from settings on
                // the agent side. The SDK's `RestoreSessionRequest`
                // intentionally has no `mcpServers` field for the
                // same reason.
                mcpServers: [],
                _meta: {
                  ...sessionSourceRequestMeta(
                    req.sourceType,
                    req.sourceId,
                    daemonOwnedStandaloneRestore
                  ),
                  // Decline decisions known before the child RPC: keep the
                  // child's replay finalize-skip aligned with the re-hang.
                  ...opts.restoreAskUserQuestion === true && (req.clientId === void 0 || options.suppressRestorePrompt === true) ? {
                    [DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY]: true
                  } : {},
                  ...historyReplay === "response" ? {
                    [LOAD_REPLAY_MODE_META_KEY]: LOAD_REPLAY_BULK_MODE,
                    ...historyPageSize !== void 0 ? {
                      [LOAD_REPLAY_PAGE_SIZE_META_KEY]: historyPageSize
                    } : {}
                  } : {},
                  ...hideInheritedHistory ? { [LOAD_REPLAY_HIDE_INHERITED_META_KEY]: true } : {},
                  ...req.suppressWorktreeContextRestore ? {
                    [DAEMON_SUPPRESS_WORKTREE_CONTEXT_RESTORE_META_KEY]: true
                  } : {}
                }
              });
              return await restoreChannel.connection.loadSession(request2);
            }
            const request = telemetry.injectPromptContext({
              sessionId: req.sessionId,
              cwd: workspaceKey,
              mcpServers: [],
              _meta: {
                ...sessionSourceRequestMeta(
                  req.sourceType,
                  req.sourceId,
                  daemonOwnedStandaloneRestore
                ),
                ...opts.restoreAskUserQuestion === true && (req.clientId === void 0 || options.suppressRestorePrompt === true) ? {
                  [DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY]: true
                } : {},
                ...req.suppressWorktreeContextRestore ? {
                  [DAEMON_SUPPRESS_WORKTREE_CONTEXT_RESTORE_META_KEY]: true
                } : {}
              }
            });
            return await restoreChannel.connection.unstable_resumeSession(
              request
            );
          }
        );
        const observedRestore = Promise.race([rawRestore, transportClosed]);
        state = await new Promise((resolve2, reject) => {
          const timer = setTimeout(() => {
            if (restoreLifecycle.phase !== "active") return;
            restoreLifecycle.phase = "abandoned";
            restoreChannel.pendingRestoreIds.delete(req.sessionId);
            restoreChannel.client.markRestoreAbandoned(req.sessionId);
            pendingRestoreEvents.delete(req.sessionId);
            restoreEvents.close();
            restoreChannel.unsettledAbandonedRestores.add(req.sessionId);
            const channelWasEmpty = harness.hasNoChannelWork(
              restoreChannel.harness,
              {
                ignoreRestoreId: req.sessionId
              }
            );
            telemetry.event("session.restore.public_result", {
              "qwen-code.daemon.session_restore.action": action,
              "qwen-code.daemon.session_restore.result": "timeout",
              "qwen-code.daemon.session_restore.timeout_ms": sessionRestoreTimeoutMs,
              "qwen-code.daemon.acp_channel.id": restoreChannel.id,
              "qwen-code.daemon.session_restore.channel_was_empty": channelWasEmpty,
              "session.id": req.sessionId
            });
            writeStderrLine(
              `qwen serve: session/${action} timed out after ${sessionRestoreTimeoutMs}ms for ${JSON.stringify(req.sessionId)} on channel ${restoreChannel.id}; decision=${channelWasEmpty ? "kill_empty" : "fence_shared"}`
            );
            if (channelWasEmpty) {
              void harness.killChannelWithLog(
                restoreChannel.harness,
                `timed-out session/${action} on empty channel`
              );
            } else {
              armRestoreSettlementGrace(restoreChannel, req.sessionId, action);
            }
            reject(
              new SessionRestoreTimeoutError(
                req.sessionId,
                action,
                sessionRestoreTimeoutMs
              )
            );
          }, sessionRestoreTimeoutMs);
          timer.unref();
          void observedRestore.then(
            (value) => {
              if (restoreLifecycle.phase === "active") {
                clearTimeout(timer);
                resolve2(value);
                return;
              }
              void settleAbandonedRestore(restoreChannel, "success");
            },
            (error) => {
              if (restoreLifecycle.phase === "active") {
                clearTimeout(timer);
                reject(error);
                return;
              }
              void settleAbandonedRestore(restoreChannel, "failure");
            }
          );
        });
        if (action === "load" && historyReplay === "response") {
          const extracted = extractLoadReplayResponse(state);
          state = extracted.state;
          replayUpdates = extracted.updates;
          replayPartial = extracted.partial;
          replayError = extracted.replayError;
          replayHasMore = extracted.hasMore === true ? true : void 0;
          replayAnchorRecordId = extracted.anchorRecordId;
        }
        const restoreHint = takeRestoreAskUserQuestionHint(state);
        restoreAskUserQuestionHint = restoreHint.hint;
        state = restoreHint.state;
      } catch (err) {
        if (err instanceof SessionRestoreTimeoutError) throw err;
        restoreEvents.close();
        if (isAcpSessionResourceNotFound(err, req.sessionId)) {
          if (!ci.harness.isDying && harness.hasNoChannelWork(ci.harness, {
            ignoreRestoreId: req.sessionId
          })) {
            await harness.startIdleTimer(
              ci.harness,
              `session ${action} not found`
            );
          }
          throw new SessionNotFoundError(req.sessionId);
        }
        await harness.retireChannelOnTimeout(
          ci.harness,
          err,
          `session ${action} timeout`
        );
        if (!ci.harness.isDying) {
          ci.harness.emptyReapPending = harness.hasNoChannelWork(ci.harness, {
            ignoreRestoreId: req.sessionId
          });
          if (ci.harness.emptyReapPending) {
            ci.harness.isDying = true;
          }
        }
        throw err;
      }
      if (shuttingDown) {
        restoreEvents.close();
        throw new Error("AcpSessionBridge is shutting down");
      }
      if (ci.harness.isDying || !harness.has(ci.harness)) {
        restoreEvents.close();
        throw new Error(
          `Session ${req.sessionId} restored on a closed agent channel`
        );
      }
      const racedEntry = byId.get(req.sessionId);
      if (racedEntry) {
        restoreEvents.close();
        assertAttachableSessionEntry(req.sessionId, racedEntry);
        racedEntry.attachCount += 1 + coalesceState.count;
        const clientId2 = registerClient(racedEntry, req.clientId);
        recordAttachRef(racedEntry, clientId2);
        let previousApprovalMode2;
        if (req.approvalMode) {
          try {
            const result = await applyApprovalMode(
              racedEntry,
              req.approvalMode,
              false,
              clientId2
            );
            previousApprovalMode2 = result.previous;
          } catch (err) {
            await rollbackAttachRegistration(
              racedEntry,
              clientId2,
              1 + coalesceState.count
            );
            throw err;
          }
          try {
            assertAttachableSessionEntry(req.sessionId, racedEntry);
          } catch (error) {
            await rollbackApprovalModeForRejectedAttach(
              racedEntry,
              previousApprovalMode2,
              clientId2
            );
            await rollbackAttachRegistration(
              racedEntry,
              clientId2,
              1 + coalesceState.count
            );
            throw error;
          }
        }
        let restorePromptAdmitted2 = false;
        if (options.deferRestorePrompt !== true) {
          restorePromptAdmitted2 = deferOrFireRestoreAskUserQuestionPrompt(
            racedEntry,
            restoreAskUserQuestionHint,
            req.clientId,
            clientId2,
            options
          );
        }
        const sourcePersisted2 = await applyRestoreSourceIfMissing(
          racedEntry,
          req
        );
        try {
          assertAttachableSessionEntry(req.sessionId, racedEntry);
        } catch (error) {
          if (previousApprovalMode2 !== void 0) {
            await rollbackApprovalModeForRejectedAttach(
              racedEntry,
              previousApprovalMode2,
              clientId2
            );
          }
          await rollbackAttachRegistration(
            racedEntry,
            clientId2,
            1 + coalesceState.count
          );
          throw error;
        }
        if (options.deferRestorePrompt === true) {
          restorePromptAdmitted2 = deferOrFireRestoreAskUserQuestionPrompt(
            racedEntry,
            restoreAskUserQuestionHint,
            req.clientId,
            clientId2,
            options
          );
        }
        return {
          sessionId: racedEntry.sessionId,
          workspaceCwd: racedEntry.workspaceCwd,
          ...racedEntry.effectiveCwd !== racedEntry.workspaceCwd ? { currentCwd: racedEntry.effectiveCwd } : {},
          attached: true,
          clientId: clientId2,
          createdAt: racedEntry.createdAt,
          ...racedEntry.sourceType ? { sourceType: racedEntry.sourceType } : {},
          ...racedEntry.sourceId !== void 0 ? { sourceId: racedEntry.sourceId } : {},
          state: racedEntry.restoreState ?? {},
          hasRunningBackgroundTasks: racedEntry.hasRunningBackgroundTasks,
          hasActivePrompt: restorePromptAdmitted2 || racedEntry.promptActive || racedEntry.goalTurnActive === true || !!racedEntry.backgroundTurn,
          ...racedEntry.backgroundTurn ? { backgroundTurn: racedEntry.backgroundTurn } : {},
          ...sourcePersisted2 !== void 0 ? { sourcePersisted: sourcePersisted2 } : {},
          ...replayFieldsFor(racedEntry, action, liveReplayMode)
        };
      }
      const entry = createSessionEntry(
        ci,
        req.sessionId,
        workspaceKey,
        restoreEvents,
        {
          drainEarlyEvents: replayUpdates.length === 0,
          lifecycleReason: action,
          // Re-seed the persisted parent lineage the caller recovered from the
          // transcript, so a restored sub-session's status reports its parent.
          ...req.parentSessionId ? { parentSessionId: req.parentSessionId } : {},
          ...req.sourceType ? { sourceType: req.sourceType } : {},
          ...req.sourceId !== void 0 ? { sourceId: req.sourceId } : {}
        }
      );
      releaseAdmissionOnce();
      const restoredArtifactSnapshot = restoredArtifactSnapshotFromState(state);
      const publicState = publicRestoreState(state);
      entry.restoreState = publicState;
      entry.backgroundTurn = parseBackgroundNotificationTurn(
        state._meta?.["backgroundTurn"]
      );
      if (typeof state._meta?.["hasRunningBackgroundTasks"] === "boolean") {
        entry.hasRunningBackgroundTasks = state._meta["hasRunningBackgroundTasks"];
      }
      if (replayPartial === true) {
        entry.restoreReplayPartial = true;
      }
      if (replayError !== void 0) {
        entry.restoreReplayError = replayError;
      }
      if (replayHasMore === true) {
        entry.restoreHistoryHasMore = true;
      }
      if (replayAnchorRecordId !== void 0) {
        entry.restoreHistoryAnchorRecordId = replayAnchorRecordId;
      }
      seedSnapshotCaches(entry, publicState);
      const deferArtifactWorkspace = isReservedStandaloneSessionSourceType(
        entry.sourceType
      );
      const artifactRestoreWarnings = [];
      if (deferArtifactWorkspace) {
        artifactRestoreWarnings.push(
          ...await entry.artifacts.restore(restoredArtifactSnapshot, {
            workspaceAccess: "metadata-only"
          })
        );
        const artifactRestoreFailed2 = artifactRestoreWarnings.some(
          (warning) => isArtifactRestoreFailureWarning(warning)
        );
        entry.pendingArtifactRestore = {
          ...restoredArtifactSnapshot !== void 0 ? { snapshot: restoredArtifactSnapshot } : {},
          replayUpdates: restoredArtifactSnapshot === void 0 || artifactRestoreFailed2 ? replayUpdates : [],
          warnings: artifactRestoreWarnings
        };
      } else {
        artifactRestoreWarnings.push(
          ...await entry.artifacts.restore(restoredArtifactSnapshot)
        );
      }
      for (const warning of artifactRestoreWarnings) {
        writeStderrLine(
          `[artifacts] session=${entry.sessionId} action=restore_warning warning=${JSON.stringify(
            warning
          )}`
        );
      }
      const artifactRestoreFailed = artifactRestoreWarnings.some(
        (warning) => isArtifactRestoreFailureWarning(warning)
      );
      if (replayUpdates.length > 0) {
        await ci.client.seedSessionUpdates(entry, replayUpdates, {
          ingestArtifacts: !deferArtifactWorkspace && (restoredArtifactSnapshot === void 0 || artifactRestoreFailed)
        });
        if (historyPageSize !== void 0 && entry.events.snapshotReplay()?.compactedTurns.some((event) => event.type === "history_truncated")) {
          entry.restoreHistoryHasMore = true;
        }
        ci.client.drainEarlyEvents(entry.sessionId, entry);
      }
      assertAttachableSessionEntry(req.sessionId, entry);
      const clientId = registerClient(entry, req.clientId);
      let previousApprovalMode;
      if (req.approvalMode) {
        previousApprovalMode = await applyApprovalModeForAttach(
          entry,
          req.approvalMode,
          clientId
        );
        assertAttachableSessionEntry(req.sessionId, entry);
      }
      entry.attachCount = coalesceState.count;
      registeredEntry = entry;
      let restorePromptAdmitted = false;
      if (options.deferRestorePrompt !== true) {
        restorePromptAdmitted = deferOrFireRestoreAskUserQuestionPrompt(
          entry,
          restoreAskUserQuestionHint,
          req.clientId,
          clientId,
          options
        );
      }
      const sourcePersisted = entry.sourceType ? await persistSessionSource(
        entry,
        `${entry.sessionId} during session restore`,
        daemonOwnedStandaloneRestore
      ) : void 0;
      try {
        assertAttachableSessionEntry(req.sessionId, entry);
      } catch (error) {
        if (previousApprovalMode !== void 0) {
          await rollbackApprovalModeForRejectedAttach(
            entry,
            previousApprovalMode,
            clientId
          );
        }
        await rollbackAttachRegistration(entry, clientId);
        throw error;
      }
      if (options.deferRestorePrompt === true) {
        restorePromptAdmitted = deferOrFireRestoreAskUserQuestionPrompt(
          entry,
          restoreAskUserQuestionHint,
          req.clientId,
          clientId,
          options
        );
      }
      return {
        sessionId: entry.sessionId,
        workspaceCwd: entry.workspaceCwd,
        attached: false,
        clientId,
        createdAt: entry.createdAt,
        ...entry.sourceType ? { sourceType: entry.sourceType } : {},
        ...entry.sourceId !== void 0 ? { sourceId: entry.sourceId } : {},
        ...sourcePersisted !== void 0 ? { sourcePersisted } : {},
        state: publicState,
        ...deferArtifactWorkspace || artifactRestoreWarnings.length > 0 ? { artifactWarnings: artifactRestoreWarnings } : {},
        hasRunningBackgroundTasks: entry.hasRunningBackgroundTasks,
        hasActivePrompt: restorePromptAdmitted || entry.promptActive || entry.goalTurnActive === true || !!entry.backgroundTurn,
        ...entry.backgroundTurn ? { backgroundTurn: entry.backgroundTurn } : {},
        ...replayFieldsFor(entry, action, liveReplayMode)
      };
    })().finally(async () => {
      if (restoreLifecycle.phase === "abandoned") return;
      releaseAdmissionOnce();
      ci?.pendingRestoreIds.delete(req.sessionId);
      ci?.client.clearRestoreInFlight(req.sessionId);
      pendingRestoreEvents.delete(req.sessionId);
      if (!registeredEntry) {
        restoreEvents.close();
        let removedRestoreEntry = false;
        const restoreEntry = byId.get(req.sessionId);
        if (restoreEntry?.events === restoreEvents) {
          byId.delete(req.sessionId);
          await restoreEntry.attachments.close().catch((error) => {
            writeStderrLine(
              `qwen serve: failed to close attachments after restoring session ${JSON.stringify(req.sessionId)}: ${error instanceof Error ? error.message : String(error)}`
            );
          });
          ci?.sessionIds.delete(req.sessionId);
          emitSessionLifecycle({
            type: "removed",
            sessionId: req.sessionId,
            workspaceCwd: restoreEntry.workspaceCwd,
            reason: "restore_failed"
          });
          removedRestoreEntry = true;
        }
        if (removedRestoreEntry && ci && harness.hasNoChannelWork(ci.harness, {
          ignoreRestoreId: req.sessionId
        })) {
          ci.harness.emptyReapPending = true;
          ci.harness.isDying = true;
        }
        ci?.client.markSessionClosed(req.sessionId);
      }
      if (ci) {
        await harness.reapPendingEmptyChannel(ci.harness);
      }
    });
    void promise.then(
      () => {
        if (restoreLifecycle.phase === "active") {
          telemetry.event("session.restore.public_result", {
            "qwen-code.daemon.session_restore.action": action,
            "qwen-code.daemon.session_restore.result": "success",
            "qwen-code.daemon.session_restore.timeout_ms": sessionRestoreTimeoutMs,
            ...ci ? { "qwen-code.daemon.acp_channel.id": ci.id } : {},
            "session.id": req.sessionId
          });
          resolveSettlement();
        }
      },
      () => {
        if (restoreLifecycle.phase === "active") {
          telemetry.event("session.restore.public_result", {
            "qwen-code.daemon.session_restore.action": action,
            "qwen-code.daemon.session_restore.result": "failure",
            "qwen-code.daemon.session_restore.timeout_ms": sessionRestoreTimeoutMs,
            ...ci ? { "qwen-code.daemon.acp_channel.id": ci.id } : {},
            "session.id": req.sessionId
          });
          resolveSettlement();
        }
      }
    );
    inFlightRestores.set(req.sessionId, {
      action,
      historyReplay,
      ...historyPageSize !== void 0 ? { historyPageSize } : {},
      liveReplayMode,
      hideInheritedHistory,
      publicPromise: promise,
      settlementPromise,
      lifecycle: restoreLifecycle,
      coalesceState
    });
    void settlementPromise.finally(() => {
      const current = inFlightRestores.get(req.sessionId);
      if (current?.settlementPromise === settlementPromise) {
        inFlightRestores.delete(req.sessionId);
        void harness.settleReleasedRuntimeWork("session restore", false);
      }
    });
    return await promise;
  }
  __name(restoreSessionWithReplay, "restoreSessionWithReplay");
  async function closeSessionImpl(sessionId, context, closeOpts) {
    const entry = byId.get(sessionId);
    if (!entry) throw new SessionNotFoundError(sessionId);
    if (entry.closing) {
      throw new SessionNotFoundError(
        sessionId,
        "The session is already closing",
        "session_closing"
      );
    }
    let originatorClientId;
    if (context?.clientId !== void 0) {
      originatorClientId = resolveTrustedClientId(entry, context.clientId);
    }
    entry.closing = true;
    const deferredCloseStamp = entry.promptSettledAt;
    clearPromptSettledClose(entry);
    const reason = closeOpts?.reason ?? "client_close";
    writeStderrLine(
      `qwen serve: closing session ${JSON.stringify(sessionId)} (reason: ${reason})` + (originatorClientId ? ` by client ${JSON.stringify(originatorClientId)}` : "")
    );
    telemetry.event("session.close", {
      "qwen-code.daemon.bridge.operation": "session.close",
      "session.id": sessionId,
      "session.close.reason": reason
    });
    const ci = channelInfoForEntry(entry);
    if (!ci) {
      writeStderrLine(
        `qwen serve: closeSession channelInfoForEntry returned undefined for session ${JSON.stringify(sessionId)} \u2014 channel cleanup skipped (entry's channel already torn down)`
      );
    }
    let agentSessionClosed = false;
    try {
      permissionMediator.forgetSession(sessionId);
      entry.pendingPermissionIds.clear();
      entry.pendingInteractions.clear();
      agentSessionClosed = await notifyAgentSessionClose(
        entry,
        ci,
        "closeSession",
        {
          throwOnFailure: true,
          requireFlush: closeOpts?.requireAgentClose === true,
          ...closeOpts?.agentCloseTimeoutMs !== void 0 ? { timeoutMs: closeOpts.agentCloseTimeoutMs } : {}
        }
      );
    } catch (error) {
      if (isDefinitiveAcpRequestError(error)) {
        entry.closing = false;
        if (deferredCloseStamp !== null) {
          entry.promptSettledAt = deferredCloseStamp;
        }
      } else if (ci) {
        await harness.killChannelWithLog(
          ci.harness,
          `recover unknown close outcome for session ${JSON.stringify(sessionId)}`
        );
      } else {
        entry.closing = false;
      }
      throw error;
    }
    if (defaultEntry === entry) defaultEntry = void 0;
    if (ci && ci.channel === entry.channel) {
      ci.sessionIds.delete(sessionId);
    }
    if (entry.promptActive) {
      entry.promptActive = false;
      activePromptCounter--;
      touchActivity();
    }
    byId.delete(sessionId);
    telemetry.metrics?.sessionLifecycle("close");
    emitSessionLifecycle({
      type: "removed",
      sessionId,
      workspaceCwd: entry.workspaceCwd,
      reason
    });
    ci?.client.markSessionClosed(sessionId);
    flushPromptTerminals(
      entry,
      "session_closed",
      "session closed before the prompt completed"
    );
    try {
      entry.events.publish({
        type: "session_closed",
        data: {
          sessionId,
          reason,
          // `data.closedBy` is kept for back-compat with existing
          // wire consumers; new code should read envelope-level
          // `originatorClientId` (matches `session_metadata_updated`,
          // `model_switched`, `approval_mode_changed`, etc.).
          ...originatorClientId ? { closedBy: originatorClientId } : {}
        },
        ...originatorClientId ? { originatorClientId } : {}
      });
    } catch {
    }
    entry.events.close();
    await entry.attachments.close().catch((error) => {
      writeStderrLine(
        `qwen serve: failed to close attachments for session ${JSON.stringify(sessionId)}: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    if (!agentSessionClosed) {
      try {
        const cancelActivePrompt = /* @__PURE__ */ __name(() => telemetry.withSpan(
          "session.close.cancel_active_prompt",
          {
            "qwen-code.daemon.bridge.operation": "session.close.cancel_active_prompt",
            "session.id": sessionId
          },
          async () => await withTimeout(
            entry.connection.cancel({ sessionId }),
            initTimeoutMs,
            "closeSession cancel"
          )
        ), "cancelActivePrompt");
        if (ci) {
          await harness.withWorkspaceControl(ci.harness, cancelActivePrompt);
        } else {
          await cancelActivePrompt();
        }
      } catch {
      }
    }
    if (ci && harness.hasNoChannelWork(ci.harness)) {
      await harness.reapPendingEmptyChannel(ci.harness);
      if (!ci.harness.isDying) {
        await harness.startIdleTimer(ci.harness, `closeSession "${sessionId}"`);
      }
    }
  }
  __name(closeSessionImpl, "closeSessionImpl");
  startSessionReaper();
  const rememberMidTurnId = /* @__PURE__ */ __name((ring, messageId) => {
    ring.push(messageId);
    if (ring.length > MID_TURN_RECONCILIATION_RING_SIZE) {
      ring.splice(0, ring.length - MID_TURN_RECONCILIATION_RING_SIZE);
    }
  }, "rememberMidTurnId");
  const promoteMidTurnMessage = /* @__PURE__ */ __name((entry, messageId, text, originatorClientId, content, eventDetailMode) => {
    const resolvableBlocks = [];
    let degraded = 0;
    for (const block of content ?? []) {
      try {
        entry.attachments.assertReference(block);
        resolvableBlocks.push(block);
      } catch (error) {
        if (!(error instanceof SessionAttachmentReferenceError)) throw error;
        degraded += 1;
      }
    }
    let prompt = [
      ...text ? [{ type: "text", text }] : [],
      ...resolvableBlocks
    ];
    if (degraded > 0) {
      prompt = withAttachmentDegradationMarker(prompt);
    }
    const context = {
      promptId: messageId,
      promotedMidTurn: { originatorClientId },
      onPromptAdmitted: /* @__PURE__ */ __name(() => {
        rememberMidTurnId(entry.promotedMidTurnMessageIds, messageId);
      }, "onPromptAdmitted")
    };
    const sendFallback = /* @__PURE__ */ __name(() => bridgeApi.sendPrompt(
      entry.sessionId,
      {
        sessionId: entry.sessionId,
        eventDetailMode,
        prompt: withAttachmentDegradationMarker(
          text ? [{ type: "text", text }] : []
        )
      },
      void 0,
      context
    ), "sendFallback");
    let result;
    try {
      result = bridgeApi.sendPrompt(
        entry.sessionId,
        {
          sessionId: entry.sessionId,
          eventDetailMode,
          prompt
        },
        void 0,
        context
      );
    } catch (error) {
      try {
        if (!(error instanceof SessionAttachmentReferenceError)) throw error;
        result = sendFallback();
      } catch (fallbackError) {
        writeStderrLine(
          `[mid-turn] session=${JSON.stringify(entry.sessionId)} failed to run promoted message ${JSON.stringify(messageId)}: ${JSON.stringify(fallbackError instanceof Error ? fallbackError.message : String(fallbackError))}`
        );
        return;
      }
    }
    void result.catch((error) => {
      writeStderrLine(
        `[mid-turn] session=${JSON.stringify(entry.sessionId)} failed to run promoted message ${JSON.stringify(messageId)}: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`
      );
    });
  }, "promoteMidTurnMessage");
  const settleUndrainedMidTurnMessages = /* @__PURE__ */ __name((entry, messages) => {
    for (const message of messages) {
      if (message.queueOnly) {
        try {
          message.onSettledWithoutDrain?.();
        } catch (error) {
          writeStderrLine(
            `[mid-turn] session=${JSON.stringify(entry.sessionId)} failed to hand undrained queue-only message ${JSON.stringify(message.messageId)} back to its caller: ${JSON.stringify(error instanceof Error ? error.message : String(error))}`
          );
        }
        continue;
      }
      promoteMidTurnMessage(
        entry,
        message.messageId,
        message.text,
        message.originatorClientId,
        message.content,
        message.eventDetailMode
      );
    }
  }, "settleUndrainedMidTurnMessages");
  const settleMidTurnQueueAfterAutomaticTurn = /* @__PURE__ */ __name((sessionId) => {
    const entry = byId.get(sessionId);
    if (!entry) return;
    advanceTurnActivity(entry);
    entry.sessionLastSeenAt = Date.now();
    touchActivity();
    if (entry.goalTurnActive === true || entry.backgroundTurn !== void 0 || entry.pendingPromptCount > 0 || entry.closing) {
      return;
    }
    const undrained = entry.midTurnMessageQueue.splice(0);
    if (undrained.length === 0) return;
    settleUndrainedMidTurnMessages(entry, undrained);
  }, "settleMidTurnQueueAfterAutomaticTurn");
  const trustedStandaloneSpawnRequests = /* @__PURE__ */ new WeakMap();
  const bridgeApi = {
    // Derived once from the frozen overrides and the configured channel
    // factory; immutable for the bridge's lifetime.
    mandatoryLeaseAttested,
    setLiveScreenContextCaptureHandler(handler) {
      liveScreenContextCaptureHandler = handler;
    },
    setLiveTaskToolRequestHandler(handler) {
      liveTaskToolRequestHandler = handler;
    },
    setLiveSpeakToUserHandler(handler) {
      liveSpeakToUserHandler = handler;
    },
    getDaemonStatusSnapshot() {
      return {
        limits: {
          maxSessions: maxSessions === Infinity ? null : maxSessions,
          maxPendingPromptsPerSession: maxPendingPromptsPerSession === Infinity ? null : maxPendingPromptsPerSession,
          eventRingSize,
          compactedReplayMaxBytes,
          maxJournalEvents,
          maxJournalBytes,
          journalGrowth: journalGrowthPoolBytes !== void 0 ? {
            poolBytes: journalGrowthPoolBytes,
            hardCapBytes: JOURNAL_GROWTH_HARD_CAP_BYTES
          } : null,
          channelIdleTimeoutMs: harness.configuredChannelIdleTimeoutMs(),
          sessionIdleTimeoutMs,
          sessionPromptSettledCloseGraceMs
        },
        sessionCount: byId.size,
        pendingPermissionCount: permissionMediator.pendingCount,
        channelLive: !!liveChannelInfo(),
        permissionPolicy: permissionMediator.policy,
        sessions: [...byId.values()].map((entry) => {
          const journalLimits = entry.events.journalLimits();
          return {
            sessionId: entry.sessionId,
            workspaceCwd: entry.workspaceCwd,
            createdAt: entry.createdAt,
            ...entry.displayName ? { displayName: entry.displayName } : {},
            clientCount: entry.clientIds.size,
            subscriberCount: entry.events.subscriberCount,
            attachCount: entry.attachCount,
            pendingPromptCount: entry.pendingPromptCount,
            pendingPermissionCount: entry.pendingPermissionIds.size,
            hasActivePrompt: hasInFlightPromptActivity(entry),
            hasRunningBackgroundTasks: entry.hasRunningBackgroundTasks,
            ...entry.backgroundTurn ? { backgroundTurn: entry.backgroundTurn } : {},
            lastEventId: entry.events.lastEventId,
            ...entry.sessionLastSeenAt !== void 0 ? { lastSeenAt: entry.sessionLastSeenAt } : {},
            ...entry.currentModelId ? { currentModelId: entry.currentModelId } : {},
            ...entry.currentApprovalMode ? { currentApprovalMode: entry.currentApprovalMode } : {},
            ...entry.planExecutionMode ? { planExecutionMode: entry.planExecutionMode } : {},
            maxJournalEvents: journalLimits?.maxEvents ?? maxJournalEvents,
            maxJournalBytes: journalLimits?.maxBytes ?? maxJournalBytes
          };
        })
      };
    },
    get sessionCount() {
      return byId.size;
    },
    get pendingPromptTotal() {
      let total = 0;
      for (const entry of byId.values()) {
        for (const pending of entry.pendingPromptList) {
          if (pending.state === "queued") total += 1;
        }
      }
      return total;
    },
    // Daemon Status child-resource: sync cache read for the sampler + the async
    // refresh it fires each tick to update that cache.
    getChildResourceSnapshot,
    refreshChildResource,
    get activePromptCount() {
      return activePromptCounter;
    },
    get activeWork() {
      for (const entry of byId.values()) {
        if (entryHasActiveWork(entry)) return true;
      }
      return false;
    },
    /**
     * Raw coverage counts rather than a pre-collapsed grade.
     *
     * The grade has to be computed over the whole daemon, not per runtime and
     * then combined: a runtime with zero Sessions is vacuously `full`, and
     * folding that in as evidence made a deployment whose only real Sessions
     * were unreported aggregate to `partial`. Counts compose; grades do not.
     */
    get activeWorkCoverage() {
      let covered = 0;
      let onNegotiatedChannel = 0;
      let total = 0;
      let oldestCoveredReportAt = null;
      for (const entry of byId.values()) {
        total++;
        const owner = channelInfoForEntry(entry);
        const capability = owner?.harness.activeWork;
        if (!capability) continue;
        onNegotiatedChannel++;
        if (ACTIVE_WORK_HOLD_CATEGORIES.some(
          (category) => !capability.categories.includes(category)
        )) {
          continue;
        }
        if (!childHoldsAreFresh(entry, capability)) continue;
        covered++;
        if (entry.childHoldsAt !== null && (oldestCoveredReportAt === null || entry.childHoldsAt < oldestCoveredReportAt)) {
          oldestCoveredReportAt = entry.childHoldsAt;
        }
      }
      return { total, covered, onNegotiatedChannel, oldestCoveredReportAt };
    },
    get lastActivityAt() {
      return lastActivityTimestamp;
    },
    get idleSinceMs() {
      return lastActivityTimestamp !== null ? Date.now() - lastActivityTimestamp : null;
    },
    isChannelLive() {
      return !!liveChannelInfo();
    },
    getWorkspaceRuntimeLifecycleSnapshot() {
      const info = liveChannelInfo();
      const runtimeLive = info !== void 0;
      const sourceRuntimeEpoch = runtimeEpochSource.current();
      if (!Number.isSafeInteger(sourceRuntimeEpoch) || sourceRuntimeEpoch < harness.epoch) {
        throw new Error(
          `Runtime epoch source regressed (local=${harness.epoch}, current=${sourceRuntimeEpoch}).`
        );
      }
      const starting = harness.starting !== void 0;
      const stopping = Array.from(channelInfos()).some(
        (candidate) => candidate.harness.isDying
      );
      const reservedWork = harness.runtimeOperationReservations > 0 || inFlightSpawns.size > 0 || inFlightRestores.size > 0 || abandonedNewSessionSettlements.size > 0 || harness.pendingKeepAliveCount > 0;
      const activeWork = starting || stopping || reservedWork || info !== void 0 && !harness.hasNoChannelWork(info.harness);
      return {
        state: !runtimeLive ? stopping ? "stopping" : starting ? "starting" : "cold" : activeWork ? "active" : "idle",
        runtimeLive,
        runtimeEpoch: runtimeLive ? harness.epoch : sourceRuntimeEpoch,
        activeWork
      };
    },
    getIdleChannelCandidate() {
      const info = liveChannelInfo();
      if (shuttingDown || !info || byId.size > 0 || channelShouldReapWhenIdle(info) || bridgeApi.getWorkspaceRuntimeLifecycleSnapshot().activeWork) {
        return void 0;
      }
      return {
        channelId: info.id,
        runtimeEpoch: harness.epoch,
        lastUsedAt: info.harness.lastUsedAt
      };
    },
    async reclaimIdleChannel(candidate, signal) {
      if (signal?.aborted) return false;
      const current = bridgeApi.getIdleChannelCandidate();
      if (!current || current.channelId !== candidate.channelId || current.runtimeEpoch !== candidate.runtimeEpoch || current.lastUsedAt !== candidate.lastUsedAt) {
        return false;
      }
      await harness.reclaimIdleChannel(liveChannelInfo().harness);
      return true;
    },
    get pendingPermissionCount() {
      return permissionMediator.pendingCount;
    },
    get permissionPolicy() {
      return permissionMediator.policy;
    },
    async loadSession(req) {
      return restoreSession("load", req, {
        ...req.deferRestoreAskUserQuestionPrompt ? { deferRestorePrompt: true } : {}
      });
    },
    async resumeSession(req) {
      return restoreSession("resume", req, {
        ...req.deferRestoreAskUserQuestionPrompt ? { deferRestorePrompt: true } : {}
      });
    },
    async spawnStandaloneSession(req) {
      const spawnRequest = {
        workspaceCwd: req.workspaceCwd,
        sessionId: req.sessionId,
        sessionScope: "thread",
        sourceType: STANDALONE_SESSION_SOURCE_TYPE,
        ...req.parentSessionId !== void 0 ? { parentSessionId: req.parentSessionId } : {},
        ...req.modelServiceId !== void 0 ? { modelServiceId: req.modelServiceId } : {},
        ...req.approvalMode !== void 0 ? { approvalMode: req.approvalMode } : {}
      };
      const state = { dispatched: false };
      trustedStandaloneSpawnRequests.set(spawnRequest, state);
      try {
        return await bridgeApi.spawnOrAttach(spawnRequest);
      } catch (error) {
        throw new StandaloneSessionSpawnError(state.dispatched, error);
      }
    },
    async restoreStandaloneSession(action, req) {
      return restoreSession(
        action,
        {
          ...req,
          sourceType: STANDALONE_SESSION_SOURCE_TYPE
        },
        { daemonOwnedStandaloneRestore: true }
      );
    },
    async spawnOrAttach(req) {
      if (shuttingDown) {
        throw new Error("AcpSessionBridge is shutting down");
      }
      const workspaceKey = resolveWorkspaceKey(req.workspaceCwd);
      const trustedStandaloneSpawn = trustedStandaloneSpawnRequests.get(req);
      trustedStandaloneSpawnRequests.delete(req);
      const daemonOwnedStandaloneCreation = trustedStandaloneSpawn !== void 0;
      if (req.sessionScope !== void 0 && req.sessionScope !== "single" && req.sessionScope !== "thread") {
        throw new InvalidSessionScopeError(req.sessionScope);
      }
      const effectiveScope = req.sessionId !== void 0 ? "thread" : req.sessionScope ?? defaultSessionScope;
      const source = parseSessionSource(req.sourceType, req.sourceId);
      if ("error" in source) {
        throw new InvalidSessionMetadataError("sourceType", source.error);
      }
      if (isReservedStandaloneSessionSourceType(source.sourceType) && !daemonOwnedStandaloneCreation) {
        throw new InvalidSessionMetadataError(
          "sourceType",
          "`standalone` is reserved for daemon-owned session creation"
        );
      }
      if (req.approvalMode !== void 0 && !KNOWN_APPROVAL_MODES.has(req.approvalMode)) {
        throw new Error(
          `Invalid approvalMode: ${JSON.stringify(req.approvalMode)}`
        );
      }
      if (effectiveScope === "single") {
        const existing = defaultEntry;
        if (existing) {
          assertAttachableSessionEntry(existing.sessionId, existing);
          existing.attachCount++;
          const clientId = registerClient(existing, req.clientId);
          recordAttachRef(existing, clientId);
          if (req.modelServiceId) {
            await applyModelServiceId(
              existing,
              req.modelServiceId,
              initTimeoutMs,
              clientId
            ).catch(() => {
            });
          }
          let previousApprovalMode;
          if (req.approvalMode) {
            previousApprovalMode = await applyApprovalModeForAttach(
              existing,
              req.approvalMode,
              clientId
            );
          }
          try {
            assertAttachableSessionEntry(existing.sessionId, existing);
          } catch (error) {
            if (previousApprovalMode !== void 0) {
              await rollbackApprovalModeForRejectedAttach(
                existing,
                previousApprovalMode,
                clientId
              );
            }
            await rollbackAttachRegistration(existing, clientId);
            throw error;
          }
          return {
            sessionId: existing.sessionId,
            workspaceCwd: existing.workspaceCwd,
            ...existing.effectiveCwd !== existing.workspaceCwd ? { currentCwd: existing.effectiveCwd } : {},
            attached: true,
            clientId,
            createdAt: existing.createdAt,
            ...existing.sourceType ? { sourceType: existing.sourceType } : {},
            ...existing.sourceId !== void 0 ? { sourceId: existing.sourceId } : {},
            hasRunningBackgroundTasks: existing.hasRunningBackgroundTasks,
            hasActivePrompt: existing.promptActive || existing.goalTurnActive === true || !!existing.backgroundTurn,
            ...existing.backgroundTurn ? { backgroundTurn: existing.backgroundTurn } : {}
          };
        }
        const inFlight = inFlightSpawns.get(workspaceKey);
        if (inFlight) {
          const session = await inFlight;
          const attachedEntry = byId.get(session.sessionId);
          if (!attachedEntry) {
            throw new SessionNotFoundError(
              session.sessionId,
              "the agent child likely crashed during initialization \u2014 retry to spawn a new session"
            );
          }
          assertAttachableSessionEntry(session.sessionId, attachedEntry);
          attachedEntry.attachCount++;
          const clientId = registerClient(attachedEntry, req.clientId);
          recordAttachRef(attachedEntry, clientId);
          if (req.modelServiceId) {
            await applyModelServiceId(
              attachedEntry,
              req.modelServiceId,
              initTimeoutMs,
              clientId
            ).catch(() => {
            });
          }
          let previousApprovalMode;
          if (req.approvalMode) {
            previousApprovalMode = await applyApprovalModeForAttach(
              attachedEntry,
              req.approvalMode,
              clientId
            );
          }
          try {
            assertAttachableSessionEntry(session.sessionId, attachedEntry);
          } catch (error) {
            if (previousApprovalMode !== void 0) {
              await rollbackApprovalModeForRejectedAttach(
                attachedEntry,
                previousApprovalMode,
                clientId
              );
            }
            await rollbackAttachRegistration(attachedEntry, clientId);
            throw error;
          }
          return {
            ...session,
            attached: true,
            clientId,
            hasRunningBackgroundTasks: attachedEntry.hasRunningBackgroundTasks,
            hasActivePrompt: attachedEntry.promptActive || attachedEntry.goalTurnActive === true || !!attachedEntry.backgroundTurn,
            ...attachedEntry.backgroundTurn ? { backgroundTurn: attachedEntry.backgroundTurn } : {}
          };
        }
      }
      if (req.sessionId !== void 0) {
        const restoreOwner = inFlightRestores.get(req.sessionId);
        if (restoreOwner) {
          const abandoned = restoreOwner.lifecycle.phase === "abandoned";
          throw new RestoreInProgressError(
            req.sessionId,
            restoreOwner.action,
            "spawn",
            abandoned ? {
              reason: "awaiting_abandoned_cleanup",
              retryAfterSeconds: abandonedRestoreRetryAfterSeconds
            } : void 0
          );
        }
        if (inFlightSessionIdReservations.has(req.sessionId)) {
          const owner = inFlightSessionIdReservations.get(req.sessionId);
          throw new RestoreInProgressError(
            req.sessionId,
            "spawn",
            "spawn",
            owner !== void 0 && abandonedSessionIdReservations.has(owner.token) ? {
              reason: "awaiting_abandoned_cleanup",
              retryAfterSeconds: abandonedNewSessionRetryAfterSeconds
            } : void 0
          );
        }
      }
      assertFreshSessionsAvailable();
      if (byId.size + inFlightSpawns.size + inFlightRestores.size + abandonedNewSessionSettlements.size >= maxSessions) {
        throw new SessionLimitExceededError(maxSessions);
      }
      const requestedSessionRegistrationOwner = req.sessionId !== void 0 ? Symbol(req.sessionId) : void 0;
      let resolveRequestedSessionSpawnSettlement;
      if (req.sessionId !== void 0 && requestedSessionRegistrationOwner !== void 0) {
        const requestedSessionSpawnSettlement = new Promise((resolve2) => {
          resolveRequestedSessionSpawnSettlement = resolve2;
        });
        inFlightSessionIdReservations.set(req.sessionId, {
          token: requestedSessionRegistrationOwner,
          settlementPromise: requestedSessionSpawnSettlement
        });
      }
      const releaseRequestedSessionRegistration = /* @__PURE__ */ __name(() => {
        if (requestedSessionRegistrationOwner !== void 0) {
          abandonedSessionIdReservations.delete(
            requestedSessionRegistrationOwner
          );
        }
        if (req.sessionId !== void 0 && requestedSessionRegistrationOwner !== void 0 && inFlightSessionIdReservations.get(req.sessionId)?.token === requestedSessionRegistrationOwner) {
          inFlightSessionIdReservations.delete(req.sessionId);
        }
        if (requestedSessionRegistrationOwner !== void 0) {
          resolveRequestedSessionSpawnSettlement?.();
          resolveRequestedSessionSpawnSettlement = void 0;
        }
      }, "releaseRequestedSessionRegistration");
      let admission;
      try {
        admission = reserveFreshSession({
          operation: "spawn",
          workspaceCwd: workspaceKey,
          ...req.sessionId !== void 0 ? { sessionId: req.sessionId } : {}
        });
      } catch (error) {
        releaseRequestedSessionRegistration();
        throw error;
      }
      let admissionReleased = false;
      const releaseAdmissionOnce = /* @__PURE__ */ __name(() => {
        if (admissionReleased) return;
        admissionReleased = true;
        releaseFreshSessionReservation(admission);
      }, "releaseAdmissionOnce");
      let abandonedSettlement;
      const promise = doSpawn(
        req.modelServiceId,
        effectiveScope,
        req.approvalMode,
        req.clientId,
        releaseAdmissionOnce,
        req.parentSessionId,
        source.sourceType,
        source.sourceId,
        req.worktree,
        req.branch,
        req.sessionId,
        daemonOwnedStandaloneCreation,
        trustedStandaloneSpawn ? () => {
          trustedStandaloneSpawn.dispatched = true;
        } : void 0,
        (settlement) => {
          abandonedSettlement = settlement;
          if (requestedSessionRegistrationOwner !== void 0) {
            abandonedSessionIdReservations.add(
              requestedSessionRegistrationOwner
            );
          }
        }
      );
      const tracker = effectiveScope === "single" ? workspaceKey : `${workspaceKey}#${randomUUID3()}`;
      inFlightSpawns.set(tracker, promise);
      try {
        return await promise;
      } finally {
        if (abandonedSettlement) {
          void abandonedSettlement.then(
            () => {
              releaseAdmissionOnce();
              releaseRequestedSessionRegistration();
            },
            () => {
              releaseAdmissionOnce();
              releaseRequestedSessionRegistration();
            }
          );
        } else {
          releaseAdmissionOnce();
          releaseRequestedSessionRegistration();
        }
        inFlightSpawns.delete(tracker);
      }
    },
    // Keep this method non-async: admission failures must throw before
    // HTTP routes return 202.
    sendPrompt(sessionId, req, signal, context) {
      if (req.eventDetailMode !== void 0 && req.eventDetailMode !== "full" && req.eventDetailMode !== "summary") {
        throw RequestError.invalidParams(
          void 0,
          "Invalid eventDetailMode; expected full or summary"
        );
      }
      const eventDetailMode = req.eventDetailMode ?? "full";
      opts.onDiagnosticLine?.(
        `qwen serve: bridge sendPrompt for session=${sessionId}`,
        "info"
      );
      const capturedContext = telemetry.captureContext();
      const queuedAt = Date.now();
      const entry = byId.get(sessionId);
      if (!entry) return Promise.reject(new SessionNotFoundError(sessionId));
      if (isClosingOrAuthorizingClose(entry)) {
        return Promise.reject(
          new SessionNotFoundError(
            sessionId,
            "The session is closing; retry after close completes",
            "session_closing"
          )
        );
      }
      if (resetPendingSessions.has(sessionId)) {
        throw new SessionResetPendingError(sessionId);
      }
      if (isReservedStandaloneSessionSourceType(entry.sourceType) && entry.managedConversationBinding?.released !== true) {
        return Promise.reject(standaloneWorkingDirectoryMissingError());
      }
      if (!Array.isArray(req.prompt)) {
        return Promise.reject(
          RequestError.invalidParams(void 0, "Prompt must be an array")
        );
      }
      const promotedMidTurn = context?.promotedMidTurn;
      const isPromotedMidTurn = promotedMidTurn !== void 0;
      const originatorClientId = promotedMidTurn ? promotedMidTurn.originatorClientId : resolveTrustedClientId(entry, context?.clientId);
      entry.attachments.assertReferences(req.prompt);
      const modelPrompt = context?.modelPrompt;
      if (modelPrompt !== void 0 && !isValidTrustedModelPrompt(modelPrompt)) {
        throw new TypeError(
          "Bridge modelPrompt must be a non-empty bounded string."
        );
      }
      if (signal?.aborted) {
        throw new DOMException("Prompt aborted", "AbortError");
      }
      if (!isPromotedMidTurn && entry.pendingPromptCount >= maxPendingPromptsPerSession) {
        throw new PromptQueueFullError(
          maxPendingPromptsPerSession,
          entry.pendingPromptCount,
          sessionId
        );
      }
      entry.pendingPromptCount += 1;
      let promptSlotReleased = false;
      const releasePromptSlot = /* @__PURE__ */ __name(() => {
        if (promptSlotReleased) return;
        promptSlotReleased = true;
        entry.pendingPromptCount = Math.max(0, entry.pendingPromptCount - 1);
      }, "releasePromptSlot");
      const promptId = context?.promptId ?? randomUUID3();
      const invocationContext = Object.freeze({
        version: 1,
        sessionId,
        promptId,
        ...originatorClientId ? { originatorClientId } : {}
      });
      const isQueued = entry.pendingPromptCount > 1;
      const pendingAbort = new AbortController();
      if (signal) {
        if (signal.aborted) {
          pendingAbort.abort(signal.reason);
        } else {
          signal.addEventListener(
            "abort",
            () => pendingAbort.abort(signal.reason),
            { once: true }
          );
        }
      }
      const channelDisplayText = getChannelPromptDisplayText(
        entry,
        context?.promptDisplayText
      );
      const pendingText = channelDisplayText === void 0 ? extractPromptText(req.prompt) : channelDisplayText || (req.prompt.some(
        (block) => isRecord7(block) && block["type"] === "image"
      ) ? "[image]" : "");
      const pendingEntry = {
        eventDetailMode,
        promptId,
        queuedAt,
        ...originatorClientId !== void 0 ? { originatorClientId } : {},
        ...isPromotedMidTurn ? { promotedMidTurn: true } : {},
        text: pendingText,
        content: extractMediaBlocks(req.prompt),
        abortController: pendingAbort,
        state: isQueued ? "queued" : "running"
      };
      entry.pendingPromptList.push(pendingEntry);
      let tailUuid;
      try {
        tailUuid = entry.promptLedger?.transcriptTailUuid?.(sessionId);
      } catch (error) {
        opts.onDiagnosticLine?.(
          `qwen serve: prompt ledger dispatch marker failed for session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          "warn"
        );
      }
      appendPromptLedgerBestEffort(entry, {
        v: 1,
        promptId,
        state: "in_flight",
        ...tailUuid !== void 0 ? { tailUuid } : {},
        at: queuedAt
      });
      try {
        context?.onPromptAdmitted?.();
      } catch (error) {
        opts.onDiagnosticLine?.(
          `qwen serve: prompt admission observer failed for session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
          "warn"
        );
      }
      const deadlineMs = context?.deadlineMs;
      const hasDeadline = typeof deadlineMs === "number" && Number.isFinite(deadlineMs) && deadlineMs > 0;
      let deadlineReject;
      let deadlinePromise;
      let deadlineTimer;
      if (hasDeadline) {
        deadlinePromise = new Promise((_resolve, reject) => {
          deadlineReject = reject;
        });
        deadlinePromise.catch(() => {
        });
        pendingEntry.cancelForwardDeadline = deadlinePromise.then(
          () => void 0,
          () => void 0
        );
        const onDeadline = /* @__PURE__ */ __name(() => {
          if (pendingEntry.terminalPublished) return;
          const deadlineErr = new PromptDeadlineExceededError(deadlineMs);
          writeStderrLine(
            `sendPrompt: prompt ${promptId} exceeded ${deadlineMs}ms deadline for session ${sessionId}; agent may still be executing`
          );
          publishPromptTerminal(entry, pendingEntry, {
            kind: "error",
            err: {
              code: "prompt_deadline_exceeded",
              message: deadlineErr.message
            }
          });
          settleActivePromptState(entry, pendingEntry.promptId);
          deadlineReject?.(deadlineErr);
          pendingAbort.abort(deadlineErr);
        }, "onDeadline");
        deadlineTimer = setTimeout(onDeadline, deadlineMs);
        deadlineTimer.unref();
      }
      if (isQueued) {
        pendingAbort.signal.addEventListener(
          "abort",
          () => {
            if (pendingEntry.state !== "queued") return;
            const waitingOwnerPromptId = entry.todoStopGuardAwaitingQueuedPromptOwnerPromptId;
            if (!waitingOwnerPromptId) return;
            const hasAnotherQueuedPrompt = entry.pendingPromptList.some(
              (candidate) => candidate !== pendingEntry && candidate.state === "queued" && !candidate.abortController.signal.aborted
            );
            if (hasAnotherQueuedPrompt) return;
            delete entry.todoStopGuardAwaitingQueuedPromptOwnerPromptId;
            void entry.connection.extMethod(TODO_STOP_GUARD_QUEUE_RELEASE_METHOD, {
              sessionId,
              promptId: waitingOwnerPromptId
            }).catch((error) => {
              writeStderrLine(
                `qwen serve: Todo Stop Guard queued-prompt release failed for ${JSON.stringify(sessionId)}: ${error instanceof Error ? error.message : String(error)}`
              );
            });
          },
          { once: true }
        );
        entry.events.publish({
          type: "pending_prompt_added",
          promptId: pendingEntry.promptId,
          data: {
            sessionId,
            promptId: pendingEntry.promptId,
            text: pendingEntry.text,
            queuedAt: pendingEntry.queuedAt
          },
          ...originatorClientId ? { originatorClientId } : {}
        });
      }
      const result = entry.promptQueue.then(
        () => telemetry.runWithContext(capturedContext, async () => {
          const queueWaitMs = Date.now() - queuedAt;
          telemetry.metrics?.promptQueueWait(queueWaitMs);
          if (pendingAbort.signal.aborted) {
            if (pendingAbort.signal.reason instanceof PromptDeadlineExceededError) {
              throw pendingAbort.signal.reason;
            }
            throw new DOMException("Prompt aborted", "AbortError");
          }
          if (isReservedStandaloneSessionSourceType(entry.sourceType) && entry.managedConversationBinding?.released !== true) {
            throw standaloneWorkingDirectoryMissingError();
          }
          pendingEntry.startedAt = Date.now();
          if (pendingEntry.state === "queued" || isPromotedMidTurn) {
            if (pendingEntry.state === "queued") {
              delete entry.todoStopGuardAwaitingQueuedPromptOwnerPromptId;
              pendingEntry.state = "running";
            }
            entry.events.publish({
              type: "pending_prompt_started",
              promptId: pendingEntry.promptId,
              data: {
                sessionId,
                promptId: pendingEntry.promptId,
                text: pendingEntry.text
              },
              ...originatorClientId ? { originatorClientId } : {}
            });
          }
          const dispatchStartMs = Date.now();
          try {
            return await telemetry.withSpan(
              "prompt.dispatch",
              {
                "qwen-code.daemon.bridge.operation": "prompt.dispatch",
                "session.id": sessionId,
                "qwen-code.daemon.prompt.queue_wait_ms": queueWaitMs,
                ...context?.clientId ? { "qwen-code.client_id": context.clientId } : {}
              },
              async () => {
                let dispatchBlocks = req.prompt;
                let resolvedPrompt;
                try {
                  resolvedPrompt = await entry.attachments.resolveContent(dispatchBlocks);
                } catch (error) {
                  if (!isPromotedMidTurn || !(error instanceof SessionAttachmentReferenceError)) {
                    throw error;
                  }
                  const perBlock = await entry.attachments.resolveContentDegrading(
                    dispatchBlocks
                  );
                  dispatchBlocks = perBlock.retainedBlocks;
                  resolvedPrompt = withAttachmentDegradationMarker(
                    perBlock.resolvedBlocks
                  );
                }
                const normalized = telemetry.injectPromptContext(
                  {
                    ...req,
                    sessionId,
                    prompt: resolvedPrompt
                  }
                );
                assertLivePromptEntry(sessionId, entry);
                const requestedRetry = req.retry === true;
                const isRetry = requestedRetry && entry.retryAllowed;
                entry.retryAllowed = false;
                const isContinue = context?.continue === true;
                const isRestoreAskUserQuestion = context?.restoreAskUserQuestion === true;
                const promptRequest = (() => {
                  const copy = {
                    ...normalized
                  };
                  delete copy.retry;
                  delete copy.delivery;
                  delete copy.eventDetailMode;
                  const meta = copy._meta && typeof copy._meta === "object" ? { ...copy._meta } : {};
                  const promptDisplayText = channelDisplayText;
                  const channelOutputMode = meta[CHANNEL_OUTPUT_MODE_META_KEY];
                  delete meta[DAEMON_RETRY_META_KEY];
                  delete meta[INVOCATION_CONTEXT_META_KEY];
                  delete meta[PRIVATE_PARENT_CAPABILITY_META_KEY];
                  delete meta[DAEMON_CONTINUE_META_KEY];
                  delete meta[DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY];
                  delete meta[DAEMON_CHANNEL_DELIVERY_META_KEY];
                  delete meta[DAEMON_PROMPT_DISPLAY_TEXT_META_KEY];
                  delete meta[SUBMITTED_PROMPT_META_KEY];
                  delete meta[DAEMON_SUBMITTED_PROMPT_META_KEY];
                  if (typeof context?.submittedPrompt === "string" && !isPromotedMidTurn && context?.channelPrompt !== true) {
                    meta[DAEMON_SUBMITTED_PROMPT_META_KEY] = context.submittedPrompt;
                  }
                  delete meta[DAEMON_MODEL_PROMPT_META_KEY];
                  delete meta[DAEMON_ATTACHMENT_REFERENCES_META_KEY];
                  delete meta[CHANNEL_PROMPT_META_KEY];
                  delete meta[CHANNEL_OUTPUT_MODE_META_KEY];
                  delete meta["qwen.goalProposalApproval"];
                  if (originatorClientId !== void 0 && entry.clientIds.has(originatorClientId) && !context?.channelPrompt && !isContinue && !isRestoreAskUserQuestion) {
                    meta["qwen.goalProposalApproval"] = true;
                  }
                  if (isRetry) {
                    meta[DAEMON_RETRY_META_KEY] = true;
                  }
                  if (isContinue) {
                    meta[DAEMON_CONTINUE_META_KEY] = true;
                  }
                  if (isRestoreAskUserQuestion) {
                    meta[DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY] = true;
                  }
                  if (context?.channelDelivery) {
                    meta[DAEMON_CHANNEL_DELIVERY_META_KEY] = context.channelDelivery;
                  }
                  if (promptDisplayText !== void 0) {
                    meta[DAEMON_PROMPT_DISPLAY_TEXT_META_KEY] = promptDisplayText;
                  }
                  if (modelPrompt !== void 0) {
                    meta[DAEMON_MODEL_PROMPT_META_KEY] = modelPrompt;
                  }
                  const attachmentReferences = dispatchBlocks.filter(
                    isSessionAttachmentReference
                  );
                  if (attachmentReferences.length > 0) {
                    meta[DAEMON_ATTACHMENT_REFERENCES_META_KEY] = attachmentReferences;
                  }
                  if (context?.channelPrompt === true) {
                    meta[CHANNEL_PROMPT_META_KEY] = true;
                    if (channelOutputMode === "per_task") {
                      meta[CHANNEL_OUTPUT_MODE_META_KEY] = channelOutputMode;
                    }
                  }
                  meta[INVOCATION_CONTEXT_META_KEY] = invocationContext;
                  if (Object.keys(meta).length > 0) {
                    copy._meta = meta;
                  } else {
                    delete copy._meta;
                  }
                  return copy;
                })();
                entry.events.setEventDetailMode(eventDetailMode);
                entry.backgroundStartsSuspended = false;
                let resolveTerminal;
                entry.activePromptTerminal = {
                  promptId: pendingEntry.promptId,
                  promise: new Promise((resolve2) => {
                    resolveTerminal = resolve2;
                  }),
                  resolve: /* @__PURE__ */ __name(() => resolveTerminal(), "resolve")
                };
                if (pendingEntry.terminalPublished) {
                  entry.activePromptTerminal.resolve();
                }
                entry.promptActive = true;
                entry.goalTurnActive = false;
                entry.activePromptId = pendingEntry.promptId;
                delete entry.cancelBroadcastWithoutPrompt;
                delete entry.turnError;
                delete entry.turnErrorEvent;
                activePromptCounter++;
                entry.sessionLastSeenAt = Date.now();
                touchActivity();
                if (originatorClientId === void 0) {
                  delete entry.activePromptOriginatorClientId;
                } else {
                  entry.activePromptOriginatorClientId = originatorClientId;
                }
                try {
                  if (!isRetry && !isContinue && !isRestoreAskUserQuestion) {
                    echoPromptToSessionBus(
                      entry,
                      {
                        ...promptRequest,
                        prompt: dispatchBlocks
                      },
                      pendingEntry.promptId,
                      originatorClientId,
                      channelDisplayText
                    );
                  }
                } catch (echoErr) {
                  settleActivePromptState(entry, pendingEntry.promptId);
                  throw echoErr;
                }
                pendingEntry.dispatched = true;
                const precedingBackgroundTurnId = entry.backgroundTurn?.turnId;
                const promptPromise = entry.connection.prompt(promptRequest).then((response) => {
                  if (precedingBackgroundTurnId && byId.get(sessionId) === entry)
                    channelInfoForEntry(entry)?.client.finishBackgroundTurn(
                      sessionId,
                      precedingBackgroundTurnId,
                      "end_turn"
                    );
                  return response;
                }).finally(() => {
                  settleActivePromptState(entry, pendingEntry.promptId);
                });
                const racedPromise = deadlinePromise ? Promise.race([
                  promptPromise,
                  getTransportClosedReject(entry),
                  deadlinePromise
                ]) : Promise.race([
                  promptPromise,
                  getTransportClosedReject(entry)
                ]);
                void racedPromise.then(
                  () => {
                  },
                  (err) => {
                    if (err instanceof PromptDeadlineExceededError) {
                      return;
                    }
                    if (err instanceof DOMException && err.name === "AbortError" && pendingEntry.state === "queued") {
                      writeStderrLine(
                        `sendPrompt: queued prompt removed before agent forward for session ${sessionId}`
                      );
                      return;
                    }
                    if (extractJsonRpcErrorField(err, "errorKind")) {
                      cancelPendingForSession(sessionId);
                      return;
                    }
                    writeStderrLine(
                      `sendPrompt: forward failed for session ${sessionId}: ${extractErrorMessage(err)}`
                    );
                    broadcastPromptCancelledOnce(
                      entry,
                      sessionId,
                      pendingEntry.promptId,
                      originatorClientId,
                      "forward_failed"
                    );
                    cancelPendingForSession(sessionId);
                  }
                ).catch(() => {
                });
                const abortSignal = pendingAbort.signal;
                const onAbort = /* @__PURE__ */ __name(() => {
                  broadcastPromptCancelledOnce(
                    entry,
                    sessionId,
                    pendingEntry.promptId,
                    originatorClientId
                  );
                  cancelPendingForSession(sessionId);
                  if (byId.get(sessionId) === entry) {
                    void forwardRunningPromptCancel(entry, pendingEntry, {
                      sessionId
                    }).catch((err) => {
                      writeStderrLine(
                        `[pending-prompt] cancel forward failed after removePendingPrompt session=${sessionId}: ${extractErrorMessage(err)}`
                      );
                    });
                  }
                }, "onAbort");
                if (abortSignal.aborted) {
                  onAbort();
                } else {
                  abortSignal.addEventListener("abort", onAbort, {
                    once: true
                  });
                  if (abortSignal.aborted) onAbort();
                  racedPromise.finally(
                    () => abortSignal.removeEventListener("abort", onAbort)
                  ).catch(() => {
                  });
                }
                return racedPromise;
              }
            );
          } finally {
            telemetry.metrics?.promptDuration(Date.now() - dispatchStartMs);
          }
        })
      );
      result.then(
        (promptResult) => {
          publishPromptTerminal(entry, pendingEntry, {
            kind: "complete",
            result: promptResult
          });
        },
        (err) => {
          if (err instanceof DOMException && err.name === "AbortError") {
            publishPromptTerminal(entry, pendingEntry, { kind: "cancelled" });
            return;
          }
          publishPromptTerminal(entry, pendingEntry, { kind: "error", err });
        }
      );
      const drainCancelForwarding = /* @__PURE__ */ __name(async () => {
        try {
          await pendingEntry.cancelForwardDrain;
        } catch {
        }
      }, "drainCancelForwarding");
      entry.promptQueue = result.then(
        drainCancelForwarding,
        drainCancelForwarding
      );
      result.finally(() => {
        if (deadlineTimer !== void 0) clearTimeout(deadlineTimer);
        const listIdx = entry.pendingPromptList.indexOf(pendingEntry);
        if (listIdx !== -1) {
          entry.pendingPromptList.splice(listIdx, 1);
          if (isQueued && !pendingEntry.removed) {
            try {
              entry.events.publish({
                type: "pending_prompt_completed",
                promptId: pendingEntry.promptId,
                data: {
                  sessionId,
                  promptId: pendingEntry.promptId,
                  state: "completed"
                },
                ...originatorClientId ? { originatorClientId } : {}
              });
            } catch {
            }
          }
        }
        const shouldSettleMidTurnQueue = entry.pendingPromptCount === 1 && !entry.backgroundTurn && !entry.closing && byId.get(entry.sessionId) === entry;
        const undrainedMessages = shouldSettleMidTurnQueue ? entry.midTurnMessageQueue.splice(0) : [];
        releasePromptSlot();
        settleUndrainedMidTurnMessages(entry, undrainedMessages);
        schedulePromptSettledClose(entry);
      }).catch(() => {
      });
      return result;
    },
    async cancelSession(sessionId, req, context) {
      opts.onDiagnosticLine?.(
        `qwen serve: bridge cancelSession for session=${sessionId}`,
        "info"
      );
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const cancelOriginatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId
      );
      entry.cancelGeneration += 1;
      entry.backgroundAdmissionEpoch = (entry.backgroundAdmissionEpoch ?? 0) + 1;
      entry.backgroundStartsSuspended = true;
      const runningPrompt = entry.pendingPromptList.find(
        (pending) => pending.state === "running" && !pending.terminalPublished
      );
      broadcastPromptCancelledOnce(
        entry,
        sessionId,
        entry.activePromptId ?? entry.backgroundTurn?.turnId ?? runningPrompt?.promptId,
        cancelOriginatorClientId
      );
      cancelPendingForSession(sessionId);
      const notif = req ? { ...req, sessionId } : { sessionId };
      telemetry.metrics?.cancelled();
      await telemetry.withSpan(
        "session.cancel",
        {
          "qwen-code.daemon.bridge.operation": "session.cancel",
          "session.id": sessionId
        },
        async () => {
          if (runningPrompt) {
            const forwarding = runningPrompt.dispatched === true && entry.activePromptId === runningPrompt.promptId ? forwardRunningPromptCancel(entry, runningPrompt, notif) : Promise.resolve();
            runningPrompt.abortController.abort(
              new DOMException(
                "Prompt cancelled before dispatch",
                "AbortError"
              )
            );
            await forwarding;
            return;
          }
          try {
            await entry.connection.cancel(notif);
          } catch (err) {
            if (isNotCurrentlyGeneratingCancelError(err)) return;
            throw err;
          }
        }
      );
    },
    subscribeEvents(sessionId, subOpts) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const raw = entry.events.subscribe(subOpts);
      cancelPromptSettledTimer(entry);
      if (!subOpts?.snapshot) return raw;
      const snapshotFrame = /* @__PURE__ */ __name(() => ({
        v: EVENT_SCHEMA_VERSION,
        type: "session_snapshot",
        data: {
          sessionId: entry.sessionId,
          currentModelId: entry.currentModelId ?? null,
          currentApprovalMode: entry.currentApprovalMode ?? null,
          ...entry.planExecutionMode ? { planExecutionMode: entry.planExecutionMode } : {},
          recordingDegraded: entry.recordingDegraded
        }
      }), "snapshotFrame");
      async function* withSnapshot() {
        let injected = false;
        if (subOpts?.lastEventId === void 0) {
          yield snapshotFrame();
          injected = true;
        }
        for await (const event of raw) {
          yield event;
          if (!injected && event.type === "replay_complete") {
            yield snapshotFrame();
            injected = true;
          }
        }
      }
      __name(withSnapshot, "withSnapshot");
      return withSnapshot();
    },
    getSessionLastEventId(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      return entry.events.lastEventId;
    },
    getSessionEventEpoch(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      return entry.events.epoch;
    },
    getSessionCurrentCwd(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      return entry.effectiveCwd;
    },
    getSessionReplaySnapshot(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      return entry.events.snapshotReplay();
    },
    respondToPermission(requestId, response, context) {
      const sessionId = permissionMediator.peekSessionFor(requestId);
      if (sessionId === void 0 || !byId.has(sessionId)) {
        writeStderrLine(
          `qwen serve: legacy permission vote ${JSON.stringify(requestId)} has no live session (peek returned ${JSON.stringify(sessionId)}); returning 404.`
        );
        return false;
      }
      return this.respondToSessionPermission(
        sessionId,
        requestId,
        response,
        context
      );
    },
    respondToSessionPermission(sessionId, requestId, response, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const actualSessionId = permissionMediator.peekSessionFor(requestId);
      if (actualSessionId !== void 0 && actualSessionId !== sessionId) {
        teeServeDebugLine(
          `rejected permission vote ${JSON.stringify(requestId)} for session ${JSON.stringify(sessionId)}; request belongs to session ${JSON.stringify(actualSessionId)}.`
        );
        return false;
      }
      if (actualSessionId === void 0) {
        writeStderrLine(
          `qwen serve: rejected permission vote ${JSON.stringify(requestId)} for session ${JSON.stringify(sessionId)}; mediator has no pending or resolved record (unknown / timed out / LRU-evicted).`
        );
        return false;
      }
      const trustedClientId = resolveTrustedClientId(entry, context?.clientId);
      if (response.outcome.outcome === "selected" && response.outcome.optionId === CANCEL_VOTE_SENTINEL) {
        throw new InvalidPermissionOptionError(requestId, CANCEL_VOTE_SENTINEL);
      }
      const optionId = response.outcome.outcome === "selected" ? response.outcome.optionId : CANCEL_VOTE_SENTINEL;
      const voterMetadata = extractPermissionResponseMetadata(response);
      const outcome = permissionMediator.vote({
        requestId,
        sessionId,
        clientId: trustedClientId,
        optionId,
        receivedAtMs: Date.now(),
        fromLoopback: context?.fromLoopback ?? false,
        ...voterMetadata ? { metadata: voterMetadata } : {}
      });
      switch (outcome.kind) {
        case "resolved":
        case "recorded":
          return true;
        case "already_resolved":
          return false;
        case "unknown_request":
          teeServeDebugLine(
            `rejected permission vote ${JSON.stringify(requestId)} for session ${JSON.stringify(sessionId)}; mediator has no pending or resolved record.`
          );
          return false;
        case "forbidden":
          throw new PermissionForbiddenError(
            requestId,
            sessionId,
            outcome.reason
          );
        default: {
          const _exhaustive = outcome;
          throw new Error(
            `unreachable PermissionVoteOutcome: ${JSON.stringify(_exhaustive)}`
          );
        }
      }
    },
    async branchSession(sessionId, req, context) {
      if (shuttingDown) throw new Error("AcpSessionBridge is shutting down");
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      if (isClosingOrAuthorizingClose(entry)) {
        throw new SessionNotFoundError(sessionId, "The session is closing");
      }
      if (isReservedStandaloneSessionSourceType(entry.sourceType)) {
        throw new InvalidSessionMetadataError(
          "sourceType",
          "Standalone sessions cannot be branched through the generic session API"
        );
      }
      const source = parseSessionSource(req.sourceType, req.sourceId);
      if ("error" in source) {
        throw new InvalidSessionMetadataError("sourceType", source.error);
      }
      if (isReservedStandaloneSessionSourceType(source.sourceType)) {
        throw new InvalidSessionMetadataError(
          "sourceType",
          "`standalone` is reserved for daemon-owned session creation"
        );
      }
      const isSideTask = source.sourceType === "side_task";
      const restoreBranch = isSideTask || req.atRecordId === void 0;
      if (context?.clientId !== void 0) {
        resolveTrustedClientId(entry, context.clientId);
      }
      assertSessionResetNotPending(sessionId);
      const concurrentSideTask = isSideTask && (entry.promptActive || !!entry.backgroundTurn);
      if (!isSideTask && (entry.pendingPromptCount > 0 || entry.promptActive || !!entry.backgroundTurn)) {
        throw new BranchWhilePromptActiveError(sessionId);
      }
      const branchResult = (concurrentSideTask ? Promise.resolve() : entry.promptQueue).then(async () => {
        const sourceCi = assertLivePromptEntry(sessionId, entry);
        if (isClosingOrAuthorizingClose(entry)) {
          throw new SessionNotFoundError(sessionId, "The session is closing");
        }
        if ((entry.promptActive || entry.backgroundTurn) && !isSideTask) {
          throw new BranchWhilePromptActiveError(sessionId);
        }
        assertFreshSessionsAvailable();
        let admission;
        if (restoreBranch) {
          if (byId.size + inFlightSpawns.size + inFlightRestores.size + abandonedNewSessionSettlements.size >= maxSessions) {
            throw new SessionLimitExceededError(maxSessions);
          }
          admission = reserveFreshSession({
            operation: "branch",
            workspaceCwd: boundWorkspace,
            sourceSessionId: sessionId
          });
        }
        let admissionReleased = false;
        const releaseAdmissionOnce = /* @__PURE__ */ __name(() => {
          if (admissionReleased || !admission) return;
          admissionReleased = true;
          releaseFreshSessionReservation(admission);
        }, "releaseAdmissionOnce");
        harness.reserveRuntimeOperation();
        try {
          const mutation = entry.connection.extMethod(
            isSideTask ? SERVE_CONTROL_EXT_METHODS.sessionSideTask : SERVE_CONTROL_EXT_METHODS.sessionBranch,
            {
              sessionId,
              cwd: boundWorkspace,
              name: req.name,
              ...req.atRecordId !== void 0 ? { atRecordId: req.atRecordId } : {}
            }
          );
          const result = await harness.withWorkspaceControl(
            sourceCi.harness,
            async () => {
              let settled;
              try {
                settled = await Promise.race([
                  mutation,
                  getTransportClosedReject(entry)
                ]);
              } catch (err) {
                const data = err?.data;
                if (!isSideTask && data && typeof data === "object" && data.errorKind === "session_busy") {
                  const msg = err?.message ?? "Branch failed";
                  throw new SessionBusyError(sessionId, msg);
                }
                throw err;
              }
              return settled;
            }
          );
          if (!result || typeof result.newSessionId !== "string") {
            throw new Error(
              `branchSession: agent returned invalid response: ${JSON.stringify(result)}`
            );
          }
          markSessionCatalogChanged();
          const sourceWarnings = [];
          const copySources = /* @__PURE__ */ __name(async (attachments) => {
            try {
              const attachmentIds = attachments ? (await attachments.list()).map((item) => item.attachmentId) : [];
              const copied = await Promise.race([
                entry.connection.extMethod("qwen/session/sources/copy", {
                  sessionId,
                  targetSessionId: result.newSessionId,
                  targetCwd: boundWorkspace,
                  attachmentIds
                }),
                getTransportClosedReject(entry)
              ]);
              if (copied.sourceError) {
                sourceWarnings.push("Session sources could not be copied.");
              } else {
                sourceWarnings.push(...copied.warnings ?? []);
              }
            } catch {
              sourceWarnings.push("Session sources could not be copied.");
            }
          }, "copySources");
          if (opts.sessionAttachmentsRoot) {
            const branchAttachments = new SessionAttachmentStore(
              opts.sessionAttachmentsRoot,
              result.newSessionId,
              opts.sessionAttachmentsFallbackRoot
            );
            try {
              await branchAttachments.copyFrom(entry.attachments);
            } catch (error) {
              writeStderrLine(
                `qwen serve: failed to copy attachments for branched session ${result.newSessionId}: ${error instanceof Error ? error.message : String(error)}`
              );
            } finally {
              await copySources(branchAttachments);
              await branchAttachments.close();
            }
          } else if (!restoreBranch) {
            await copySources();
          }
          const rawBranchName = result.displayName ?? result.title;
          const branchDisplayName = typeof rawBranchName === "string" ? rawBranchName : result.newSessionId.slice(0, 8);
          if (!restoreBranch) {
            return {
              ...sourceWarnings.length > 0 ? { sourceWarnings } : {},
              sessionId: result.newSessionId,
              displayName: branchDisplayName,
              forkedFrom: {
                sessionId,
                displayName: entry.displayName ?? sessionId.slice(0, 8)
              }
            };
          }
          const ci = getChannelInfo(await harness.ensure());
          let restored;
          try {
            const hideInheritedHistory = req.replayInheritedHistory === false;
            restored = await restoreSession(
              "load",
              {
                sessionId: result.newSessionId,
                workspaceCwd: boundWorkspace,
                clientId: context?.clientId,
                ...hideInheritedHistory ? {
                  historyReplay: "response",
                  hideInheritedHistory: true
                } : {},
                ...source
              },
              {
                skipFreshSessionAdmission: true,
                // A fork inherits the parent's dangling ask_user_question
                // tail, but forks cannot run that tool — never fire a
                // restore prompt into a brand-new branch.
                suppressRestorePrompt: true
              }
            );
            releaseAdmissionOnce();
          } catch (restoreErr) {
            writeStderrLine(
              `qwen serve: branchSession load failed for ${result.newSessionId}; closing partial live state while preserving the committed session...`
            );
            try {
              if (!ci.harness.isDying) {
                await harness.withWorkspaceControl(
                  ci.harness,
                  () => withTimeout(
                    Promise.race([
                      ci.connection.extMethod(
                        SERVE_CONTROL_EXT_METHODS.sessionClose,
                        {
                          sessionId: result.newSessionId,
                          cwd: boundWorkspace,
                          drainTimeoutMs: sessionCloseDrainBudgetMs(initTimeoutMs)
                        }
                      ),
                      channelUnavailableReject(
                        ci.channel,
                        "during branchSession cleanup"
                      )
                    ]),
                    initTimeoutMs,
                    "branchSession cleanup"
                  )
                );
              }
            } catch (cleanupErr) {
              writeStderrLine(
                `qwen serve: branchSession live-state close for ${result.newSessionId} failed: ${extractErrorMessage(cleanupErr)}`
              );
            }
            throw restoreErr;
          }
          const newEntry = byId.get(result.newSessionId);
          if (newEntry && !opts.sessionAttachmentsRoot) {
            try {
              await newEntry.attachments.copyFrom(entry.attachments);
            } catch (error) {
              writeStderrLine(
                `qwen serve: failed to copy attachments for branched session ${result.newSessionId}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
          if (!opts.sessionAttachmentsRoot) {
            await copySources(newEntry?.attachments);
          }
          if (newEntry) newEntry.displayName = branchDisplayName;
          let sourcePersisted;
          if (newEntry?.sourceType) {
            try {
              const sourceResult = await withTimeout(
                newEntry.connection.extMethod(
                  SERVE_CONTROL_EXT_METHODS.sessionSource,
                  {
                    sessionId: newEntry.sessionId,
                    sourceType: newEntry.sourceType,
                    ...newEntry.sourceId !== void 0 ? { sourceId: newEntry.sourceId } : {}
                  }
                ),
                initTimeoutMs,
                "sessionSource"
              );
              sourcePersisted = sourceResult?.persisted === true;
            } catch (error) {
              sourcePersisted = false;
              writeStderrLine(
                `qwen serve: source metadata for branched session ${result.newSessionId} was not persisted: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
          return {
            ...restored,
            ...sourceWarnings.length > 0 ? { sourceWarnings } : {},
            displayName: branchDisplayName,
            forkedFrom: {
              sessionId,
              displayName: entry.displayName ?? sessionId.slice(0, 8)
            },
            ...sourcePersisted !== void 0 ? { sourcePersisted } : {}
          };
        } finally {
          releaseAdmissionOnce();
          await harness.releaseRuntimeOperationReservation("session branch");
        }
      });
      if (!concurrentSideTask) {
        entry.promptQueue = branchResult.then(
          () => void 0,
          () => void 0
        );
      }
      return branchResult;
    },
    async createSideTaskSession(sessionId, req, context) {
      const result = await this.branchSession(
        sessionId,
        {
          name: req.name,
          sourceType: "side_task",
          sourceId: sessionId,
          replayInheritedHistory: false
        },
        context
      );
      const restoredResult = result;
      const { forkedFrom: _forkedFrom, ...sideTask } = restoredResult;
      return {
        ...sideTask,
        parentSessionId: sessionId
      };
    },
    async changeSessionCwd(sessionId, req, context) {
      if (shuttingDown) throw new Error("AcpSessionBridge is shutting down");
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      if (isReservedStandaloneSessionSourceType(entry.sourceType) && (req.managedRelocation !== "live-conversation" || req.conversationDirectoryExpectation === void 0)) {
        throw standaloneWorkingDirectoryMissingError();
      }
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId
      );
      assertSessionResetNotPending(sessionId);
      const cdPromise = entry.promptQueue.then(async () => {
        const ci = assertLivePromptEntry(sessionId, entry);
        harness.reserveRuntimeOperation();
        try {
          if (entry.promptActive || entry.backgroundTurn) {
            throw new CdWhilePromptActiveError(sessionId);
          }
          const raw = await harness.withWorkspaceControl(
            ci.harness,
            () => Promise.race([
              harness.changeSessionCwd(ci.harness, sessionId, req),
              getTransportClosedReject(entry)
            ])
          );
          const extResult = raw;
          if (typeof extResult?.previousCwd !== "string" || typeof extResult?.newCwd !== "string" || !Array.isArray(extResult?.warnings)) {
            throw new Error(
              `changeSessionCwd: unexpected response shape from agent: ${JSON.stringify(raw)}`
            );
          }
          if (isReservedStandaloneSessionSourceType(entry.sourceType) && (req.conversationDirectoryExpectation === void 0 || extResult.newCwd !== req.conversationDirectoryExpectation.child.canonicalPath)) {
            throw standaloneWorkingDirectoryMissingError();
          }
          entry.effectiveCwd = extResult.newCwd;
          if (isReservedStandaloneSessionSourceType(entry.sourceType) && req.conversationDirectoryExpectation !== void 0) {
            entry.artifactWorkspaceReady = false;
            entry.managedConversationBinding = {
              expectation: req.conversationDirectoryExpectation,
              released: false
            };
          }
          if (extResult.previousCwd !== extResult.newCwd) {
            entry.events.publish({
              type: "session_cwd_changed",
              data: {
                sessionId,
                previousCwd: extResult.previousCwd,
                newCwd: extResult.newCwd
              },
              ...originatorClientId ? { originatorClientId } : {}
            });
          }
          return extResult;
        } finally {
          await harness.releaseRuntimeOperationReservation(
            "session cwd change"
          );
        }
      });
      entry.promptQueue = cdPromise.then(
        () => void 0,
        () => void 0
      );
      entry.cwdChangeQueue = cdPromise.then(
        () => void 0,
        () => void 0
      );
      const result = await withTimeout(
        cdPromise,
        Math.max(initTimeoutMs, 3e4),
        "changeSessionCwd"
      );
      writeStderrLine(
        `qwen serve: session ${sessionId} cwd changed: ${result.previousCwd} -> ${result.newCwd}` + (result.warnings.length > 0 ? ` (warnings: ${result.warnings.join("; ")})` : "")
      );
      return { sessionId, ...result };
    },
    async commitManagedConversationBinding(sessionId, expectation) {
      let entry = byId.get(sessionId);
      if (!entry) throw standaloneWorkingDirectoryMissingError();
      await entry.cwdChangeQueue;
      if (byId.get(sessionId) !== entry) {
        throw standaloneWorkingDirectoryMissingError();
      }
      const binding = entry.managedConversationBinding;
      if (!isReservedStandaloneSessionSourceType(entry.sourceType) || !binding || !sameConversationDirectoryExpectation(binding.expectation, expectation)) {
        throw standaloneWorkingDirectoryMissingError();
      }
      const response = await withTimeout(
        Promise.race([
          entry.connection.extMethod(
            SERVE_CONTROL_EXT_METHODS.sessionManagedConversationBindingCommit,
            {
              sessionId,
              conversationDirectoryExpectation: expectation
            }
          ),
          getTransportClosedReject(entry)
        ]),
        initTimeoutMs,
        "commitManagedConversationBinding"
      );
      if (response?.committed !== true) {
        throw new Error(
          "commitManagedConversationBinding returned an invalid acknowledgement"
        );
      }
      entry = byId.get(sessionId);
      if (!entry || entry.managedConversationBinding !== binding || !sameConversationDirectoryExpectation(binding.expectation, expectation)) {
        throw standaloneWorkingDirectoryMissingError();
      }
      if (entry.artifactWorkspaceCwd !== expectation.child.canonicalPath) {
        const artifacts = new SessionArtifactStore({
          sessionId,
          workspaceCwd: expectation.child.canonicalPath,
          runtimeBaseDir: opts.artifactSnapshotRuntimeBaseDir,
          persistence: createSessionArtifactPersistence(
            entry.connection,
            sessionId
          )
        });
        const pending = entry.pendingArtifactRestore;
        if (pending) {
          const warnings = await artifacts.restore(pending.snapshot, {
            workspaceAccess: "metadata-only"
          });
          for (const warning of warnings) {
            if (!pending.warnings.includes(warning)) {
              pending.warnings.push(warning);
              writeStderrLine(
                `[artifacts] session=${entry.sessionId} action=restore_warning warning=${JSON.stringify(
                  warning
                )}`
              );
            }
          }
        }
        entry.artifacts = artifacts;
        entry.artifactWorkspaceCwd = expectation.child.canonicalPath;
      } else {
        entry.artifacts.resetWorkspaceResolutionCache();
      }
    },
    async releaseManagedConversationBinding(sessionId, expectation) {
      let entry = byId.get(sessionId);
      if (!entry) throw standaloneWorkingDirectoryMissingError();
      await entry.cwdChangeQueue;
      if (byId.get(sessionId) !== entry) {
        throw standaloneWorkingDirectoryMissingError();
      }
      const binding = entry.managedConversationBinding;
      if (!isReservedStandaloneSessionSourceType(entry.sourceType) || !binding || !sameConversationDirectoryExpectation(binding.expectation, expectation)) {
        throw standaloneWorkingDirectoryMissingError();
      }
      const response = await withTimeout(
        Promise.race([
          entry.connection.extMethod(
            SERVE_CONTROL_EXT_METHODS.sessionManagedConversationBindingRelease,
            {
              sessionId,
              conversationDirectoryExpectation: expectation
            }
          ),
          getTransportClosedReject(entry)
        ]),
        initTimeoutMs,
        "releaseManagedConversationBinding"
      );
      if (response?.released !== true) {
        throw new Error(
          "releaseManagedConversationBinding returned an invalid acknowledgement"
        );
      }
      entry = byId.get(sessionId);
      if (!entry || entry.managedConversationBinding !== binding || !sameConversationDirectoryExpectation(binding.expectation, expectation)) {
        throw standaloneWorkingDirectoryMissingError();
      }
      binding.released = true;
      entry.artifactWorkspaceReady = true;
    },
    setSessionWorktree(sessionId, worktree) {
      const entry = byId.get(sessionId);
      if (entry) {
        entry.worktree = worktree;
        markSessionCatalogChanged();
      }
    },
    clearSessionWorktree(sessionId) {
      const entry = byId.get(sessionId);
      if (entry?.worktree !== void 0) {
        delete entry.worktree;
        markSessionCatalogChanged();
      }
    },
    setSessionResetPending(sessionId) {
      resetPendingSessions.add(sessionId);
      return byId.has(sessionId);
    },
    clearSessionResetPending(sessionId) {
      resetPendingSessions.delete(sessionId);
    },
    async severSessionClients(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) return true;
      const registrations = /* @__PURE__ */ __name(() => {
        let total = 0;
        for (const count of entry.clientIds.values()) total += count;
        return total;
      }, "registrations");
      let outstanding = registrations();
      while (outstanding > 0 && byId.get(sessionId) === entry) {
        for (const clientId of [...entry.clientIds.keys()]) {
          await bridgeApi.detachClient(sessionId, clientId);
        }
        const remaining = registrations();
        if (remaining >= outstanding) break;
        outstanding = remaining;
      }
      return !byId.has(sessionId);
    },
    fireDeferredRestoreAskUserQuestionPrompt(sessionId, clientId) {
      if (clientId === void 0) return false;
      const entry = byId.get(sessionId);
      const requestedClientId = entry?.deferredRestoreAskUserQuestionPrompts?.get(clientId);
      if (!entry || requestedClientId === void 0) return false;
      entry.deferredRestoreAskUserQuestionPrompts?.delete(clientId);
      return maybeFireRestoreAskUserQuestionPrompt(
        entry,
        true,
        requestedClientId,
        clientId,
        {}
      );
    },
    discardDeferredRestoreAskUserQuestionPrompt(sessionId, clientId) {
      if (clientId === void 0) return;
      const entry = byId.get(sessionId);
      entry?.deferredRestoreAskUserQuestionPrompts?.delete(clientId);
    },
    async closeSession(sessionId, context, closeOpts) {
      return closeSessionImpl(sessionId, context, closeOpts);
    },
    async ensureDefaultSessionPersisted(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const result = await withTimeout(
        Promise.race([
          entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionSource, {
            sessionId,
            sourceType: "default"
          }),
          getTransportClosedReject(entry)
        ]),
        initTimeoutMs,
        "ensureDefaultSessionPersisted"
      );
      if (result?.persisted !== true) {
        throw new Error(`Session '${sessionId}' could not be persisted`);
      }
    },
    updateSessionMetadata(sessionId, metadata, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const metadataOriginatorClientId = context?.clientId !== void 0 ? resolveTrustedClientId(entry, context.clientId) : void 0;
      if (metadata.pr !== void 0) {
        const pr = metadata.pr;
        if (pr === null || typeof pr !== "object" || typeof pr.number !== "number" || !Number.isInteger(pr.number) || pr.number <= 0 || typeof pr.url !== "string" || pr.url.length > SESSION_PR_URL_MAX_LENGTH || !/^https?:\/\//i.test(pr.url) || // The url is interpolated into the stderr audit line — control
        // characters would let a client forge log lines (the displayName
        // branch rejects them for the same reason).
        hasControlCharacter2(pr.url) || pr.state !== void 0 && pr.state !== "open" && pr.state !== "merged" && pr.state !== "closed") {
          throw new InvalidSessionMetadataError(
            "pr",
            `must be an object with a positive integer \`number\` and an http(s) \`url\` of at most ${SESSION_PR_URL_MAX_LENGTH} characters, without control characters, and an optional \`state\` that is one of \`open\`, \`merged\`, or \`closed\``
          );
        }
      }
      if (metadata.displayName !== void 0) {
        if (metadata.titleSource !== void 0 && metadata.titleSource !== "manual" && metadata.titleSource !== "auto") {
          throw new InvalidSessionMetadataError(
            "titleSource",
            "must be either `manual` or `auto`"
          );
        }
        if (typeof metadata.displayName !== "string" || metadata.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
          throw new InvalidSessionMetadataError(
            "displayName",
            `must be a string of at most ${MAX_DISPLAY_NAME_LENGTH} characters`
          );
        }
        if (hasControlCharacter2(metadata.displayName)) {
          throw new InvalidSessionMetadataError(
            "displayName",
            "must not contain control characters"
          );
        }
        if (metadata.displayName.trim() === "") {
          throw new InvalidSessionMetadataError(
            "displayName",
            "must not be empty"
          );
        }
        const nextDisplayName = metadata.displayName || void 0;
        const titleSource = metadata.titleSource ?? "manual";
        if (entry.displayName !== nextDisplayName) {
          entry.displayName = nextDisplayName;
          markSessionCatalogChanged();
          writeStderrLine(
            `qwen serve: updated session metadata ${JSON.stringify(sessionId)} displayName=${entry.displayName === void 0 ? "cleared" : "set"}` + (context?.clientId ? ` by client ${JSON.stringify(context.clientId)}` : "")
          );
          if (nextDisplayName) {
            entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionTitle, {
              sessionId,
              displayName: nextDisplayName,
              titleSource
            }).then((res) => {
              const r = res;
              if (r && r.persisted === false) {
                writeStderrLine(
                  `qwen serve: displayName for ${sessionId} was not persisted`
                );
              }
            }).catch((err) => {
              writeStderrLine(
                `qwen serve: failed to persist displayName for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
              );
            });
          }
          try {
            entry.events.publish({
              type: "session_metadata_updated",
              data: {
                sessionId,
                displayName: entry.displayName,
                ...entry.displayName ? { titleSource } : {}
              },
              ...metadataOriginatorClientId ? { originatorClientId: metadataOriginatorClientId } : {}
            });
          } catch {
          }
        }
      }
      if (metadata.pr !== void 0) {
        const bound = metadata.pr;
        const existing = entry.prs ?? [];
        const latest = existing[existing.length - 1];
        if (latest?.number === bound.number && latest.url === bound.url && // A re-bind carrying a new state is a change: the live entry,
        // the metadata event, and the catalog revision must all see it.
        (bound.state === void 0 || bound.state === latest.state)) {
        } else {
          const known = existing.find(
            (p) => p.number === bound.number && canonicalSessionPrUrl(p.url) === canonicalSessionPrUrl(bound.url)
          );
          entry.prs = [
            ...existing.filter((p) => p.number !== bound.number),
            {
              number: bound.number,
              url: bound.url,
              ...bound.state ?? known?.state ? {
                state: bound.state ?? known?.state
              } : {},
              // The issue snapshot is daemon-derived, never client-bound.
              ...known?.issues ? { issues: known.issues } : {}
            }
          ].slice(-SESSION_PR_LIST_LIMIT);
          markSessionCatalogChanged();
          writeStderrLine(
            `qwen serve: updated session metadata ${JSON.stringify(sessionId)} pr=${bound.number} bound (${bound.url})` + (context?.clientId ? ` by client ${JSON.stringify(context.clientId)}` : "")
          );
          try {
            entry.events.publish({
              type: "session_metadata_updated",
              // Echo the current name: SDK folds treat an absent displayName
              // as "cleared", so a pr-only event must not blank the title.
              data: {
                sessionId,
                ...entry.displayName !== void 0 ? { displayName: entry.displayName } : {},
                prs: entry.prs
              },
              ...metadataOriginatorClientId ? { originatorClientId: metadataOriginatorClientId } : {}
            });
          } catch {
          }
        }
      }
      return {
        displayName: entry.displayName,
        ...entry.prs && entry.prs.length > 0 ? { prs: entry.prs } : {}
      };
    },
    seedSessionPrs(sessionId, prs) {
      const entry = byId.get(sessionId);
      if (!entry || entry.prs && entry.prs.length > 0) return;
      entry.prs = prs.map(toSessionPrInfo).slice(-SESSION_PR_LIST_LIMIT);
    },
    setSessionPrs(sessionId, prs) {
      const entry = byId.get(sessionId);
      if (!entry) return;
      const next = prs.map(toSessionPrInfo).slice(-SESSION_PR_LIST_LIMIT);
      const current = entry.prs ?? [];
      const sameIssueList = /* @__PURE__ */ __name((left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null), "sameIssueList");
      const unchanged = current.length === next.length && current.every(
        (p, index) => p.number === next[index].number && p.url === next[index].url && p.state === next[index].state && sameIssueList(p.issues, next[index].issues)
      );
      entry.prs = next;
      if (unchanged) return;
      markSessionCatalogChanged();
      try {
        entry.events.publish({
          type: "session_metadata_updated",
          data: {
            sessionId,
            // Echo the current name: SDK folds treat an absent displayName
            // as "cleared", so a pr-only event must not blank the title.
            ...entry.displayName !== void 0 ? { displayName: entry.displayName } : {},
            prs: entry.prs
          }
        });
      } catch {
      }
    },
    async getSessionSources(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      if (isReservedStandaloneSessionSourceType(entry.sourceType) && entry.managedConversationBinding?.released !== true) {
        throw standaloneWorkingDirectoryMissingError();
      }
      resolveTrustedClientId(entry, context?.clientId);
      return requestSessionSources(sessionId, "qwen/session/sources/list");
    },
    async upsertSessionSource(sessionId, input, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      if (isReservedStandaloneSessionSourceType(entry.sourceType) && entry.managedConversationBinding?.released !== true) {
        throw standaloneWorkingDirectoryMissingError();
      }
      const clientId = resolveTrustedClientId(entry, context.clientId);
      if (!clientId) {
        throw new RequestError(
          -32602,
          "A session-bound client id is required",
          {
            errorKind: "client_id_required"
          }
        );
      }
      const validated = validateSessionSourceInput(input);
      if (validated.locator.type === "attachment") {
        const attachmentId = validated.locator.attachmentId;
        const attachments = await entry.attachments.list();
        if (byId.get(sessionId) !== entry) {
          throw new SessionNotFoundError(sessionId);
        }
        resolveTrustedClientId(entry, context.clientId);
        if (!attachments.some((item) => item.attachmentId === attachmentId)) {
          throw new RequestError(-32602, "Session attachment not found", {
            errorKind: "source_attachment_not_found"
          });
        }
      }
      return requestSessionSources(sessionId, "qwen/session/sources/upsert", {
        input: validated
      });
    },
    async removeSessionSource(sessionId, sourceId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      if (isReservedStandaloneSessionSourceType(entry.sourceType) && entry.managedConversationBinding?.released !== true) {
        throw standaloneWorkingDirectoryMissingError();
      }
      const clientId = resolveTrustedClientId(entry, context.clientId);
      if (!clientId) {
        throw new RequestError(
          -32602,
          "A session-bound client id is required",
          {
            errorKind: "client_id_required"
          }
        );
      }
      return requestSessionSources(sessionId, "qwen/session/sources/remove", {
        sourceId
      });
    },
    async getSessionArtifacts(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      if (isReservedStandaloneSessionSourceType(entry.sourceType) && entry.managedConversationBinding?.released !== true) {
        throw standaloneWorkingDirectoryMissingError();
      }
      resolveTrustedClientId(entry, context?.clientId);
      await entry.prepareArtifactWorkspace?.();
      return entry.artifacts.list();
    },
    async addSessionArtifact(sessionId, artifact, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      if (isReservedStandaloneSessionSourceType(entry.sourceType) && entry.managedConversationBinding?.released !== true) {
        throw standaloneWorkingDirectoryMissingError();
      }
      const clientId = resolveTrustedClientId(entry, context?.clientId);
      await entry.prepareArtifactWorkspace?.();
      const input = makeClientArtifactInput(artifact, clientId);
      const result = await entry.artifacts.upsertMany([input], {
        validationStrict: true,
        persistenceStrict: false
      });
      publishArtifactChanges(entry, result.changes, clientId);
      const warnings = [...result.warnings ?? []];
      return warnings.length > 0 ? { ...result, warnings } : result;
    },
    async removeSessionArtifact(sessionId, artifactId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      if (isReservedStandaloneSessionSourceType(entry.sourceType) && entry.managedConversationBinding?.released !== true) {
        throw standaloneWorkingDirectoryMissingError();
      }
      const clientId = resolveTrustedClientId(entry, context?.clientId);
      await entry.prepareArtifactWorkspace?.();
      const result = await entry.artifacts.remove(artifactId, { clientId });
      publishArtifactChanges(entry, result.changes, clientId);
      const warnings = [...result.warnings ?? []];
      return warnings.length > 0 ? { ...result, warnings } : result;
    },
    listWorkspaceSessions(workspaceCwd) {
      if (!path4.isAbsolute(workspaceCwd)) return [];
      const key = workspaceCwd === boundWorkspace ? boundWorkspace : canonicalizeWorkspace(workspaceCwd);
      if (key !== boundWorkspace) return [];
      const out = [];
      for (const entry of byId.values()) {
        if (entry.workspaceCwd === key) {
          out.push(toSessionSummary(entry));
        }
      }
      return out;
    },
    getSessionCatalogVersion,
    markSessionCatalogChanged,
    getSessionSummary(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      return toSessionSummary(entry);
    },
    recordHeartbeat(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const clientId = resolveTrustedClientId(entry, context?.clientId);
      const lastSeenAt = Date.now();
      entry.sessionLastSeenAt = lastSeenAt;
      if (clientId !== void 0) {
        entry.clientLastSeenAt.set(clientId, lastSeenAt);
      }
      return {
        sessionId: entry.sessionId,
        ...clientId !== void 0 ? { clientId } : {},
        lastSeenAt
      };
    },
    getHeartbeatState(sessionId) {
      const entry = byId.get(sessionId);
      if (!entry) return void 0;
      return {
        ...entry.sessionLastSeenAt !== void 0 ? { sessionLastSeenAt: entry.sessionLastSeenAt } : {},
        clientLastSeenAt: new Map(entry.clientLastSeenAt)
      };
    },
    publishWorkspaceEvent(event) {
      const sessions = Array.from(byId.values());
      let successCount = 0;
      let failureCount = 0;
      for (const entry of sessions) {
        try {
          const published = entry.events.publish(event);
          if (published === void 0) {
            failureCount += 1;
            teeServeDebugLine(
              `publishWorkspaceEvent: publish on session ${entry.sessionId} no-op (bus closed or unserializable)`
            );
          } else {
            successCount += 1;
          }
        } catch (err) {
          failureCount += 1;
          const detail = `publishWorkspaceEvent: bus publish failed for session ${JSON.stringify(entry.sessionId)} (type=${event.type}): ${err instanceof Error ? err.message : String(err)}`;
          if (shuttingDown) {
            teeServeDebugLine(detail);
          } else {
            writeStderrLine(`qwen serve: ${detail}`);
          }
        }
      }
      if (sessions.length > 0 && successCount === 0 && !shuttingDown) {
        writeStderrLine(
          `qwen serve: publishWorkspaceEvent type=${event.type} dropped on ALL ${failureCount} session bus(es); SSE subscribers will miss this event (GET fallback still authoritative)`
        );
      }
    },
    knownClientIds() {
      const out = /* @__PURE__ */ new Set();
      for (const entry of byId.values()) {
        for (const id of entry.clientIds.keys()) out.add(id);
      }
      return out;
    },
    async queryWorkspaceStatus(method, idle) {
      return requestWorkspaceStatus(method, idle);
    },
    async invokeWorkspaceCommand(method, params, invokeOpts) {
      const startsWorkspaceChannel = method === SERVE_CONTROL_EXT_METHODS.workspaceMcpRestart;
      const invoke = /* @__PURE__ */ __name(async (info2) => {
        const timeout = invokeOpts?.timeoutMs ?? initTimeoutMs;
        const response = await withTimeout(
          Promise.race([
            info2.connection.extMethod(method, params ?? {}),
            getChannelClosedReject(info2)
          ]),
          timeout,
          method
        );
        if (method === SERVE_CONTROL_EXT_METHODS.workspaceMcpRestart && typeof params?.["serverName"] === "string") {
          invalidateWorkspaceMcpDetailCache(params["serverName"]);
          await requestWorkspaceStatus(
            SERVE_STATUS_EXT_METHODS.workspaceMcp,
            () => {
              throw new BridgeChannelClosedError(
                "workspace MCP restart status refresh"
              );
            },
            {},
            /* @__PURE__ */ new Set([params["serverName"]])
          );
        }
        return response;
      }, "invoke");
      if (startsWorkspaceChannel) {
        return await withEnsuredWorkspaceControl(invoke);
      }
      const info = liveChannelInfo();
      if (!info) throw new SessionNotFoundError(`workspace-command:${method}`);
      return await harness.withWorkspaceControl(
        info.harness,
        () => invoke(info)
      );
    },
    async isWorkspaceMemoryRememberAvailable() {
      return await withEnsuredWorkspaceControl(async (info) => {
        const response = await withTimeout(
          Promise.race([
            info.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceMemoryRememberAvailability,
              { cwd: boundWorkspace }
            ),
            getChannelClosedReject(info)
          ]),
          initTimeoutMs,
          SERVE_CONTROL_EXT_METHODS.workspaceMemoryRememberAvailability
        );
        return response !== null && typeof response === "object" && response["available"] === true;
      });
    },
    async runWorkspaceMemoryRemember(request) {
      return await withEnsuredWorkspaceControl(async (info) => {
        const response = await withTimeout(
          Promise.race([
            info.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceMemoryRemember,
              { ...request, cwd: boundWorkspace }
            ),
            getChannelClosedReject(info)
          ]),
          WORKSPACE_MEMORY_REMEMBER_TIMEOUT_MS,
          SERVE_CONTROL_EXT_METHODS.workspaceMemoryRemember
        );
        return parseWorkspaceMemoryRememberResult(response);
      });
    },
    async runWorkspaceMemoryForget(request) {
      return await withEnsuredWorkspaceControl(async (info) => {
        const response = await withTimeout(
          Promise.race([
            info.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceMemoryForget,
              { ...request, cwd: boundWorkspace }
            ),
            getChannelClosedReject(info)
          ]),
          WORKSPACE_MEMORY_REMEMBER_TIMEOUT_MS,
          SERVE_CONTROL_EXT_METHODS.workspaceMemoryForget
        );
        return parseWorkspaceMemoryForgetResult(response);
      });
    },
    async runWorkspaceMemoryDream() {
      return await withEnsuredWorkspaceControl(async (info) => {
        const response = await withTimeout(
          Promise.race([
            info.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceMemoryDream,
              { cwd: boundWorkspace }
            ),
            getChannelClosedReject(info)
          ]),
          WORKSPACE_MEMORY_REMEMBER_TIMEOUT_MS,
          SERVE_CONTROL_EXT_METHODS.workspaceMemoryDream
        );
        return parseWorkspaceMemoryDreamResult(response);
      });
    },
    async getWorkspaceMcpToolsStatus(serverName) {
      const result = await requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceMcpTools,
        () => {
          const cached = workspaceMcpToolsCache.get(serverName);
          return cached ? { ...cached, acpChannelLive: false } : {
            v: STATUS_SCHEMA_VERSION,
            workspaceCwd: boundWorkspace,
            serverName,
            initialized: false,
            acpChannelLive: false,
            tools: [],
            errors: [
              {
                kind: "mcp_tools",
                status: "not_started",
                hint: "initialize MCP discovery to populate"
              }
            ]
          };
        },
        { serverName }
      );
      if (result.acpChannelLive) {
        workspaceMcpToolsCache.set(serverName, result);
      }
      return result;
    },
    async getWorkspaceMcpResourcesStatus(serverName) {
      const result = await requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceMcpResources,
        () => {
          const cached = workspaceMcpResourcesCache.get(serverName);
          return cached ? { ...cached, acpChannelLive: false } : {
            v: STATUS_SCHEMA_VERSION,
            workspaceCwd: boundWorkspace,
            serverName,
            initialized: false,
            acpChannelLive: false,
            resources: [],
            errors: [
              {
                kind: "mcp_resources",
                status: "not_started",
                hint: "initialize MCP discovery to populate"
              }
            ]
          };
        },
        { serverName }
      );
      if (result.acpChannelLive) {
        workspaceMcpResourcesCache.set(serverName, result);
      }
      return result;
    },
    async getWorkspaceToolsStatus() {
      return requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceTools,
        () => ({
          v: STATUS_SCHEMA_VERSION,
          workspaceCwd: boundWorkspace,
          initialized: true,
          acpChannelLive: false,
          tools: [],
          errors: [
            {
              kind: "tools",
              status: "not_started",
              hint: "spawn a session to populate"
            }
          ]
        })
      );
    },
    async getSessionContextStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionContext
      );
    },
    async getSessionContextUsageStatus(sessionId, opts2) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionContextUsage,
        { detail: opts2?.detail === true }
      );
    },
    async getSessionSupportedCommandsStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionSupportedCommands
      );
    },
    async getSessionTasksStatus(sessionId, opts2) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionTasks,
        { includeWorkflows: opts2?.includeWorkflows === true }
      );
    },
    async getSessionAgentsStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionAgents
      );
    },
    async getSessionAgentTrace(sessionId, rootAgentId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionAgentTrace,
        rootAgentId === void 0 ? void 0 : { rootAgentId }
      );
    },
    async getSessionLspStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionLspStatus
      );
    },
    async getSessionResourcesStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionResources
      );
    },
    async getSessionSavedWorkflow(sessionId, name) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionSavedWorkflow,
        { name }
      );
    },
    async getSessionTranscriptPage(req) {
      return requestSessionTranscriptPage(req);
    },
    async flushSessionTranscript(sessionId) {
      await requestSessionTranscriptPage({
        sessionId,
        direction: "backward",
        limit: 1
      });
    },
    async getSessionTurnIndexPage(req) {
      return requestSessionTurnIndexPage(req);
    },
    async cancelSessionTask(sessionId, taskId, taskKind, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      return requestSessionStatus(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionTaskCancel,
        { taskId, taskKind }
      );
    },
    async controlSessionWorkflowTask(sessionId, taskId, action, context, input) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      assertSessionResetNotPending(sessionId);
      return requestSessionStatus(sessionId, SERVE_CONTROL_EXT_METHODS.sessionWorkflowTaskAction, {
        taskId,
        action,
        // Forwarded only when present, so a control action's request body
        // stays byte-identical to what it was before start input existed.
        ...input?.args !== void 0 ? { args: input.args } : {},
        ...input?.sourceRef !== void 0 ? { sourceRef: input.sourceRef } : {},
        ...input?.script !== void 0 ? { script: input.script } : {}
      });
    },
    async controlSessionGoal(sessionId, request, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.harness.isDying)
        throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      assertSessionResetNotPending(sessionId);
      return requestSessionStatus(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionGoalControl,
        { request }
      );
    },
    async clearSessionGoal(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionGoalClear
      );
    },
    async getSessionGoal(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionGoalGet
      );
    },
    async continueSession(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      const cancelGeneration = entry.cancelGeneration;
      const decision = await requestSessionStatus(sessionId, SERVE_CONTROL_EXT_METHODS.sessionContinue);
      if (!decision.accepted) {
        return decision;
      }
      const liveEntry = byId.get(sessionId);
      if (!liveEntry) throw new SessionNotFoundError(sessionId);
      if (liveEntry !== entry || liveEntry.cancelGeneration !== cancelGeneration || isClosingOrAuthorizingClose(liveEntry) || liveEntry.pendingPromptCount > 0 || liveEntry.promptActive || liveEntry.goalTurnActive) {
        return { accepted: false, interruption: decision.interruption };
      }
      const lastEventId = liveEntry.events.lastEventId;
      const eventEpoch = liveEntry.events.epoch;
      const promptId = context?.promptId;
      const promptPromise = bridgeApi.sendPrompt(
        sessionId,
        { sessionId, prompt: [] },
        void 0,
        {
          ...context?.clientId !== void 0 ? { clientId: context.clientId } : {},
          ...promptId !== void 0 ? { promptId } : {},
          continue: true
        }
      );
      promptPromise.catch((err) => {
        teeServeDebugLine(
          `continueSession: continuation turn failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
        );
      });
      return {
        ...decision,
        ...promptId !== void 0 ? { promptId } : {},
        lastEventId,
        eventEpoch
      };
    },
    async getSessionStatsStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionStats
      );
    },
    async getWorkspaceHooksStatus() {
      return requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceHooks,
        () => createIdleWorkspaceHooksStatus(boundWorkspace)
      );
    },
    async getSessionHooksStatus(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionHooks
      );
    },
    async getWorkspaceExtensionsStatus() {
      return requestWorkspaceStatus(
        SERVE_STATUS_EXT_METHODS.workspaceExtensions,
        () => createIdleWorkspaceExtensionsStatus(boundWorkspace)
      );
    },
    async refreshExtensionsForAllSessions(data, options) {
      const skillsOnly = options?.skillsOnly === true;
      const sessions = Array.from(byId.values());
      const bootstrapRefreshConnections = /* @__PURE__ */ new Set();
      const refreshSession = /* @__PURE__ */ __name(async (entry, refreshBootstrap) => {
        const refreshKey = `${entry.sessionId}:${skillsOnly ? "skills" : "all"}`;
        let inFlight = inFlightExtensionRefreshes.get(refreshKey);
        let created = false;
        if (!inFlight || inFlight.connection !== entry.connection || refreshBootstrap && !inFlight.refreshBootstrap) {
          const promise = (async () => {
            await entry.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceExtensionsRefresh,
              {
                sessionId: entry.sessionId,
                ...refreshBootstrap ? {} : { refreshBootstrap: false },
                ...skillsOnly ? { skillsOnly: true } : {}
              }
            );
          })();
          let rejectUnavailable;
          const unavailable = new Promise((_resolve, reject) => {
            rejectUnavailable = /* @__PURE__ */ __name(() => reject(
              new BridgeChannelClosedError("refreshExtensionsForAllSessions")
            ), "rejectUnavailable");
          });
          inFlight = {
            connection: entry.connection,
            promise,
            wait: Promise.race([
              withTimeout(
                promise,
                3e4,
                SERVE_CONTROL_EXT_METHODS.workspaceExtensionsRefresh
              ),
              unavailable
            ]),
            rejectUnavailable,
            refreshBootstrap
          };
          inFlightExtensionRefreshes.set(refreshKey, inFlight);
          created = true;
        }
        const clear = /* @__PURE__ */ __name(() => {
          if (inFlightExtensionRefreshes.get(refreshKey) === inFlight) {
            inFlightExtensionRefreshes.delete(refreshKey);
          }
        }, "clear");
        if (created) void inFlight.promise.then(clear, clear);
        await inFlight.wait;
      }, "refreshSession");
      const results = await Promise.all(
        sessions.map(async (entry) => {
          const info = channelInfoForEntry(entry);
          if (!info || info.harness.isDying) {
            return {
              refreshed: 0,
              failed: 0,
              entry,
              refreshBootstrap: false
            };
          }
          const refreshBootstrap = !bootstrapRefreshConnections.has(
            entry.connection
          );
          bootstrapRefreshConnections.add(entry.connection);
          try {
            await harness.withWorkspaceControl(
              info.harness,
              () => refreshSession(entry, refreshBootstrap)
            );
            return { refreshed: 1, failed: 0, entry, refreshBootstrap };
          } catch (err) {
            writeServeDebugLine(
              `refreshExtensions: session ${entry.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`
            );
            return { refreshed: 0, failed: 1, entry, refreshBootstrap };
          }
        })
      );
      await Promise.all(
        results.filter((result) => result.failed > 0 && result.refreshBootstrap).map(async (failedBootstrap) => {
          const retry = results.find(
            (result) => result.refreshed > 0 && result.entry.connection === failedBootstrap.entry.connection
          );
          if (!retry) return;
          const info = channelInfoForEntry(retry.entry);
          if (!info || info.harness.isDying) return;
          try {
            await harness.withWorkspaceControl(
              info.harness,
              () => refreshSession(retry.entry, true)
            );
          } catch (err) {
            writeServeDebugLine(
              `refreshExtensions: bootstrap retry via session ${retry.entry.sessionId} failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        })
      );
      const refreshed = results.reduce(
        (sum, result) => sum + result.refreshed,
        0
      );
      const failed = results.reduce((sum, result) => sum + result.failed, 0);
      if (refreshed > 0 || failed > 0 || data?.status !== void 0) {
        broadcastWorkspaceEvent({
          type: "extensions_changed",
          data: { ...data, refreshed, failed }
        });
      }
      return { refreshed, failed };
    },
    broadcastExtensionsChanged(data) {
      broadcastWorkspaceEvent({
        type: "extensions_changed",
        data
      });
    },
    async setSessionModel(sessionId, req, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId
      );
      const normalized = { ...req, sessionId };
      const conn = entry.connection;
      const transportClosed = getTransportClosedReject(entry);
      const work = entry.modelChangeQueue.then(async () => {
        entry.modelRoundtripInFlight = true;
        let succeeded = false;
        try {
          const result = await Promise.race([
            withTimeout(
              conn.unstable_setSessionModel(normalized),
              initTimeoutMs,
              "setSessionModel"
            ),
            transportClosed
          ]);
          publishModelSwitched(entry, req.modelId, originatorClientId);
          if (!isReservedStandaloneSessionSourceType(entry.sourceType)) {
            broadcastWorkspaceEvent({
              type: "settings_changed",
              data: {
                key: "model.name",
                value: getCanonicalModelId(result, req.modelId)
              },
              ...originatorClientId ? { originatorClientId } : {}
            });
          }
          succeeded = true;
          return result;
        } finally {
          entry.modelRoundtripInFlight = false;
          if (succeeded) {
            void reconcileAfterRoundtrip(entry, "model");
          } else {
            writeStderrLine(
              `[reconcile] session=${entry.sessionId} target=model action=skipped reason=roundtrip_failed`
            );
          }
        }
      });
      entry.modelChangeQueue = work.then(
        () => void 0,
        () => void 0
      );
      let response;
      try {
        response = await work;
      } catch (err) {
        entry.events.publish({
          type: "model_switch_failed",
          data: {
            sessionId: entry.sessionId,
            requestedModelId: req.modelId,
            error: extractErrorMessage(err)
          },
          ...originatorClientId ? { originatorClientId } : {}
        });
        throw err;
      }
      return response;
    },
    async setSessionConfigOption(sessionId, req) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.harness.isDying)
        throw new SessionNotFoundError(sessionId);
      const normalized = { ...req, sessionId };
      const transportClosed = getTransportClosedReject(entry);
      const work = entry.modelChangeQueue.then(
        () => Promise.race([
          withTimeout(
            entry.connection.setSessionConfigOption(normalized),
            initTimeoutMs,
            "setSessionConfigOption"
          ),
          transportClosed
        ])
      );
      entry.modelChangeQueue = work.then(
        () => void 0,
        () => void 0
      );
      return await work;
    },
    async setSessionLanguage(sessionId, params, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.harness.isDying)
        throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId
      );
      const result = await Promise.race([
        withTimeout(
          entry.connection.extMethod(
            SERVE_CONTROL_EXT_METHODS.sessionLanguage,
            {
              sessionId,
              language: params.language,
              syncOutputLanguage: params.syncOutputLanguage
            }
          ),
          initTimeoutMs,
          SERVE_CONTROL_EXT_METHODS.sessionLanguage
        ),
        getTransportClosedReject(entry)
      ]);
      try {
        entry.events.publish({
          type: "language_changed",
          data: {
            sessionId: entry.sessionId,
            language: result.language,
            outputLanguage: result.outputLanguage ?? null,
            refreshed: result.refreshed ?? false
          },
          ...originatorClientId ? { originatorClientId } : {}
        });
      } catch (err) {
        writeServeDebugLine(
          `language_changed event publish failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      return {
        language: result.language,
        outputLanguage: result.outputLanguage ?? null,
        refreshed: result.refreshed ?? false
      };
    },
    async setUserLanguage(params) {
      const info = liveChannelInfo();
      if (!info) throw new SessionNotFoundError("user-language");
      return await withTimeout(
        Promise.race([
          info.connection.extMethod(SERVE_CONTROL_EXT_METHODS.userLanguage, {
            language: params.language,
            syncOutputLanguage: params.syncOutputLanguage
          }),
          getChannelClosedReject(info)
        ]),
        initTimeoutMs,
        SERVE_CONTROL_EXT_METHODS.userLanguage
      );
    },
    async setSessionLiveConversationActive(sessionId, active) {
      await requestSessionStatus(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionLiveConversation,
        { active }
      );
    },
    async appendSessionLiveTranscript(sessionId, entries, model) {
      await requestSessionStatus(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionLiveTranscript,
        { entries, model }
      );
    },
    async setSessionApprovalMode(sessionId, mode, opts2, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      if (opts2.persist && isReservedStandaloneSessionSourceType(entry.sourceType)) {
        throw new InvalidSessionMetadataError(
          "persist",
          "Standalone approval mode changes are session-scoped"
        );
      }
      const info = channelInfoForEntry(entry);
      if (!info || info.harness.isDying)
        throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId
      );
      return await applyApprovalMode(
        entry,
        mode,
        opts2.persist,
        originatorClientId,
        opts2.planMode
      );
    },
    async generateSessionRecap(sessionId, _context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.harness.isDying)
        throw new SessionNotFoundError(sessionId);
      opts.onDiagnosticLine?.(
        `qwen serve: bridge generateSessionRecap dispatching ext-method for session=${sessionId}`,
        "info"
      );
      const response = await Promise.race([
        withTimeout(
          entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionRecap, {
            sessionId
          }),
          SESSION_RECAP_TIMEOUT_MS,
          SERVE_CONTROL_EXT_METHODS.sessionRecap
        ),
        getTransportClosedReject(entry)
      ]);
      opts.onDiagnosticLine?.(
        `qwen serve: bridge generateSessionRecap completed for session=${sessionId} recap=${response.recap ? `len=${response.recap.length}` : "null"}`,
        "info"
      );
      return {
        sessionId: entry.sessionId,
        recap: response.recap ?? null
      };
    },
    generateSessionContent(sessionId, prompt, signal, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.harness.isDying)
        throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      const requestId = randomUUID3();
      const queue = new GenerationStreamQueue(
        GENERATION_STREAM_QUEUE_CAPACITY
      );
      const request = {
        sessionId,
        connection: entry.connection,
        queue,
        settled: false
      };
      generationRequests.set(requestId, request);
      const cancel = /* @__PURE__ */ __name(() => {
        if (request.settled) return;
        request.settled = true;
        generationRequests.delete(requestId);
        queue.close();
        void entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionGenerationCancel, {
          sessionId,
          requestId
        }).catch(() => void 0);
      }, "cancel");
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) {
        cancel();
        return queue;
      }
      void Promise.race([
        withTimeout(
          entry.connection.extMethod(
            SERVE_CONTROL_EXT_METHODS.sessionGenerationStart,
            { sessionId, requestId, prompt }
          ),
          SESSION_GENERATION_TIMEOUT_MS,
          SERVE_CONTROL_EXT_METHODS.sessionGenerationStart
        ),
        getTransportClosedReject(entry)
      ]).then((raw) => {
        if (request.settled) return;
        const response = raw;
        const model = response["model"];
        const modelSource = response["modelSource"];
        if (typeof model !== "string" || modelSource !== "fast" && modelSource !== "main") {
          throw new Error("Malformed generation completion");
        }
        const accepted = queue.push({
          type: "done",
          requestId,
          model,
          modelSource,
          ...typeof response["inputTokens"] === "number" ? { inputTokens: response["inputTokens"] } : {},
          ...typeof response["outputTokens"] === "number" ? { outputTokens: response["outputTokens"] } : {}
        });
        if (accepted) queue.close();
        else queue.fail(new Error("Generation stream consumer too slow"));
      }).catch((error) => {
        if (!request.settled) queue.fail(error);
      }).finally(() => {
        request.settled = true;
        signal.removeEventListener("abort", cancel);
        generationRequests.delete(requestId);
      });
      return queue;
    },
    getPendingPrompts(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      return entry.pendingPromptList.filter((p) => !p.removed && !p.terminalPublished).map((p) => ({
        promptId: p.promptId,
        text: p.text,
        ...p.content ? { content: p.content } : {},
        queuedAt: p.queuedAt,
        state: p.state,
        ...p.originatorClientId !== void 0 ? { originatorClientId: p.originatorClientId } : {}
      }));
    },
    async getSessionTurnStatus(sessionId, context, promptId) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      const liveBeforeRead = findLiveTurnStatus(entry, promptId);
      if (liveBeforeRead) return liveBeforeRead;
      if (promptId !== void 0 && entry.enrichedTerminalPromptIds.has(promptId)) {
        const enrichedTerminal = entry.terminalTurnStatuses.get(promptId);
        if (enrichedTerminal) return enrichedTerminal;
      }
      const rewindGenerationBeforeRead = entry.rewindGeneration;
      let result;
      try {
        result = await requestSessionStatus(
          sessionId,
          SERVE_CONTROL_EXT_METHODS.sessionTurnStatus,
          { ...promptId !== void 0 ? { promptId } : {} },
          // Transcript scans of large histories exceed the 10s init default;
          // give the read the same budget as other transcript reads.
          SESSION_TRANSCRIPT_TIMEOUT_MS
        );
      } catch (error) {
        const liveAfterFailure = findLiveTurnStatus(entry, promptId);
        if (liveAfterFailure) return liveAfterFailure;
        const terminalAfterFailure = promptId !== void 0 ? entry.terminalTurnStatuses.get(promptId) : latestTerminalTurnStatus(entry);
        if (terminalAfterFailure) return terminalAfterFailure;
        throw error;
      }
      const liveAfterRead = findLiveTurnStatus(entry, promptId);
      if (liveAfterRead) return liveAfterRead;
      const terminal = promptId !== void 0 ? entry.terminalTurnStatuses.get(promptId) : latestTerminalTurnStatus(entry);
      const persisted = result.turnResult && entry.rewindGeneration === rewindGenerationBeforeRead ? settledTurnStatus(sessionId, result.turnResult) : void 0;
      if (promptId !== void 0) {
        if (terminal && persisted) {
          const merged = mergeTerminalWithPersisted(terminal, persisted);
          rememberEnrichedTerminalTurnStatus(entry, promptId, merged);
          return merged;
        }
        if (terminal) return terminal;
        if (persisted) {
          rememberEnrichedTerminalTurnStatus(entry, promptId, persisted);
          return persisted;
        }
      } else {
        if (terminal && persisted && terminal.promptId === persisted.promptId) {
          return mergeTerminalWithPersisted(terminal, persisted);
        }
        if (terminal && persisted) {
          return (terminal.endedAt ?? 0) >= (persisted.endedAt ?? 0) ? terminal : persisted;
        }
        if (terminal) return terminal;
        if (persisted) return persisted;
      }
      if (promptId !== void 0) {
        return void 0;
      }
      return { sessionId, state: "idle" };
    },
    async storeSessionAttachment(sessionId, data, mimeType, context, name) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      return await entry.attachments.putAttachment(data, mimeType, name);
    },
    async readSessionAttachment(sessionId, attachmentId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      return await entry.attachments.read(attachmentId);
    },
    async listSessionAttachments(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      return await entry.attachments.list();
    },
    async removeSessionAttachment(sessionId, attachmentId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      return await entry.attachments.remove(attachmentId);
    },
    async deleteSessionAttachments(sessionId, options) {
      const store = byId.get(sessionId)?.attachments ?? new SessionAttachmentStore(
        opts.sessionAttachmentsRoot,
        sessionId,
        opts.sessionAttachmentsFallbackRoot
      );
      await store.delete(options);
    },
    removePendingPrompt(sessionId, promptId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      const idx = entry.pendingPromptList.findIndex(
        (p) => p.promptId === promptId
      );
      if (idx === -1) return { removed: false };
      const target = entry.pendingPromptList[idx];
      if (target.removed) return { removed: false };
      writeStderrLine(
        `[pending-prompt] session=${sessionId} removing promptId=${promptId} state=${target.state}`
      );
      target.abortController.abort(
        new DOMException("Prompt removed by user", "AbortError")
      );
      if (target.state === "queued") {
        entry.pendingPromptList.splice(idx, 1);
      } else {
        target.removed = true;
      }
      try {
        entry.events.publish({
          type: "pending_prompt_completed",
          promptId,
          data: { sessionId, promptId, state: "removed" },
          ...target.originatorClientId ? { originatorClientId: target.originatorClientId } : {}
        });
      } catch {
      }
      if (target.state === "queued") {
        publishPromptTerminal(entry, target, { kind: "cancelled" });
      }
      return { removed: true };
    },
    enqueueMidTurnMessage(sessionId, message, context, requestedMessageId, options) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId
      );
      const eventDetailMode = options?.eventDetailMode ?? "full";
      if (eventDetailMode !== "full" && eventDetailMode !== "summary") {
        throw RequestError.invalidParams(
          void 0,
          "Invalid eventDetailMode; expected full or summary"
        );
      }
      const trimmed = message.trim();
      const mediaBlocks = (options?.content ?? []).filter(
        (block) => block.type === "image" || block.type === "resource"
      );
      if (trimmed.length === 0 && mediaBlocks.length === 0) {
        writeStderrLine(
          `[mid-turn] session=${entry.sessionId} rejected: empty`
        );
        return { accepted: false };
      }
      if (requestedMessageId !== void 0) {
        const existing = entry.midTurnMessageQueue.find(
          (queued) => queued.messageId === requestedMessageId
        );
        if (existing) {
          const sameMedia = JSON.stringify(existing.content ?? []) === JSON.stringify(mediaBlocks);
          if (existing.text === trimmed && sameMedia && (existing.eventDetailMode ?? "full") === eventDetailMode) {
            return { accepted: true, messageId: requestedMessageId };
          }
          writeStderrLine(
            `[mid-turn] session=${JSON.stringify(entry.sessionId)} rejected id ${JSON.stringify(requestedMessageId)}: text, content or mode mismatch`
          );
          return { accepted: false };
        }
        const promoted = entry.pendingPromptList.find(
          (pending) => pending.promptId === requestedMessageId
        );
        if (promoted) {
          const promotedMedia = (promoted.content ?? []).filter(
            (block) => block.type === "image" || block.type === "resource"
          );
          const sameMedia = JSON.stringify(promotedMedia) === JSON.stringify(mediaBlocks);
          const promotedText = promoted.text === "[image]" && trimmed.length === 0 ? "" : promoted.text;
          if (promotedText === trimmed && sameMedia && (promoted.eventDetailMode ?? "full") === eventDetailMode) {
            return { accepted: true, messageId: requestedMessageId };
          }
          writeStderrLine(
            `[mid-turn] session=${JSON.stringify(entry.sessionId)} rejected promoted id ${JSON.stringify(requestedMessageId)}: text, content or mode mismatch`
          );
          return { accepted: false };
        }
        if (entry.settledMidTurnMessageIds.includes(requestedMessageId)) {
          return { accepted: true, messageId: requestedMessageId };
        }
        if (entry.promotedMidTurnMessageIds.includes(requestedMessageId)) {
          return { accepted: true, messageId: requestedMessageId };
        }
      }
      if (isClosingOrAuthorizingClose(entry)) {
        writeStderrLine(
          `[mid-turn] session=${JSON.stringify(entry.sessionId)} rejected: session closing`
        );
        return { accepted: false };
      }
      entry.attachments.assertReferences(mediaBlocks);
      const inlineBytes = inlineAttachmentBlockBytes(mediaBlocks);
      if (inlineBytes > 0) {
        const queuedInlineBytes = entry.midTurnMessageQueue.reduce(
          (total, queued) => total + inlineAttachmentBlockBytes(queued.content ?? []),
          0
        );
        if (queuedInlineBytes + inlineBytes > MAX_QUEUED_INLINE_ATTACHMENT_BYTES) {
          writeStderrLine(
            `[mid-turn] session=${entry.sessionId} rejected: queued inline attachments exceed the ${MAX_QUEUED_INLINE_ATTACHMENT_BYTES}-byte session budget`
          );
          return { accepted: false };
        }
      }
      const messageId = requestedMessageId ?? randomUUID3();
      if (entry.pendingPromptCount === 0 && entry.goalTurnActive !== true && (!entry.backgroundTurn || options?.queueOnly)) {
        if (options?.queueOnly || options?.rejectIfIdle) {
          writeStderrLine(
            `[mid-turn] session=${JSON.stringify(entry.sessionId)} rejected id ${JSON.stringify(messageId)}: session idle`
          );
          return { accepted: false, reason: "session_idle" };
        }
        promoteMidTurnMessage(
          entry,
          messageId,
          trimmed,
          originatorClientId,
          mediaBlocks.length > 0 ? mediaBlocks : void 0,
          eventDetailMode
        );
        return { accepted: true, messageId };
      }
      if (entry.midTurnMessageQueue.length >= MAX_MID_TURN_QUEUE_DEPTH) {
        writeStderrLine(
          `[mid-turn] session=${entry.sessionId} rejected: queue full (depth ${entry.midTurnMessageQueue.length} >= ${MAX_MID_TURN_QUEUE_DEPTH})`
        );
        return { accepted: false };
      }
      const queuedMessage = {
        eventDetailMode,
        messageId,
        text: trimmed,
        ...mediaBlocks.length > 0 ? { content: mediaBlocks } : {},
        originatorClientId,
        ...options?.queueOnly ? {
          queueOnly: true,
          onSettledWithoutDrain: options.onSettledWithoutDrain
        } : {}
      };
      entry.midTurnMessageQueue.push(queuedMessage);
      if (originatorClientId) {
        try {
          entry.events.publish({
            type: "pending_prompt_added",
            promptId: messageId,
            data: {
              sessionId,
              promptId: messageId,
              text: trimmed,
              queuedAt: Date.now()
            },
            originatorClientId
          });
        } catch {
        }
      }
      return { accepted: true, messageId };
    },
    removeMidTurnMessage(sessionId, messageId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      const index = entry.midTurnMessageQueue.findIndex(
        (message) => message.messageId === messageId
      );
      if (index === -1) {
        const isPromoted = entry.pendingPromptList.some(
          (pending) => pending.promptId === messageId && pending.promotedMidTurn === true
        );
        if (!isPromoted) {
          writeStderrLine(
            `[mid-turn] session=${JSON.stringify(entry.sessionId)} remove missed messageId=${JSON.stringify(messageId)} (already drained or completed)`
          );
          return { removed: false };
        }
        const promoted = bridgeApi.removePendingPrompt(
          sessionId,
          messageId,
          context
        );
        if (promoted.removed) {
          rememberMidTurnId(entry.settledMidTurnMessageIds, messageId);
          return promoted;
        }
        writeStderrLine(
          `[mid-turn] session=${JSON.stringify(entry.sessionId)} remove missed messageId=${JSON.stringify(messageId)} (already drained or completed)`
        );
        return { removed: false };
      }
      const [removed] = entry.midTurnMessageQueue.splice(index, 1);
      rememberMidTurnId(entry.settledMidTurnMessageIds, messageId);
      if (removed) {
        try {
          entry.events.publish({
            type: "pending_prompt_completed",
            promptId: messageId,
            data: { sessionId, promptId: messageId, state: "removed" },
            ...removed.originatorClientId ? { originatorClientId: removed.originatorClientId } : {}
          });
        } catch {
        }
      }
      return { removed: true };
    },
    async enqueueBackgroundNotification(sessionId, notification) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.harness.isDying)
        throw new SessionNotFoundError(sessionId);
      entry.pendingAgentNotificationCount++;
      try {
        const response = await Promise.race([
          withTimeout(
            entry.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.sessionBackgroundNotification,
              { sessionId, ...notification }
            ),
            initTimeoutMs,
            SERVE_CONTROL_EXT_METHODS.sessionBackgroundNotification
          ),
          getTransportClosedReject(entry)
        ]);
        return { sessionId, accepted: response["accepted"] === true };
      } finally {
        entry.pendingAgentNotificationCount = Math.max(
          0,
          entry.pendingAgentNotificationCount - 1
        );
        void maybeCloseIdleSession(entry, "agent_notification_settled");
      }
    },
    getMidTurnMessages(sessionId, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      return {
        // Anonymous enqueues (live steering) stay off the shared surface:
        // their delegation text is not a user message other attached clients
        // should restore into their queue views.
        messages: entry.midTurnMessageQueue.filter((message) => message.originatorClientId !== void 0).map((message) => ({
          messageId: message.messageId,
          text: message.text,
          // Carry the media blocks so a refreshed client can rebuild the
          // queued row with its attachments (the snapshot is the only
          // recovery source once the client's in-memory copy is gone).
          ...message.content ? { content: message.content } : {}
        })),
        settledMessageIds: [...entry.settledMidTurnMessageIds],
        promotedMessageIds: [...entry.promotedMidTurnMessageIds]
      };
    },
    async generateSessionBtw(sessionId, question, signal, _context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.harness.isDying)
        throw new SessionNotFoundError(sessionId);
      if (signal?.aborted) return { sessionId, answer: null };
      const races = [
        withTimeout(
          entry.connection.extMethod(SERVE_CONTROL_EXT_METHODS.sessionBtw, {
            sessionId,
            question
          }),
          SESSION_BTW_TIMEOUT_MS,
          SERVE_CONTROL_EXT_METHODS.sessionBtw
        ),
        getTransportClosedReject(entry)
      ];
      let cleanupAbort;
      if (signal) {
        races.push(
          new Promise((_, reject) => {
            const handler = /* @__PURE__ */ __name(() => reject(new DOMException("Aborted", "AbortError")), "handler");
            signal.addEventListener("abort", handler, { once: true });
            cleanupAbort = /* @__PURE__ */ __name(() => signal.removeEventListener("abort", handler), "cleanupAbort");
          })
        );
      }
      let response;
      try {
        response = await Promise.race(races);
      } finally {
        cleanupAbort?.();
      }
      return {
        sessionId: entry.sessionId,
        answer: response.answer ?? null
      };
    },
    async launchSessionForkAgent(sessionId, directive, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const info = channelInfoForEntry(entry);
      if (!info || info.harness.isDying)
        throw new SessionNotFoundError(sessionId);
      resolveTrustedClientId(entry, context?.clientId);
      const trimmed = directive.trim();
      if (!trimmed) {
        throw new Error("Fork directive is required");
      }
      assertSessionResetNotPending(sessionId);
      if (entry.pendingPromptCount > 0 || entry.promptActive || !!entry.backgroundTurn) {
        throw new SessionBusyError(
          sessionId,
          "Cannot fork while a response or tool call is in progress"
        );
      }
      return entry.promptQueue.then(async () => {
        if (entry.pendingPromptCount > 0 || entry.promptActive || !!entry.backgroundTurn) {
          throw new SessionBusyError(
            sessionId,
            "Cannot fork while a response or tool call is in progress"
          );
        }
        opts.onDiagnosticLine?.(
          `qwen serve: launchSessionForkAgent requested for session=${sessionId}`,
          "info"
        );
        let response;
        try {
          response = await Promise.race([
            withTimeout(
              entry.connection.extMethod(
                SERVE_CONTROL_EXT_METHODS.sessionForkAgent,
                {
                  sessionId,
                  directive: trimmed
                }
              ),
              initTimeoutMs,
              SERVE_CONTROL_EXT_METHODS.sessionForkAgent
            ),
            getTransportClosedReject(entry)
          ]);
        } catch (error) {
          opts.onDiagnosticLine?.(
            `qwen serve: launchSessionForkAgent failed for session=${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
            "warn"
          );
          throw error;
        }
        const result = {
          sessionId: entry.sessionId,
          description: response.description ?? trimmed.slice(0, 60),
          launched: response.launched === true
        };
        opts.onDiagnosticLine?.(
          `qwen serve: launchSessionForkAgent completed for session=${sessionId} launched=${result.launched}`,
          "info"
        );
        return result;
      });
    },
    async executeShellCommand(sessionId, command, signal, context) {
      opts.onDiagnosticLine?.(
        `qwen serve: bridge executeShellCommand for session=${sessionId}`,
        "info"
      );
      if (opts.sessionShellCommandEnabled !== true) {
        throw new SessionShellDisabledError();
      }
      if (context?.clientId === void 0) {
        throw new SessionShellClientRequiredError();
      }
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context.clientId
      );
      assertSessionResetNotPending(sessionId);
      if (signal?.aborted) {
        return { exitCode: null, output: "", aborted: true };
      }
      let abortResolve;
      const onAbort = /* @__PURE__ */ __name(() => abortResolve?.(), "onAbort");
      try {
        await Promise.race([
          entry.cwdChangeQueue,
          new Promise((resolve2) => {
            abortResolve = resolve2;
            if (signal?.aborted) return resolve2();
            signal?.addEventListener("abort", onAbort, { once: true });
          })
        ]);
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
      if (signal?.aborted) {
        return { exitCode: null, output: "", aborted: true };
      }
      const cwd = entry.effectiveCwd;
      entry.events.publish({
        type: "user_shell_command",
        data: { sessionId, command, cwd },
        ...originatorClientId ? { originatorClientId } : {}
      });
      const outputChunks = [];
      const abort = new AbortController();
      const onSignalAbort = /* @__PURE__ */ __name(() => abort.abort(), "onSignalAbort");
      signal?.addEventListener("abort", onSignalAbort, { once: true });
      try {
        const handle = await harness.executeShell(
          command,
          cwd,
          (event) => {
            if (event.type === "data") {
              const chunk = typeof event.chunk === "string" ? event.chunk : event.chunk.map(
                (line) => line.map((t) => t.text).join("")
              ).join("\n");
              outputChunks.push(chunk);
              entry.events.publish({
                type: "session_update",
                data: {
                  sessionId,
                  update: {
                    sessionUpdate: "shell_output",
                    output: chunk,
                    _meta: {
                      serverTimestamp: Date.now(),
                      source: "user-shell"
                    }
                  }
                },
                ...originatorClientId ? { originatorClientId } : {}
              });
            }
          },
          abort.signal
        );
        const timeoutId = setTimeout(
          () => abort.abort(),
          SHELL_COMMAND_TIMEOUT_MS
        );
        timeoutId.unref();
        const result = await handle.result;
        clearTimeout(timeoutId);
        const exitCode = result.exitCode;
        const aborted = result.aborted;
        const output = outputChunks.join("") || result.output;
        entry.events.publish({
          type: "user_shell_result",
          data: {
            sessionId,
            exitCode,
            signal: result.signal,
            aborted,
            _meta: { serverTimestamp: Date.now() }
          },
          ...originatorClientId ? { originatorClientId } : {}
        });
        const historyOutput = output.length > MAX_SHELL_OUTPUT_FOR_HISTORY ? output.substring(0, MAX_SHELL_OUTPUT_FOR_HISTORY) + "\n... (truncated)" : output;
        try {
          await withTimeout(
            Promise.race([
              entry.connection.extMethod(
                SERVE_CONTROL_EXT_METHODS.sessionShellHistory,
                { sessionId, command, output: historyOutput, exitCode }
              ),
              getTransportClosedReject(entry)
            ]),
            initTimeoutMs,
            "sessionShellHistory"
          );
        } catch (err) {
          writeServeDebugLine(
            `shell history injection failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return { exitCode, output, aborted };
      } catch (err) {
        entry.events.publish({
          type: "user_shell_result",
          data: {
            sessionId,
            exitCode: null,
            signal: null,
            aborted: false,
            error: err instanceof Error ? err.message : String(err),
            _meta: { serverTimestamp: Date.now() }
          },
          ...originatorClientId ? { originatorClientId } : {}
        });
        throw err;
      } finally {
        signal?.removeEventListener("abort", onSignalAbort);
      }
    },
    async getRewindSnapshots(sessionId) {
      return requestSessionStatus(
        sessionId,
        SERVE_STATUS_EXT_METHODS.sessionRewindSnapshots
      );
    },
    async rewindSession(sessionId, req, context) {
      const entry = byId.get(sessionId);
      if (!entry) throw new SessionNotFoundError(sessionId);
      if (isClosingOrAuthorizingClose(entry)) {
        throw new SessionNotFoundError(
          sessionId,
          "The session is closing; retry after close completes",
          "session_closing"
        );
      }
      const info = channelInfoForEntry(entry);
      if (!info || info.harness.isDying)
        throw new SessionNotFoundError(sessionId);
      const originatorClientId = resolveTrustedClientId(
        entry,
        context?.clientId
      );
      assertSessionResetNotPending(sessionId);
      if (entry.pendingPromptCount > 0 || entry.promptActive || !!entry.backgroundTurn) {
        throw new SessionBusyError(
          sessionId,
          "Cannot rewind while a prompt is running"
        );
      }
      const rewindResult = entry.promptQueue.then(async () => {
        if (entry.closing) {
          throw new SessionNotFoundError(sessionId, "The session is closing");
        }
        let response;
        try {
          response = await Promise.race([
            entry.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.sessionRewind,
              {
                sessionId,
                promptId: req.promptId,
                rewindFiles: req.rewindFiles !== false
              }
            ),
            getTransportClosedReject(entry)
          ]);
        } catch (err) {
          const data = err?.data;
          if (data && typeof data === "object" && "errorKind" in data) {
            const kind = data.errorKind;
            const msg = err?.message ?? "Rewind failed";
            if (kind === "session_busy") {
              throw new SessionBusyError(sessionId, msg);
            }
            if (kind === "invalid_rewind_target") {
              throw new InvalidRewindTargetError(sessionId, msg);
            }
          }
          throw err;
        }
        entry.terminalTurnStatuses.clear();
        entry.enrichedTerminalPromptIds.clear();
        entry.rewindGeneration += 1;
        const targetTurnIndex = response["targetTurnIndex"] ?? 0;
        const filesChanged = response["filesChanged"] ?? [];
        const filesFailed = response["filesFailed"] ?? [];
        const artifactSnapshot = restoredArtifactSnapshotFromState(
          response
        );
        const artifactSnapshotUnavailable = artifactSnapshotUnavailableReason(
          response
        );
        const beforeArtifacts = (await entry.artifacts.list()).artifacts;
        const shouldRestoreArtifactSnapshot = artifactSnapshot !== void 0 && artifactSnapshotUnavailable === void 0;
        const artifactRestoreWarnings = artifactSnapshotUnavailable !== void 0 ? [
          `artifact snapshot rebuild unavailable during rewind: ${artifactSnapshotUnavailable}`
        ] : shouldRestoreArtifactSnapshot ? await entry.artifacts.restore(artifactSnapshot, {
          preserveLiveEphemeral: true
        }) : [];
        const artifactRestoreFailed = artifactRestoreWarnings.some(
          isArtifactRestoreFailureWarning
        );
        const shouldRecordArtifactSnapshot = shouldRestoreArtifactSnapshot && !artifactRestoreFailed;
        const artifactSnapshotWarnings = shouldRecordArtifactSnapshot ? await entry.artifacts.recordSnapshot() : [];
        const artifactWarnings = [
          ...artifactRestoreWarnings,
          ...artifactSnapshotWarnings
        ];
        for (const warning of artifactRestoreWarnings) {
          writeStderrLine(
            `[artifacts] session=${entry.sessionId} action=rewind_restore_warning warning=${JSON.stringify(
              warning
            )}`
          );
        }
        for (const warning of artifactSnapshotWarnings) {
          writeStderrLine(
            `[artifacts] session=${entry.sessionId} action=rewind_snapshot_warning warning=${JSON.stringify(
              warning
            )}`
          );
        }
        const afterArtifacts = (await entry.artifacts.list()).artifacts;
        publishArtifactChanges(
          entry,
          artifactReseedChanges(beforeArtifacts, afterArtifacts),
          originatorClientId
        );
        try {
          entry.events.publish({
            type: "session_rewound",
            data: {
              sessionId,
              promptId: req.promptId,
              targetTurnIndex,
              filesChanged,
              filesFailed,
              ...artifactWarnings.length > 0 ? { warnings: artifactWarnings } : {}
            },
            ...originatorClientId ? { originatorClientId } : {}
          });
        } catch {
        }
        return {
          rewound: filesFailed.length === 0,
          targetTurnIndex,
          filesChanged,
          filesFailed,
          ...artifactWarnings.length > 0 ? { warnings: artifactWarnings } : {}
        };
      });
      entry.promptQueue = rewindResult.then(
        () => void 0,
        () => void 0
      );
      return rewindResult;
    },
    async manageMcpServer(serverName, action, originatorClientId) {
      let releaseAuthentication = action === "authenticate" ? opts.acquireMcpAuthentication?.(boundWorkspace, serverName) : void 0;
      if (action === "authenticate" && opts.acquireMcpAuthentication && !releaseAuthentication) {
        throw new McpAuthenticationInProgressError();
      }
      try {
        return await withEnsuredWorkspaceControl(async (info) => {
          if (releaseAuthentication) {
            info.workspaceMcpAuthenticationReleases.set(
              serverName,
              releaseAuthentication
            );
            releaseAuthentication = void 0;
          }
          const timeout = action === "authenticate" ? MCP_OAUTH_TIMEOUT_MS : MCP_RESTART_TIMEOUT_MS;
          let response;
          try {
            response = await Promise.race([
              withTimeout(
                info.connection.extMethod(
                  SERVE_CONTROL_EXT_METHODS.workspaceMcpManage,
                  { serverName, action, originatorClientId }
                ),
                timeout,
                SERVE_CONTROL_EXT_METHODS.workspaceMcpManage
              ),
              getChannelClosedReject(info)
            ]);
          } catch (error) {
            if (action === "authenticate" && !(error instanceof BridgeTimeoutError) && !(error instanceof BridgeChannelClosedError)) {
              info.workspaceMcpAuthenticationReleases.get(serverName)?.();
              info.workspaceMcpAuthenticationReleases.delete(serverName);
            }
            throw error;
          }
          if (action === "authenticate" && response.pending) {
            info.workspaceMcpAuthenticationServerNames.add(serverName);
            const previousTimer = info.workspaceMcpAuthenticationTimers.get(serverName);
            if (previousTimer) clearTimeout(previousTimer);
            const timer = setTimeout(() => {
              void expireWorkspaceMcpAuthentication(info, serverName, timer);
            }, MCP_OAUTH_TIMEOUT_MS);
            timer.unref();
            info.workspaceMcpAuthenticationTimers.set(serverName, timer);
          } else if (action === "authenticate") {
            info.workspaceMcpAuthenticationReleases.get(serverName)?.();
            info.workspaceMcpAuthenticationReleases.delete(serverName);
          }
          invalidateWorkspaceMcpDetailCache(serverName);
          await requestWorkspaceStatus(
            SERVE_STATUS_EXT_METHODS.workspaceMcp,
            () => {
              throw new BridgeChannelClosedError(
                "workspace MCP management status refresh"
              );
            },
            {},
            /* @__PURE__ */ new Set([serverName])
          );
          broadcastWorkspaceEvent({
            type: "mcp_server_changed",
            data: {
              serverName: response.serverName,
              action: response.action,
              originatorClientId
            },
            ...originatorClientId ? { originatorClientId } : {}
          });
          return response;
        });
      } finally {
        releaseAuthentication?.();
      }
    },
    async initializeWorkspaceMcp() {
      return await withEnsuredWorkspaceControl(async (info) => {
        info.workspaceMcpDiscoveryRequested = true;
        const result = await Promise.race([
          withTimeout(
            info.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceMcpInitialize,
              { cwd: boundWorkspace }
            ),
            initTimeoutMs,
            SERVE_CONTROL_EXT_METHODS.workspaceMcpInitialize
          ),
          getChannelClosedReject(info)
        ]);
        if (result.accepted) {
          beginWorkspaceMcpDiscovery(info);
        }
        return result;
      });
    },
    async reloadWorkspaceMcp(options) {
      return await withEnsuredWorkspaceControl(async (info) => {
        info.workspaceMcpDiscoveryRequested = true;
        const result = await Promise.race([
          withTimeout(
            info.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceMcpReload,
              { cwd: boundWorkspace, ...options }
            ),
            initTimeoutMs,
            SERVE_CONTROL_EXT_METHODS.workspaceMcpReload
          ),
          getChannelClosedReject(info)
        ]);
        if (result.accepted) {
          beginWorkspaceMcpDiscovery(info);
        }
        return result;
      });
    },
    async generateWorkspaceAgent(description, _originatorClientId) {
      const info = liveChannelInfo();
      if (!info) {
        throw new SessionNotFoundError("agents:generate");
      }
      return await harness.withWorkspaceControl(
        info.harness,
        async () => await Promise.race([
          withTimeout(
            info.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceAgentGenerate,
              { description }
            ),
            MCP_RESTART_TIMEOUT_MS,
            SERVE_CONTROL_EXT_METHODS.workspaceAgentGenerate
          ),
          getChannelClosedReject(info)
        ])
      );
    },
    generateWorkspaceContent(prompt, signal, _originatorClientId) {
      const requestId = randomUUID3();
      const queue = new GenerationStreamQueue(
        GENERATION_STREAM_QUEUE_CAPACITY
      );
      const request = {
        connection: void 0,
        queue,
        settled: false
      };
      const cancel = /* @__PURE__ */ __name(() => {
        if (request.settled) return;
        request.settled = true;
        workspaceGenerationRequests.delete(requestId);
        queue.close();
        void request.connection?.extMethod(SERVE_CONTROL_EXT_METHODS.workspaceGenerationCancel, {
          requestId
        }).catch(() => void 0);
      }, "cancel");
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) {
        cancel();
        return queue;
      }
      harness.reserveRuntimeOperation();
      void (async () => {
        try {
          const channelInfo = getChannelInfo(await harness.ensure());
          request.connection = channelInfo.connection;
          await harness.withWorkspaceControl(channelInfo.harness, async () => {
            if (request.settled) return;
            workspaceGenerationRequests.set(requestId, request);
            const raw = await Promise.race([
              withTimeout(
                channelInfo.connection.extMethod(
                  SERVE_CONTROL_EXT_METHODS.workspaceGenerationStart,
                  {
                    requestId,
                    prompt,
                    purpose: "text"
                  }
                ),
                SESSION_GENERATION_TIMEOUT_MS,
                SERVE_CONTROL_EXT_METHODS.workspaceGenerationStart
              ),
              getChannelClosedReject(channelInfo)
            ]);
            if (request.settled) return;
            const response = raw;
            const model = response["model"];
            const modelSource = response["modelSource"];
            if (typeof model !== "string" || modelSource !== "fast" && modelSource !== "main") {
              throw new Error("Malformed workspace generation completion");
            }
            const accepted = queue.push({
              type: "done",
              requestId,
              model,
              modelSource,
              ...typeof response["inputTokens"] === "number" ? { inputTokens: response["inputTokens"] } : {},
              ...typeof response["outputTokens"] === "number" ? { outputTokens: response["outputTokens"] } : {}
            });
            if (accepted) queue.close();
            else queue.fail(new Error("Generation stream consumer too slow"));
          });
        } catch (error) {
          if (!request.settled) queue.fail(error);
        } finally {
          request.settled = true;
          signal.removeEventListener("abort", cancel);
          workspaceGenerationRequests.delete(requestId);
          await harness.releaseRuntimeOperationReservation(
            "workspace generation"
          );
        }
      })().catch(() => void 0);
      return queue;
    },
    async addRuntimeMcpServer(name, config, originatorClientId) {
      const info = liveChannelInfo();
      if (!info) {
        throw Object.assign(
          new Error(`No live ACP channel for runtime MCP add: ${name}`),
          { data: { errorKind: "acp_channel_unavailable" } }
        );
      }
      return await harness.withWorkspaceControl(info.harness, async () => {
        const response = await Promise.race([
          withTimeout(
            info.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeAdd,
              { name, config, originatorClientId }
            ),
            MCP_RESTART_SERVER_DEADLINE_MS,
            SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeAdd
          ),
          getChannelClosedReject(info)
        ]);
        const addSkipped = response.skipped === true;
        if (!addSkipped) {
          const ok = response;
          broadcastWorkspaceEvent({
            type: "mcp_server_added",
            data: {
              name: ok.name,
              transport: ok.transport,
              replaced: ok.replaced,
              shadowedSettings: ok.shadowedSettings,
              toolCount: ok.toolCount,
              originatorClientId: ok.originatorClientId
            },
            ...originatorClientId ? { originatorClientId } : {}
          });
        }
        return response;
      });
    },
    async removeRuntimeMcpServer(name, originatorClientId) {
      const info = liveChannelInfo();
      if (!info) {
        throw Object.assign(
          new Error(`No live ACP channel for runtime MCP remove: ${name}`),
          { data: { errorKind: "acp_channel_unavailable" } }
        );
      }
      return await harness.withWorkspaceControl(info.harness, async () => {
        const response = await Promise.race([
          withTimeout(
            info.connection.extMethod(
              SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeRemove,
              { name, originatorClientId }
            ),
            MCP_RESTART_SERVER_DEADLINE_MS,
            SERVE_CONTROL_EXT_METHODS.workspaceMcpRuntimeRemove
          ),
          getChannelClosedReject(info)
        ]);
        const removeSkipped = response.skipped === true;
        if (!removeSkipped) {
          const ok = response;
          broadcastWorkspaceEvent({
            type: "mcp_server_removed",
            data: {
              name: ok.name,
              wasShadowingSettings: ok.wasShadowingSettings,
              originatorClientId: ok.originatorClientId
            },
            ...originatorClientId ? { originatorClientId } : {}
          });
        }
        return response;
      });
    },
    async addSessionRuntimeMcpServer(sessionId, name, config, originatorClientId) {
      return requestSessionStatus(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionMcpRuntimeAdd,
        { name, config, originatorClientId },
        MCP_RESTART_SERVER_DEADLINE_MS
      );
    },
    async removeSessionRuntimeMcpServer(sessionId, name, originatorClientId) {
      return requestSessionStatus(
        sessionId,
        SERVE_CONTROL_EXT_METHODS.sessionMcpRuntimeRemove,
        { name, originatorClientId },
        MCP_RESTART_SERVER_DEADLINE_MS
      );
    },
    async killSession(sessionId, opts2) {
      const entry = byId.get(sessionId);
      if (!entry) return false;
      if (opts2?.requireZeroAttaches && entry.attachCount > 0) {
        entry.spawnOwnerWantedKill = true;
        return false;
      }
      if (entry.closing) {
        const closingChannel = channelInfoForEntry(entry);
        if (!closingChannel) return false;
        await harness.killChannelWithLog(
          closingChannel.harness,
          `force kill closing session ${JSON.stringify(sessionId)}`
        );
        await entry.attachments.close().catch((releaseError) => {
          writeStderrLine(
            `qwen serve: failed to close attachments for killed session ${JSON.stringify(sessionId)}: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`
          );
        });
        return true;
      }
      entry.closing = true;
      const deferredCloseStamp = entry.promptSettledAt;
      clearPromptSettledClose(entry);
      const ci = channelInfoForEntry(entry);
      if (!ci) {
        writeStderrLine(
          `qwen serve: killSession channelInfoForEntry returned undefined for session ${JSON.stringify(sessionId)} \u2014 channel cleanup skipped (entry's channel already torn down)`
        );
      }
      permissionMediator.forgetSession(sessionId);
      entry.pendingPermissionIds.clear();
      entry.pendingInteractions.clear();
      try {
        await notifyAgentSessionClose(entry, ci, "killSession", {
          throwOnFailure: true,
          timeoutMs: initTimeoutMs
        });
      } catch (error) {
        if (isDefinitiveAcpRequestError(error)) {
          entry.closing = false;
          if (deferredCloseStamp !== null) {
            entry.promptSettledAt = deferredCloseStamp;
          }
          return false;
        }
        if (ci) {
          await harness.killChannelWithLog(
            ci.harness,
            `force kill session ${JSON.stringify(sessionId)}`
          );
          return true;
        }
        entry.closing = false;
        throw error;
      }
      if (entry.promptActive) {
        entry.promptActive = false;
        activePromptCounter--;
        touchActivity();
      }
      if (defaultEntry === entry) defaultEntry = void 0;
      byId.delete(sessionId);
      telemetry.metrics?.sessionLifecycle("die");
      emitSessionLifecycle({
        type: "removed",
        sessionId,
        workspaceCwd: entry.workspaceCwd,
        reason: "killed"
      });
      if (ci && ci.channel === entry.channel) {
        ci.sessionIds.delete(sessionId);
      }
      ci?.client.markSessionClosed(sessionId);
      flushPromptTerminals(
        entry,
        "session_killed",
        "session killed before the prompt completed"
      );
      try {
        entry.events.publish({
          type: "session_died",
          data: { sessionId, reason: "killed" }
        });
      } catch {
      }
      entry.events.close();
      await entry.attachments.close().catch((error) => {
        writeStderrLine(
          `qwen serve: failed to close attachments for killed session ${JSON.stringify(sessionId)}: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      if (ci && harness.hasNoChannelWork(ci.harness)) {
        await harness.reapPendingEmptyChannel(ci.harness);
        if (!ci.harness.isDying) {
          await harness.startIdleTimer(
            ci.harness,
            `killSession "${sessionId}"`
          );
        }
      }
      return true;
    },
    async detachClient(sessionId, clientId) {
      const entry = byId.get(sessionId);
      if (!entry) return;
      if (clientId !== void 0 && releaseAttachRef(entry, clientId)) {
        if (entry.attachCount > 0) entry.attachCount--;
      }
      unregisterClient(entry, clientId);
      await maybeCloseIdleSession(entry, "last_client_detached");
      rearmPromptSettledClose(entry);
    },
    killAllSync() {
      shuttingDown = true;
      harness.cancelIdleTimer();
      stopSessionReaper();
      const channels = Array.from(harness.values());
      const entries = Array.from(byId.values());
      defaultEntry = void 0;
      byId.clear();
      for (const entry of entries) {
        emitSessionLifecycle({
          type: "removed",
          sessionId: entry.sessionId,
          workspaceCwd: entry.workspaceCwd,
          reason: "kill_all"
        });
      }
      harness.killAllSync(channels);
    },
    shutdown(options) {
      if (shutdownPromise) return shutdownPromise;
      const shutdownReason = options?.reason ?? "daemon_shutdown";
      let resolveShutdown;
      let rejectShutdown;
      shutdownPromise = new Promise((resolve2, reject) => {
        resolveShutdown = resolve2;
        rejectShutdown = reject;
      });
      void (async () => {
        shuttingDown = true;
        unregisterJournalGrowthSessionLimits?.();
        harness.cancelIdleTimer();
        stopSessionReaper();
        const entries = Array.from(byId.values());
        const channels = Array.from(harness.values());
        harness.markDying(channels);
        for (const e of entries) {
          permissionMediator.forgetSession(e.sessionId);
          e.pendingPermissionIds.clear();
          e.pendingInteractions.clear();
        }
        defaultEntry = void 0;
        byId.clear();
        for (const e of entries) {
          telemetry.metrics?.sessionLifecycle("die");
          emitSessionLifecycle({
            type: "removed",
            sessionId: e.sessionId,
            workspaceCwd: e.workspaceCwd,
            reason: shutdownReason
          });
          flushPromptTerminals(
            e,
            "daemon_shutdown",
            "daemon shut down before the prompt completed"
          );
          try {
            e.events.publish({
              type: "session_died",
              data: { sessionId: e.sessionId, reason: shutdownReason }
            });
          } catch {
          }
          e.events.close();
        }
        const inFlightSessionAwaits = Array.from(inFlightSpawns.values()).map(
          (p) => p.then(
            () => void 0,
            () => void 0
          )
        );
        const inFlightRestoreAwaits = Array.from(inFlightRestores.values()).map(
          (restore) => restore.settlementPromise.then(
            () => void 0,
            () => void 0
          )
        );
        const abandonedNewSessionAwaits = Array.from(
          abandonedNewSessionSettlements
        );
        const inFlightChannelAwait = harness.starting ? harness.starting.then(
          () => void 0,
          () => void 0
        ) : Promise.resolve();
        const teardownResults = await Promise.allSettled([
          ...channels.map((ci) => harness.terminate(ci)),
          ...[...byId.values()].map((entry) => entry.attachments.close()),
          ...inFlightSessionAwaits,
          ...inFlightRestoreAwaits,
          ...abandonedNewSessionAwaits,
          inFlightChannelAwait
        ]);
        const teardownFailures = teardownResults.flatMap(
          (result) => result.status === "rejected" ? [result.reason] : []
        );
        if (teardownFailures.length === 1) throw teardownFailures[0];
        if (teardownFailures.length > 1) {
          throw new AggregateError(
            teardownFailures,
            "ACP bridge shutdown failed"
          );
        }
      })().then(resolveShutdown, rejectShutdown);
      return shutdownPromise;
    },
    preheat: harness.preheat
  };
  sendTrackedPrompt.fn = bridgeApi.sendPrompt.bind(bridgeApi);
  return bridgeApi;
}
__name(createSessionControlPlane, "createSessionControlPlane");

// packages/acp-bridge/src/bridge.ts
function createAcpSessionBridge(opts) {
  return createSessionControlPlane(opts, createChannelHarness);
}
__name(createAcpSessionBridge, "createAcpSessionBridge");
var createHttpAcpBridge = createAcpSessionBridge;

export {
  SessionArtifactValidationError,
  SessionArtifactAuthorizationError,
  SCHEDULED_TASK_RUN_SOURCE_TYPE,
  SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX,
  parseSessionSource,
  isA2uiToolMeta,
  extractErrorMessage,
  extractErrorCode,
  classifyTurnErrorKind,
  createAcpSessionBridge,
  createHttpAcpBridge
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
