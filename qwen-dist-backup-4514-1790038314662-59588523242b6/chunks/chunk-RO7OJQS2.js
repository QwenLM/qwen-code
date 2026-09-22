// Force strict mode and setup for ESM
"use strict";
import {
  CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS
} from "./chunk-CJ3DHN5I.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/sdk-typescript/src/daemon/index.ts
init_esbuild_shims();

// packages/sdk-typescript/src/daemon/DaemonClient.ts
init_esbuild_shims();

// packages/acp-bridge/dist/mcpTimeouts.js
init_esbuild_shims();
var MCP_RESTART_SERVER_DEADLINE_MS = 3e5;
var MCP_RESTART_CLIENT_HEADROOM_MS = 3e4;

// packages/sdk-typescript/src/daemon/DaemonAuthFlow.ts
init_esbuild_shims();

// packages/sdk-typescript/src/daemon/DaemonHttpError.ts
init_esbuild_shims();
var DaemonHttpError = class extends Error {
  static {
    __name(this, "DaemonHttpError");
  }
  status;
  body;
  constructor(status, body, message) {
    super(message);
    this.name = "DaemonHttpError";
    this.status = status;
    this.body = body;
  }
};
function getErrorBodyRecord(body) {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? body : void 0;
}
__name(getErrorBodyRecord, "getErrorBodyRecord");
function isSubagentSessionNotFound(error, toolCallId) {
  if (!(error instanceof DaemonHttpError) || error.status !== 404) {
    return false;
  }
  const body = getErrorBodyRecord(error.body);
  if (body?.["code"] !== "session_not_found") return false;
  return toolCallId === void 0 || body["toolCallId"] === toolCallId;
}
__name(isSubagentSessionNotFound, "isSubagentSessionNotFound");
function isSessionLevelNotFound(error) {
  if (!(error instanceof DaemonHttpError) || error.status !== 404) {
    return false;
  }
  const body = getErrorBodyRecord(error.body);
  if (body?.["code"] !== "session_not_found") return false;
  const toolCallId = body["toolCallId"];
  return toolCallId === void 0 || toolCallId === null;
}
__name(isSessionLevelNotFound, "isSessionLevelNotFound");

// packages/sdk-typescript/src/daemon/DaemonAuthFlow.ts
var DEVICE_FLOW_EXPIRY_GRACE_MS = 3e4;
var TERMINAL_STATUSES = /* @__PURE__ */ new Set(
  ["authorized", "expired", "error", "cancelled"]
);
var DaemonAuthFlow = class {
  constructor(client) {
    this.client = client;
  }
  static {
    __name(this, "DaemonAuthFlow");
  }
  async start(opts) {
    const initial = await this.client.startDeviceFlow(opts);
    const handleClient = this.client;
    const handle = {
      deviceFlowId: initial.deviceFlowId,
      providerId: initial.providerId,
      userCode: initial.userCode,
      verificationUri: initial.verificationUri,
      verificationUriComplete: initial.verificationUriComplete,
      expiresAt: initial.expiresAt,
      intervalMs: initial.intervalMs,
      attached: initial.attached,
      cancel: /* @__PURE__ */ __name(() => handleClient.cancelDeviceFlow(initial.deviceFlowId, {
        clientId: opts.clientId
      }), "cancel"),
      awaitCompletion: /* @__PURE__ */ __name(async (waitOpts = {}) => {
        const finalState = await awaitCompletion(
          handleClient,
          initial,
          opts.clientId,
          waitOpts
        );
        return finalState;
      }, "awaitCompletion")
    };
    return handle;
  }
  status(deviceFlowId, opts) {
    return this.client.getDeviceFlow(deviceFlowId, opts);
  }
  cancel(deviceFlowId, opts) {
    return this.client.cancelDeviceFlow(deviceFlowId, opts);
  }
};
async function awaitCompletion(client, start, clientId, opts) {
  return await pollUntilTerminal(client, start, clientId, opts);
}
__name(awaitCompletion, "awaitCompletion");
async function getDeviceFlowOrSynthetic404(client, start, clientId, signal) {
  try {
    return await client.getDeviceFlow(start.deviceFlowId, {
      clientId,
      signal
    });
  } catch (err) {
    if (err instanceof DaemonHttpError && err.status === 404) {
      return {
        deviceFlowId: start.deviceFlowId,
        providerId: start.providerId,
        status: "error",
        errorKind: "not_found_or_evicted",
        hint: "device-flow not found on daemon (evicted past terminal grace, daemon restart, or unknown deviceFlowId)",
        createdAt: Date.now()
      };
    }
    throw err;
  }
}
__name(getDeviceFlowOrSynthetic404, "getDeviceFlowOrSynthetic404");
function sanitizePositiveMs(raw, opts = {}) {
  if (raw === void 0) return void 0;
  if (!Number.isFinite(raw)) return void 0;
  if (opts.allowZero ? raw < 0 : raw <= 0) return void 0;
  return raw;
}
__name(sanitizePositiveMs, "sanitizePositiveMs");
async function pollUntilTerminal(client, start, clientId, opts) {
  const signal = opts.signal;
  const sanitizedTimeoutMs = sanitizePositiveMs(opts.timeoutMs, {
    allowZero: true
  });
  const sanitizedPollOverrideMs = sanitizePositiveMs(opts.pollOverrideMs);
  const ceiling = sanitizedTimeoutMs !== void 0 ? Date.now() + sanitizedTimeoutMs : start.expiresAt + DEVICE_FLOW_EXPIRY_GRACE_MS;
  let interval = Math.max(
    1e3,
    sanitizedPollOverrideMs ?? start.intervalMs ?? 5e3
  );
  let lastIntervalMs = interval;
  while (true) {
    if (signal?.aborted) {
      throw signalAbortError(signal);
    }
    const now = Date.now();
    if (now >= ceiling) {
      return await getDeviceFlowOrSynthetic404(client, start, clientId, signal);
    }
    const snapshot = await getDeviceFlowOrSynthetic404(
      client,
      start,
      clientId,
      signal
    );
    if (snapshot.intervalMs && snapshot.intervalMs !== lastIntervalMs) {
      lastIntervalMs = snapshot.intervalMs;
      interval = snapshot.intervalMs;
      opts.onThrottled?.(snapshot.intervalMs);
    }
    if (TERMINAL_STATUSES.has(snapshot.status)) return snapshot;
    await waitFor(interval, signal);
  }
}
__name(pollUntilTerminal, "pollUntilTerminal");
async function waitFor(ms, signal) {
  if (signal?.aborted) throw signalAbortError(signal);
  await new Promise((resolve, reject) => {
    const handle = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = /* @__PURE__ */ __name(() => {
      cleanup();
      reject(signalAbortError(signal));
    }, "onAbort");
    function cleanup() {
      clearTimeout(handle);
      signal?.removeEventListener("abort", onAbort);
    }
    __name(cleanup, "cleanup");
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
__name(waitFor, "waitFor");
function signalAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("aborted");
}
__name(signalAbortError, "signalAbortError");

// packages/sdk-typescript/src/daemon/session-pr.ts
init_esbuild_shims();
var MAX_SESSION_PR_URL_LENGTH = 2048;
var MAX_SESSION_PR_ISSUES = 10;
function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
__name(hasControlCharacter, "hasControlCharacter");
function isBindingUrl(value) {
  return typeof value === "string" && value.length <= MAX_SESSION_PR_URL_LENGTH && /^https?:\/\//i.test(value) && !hasControlCharacter(value);
}
__name(isBindingUrl, "isBindingUrl");
function isDaemonSessionIssueInfo(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = value;
  return typeof v["number"] === "number" && Number.isInteger(v["number"]) && v["number"] > 0 && isBindingUrl(v["url"]) && (v["state"] === void 0 || v["state"] === "open" || v["state"] === "completed" || v["state"] === "not_planned");
}
__name(isDaemonSessionIssueInfo, "isDaemonSessionIssueInfo");
function isDaemonSessionPrInfo(value) {
  if (typeof value !== "object" || value === null) return false;
  const v = value;
  return typeof v["number"] === "number" && Number.isInteger(v["number"]) && v["number"] > 0 && isBindingUrl(v["url"]) && (v["state"] === void 0 || v["state"] === "open" || v["state"] === "merged" || v["state"] === "closed") && (v["issues"] === void 0 || Array.isArray(v["issues"]) && v["issues"].length <= MAX_SESSION_PR_ISSUES && v["issues"].every(isDaemonSessionIssueInfo));
}
__name(isDaemonSessionPrInfo, "isDaemonSessionPrInfo");

// packages/sdk-typescript/src/daemon/RestSseTransport.ts
init_esbuild_shims();

// packages/sdk-typescript/src/daemon/DaemonTransport.ts
init_esbuild_shims();
var DaemonTransportClosedError = class extends Error {
  static {
    __name(this, "DaemonTransportClosedError");
  }
  constructor(message) {
    super(message ?? "Transport connection closed");
    this.name = "DaemonTransportClosedError";
  }
};

// packages/sdk-typescript/src/daemon/sse.ts
init_esbuild_shims();
var SseFramingError = class extends Error {
  static {
    __name(this, "SseFramingError");
  }
  constructor(message) {
    super(message);
    this.name = "SseFramingError";
  }
};
var MAX_BUF_CHARS = 16 * 1024 * 1024;
async function* parseSseStream(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let onAbort;
  if (signal) {
    onAbort = /* @__PURE__ */ __name(() => {
      reader.cancel().catch(() => {
      });
    }, "onAbort");
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    while (true) {
      if (signal?.aborted) {
        return;
      }
      let value;
      let done;
      try {
        ({ value, done } = await reader.read());
      } catch (err) {
        if (signal?.aborted) return;
        throw err;
      }
      if (done) {
        buf += decoder.decode();
        if (buf.length > 0) {
          const consumed2 = consumeFrames(buf);
          for (const raw of consumed2.frames) {
            const frame = parseFrame(raw);
            if (frame) yield frame;
          }
          if (consumed2.tail.length > 0) {
            const frame = parseFrame(consumed2.tail);
            if (frame) yield frame;
          }
        }
        return;
      }
      buf += decoder.decode(value, { stream: true });
      if (buf.length > MAX_BUF_CHARS) {
        throw new SseFramingError(
          `parseSseStream: unread buffer exceeded ${MAX_BUF_CHARS} UTF-16 code units without a frame separator \u2014 upstream likely not SSE`
        );
      }
      const consumed = consumeFrames(buf);
      if (consumed.frames.length > 0) {
        for (const raw of consumed.frames) {
          const frame = parseFrame(raw);
          if (frame) yield frame;
        }
      }
      buf = consumed.tail;
    }
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    try {
      await reader.cancel();
    } catch {
    }
  }
}
__name(parseSseStream, "parseSseStream");
function consumeFrames(buf) {
  const frames = [];
  let cursor = 0;
  while (cursor < buf.length) {
    const lf = buf.indexOf("\n\n", cursor);
    if (lf === -1) {
      const crlf = buf.indexOf("\r\n\r\n", cursor);
      if (crlf === -1) break;
      frames.push(buf.slice(cursor, crlf));
      cursor = crlf + 4;
      continue;
    }
    const window = buf.slice(cursor, lf);
    const crlfInWindow = window.indexOf("\r\n\r\n");
    if (crlfInWindow !== -1) {
      const crlf = cursor + crlfInWindow;
      frames.push(buf.slice(cursor, crlf));
      cursor = crlf + 4;
    } else {
      frames.push(buf.slice(cursor, lf));
      cursor = lf + 2;
    }
  }
  return { frames, tail: buf.slice(cursor) };
}
__name(consumeFrames, "consumeFrames");
function parseFrame(raw) {
  if (!raw) return void 0;
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const rest = line.slice(5);
    dataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest);
  }
  if (dataLines.length === 0) return void 0;
  const dataText = dataLines.join("\n");
  try {
    const parsed = JSON.parse(dataText);
    if (typeof parsed !== "object" || parsed === null) return void 0;
    if (Array.isArray(parsed)) return void 0;
    if (parsed.v !== 1 || typeof parsed.type !== "string") {
      return void 0;
    }
    const rawId = parsed.id;
    if (rawId !== void 0) {
      if (!Number.isSafeInteger(rawId)) return void 0;
      if (rawId < 1) return void 0;
    }
    return parsed;
  } catch {
    return void 0;
  }
}
__name(parseFrame, "parseFrame");

// packages/sdk-typescript/src/daemon/RestSseTransport.ts
var SSE_STREAM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var RestSseTransport = class {
  static {
    __name(this, "RestSseTransport");
  }
  baseUrl;
  token;
  _fetch;
  activeSseRequests = /* @__PURE__ */ new Set();
  _disposed = false;
  type = "rest";
  supportsReplay = true;
  restFetch;
  constructor(baseUrl, token, fetchFn) {
    this.baseUrl = baseUrl;
    this.token = token;
    this._fetch = fetchFn;
    this.restFetch = fetchFn;
  }
  get connected() {
    return !this._disposed;
  }
  async fetch(url, init, _opts) {
    if (this._disposed) {
      throw new DaemonTransportClosedError();
    }
    return this._fetch(url, init);
  }
  /**
   * Open an SSE stream for the given session. Mirrors the inline
   * logic that previously lived in `DaemonClient.subscribeEvents`:
   *   - connect-phase timeout via AbortController
   *   - `Last-Event-ID` header
   *   - `?maxQueued=N` query param
   *   - content-type validation
   *   - delegation to `parseSseStream`
   */
  async *subscribeEvents(sessionId, opts = {}) {
    if (this._disposed) {
      throw new DaemonTransportClosedError();
    }
    const requestCtrl = new AbortController();
    this.activeSseRequests.add(requestCtrl);
    try {
      const headers = { Accept: "text/event-stream" };
      if (this.token) {
        headers["Authorization"] = `Bearer ${this.token}`;
      }
      if (opts.clientId) {
        headers["X-Qwen-Client-Id"] = opts.clientId;
      }
      if (opts.lastEventId !== void 0) {
        headers["Last-Event-ID"] = String(opts.lastEventId);
        if (opts.epoch !== void 0) {
          headers["X-Qwen-Event-Epoch"] = opts.epoch;
        }
      }
      const fetchSignal = opts.signal ? composeAbortSignals([opts.signal, requestCtrl.signal]) : requestCtrl.signal;
      let url = `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/events`;
      const query = new URLSearchParams();
      if (opts.maxQueued !== void 0) {
        query.set("maxQueued", String(opts.maxQueued));
      }
      if (opts.sseConnectReason !== void 0) {
        query.set("connectReason", opts.sseConnectReason);
      }
      if (opts.previousSseStreamId !== void 0) {
        query.set("previousStreamId", opts.previousSseStreamId);
      }
      const queryString = query.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
      let connectTimer;
      const connectTimeoutMs = opts.connectTimeoutMs;
      if (connectTimeoutMs && Number.isFinite(connectTimeoutMs)) {
        connectTimer = setTimeout(
          () => requestCtrl.abort(
            new DOMException("Initial connect timed out", "TimeoutError")
          ),
          connectTimeoutMs
        );
        if (typeof connectTimer === "object" && connectTimer && "unref" in connectTimer) {
          connectTimer.unref();
        }
      }
      let res;
      try {
        res = await this._fetch(url, { headers, signal: fetchSignal });
      } finally {
        if (connectTimer !== void 0) clearTimeout(connectTimer);
      }
      if (!res.ok) {
        let body;
        try {
          const text = await res.text();
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        } catch {
        }
        const detail = body && typeof body === "object" && "error" in body ? String(body.error) : `HTTP ${res.status}`;
        throw new DaemonHttpError(
          res.status,
          body,
          `GET /session/:id/events: ${detail}`
        );
      }
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.toLowerCase().includes("text/event-stream")) {
        try {
          await res.body?.cancel();
        } catch {
        }
        throw new DaemonHttpError(
          res.status,
          ct,
          `GET /session/:id/events: expected content-type text/event-stream, got "${ct}"`
        );
      }
      if (!res.body) {
        throw new Error("No SSE body");
      }
      const responseStreamId = res.headers.get("x-qwen-sse-stream-id");
      opts.onSseStreamAccepted?.(
        responseStreamId && SSE_STREAM_ID_RE.test(responseStreamId) ? responseStreamId.toLowerCase() : void 0
      );
      const responseEpoch = res.headers.get("x-qwen-event-epoch");
      if (responseEpoch) {
        opts.onEpoch?.(responseEpoch);
      }
      yield* parseSseStream(res.body, fetchSignal);
    } finally {
      requestCtrl.abort();
      this.activeSseRequests.delete(requestCtrl);
    }
  }
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const requestCtrl of this.activeSseRequests) {
      requestCtrl.abort();
    }
    this.activeSseRequests.clear();
  }
};
function composeAbortSignals(signals) {
  const anyFn = AbortSignal.any;
  if (typeof anyFn === "function") return anyFn.call(AbortSignal, signals);
  const ctrl = new AbortController();
  const cleanups = [];
  const detachAll = /* @__PURE__ */ __name(() => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        fn?.();
      } catch {
      }
    }
  }, "detachAll");
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      detachAll();
      return ctrl.signal;
    }
    const onAbort = /* @__PURE__ */ __name(() => {
      ctrl.abort(s.reason);
      detachAll();
    }, "onAbort");
    s.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => s.removeEventListener("abort", onAbort));
  }
  ctrl.signal.addEventListener("abort", detachAll, { once: true });
  return ctrl.signal;
}
__name(composeAbortSignals, "composeAbortSignals");

// packages/sdk-typescript/src/daemon/types.ts
init_esbuild_shims();

// packages/sdk-typescript/src/types/permission-mode.ts
init_esbuild_shims();
var PERMISSION_MODES = [
  "plan",
  "default",
  "auto-edit",
  "auto",
  "yolo"
];

// packages/sdk-typescript/src/daemon/types.ts
var GOAL_PAUSE_REASON_COMMAND = "Paused with /goal pause.";
var GOAL_CHECKPOINT_STALL_LIMIT = 3;
var DaemonCapabilityMissingError = class extends Error {
  static {
    __name(this, "DaemonCapabilityMissingError");
  }
  capability;
  constructor(capability, hint) {
    super(
      `DaemonCapabilities.${capability} is missing \u2014 ${hint}. The daemon you are connected to likely predates the feature that added this field; upgrade the daemon or fall back to a different code path that doesn't require it.`
    );
    this.name = "DaemonCapabilityMissingError";
    this.capability = capability;
  }
};
function requireWorkspaceCwd(caps) {
  if (typeof caps.workspaceCwd !== "string" || caps.workspaceCwd.length === 0) {
    throw new DaemonCapabilityMissingError(
      "workspaceCwd",
      caps.workspaceCwd === "" ? "daemon returned an empty workspaceCwd (newer daemon with a bug)" : "daemon predates workspaceCwd support; upgrade it"
    );
  }
  return caps.workspaceCwd;
}
__name(requireWorkspaceCwd, "requireWorkspaceCwd");
function parseDaemonBackgroundTurn(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return void 0;
  const record = value;
  if (typeof record["turnId"] !== "string" || !record["turnId"] || typeof record["taskId"] !== "string" || !record["taskId"] || record["kind"] !== "agent" && record["kind"] !== "monitor" && record["kind"] !== "shell" && record["kind"] !== "workflow" || typeof record["startedAt"] !== "number" || !Number.isFinite(record["startedAt"]) || record["startedAt"] < 0 || ["toolUseId", "sourceTurnId", "label"].some(
    (key) => record[key] !== void 0 && typeof record[key] !== "string"
  ))
    return void 0;
  return value;
}
__name(parseDaemonBackgroundTurn, "parseDaemonBackgroundTurn");
var DAEMON_ERROR_KINDS = [
  "missing_binary",
  "blocked_egress",
  "auth_env_error",
  "init_timeout",
  "restore_timeout",
  "protocol_error",
  "missing_file",
  "parse_error",
  // Budget refusal under `--mcp-budget-mode=enforce`.
  "budget_exhausted",
  // Runtime MCP mutation routes (POST/DELETE /workspace/mcp/servers).
  "mcp_budget_would_exceed",
  "mcp_server_spawn_failed",
  "invalid_config",
  // A prompt exceeded the daemon-configured wallclock cap (or the
  // request's own `deadlineMs`, capped at the server flag).
  "prompt_deadline_exceeded",
  // An SSE writer's last successful flush was older than the daemon's
  // writer-idle deadline.
  "writer_idle_timeout",
  // The model response stream ended before a complete turn could be read.
  "model_stream_interrupted",
  // Tool-call loop protection stopped the current turn.
  "loop_detected"
];
var DAEMON_CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;
function isDaemonContentHash(value) {
  return typeof value === "string" && DAEMON_CONTENT_HASH_RE.test(value);
}
__name(isDaemonContentHash, "isDaemonContentHash");
var DAEMON_APPROVAL_MODES = PERMISSION_MODES;

// packages/sdk-typescript/src/daemon/standalone-sessions.ts
init_esbuild_shims();
var STANDALONE_SESSIONS_CAPABILITY = "standalone_sessions_v1";
var STANDALONE_SESSION_OPTIONS_CAPABILITY = "standalone_session_options_v1";
var DaemonStandaloneProtocolError = class extends Error {
  constructor(route, detail) {
    super(`${route}: malformed standalone-session response (${detail})`);
    this.route = route;
    this.name = "DaemonStandaloneProtocolError";
  }
  static {
    __name(this, "DaemonStandaloneProtocolError");
  }
};
var DaemonStandaloneCreationOutcomeUnknownError = class extends Error {
  constructor(sessionId, recovery, originalError) {
    super(
      `Standalone session creation outcome is unknown for ${sessionId}; inspect recovery before retrying.`
    );
    this.sessionId = sessionId;
    this.recovery = recovery;
    this.originalError = originalError;
    this.name = "DaemonStandaloneCreationOutcomeUnknownError";
  }
  static {
    __name(this, "DaemonStandaloneCreationOutcomeUnknownError");
  }
};
function asRecord(value, route, field = "response") {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DaemonStandaloneProtocolError(route, `expected ${field} object`);
  }
  return value;
}
__name(asRecord, "asRecord");
function requireString(value, field, route, allowEmpty = false) {
  const result = value[field];
  if (typeof result !== "string" || !allowEmpty && result.length === 0) {
    throw new DaemonStandaloneProtocolError(route, `expected ${field} string`);
  }
  return result;
}
__name(requireString, "requireString");
function requireStringArray(value, field, route) {
  const result = value[field];
  if (!Array.isArray(result) || !result.every((item) => typeof item === "string")) {
    throw new DaemonStandaloneProtocolError(route, `expected ${field}[]`);
  }
}
__name(requireStringArray, "requireStringArray");
function requireSessionId(value, route, expected) {
  const sessionId = requireString(value, "sessionId", route);
  if (expected !== void 0 && sessionId !== expected) {
    throw new DaemonStandaloneProtocolError(
      route,
      `expected sessionId ${expected}, received ${sessionId}`
    );
  }
  return sessionId;
}
__name(requireSessionId, "requireSessionId");
function validateContext(value, route) {
  if (asRecord(value["context"], route, "context")["kind"] !== "standalone") {
    throw new DaemonStandaloneProtocolError(
      route,
      "expected standalone context"
    );
  }
}
__name(validateContext, "validateContext");
function validateWorkingDirectory(value, route) {
  const directory = asRecord(value, route, "workingDirectory");
  if (directory["state"] !== "ready" && directory["state"] !== "recreated") {
    throw new DaemonStandaloneProtocolError(
      route,
      "invalid workingDirectory.state"
    );
  }
  if (directory["warnings"] !== void 0) {
    requireStringArray(directory, "warnings", route);
  }
}
__name(validateWorkingDirectory, "validateWorkingDirectory");
function validateStandaloneFields(value, route) {
  if (value["sourceType"] !== "standalone") {
    throw new DaemonStandaloneProtocolError(
      route,
      "expected standalone sourceType"
    );
  }
  validateContext(value, route);
  requireString(value, "projectlessOutputDirectory", route);
  validateWorkingDirectory(value["workingDirectory"], route);
}
__name(validateStandaloneFields, "validateStandaloneFields");
function validateOptionalString(value, field, route) {
  if (value[field] !== void 0 && typeof value[field] !== "string") {
    throw new DaemonStandaloneProtocolError(route, `expected ${field} string`);
  }
}
__name(validateOptionalString, "validateOptionalString");
function validateStatusCell(value, route) {
  requireString(value, "kind", route);
  if (!["ok", "warning", "error", "disabled", "not_started", "unknown"].includes(
    String(value["status"])
  )) {
    throw new DaemonStandaloneProtocolError(route, "invalid status");
  }
  for (const field of ["error", "hint"]) {
    validateOptionalString(value, field, route);
  }
  if (value["errorKind"] !== void 0 && !DAEMON_ERROR_KINDS.includes(
    value["errorKind"]
  )) {
    throw new DaemonStandaloneProtocolError(route, "invalid errorKind");
  }
}
__name(validateStatusCell, "validateStatusCell");
function validateProviderModel(value, route) {
  const model = asRecord(value, route, "provider model");
  requireString(model, "modelId", route);
  requireString(model, "baseModelId", route);
  requireString(model, "name", route, true);
  if (model["description"] !== void 0 && model["description"] !== null && typeof model["description"] !== "string") {
    throw new DaemonStandaloneProtocolError(route, "invalid description");
  }
  if (model["contextLimit"] !== void 0 && (typeof model["contextLimit"] !== "number" || !Number.isFinite(model["contextLimit"]) || model["contextLimit"] <= 0)) {
    throw new DaemonStandaloneProtocolError(route, "invalid contextLimit");
  }
  for (const field of ["baseUrl", "envKey"]) {
    validateOptionalString(model, field, route);
  }
  for (const field of ["isCurrent", "isRuntime"]) {
    if (typeof model[field] !== "boolean") {
      throw new DaemonStandaloneProtocolError(
        route,
        `expected ${field} boolean`
      );
    }
  }
  if (model["modalities"] !== void 0) {
    const modalities = asRecord(model["modalities"], route, "modalities");
    for (const field of ["image", "pdf", "audio", "video"]) {
      if (modalities[field] !== void 0 && typeof modalities[field] !== "boolean") {
        throw new DaemonStandaloneProtocolError(
          route,
          `expected modalities.${field} boolean`
        );
      }
    }
  }
  if (model["configOptions"] !== void 0 && !Array.isArray(model["configOptions"])) {
    throw new DaemonStandaloneProtocolError(route, "expected configOptions[]");
  }
}
__name(validateProviderModel, "validateProviderModel");
function parseStandaloneSessionOptions(value, route) {
  const options = asRecord(value, route);
  if (options["workspaceCwd"] !== void 0 || options["acpChannelLive"] !== void 0) {
    throw new DaemonStandaloneProtocolError(
      route,
      "standalone options exposed workspace internals"
    );
  }
  if (options["v"] !== 1) {
    throw new DaemonStandaloneProtocolError(route, "expected v=1");
  }
  if (typeof options["initialized"] !== "boolean") {
    throw new DaemonStandaloneProtocolError(
      route,
      "expected initialized boolean"
    );
  }
  if (options["current"] !== void 0) {
    const current = asRecord(options["current"], route, "current");
    for (const field of [
      "authType",
      "modelId",
      "baseUrl",
      "fastModelId",
      "visionModelId"
    ]) {
      validateOptionalString(current, field, route);
    }
  }
  if (options["approvalMode"] !== void 0 && !DAEMON_APPROVAL_MODES.includes(
    options["approvalMode"]
  )) {
    throw new DaemonStandaloneProtocolError(route, "invalid approvalMode");
  }
  if (!Array.isArray(options["providers"])) {
    throw new DaemonStandaloneProtocolError(route, "expected providers[]");
  }
  for (const value2 of options["providers"]) {
    const provider = asRecord(value2, route, "provider");
    validateStatusCell(provider, route);
    if (provider["kind"] !== "model_provider") {
      throw new DaemonStandaloneProtocolError(
        route,
        "expected model_provider kind"
      );
    }
    requireString(provider, "authType", route);
    if (typeof provider["current"] !== "boolean") {
      throw new DaemonStandaloneProtocolError(
        route,
        "expected provider current boolean"
      );
    }
    if (!Array.isArray(provider["models"])) {
      throw new DaemonStandaloneProtocolError(route, "expected models[]");
    }
    for (const model of provider["models"]) {
      validateProviderModel(model, route);
    }
  }
  if (options["errors"] !== void 0) {
    if (!Array.isArray(options["errors"])) {
      throw new DaemonStandaloneProtocolError(route, "expected errors[]");
    }
    for (const value2 of options["errors"]) {
      validateStatusCell(asRecord(value2, route, "error"), route);
    }
  }
  return options;
}
__name(parseStandaloneSessionOptions, "parseStandaloneSessionOptions");
function parseStandaloneSession(value, route, expectedSessionId) {
  const session = asRecord(value, route);
  requireSessionId(session, route, expectedSessionId);
  requireString(session, "workspaceCwd", route);
  if (typeof session["attached"] !== "boolean") {
    throw new DaemonStandaloneProtocolError(route, "expected attached boolean");
  }
  if (session["modelApplied"] !== void 0 && typeof session["modelApplied"] !== "boolean") {
    throw new DaemonStandaloneProtocolError(
      route,
      "expected modelApplied boolean"
    );
  }
  validateStandaloneFields(session, route);
  return session;
}
__name(parseStandaloneSession, "parseStandaloneSession");
function parseRestoredStandaloneSession(value, route, expectedSessionId) {
  const raw = asRecord(value, route);
  parseStandaloneSession(raw, route, expectedSessionId);
  asRecord(raw["state"], route, "state");
  return raw;
}
__name(parseRestoredStandaloneSession, "parseRestoredStandaloneSession");
function parseStandaloneSummary(value, route, expectedSessionId) {
  const summary = asRecord(value, route);
  requireSessionId(summary, route, expectedSessionId);
  requireString(summary, "workspaceCwd", route);
  if (summary["sourceType"] !== "standalone") {
    throw new DaemonStandaloneProtocolError(
      route,
      "expected standalone sourceType"
    );
  }
  validateContext(summary, route);
  return summary;
}
__name(parseStandaloneSummary, "parseStandaloneSummary");
function parseStandaloneLookup(value, route, expectedSessionId) {
  const lookup = asRecord(value, route);
  if (lookup["state"] === "creating") {
    const sessionId = requireSessionId(lookup, route, expectedSessionId);
    return { sessionId, state: "creating" };
  }
  return parseStandaloneSummary(lookup, route, expectedSessionId);
}
__name(parseStandaloneLookup, "parseStandaloneLookup");
function parseStandaloneListPage(value, route) {
  const page = asRecord(value, route);
  if (!Array.isArray(page["sessions"])) {
    throw new DaemonStandaloneProtocolError(route, "expected sessions[]");
  }
  if (page["nextCursor"] !== void 0 && typeof page["nextCursor"] !== "string") {
    throw new DaemonStandaloneProtocolError(
      route,
      "expected nextCursor string"
    );
  }
  for (const field of ["liveMergeFailed", "truncated"]) {
    if (page[field] !== void 0 && typeof page[field] !== "boolean") {
      throw new DaemonStandaloneProtocolError(
        route,
        `expected ${field} boolean`
      );
    }
  }
  for (const session of page["sessions"])
    parseStandaloneSummary(session, route);
  return page;
}
__name(parseStandaloneListPage, "parseStandaloneListPage");
function parseStandaloneDirectoryResult(value, route, expectedSessionId) {
  const result = asRecord(value, route);
  requireSessionId(result, route, expectedSessionId);
  requireString(result, "projectlessOutputDirectory", route);
  validateWorkingDirectory(result["workingDirectory"], route);
  return result;
}
__name(parseStandaloneDirectoryResult, "parseStandaloneDirectoryResult");
function parseStandaloneMetadataResult(value, route, expectedSessionId) {
  const result = asRecord(value, route);
  requireSessionId(result, route, expectedSessionId);
  requireString(result, "displayName", route, true);
  return result;
}
__name(parseStandaloneMetadataResult, "parseStandaloneMetadataResult");
function validateBatch(value, route, fields) {
  const result = asRecord(value, route);
  for (const field of fields) requireStringArray(result, field, route);
  if (!Array.isArray(result["errors"])) {
    throw new DaemonStandaloneProtocolError(route, "expected errors[]");
  }
  for (const item of result["errors"]) {
    const error = asRecord(item, route, "batch error");
    for (const field of ["sessionId", "code", "message"]) {
      requireString(error, field, route);
    }
  }
  return result;
}
__name(validateBatch, "validateBatch");
function parseArchiveStandaloneSessionsResult(value, route) {
  return validateBatch(value, route, [
    "archived",
    "alreadyArchived",
    "notFound"
  ]);
}
__name(parseArchiveStandaloneSessionsResult, "parseArchiveStandaloneSessionsResult");
function parseUnarchiveStandaloneSessionsResult(value, route) {
  return validateBatch(value, route, [
    "unarchived",
    "alreadyActive",
    "notFound"
  ]);
}
__name(parseUnarchiveStandaloneSessionsResult, "parseUnarchiveStandaloneSessionsResult");
function parseDeleteStandaloneSessionsResult(value, route) {
  return validateBatch(value, route, [
    "removed",
    "notFound",
    "fileCleanupPending"
  ]);
}
__name(parseDeleteStandaloneSessionsResult, "parseDeleteStandaloneSessionsResult");
function isStandaloneSessionNotFoundError(error) {
  return error instanceof DaemonHttpError && error.status === 404 && recordCode(error.body) === "standalone_session_not_found";
}
__name(isStandaloneSessionNotFoundError, "isStandaloneSessionNotFoundError");
function isStandaloneCreationOutcomeUnknown(error) {
  return error instanceof DaemonStandaloneCreationOutcomeUnknownError || error instanceof DaemonHttpError && recordCode(error.body) === "standalone_creation_outcome_unknown";
}
__name(isStandaloneCreationOutcomeUnknown, "isStandaloneCreationOutcomeUnknown");
function recordCode(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value["code"] : void 0;
}
__name(recordCode, "recordCode");

// packages/sdk-typescript/src/daemon/DaemonClient.ts
var WORKSPACE_MEMORY_REMEMBER_PATH = "/workspace/memory/remember";
var WORKSPACE_MEMORY_FORGET_PATH = "/workspace/memory/forget";
var WORKSPACE_MEMORY_DREAM_PATH = "/workspace/memory/dream";
function parseSessionGenerationEvent(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return void 0;
  }
  const event = value;
  if (event["v"] !== 1 || typeof event["type"] !== "string") return void 0;
  const requestId = event["requestId"];
  const modelSource = event["modelSource"];
  const validRequestId = typeof requestId === "string" && requestId.length > 0;
  const validModelSource = modelSource === "fast" || modelSource === "main";
  const validTokenCount = /* @__PURE__ */ __name((count) => count === void 0 || typeof count === "number" && Number.isSafeInteger(count) && count >= 0, "validTokenCount");
  if (event["type"] === "started") {
    if (!validRequestId || typeof event["model"] !== "string" || !validModelSource) {
      return void 0;
    }
  } else if (event["type"] === "thinking") {
    if (!validRequestId) return void 0;
  } else if (event["type"] === "delta") {
    if (!validRequestId || !Number.isSafeInteger(event["seq"]) || event["seq"] < 0 || typeof event["text"] !== "string" || event["text"].length === 0) {
      return void 0;
    }
  } else if (event["type"] === "done") {
    if (!validRequestId || typeof event["model"] !== "string" || !validModelSource || !validTokenCount(event["inputTokens"]) || !validTokenCount(event["outputTokens"])) {
      return void 0;
    }
  } else if (event["type"] === "error") {
    if (typeof event["code"] !== "string" || typeof event["message"] !== "string") {
      return void 0;
    }
  } else {
    return void 0;
  }
  return event;
}
__name(parseSessionGenerationEvent, "parseSessionGenerationEvent");
var DEFAULT_SESSION_LIST_PAGE_SIZE = 20;
var DEFAULT_FETCH_TIMEOUT_MS = 3e4;
var CAPABILITY_PREFLIGHT_TTL_MS = 6e4;
var DEFAULT_PROVIDER_MUTATION_TIMEOUT_MS = 0;
var DEFAULT_SESSION_RESTORE_TIMEOUT_MS = 7e4;
var SESSION_RESTORE_TIMEOUT_HEADROOM_MS = 1e4;
var VOICE_TRANSCRIPTION_DEFAULT_TIMEOUT_MS = 65e3;
var GITHUB_SETUP_DEFAULT_TIMEOUT_MS = 9e4;
var CHANNEL_NOTIFY_DEFAULT_TIMEOUT_MS = 35e3;
var WORKSPACE_RUNTIME_ENSURE_SERVER_DEADLINE_MS = 6e4;
var WORKSPACE_RUNTIME_ENSURE_CLIENT_HEADROOM_MS = 2e3;
var WORKSPACE_RUNTIME_ENSURE_TIMEOUT_MS = WORKSPACE_RUNTIME_ENSURE_SERVER_DEADLINE_MS + WORKSPACE_RUNTIME_ENSURE_CLIENT_HEADROOM_MS;
var MAX_TIMER_DELAY_MS = 2147483647;
var DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5;
var MCP_RESTART_DEFAULT_TIMEOUT_MS = MCP_RESTART_SERVER_DEADLINE_MS + MCP_RESTART_CLIENT_HEADROOM_MS;
var CLIENT_ID_HEADER = "X-Qwen-Client-Id";
var urlEncode = encodeURIComponent;
function transcriptPageSuffix(opts) {
  const query = new URLSearchParams();
  if (opts.compactedReplayMode !== void 0)
    query.set("compactedReplayMode", opts.compactedReplayMode);
  if (opts.cursor !== void 0) query.set("cursor", opts.cursor);
  if (opts.direction !== void 0) query.set("direction", opts.direction);
  if (opts.atRecordId !== void 0) query.set("atRecordId", opts.atRecordId);
  if (opts.snapshot !== void 0) query.set("snapshot", opts.snapshot);
  if (opts.beforeRecordId !== void 0) {
    query.set("beforeRecordId", opts.beforeRecordId);
  }
  if (opts.limit !== void 0) query.set("limit", String(opts.limit));
  const value = query.toString();
  return value ? `?${value}` : "";
}
__name(transcriptPageSuffix, "transcriptPageSuffix");
function turnIndexPageSuffix(opts) {
  const query = new URLSearchParams();
  if (opts.snapshot !== void 0) query.set("snapshot", opts.snapshot);
  if (opts.start !== void 0) query.set("start", String(opts.start));
  if (opts.limit !== void 0) query.set("limit", String(opts.limit));
  const value = query.toString();
  return value ? `?${value}` : "";
}
__name(turnIndexPageSuffix, "turnIndexPageSuffix");
function normalizePermissionRuleInput(rule) {
  const trimmed = rule.trim();
  if (!trimmed) {
    throw new Error("rule must be a non-empty string");
  }
  return trimmed;
}
__name(normalizePermissionRuleInput, "normalizePermissionRuleInput");
function normalizePendingPromptLimit(value) {
  if (value === void 0) return DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION;
  if (value === null || value === 0 || value === Infinity) {
    return Infinity;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("bad maxPendingPromptsPerSession");
  }
  return value;
}
__name(normalizePendingPromptLimit, "normalizePendingPromptLimit");
function stripTrailingSlashes(url) {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return end === url.length ? url : url.slice(0, end);
}
__name(stripTrailingSlashes, "stripTrailingSlashes");
function createStandaloneSessionId() {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = bytes[6] & 15 | 64;
  bytes[8] = bytes[8] & 63 | 128;
  const hex = Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
__name(createStandaloneSessionId, "createStandaloneSessionId");
function readTokenFromEnv() {
  try {
    const proc = globalThis.process;
    const raw = proc?.env?.["QWEN_SERVER_TOKEN"];
    if (typeof raw !== "string") return void 0;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? void 0 : trimmed;
  } catch {
    return void 0;
  }
}
__name(readTokenFromEnv, "readTokenFromEnv");
var DaemonPendingPromptLimitError = class extends Error {
  static {
    __name(this, "DaemonPendingPromptLimitError");
  }
  constructor(sessionId, limit, pendingCount) {
    super(`Pending prompts full: "${sessionId}" (${pendingCount}/${limit})`);
    this.name = "DaemonPendingPromptLimitError";
    this.sessionId = sessionId;
    this.limit = limit;
    this.pendingCount = pendingCount;
  }
};
var DaemonSessionIdProtocolError = class extends Error {
  constructor(requestedSessionId, actualSessionId) {
    super(
      `Daemon returned session "${actualSessionId}" instead of requested session "${requestedSessionId}".`
    );
    this.requestedSessionId = requestedSessionId;
    this.actualSessionId = actualSessionId;
    this.name = "DaemonSessionIdProtocolError";
  }
  static {
    __name(this, "DaemonSessionIdProtocolError");
  }
};
var EXTENSION_ARCHIVE_UPLOAD_TIMEOUT_MS = 12e4;
function isDaemonTurnError(error) {
  return typeof error === "object" && error !== null && error._daemonTurnError === true;
}
__name(isDaemonTurnError, "isDaemonTurnError");
function isStaleBranchPointError(error) {
  return error instanceof DaemonHttpError && error.status === 409 && error.body?.code === "branch_point_invalid";
}
__name(isStaleBranchPointError, "isStaleBranchPointError");
var DaemonClient = class {
  static {
    __name(this, "DaemonClient");
  }
  baseUrl;
  token;
  _fetch;
  fetchTimeoutMs;
  hasExplicitFetchTimeout;
  cachedSessionRestoreTimeoutMs;
  capabilityFeatures;
  capabilitiesRequest;
  capabilitiesGeneration = 0;
  restoreBudgetGeneration = 0;
  promptLimit;
  promptCounts = /* @__PURE__ */ Object.create(null);
  /**
   * Pluggable transport layer. Defaults to `RestSseTransport` when
   * no explicit transport is supplied — preserving the pre-abstraction
   * REST+SSE behavior with zero breaking changes.
   */
  transport;
  // Lazy singleton so clients that never touch auth pay no allocation cost.
  // Exposed via the readonly `auth` accessor below.
  _authFlow;
  /**
   * High-level auth helper. Wraps the four
   * `*DeviceFlow*` methods with a `start(...).awaitCompletion()` shape
   * for the common "log in remotely" UX. Lazy-constructed.
   */
  get auth() {
    if (!this._authFlow) {
      this._authFlow = new DaemonAuthFlow(this);
    }
    return this._authFlow;
  }
  constructor(opts) {
    this.baseUrl = stripTrailingSlashes(opts.baseUrl);
    this.token = opts.token ?? readTokenFromEnv();
    this._fetch = opts.fetch ?? opts.transport?.restFetch ?? globalThis.fetch.bind(globalThis);
    this.hasExplicitFetchTimeout = opts.fetchTimeoutMs !== void 0;
    const raw = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.fetchTimeoutMs = Number.isFinite(raw) && raw > 0 ? raw : 0;
    this.promptLimit = normalizePendingPromptLimit(
      opts.maxPendingPromptsPerSession
    );
    this.transport = opts.transport ?? new RestSseTransport(this.baseUrl, this.token, this._fetch);
  }
  get maxPendingPromptsPerSession() {
    return this.promptLimit;
  }
  /** @internal */
  reservePromptSlot(sessionId, limit = this.promptLimit) {
    if (limit === Infinity) return () => {
    };
    const promptCounts = this.promptCounts;
    const pendingCount = promptCounts[sessionId] ?? 0;
    if (pendingCount >= limit) {
      throw new DaemonPendingPromptLimitError(sessionId, limit, pendingCount);
    }
    promptCounts[sessionId] = pendingCount + 1;
    let released;
    return () => {
      if (released) return;
      released = true;
      if ((promptCounts[sessionId] ?? 0) <= 1) {
        delete promptCounts[sessionId];
      } else {
        --promptCounts[sessionId];
      }
    };
  }
  /**
   * Wrap a fetch call with the per-client `fetchTimeoutMs`. If the caller
   * passes their own `signal`, both signals abort the request via
   * `AbortSignal.any`, so caller cancellation and the per-call timeout
   * compose. Streaming endpoints (subscribeEvents) call `_fetch` directly
   * to skip the timeout — long-lived SSE connections must not be killed
   * by it.
   */
  async fetchWithTimeout(url, init = {}, consume, perCallTimeoutMs, mode = "transport") {
    let effectiveTimeoutMs = this.fetchTimeoutMs;
    if (perCallTimeoutMs !== void 0 && Number.isFinite(perCallTimeoutMs) && perCallTimeoutMs >= 0) {
      effectiveTimeoutMs = perCallTimeoutMs;
    }
    if (!effectiveTimeoutMs || !Number.isFinite(effectiveTimeoutMs)) {
      const res = mode === "rest" ? await this._fetch(url, init) : await this.transport.fetch(url, init);
      if (consume) return consume(res);
      return res;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort(new DOMException("timeout", "TimeoutError"));
    }, effectiveTimeoutMs);
    if (typeof timer === "object" && timer && "unref" in timer) {
      timer.unref();
    }
    const callerSignal = init.signal ?? void 0;
    const signal = callerSignal ? composeAbortSignals2([callerSignal, ctrl.signal]) : ctrl.signal;
    try {
      const res = mode === "rest" ? await this._fetch(url, { ...init, signal }) : await this.transport.fetch(url, { ...init, signal });
      if (consume) return await consume(res);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
  // -- Plumbing -----------------------------------------------------------
  headers(extra = {}, clientId) {
    const out = { ...extra };
    if (this.token) out["Authorization"] = `Bearer ${this.token}`;
    if (clientId) out[CLIENT_ID_HEADER] = clientId;
    return out;
  }
  async failOnError(res, label, sessionId) {
    let body = void 0;
    try {
      const text = await res.text();
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
    } catch {
    }
    const errorBody = body && typeof body === "object" && !Array.isArray(body) ? body : void 0;
    let detail = errorBody && "error" in errorBody ? String(errorBody["error"]) : `HTTP ${res.status}`;
    if (res.status >= 500 && errorBody?.["error"] === "Internal error" && typeof errorBody["code"] === "number") {
      const data = errorBody["data"];
      if (typeof data === "string" && data.length > 0) {
        detail = data;
      } else if (data && typeof data === "object" && !Array.isArray(data)) {
        const record = data;
        const details = record["details"];
        const message = record["message"];
        if (typeof details === "string" && details.length > 0) {
          detail = details;
        } else if (typeof message === "string" && message.length > 0) {
          detail = message;
        }
      }
    }
    if (sessionId && res.status === 503 && body && typeof body === "object") {
      const data = body;
      if (data.code === "prompt_queue_full") {
        return new DaemonPendingPromptLimitError(
          typeof data.sessionId === "string" ? data.sessionId : sessionId,
          typeof data.limit === "number" ? data.limit : 0,
          typeof data.pendingCount === "number" ? data.pendingCount : 0
        );
      }
    }
    return new DaemonHttpError(res.status, body, `${label}: ${detail}`);
  }
  async jsonRequest(path, label, opts = {}) {
    const hasBody = opts.body !== void 0;
    return await this.fetchWithTimeout(
      `${this.baseUrl}${path}`,
      {
        ...opts.method ? { method: opts.method } : {},
        headers: this.headers(
          hasBody ? { "Content-Type": "application/json" } : {},
          opts.clientId
        ),
        ...hasBody ? { body: JSON.stringify(opts.body) } : {},
        ...opts.signal ? { signal: opts.signal } : {}
      },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, label);
        return await res.json();
      },
      opts.timeoutMs,
      opts.mode
    );
  }
  /** @internal */
  async workspaceJsonRequest(workspaceSelector, path, label, opts = {}) {
    return await this.jsonRequest(
      `/workspaces/${workspaceSelector}${path}`,
      label,
      opts
    );
  }
  /** @internal */
  async sessionExportRequest(path, label, opts = {}) {
    const format = opts.format ?? "html";
    const query = opts.format ? `?format=${urlEncode(opts.format)}` : "";
    return await this.fetchWithTimeout(
      `${this.baseUrl}${path}${query}`,
      { headers: this.headers({}, opts.clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, label);
        }
        const content = await res.text();
        const mimeType = res.headers.get("content-type") ?? "";
        const filename = /filename="([^"]+)"/i.exec(
          res.headers.get("content-disposition") ?? ""
        )?.[1] ?? `export.${format}`;
        return {
          content,
          filename,
          mimeType,
          format
        };
      },
      void 0,
      "rest"
    );
  }
  /** @internal */
  async workspaceNoContentRequest(workspaceSelector, path, label, opts = {}) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspaces/${workspaceSelector}${path}`,
      {
        ...opts.method ? { method: opts.method } : {},
        headers: this.headers({}, opts.clientId)
      },
      async (res) => {
        if (res.status === 204) {
          try {
            await res.body?.cancel();
          } catch {
          }
          return;
        }
        if (res.status === 404 && opts.okNotFoundCode) {
          const err = await this.failOnError(res, label);
          const body = err.body;
          if (body?.code === opts.okNotFoundCode) return;
          throw err;
        }
        throw await this.failOnError(res, label);
      },
      opts.timeoutMs
    );
  }
  workspaceById(workspaceId) {
    return new WorkspaceDaemonClient(this, urlEncode(workspaceId));
  }
  workspaceByCwd(workspaceCwd) {
    return new WorkspaceDaemonClient(this, urlEncode(workspaceCwd));
  }
  // -- Lifecycle / discovery ---------------------------------------------
  async health() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/health`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "GET /health");
        return await res.json();
      }
    );
  }
  async capabilities() {
    const generation = ++this.capabilitiesGeneration;
    this.capabilityFeatures = void 0;
    const request = this.fetchWithTimeout(
      `${this.baseUrl}/capabilities`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "GET /capabilities");
        return await res.json();
      }
    );
    this.capabilitiesRequest = request;
    try {
      const capabilities = await request;
      if (generation === this.capabilitiesGeneration) {
        this.capabilityFeatures = {
          features: new Set(
            Array.isArray(capabilities.features) ? capabilities.features : []
          ),
          expiresAt: Date.now() + CAPABILITY_PREFLIGHT_TTL_MS
        };
      }
      if (generation > this.restoreBudgetGeneration) {
        this.restoreBudgetGeneration = generation;
        const restoreTimeoutMs = capabilities.limits?.sessionRestoreTimeoutMs;
        this.cachedSessionRestoreTimeoutMs = typeof restoreTimeoutMs === "number" && Number.isInteger(restoreTimeoutMs) && restoreTimeoutMs > 0 && restoreTimeoutMs <= MAX_TIMER_DELAY_MS ? restoreTimeoutMs : void 0;
      }
      return capabilities;
    } finally {
      if (generation === this.capabilitiesGeneration) {
        this.capabilitiesRequest = void 0;
      }
    }
  }
  /**
   * The Web Shell's product name and logo, resolved by the daemon from the
   * operator settings scopes (system defaults, user, system). Workspace
   * settings never contribute. An empty object means the client should use its
   * built-in brand.
   *
   * Separate from `capabilities()` because that envelope's contract is that
   * clients probe by connecting rather than reading ambient settings into it.
   * A daemon that supports it advertises the `web_shell_brand` feature tag, so
   * callers can preflight instead of relying on the 404 an older daemon returns;
   * either way, treat branding as optional and fall back rather than fail.
   */
  async brand() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/brand`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "GET /brand");
        return await res.json();
      }
    );
  }
  /**
   * Send text directly through the primary workspace's channel worker.
   * This does not create or prompt an Agent session. Pre-flight the
   * `channel_delivery` capability before calling across mixed daemon versions.
   * A successful capability check does not guarantee worker liveness; callers
   * must treat 503 `channel_worker_unavailable` as an expected outcome.
   */
  async notify(req, opts) {
    return await this.jsonRequest(
      "/workspace/notify",
      "POST /workspace/notify",
      {
        method: "POST",
        body: req,
        timeoutMs: opts?.timeoutMs ?? CHANNEL_NOTIFY_DEFAULT_TIMEOUT_MS,
        mode: "rest"
      }
    );
  }
  async requireCapability(capability) {
    let supported;
    if (capability === "session_source_metadata") {
      while (this.capabilitiesRequest || !this.capabilityFeatures || this.capabilityFeatures.expiresAt <= Date.now()) {
        const request = this.capabilitiesRequest ?? this.capabilities();
        const generation = this.capabilitiesGeneration;
        try {
          await request;
        } catch (error) {
          if (generation === this.capabilitiesGeneration) throw error;
        }
      }
      supported = this.capabilityFeatures.features.has(capability);
    } else {
      const caps = await this.capabilities();
      supported = Array.isArray(caps.features) && caps.features.includes(capability);
    }
    if (!supported) {
      throw new DaemonCapabilityMissingError(
        capability,
        `daemon does not advertise the ${capability} feature`
      );
    }
  }
  /**
   * Consolidated daemon status report (`GET /daemon/status`). The default
   * `summary` detail reads cheap in-memory counters; `full` adds per-session,
   * ACP-connection, auth, and workspace diagnostics sections.
   */
  async daemonStatus(detail = "summary") {
    const query = detail === "summary" ? "" : `?detail=${detail}`;
    return await this.jsonRequest(
      `/daemon/status${query}`,
      "GET /daemon/status"
    );
  }
  /**
   * Aggregate local token-usage dashboard (`GET /usage/dashboard`): the
   * selected range's flattened totals plus a trailing per-day heatmap, read
   * from the durable local usage history (global, cross-project). `range`
   * scopes the summary (default `today`); `heatmapDays` sets the heatmap
   * window (default ~6 months, server-clamped to 1..366).
   */
  async usageDashboard(opts = {}) {
    const params = new URLSearchParams();
    if (opts.range !== void 0) params.set("range", opts.range);
    if (opts.heatmapDays !== void 0) {
      params.set("heatmapDays", String(opts.heatmapDays));
    }
    const query = params.toString();
    return await this.jsonRequest(
      `/usage/dashboard${query ? `?${query}` : ""}`,
      "GET /usage/dashboard"
    );
  }
  async workspaceMcp() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "GET /workspace/mcp");
        return await res.json();
      }
    );
  }
  async setUserMcpServer(name, config) {
    return await this.jsonRequest(
      `/workspace/config/mcp/servers/${urlEncode(name)}`,
      "PUT /workspace/config/mcp/servers/:name",
      {
        method: "PUT",
        body: { scope: "user", config },
        mode: "rest"
      }
    );
  }
  async removeUserMcpServer(name) {
    return await this.jsonRequest(
      `/workspace/config/mcp/servers/${urlEncode(name)}?scope=user`,
      "DELETE /workspace/config/mcp/servers/:name",
      { method: "DELETE", mode: "rest" }
    );
  }
  async setUserMcpServerEnabled(name, enabled) {
    return await this.jsonRequest(
      `/workspace/config/mcp/${urlEncode(name)}/${enabled ? "enable" : "disable"}`,
      "POST /workspace/config/mcp/:server/:action",
      { method: "POST", body: {}, mode: "rest" }
    );
  }
  async initializeWorkspaceMcp() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/initialize`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: "{}"
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspace/mcp/initialize");
        }
        return await res.json();
      }
    );
  }
  async reloadWorkspaceMcp(options = {}) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/reload`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(options)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspace/mcp/reload");
        }
        return await res.json();
      }
    );
  }
  async workspaceGit(opts) {
    return await this.jsonRequest(
      `/workspace/git${opts?.wait ? "?wait=1" : ""}`,
      "GET /workspace/git",
      { mode: "rest" }
    );
  }
  async workspaceGitDiff() {
    return await this.jsonRequest(
      "/workspace/git/diff",
      "GET /workspace/git/diff",
      { mode: "rest" }
    );
  }
  async workspaceGitDiffFile(path, oldPath) {
    const query = `/workspace/git/diff/file?path=${urlEncode(path)}` + (oldPath != null ? `&oldPath=${urlEncode(oldPath)}` : "");
    return await this.jsonRequest(
      query,
      "GET /workspace/git/diff/file",
      { mode: "rest" }
    );
  }
  async workspaceGitLog(limit, skip, range) {
    const params = new URLSearchParams();
    if (limit != null) params.set("limit", String(limit));
    if (skip != null) params.set("skip", String(skip));
    if (range) params.set("range", range);
    const qs = params.toString();
    return await this.jsonRequest(
      `/workspace/git/log${qs ? `?${qs}` : ""}`,
      "GET /workspace/git/log",
      { mode: "rest" }
    );
  }
  async workspaceGitCommitDetail(sha) {
    return await this.jsonRequest(
      `/workspace/git/log/commit?sha=${urlEncode(sha)}`,
      "GET /workspace/git/log/commit",
      { mode: "rest" }
    );
  }
  async workspaceGitBranches() {
    return await this.jsonRequest(
      "/workspace/git/branches",
      "GET /workspace/git/branches",
      { mode: "rest" }
    );
  }
  async workspaceGitCheckout(ref) {
    return await this.jsonRequest(
      "/workspace/git/checkout",
      "POST /workspace/git/checkout",
      { method: "POST", body: { ref }, mode: "rest" }
    );
  }
  async workspaceGitCreateBranch(name, startPoint) {
    return await this.jsonRequest(
      "/workspace/git/branch",
      "POST /workspace/git/branch",
      { method: "POST", body: { name, startPoint }, mode: "rest" }
    );
  }
  async workspaceGitPush(opts) {
    return await this.jsonRequest(
      "/workspace/git/push",
      "POST /workspace/git/push",
      { method: "POST", body: opts ?? {}, mode: "rest" }
    );
  }
  async workspaceGitPull(opts, timeoutMs) {
    return await this.jsonRequest(
      "/workspace/git/pull",
      "POST /workspace/git/pull",
      { method: "POST", body: opts ?? {}, mode: "rest", timeoutMs }
    );
  }
  async workspaceGitCommit(message, opts) {
    return await this.jsonRequest(
      "/workspace/git/commit",
      "POST /workspace/git/commit",
      { method: "POST", body: { message, ...opts }, mode: "rest" }
    );
  }
  async workspaceMcpTools(serverName) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/${urlEncode(serverName)}/tools`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace/mcp/:server/tools");
        }
        return await res.json();
      }
    );
  }
  async workspaceMcpResources(serverName) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/${urlEncode(serverName)}/resources`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "GET /workspace/mcp/:server/resources"
          );
        }
        return await res.json();
      }
    );
  }
  async workspaceSkills() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/skills`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace/skills");
        }
        return await res.json();
      }
    );
  }
  workspaceConfigSkills() {
    return this.jsonRequest("/workspace/config/skills", "Skills config", {
      mode: "rest"
    });
  }
  workspaceRuntimeSkills() {
    return this.jsonRequest("/workspace/runtime/skills", "Skills runtime", {
      mode: "rest"
    });
  }
  async workspaceAcpPreheat(timeoutMs) {
    const serverBudgetMs = timeoutMs ?? 5e3;
    const suffix = timeoutMs !== void 0 ? `?timeoutMs=${encodeURIComponent(timeoutMs)}` : "";
    return await this.jsonRequest(
      `/workspace/acp/preheat${suffix}`,
      "POST /workspace/acp/preheat",
      {
        method: "POST",
        timeoutMs: serverBudgetMs + 2e3,
        mode: "rest"
      }
    );
  }
  async workspaceAcpStatus() {
    return await this.jsonRequest(
      "/workspace/acp/status",
      "GET /workspace/acp/status",
      { mode: "rest" }
    );
  }
  async ensureWorkspaceRuntime() {
    return await this.jsonRequest(
      "/workspace/runtime/ensure",
      "POST /workspace/runtime/ensure",
      {
        method: "POST",
        timeoutMs: WORKSPACE_RUNTIME_ENSURE_TIMEOUT_MS,
        mode: "rest"
      }
    );
  }
  async workspaceRuntimeStatus() {
    return await this.jsonRequest(
      "/workspace/runtime/status",
      "GET /workspace/runtime/status",
      { mode: "rest" }
    );
  }
  async workspaceProviders() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/providers`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace/providers");
        }
        return await res.json();
      }
    );
  }
  async workspaceHooks() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/hooks`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "GET /workspace/hooks");
        return await res.json();
      }
    );
  }
  async sessionHooks(sessionId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/hooks`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok)
          throw await this.failOnError(res, "GET /session/:id/hooks");
        return await res.json();
      }
    );
  }
  async sessionResources(sessionId, clientId) {
    return await this.jsonRequest(
      `/session/${urlEncode(sessionId)}/resources`,
      "GET /session/:id/resources",
      { clientId, mode: "rest" }
    );
  }
  async workspaceExtensions() {
    return await this.jsonRequest(
      "/workspace/extensions",
      "GET /workspace/extensions",
      { mode: "rest" }
    );
  }
  async installExtension(params, clientId) {
    return await this.jsonRequest(
      "/workspace/extensions/install",
      "POST /workspace/extensions/install",
      { method: "POST", body: params, clientId, mode: "rest" }
    );
  }
  async installExtensionArchive(params, clientId) {
    const query = new URLSearchParams({
      filename: params.filename,
      consent: String(params.consent === true)
    });
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/extensions/install-archive?${query}`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/octet-stream" },
          clientId
        ),
        body: params.archive
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "POST /workspace/extensions/install-archive"
          );
        }
        return await res.json();
      },
      EXTENSION_ARCHIVE_UPLOAD_TIMEOUT_MS,
      "rest"
    );
  }
  async extensionOperationStatus(operationId) {
    return await this.jsonRequest(
      `/workspace/extensions/operations/${urlEncode(operationId)}`,
      "GET /workspace/extensions/operations/:operationId",
      { mode: "rest" }
    );
  }
  async activeExtensionOperations() {
    return await this.jsonRequest(
      "/workspace/extensions/operations",
      "GET /workspace/extensions/operations",
      { mode: "rest" }
    );
  }
  async respondToExtensionInteraction(operationId, interactionId, response, clientId) {
    return await this.jsonRequest(
      `/workspace/extensions/operations/${urlEncode(operationId)}/interactions/${urlEncode(interactionId)}`,
      "POST /workspace/extensions/operations/:operationId/interactions/:interactionId",
      { method: "POST", body: response, clientId, mode: "rest" }
    );
  }
  async checkExtensionUpdates(clientId) {
    return await this.jsonRequest(
      "/workspace/extensions/check-updates",
      "POST /workspace/extensions/check-updates",
      { method: "POST", body: {}, clientId, mode: "rest" }
    );
  }
  async refreshExtensions(clientId) {
    return await this.jsonRequest(
      "/workspace/extensions/refresh",
      "POST /workspace/extensions/refresh",
      { method: "POST", body: {}, clientId, mode: "rest" }
    );
  }
  async enableExtension(name, params, clientId) {
    return await this.jsonRequest(
      `/workspace/extensions/${urlEncode(name)}/enable`,
      "POST /workspace/extensions/:name/enable",
      { method: "POST", body: params, clientId, mode: "rest" }
    );
  }
  async disableExtension(name, params, clientId) {
    return await this.jsonRequest(
      `/workspace/extensions/${urlEncode(name)}/disable`,
      "POST /workspace/extensions/:name/disable",
      { method: "POST", body: params, clientId, mode: "rest" }
    );
  }
  async updateExtension(name, clientId) {
    return await this.jsonRequest(
      `/workspace/extensions/${urlEncode(name)}/update`,
      "POST /workspace/extensions/:name/update",
      { method: "POST", body: {}, clientId, mode: "rest" }
    );
  }
  async uninstallExtension(name, clientId) {
    return await this.jsonRequest(
      `/workspace/extensions/${urlEncode(name)}`,
      "DELETE /workspace/extensions/:name",
      { method: "DELETE", clientId, mode: "rest" }
    );
  }
  async extensionCatalog() {
    return await this.jsonRequest(
      "/extensions",
      "GET /extensions",
      { mode: "rest" }
    );
  }
  async installUserExtension(params, clientId) {
    return await this.jsonRequest(
      "/extensions/install",
      "POST /extensions/install",
      { method: "POST", body: params, clientId, mode: "rest" }
    );
  }
  async checkUserExtensionUpdates(clientId) {
    return await this.jsonRequest(
      "/extensions/check-updates",
      "POST /extensions/check-updates",
      { method: "POST", body: {}, clientId, mode: "rest" }
    );
  }
  async updateUserExtension(extensionId, clientId) {
    return await this.jsonRequest(
      `/extensions/${urlEncode(extensionId)}/update`,
      "POST /extensions/:extensionId/update",
      { method: "POST", body: {}, clientId, mode: "rest" }
    );
  }
  async uninstallUserExtension(extensionId, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/extensions/${urlEncode(extensionId)}`,
      {
        method: "DELETE",
        headers: this.headers({}, clientId)
      },
      async (res) => {
        if (res.status === 204) {
          await res.body?.cancel().catch(() => void 0);
          return void 0;
        }
        if (!res.ok) {
          throw await this.failOnError(res, "DELETE /extensions/:extensionId");
        }
        return await res.json();
      },
      void 0,
      "rest"
    );
  }
  async setExtensionDefaultActivation(extensionId, state, clientId) {
    return await this.jsonRequest(
      `/extensions/${urlEncode(extensionId)}/activation`,
      "PUT /extensions/:extensionId/activation",
      { method: "PUT", body: { state }, clientId, mode: "rest" }
    );
  }
  async setExtensionDefaultActivations(extensionNames, state, clientId) {
    return await this.jsonRequest(
      "/extensions/activation",
      "PUT /extensions/activation",
      {
        method: "PUT",
        body: { extensionNames: [...extensionNames], state },
        clientId,
        mode: "rest"
      }
    );
  }
  async extensionOperation(operationId, signal) {
    return await this.jsonRequest(
      `/extensions/operations/${urlEncode(operationId)}`,
      "GET /extensions/operations/:operationId",
      signal ? { signal, mode: "rest" } : { mode: "rest" }
    );
  }
  async waitForExtensionOperation(handle, options = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? 1e3;
    const timeoutMs = options.timeoutMs ?? 10 * 6e4;
    const hasDeadline = timeoutMs !== Number.POSITIVE_INFINITY;
    const deadline = Date.now() + timeoutMs;
    const timeoutError = /* @__PURE__ */ __name(() => new Error(
      `Timed out waiting for extension operation ${handle.operationId}. The server operation was not cancelled.`
    ), "timeoutError");
    for (; ; ) {
      options.signal?.throwIfAborted();
      const pollBudgetMs = deadline - Date.now();
      if (pollBudgetMs <= 0 || Number.isNaN(pollBudgetMs)) {
        throw timeoutError();
      }
      let operation;
      if (!hasDeadline) {
        operation = await this.extensionOperation(
          handle.operationId,
          options.signal
        );
      } else {
        const deadlineController = new AbortController();
        const pollSignal = options.signal ? composeAbortSignals2([options.signal, deadlineController.signal]) : deadlineController.signal;
        let deadlineTimer;
        const deadlinePromise = new Promise((_, reject) => {
          const expire = /* @__PURE__ */ __name(() => {
            const error = timeoutError();
            reject(error);
            deadlineController.abort(error);
          }, "expire");
          const schedule = /* @__PURE__ */ __name(() => {
            const remainingMs2 = deadline - Date.now();
            if (remainingMs2 <= 0) {
              expire();
              return;
            }
            deadlineTimer = setTimeout(
              () => {
                if (Date.now() >= deadline) {
                  expire();
                } else {
                  schedule();
                }
              },
              Math.min(remainingMs2, MAX_TIMER_DELAY_MS)
            );
          }, "schedule");
          schedule();
        });
        try {
          operation = await Promise.race([
            this.extensionOperation(handle.operationId, pollSignal),
            deadlinePromise
          ]);
        } finally {
          if (deadlineTimer !== void 0) clearTimeout(deadlineTimer);
          deadlineController.abort();
        }
      }
      if (operation.status !== "queued" && operation.status !== "running") {
        return operation;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw timeoutError();
      }
      await new Promise((resolve, reject) => {
        const finish = /* @__PURE__ */ __name(() => {
          options.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, "finish");
        const timer = setTimeout(
          finish,
          Math.min(pollIntervalMs, remainingMs, MAX_TIMER_DELAY_MS)
        );
        const onAbort = /* @__PURE__ */ __name(() => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
          reject(
            options.signal?.reason ?? new DOMException("Aborted", "AbortError")
          );
        }, "onAbort");
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) onAbort();
      });
    }
  }
  // -- Workspace files (workspace files) -------------------------------
  async readWorkspaceFile(filePath, opts = {}, clientId) {
    const query = new URLSearchParams({ path: filePath });
    if (opts.maxBytes !== void 0) {
      query.set("maxBytes", String(opts.maxBytes));
    }
    if (opts.line !== void 0) {
      query.set("line", String(opts.line));
    }
    if (opts.limit !== void 0) {
      query.set("limit", String(opts.limit));
    }
    if (opts.cursor !== void 0) {
      query.set("cursor", opts.cursor);
    }
    return await this.fetchWithTimeout(
      `${this.baseUrl}/file?${query.toString()}`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "GET /file");
        return await res.json();
      }
    );
  }
  async readWorkspaceFileBytes(filePath, opts = {}, clientId) {
    const query = new URLSearchParams({ path: filePath });
    if (opts.offset !== void 0) {
      query.set("offset", String(opts.offset));
    }
    if (opts.maxBytes !== void 0) {
      query.set("maxBytes", String(opts.maxBytes));
    }
    return await this.fetchWithTimeout(
      `${this.baseUrl}/file/bytes?${query.toString()}`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "GET /file/bytes");
        return await res.json();
      }
    );
  }
  async fileStat(filePath) {
    const query = new URLSearchParams({ path: filePath });
    return await this.fetchWithTimeout(
      `${this.baseUrl}/stat?${query.toString()}`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "GET /stat");
        return await res.json();
      }
    );
  }
  async dirList(dirPath) {
    const query = new URLSearchParams({ path: dirPath });
    return await this.fetchWithTimeout(
      `${this.baseUrl}/list?${query.toString()}`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "GET /list");
        return await res.json();
      }
    );
  }
  /**
   * Directory-name suggestions for an absolute path prefix, for flows that
   * pick a path outside any registered workspace (e.g. "Add workspace").
   */
  async workspacePathSuggestions(prefix) {
    const query = new URLSearchParams({ prefix });
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace-path-suggestions?${query.toString()}`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace-path-suggestions");
        }
        return await res.json();
      }
    );
  }
  async workspaceDirectoryPicker() {
    return await this.jsonRequest(
      "/workspace-directory-picker",
      "POST /workspace-directory-picker",
      {
        method: "POST",
        body: {},
        timeoutMs: 31e4,
        mode: "rest"
      }
    );
  }
  async glob(pattern) {
    const query = new URLSearchParams({ pattern });
    return await this.fetchWithTimeout(
      `${this.baseUrl}/glob?${query.toString()}`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "GET /glob");
        return await res.json();
      }
    );
  }
  async writeWorkspaceFile(req, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/file/write`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify(req)
      },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "POST /file/write");
        return await res.json();
      }
    );
  }
  async editWorkspaceFile(req, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/file/edit`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify(req)
      },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "POST /file/edit");
        return await res.json();
      }
    );
  }
  /**
   * Upload binary bytes to the workspace. Shared raw-POST core used by both
   * the legacy-primary `uploadWorkspaceFile` and the workspace-qualified
   * variant, parameterized by URL path + route label. Keeps auth headers,
   * timeout/abort composition, progress transport, and `DaemonHttpError`
   * construction in one place.
   *
   * Uses `XMLHttpRequest` when `req.onProgress` is provided (`fetch` exposes
   * no upload progress); plain `fetch` otherwise. Progress is browser-only:
   * requesting it where `XMLHttpRequest` is unavailable fails before sending.
   *
   * @internal
   */
  async uploadFileToPath(uploadPath, label, req, clientId) {
    const query = new URLSearchParams({ path: req.path });
    const url = `${this.baseUrl}${uploadPath}?${query.toString()}`;
    const headers = this.headers(
      { "Content-Type": "application/octet-stream" },
      clientId
    );
    if (req.onProgress) {
      return await this.uploadWithProgress(url, label, req, headers);
    }
    return await this.fetchWithTimeout(
      url,
      {
        method: "POST",
        headers,
        body: req.data,
        ...req.signal ? { signal: req.signal } : {}
      },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, label);
        const text = await res.text();
        let body;
        try {
          body = text ? JSON.parse(text) : void 0;
        } catch {
          body = text;
        }
        if (!body || typeof body !== "object" || !("path" in body)) {
          throw new Error(`${label}: invalid upload response body`);
        }
        return body;
      },
      req.timeoutMs,
      "rest"
    );
  }
  async uploadWithProgress(url, label, req, headers) {
    if (typeof XMLHttpRequest === "undefined") {
      throw new Error(
        `${label}: upload progress requires XMLHttpRequest (browser only)`
      );
    }
    let effectiveTimeoutMs = this.fetchTimeoutMs;
    if (req.timeoutMs !== void 0 && Number.isFinite(req.timeoutMs) && req.timeoutMs >= 0) {
      effectiveTimeoutMs = req.timeoutMs;
    }
    const onProgress = req.onProgress;
    return await new Promise(
      (resolve, reject) => {
        if (req.signal?.aborted) {
          reject(
            req.signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
          );
          return;
        }
        const xhr = new XMLHttpRequest();
        let abortListener;
        const cleanup = /* @__PURE__ */ __name(() => {
          if (abortListener && req.signal) {
            req.signal.removeEventListener("abort", abortListener);
          }
        }, "cleanup");
        xhr.open("POST", url);
        for (const [name, value] of Object.entries(headers)) {
          xhr.setRequestHeader(name, value);
        }
        if (effectiveTimeoutMs > 0) xhr.timeout = effectiveTimeoutMs;
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && onProgress) {
            onProgress({ loaded: event.loaded, total: event.total });
          }
        };
        xhr.onload = () => {
          cleanup();
          let body;
          try {
            body = xhr.responseText ? JSON.parse(xhr.responseText) : void 0;
          } catch {
            body = xhr.responseText;
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            if (!body || typeof body !== "object" || !("path" in body)) {
              reject(new Error(`${label}: invalid upload response body`));
              return;
            }
            resolve(body);
            return;
          }
          const detail = body && typeof body === "object" && "error" in body ? String(body.error) : `HTTP ${xhr.status}`;
          reject(new DaemonHttpError(xhr.status, body, `${label}: ${detail}`));
        };
        xhr.onerror = () => {
          cleanup();
          reject(new Error(`${label}: network request failed`));
        };
        xhr.ontimeout = () => {
          cleanup();
          reject(new DOMException("timeout", "TimeoutError"));
        };
        xhr.onabort = () => {
          cleanup();
          reject(
            req.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError")
          );
        };
        if (req.signal) {
          abortListener = /* @__PURE__ */ __name(() => xhr.abort(), "abortListener");
          req.signal.addEventListener("abort", abortListener, { once: true });
        }
        try {
          xhr.send(req.data);
        } catch (error) {
          cleanup();
          reject(error);
        }
      }
    );
  }
  async uploadWorkspaceFile(req, clientId) {
    return await this.uploadFileToPath(
      "/file/upload",
      "POST /file/upload",
      req,
      clientId
    );
  }
  // -- Workspace memory (workspace memory/agents) ------------------------------
  /**
   * Fetch the daemon's `QWEN.md` / `AGENTS.md` snapshot. Read-only;
   * pre-flight `caps.features.workspace_memory` before calling
   * against an unknown daemon. Returns `initialized: false` and an
   * empty `files` array when no memory files exist at the bound
   * workspace root or `~/.qwen`.
   *
   * v1 discovers files at the bound workspace ROOT only, plus the
   * user's global `~/.qwen` directory — it does NOT walk parent
   * directories or recurse into the workspace tree. The route's
   * companion helper `walkWorkspaceForMemory` keeps a guarded
   * upward-walk loop body for a future hierarchical mode but breaks
   * after iteration 1 in this release.
   */
  async workspaceMemory() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/memory`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace/memory");
        }
        return await res.json();
      }
    );
  }
  /**
   * Append to or replace `QWEN.md` at workspace or global scope.
   * The strict mutation gate accepts trusted-loopback callers without a token;
   * older daemons and non-trusted embeds can still return `token_required`.
   * When the daemon advertises `workspace_memory`, expect 200 with
   * `{ ok, filePath, bytesWritten, mode }`; older daemons without the
   * capability return 404.
   */
  async writeWorkspaceMemory(req, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/memory`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify(req)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspace/memory");
        }
        return await res.json();
      }
    );
  }
  /**
   * Queue a hidden managed-memory remember task for the daemon's bound
   * workspace. This does not require an existing session; callers should
   * poll `getWorkspaceMemoryRememberTask()` until the task is terminal.
   */
  async rememberWorkspaceMemory(content, opts = {}) {
    if (opts.scope) {
      await this.requireCapability(
        opts.scope === "project" ? "workspace_memory_remember_project_scope" : "workspace_memory_remember_user_scope"
      );
    }
    return await this.jsonRequest(
      WORKSPACE_MEMORY_REMEMBER_PATH,
      `POST ${WORKSPACE_MEMORY_REMEMBER_PATH}`,
      {
        method: "POST",
        body: {
          content,
          contextMode: opts.contextMode ?? "workspace",
          ...opts.scope ? { scope: opts.scope } : {}
        },
        clientId: opts.clientId
      }
    );
  }
  async getWorkspaceMemoryRememberTask(taskId, opts) {
    return await this.jsonRequest(
      `${WORKSPACE_MEMORY_REMEMBER_PATH}/${urlEncode(taskId)}`,
      `GET ${WORKSPACE_MEMORY_REMEMBER_PATH}/:taskId`,
      { clientId: opts?.clientId }
    );
  }
  async forgetWorkspaceMemory(query, opts = {}) {
    if (opts.scope) {
      await this.requireCapability("workspace_memory_forget_scope");
    }
    return await this.jsonRequest(
      WORKSPACE_MEMORY_FORGET_PATH,
      `POST ${WORKSPACE_MEMORY_FORGET_PATH}`,
      {
        method: "POST",
        body: {
          query,
          ...opts.scope ? { scope: opts.scope } : {}
        },
        clientId: opts.clientId
      }
    );
  }
  async getWorkspaceMemoryForgetTask(taskId, opts) {
    return await this.jsonRequest(
      `${WORKSPACE_MEMORY_FORGET_PATH}/${urlEncode(taskId)}`,
      `GET ${WORKSPACE_MEMORY_FORGET_PATH}/:taskId`,
      { clientId: opts?.clientId }
    );
  }
  async dreamWorkspaceMemory(opts = {}) {
    return await this.jsonRequest(
      WORKSPACE_MEMORY_DREAM_PATH,
      `POST ${WORKSPACE_MEMORY_DREAM_PATH}`,
      {
        method: "POST",
        body: {},
        clientId: opts.clientId
      }
    );
  }
  async getWorkspaceMemoryDreamTask(taskId, opts) {
    return await this.jsonRequest(
      `${WORKSPACE_MEMORY_DREAM_PATH}/${urlEncode(taskId)}`,
      `GET ${WORKSPACE_MEMORY_DREAM_PATH}/:taskId`,
      { clientId: opts?.clientId }
    );
  }
  // -- Workspace agents (workspace memory/agents) ------------------------------
  async listWorkspaceAgents() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/agents`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace/agents");
        }
        return await res.json();
      }
    );
  }
  /**
   * Create a project- or user-level subagent. 409 `agent_already_exists`
   * when a same-name agent is already registered at the chosen level;
   * 422 `invalid_config` for validation failures.
   */
  async createWorkspaceAgent(req, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/agents`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify(req)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspace/agents");
        }
        return await res.json();
      }
    );
  }
  async generateWorkspaceAgent(description, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/agents/generate`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify({ description })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspace/agents/generate");
        }
        return await res.json();
      },
      MCP_RESTART_DEFAULT_TIMEOUT_MS
    );
  }
  async *generateContentEvents(path, label, body, opts, parse, requireTerminal) {
    const res = await this.transport.fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(
        {
          "Content-Type": "application/json",
          Accept: "text/event-stream"
        },
        opts?.clientId
      ),
      body: JSON.stringify(body),
      signal: opts?.signal
    });
    if (!res.ok) throw await this.failOnError(res, label);
    if (!res.body) throw new Error("Generation response body is missing");
    let sawTerminal = false;
    for await (const event of parseSseStream(res.body, opts?.signal)) {
      const generationEvent = parse(event);
      if (!generationEvent) continue;
      sawTerminal = generationEvent.type === "done" || generationEvent.type === "error";
      yield generationEvent;
      if (requireTerminal && sawTerminal) return;
    }
    if (requireTerminal && !opts?.signal?.aborted && !sawTerminal) {
      throw new Error("Stream ended without terminal event");
    }
  }
  async *generateWorkspaceContent(prompt, opts) {
    yield* this.generateContentEvents(
      "/workspace/generate",
      "POST /workspace/generate",
      { prompt },
      opts,
      parseSessionGenerationEvent,
      true
    );
  }
  async getWorkspaceAgent(agentType, opts = {}) {
    const url = opts.scope ? `${this.baseUrl}/workspace/agents/${urlEncode(agentType)}?scope=${urlEncode(opts.scope)}` : `${this.baseUrl}/workspace/agents/${urlEncode(agentType)}`;
    return await this.fetchWithTimeout(
      url,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace/agents/:agentType");
        }
        return await res.json();
      }
    );
  }
  /**
   * Update a project- or user-level subagent definition. Built-in /
   * extension / session-level agents are read-only and return 403
   * `agent_readonly`; missing agents return 404 `agent_not_found`.
   *
   * Optional `scope` mirrors the delete helper: when a project agent
   * shadows a user-level agent of the same name, pass
   * `{ scope: 'global' }` to update the user-level definition
   * specifically. Without the scope the daemon resolves through the
   * default precedence (project > user) and updates the project entry.
   */
  async updateWorkspaceAgent(agentType, req, opts = {}, clientId) {
    const url = opts.scope ? `${this.baseUrl}/workspace/agents/${urlEncode(agentType)}?scope=${urlEncode(opts.scope)}` : `${this.baseUrl}/workspace/agents/${urlEncode(agentType)}`;
    return await this.fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify(req)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "POST /workspace/agents/:agentType"
          );
        }
        return await res.json();
      }
    );
  }
  /**
   * Delete a project- or user-level subagent definition. Optional
   * `scope` query narrows deletion to one level when the same name
   * exists at both. Idempotent for SDK callers — both 204 (deleted)
   * and 404 (already gone) resolve successfully.
   */
  async deleteWorkspaceAgent(agentType, opts = {}, clientId) {
    const url = opts.scope ? `${this.baseUrl}/workspace/agents/${urlEncode(agentType)}?scope=${urlEncode(opts.scope)}` : `${this.baseUrl}/workspace/agents/${urlEncode(agentType)}`;
    return await this.fetchWithTimeout(
      url,
      {
        method: "DELETE",
        headers: this.headers({}, clientId)
      },
      async (res) => {
        if (res.status === 204) {
          try {
            await res.body?.cancel();
          } catch {
          }
          return;
        }
        if (res.status === 404) {
          const err = await this.failOnError(
            res,
            "DELETE /workspace/agents/:agentType"
          );
          const body = err.body;
          if (body && body.code === "agent_not_found") return;
          throw err;
        }
        throw await this.failOnError(
          res,
          "DELETE /workspace/agents/:agentType"
        );
      }
    );
  }
  async workspaceEnv() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/env`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "GET /workspace/env");
        return await res.json();
      }
    );
  }
  async workspacePreflight() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/preflight`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace/preflight");
        }
        return await res.json();
      }
    );
  }
  async workspaceTools() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/tools`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace/tools");
        }
        return await res.json();
      }
    );
  }
  // -- Sessions ----------------------------------------------------------
  async getStandaloneSessionOptions() {
    await this.requireCapability(STANDALONE_SESSION_OPTIONS_CAPABILITY);
    const route = "GET /standalone/session-options";
    const response = await this.jsonRequest(
      "/standalone/session-options",
      route,
      { mode: "rest" }
    );
    return parseStandaloneSessionOptions(response, route);
  }
  async createStandaloneSession(options = {}) {
    await this.requireCapability(STANDALONE_SESSIONS_CAPABILITY);
    const { sessionId: requestedSessionId, ...request } = options;
    const sessionId = (requestedSessionId ?? createStandaloneSessionId()).toLowerCase();
    try {
      const response = await this.jsonRequest(
        "/standalone/sessions",
        "POST /standalone/sessions",
        {
          method: "POST",
          body: { sessionId, ...request },
          mode: "rest"
        }
      );
      return parseStandaloneSession(
        response,
        "POST /standalone/sessions",
        sessionId
      );
    } catch (error) {
      if (error instanceof DaemonHttpError && !isStandaloneCreationOutcomeUnknown(error)) {
        throw error;
      }
      const recovery = await this.recoverStandaloneCreation(sessionId);
      throw new DaemonStandaloneCreationOutcomeUnknownError(
        sessionId,
        recovery,
        error
      );
    }
  }
  async listStandaloneSessions(options = {}) {
    return (await this.listStandaloneSessionsPage(options)).sessions;
  }
  async listStandaloneSessionsPage(options = {}) {
    const query = new URLSearchParams();
    if (options.cursor !== void 0) query.set("cursor", options.cursor);
    if (options.pageSize !== void 0) {
      query.set("size", String(options.pageSize));
    }
    if (options.archiveState !== void 0) {
      query.set("archiveState", options.archiveState);
    }
    const queryString = query.toString();
    const suffix = queryString ? `?${queryString}` : "";
    return await this.standaloneJsonRequest(
      `/standalone/sessions${suffix}`,
      "GET /standalone/sessions",
      parseStandaloneListPage
    );
  }
  async getStandaloneSession(sessionId) {
    await this.requireCapability(STANDALONE_SESSIONS_CAPABILITY);
    return await this.getStandaloneSessionUnchecked(sessionId.toLowerCase());
  }
  async loadStandaloneSession(sessionId, request = {}, clientId) {
    return await this.restoreStandaloneSession(
      "load",
      sessionId,
      request,
      clientId
    );
  }
  async resumeStandaloneSession(sessionId, request = {}, clientId) {
    return await this.restoreStandaloneSession(
      "resume",
      sessionId,
      request,
      clientId
    );
  }
  async repairStandaloneSessionDirectory(sessionId) {
    const normalized = sessionId.toLowerCase();
    const route = "POST /standalone/sessions/:id/repair-directory";
    return await this.standaloneJsonRequest(
      `/standalone/sessions/${urlEncode(normalized)}/repair-directory`,
      route,
      (response) => parseStandaloneDirectoryResult(response, route, normalized),
      { method: "POST", body: {} }
    );
  }
  async renameStandaloneSession(sessionId, displayName, clientId) {
    const normalized = sessionId.toLowerCase();
    const route = "PATCH /standalone/sessions/:id/metadata";
    return await this.standaloneJsonRequest(
      `/standalone/sessions/${urlEncode(normalized)}/metadata`,
      route,
      (response) => parseStandaloneMetadataResult(response, route, normalized),
      {
        method: "PATCH",
        body: { displayName },
        clientId
      }
    );
  }
  async exportStandaloneSession(sessionId, options = {}) {
    await this.requireCapability(STANDALONE_SESSIONS_CAPABILITY);
    return await this.sessionExportRequest(
      `/standalone/sessions/${urlEncode(sessionId.toLowerCase())}/export`,
      "GET /standalone/sessions/:id/export",
      options
    );
  }
  async archiveStandaloneSessions(sessionIds) {
    return await this.standaloneBatchRequest(
      "archive",
      sessionIds,
      parseArchiveStandaloneSessionsResult
    );
  }
  async unarchiveStandaloneSessions(sessionIds) {
    return await this.standaloneBatchRequest(
      "unarchive",
      sessionIds,
      parseUnarchiveStandaloneSessionsResult
    );
  }
  async deleteStandaloneSessions(sessionIds) {
    return await this.standaloneBatchRequest(
      "delete",
      sessionIds,
      parseDeleteStandaloneSessionsResult
    );
  }
  async standaloneJsonRequest(path, route, parse, options = {}) {
    await this.requireCapability(STANDALONE_SESSIONS_CAPABILITY);
    const response = await this.jsonRequest(path, route, {
      ...options,
      mode: "rest"
    });
    return parse(response, route);
  }
  async standaloneBatchRequest(action, sessionIds, parse) {
    const route = `POST /standalone/sessions/${action}`;
    return await this.standaloneJsonRequest(
      `/standalone/sessions/${action}`,
      route,
      parse,
      {
        method: "POST",
        body: {
          sessionIds: sessionIds.map((sessionId) => sessionId.toLowerCase())
        }
      }
    );
  }
  async restoreStandaloneSession(action, sessionId, request, clientId) {
    const normalized = sessionId.toLowerCase();
    const route = `POST /standalone/sessions/:id/${action}`;
    const { timeoutMs, ...body } = request;
    return await this.standaloneJsonRequest(
      `/standalone/sessions/${urlEncode(normalized)}/${action}`,
      route,
      (response) => parseRestoredStandaloneSession(response, route, normalized),
      {
        method: "POST",
        body,
        clientId,
        timeoutMs: this.resolveRestoreTimeoutMs(timeoutMs)
      }
    );
  }
  async getStandaloneSessionUnchecked(sessionId) {
    const route = "GET /standalone/sessions/:id";
    const response = await this.jsonRequest(
      `/standalone/sessions/${urlEncode(sessionId)}`,
      route,
      { mode: "rest" }
    );
    return parseStandaloneLookup(response, route, sessionId);
  }
  async recoverStandaloneCreation(sessionId) {
    try {
      const lookup = await this.getStandaloneSessionUnchecked(sessionId);
      return "state" in lookup ? { state: "creating", sessionId } : { state: "existing", session: lookup };
    } catch (error) {
      return isStandaloneSessionNotFoundError(error) ? { state: "absent", sessionId } : { state: "unknown", sessionId, error };
    }
  }
  async createOrAttachSession(req, clientId) {
    if (req.sessionId !== void 0 && req.sessionId !== null) {
      await this.requireCapability("session_id_override");
    }
    if (req.sourceType !== void 0 || req.sourceId !== void 0) {
      await this.requireCapability("session_source_metadata");
    }
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify({
          cwd: req.workspaceCwd,
          ...req.sessionId !== void 0 ? { sessionId: req.sessionId } : {},
          ...req.modelServiceId ? { modelServiceId: req.modelServiceId } : {},
          // `!== undefined` (not truthy) so a buggy caller passing
          // `sessionScope: '' | null` doesn't get the field silently
          // erased on the wire — let the daemon's `400
          // invalid_session_scope` surface the bug. Same shape the
          // bridge's own validation uses (`httpAcpBridge.ts:
          // spawnOrAttach`); SDK should be a transparent layer here.
          ...req.sessionScope !== void 0 ? { sessionScope: req.sessionScope } : {},
          ...req.approvalMode !== void 0 ? { approvalMode: req.approvalMode } : {},
          ...req.sourceType !== void 0 ? { sourceType: req.sourceType } : {},
          ...req.sourceId !== void 0 ? { sourceId: req.sourceId } : {},
          ...req.worktree !== void 0 ? { worktree: req.worktree } : {},
          ...req.branch !== void 0 ? { branch: req.branch } : {}
        })
      },
      async (res) => {
        if (!res.ok) throw await this.failOnError(res, "POST /session");
        const session = await res.json();
        if (typeof req.sessionId === "string" && session.sessionId !== req.sessionId.toLowerCase()) {
          throw new DaemonSessionIdProtocolError(
            req.sessionId.toLowerCase(),
            session.sessionId
          );
        }
        return session;
      }
    );
  }
  /**
   * Enumerate the session catalog for a workspace. Used by session-picker UIs.
   * Returns an empty list (not 404) when the workspace has no sessions.
   */
  async listWorkspaceSessions(workspaceCwd, options) {
    const page = await this.listWorkspaceSessionsPage(workspaceCwd, options);
    return page.sessions;
  }
  async listWorkspaceSessionsPage(workspaceCwd, options) {
    if (options?.sourceType !== void 0 || options?.sourceId !== void 0) {
      await this.requireCapability("session_source_metadata");
    }
    const requestedPageSize = options?.pageSize ?? DEFAULT_SESSION_LIST_PAGE_SIZE;
    const pageSize = Math.max(
      1,
      Math.min(
        1e3,
        Math.round(
          Number.isFinite(requestedPageSize) ? requestedPageSize : DEFAULT_SESSION_LIST_PAGE_SIZE
        )
      )
    );
    const query = new URLSearchParams({ size: String(pageSize) });
    if (options?.cursor !== void 0) {
      query.set("cursor", options.cursor);
    }
    if (options?.archiveState !== void 0) {
      query.set("archiveState", options.archiveState);
    }
    if (options?.view !== void 0) {
      query.set("view", options.view);
    }
    if (options?.group !== void 0) {
      query.set("group", options.group);
    }
    if (options?.parentSessionId !== void 0) {
      query.set("parentSessionId", options.parentSessionId);
    }
    if (options?.sourceType !== void 0) {
      query.set("sourceType", options.sourceType);
    }
    if (options?.sourceId !== void 0) {
      query.set("sourceId", options.sourceId);
    }
    return await this.jsonRequest(
      `/workspace/${urlEncode(workspaceCwd)}/sessions?${query.toString()}`,
      "GET /workspace/sessions"
    );
  }
  /**
   * Search user/assistant message content across a workspace's persisted
   * sessions via `GET /workspace/:id/sessions/search`. Returns one summary +
   * snippet per matching session, most recently modified first. Requires a
   * daemon new enough to serve the route — older daemons answer 404.
   */
  async searchWorkspaceSessions(workspaceCwd, queryText, options = {}) {
    const query = new URLSearchParams({ q: queryText });
    if (options.maxResults !== void 0) {
      query.set("maxResults", String(options.maxResults));
    }
    return await this.jsonRequest(
      `/workspace/${urlEncode(workspaceCwd)}/sessions/search?${query.toString()}`,
      "GET /workspace/sessions/search",
      { ...options.signal ? { signal: options.signal } : {} }
    );
  }
  /**
   * Read the memory-only live-state snapshot for a workspace via
   * `GET /workspaces/:workspace/sessions/live-state`: the complete set of
   * live sessions with volatile state plus the in-memory catalog version
   * equality token. Always uses native REST transport (never the pluggable
   * ACP transport).
   *
   * This method deliberately does not pre-flight
   * `requireCapability('workspace_session_live_state')` — a capability
   * probe on every poll would double request volume. Consumers preflight
   * the capability once from their already-loaded capabilities and fall
   * back to the full session catalog when it is absent.
   */
  getWorkspaceSessionLiveState(workspaceCwd, opts = {}) {
    return this.workspaceByCwd(workspaceCwd).getSessionLiveState(opts);
  }
  async listSessionGroups(workspaceCwd) {
    return await this.jsonRequest(
      `/workspace/${urlEncode(workspaceCwd)}/session-groups`,
      "GET /workspace/session-groups"
    );
  }
  async createSessionGroup(workspaceCwd, input) {
    const body = await this.jsonRequest(
      `/workspace/${urlEncode(workspaceCwd)}/session-groups`,
      "POST /workspace/session-groups",
      { method: "POST", body: input }
    );
    return body.group;
  }
  async updateSessionGroup(workspaceCwd, groupId, update) {
    const body = await this.jsonRequest(
      `/workspace/${urlEncode(workspaceCwd)}/session-groups/${urlEncode(groupId)}`,
      "PATCH /workspace/session-groups/:groupId",
      { method: "PATCH", body: update }
    );
    return body.group;
  }
  async deleteSessionGroup(workspaceCwd, groupId) {
    return await this.jsonRequest(
      `/workspace/${urlEncode(workspaceCwd)}/session-groups/${urlEncode(groupId)}`,
      "DELETE /workspace/session-groups/:groupId",
      { method: "DELETE" }
    );
  }
  async updateSessionOrganization(sessionId, update, clientId) {
    return await this.jsonRequest(
      `/session/${urlEncode(sessionId)}/organization`,
      "PATCH /session/:id/organization",
      { method: "PATCH", body: update, clientId }
    );
  }
  async loadSession(sessionId, req = {}, clientId) {
    return this.restoreSession("load", sessionId, req, clientId);
  }
  async exportSession(sessionId, opts = {}) {
    return await this.sessionExportRequest(
      `/session/${urlEncode(sessionId)}/export`,
      "GET /session/:id/export",
      opts
    );
  }
  async getSessionTranscriptPage(sessionId, opts = {}) {
    return await this.jsonRequest(
      `/session/${urlEncode(sessionId)}/transcript${transcriptPageSuffix(opts)}`,
      "GET /session/:id/transcript",
      {
        clientId: opts.clientId,
        mode: "rest"
      }
    );
  }
  async getSessionTurnIndexPage(sessionId, opts = {}) {
    return await this.jsonRequest(
      `/session/${urlEncode(sessionId)}/turn-index${turnIndexPageSuffix(opts)}`,
      "GET /session/:id/turn-index",
      { clientId: opts.clientId, mode: "rest" }
    );
  }
  async resolveSubagentSession(sessionId, subagentRef, clientId) {
    return await this.jsonRequest(
      `/session/${urlEncode(sessionId)}/subagents/${urlEncode(subagentRef)}`,
      "GET /session/:id/subagents/:subagentRef",
      { clientId, mode: "rest" }
    );
  }
  async cancelSubagentSession(sessionId, subagentRef, clientId) {
    return await this.jsonRequest(
      `/session/${urlEncode(sessionId)}/subagents/${urlEncode(subagentRef)}/cancel`,
      "POST /session/:id/subagents/:subagentRef/cancel",
      { clientId, mode: "rest", method: "POST" }
    );
  }
  /** Admit an interrupted turn without adding a user message. */
  async continueSession(sessionId, opts = {}) {
    opts.signal?.throwIfAborted();
    return await this.jsonRequest(
      `/session/${urlEncode(sessionId)}/continue`,
      "POST /session/:id/continue",
      {
        method: "POST",
        clientId: opts.clientId,
        signal: opts.signal,
        mode: "rest"
      }
    );
  }
  async resumeSession(sessionId, req = {}, clientId) {
    return this.restoreSession("resume", sessionId, req, clientId);
  }
  /**
   * Transfer a worktree session's checkout ownership to a fresh replacement
   * session (`POST /session/:id/worktree-reset`, capability
   * `session_worktree_reset_v1`). Resolves 200 with the replacement
   * session's create-shape response. The route never reads a caller-supplied
   * client id, so this method takes none — but the response is not
   * registration-free: a fresh transfer mints an owner-style `clientId` for
   * the spawn it performs, registers it on the replacement, and returns it in
   * the body, while an idempotent resume of a committed transfer returns
   * none. That registration is not an attachment (the replacement's attach
   * count is unaffected), and nothing detaches it for you — pass a minted id
   * you do not keep using to `detachSession`, or the replacement never
   * reaches the daemon's idle cleanup. Typed 409 bodies carry the reset
   * taxonomy: `worktree_reset_unsupported` (not a worktree session),
   * `worktree_reset_active` (a session involved is busy), and
   * `worktree_reset_invalid_state` (corrupt or ambiguous ownership state; a
   * partial transfer this request started is rolled back, while a
   * pre-existing interrupted state is left untouched for operator repair).
   * A crashed transfer whose sidecar links agree is self-healed here: a
   * pre-commit one (the marker still names this session, or is absent while
   * the replacement is dormant) is rolled back and re-run in the same
   * request, and a committed one (the marker names the replacement) is
   * finished idempotently. Every other interrupted shape — disagreeing links,
   * an invalid marker, a marker naming a third session, a replacement still
   * live with no marker — is reported as `worktree_reset_invalid_state` (or
   * `worktree_reset_active` when the committed replacement is busy) and left
   * untouched: a retry re-reads the same state and returns the same 409, so
   * it does not converge and needs operator repair rather than a retry loop.
   * `worktree_reset_interrupted`, `worktree_session_superseded`, and
   * `worktree_marker_missing` belong to the restore surface (`loadSession` /
   * `resumeSession`) instead; for `worktree_reset_interrupted` — the
   * agreeing-links shape — retrying this reset against the superseded session
   * is the repair.
   */
  async resetWorktreeSession(sessionId, req = {}) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/worktree-reset`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          ...req.workspaceCwd !== void 0 ? { cwd: req.workspaceCwd } : {},
          ...req.modelServiceId !== void 0 ? { modelServiceId: req.modelServiceId } : {},
          ...req.approvalMode !== void 0 ? { approvalMode: req.approvalMode } : {},
          ...req.sourceType !== void 0 ? { sourceType: req.sourceType } : {},
          ...req.sourceId !== void 0 ? { sourceId: req.sourceId } : {}
        })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /session/:id/worktree-reset");
        }
        return await res.json();
      }
    );
  }
  async branchSession(sessionId, req = {}, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/branch`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify({
          name: req.name,
          ..."atRecordId" in req ? { atRecordId: req.atRecordId } : {}
        })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /session/:id/branch");
        }
        return await res.json();
      },
      12e4
    );
  }
  async createSideTaskSession(sessionId, req = {}, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/side-task`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify({
          ...req.name !== void 0 ? { name: req.name } : {}
        })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /session/:id/side-task");
        }
        return await res.json();
      }
    );
  }
  async forkSession(sessionId, req, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/fork`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify({ directive: req.directive })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /session/:id/fork");
        }
        return await res.json();
      }
    );
  }
  async sessionContext(sessionId, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/context`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /session/:id/context");
        }
        return await res.json();
      }
    );
  }
  /**
   * Read the current in-memory runtime status for one live daemon session.
   */
  async sessionStatus(sessionId, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/status`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /session/:id/status");
        }
        return await res.json();
      }
    );
  }
  async sessionContextUsage(sessionId, opts = {}, clientId) {
    const params = new URLSearchParams();
    if (opts.detail === true) params.set("detail", "true");
    const query = params.toString();
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/context-usage${query ? `?${query}` : ""}`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /session/:id/context-usage");
        }
        return await res.json();
      }
    );
  }
  async sessionSupportedCommands(sessionId, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/supported-commands`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "GET /session/:id/supported-commands"
          );
        }
        return await res.json();
      }
    );
  }
  async sessionTasks(sessionId, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/tasks`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /session/:id/tasks");
        }
        return await res.json();
      }
    );
  }
  async sessionAgents(sessionId, clientId, signal) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/agents`,
      { headers: this.headers({}, clientId), signal },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /session/:id/agents");
        }
        return await res.json();
      }
    );
  }
  async sessionAgentTrace(sessionId, opts = {}) {
    const query = new URLSearchParams();
    if (opts.rootAgentId) {
      query.set("rootAgentId", opts.rootAgentId);
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/agent-trace${suffix}`,
      { headers: this.headers({}, opts.clientId), signal: opts.signal },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /session/:id/agent-trace");
        }
        return await res.json();
      }
    );
  }
  async sessionWorkflowTasks(sessionId, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/tasks?includeWorkflows=true`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /session/:id/tasks");
        }
        return await res.json();
      }
    );
  }
  async sessionSavedWorkflow(sessionId, name, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/saved-workflows/${urlEncode(name)}`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "GET /session/:id/saved-workflows/:name"
          );
        }
        return await res.json();
      }
    );
  }
  async sessionLspStatus(sessionId, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/lsp`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /session/:id/lsp");
        }
        return await res.json();
      }
    );
  }
  async sessionTaskCancel(sessionId, taskId, kind, clientId) {
    return await this.sessionTaskMutation(
      sessionId,
      taskId,
      "cancel",
      { kind },
      clientId
    );
  }
  /**
   * Control a workflow run, or start a new one. `taskId` is the run id for the
   * control actions, the definition name for `run-saved`, and the caller's own
   * start key for `run-script` — two concurrent starts under one key start one
   * run. `input` is read by the two start actions only.
   */
  async sessionWorkflowTaskAction(sessionId, taskId, action, clientId, input) {
    return await this.sessionTaskMutation(
      sessionId,
      taskId,
      "workflow-action",
      {
        action,
        // Sent only when supplied, so a control action's body is what it was
        // before start input existed.
        ...input?.args !== void 0 ? { args: input.args } : {},
        ...input?.sourceRef !== void 0 ? { sourceRef: input.sourceRef } : {},
        ...input?.script !== void 0 ? { script: input.script } : {}
      },
      clientId
    );
  }
  async sessionTaskMutation(sessionId, taskId, route, body, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/tasks/${urlEncode(taskId)}/${route}`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify(body)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            `POST /session/:id/tasks/:taskId/${route}`
          );
        }
        return await res.json();
      }
    );
  }
  sessionGoalClear(sessionId, clientId) {
    return this.jsonRequest(
      `/session/${urlEncode(sessionId)}/goal/clear`,
      "POST /session/:id/goal/clear",
      { method: "POST", body: {}, clientId }
    );
  }
  sessionGoal(sessionId, clientId) {
    return this.jsonRequest(
      `/session/${urlEncode(sessionId)}/goal`,
      "GET /session/:id/goal",
      { clientId }
    );
  }
  sessionGoalControl(sessionId, request, clientId) {
    return this.jsonRequest(
      `/session/${urlEncode(sessionId)}/goal`,
      "POST /session/:id/goal",
      { method: "POST", body: request, clientId }
    );
  }
  async sessionStats(sessionId, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/stats`,
      { headers: this.headers({}, clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /session/:id/stats");
        }
        return await res.json();
      }
    );
  }
  /**
   * Shared transport for `loadSession` / `resumeSession`. Both routes
   * share an identical wire shape (POST /session/:id/{load|resume}
   * with optional `cwd` body) and identical error envelopes from the
   * daemon, so they collapse into a single fetch path that only
   * differs in the URL suffix and the route name reported on errors.
   */
  async restoreSession(action, sessionId, req, clientId) {
    let sourceType = req.sourceType;
    let sourceId = req.sourceId;
    if (req.sourceType !== void 0 || req.sourceId !== void 0) {
      try {
        await this.requireCapability("session_source_metadata");
      } catch (error) {
        if (!(error instanceof DaemonCapabilityMissingError)) {
          throw error;
        }
        sourceType = void 0;
        sourceId = void 0;
      }
    }
    const timeoutMs = this.resolveRestoreTimeoutMs(req.timeoutMs);
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/${action}`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify({
          cwd: req.workspaceCwd,
          ...req.approvalMode !== void 0 ? { approvalMode: req.approvalMode } : {},
          ...action === "load" && req.historyPageSize !== void 0 ? { historyPageSize: req.historyPageSize } : {},
          ...action === "load" && req.compactedReplayMode !== void 0 ? { compactedReplayMode: req.compactedReplayMode } : {},
          ...action === "load" && req.liveReplayMode !== void 0 ? { liveReplayMode: req.liveReplayMode } : {},
          ...sourceType !== void 0 ? { sourceType } : {},
          ...sourceId !== void 0 ? { sourceId } : {}
        })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, `POST /session/:id/${action}`);
        }
        return await res.json();
      },
      timeoutMs
    );
  }
  resolveRestoreTimeoutMs(perRequestTimeoutMs) {
    if (perRequestTimeoutMs !== void 0) {
      if (!Number.isFinite(perRequestTimeoutMs) || !Number.isInteger(perRequestTimeoutMs) || perRequestTimeoutMs < 0) {
        throw new TypeError(
          "RestoreSessionRequest.timeoutMs must be a non-negative integer"
        );
      }
      return perRequestTimeoutMs > MAX_TIMER_DELAY_MS ? 0 : perRequestTimeoutMs;
    }
    if (this.hasExplicitFetchTimeout) {
      return this.fetchTimeoutMs > MAX_TIMER_DELAY_MS ? 0 : this.fetchTimeoutMs;
    }
    const derived = this.cachedSessionRestoreTimeoutMs ? this.cachedSessionRestoreTimeoutMs + SESSION_RESTORE_TIMEOUT_HEADROOM_MS : DEFAULT_SESSION_RESTORE_TIMEOUT_MS;
    return derived > MAX_TIMER_DELAY_MS ? 0 : derived;
  }
  /**
   * Change the approval mode of a live session.
   * The daemon applies the change in the ACP child's per-session
   * `Config` and publishes an `approval_mode_changed` event. Pass
   * `opts.persist: true` to also write `tools.approvalMode` to the
   * workspace settings file (default is ephemeral so a remote caller
   * does not pollute the user's host settings unless asked).
   *
   * Pre-flight `caps.features.session_approval_mode_control` before
   * calling — older daemons reject the route with 404.
   *
   * The trust-folder gate inside core's `setApprovalMode` rejects
   * privileged modes in untrusted folders; the route surfaces that
   * with HTTP 403 + `errorKind: 'auth_env_error'`.
   */
  async setSessionApprovalMode(sessionId, mode, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/approval-mode`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify({
          mode,
          ...opts?.planMode !== void 0 ? { planMode: opts.planMode } : {},
          ...opts?.persist === true ? { persist: true } : {}
        })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /session/:id/approval-mode");
        }
        return await res.json();
      }
    );
  }
  async getRewindSnapshots(sessionId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/rewind/snapshots`,
      { method: "GET", headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "GET /session/:id/rewind/snapshots"
          );
        }
        return await res.json();
      },
      void 0,
      "rest"
    );
  }
  async rewindSession(sessionId, promptId, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/rewind`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify({
          promptId,
          ...opts?.rewindFiles !== void 0 ? { rewindFiles: opts.rewindFiles } : {}
        })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /session/:id/rewind");
        }
        return await res.json();
      },
      void 0,
      "rest"
    );
  }
  /**
   * Generate a one-sentence "where did I leave off"
   * recap of the session. Wraps `generateSessionRecap` (core/services/
   * sessionRecap.ts) via an ACP control-channel ext-method, so the
   * summary is computed against the active LlmClient chat history
   * inside the daemon's ACP child.
   *
   * Non-strict mutation gate — posture matches `/session/:id/prompt`
   * (the route costs tokens but mutates no state). Calls `_fetch`
   * directly without the per-call `fetchTimeoutMs` wrapper because the
   * underlying side-query can take longer than the default 30s under
   * a slow model. Older daemons (pre-recap support) return 404 —
   * pre-flight `caps.features.session_recap` before calling.
   *
   * Cancellation: the optional `signal` aborts only the LOCAL HTTP
   * fetch. It does NOT propagate to the daemon — the bridge-side wait
   * continues until the 60s `SESSION_RECAP_TIMEOUT_MS` backstop, and
   * the side-query inside the ACP child always runs to completion (no
   * cross-process abort plumbing in v1). A future request-id-based
   * cancel ext-method will plumb a real signal end-to-end if/when the
   * bandwidth cost justifies it.
   *
   * `recap` may be `null` on too-short histories or transient model
   * failures (a 200 response with `recap: null`), per the best-effort
   * contract of the core helper.
   */
  async recapSession(sessionId, opts) {
    const res = await this.transport.fetch(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/recap`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: "{}",
        signal: opts?.signal
      }
    );
    if (!res.ok) throw await this.failOnError(res, "POST /session/:id/recap");
    return await res.json();
  }
  async *generateSessionContent(sessionId, prompt, opts) {
    yield* this.generateContentEvents(
      `/session/${urlEncode(sessionId)}/generate`,
      "POST /session/:id/generate",
      { prompt },
      opts,
      parseSessionGenerationEvent,
      false
    );
  }
  async btwSession(sessionId, question, opts) {
    const res = await this.transport.fetch(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/btw`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify({ question }),
        signal: opts?.signal
      }
    );
    if (!res.ok) throw await this.failOnError(res, "POST /session/:id/btw");
    return await res.json();
  }
  async uploadSessionAttachment(sessionId, data, name, mimeType, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/attachments?name=${urlEncode(name)}`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": mimeType }, opts?.clientId),
        body: data,
        signal: opts?.signal
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /session/:id/attachments");
        }
        return await res.json();
      }
    );
  }
  async readSessionArtifactContent(sessionId, artifactId, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/artifacts/${urlEncode(artifactId)}/content`,
      {
        method: "GET",
        headers: this.headers({}, opts?.clientId),
        signal: opts?.signal
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "GET /session/:id/artifacts/:artifactId/content"
          );
        }
        return await res.text();
      }
    );
  }
  async readSessionAttachment(sessionId, attachmentId, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/attachments/${urlEncode(attachmentId)}`,
      {
        method: "GET",
        headers: this.headers({}, opts?.clientId),
        signal: opts?.signal
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "GET /session/:id/attachments/:attachmentId"
          );
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + 32768)
          );
        }
        return {
          data: btoa(binary),
          mimeType: res.headers.get("content-type") ?? "application/octet-stream"
        };
      }
    );
  }
  async listSessionAttachments(sessionId, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/attachments`,
      {
        method: "GET",
        headers: this.headers({}, opts?.clientId),
        signal: opts?.signal
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /session/:id/attachments");
        }
        const body = await res.json();
        return Array.isArray(body.attachments) ? body.attachments : [];
      }
    );
  }
  async removeSessionAttachment(sessionId, attachmentId, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/attachments/${urlEncode(attachmentId)}`,
      {
        method: "DELETE",
        headers: this.headers({}, opts?.clientId),
        signal: opts?.signal
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "DELETE /session/:id/attachments/:attachmentId"
          );
        }
        return (await res.json()).removed === true;
      }
    );
  }
  /**
   * Queue a user message typed while the session's turn is still running. The
   * ACP child drains it between tool batches so the model sees it before the
   * turn ends. Every accepted request is daemon-owned; a caller-supplied id
   * makes ambiguous retries idempotent. `opts.content` carries media content
   * image blocks alongside the text — pre-flight the
   * `session_attachments` capability; older daemons ignore the
   * field and drop the media.
   */
  async enqueueMidTurnMessage(sessionId, message, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/mid-turn-message`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify({
          message,
          messageId: opts?.messageId,
          ...opts?.eventDetailMode !== void 0 ? { eventDetailMode: opts.eventDetailMode } : {},
          ...opts?.content && opts.content.length > 0 ? { content: opts.content } : {}
        }),
        signal: opts?.signal
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "POST /session/:id/mid-turn-message"
          );
        }
        return await res.json();
      }
    );
  }
  async removeMidTurnMessage(sessionId, messageId, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/mid-turn-messages/${urlEncode(messageId)}`,
      {
        method: "DELETE",
        headers: this.headers({}, opts?.clientId)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "DELETE /session/:id/mid-turn-messages/:messageId"
          );
        }
        return await res.json();
      }
    );
  }
  /**
   * Fetch the mid-turn reconciliation snapshot for a session: messages still
   * waiting in the daemon queue plus bounded terminal id rings.
   * Callers reconcile against this
   * instead of resending accepted messages at the idle boundary. Only available
   * when the daemon advertises `session_mid_turn_message_query` — older
   * daemons answer 404 and callers keep the legacy behavior.
   */
  async getMidTurnMessages(sessionId, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/mid-turn-messages`,
      {
        method: "GET",
        headers: this.headers({}, opts?.clientId),
        signal: opts?.signal
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "GET /session/:id/mid-turn-messages"
          );
        }
        return await res.json();
      }
    );
  }
  /**
   * List prompts in the daemon's per-session pending queue. Includes the
   * currently running prompt (`state: 'running'`) and any FIFO-waiting
   * prompts (`state: 'queued'`). Returns an empty array when no prompts
   * are pending.
   */
  async getPendingPrompts(sessionId, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/pending-prompts`,
      {
        method: "GET",
        headers: this.headers({}, opts?.clientId)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /session/:id/pending-prompts");
        }
        return await res.json();
      }
    );
  }
  /**
   * Remove a specific prompt from the daemon's pending queue. For queued
   * prompts this aborts them so the FIFO skips dispatch; for the running
   * prompt this triggers a cancel. Returns `{ removed: false }` when the
   * promptId is not found.
   */
  async removePendingPrompt(sessionId, promptId, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/pending-prompts/${urlEncode(promptId)}`,
      {
        method: "DELETE",
        headers: this.headers({}, opts?.clientId)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "DELETE /session/:id/pending-prompts/:promptId"
          );
        }
        return await res.json();
      }
    );
  }
  /**
   * Execute a direct daemon-side shell command for a session. The daemon must
   * be started with direct session shell enabled and either bearer auth or
   * trusted-loopback operator authority; callers must also provide a client id
   * already bound to this session.
   * Prefer `DaemonSessionClient.shellCommand()` when available because it
   * forwards the session-bound client id automatically.
   */
  async shellCommand(sessionId, command, opts) {
    const res = await this.transport.fetch(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/shell`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify({ command }),
        signal: opts?.signal
      }
    );
    if (!res.ok) throw await this.failOnError(res, "POST /session/:id/shell");
    return await res.json();
  }
  /**
   * Toggle a tool name in the workspace's
   * `tools.disabled` settings list. The strict mutation gate accepts
   * trusted-loopback operator authority or listener credentials. The daemon
   * writes the settings file directly and fan-outs a `tool_toggled` event to
   * every live session SSE bus.
   *
   * Already-registered tools in active sessions are NOT retroactively
   * unregistered. The toggle takes effect on the next ACP child spawn
   * — listeners that need the live tool list to reflect the change
   * should also `POST /workspace/mcp/:server/restart` (when the tool
   * is MCP-discovered) or open a new session.
   *
   * Pre-flight `caps.features.workspace_tool_toggle` before calling.
   */
  async setWorkspaceToolEnabled(toolName, enabled, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/tools/${urlEncode(toolName)}/enable`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify({ enabled })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "POST /workspace/tools/:name/enable"
          );
        }
        return await res.json();
      }
    );
  }
  /**
   * Update workspace Skill settings by name without requiring a loaded Skill.
   * Active ACP sessions refresh their skill validation and command lists before
   * the response returns; `activation` reports deferred or partial refreshes.
   *
   * Pre-flight
   * `caps.features.includes('workspace_skill_settings_toggle')` before calling.
   */
  async setWorkspaceSkillEnabled(skillName, enabled, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/skills/${urlEncode(skillName)}/enable`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify({ enabled })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "POST /workspace/skills/:name/enable"
          );
        }
        return await res.json();
      }
    );
  }
  /**
   * Update workspace Skill settings for up to 100 names in one write.
   *
   * Pre-flight
   * `caps.features.includes('workspace_skill_settings_batch_toggle')` before
   * calling.
   */
  async setWorkspaceSkillsEnabled(skillNames, enabled, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/skills/enable`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify({ skillNames, enabled })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspace/skills/enable");
        }
        return await res.json();
      }
    );
  }
  installWorkspaceSkill(request) {
    return this.jsonRequest("/workspace/skills/install", "Skill", {
      method: "POST",
      body: request
    });
  }
  deleteWorkspaceSkill(skillName, scope) {
    return this.jsonRequest(
      `/workspace/skills/${urlEncode(skillName)}?scope=${scope}`,
      "Skill",
      { method: "DELETE" }
    );
  }
  installWorkspaceConfigSkill(request) {
    return this.jsonRequest("/workspace/config/skills/install", "Skill", {
      method: "POST",
      body: request,
      mode: "rest"
    });
  }
  deleteWorkspaceConfigSkill(skillName, scope) {
    return this.jsonRequest(
      `/workspace/config/skills/${urlEncode(skillName)}?scope=${scope}`,
      "Skill",
      { method: "DELETE", mode: "rest" }
    );
  }
  async workspaceSettings(opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/settings`,
      {
        method: "GET",
        headers: this.headers({}, opts?.clientId)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace/settings");
        }
        return await res.json();
      }
    );
  }
  async setWorkspaceSetting(scope, key, value, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/settings`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify({
          scope,
          key,
          value,
          ...opts?.mcpServerMutation ? { mcpServerMutation: opts.mcpServerMutation } : {}
        })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspace/settings");
        }
        return await res.json();
      }
    );
  }
  async modelConfigurations() {
    return this.jsonRequest("/workspace/models", "GET /workspace/models");
  }
  async updateModelContextWindow(key, contextWindowSize) {
    return this.fetchWithTimeout(
      `${this.baseUrl}/workspace/models`,
      {
        method: "PATCH",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ key, contextWindowSize })
      },
      async (res) => {
        if (!res.ok)
          throw await this.failOnError(res, "PATCH /workspace/models");
        return await res.json();
      },
      this.hasExplicitFetchTimeout ? void 0 : DEFAULT_PROVIDER_MUTATION_TIMEOUT_MS
    );
  }
  async deleteModel(target, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/models`,
      {
        method: "DELETE",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify(target)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "DELETE /workspace/models");
        }
        return await res.json();
      },
      this.hasExplicitFetchTimeout ? void 0 : DEFAULT_PROVIDER_MUTATION_TIMEOUT_MS
    );
  }
  async workspaceVoice(clientId) {
    return await this.jsonRequest(
      "/workspace/voice",
      "GET /workspace/voice",
      { clientId }
    );
  }
  async setWorkspaceVoice(update, clientId) {
    return await this.jsonRequest(
      "/workspace/voice",
      "POST /workspace/voice",
      { method: "POST", body: update, clientId }
    );
  }
  async transcribeWorkspaceVoice(audio, opts) {
    return await this.voiceTranscriptionRequest(
      "/workspace/voice/transcribe",
      "POST /workspace/voice/transcribe",
      audio,
      opts
    );
  }
  async liveStatus(clientId) {
    return await this.jsonRequest(
      "/live/status",
      "GET /live/status",
      {
        clientId
      }
    );
  }
  async liveSetupStatus(clientId) {
    return await this.jsonRequest(
      "/live/setup",
      "GET /live/setup",
      { clientId }
    );
  }
  async updateLiveSetup(update, clientId) {
    return await this.jsonRequest(
      "/live/setup",
      "POST /live/setup",
      { method: "POST", body: update, clientId }
    );
  }
  async retryLiveHostInstall(clientId) {
    return await this.jsonRequest(
      "/live/setup/install",
      "POST /live/setup/install",
      { method: "POST", body: {}, clientId }
    );
  }
  async launchLiveHost(clientId) {
    return await this.jsonRequest(
      "/live/setup/launch",
      "POST /live/setup/launch",
      { method: "POST", body: {}, clientId }
    );
  }
  async startLive(mode = "resume", clientId) {
    const path = mode === "new" ? "/live/new" : "/live/start";
    return await this.jsonRequest(
      path,
      mode === "new" ? "POST /live/new" : "POST /live/start",
      { method: "POST", body: {}, clientId }
    );
  }
  async stopLive(clientId) {
    return await this.jsonRequest(
      "/live/stop",
      "POST /live/stop",
      { method: "POST", body: {}, clientId }
    );
  }
  async setLiveMute(update, clientId) {
    return await this.jsonRequest(
      "/live/mute",
      "POST /live/mute",
      { method: "POST", body: update, clientId }
    );
  }
  async setLiveShortcut(shortcut, clientId) {
    return await this.jsonRequest(
      "/live/shortcut",
      "POST /live/shortcut",
      { method: "POST", body: { shortcut }, clientId }
    );
  }
  /** @internal */
  async workspaceVoiceTranscriptionRequest(workspaceSelector, audio, opts) {
    return await this.voiceTranscriptionRequest(
      `/workspaces/${workspaceSelector}/voice/transcribe`,
      "POST /workspaces/:workspace/voice/transcribe",
      audio,
      opts
    );
  }
  async voiceTranscriptionRequest(path, label, audio, opts) {
    const query = opts.voiceModel ? `?${new URLSearchParams({ voiceModel: opts.voiceModel }).toString()}` : "";
    return await this.fetchWithTimeout(
      `${this.baseUrl}${path}${query}`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": opts.mimeType }, opts.clientId),
        body: audio
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, label);
        }
        return await res.json();
      },
      opts.timeoutMs ?? VOICE_TRANSCRIPTION_DEFAULT_TIMEOUT_MS,
      "rest"
    );
  }
  async workspaceTrust(opts) {
    const query = opts?.statusVersion === 2 ? "?statusVersion=2" : "";
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/trust${query}`,
      {
        method: "GET",
        headers: this.headers({}, opts?.clientId)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace/trust");
        }
        return await res.json();
      }
    );
  }
  async requestWorkspaceTrustChange(request, clientId) {
    return await this.jsonRequest(
      "/workspace/trust/request",
      "POST /workspace/trust/request",
      { method: "POST", body: request, clientId }
    );
  }
  async workspacePermissions(opts) {
    return await this.jsonRequest(
      "/workspace/permissions",
      "GET /workspace/permissions",
      { clientId: opts?.clientId }
    );
  }
  /**
   * Replace one permission rule list.
   *
   * `capabilities.features` including `workspace_permissions` means the
   * daemon exposes the permissions surface. A write still needs a live ACP
   * session so the active child can receive the update; without one the
   * daemon rejects the request with `permission_session_required`.
   */
  async setWorkspacePermissionRules(scope, ruleType, rules, opts) {
    return await this.jsonRequest(
      "/workspace/permissions",
      "POST /workspace/permissions",
      {
        method: "POST",
        body: { scope, ruleType, rules: [...rules] },
        clientId: opts?.clientId
      }
    );
  }
  /**
   * Convenience helper that appends a single rule to the specified scope/type
   * list. Performs a non-atomic read-modify-write: GETs the current rules,
   * appends the new rule locally, then POSTs the full replacement list.
   *
   * @remarks Not safe for concurrent use — a concurrent modification between
   * the GET and POST will be silently overwritten (lost-update / TOCTOU).
   */
  async addWorkspacePermissionRule(scope, ruleType, rule, opts) {
    const normalized = normalizePermissionRuleInput(rule);
    const current = await this.workspacePermissions(opts);
    const rules = current[scope].rules[ruleType];
    if (rules.includes(normalized)) return current;
    return await this.setWorkspacePermissionRules(
      scope,
      ruleType,
      [...rules, normalized],
      opts
    );
  }
  /**
   * Convenience helper that removes a single rule from the specified scope/type
   * list. Performs a non-atomic read-modify-write: GETs the current rules,
   * removes the rule locally, then POSTs the full replacement list.
   *
   * @remarks Not safe for concurrent use — a concurrent modification between
   * the GET and POST will be silently overwritten (lost-update / TOCTOU).
   */
  async removeWorkspacePermissionRule(scope, ruleType, rule, opts) {
    const normalized = normalizePermissionRuleInput(rule);
    const current = await this.workspacePermissions(opts);
    const rules = current[scope].rules[ruleType];
    if (!rules.includes(normalized)) return current;
    return await this.setWorkspacePermissionRules(
      scope,
      ruleType,
      rules.filter((item) => item !== normalized),
      opts
    );
  }
  /**
   * Restart a configured MCP server through the ACP child's
   * `McpClientManager`. The daemon pre-checks the live budget
   * snapshot; soft refusals (in-flight discovery,
   * disabled server, budget would exceed under `enforce` mode) come
   * back as 200 OK with `{restarted: false, skipped: true, reason}`.
   * Only hard errors (unknown server name, no live ACP channel)
   * surface as non-2xx.
   *
   * The daemon-side restart waits up to 5 minutes for stdio MCP
   * discovery; the SDK default allows that budget plus 30s headroom
   * so a slow but valid restart isn't
   * aborted client-side while the daemon continues working. Callers can pass a custom
   * `timeoutMs` when their threat model needs a tighter cap, or `0`
   * to disable the timeout entirely.
   *
   * `entryIndex` targets one pooled entry by index. Use `'*'` to
   * restart all entries for a pooled server.
   *
   * Pre-flight `caps.features.workspace_mcp_restart` before calling.
   */
  async restartMcpServer(serverName, opts) {
    const query = opts?.entryIndex === void 0 ? "" : `?entryIndex=${urlEncode(String(opts.entryIndex))}`;
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/${urlEncode(serverName)}/restart${query}`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: "{}"
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "POST /workspace/mcp/:server/restart"
          );
        }
        return await res.json();
      },
      opts?.timeoutMs ?? MCP_RESTART_DEFAULT_TIMEOUT_MS
    );
  }
  async reload(opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/reload`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: "{}"
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspace/reload");
        }
        return await res.json();
      },
      opts?.timeoutMs
    );
  }
  /**
   * Reload the daemon-managed channel worker: the daemon stops and relaunches
   * it so it re-reads settings.json (channels / proxy / per-channel model).
   * Requires an enabled runtime selection; otherwise the route responds 409.
   * Pre-flight the dynamic `channel_reload` capability.
   */
  async reloadChannelWorker(opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/channel/reload`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: "{}"
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspace/channel/reload");
        }
        return await res.json();
      },
      opts?.timeoutMs ?? CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS
    );
  }
  async getChannelWorkerControl(opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/channel`,
      {
        method: "GET",
        headers: this.headers({}, opts?.clientId)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace/channel");
        }
        return await res.json();
      },
      opts?.timeoutMs
    );
  }
  async setChannelWorkerSelection(selection, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/channel`,
      {
        method: "PUT",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify({ selection })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "PUT /workspace/channel");
        }
        return await res.json();
      },
      opts?.timeoutMs ?? CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS
    );
  }
  async stopChannelWorker(opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/channel`,
      {
        method: "DELETE",
        headers: this.headers({}, opts?.clientId)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "DELETE /workspace/channel");
        }
        return await res.json();
      },
      opts?.timeoutMs ?? CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS
    );
  }
  workspaceChannelTypes(opts) {
    return this.jsonRequest(
      "/workspace/channel-types",
      "GET /workspace/channel-types",
      { clientId: opts?.clientId, timeoutMs: opts?.timeoutMs, mode: "rest" }
    );
  }
  workspaceChannels(opts) {
    return this.jsonRequest(
      "/workspace/channels",
      "GET /workspace/channels",
      { clientId: opts?.clientId, timeoutMs: opts?.timeoutMs, mode: "rest" }
    );
  }
  upsertWorkspaceChannel(name, request, opts) {
    return this.jsonRequest(
      `/workspace/channels/${urlEncode(name)}`,
      "PUT /workspace/channels/:name",
      {
        method: "PUT",
        body: request,
        clientId: opts?.clientId,
        timeoutMs: opts?.timeoutMs ?? CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS,
        mode: "rest"
      }
    );
  }
  deleteWorkspaceChannel(name, request, opts) {
    return this.jsonRequest(
      `/workspace/channels/${urlEncode(name)}`,
      "DELETE /workspace/channels/:name",
      {
        method: "DELETE",
        body: request,
        clientId: opts?.clientId,
        timeoutMs: opts?.timeoutMs ?? CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS,
        mode: "rest"
      }
    );
  }
  setWorkspaceChannelStartup(name, request, opts) {
    return this.jsonRequest(
      `/workspace/channels/${urlEncode(name)}/startup`,
      "PUT /workspace/channels/:name/startup",
      {
        method: "PUT",
        body: request,
        clientId: opts?.clientId,
        timeoutMs: opts?.timeoutMs ?? CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS,
        mode: "rest"
      }
    );
  }
  startWorkspaceChannel(name, opts) {
    return this.workspaceChannelAction(name, "start", opts);
  }
  stopWorkspaceChannel(name, opts) {
    return this.workspaceChannelAction(name, "stop", opts);
  }
  restartWorkspaceChannel(name, opts) {
    return this.workspaceChannelAction(name, "restart", opts);
  }
  workspaceChannelPairingRequests(name, opts) {
    return this.jsonRequest(
      `/workspace/channels/${urlEncode(name)}/pairing-requests`,
      "GET /workspace/channels/:name/pairing-requests",
      { clientId: opts?.clientId, timeoutMs: opts?.timeoutMs, mode: "rest" }
    );
  }
  approveWorkspaceChannelPairing(name, request, opts) {
    return this.jsonRequest(
      `/workspace/channels/${urlEncode(name)}/pairing-requests/approve`,
      "POST /workspace/channels/:name/pairing-requests/approve",
      {
        method: "POST",
        body: request,
        clientId: opts?.clientId,
        timeoutMs: opts?.timeoutMs ?? CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS,
        mode: "rest"
      }
    );
  }
  workspaceChannelPairingApprovals(name, opts) {
    return this.jsonRequest(
      `/workspace/channels/${urlEncode(name)}/pairing-approvals`,
      "GET /workspace/channels/:name/pairing-approvals",
      { clientId: opts?.clientId, timeoutMs: opts?.timeoutMs, mode: "rest" }
    );
  }
  revokeWorkspaceChannelPairingApproval(name, request, opts) {
    return this.jsonRequest(
      `/workspace/channels/${urlEncode(name)}/pairing-approvals`,
      "DELETE /workspace/channels/:name/pairing-approvals",
      {
        method: "DELETE",
        body: request,
        clientId: opts?.clientId,
        timeoutMs: opts?.timeoutMs ?? CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS,
        mode: "rest"
      }
    );
  }
  workspaceChannelAction(name, action, opts) {
    return this.jsonRequest(
      `/workspace/channels/${urlEncode(name)}/${action}`,
      `POST /workspace/channels/:name/${action}`,
      {
        method: "POST",
        body: {},
        clientId: opts?.clientId,
        timeoutMs: opts?.timeoutMs ?? CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS,
        mode: "rest"
      }
    );
  }
  async manageMcpServer(serverName, action, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/${urlEncode(serverName)}/${urlEncode(action)}`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: "{}"
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "POST /workspace/mcp/:server/:action"
          );
        }
        return await res.json();
      },
      opts?.timeoutMs ?? MCP_RESTART_DEFAULT_TIMEOUT_MS
    );
  }
  /**
   * Add (or replace) a runtime MCP server. The daemon
   * validates the config, starts the server, and emits an
   * `mcp_server_added` SSE event to all live sessions. Callers
   * pre-flight `caps.features.mcp_server_runtime_mutation` before
   * calling — older daemons return 404.
   */
  async addRuntimeMcpServer(request, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/servers`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify(request)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspace/mcp/servers");
        }
        return await res.json();
      },
      opts?.timeoutMs ?? MCP_RESTART_DEFAULT_TIMEOUT_MS
    );
  }
  /**
   * Remove a runtime MCP server by name. The daemon
   * tears down the server process, removes it from the runtime
   * overlay, and emits an `mcp_server_removed` SSE event. Idempotent
   * at the HTTP level: if the server was never present the daemon
   * returns 200 with `{ skipped: true, reason: 'not_present' }`.
   * Pre-flight `caps.features.mcp_server_runtime_mutation` before
   * calling.
   */
  async removeRuntimeMcpServer(name, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/mcp/servers/${urlEncode(name)}`,
      {
        method: "DELETE",
        headers: this.headers({}, opts?.clientId)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "DELETE /workspace/mcp/servers/:name"
          );
        }
        return await res.json();
      },
      opts?.timeoutMs ?? MCP_RESTART_DEFAULT_TIMEOUT_MS
    );
  }
  /**
   * Scaffold a `QWEN.md` at the daemon's bound
   * workspace root. Mechanical only — does NOT invoke the LLM. The
   * daemon writes an empty file; clients that want AI-driven content
   * fill should follow up with `POST /session/:id/prompt`.
   *
   * Default refuses to overwrite — when the file exists with non-
   * whitespace content the daemon returns 409
   * `workspace_init_conflict` with the existing path and size in the
   * body. Pass `opts.force: true` to overwrite unconditionally.
   *
   * Pre-flight `caps.features.workspace_init` before calling.
   */
  async initWorkspace(opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/init`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify(opts?.force === true ? { force: true } : {})
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspace/init");
        }
        return await res.json();
      }
    );
  }
  async setupGithub(params, clientId) {
    return await this.jsonRequest(
      "/workspace/setup-github",
      "POST /workspace/setup-github",
      {
        method: "POST",
        body: params,
        clientId,
        timeoutMs: GITHUB_SETUP_DEFAULT_TIMEOUT_MS
      }
    );
  }
  /**
   * Switch the active model for a session. Backed by ACP's currently-unstable
   * `unstable_setSessionModel`; the daemon also publishes a `model_switched`
   * event so cross-client UIs can update.
   */
  async setSessionModel(sessionId, modelId, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/model`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify({ modelId })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /session/:id/model");
        }
        return await res.json();
      }
    );
  }
  async setSessionConfigOption(sessionId, configId, value, clientOrOptions) {
    const options = typeof clientOrOptions === "string" ? { clientId: clientOrOptions } : clientOrOptions;
    return await this.jsonRequest(
      `/session/${urlEncode(sessionId)}/config-option`,
      "POST /session/:id/config-option",
      {
        method: "POST",
        body: {
          configId,
          value,
          ...options?.persist !== void 0 ? { persist: options.persist } : {}
        },
        clientId: options?.clientId
      }
    );
  }
  async setSessionLanguage(sessionId, language, opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/language`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts?.clientId
        ),
        body: JSON.stringify({
          language,
          syncOutputLanguage: opts?.syncOutputLanguage ?? false
        })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /session/:id/language");
        }
        return await res.json();
      }
    );
  }
  /**
   * Sessionless user-level language sync (`POST /language`). Succeeds with
   * zero sessions, so hosts can switch language before creating one.
   * Pre-flight `caps.features.includes('user_language_sync')` — daemons that
   * predate the route or were built without settings persistence 404.
   */
  async setUserLanguage(language, opts) {
    return await this.jsonRequest(
      "/language",
      "POST /language",
      {
        method: "POST",
        body: {
          language,
          syncOutputLanguage: opts?.syncOutputLanguage ?? false
        },
        clientId: opts?.clientId
      }
    );
  }
  /**
   * Send a prompt to the agent. Supports both blocking (legacy 200)
   * and non-blocking (202 + SSE `turn_complete`) daemon responses.
   *
   * For 202 daemons this opens a **temporary** SSE subscription to
   * await the matching `turn_complete`/`turn_error`. Callers that
   * already manage a long-lived SSE subscription (e.g.
   * `DaemonSessionClient`) should prefer {@link promptNonBlocking}
   * and correlate via their existing event stream to avoid the extra
   * connection.
   */
  async prompt(sessionId, req, signal, clientId) {
    signal?.throwIfAborted();
    const releasePromptSlot = this.reservePromptSlot(sessionId);
    let releaseOnExit = true;
    try {
      const res = await this.transport.fetch(
        `${this.baseUrl}/session/${urlEncode(sessionId)}/prompt`,
        {
          method: "POST",
          headers: this.headers(
            { "Content-Type": "application/json" },
            clientId
          ),
          body: JSON.stringify(req),
          signal
        }
      );
      if (res.status === 202) {
        const accept = await res.json();
        releaseOnExit = false;
        try {
          return await this._awaitTurnComplete(
            sessionId,
            accept.promptId,
            accept.lastEventId,
            signal,
            clientId,
            accept.eventEpoch
          );
        } finally {
          releasePromptSlot();
        }
      }
      if (!res.ok) {
        throw await this.failOnError(
          res,
          "POST /session/:id/prompt",
          sessionId
        );
      }
      return await res.json();
    } finally {
      if (releaseOnExit) releasePromptSlot();
    }
  }
  /**
   * Fire-and-forget prompt trigger. Returns the 202 acceptance
   * envelope (`{ promptId, lastEventId }`) without waiting for the
   * turn to complete. The caller is responsible for observing
   * `turn_complete` / `turn_error` on the session's SSE stream,
   * matching by `promptId`.
   *
   * This is the recommended path for callers that already maintain a
   * long-lived SSE subscription (like `DaemonSessionClient`) —
   * avoids the extra SSE connection that {@link prompt} opens for
   * the temporary 202 fallback.
   *
   * Falls back to `prompt()` for legacy 200 daemons.
   *
   * Note: this method does not enforce the local pending-prompt cap.
   * Callers that need early-fail behavior should use {@link prompt} or
   * reserve a slot before calling this method.
   */
  async promptNonBlocking(sessionId, req, signal, clientId) {
    const res = await this.transport.fetch(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/prompt`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify(req),
        signal
      }
    );
    if (res.status === 202) {
      return await res.json();
    }
    if (!res.ok) {
      throw await this.failOnError(res, "POST /session/:id/prompt", sessionId);
    }
    return await res.json();
  }
  async _awaitTurnComplete(sessionId, promptId, lastEventId, signal, clientId, eventEpoch) {
    const sseAbort = new AbortController();
    const composedSignal = signal ? composeAbortSignals2([signal, sseAbort.signal]) : sseAbort.signal;
    try {
      const events = this.subscribeEvents(sessionId, {
        lastEventId,
        // Cursor and epoch both come from the 202 envelope: a daemon
        // restart between the 202 and this subscribe is detected as an
        // epoch mismatch instead of silently mis-resuming (DAEMON-001).
        ...eventEpoch !== void 0 ? { epoch: eventEpoch } : {},
        signal: composedSignal
      });
      for await (const event of events) {
        const result = matchTurnEvent(event, promptId);
        if (result !== void 0) return result;
      }
      throw new Error("SSE stream ended");
    } catch (err) {
      if (signal?.aborted && err instanceof DOMException && err.name === "AbortError") {
        this.cancel(sessionId, clientId).catch(() => {
        });
        throw err;
      }
      throw err;
    } finally {
      if (!sseAbort.signal.aborted) sseAbort.abort();
    }
  }
  /**
   * Bump the daemon's last-seen bookkeeping for this session. The
   * route is short-lived — drives diagnostics and future revocation
   * policy -- so it goes through the standard
   * `fetchTimeoutMs`. Older daemons return 404 for
   * `/heartbeat`; clients should pre-flight
   * `caps.features.client_heartbeat` before calling.
   */
  async heartbeat(sessionId, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/heartbeat`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: "{}"
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /session/:id/heartbeat");
        }
        return await res.json();
      }
    );
  }
  async cancel(sessionId, clientId) {
    await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/cancel`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: "{}"
      },
      async (res) => {
        if (!res.ok && res.status !== 204) {
          throw await this.failOnError(res, "POST /session/:id/cancel");
        }
        try {
          await res.body?.cancel();
        } catch {
        }
      }
    );
  }
  // -- Events stream -----------------------------------------------------
  async *subscribeEvents(sessionId, opts = {}) {
    yield* this.transport.subscribeEvents(sessionId, {
      lastEventId: opts.lastEventId,
      epoch: opts.epoch,
      onEpoch: opts.onEpoch,
      maxQueued: opts.maxQueued,
      clientId: opts.clientId,
      sseConnectReason: opts.sseConnectReason,
      previousSseStreamId: opts.previousSseStreamId,
      onSseStreamAccepted: opts.onSseStreamAccepted,
      signal: opts.signal,
      connectTimeoutMs: this.fetchTimeoutMs || void 0
    });
  }
  // -- Permissions -------------------------------------------------------
  /**
   * Cast a permission vote. Returns true when the daemon accepted the vote,
   * false on 404 (request unknown or already resolved by another client —
   * the typical "lost the race" outcome under multi-client fan-out).
   */
  async respondToPermission(requestId, response, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/permission/${urlEncode(requestId)}`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify(response)
      },
      async (res) => {
        if (res.status === 200) {
          try {
            await res.body?.cancel();
          } catch {
          }
          return true;
        }
        if (res.status === 404) {
          try {
            await res.body?.cancel();
          } catch {
          }
          return false;
        }
        throw await this.failOnError(res, "POST /permission/:requestId");
      }
    );
  }
  /**
   * Cast a permission vote against an explicit daemon session. New clients
   * should prefer this once `capabilities.features` includes
   * `session_permission_vote`; the legacy request-id-only route remains for
   * older daemons.
   */
  async respondToSessionPermission(sessionId, requestId, response, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/permission/${urlEncode(requestId)}`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify(response)
      },
      async (res) => {
        if (res.status === 200) {
          try {
            await res.body?.cancel();
          } catch {
          }
          return true;
        }
        if (res.status === 404) {
          try {
            await res.body?.cancel();
          } catch {
          }
          return false;
        }
        throw await this.failOnError(
          res,
          "POST /session/:id/permission/:requestId"
        );
      }
    );
  }
  // -- Session lifecycle ---------------------------------------------------
  /**
   * Close a daemon session. The daemon treats DELETE as idempotent for SDK
   * callers: both 204 (closed) and 404 (already gone) resolve successfully.
   */
  async closeSession(sessionId, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}`,
      {
        method: "DELETE",
        headers: this.headers({}, clientId)
      },
      async (res) => {
        if (res.status === 204 || res.status === 404) {
          try {
            await res.body?.cancel();
          } catch {
          }
          return;
        }
        throw await this.failOnError(res, "DELETE /session/:id");
      }
    );
  }
  async detachSession(sessionId, clientId) {
    if (!clientId) return;
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/detach`,
      {
        method: "POST",
        headers: this.headers({}, clientId)
      },
      async (res) => {
        if (res.status === 204 || res.status === 404) {
          try {
            await res.body?.cancel();
          } catch {
          }
          return;
        }
        throw await this.failOnError(res, "POST /session/:id/detach");
      }
    );
  }
  async deleteSessionsData(sessionIds, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/sessions/delete`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify({ sessionIds })
      },
      async (res) => {
        if (res.ok) {
          return await res.json();
        }
        throw await this.failOnError(res, "POST /sessions/delete");
      }
    );
  }
  async archiveSessionsData(sessionIds, clientIdOrOptions, clientId) {
    const options = typeof clientIdOrOptions === "object" ? clientIdOrOptions : void 0;
    return await this.fetchWithTimeout(
      `${this.baseUrl}/sessions/archive`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          typeof clientIdOrOptions === "string" ? clientIdOrOptions : clientId
        ),
        body: JSON.stringify({
          sessionIds,
          ...options?.resolveConflicts !== void 0 ? { resolveConflicts: options.resolveConflicts } : {}
        })
      },
      async (res) => {
        if (res.ok) {
          return await res.json();
        }
        throw await this.failOnError(res, "POST /sessions/archive");
      }
    );
  }
  async unarchiveSessionsData(sessionIds, clientIdOrOptions, clientId) {
    const options = typeof clientIdOrOptions === "object" ? clientIdOrOptions : void 0;
    return await this.fetchWithTimeout(
      `${this.baseUrl}/sessions/unarchive`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          typeof clientIdOrOptions === "string" ? clientIdOrOptions : clientId
        ),
        body: JSON.stringify({
          sessionIds,
          ...options?.resolveConflicts !== void 0 ? { resolveConflicts: options.resolveConflicts } : {}
        })
      },
      async (res) => {
        if (res.ok) {
          return await res.json();
        }
        throw await this.failOnError(res, "POST /sessions/unarchive");
      }
    );
  }
  // -- Auth device-flow ---------------------------------------------------
  /**
   * Start an OAuth device-flow login for the given provider. The daemon
   * polls the IdP in the background and emits typed `auth_device_flow_*`
   * SSE events; callers can also poll `getDeviceFlow(...)`.
   *
   * Per-provider singleton: a repeat call while a flow is already pending
   * for the same provider is an idempotent take-over and returns the
   * existing entry rather than starting a fresh IdP request. The
   * `attached` field on the result distinguishes the two cases.
   */
  async startDeviceFlow(opts) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/auth/device-flow`,
      {
        method: "POST",
        headers: this.headers(
          { "Content-Type": "application/json" },
          opts.clientId
        ),
        body: JSON.stringify({ providerId: opts.providerId })
      },
      async (res) => {
        if (res.status !== 200 && res.status !== 201) {
          throw await this.failOnError(res, "POST /workspace/auth/device-flow");
        }
        return await res.json();
      }
    );
  }
  async getDeviceFlow(deviceFlowId, opts = {}) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/auth/device-flow/${urlEncode(deviceFlowId)}`,
      { headers: this.headers({}, opts.clientId), signal: opts.signal },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(
            res,
            "GET /workspace/auth/device-flow/:id"
          );
        }
        return await res.json();
      }
    );
  }
  /**
   * Cancel a pending device-flow. Idempotent: terminal entries return
   * 204 (no-op); unknown ids return 404 — both resolve here, matching
   * the SDK's `closeSession` shape.
   */
  async cancelDeviceFlow(deviceFlowId, opts = {}) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/auth/device-flow/${urlEncode(deviceFlowId)}`,
      {
        method: "DELETE",
        headers: this.headers({}, opts.clientId)
      },
      async (res) => {
        if (res.status === 204 || res.status === 404) {
          try {
            await res.body?.cancel();
          } catch {
          }
          return;
        }
        throw await this.failOnError(
          res,
          "DELETE /workspace/auth/device-flow/:id"
        );
      }
    );
  }
  /** Snapshot of persisted auth credentials + currently pending device-flows. */
  async getAuthStatus(opts = {}) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/auth/status`,
      { headers: this.headers({}, opts.clientId) },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace/auth/status");
        }
        return await res.json();
      }
    );
  }
  async getAuthProviders() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/auth/providers`,
      { headers: this.headers() },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "GET /workspace/auth/providers");
        }
        return await res.json();
      }
    );
  }
  async installAuthProvider(req) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspace/auth/provider`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify(req)
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspace/auth/provider");
        }
        return await res.json();
      },
      this.hasExplicitFetchTimeout ? void 0 : DEFAULT_PROVIDER_MUTATION_TIMEOUT_MS
    );
  }
  async addWorkspace(cwd, options = {}) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspaces`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          cwd,
          ...options.persist ? { persist: true } : {},
          ...options.displayName !== void 0 ? { displayName: options.displayName } : {}
        })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspaces");
        }
        return await res.json();
      }
    );
  }
  async updateWorkspace(workspaceSelector, update) {
    return await this.workspaceJsonRequest(
      urlEncode(workspaceSelector),
      "",
      "PATCH /workspaces/:workspace",
      { method: "PATCH", body: update, mode: "rest" }
    );
  }
  /** Requests a process-local workspace in a daemon-managed empty directory. */
  async addScratchWorkspace() {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/workspaces`,
      {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ kind: "scratch" })
      },
      async (res) => {
        if (!res.ok) {
          throw await this.failOnError(res, "POST /workspaces");
        }
        return await res.json();
      }
    );
  }
  // -- Lifecycle / disposal ------------------------------------------------
  /**
   * Release transport resources (WS close, etc.). Idempotent.
   * After `dispose()`, further calls to `fetch` / `subscribeEvents`
   * on the underlying transport throw `DaemonTransportClosedError`.
   */
  dispose() {
    this.restoreBudgetGeneration = ++this.capabilitiesGeneration;
    this.capabilitiesRequest = void 0;
    this.capabilityFeatures = void 0;
    this.transport.dispose();
  }
  listSessionSources(sessionId, clientId) {
    return this.jsonRequest(
      `/session/${urlEncode(sessionId)}/sources`,
      "GET /session/:id/sources",
      { clientId, mode: "rest" }
    );
  }
  upsertSessionSource(sessionId, source, clientId) {
    return this.jsonRequest(
      `/session/${urlEncode(sessionId)}/sources`,
      "POST /session/:id/sources",
      { method: "POST", body: source, clientId, mode: "rest" }
    );
  }
  removeSessionSource(sessionId, sourceId, clientId) {
    return this.jsonRequest(
      `/session/${urlEncode(sessionId)}/sources/${urlEncode(sourceId)}`,
      "DELETE /session/:id/sources/:sourceId",
      { method: "DELETE", clientId, mode: "rest" }
    );
  }
  // -- Session artifacts ---------------------------------------------------
  async listSessionArtifacts(sessionId, clientId) {
    return await this.jsonRequest(
      `/session/${urlEncode(sessionId)}/artifacts`,
      "GET /session/:id/artifacts",
      { clientId }
    );
  }
  async addSessionArtifact(sessionId, artifact, clientId) {
    return await this.jsonRequest(
      `/session/${urlEncode(sessionId)}/artifacts`,
      "POST /session/:id/artifacts",
      {
        method: "POST",
        body: artifact,
        clientId
      }
    );
  }
  async removeSessionArtifact(sessionId, artifactId, clientId) {
    return await this.jsonRequest(
      `/session/${urlEncode(sessionId)}/artifacts/${urlEncode(artifactId)}`,
      "DELETE /session/:id/artifacts/:artifactId",
      {
        method: "DELETE",
        clientId
      }
    );
  }
  // -- Session metadata ----------------------------------------------------
  /**
   * Patch mutable session metadata and return the effective stored metadata
   * reported by the daemon.
   */
  async updateSessionMetadata(sessionId, metadata, clientId) {
    return await this.fetchWithTimeout(
      `${this.baseUrl}/session/${urlEncode(sessionId)}/metadata`,
      {
        method: "PATCH",
        headers: this.headers({ "Content-Type": "application/json" }, clientId),
        body: JSON.stringify(metadata)
      },
      async (res) => {
        if (res.status === 200) {
          const body = await res.json();
          const result = {};
          if (typeof body.displayName === "string") {
            result.displayName = body.displayName;
          }
          if (Array.isArray(body.prs)) {
            const valid = body.prs.filter(isDaemonSessionPrInfo);
            if (valid.length > 0) result.prs = valid;
          }
          return result;
        }
        throw await this.failOnError(res, "PATCH /session/:id/metadata");
      }
    );
  }
};
var WorkspaceDaemonClient = class {
  constructor(client, workspaceSelector) {
    this.client = client;
    this.workspaceSelector = workspaceSelector;
  }
  static {
    __name(this, "WorkspaceDaemonClient");
  }
  workspaceMcp() {
    return this.get("/mcp", "GET /workspaces/:workspace/mcp");
  }
  mcpConfig() {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/config/mcp/servers",
      "GET /workspaces/:workspace/config/mcp/servers",
      { mode: "rest" }
    );
  }
  setMcpServer(name, config) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/config/mcp/servers/${urlEncode(name)}`,
      "PUT /workspaces/:workspace/config/mcp/servers/:name",
      {
        method: "PUT",
        body: { scope: "workspace", config },
        mode: "rest"
      }
    );
  }
  removeMcpServer(name) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/config/mcp/servers/${urlEncode(name)}?scope=workspace`,
      "DELETE /workspaces/:workspace/config/mcp/servers/:name",
      { method: "DELETE", mode: "rest" }
    );
  }
  setMcpServerEnabled(name, enabled) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/config/mcp/${urlEncode(name)}/${enabled ? "enable" : "disable"}`,
      "POST /workspaces/:workspace/config/mcp/:server/:action",
      { method: "POST", body: {}, mode: "rest" }
    );
  }
  runtimeMcp() {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/runtime/mcp",
      "GET /workspaces/:workspace/runtime/mcp",
      { mode: "rest" }
    );
  }
  runtimeMcpTools(serverName) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/runtime/mcp/${urlEncode(serverName)}/tools`,
      "GET /workspaces/:workspace/runtime/mcp/:server/tools",
      { mode: "rest" }
    );
  }
  runtimeMcpResources(serverName) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/runtime/mcp/${urlEncode(serverName)}/resources`,
      "GET /workspaces/:workspace/runtime/mcp/:server/resources",
      { mode: "rest" }
    );
  }
  reloadRuntimeMcp(options = {}) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/runtime/mcp/reload",
      "POST /workspaces/:workspace/runtime/mcp/reload",
      {
        method: "POST",
        body: options,
        mode: "rest",
        timeoutMs: MCP_RESTART_DEFAULT_TIMEOUT_MS
      }
    );
  }
  restartRuntimeMcpServer(serverName) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/runtime/mcp/${urlEncode(serverName)}/restart`,
      "POST /workspaces/:workspace/runtime/mcp/:server/restart",
      {
        method: "POST",
        body: {},
        mode: "rest",
        timeoutMs: MCP_RESTART_DEFAULT_TIMEOUT_MS
      }
    );
  }
  manageRuntimeMcpServer(serverName, action) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/runtime/mcp/${urlEncode(serverName)}/${action}`,
      "POST /workspaces/:workspace/runtime/mcp/:server/:action",
      {
        method: "POST",
        body: {},
        mode: "rest",
        timeoutMs: MCP_RESTART_DEFAULT_TIMEOUT_MS
      }
    );
  }
  ensureRuntime() {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/runtime/ensure",
      "POST /workspaces/:workspace/runtime/ensure",
      {
        method: "POST",
        timeoutMs: WORKSPACE_RUNTIME_ENSURE_TIMEOUT_MS,
        mode: "rest"
      }
    );
  }
  runtimeStatus() {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/runtime/status",
      "GET /workspaces/:workspace/runtime/status",
      { mode: "rest" }
    );
  }
  /**
   * Ask the daemon host to open this workspace's directory in the host's OS
   * file manager (Finder/Explorer/xdg-open). Only advertised via the
   * `workspace_local_open` capability; on a headless host the daemon answers
   * 501 `local_path_open_unavailable`.
   */
  async openLocally() {
    await this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/open",
      "POST /workspaces/:workspace/open",
      { method: "POST", body: {}, mode: "rest" }
    );
  }
  /**
   * Ask the daemon host to open a terminal window in this workspace's
   * directory (Terminal.app/wt.exe/a Linux terminal emulator). Only
   * advertised via the `workspace_local_terminal` capability; on a headless
   * host the daemon answers 501 `local_path_open_unavailable`.
   */
  async openTerminalLocally() {
    await this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/open",
      "POST /workspaces/:workspace/open",
      { method: "POST", body: { target: "terminal" }, mode: "rest" }
    );
  }
  /**
   * Send text directly through this exact workspace's channel worker.
   * A successful capability pre-flight does not guarantee worker liveness;
   * callers must treat 503 `channel_worker_unavailable` as an expected outcome.
   */
  notify(req, opts) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/notify",
      "POST /workspaces/:workspace/notify",
      {
        method: "POST",
        body: req,
        timeoutMs: opts?.timeoutMs ?? CHANNEL_NOTIFY_DEFAULT_TIMEOUT_MS,
        mode: "rest"
      }
    );
  }
  workspaceChannelTypes(opts) {
    return this.channelRequest(
      "/channel-types",
      "GET /workspaces/:workspace/channel-types",
      void 0,
      opts
    );
  }
  workspaceChannels(opts) {
    return this.channelRequest(
      "/channels",
      "GET /workspaces/:workspace/channels",
      void 0,
      opts
    );
  }
  upsertWorkspaceChannel(name, request, opts) {
    return this.channelRequest(
      `/channels/${urlEncode(name)}`,
      "PUT /workspaces/:workspace/channels/:name",
      { method: "PUT", body: request },
      opts
    );
  }
  deleteWorkspaceChannel(name, request, opts) {
    return this.channelRequest(
      `/channels/${urlEncode(name)}`,
      "DELETE /workspaces/:workspace/channels/:name",
      { method: "DELETE", body: request },
      opts
    );
  }
  setWorkspaceChannelStartup(name, request, opts) {
    return this.channelRequest(
      `/channels/${urlEncode(name)}/startup`,
      "PUT /workspaces/:workspace/channels/:name/startup",
      { method: "PUT", body: request },
      opts
    );
  }
  startWorkspaceChannel(name, opts) {
    return this.channelAction(name, "start", opts);
  }
  stopWorkspaceChannel(name, opts) {
    return this.channelAction(name, "stop", opts);
  }
  restartWorkspaceChannel(name, opts) {
    return this.channelAction(name, "restart", opts);
  }
  workspaceChannelPairingRequests(name, opts) {
    return this.channelRequest(
      `/channels/${urlEncode(name)}/pairing-requests`,
      "GET /workspaces/:workspace/channels/:name/pairing-requests",
      void 0,
      opts
    );
  }
  approveWorkspaceChannelPairing(name, request, opts) {
    return this.channelRequest(
      `/channels/${urlEncode(name)}/pairing-requests/approve`,
      "POST /workspaces/:workspace/channels/:name/pairing-requests/approve",
      { method: "POST", body: request },
      opts
    );
  }
  workspaceChannelPairingApprovals(name, opts) {
    return this.channelRequest(
      `/channels/${urlEncode(name)}/pairing-approvals`,
      "GET /workspaces/:workspace/channels/:name/pairing-approvals",
      void 0,
      opts
    );
  }
  revokeWorkspaceChannelPairingApproval(name, request, opts) {
    return this.channelRequest(
      `/channels/${urlEncode(name)}/pairing-approvals`,
      "DELETE /workspaces/:workspace/channels/:name/pairing-approvals",
      { method: "DELETE", body: request },
      opts
    );
  }
  channelAction(name, action, opts) {
    return this.channelRequest(
      `/channels/${urlEncode(name)}/${action}`,
      `POST /workspaces/:workspace/channels/:name/${action}`,
      { method: "POST", body: {} },
      opts
    );
  }
  channelRequest(path, label, request, opts) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      path,
      label,
      {
        ...request ?? {},
        clientId: opts?.clientId,
        timeoutMs: opts?.timeoutMs ?? (request ? CHANNEL_CONTROL_DEFAULT_TIMEOUT_MS : void 0),
        mode: "rest"
      }
    );
  }
  initializeWorkspaceMcp() {
    return this.post(
      "/mcp/initialize",
      "POST /workspaces/:workspace/mcp/initialize",
      {}
    );
  }
  reloadWorkspaceMcp(options = {}) {
    return this.post(
      "/mcp/reload",
      "POST /workspaces/:workspace/mcp/reload",
      options
    );
  }
  workspaceVoice(clientId) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/voice",
      "GET /workspaces/:workspace/voice",
      { clientId, mode: "rest" }
    );
  }
  setWorkspaceVoice(update, clientId) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/voice",
      "POST /workspaces/:workspace/voice",
      { method: "POST", body: update, clientId, mode: "rest" }
    );
  }
  transcribeWorkspaceVoice(audio, opts) {
    return this.client.workspaceVoiceTranscriptionRequest(
      this.workspaceSelector,
      audio,
      opts
    );
  }
  liveStatus(clientId) {
    return this.client.liveStatus(clientId);
  }
  liveSetupStatus(clientId) {
    return this.client.liveSetupStatus(clientId);
  }
  updateLiveSetup(update, clientId) {
    return this.client.updateLiveSetup(update, clientId);
  }
  retryLiveHostInstall(clientId) {
    return this.client.retryLiveHostInstall(clientId);
  }
  launchLiveHost(clientId) {
    return this.client.launchLiveHost(clientId);
  }
  startLive(mode = "resume", clientId) {
    return this.client.startLive(mode, clientId);
  }
  stopLive(clientId) {
    return this.client.stopLive(clientId);
  }
  setLiveMute(update, clientId) {
    return this.client.setLiveMute(update, clientId);
  }
  setLiveShortcut(shortcut, clientId) {
    return this.client.setLiveShortcut(shortcut, clientId);
  }
  workspaceGit(opts) {
    const params = new URLSearchParams();
    if (opts?.cwd) params.set("cwd", opts.cwd);
    if (opts?.wait) params.set("wait", "1");
    const query = params.toString();
    const suffix = query ? `/git?${query}` : "/git";
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      suffix,
      "GET /workspaces/:workspace/git",
      { mode: "rest" }
    );
  }
  workspaceGitDiff(cwd) {
    const suffix = cwd != null ? `/git/diff?cwd=${urlEncode(cwd)}` : "/git/diff";
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      suffix,
      "GET /workspaces/:workspace/git/diff",
      { mode: "rest" }
    );
  }
  workspaceGitDiffFile(path, oldPath, cwd) {
    const query = `/git/diff/file?path=${urlEncode(path)}` + (oldPath != null ? `&oldPath=${urlEncode(oldPath)}` : "") + (cwd != null ? `&cwd=${urlEncode(cwd)}` : "");
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      query,
      "GET /workspaces/:workspace/git/diff/file",
      { mode: "rest" }
    );
  }
  workspaceGitLog(limit, skip, cwd, range) {
    const params = new URLSearchParams();
    if (limit != null) params.set("limit", String(limit));
    if (skip != null) params.set("skip", String(skip));
    if (cwd != null) params.set("cwd", cwd);
    if (range) params.set("range", range);
    const qs = params.toString();
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/git/log${qs ? `?${qs}` : ""}`,
      "GET /workspaces/:workspace/git/log",
      { mode: "rest" }
    );
  }
  workspaceGitCommitDetail(sha, cwd) {
    const query = `/git/log/commit?sha=${urlEncode(sha)}` + (cwd != null ? `&cwd=${urlEncode(cwd)}` : "");
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      query,
      "GET /workspaces/:workspace/git/log/commit",
      { mode: "rest" }
    );
  }
  workspaceGitBranches(cwd) {
    const suffix = cwd != null ? `/git/branches?cwd=${urlEncode(cwd)}` : "/git/branches";
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      suffix,
      "GET /workspaces/:workspace/git/branches",
      { mode: "rest" }
    );
  }
  workspaceGitCheckout(ref, cwd) {
    const suffix = cwd != null ? `/git/checkout?cwd=${urlEncode(cwd)}` : "/git/checkout";
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      suffix,
      "POST /workspaces/:workspace/git/checkout",
      { method: "POST", body: { ref }, mode: "rest" }
    );
  }
  workspaceGitCreateBranch(name, startPoint, cwd) {
    const suffix = cwd != null ? `/git/branch?cwd=${urlEncode(cwd)}` : "/git/branch";
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      suffix,
      "POST /workspaces/:workspace/git/branch",
      { method: "POST", body: { name, startPoint }, mode: "rest" }
    );
  }
  workspaceGitPush(opts, cwd) {
    const suffix = cwd != null ? `/git/push?cwd=${urlEncode(cwd)}` : "/git/push";
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      suffix,
      "POST /workspaces/:workspace/git/push",
      { method: "POST", body: opts ?? {}, mode: "rest" }
    );
  }
  workspaceGitPull(opts, cwd, timeoutMs) {
    const suffix = cwd != null ? `/git/pull?cwd=${urlEncode(cwd)}` : "/git/pull";
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      suffix,
      "POST /workspaces/:workspace/git/pull",
      { method: "POST", body: opts ?? {}, mode: "rest", timeoutMs }
    );
  }
  workspaceGitCommit(message, opts, cwd) {
    const suffix = cwd != null ? `/git/commit?cwd=${urlEncode(cwd)}` : "/git/commit";
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      suffix,
      "POST /workspaces/:workspace/git/commit",
      { method: "POST", body: { message, ...opts }, mode: "rest" }
    );
  }
  workspaceGitRemotes(cwd) {
    const suffix = cwd != null ? `/git/remotes?cwd=${urlEncode(cwd)}` : "/git/remotes";
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      suffix,
      "GET /workspaces/:workspace/git/remotes",
      { mode: "rest" }
    );
  }
  workspaceGitRemoteAdd(name, url, cwd, timeoutMs) {
    const suffix = cwd != null ? `/git/remote?cwd=${urlEncode(cwd)}` : "/git/remote";
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      suffix,
      "POST /workspaces/:workspace/git/remote",
      { method: "POST", body: { name, url }, mode: "rest", timeoutMs }
    );
  }
  workspaceGitRemoteRemove(name, cwd, timeoutMs) {
    const suffix = cwd != null ? `/git/remote/remove?cwd=${urlEncode(cwd)}` : "/git/remote/remove";
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      suffix,
      "POST /workspaces/:workspace/git/remote/remove",
      { method: "POST", body: { name }, mode: "rest", timeoutMs }
    );
  }
  workspaceGitHubPullRequests() {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/github/prs",
      "GET /workspaces/:workspace/github/prs",
      { mode: "rest" }
    );
  }
  workspaceGitHubCreatePullRequest(opts, cwd) {
    const suffix = cwd != null ? `/github/prs/create?cwd=${urlEncode(cwd)}` : "/github/prs/create";
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      suffix,
      "POST /workspaces/:workspace/github/prs/create",
      { method: "POST", body: opts, mode: "rest" }
    );
  }
  workspaceGitHubDefaultBranch() {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/github/default-branch",
      "GET /workspaces/:workspace/github/default-branch",
      { mode: "rest" }
    );
  }
  workspaceSkills() {
    return this.get("/skills", "GET /workspaces/:workspace/skills");
  }
  workspaceConfigSkills() {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/config/skills",
      "GET /workspaces/:workspace/config/skills",
      { mode: "rest" }
    );
  }
  workspaceRuntimeSkills() {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/runtime/skills",
      "GET /workspaces/:workspace/runtime/skills",
      { mode: "rest" }
    );
  }
  setWorkspaceConfigSkillEnabled(skillName, enabled, opts) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/config/skills/${urlEncode(skillName)}/enable`,
      "POST /workspaces/:workspace/config/skills/:name/enable",
      {
        method: "POST",
        body: { enabled },
        clientId: opts?.clientId,
        mode: "rest"
      }
    );
  }
  installWorkspaceConfigSkill(request) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/config/skills/install",
      "POST /workspaces/:workspace/config/skills/install",
      { method: "POST", body: request, mode: "rest" }
    );
  }
  deleteWorkspaceConfigSkill(skillName, scope) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/config/skills/${urlEncode(skillName)}?scope=${scope}`,
      "DELETE /workspaces/:workspace/config/skills/:name",
      { method: "DELETE", mode: "rest" }
    );
  }
  workspaceProviders() {
    return this.get("/providers", "GET /workspaces/:workspace/providers");
  }
  workspaceHooks() {
    return this.get("/hooks", "GET /workspaces/:workspace/hooks");
  }
  workspaceEnv() {
    return this.get("/env", "GET /workspaces/:workspace/env");
  }
  workspacePreflight() {
    return this.get("/preflight", "GET /workspaces/:workspace/preflight");
  }
  workspaceTools() {
    return this.get("/tools", "GET /workspaces/:workspace/tools");
  }
  workspaceMemory() {
    return this.get("/memory", "GET /workspaces/:workspace/memory");
  }
  remove(options) {
    const body = options?.force === void 0 ? void 0 : {
      force: options.force
    };
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "",
      "DELETE /workspaces/:workspace",
      {
        method: "DELETE",
        ...body ? { body } : {},
        ...options?.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
        mode: "rest"
      }
    );
  }
  writeWorkspaceMemory(req, clientId) {
    return this.post(
      "/memory",
      "POST /workspaces/:workspace/memory",
      { ...req, scope: "workspace" },
      clientId
    );
  }
  listWorkspaceAgents() {
    return this.get("/agents", "GET /workspaces/:workspace/agents");
  }
  createWorkspaceAgent(req, clientId) {
    return this.post(
      "/agents",
      "POST /workspaces/:workspace/agents",
      { ...req, scope: req.scope ?? "workspace" },
      clientId
    );
  }
  getWorkspaceAgent(agentType) {
    return this.get(
      `/agents/${urlEncode(agentType)}`,
      "GET /workspaces/:workspace/agents/:agentType"
    );
  }
  updateWorkspaceAgent(agentType, req, opts = {}) {
    const query = opts.scope ? `?scope=${urlEncode(opts.scope)}` : "";
    return this.post(
      `/agents/${urlEncode(agentType)}${query}`,
      "POST /workspaces/:workspace/agents/:agentType",
      req,
      opts.clientId
    );
  }
  async deleteWorkspaceAgent(agentType, opts = {}) {
    const query = opts.scope ? `?scope=${urlEncode(opts.scope)}` : "";
    return await this.client.workspaceNoContentRequest(
      this.workspaceSelector,
      `/agents/${urlEncode(agentType)}${query}`,
      "DELETE /workspaces/:workspace/agents/:agentType",
      {
        method: "DELETE",
        clientId: opts.clientId,
        okNotFoundCode: "agent_not_found"
      }
    );
  }
  async listWorkspaceSessionsPage(options) {
    if (options?.sourceType !== void 0 || options?.sourceId !== void 0) {
      await this.client.requireCapability("session_source_metadata");
    }
    const requestedPageSize = options?.pageSize ?? DEFAULT_SESSION_LIST_PAGE_SIZE;
    const pageSize = Math.max(
      1,
      Math.min(
        1e3,
        Math.round(
          Number.isFinite(requestedPageSize) ? requestedPageSize : DEFAULT_SESSION_LIST_PAGE_SIZE
        )
      )
    );
    const query = new URLSearchParams({ size: String(pageSize) });
    if (options?.cursor !== void 0) query.set("cursor", options.cursor);
    if (options?.archiveState !== void 0) {
      query.set("archiveState", options.archiveState);
    }
    if (options?.view !== void 0) query.set("view", options.view);
    if (options?.group !== void 0) query.set("group", options.group);
    if (options?.parentSessionId !== void 0) {
      query.set("parentSessionId", options.parentSessionId);
    }
    if (options?.sourceType !== void 0) {
      query.set("sourceType", options.sourceType);
    }
    if (options?.sourceId !== void 0) {
      query.set("sourceId", options.sourceId);
    }
    return await this.get(
      `/sessions?${query.toString()}`,
      "GET /workspaces/:workspace/sessions"
    );
  }
  async listWorkspaceSessions(options) {
    const page = await this.listWorkspaceSessionsPage(options);
    return page.sessions;
  }
  getWorkspaceSessionInfo() {
    return this.get("/session-info", "GET /workspaces/:workspace/session-info");
  }
  /**
   * Read the memory-only live-state snapshot for this workspace: the
   * complete set of live sessions with volatile state plus the in-memory
   * catalog version equality token. Always uses native REST transport
   * (never the pluggable ACP transport).
   *
   * This method deliberately does not pre-flight
   * `requireCapability('workspace_session_live_state')` — a capability
   * probe on every poll would double request volume. Consumers preflight
   * the capability once from their already-loaded capabilities and fall
   * back to the full session catalog when it is absent.
   */
  getSessionLiveState(opts = {}) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/sessions/live-state",
      "GET /workspaces/:workspace/sessions/live-state",
      { clientId: opts.clientId, timeoutMs: opts.timeoutMs, mode: "rest" }
    );
  }
  /**
   * Read one page from an active persisted session transcript in this
   * workspace.
   * The daemon performs replay locally without attaching to the session or
   * starting ACP. This method always uses native REST transport.
   */
  getSessionTranscriptPage(sessionId, opts = {}) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/session/${urlEncode(sessionId)}/transcript${transcriptPageSuffix(opts)}`,
      "GET /workspaces/:workspace/session/:id/transcript",
      { clientId: opts.clientId, mode: "rest" }
    );
  }
  /** Read one sparse page of persisted navigation turns in this workspace. */
  getSessionTurnIndexPage(sessionId, opts = {}) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/session/${urlEncode(sessionId)}/turn-index${turnIndexPageSuffix(opts)}`,
      "GET /workspaces/:workspace/session/:id/turn-index",
      { clientId: opts.clientId, mode: "rest" }
    );
  }
  /** Export an active persisted session from this registered workspace. */
  exportSession(sessionId, opts = {}) {
    return this.client.sessionExportRequest(
      `/workspaces/${this.workspaceSelector}/session/${urlEncode(sessionId)}/export`,
      "GET /workspaces/:workspace/session/:id/export",
      opts
    );
  }
  /** Export an archived persisted session from this registered workspace. */
  exportArchivedSession(sessionId, opts = {}) {
    return this.client.sessionExportRequest(
      `/workspaces/${this.workspaceSelector}/session/${urlEncode(sessionId)}/archive/export`,
      "GET /workspaces/:workspace/session/:id/archive/export",
      opts
    );
  }
  updateSessionMetadata(sessionId, metadata, clientId) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/session/${urlEncode(sessionId)}/metadata`,
      "PATCH /workspaces/:workspace/session/:id/metadata",
      { method: "PATCH", body: metadata, clientId, mode: "rest" }
    );
  }
  listSessionGroups() {
    return this.get(
      "/session-groups",
      "GET /workspaces/:workspace/session-groups"
    );
  }
  async createSessionGroup(input) {
    const body = await this.post(
      "/session-groups",
      "POST /workspaces/:workspace/session-groups",
      input
    );
    return body.group;
  }
  async updateSessionGroup(groupId, update) {
    const body = await this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/session-groups/${urlEncode(groupId)}`,
      "PATCH /workspaces/:workspace/session-groups/:groupId",
      { method: "PATCH", body: update }
    );
    return body.group;
  }
  deleteSessionGroup(groupId) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/session-groups/${urlEncode(groupId)}`,
      "DELETE /workspaces/:workspace/session-groups/:groupId",
      { method: "DELETE" }
    );
  }
  updateSessionOrganization(sessionId, update, clientId) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/session/${urlEncode(sessionId)}/organization`,
      "PATCH /workspaces/:workspace/session/:id/organization",
      { method: "PATCH", body: update, clientId }
    );
  }
  deleteSessionsData(sessionIds, clientId) {
    return this.post(
      "/sessions/delete",
      "POST /workspaces/:workspace/sessions/delete",
      { sessionIds },
      clientId
    );
  }
  archiveSessionsData(sessionIds, clientIdOrOptions, clientId) {
    const options = typeof clientIdOrOptions === "object" ? clientIdOrOptions : void 0;
    return this.post(
      "/sessions/archive",
      "POST /workspaces/:workspace/sessions/archive",
      {
        sessionIds,
        ...options?.resolveConflicts !== void 0 ? { resolveConflicts: options.resolveConflicts } : {}
      },
      typeof clientIdOrOptions === "string" ? clientIdOrOptions : clientId
    );
  }
  unarchiveSessionsData(sessionIds, clientIdOrOptions, clientId) {
    const options = typeof clientIdOrOptions === "object" ? clientIdOrOptions : void 0;
    return this.post(
      "/sessions/unarchive",
      "POST /workspaces/:workspace/sessions/unarchive",
      {
        sessionIds,
        ...options?.resolveConflicts !== void 0 ? { resolveConflicts: options.resolveConflicts } : {}
      },
      typeof clientIdOrOptions === "string" ? clientIdOrOptions : clientId
    );
  }
  readWorkspaceFile(filePath, opts = {}, clientId) {
    const query = new URLSearchParams({ path: filePath });
    if (opts.maxBytes !== void 0)
      query.set("maxBytes", String(opts.maxBytes));
    if (opts.line !== void 0) query.set("line", String(opts.line));
    if (opts.limit !== void 0) query.set("limit", String(opts.limit));
    if (opts.cursor !== void 0) query.set("cursor", opts.cursor);
    return this.get(
      `/file?${query.toString()}`,
      "GET /workspaces/:workspace/file",
      clientId
    );
  }
  readWorkspaceFileBytes(filePath, opts = {}, clientId) {
    const query = new URLSearchParams({ path: filePath });
    if (opts.offset !== void 0) query.set("offset", String(opts.offset));
    if (opts.maxBytes !== void 0)
      query.set("maxBytes", String(opts.maxBytes));
    return this.get(
      `/file/bytes?${query.toString()}`,
      "GET /workspaces/:workspace/file/bytes",
      clientId
    );
  }
  fileStat(filePath) {
    const query = new URLSearchParams({ path: filePath });
    return this.get(
      `/stat?${query.toString()}`,
      "GET /workspaces/:workspace/stat"
    );
  }
  dirList(dirPath) {
    const query = new URLSearchParams({ path: dirPath });
    return this.get(
      `/list?${query.toString()}`,
      "GET /workspaces/:workspace/list"
    );
  }
  glob(pattern, opts = {}) {
    const query = new URLSearchParams({ pattern });
    if (opts.maxResults !== void 0) {
      query.set("maxResults", String(opts.maxResults));
    }
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/glob?${query.toString()}`,
      "GET /workspaces/:workspace/glob",
      { signal: opts.signal }
    );
  }
  writeWorkspaceFile(req, clientId) {
    return this.post(
      "/file/write",
      "POST /workspaces/:workspace/file/write",
      req,
      clientId
    );
  }
  editWorkspaceFile(req, clientId) {
    return this.post(
      "/file/edit",
      "POST /workspaces/:workspace/file/edit",
      req,
      clientId
    );
  }
  uploadWorkspaceFile(req, clientId) {
    return this.client.uploadFileToPath(
      `/workspaces/${this.workspaceSelector}/file/upload`,
      "POST /workspaces/:workspace/file/upload",
      req,
      clientId
    );
  }
  workspaceSettings(opts) {
    return this.get(
      "/settings",
      "GET /workspaces/:workspace/settings",
      opts?.clientId
    );
  }
  setWorkspaceSetting(scope, key, value, opts) {
    return this.post(
      "/settings",
      "POST /workspaces/:workspace/settings",
      {
        scope,
        key,
        value,
        ...opts?.mcpServerMutation ? { mcpServerMutation: opts.mcpServerMutation } : {}
      },
      opts?.clientId
    );
  }
  workspaceTrust(opts) {
    return this.get(
      opts?.statusVersion === 2 ? "/trust?statusVersion=2" : "/trust",
      "GET /workspaces/:workspace/trust",
      opts?.clientId
    );
  }
  requestWorkspaceTrustChange(request, clientId) {
    return this.post(
      "/trust/request",
      "POST /workspaces/:workspace/trust/request",
      request,
      clientId
    );
  }
  workspacePermissions(opts) {
    return this.get(
      "/permissions",
      "GET /workspaces/:workspace/permissions",
      opts?.clientId
    );
  }
  setWorkspacePermissionRules(ruleType, rules, opts) {
    return this.post(
      "/permissions",
      "POST /workspaces/:workspace/permissions",
      { scope: "workspace", ruleType, rules: [...rules] },
      opts?.clientId
    );
  }
  setWorkspaceToolEnabled(toolName, enabled, opts) {
    return this.post(
      `/tools/${urlEncode(toolName)}/enable`,
      "POST /workspaces/:workspace/tools/:name/enable",
      { enabled },
      opts?.clientId
    );
  }
  setWorkspaceSkillEnabled(skillName, enabled, opts) {
    return this.post(
      `/skills/${urlEncode(skillName)}/enable`,
      "POST /workspaces/:workspace/skills/:name/enable",
      { enabled },
      opts?.clientId
    );
  }
  setWorkspaceSkillsEnabled(skillNames, enabled, opts) {
    return this.post(
      "/skills/enable",
      "POST /workspaces/:workspace/skills/enable",
      { skillNames, enabled },
      opts?.clientId
    );
  }
  restartMcpServer(serverName, opts) {
    const query = opts?.entryIndex === void 0 ? "" : `?entryIndex=${urlEncode(String(opts.entryIndex))}`;
    return this.post(
      `/mcp/${urlEncode(serverName)}/restart${query}`,
      "POST /workspaces/:workspace/mcp/:server/restart",
      {},
      opts?.clientId,
      opts?.timeoutMs ?? MCP_RESTART_DEFAULT_TIMEOUT_MS
    );
  }
  reload(opts) {
    return this.post(
      "/reload",
      "POST /workspaces/:workspace/reload",
      {},
      opts?.clientId,
      opts?.timeoutMs
    );
  }
  initWorkspace(opts) {
    return this.post(
      "/init",
      "POST /workspaces/:workspace/init",
      opts?.force === true ? { force: true } : {},
      opts?.clientId
    );
  }
  workspaceExtensions() {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/extensions",
      "GET /workspaces/:workspace/extensions",
      { mode: "rest" }
    );
  }
  extensionState(extensionId) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/extensions/${urlEncode(extensionId)}/state`,
      "GET /workspaces/:workspace/extensions/:extensionId/state",
      { mode: "rest" }
    );
  }
  setExtensionState(extensionId, update, clientId) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/extensions/${urlEncode(extensionId)}/state`,
      "PUT /workspaces/:workspace/extensions/:extensionId/state",
      { method: "PUT", body: update, clientId, mode: "rest" }
    );
  }
  setExtensionActivation(extensionId, state, clientId) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/extensions/${urlEncode(extensionId)}/activation`,
      "PUT /workspaces/:workspace/extensions/:extensionId/activation",
      { method: "PUT", body: { state }, clientId, mode: "rest" }
    );
  }
  setExtensionActivations(extensionNames, state, clientId) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/extensions/activation",
      "PUT /workspaces/:workspace/extensions/activation",
      {
        method: "PUT",
        body: { extensionNames: [...extensionNames], state },
        clientId,
        mode: "rest"
      }
    );
  }
  clearExtensionActivation(extensionId, clientId) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      `/extensions/${urlEncode(extensionId)}/activation`,
      "DELETE /workspaces/:workspace/extensions/:extensionId/activation",
      { method: "DELETE", clientId, mode: "rest" }
    );
  }
  refreshExtensionRuntime(clientId) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      "/extensions/refresh",
      "POST /workspaces/:workspace/extensions/refresh",
      { method: "POST", body: {}, clientId, mode: "rest" }
    );
  }
  get(path, label, clientId) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      path,
      label,
      { clientId }
    );
  }
  post(path, label, body, clientId, timeoutMs) {
    return this.client.workspaceJsonRequest(
      this.workspaceSelector,
      path,
      label,
      { method: "POST", body, clientId, timeoutMs }
    );
  }
};
function composeAbortSignals2(signals) {
  const anyFn = AbortSignal.any;
  if (typeof anyFn === "function") return anyFn.call(AbortSignal, signals);
  const ctrl = new AbortController();
  const cleanups = [];
  const detachAll = /* @__PURE__ */ __name(() => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        fn?.();
      } catch {
      }
    }
  }, "detachAll");
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      detachAll();
      return ctrl.signal;
    }
    const onAbort = /* @__PURE__ */ __name(() => {
      ctrl.abort(s.reason);
      detachAll();
    }, "onAbort");
    s.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => s.removeEventListener("abort", onAbort));
  }
  ctrl.signal.addEventListener("abort", detachAll, { once: true });
  return ctrl.signal;
}
__name(composeAbortSignals2, "composeAbortSignals");
function matchTurnEvent(event, promptId) {
  if (event.type === "turn_complete") {
    const data = event.data;
    if (data.promptId === promptId) {
      const stopReason = data.stopReason ?? "end_turn";
      const candidate = data.branchPoint;
      const recordUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const branchPoint = stopReason === "end_turn" && typeof candidate?.assistantRecordUuid === "string" && recordUuidPattern.test(candidate.assistantRecordUuid) && typeof candidate.checkpointUuid === "string" && recordUuidPattern.test(candidate.checkpointUuid) ? {
        assistantRecordUuid: candidate.assistantRecordUuid,
        checkpointUuid: candidate.checkpointUuid
      } : void 0;
      return {
        stopReason,
        ...branchPoint ? { branchPoint } : {}
      };
    }
  }
  if (event.type === "turn_error") {
    const data = event.data;
    if (data.promptId === promptId) {
      throw Object.assign(
        new DaemonHttpError(
          500,
          data.code ?? "turn_error",
          data.message ?? "Prompt failed"
        ),
        { _daemonTurnError: true }
      );
    }
  }
  return void 0;
}
__name(matchTurnEvent, "matchTurnEvent");
function isNonBlockingAccepted(result) {
  return "promptId" in result && "lastEventId" in result;
}
__name(isNonBlockingAccepted, "isNonBlockingAccepted");

// packages/sdk-typescript/src/daemon/pwa-assets.ts
init_esbuild_shims();
var WEB_SHELL_PWA_ASSETS = [
  {
    route: "/manifest.webmanifest",
    contentType: "application/manifest+json",
    serviceWorkerAllowed: false
  },
  {
    route: "/sw.js",
    contentType: "application/javascript",
    serviceWorkerAllowed: true
  }
];
var WEB_SHELL_SERVICE_WORKER_ROUTE = WEB_SHELL_PWA_ASSETS.find(
  ({ serviceWorkerAllowed }) => serviceWorkerAllowed
).route;

// packages/sdk-typescript/src/daemon/DaemonSessionClient.ts
init_esbuild_shims();
function isSessionAttachmentReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value;
  return (record["type"] === "image" || record["type"] === "resource") && typeof record["attachmentId"] === "string" && record["attachmentId"].length > 0 && typeof record["mimeType"] === "string" && record["mimeType"].length > 0 && (record["type"] !== "image" || record["mimeType"].startsWith("image/")) && typeof record["size"] === "number" && Number.isSafeInteger(record["size"]) && record["size"] >= 0 && (record["type"] !== "image" || record["size"] > 0);
}
__name(isSessionAttachmentReference, "isSessionAttachmentReference");
var MAX_ATTACHMENT_CACHE_BYTES = 32 * 1024 * 1024;
var MAX_ATTACHMENT_CACHE_ENTRIES = 128;
function createStandaloneRestoredClient(client, restored, includeReplay) {
  const {
    state,
    hasActivePrompt,
    compactedReplay,
    liveJournal,
    historyHasMore,
    historyAnchorRecordId,
    replayDegraded,
    partial,
    replayError,
    lastEventId,
    eventEpoch,
    ...session
  } = restored;
  return new DaemonSessionClient({
    client,
    session,
    hasActivePrompt,
    state,
    lastEventId: lastEventId ?? 0,
    eventEpoch,
    ...includeReplay ? {
      replaySnapshot: {
        compactedReplay: compactedReplay ?? [],
        liveJournal: liveJournal ?? []
      },
      replaySnapshotComplete: Array.isArray(compactedReplay) && Array.isArray(liveJournal),
      replayPartial: partial === true,
      replayError,
      historyHasMore,
      historyAnchorRecordId,
      replayDegraded
    } : {}
  });
}
__name(createStandaloneRestoredClient, "createStandaloneRestoredClient");
var DaemonSessionClient = class _DaemonSessionClient {
  static {
    __name(this, "DaemonSessionClient");
  }
  client;
  session;
  restoreStrategy;
  state;
  /**
   * Not `readonly`: {@link consumeReplaySnapshot} swaps it for an empty
   * snapshot once the provider has injected it into the transcript store,
   * releasing the raw wire events (tens of MiB on busy sessions) instead of
   * retaining them for the session client's lifetime.
   */
  replaySnapshot;
  replaySnapshotComplete;
  replayPartial;
  replayError;
  hasActivePrompt;
  backgroundTurn;
  hasRunningBackgroundTasks;
  historyHasMore;
  /**
   * Fallback pagination anchor from the daemon load response (see
   * {@link DaemonSessionClientOptions.historyAnchorRecordId}). Undefined
   * when the retained window already carries a recordId or the daemon
   * could not read one from the persisted transcript.
   */
  historyAnchorRecordId;
  /**
   * True when the load response flagged the replay snapshot as degraded
   * (`replayDegraded` — compaction failed at least once, so
   * `replaySnapshot` may lag behind live events). Prefer the full
   * transcript (see `fullTranscriptAvailable`) when set.
   */
  replayDegraded;
  lastSeenEventId;
  /**
   * Epoch token paired with {@link lastSeenEventId}. Seeded from the
   * load/resume/create response when available, refreshed from every
   * subscription's `X-Qwen-Event-Epoch` response header.
   */
  lastSeenEpoch;
  hasAcceptedRestStream = false;
  lastAcceptedRestStreamId;
  subscriptionActive = false;
  /** In-flight `reattach()` so concurrent prompts re-register only once. */
  reattaching;
  cancelling;
  promptLimit;
  attachmentCache = /* @__PURE__ */ new Map();
  attachmentCacheBytes = 0;
  _pendingPrompts = /* @__PURE__ */ new Map();
  constructor(opts) {
    this.client = opts.client;
    this.session = { ...opts.session };
    const context = opts.session.context;
    this.restoreStrategy = opts.session.sourceType === "standalone" && context?.kind === "standalone" ? { kind: "standalone" } : { kind: "workspace", workspaceCwd: opts.session.workspaceCwd };
    this.state = { ...opts.state ?? {} };
    this.hasActivePrompt = opts.hasActivePrompt ?? false;
    this.backgroundTurn = parseDaemonBackgroundTurn(
      opts.session.backgroundTurn
    );
    this.hasRunningBackgroundTasks = opts.session.hasRunningBackgroundTasks;
    this.historyHasMore = opts.historyHasMore ?? false;
    this.historyAnchorRecordId = opts.historyAnchorRecordId;
    this.replayDegraded = opts.replayDegraded ?? false;
    this.replaySnapshot = opts.replaySnapshot ?? {
      compactedReplay: [],
      liveJournal: []
    };
    this.replaySnapshotComplete = opts.replaySnapshotComplete ?? false;
    this.replayPartial = opts.replayPartial ?? false;
    this.replayError = opts.replayError;
    this.lastSeenEventId = validateLastEventId(opts.lastEventId);
    this.lastSeenEpoch = opts.eventEpoch;
    this.promptLimit = opts.maxPendingPromptsPerSession === void 0 ? opts.client.maxPendingPromptsPerSession : normalizePendingPromptLimit(opts.maxPendingPromptsPerSession);
  }
  /**
   * Creates a new daemon session or attaches to an existing matching session.
   */
  static async createOrAttach(client, req = {}, clientId) {
    const session = await client.createOrAttachSession(req, clientId);
    const lastEventId = !session.attached || req.modelServiceId || req.approvalMode ? 0 : void 0;
    return new _DaemonSessionClient({
      client,
      session,
      hasActivePrompt: session.hasActivePrompt,
      lastEventId,
      // Newer daemons may stamp the bus epoch on the create/attach
      // response; older ones don't — the first subscription then learns it
      // from the `X-Qwen-Event-Epoch` response header.
      eventEpoch: session.eventEpoch
    });
  }
  /**
   * Loads an existing daemon session and seeds the first event subscription
   * from the start of the daemon replay ring so history replay frames emitted
   * during `session/load` are visible to this client.
   */
  static async load(client, sessionId, req = {}, clientId) {
    const restored = await client.loadSession(sessionId, req, clientId);
    const replaySnapshotComplete = Array.isArray(restored.compactedReplay) && Array.isArray(restored.liveJournal);
    const {
      state,
      hasActivePrompt,
      compactedReplay,
      liveJournal,
      historyHasMore,
      historyAnchorRecordId,
      replayDegraded,
      partial,
      replayError,
      lastEventId: serverLastEventId,
      eventEpoch,
      ...session
    } = restored;
    const result = new _DaemonSessionClient({
      client,
      session,
      hasActivePrompt,
      state,
      lastEventId: serverLastEventId ?? 0,
      eventEpoch,
      replaySnapshot: {
        compactedReplay: compactedReplay ?? [],
        liveJournal: liveJournal ?? []
      },
      replaySnapshotComplete,
      replayPartial: partial === true,
      replayError,
      historyHasMore,
      historyAnchorRecordId,
      replayDegraded
    });
    await result.hydrateReplaySnapshot();
    return result;
  }
  /**
   * Resumes an existing daemon session without requesting history replay.
   * When the daemon returns a watermark (`lastEventId`), uses it as the
   * initial SSE cursor. Falls back to 0 for older daemons so
   * post-resume events (e.g. `available_commands_update`) are captured.
   */
  static async resume(client, sessionId, req = {}, clientId) {
    const {
      state,
      hasActivePrompt,
      lastEventId: serverLastEventId,
      eventEpoch,
      ...session
    } = await client.resumeSession(sessionId, req, clientId);
    return new _DaemonSessionClient({
      client,
      session,
      hasActivePrompt,
      state,
      lastEventId: serverLastEventId ?? 0,
      eventEpoch
    });
  }
  /**
   * Transfer a worktree session's checkout ownership to a fresh replacement
   * session and return a client bound to the replacement's identity. That
   * client carries whatever `clientId` the response had: a fresh transfer
   * mints and registers an owner-style one for the spawn it performs, while
   * an idempotent resume of a committed transfer returns none. The
   * registration is not an attachment (the replacement's attach count is
   * unaffected), but it is a client registration, and a non-empty one is what
   * holds the daemon's idle cleanup off — so detach a minted id you do not
   * keep using, or the replacement stays live indefinitely. A registered
   * attachment still requires the normal restore surface: load or resume the
   * replacement, passing the minted id to reuse that registration instead of
   * adding a second one. The replacement is a brand-new conversation; the
   * superseded session keeps its transcript on the daemon and is never
   * restored again (its restore surfaces `worktree_session_superseded`). The
   * existing reattach identity guard applies to the replacement client
   * unchanged.
   */
  static async resetWorktree(client, sessionId, req = {}) {
    const session = await client.resetWorktreeSession(sessionId, req);
    return new _DaemonSessionClient({
      client,
      session,
      hasActivePrompt: session.hasActivePrompt,
      // The replacement is freshly created: seed from the start of its bus
      // so events fired during the transfer window are not skipped.
      lastEventId: 0,
      eventEpoch: session.eventEpoch
    });
  }
  static async createStandalone(client, options = {}) {
    const session = await client.createStandaloneSession(options);
    return new _DaemonSessionClient({
      client,
      session,
      hasActivePrompt: session.hasActivePrompt,
      lastEventId: 0,
      eventEpoch: session.eventEpoch
    });
  }
  static async loadStandalone(client, sessionId, request = {}, clientId) {
    const restored = await client.loadStandaloneSession(
      sessionId,
      request,
      clientId
    );
    const result = createStandaloneRestoredClient(client, restored, true);
    await result.hydrateReplaySnapshot();
    return result;
  }
  static async resumeStandalone(client, sessionId, request = {}, clientId) {
    const restored = await client.resumeStandaloneSession(
      sessionId,
      request,
      clientId
    );
    return createStandaloneRestoredClient(client, restored, false);
  }
  get sessionId() {
    return this.session.sessionId;
  }
  get workspaceCwd() {
    return this.session.workspaceCwd;
  }
  get attached() {
    return this.session.attached;
  }
  get clientId() {
    return this.session.clientId;
  }
  get worktree() {
    return this.session.worktree;
  }
  get worktreeState() {
    return this.session.worktreeState;
  }
  get branch() {
    return this.session.branch;
  }
  /**
   * Present when this client was created with a `modelServiceId`: `false`
   * means the spawn-time model switch failed and the session is running on
   * the agent default model.
   */
  get modelApplied() {
    return this.session.modelApplied;
  }
  get lastEventId() {
    return this.lastSeenEventId;
  }
  get eventEpoch() {
    return this.lastSeenEpoch;
  }
  /**
   * Returns the retained replay snapshot and drops the client's reference
   * to it. Call once the snapshot has been injected into a transcript
   * store; the raw wire events are no longer needed (SSE continues from
   * `lastEventId`, and older history is served by pagination) and can
   * otherwise pin tens of MiB per session client.
   */
  consumeReplaySnapshot() {
    const snapshot = this.replaySnapshot;
    this.replaySnapshot = { compactedReplay: [], liveJournal: [] };
    return snapshot;
  }
  setLastEventId(lastEventId) {
    this.lastSeenEventId = validateLastEventId(lastEventId);
  }
  async prompt(req, signal) {
    signal?.throwIfAborted();
    if (!this.subscriptionActive) {
      return await this.withClientIdSelfHeal(
        () => this.client.prompt(this.sessionId, req, signal, this.clientId)
      );
    }
    const releaseAdmission = this.client.reservePromptSlot(
      this.sessionId,
      this.promptLimit
    );
    let accepted;
    try {
      accepted = await this.withClientIdSelfHeal(
        () => this.client.promptNonBlocking(
          this.sessionId,
          req,
          signal,
          this.clientId
        )
      );
      if (!isNonBlockingAccepted(accepted)) {
        releaseAdmission();
        return accepted;
      }
      if (!this.subscriptionActive) {
        throw Error("SSE stream ended");
      }
    } catch (err) {
      releaseAdmission();
      throw err;
    }
    return new Promise((resolve, reject) => {
      const onAbort = /* @__PURE__ */ __name(() => {
        const pending = this._pendingPrompts.get(accepted.promptId);
        if (pending && this._pendingPrompts.delete(accepted.promptId)) {
          this.cancel().catch(() => {
          });
          pending.reject(
            signal.reason ?? new DOMException("Aborted", "AbortError")
          );
        }
      }, "onAbort");
      const cleanup = /* @__PURE__ */ __name(() => signal?.removeEventListener("abort", onAbort), "cleanup");
      this._pendingPrompts.set(accepted.promptId, {
        resolve: /* @__PURE__ */ __name((r) => {
          cleanup();
          releaseAdmission();
          resolve(r);
        }, "resolve"),
        reject: /* @__PURE__ */ __name((e) => {
          cleanup();
          releaseAdmission();
          reject(e);
        }, "reject")
      });
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  /**
   * Submit a prompt and return as soon as the daemon accepts it.
   *
   * This is admission-only: it does not reserve a client-side prompt slot,
   * register the prompt in `_pendingPrompts`, or wait for the matching
   * `turn_complete` / `turn_error` SSE event. Callers that need final turn
   * results should use `prompt()` or manage SSE terminal events themselves.
   */
  async submitPrompt(req, signal) {
    signal?.throwIfAborted();
    const accepted = await this.withClientIdSelfHeal(
      () => this.client.promptNonBlocking(this.sessionId, req, signal, this.clientId)
    );
    if (!isNonBlockingAccepted(accepted)) {
      throw new Error("Expected non-blocking prompt acceptance");
    }
    return accepted;
  }
  /** Return continuation admission; terminal results arrive on the event stream. */
  async continueSession(signal) {
    signal?.throwIfAborted();
    return await this.withClientIdSelfHeal(
      () => this.client.continueSession(this.sessionId, {
        clientId: this.clientId,
        signal
      })
    );
  }
  async uploadAttachment(data, name, mimeType, signal) {
    return await this.withClientIdSelfHeal(
      () => this.client.uploadSessionAttachment(
        this.sessionId,
        data,
        name,
        mimeType,
        {
          ...signal ? { signal } : {},
          ...this.clientId ? { clientId: this.clientId } : {}
        }
      )
    );
  }
  async readAttachment(attachmentId, signal) {
    return await this.withClientIdSelfHeal(
      () => this.client.readSessionAttachment(this.sessionId, attachmentId, {
        ...signal ? { signal } : {},
        ...this.clientId ? { clientId: this.clientId } : {}
      })
    );
  }
  async listAttachments(signal) {
    return await this.withClientIdSelfHeal(
      () => this.client.listSessionAttachments(this.sessionId, {
        ...signal ? { signal } : {},
        ...this.clientId ? { clientId: this.clientId } : {}
      })
    );
  }
  async removeAttachment(attachmentId, signal) {
    const removed = await this.withClientIdSelfHeal(
      () => this.client.removeSessionAttachment(this.sessionId, attachmentId, {
        ...signal ? { signal } : {},
        ...this.clientId ? { clientId: this.clientId } : {}
      })
    );
    if (removed) {
      const cached = this.attachmentCache.get(attachmentId);
      this.attachmentCache.delete(attachmentId);
      this.attachmentCacheBytes -= cached?.size ?? 0;
    }
    return removed;
  }
  /**
   * Run a prompt-admission call, recovering from a stale `clientId`.
   *
   * A daemon restart (or session reload) wipes the daemon's in-memory client
   * registration, so a prompt sent with our now-unknown `clientId` is rejected
   * at admission with `400 invalid_client_id` (see PR #5784). That rejection
   * happens before the turn is registered, so the prompt never ran — retrying
   * cannot double-execute. We re-register to obtain a fresh `clientId` and
   * retry the admission exactly once. Any other error (and a second
   * `invalid_client_id`) propagates.
   */
  async withClientIdSelfHeal(fn) {
    try {
      return await fn();
    } catch (err) {
      if (!isInvalidClientId(err)) throw err;
      await this.reattach();
      return await fn();
    }
  }
  /**
   * Re-register this client against the (already-restored) session to obtain a
   * fresh daemon-assigned `clientId`. Concurrent callers coalesce onto a single
   * in-flight `resume` so we never orphan extra registrations.
   */
  async reattach() {
    if (this.reattaching) return this.reattaching;
    const resume = this.restoreStrategy.kind === "standalone" ? this.client.resumeStandaloneSession(this.sessionId) : this.client.resumeSession(this.sessionId, {
      workspaceCwd: this.restoreStrategy.workspaceCwd
    });
    this.reattaching = resume.then(async (session) => {
      if (this.session.worktreeState === "persisted-v1") {
        if (!session.worktree) {
          this.session.worktree = void 0;
          this.session.worktreeState = void 0;
        } else {
          const sameWorktree = session.worktreeState === "persisted-v1" && session.worktree.path === this.session.worktree?.path;
          if (!sameWorktree) {
            await this.client.detachSession(session.sessionId, session.clientId).catch(() => {
            });
            throw new Error(
              `Daemon lost durable worktree identity for session ${this.sessionId}`
            );
          }
          this.session.worktree = session.worktree;
          this.session.worktreeState = session.worktreeState;
        }
      }
      this.session.clientId = session.clientId;
    });
    try {
      await this.reattaching;
    } finally {
      this.reattaching = void 0;
    }
  }
  async cancel() {
    const cancelling = this.cancelling ?? this.client.cancel(this.sessionId, this.clientId);
    this.cancelling = cancelling;
    try {
      await cancelling;
    } finally {
      if (this.cancelling === cancelling) {
        this.cancelling = void 0;
      }
    }
  }
  /**
   * Bump the daemon's last-seen bookkeeping for this session. Adapters
   * with a long-lived view of a session (TUI/IDE/web) can fire this on
   * an interval to keep diagnostics fresh and feed future revocation
   * policy. Forwards the bound `clientId` so identified clients update
   * their per-client timestamp instead of just the session-wide one.
   */
  heartbeat() {
    return this.client.heartbeat(this.sessionId, this.clientId);
  }
  listSources() {
    return this.client.listSessionSources(this.sessionId, this.clientId);
  }
  upsertSource(source) {
    return this.client.upsertSessionSource(
      this.sessionId,
      source,
      this.clientId
    );
  }
  removeSource(sourceId) {
    return this.client.removeSessionSource(
      this.sessionId,
      sourceId,
      this.clientId
    );
  }
  artifacts() {
    return this.client.listSessionArtifacts(this.sessionId, this.clientId);
  }
  addArtifact(artifact) {
    return this.client.addSessionArtifact(
      this.sessionId,
      artifact,
      this.clientId
    );
  }
  removeArtifact(artifactId) {
    return this.client.removeSessionArtifact(
      this.sessionId,
      artifactId,
      this.clientId
    );
  }
  setModel(modelId) {
    return this.client.setSessionModel(this.sessionId, modelId, this.clientId);
  }
  setConfigOption(configId, value, opts) {
    return this.client.setSessionConfigOption(this.sessionId, configId, value, {
      clientId: this.clientId,
      persist: opts?.persist
    });
  }
  getRewindSnapshots() {
    return this.client.getRewindSnapshots(this.sessionId);
  }
  rewind(promptId, opts) {
    return this.client.rewindSession(this.sessionId, promptId, {
      clientId: this.clientId,
      ...opts?.rewindFiles !== void 0 ? { rewindFiles: opts.rewindFiles } : {}
    });
  }
  fork(directive) {
    return this.client.forkSession(
      this.sessionId,
      { directive },
      this.clientId
    );
  }
  /**
   * One-sentence "where did I leave off" recap of this session. See
   * `DaemonClient.recapSession` for the full contract: best-effort
   * (may return `recap: null`); the optional `signal` aborts only the
   * local HTTP fetch — the daemon-side wait + the LLM call in the ACP
   * child both run to completion regardless (no cross-process abort
   * plumbing in v1).
   */
  recap(opts) {
    return this.client.recapSession(this.sessionId, {
      ...opts?.signal ? { signal: opts.signal } : {},
      ...this.clientId ? { clientId: this.clientId } : {}
    });
  }
  generateContent(prompt, opts) {
    return this.client.generateSessionContent(this.sessionId, prompt, {
      ...opts?.signal ? { signal: opts.signal } : {},
      ...this.clientId ? { clientId: this.clientId } : {}
    });
  }
  btw(question, opts) {
    return this.client.btwSession(this.sessionId, question, {
      ...opts?.signal ? { signal: opts.signal } : {},
      ...this.clientId ? { clientId: this.clientId } : {}
    });
  }
  /**
   * Queue a user message typed while this session's turn is still running so
   * the ACP child can drain it mid-turn. Forwards the client id bound at
   * create/attach. Accepted requests become daemon-owned even when the active
   * turn settles while the request is in flight.
   */
  enqueueMidTurnMessage(message, opts) {
    return this.client.enqueueMidTurnMessage(this.sessionId, message, {
      ...opts?.signal ? { signal: opts.signal } : {},
      ...opts?.eventDetailMode !== void 0 ? { eventDetailMode: opts.eventDetailMode } : {},
      ...opts?.messageId ? { messageId: opts.messageId } : {},
      ...opts?.content && opts.content.length > 0 ? { content: opts.content } : {},
      ...this.clientId ? { clientId: this.clientId } : {}
    });
  }
  removeMidTurnMessage(messageId) {
    return this.client.removeMidTurnMessage(this.sessionId, messageId, {
      ...this.clientId ? { clientId: this.clientId } : {}
    });
  }
  /**
   * Fetch the mid-turn reconciliation snapshot (queue + delivery-state rings) for
   * this session. Forwards the bound client id. See
   * `DaemonClient.getMidTurnMessages` — requires the daemon to advertise
   * `session_mid_turn_message_query`; older daemons reject with 404 and
   * callers preserve their current state.
   */
  async getMidTurnMessages(opts) {
    const result = await this.client.getMidTurnMessages(this.sessionId, {
      ...opts?.signal ? { signal: opts.signal } : {},
      ...this.clientId ? { clientId: this.clientId } : {}
    });
    return {
      ...result,
      messages: await Promise.all(
        result.messages.map(async (message) => ({
          ...message,
          ...message.content ? { content: await this.hydrateContent(message.content) } : {}
        }))
      )
    };
  }
  async getPendingPrompts() {
    const result = await this.client.getPendingPrompts(this.sessionId, {
      ...this.clientId ? { clientId: this.clientId } : {}
    });
    return {
      pendingPrompts: await Promise.all(
        result.pendingPrompts.map(async (prompt) => ({
          ...prompt,
          ...prompt.content ? { content: await this.hydrateContent(prompt.content) } : {}
        }))
      )
    };
  }
  async getTranscriptPage(opts = {}) {
    const page = await this.client.getSessionTranscriptPage(this.sessionId, {
      ...opts,
      clientId: opts.clientId ?? this.clientId
    });
    return {
      ...page,
      events: await Promise.all(
        page.events.map(async (event) => await this.hydrateEvent(event))
      )
    };
  }
  async getTurnIndexPage(opts = {}) {
    return this.client.getSessionTurnIndexPage(this.sessionId, {
      ...opts,
      clientId: opts.clientId ?? this.clientId
    });
  }
  removePendingPrompt(promptId) {
    return this.client.removePendingPrompt(this.sessionId, promptId, {
      ...this.clientId ? { clientId: this.clientId } : {}
    });
  }
  /**
   * Execute a direct daemon-side shell command for this session. Requires the
   * daemon to opt in to direct session shell with bearer auth or
   * trusted-loopback authority; this wrapper automatically forwards the client
   * id bound when the session was created or attached.
   */
  shellCommand(command, signal) {
    return this.client.shellCommand(this.sessionId, command, {
      ...signal ? { signal } : {},
      ...this.clientId ? { clientId: this.clientId } : {}
    });
  }
  context() {
    return this.client.sessionContext(this.sessionId, this.clientId);
  }
  status() {
    return this.client.sessionStatus(this.sessionId, this.clientId);
  }
  contextUsage(opts = {}) {
    return this.client.sessionContextUsage(this.sessionId, opts, this.clientId);
  }
  supportedCommands() {
    return this.client.sessionSupportedCommands(this.sessionId, this.clientId);
  }
  tasks() {
    return this.client.sessionTasks(this.sessionId, this.clientId);
  }
  agents(signal) {
    return this.client.sessionAgents(this.sessionId, this.clientId, signal);
  }
  agentTrace(opts = {}) {
    return this.client.sessionAgentTrace(this.sessionId, {
      ...opts,
      clientId: this.clientId
    });
  }
  workflowTasks() {
    return this.client.sessionWorkflowTasks(this.sessionId, this.clientId);
  }
  savedWorkflow(name) {
    return this.client.sessionSavedWorkflow(
      this.sessionId,
      name,
      this.clientId
    );
  }
  lspStatus() {
    return this.client.sessionLspStatus(this.sessionId, this.clientId);
  }
  resources() {
    return this.client.sessionResources(this.sessionId, this.clientId);
  }
  cancelTask(taskId, kind) {
    return this.client.sessionTaskCancel(
      this.sessionId,
      taskId,
      kind,
      this.clientId
    );
  }
  controlWorkflowTask(taskId, action, input) {
    return this.client.sessionWorkflowTaskAction(
      this.sessionId,
      taskId,
      action,
      this.clientId,
      input
    );
  }
  clearGoal() {
    return this.client.sessionGoalClear(this.sessionId, this.clientId);
  }
  goal() {
    return this.client.sessionGoal(this.sessionId, this.clientId);
  }
  controlGoal(request) {
    return this.client.sessionGoalControl(
      this.sessionId,
      request,
      this.clientId
    );
  }
  stats() {
    return this.client.sessionStats(this.sessionId, this.clientId);
  }
  async respondToPermission(requestId, response) {
    return await this.client.respondToPermission(
      requestId,
      response,
      this.clientId
    );
  }
  async respondToSessionPermission(requestId, response) {
    return await this.client.respondToSessionPermission(
      this.sessionId,
      requestId,
      response,
      this.clientId
    );
  }
  async close() {
    return await this.client.closeSession(this.sessionId, this.clientId);
  }
  async detach() {
    return await this.client.detachSession(this.sessionId, this.clientId);
  }
  async updateMetadata(metadata) {
    return await this.client.updateSessionMetadata(
      this.sessionId,
      metadata,
      this.clientId
    );
  }
  events(opts = {}) {
    return this.openEventSubscription(opts);
  }
  /**
   * @deprecated Use {@link events} instead. Both methods are equivalent.
   */
  subscribeEvents(opts = {}) {
    return this.openEventSubscription(opts);
  }
  openEventSubscription(opts) {
    const requestedLastEventId = validateLastEventId(opts.lastEventId);
    let started = false;
    let released = false;
    const release = /* @__PURE__ */ __name(() => {
      if (released) return;
      released = true;
      this.subscriptionActive = false;
    }, "release");
    const acquire = /* @__PURE__ */ __name(() => {
      if (started) return;
      if (this.subscriptionActive) {
        throw new Error("subscription active");
      }
      this.subscriptionActive = true;
      started = true;
    }, "acquire");
    const iterator = this.iterateEvents(
      { ...opts, lastEventId: requestedLastEventId },
      release
    );
    return {
      next: /* @__PURE__ */ __name(async (value) => {
        if (!released) {
          acquire();
        }
        return await iterator.next(value);
      }, "next"),
      return: /* @__PURE__ */ __name(async () => {
        try {
          return await iterator.return(void 0);
        } finally {
          release();
        }
      }, "return"),
      throw: /* @__PURE__ */ __name(async (error) => {
        try {
          return await iterator.throw(error);
        } finally {
          release();
        }
      }, "throw"),
      [Symbol.asyncIterator]() {
        return this;
      }
    };
  }
  async *iterateEvents(opts, release) {
    try {
      const {
        resume = true,
        sseConnectReason: requestedConnectReason,
        ...sessionSubscribeOpts
      } = opts;
      const subscribeOpts = { ...sessionSubscribeOpts };
      delete subscribeOpts.clientId;
      delete subscribeOpts.previousSseStreamId;
      delete subscribeOpts.onSseStreamAccepted;
      const lastEventId = subscribeOpts.lastEventId ?? (resume ? this.lastSeenEventId : void 0);
      const epoch = subscribeOpts.epoch ?? (resume ? this.lastSeenEpoch : void 0);
      const callerOnEpoch = subscribeOpts.onEpoch;
      const restSubscription = this.client.transport.type === "rest";
      if (!restSubscription) {
        this.hasAcceptedRestStream = false;
        this.lastAcceptedRestStreamId = void 0;
      }
      const sseConnectReason = requestedConnectReason ?? (this.hasAcceptedRestStream ? "resume" : "initial");
      for await (const event of this.client.subscribeEvents(this.sessionId, {
        ...subscribeOpts,
        lastEventId,
        ...this.clientId ? { clientId: this.clientId } : {},
        sseConnectReason,
        ...this.lastAcceptedRestStreamId ? {
          previousSseStreamId: this.lastAcceptedRestStreamId
        } : {},
        onSseStreamAccepted: /* @__PURE__ */ __name((streamId) => {
          this.hasAcceptedRestStream = true;
          this.lastAcceptedRestStreamId = streamId;
        }, "onSseStreamAccepted"),
        ...epoch !== void 0 ? { epoch } : {},
        onEpoch: /* @__PURE__ */ __name((learned) => {
          this.lastSeenEpoch = learned;
          callerOnEpoch?.(learned);
        }, "onEpoch")
      })) {
        const hydratedEvent = await this.hydrateEvent(event);
        this._dispatchTurnEvent(hydratedEvent);
        yield hydratedEvent;
        if (event.id !== void 0) {
          this.lastSeenEventId = Math.max(
            this.lastSeenEventId ?? 0,
            validateLastEventId(event.id)
          );
        }
      }
    } finally {
      this._rejectAllPending(new Error("SSE stream ended"));
      release();
    }
  }
  async hydrateReplaySnapshot() {
    this.replaySnapshot.compactedReplay = await Promise.all(
      this.replaySnapshot.compactedReplay.map(
        async (event) => await this.hydrateEvent(event)
      )
    );
    this.replaySnapshot.liveJournal = await Promise.all(
      this.replaySnapshot.liveJournal.map(
        async (event) => await this.hydrateEvent(event)
      )
    );
  }
  async hydrateEvent(event) {
    if (!event.data || typeof event.data !== "object") return event;
    const data = event.data;
    if (event.type === "session_update") {
      const update = data["update"];
      if (update && typeof update === "object" && !Array.isArray(update)) {
        const content2 = update["content"];
        const hydrated2 = await this.hydrateBlock(content2);
        if (hydrated2 === content2) return event;
        return {
          ...event,
          data: { ...data, update: { ...update, content: hydrated2 } }
        };
      }
      const content = data["content"];
      const hydrated = await this.hydrateBlock(content);
      if (hydrated === content) return event;
      return { ...event, data: { ...data, content: hydrated } };
    }
    if (event.type !== "mid_turn_message_injected") return event;
    const items = data["items"];
    if (!Array.isArray(items)) return event;
    return {
      ...event,
      data: {
        ...data,
        items: await Promise.all(
          items.map(async (item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              return item;
            }
            const record = item;
            return Array.isArray(record["content"]) ? {
              ...record,
              content: await this.hydrateContent(record["content"])
            } : item;
          })
        )
      }
    };
  }
  async hydrateContent(content) {
    return await Promise.all(
      content.map(async (block) => await this.hydrateBlock(block))
    );
  }
  async hydrateBlock(block) {
    if (!isSessionAttachmentReference(block)) {
      return block;
    }
    if (block.type === "resource") return block;
    let cached = this.attachmentCache.get(block.attachmentId);
    if (cached) {
      this.attachmentCache.delete(block.attachmentId);
      this.attachmentCache.set(block.attachmentId, cached);
    } else {
      const pending = this.withClientIdSelfHeal(
        () => this.client.readSessionAttachment(this.sessionId, block.attachmentId, {
          ...this.clientId ? { clientId: this.clientId } : {}
        })
      );
      cached = { pending, size: block.size };
      this.attachmentCache.set(block.attachmentId, cached);
      this.attachmentCacheBytes += block.size;
      while (this.attachmentCache.size > MAX_ATTACHMENT_CACHE_ENTRIES || this.attachmentCacheBytes > MAX_ATTACHMENT_CACHE_BYTES) {
        const oldestId = this.attachmentCache.keys().next().value;
        if (oldestId === void 0) break;
        const evicted = this.attachmentCache.get(oldestId);
        this.attachmentCache.delete(oldestId);
        this.attachmentCacheBytes -= evicted?.size ?? 0;
      }
      void pending.catch(() => {
        if (this.attachmentCache.get(block.attachmentId)?.pending !== pending)
          return;
        this.attachmentCache.delete(block.attachmentId);
        this.attachmentCacheBytes -= block.size;
      });
    }
    try {
      const attachment = await cached.pending;
      return {
        type: "image",
        data: attachment.data,
        mimeType: attachment.mimeType,
        // Keep the reference id on the hydrated block so message images stay
        // re-fetchable after a reload (Web Shell previews persist the id
        // instead of the data URL).
        attachmentId: block.attachmentId
      };
    } catch (err) {
      if (err instanceof DaemonHttpError && (err.status === 404 || err.status === 410)) {
        return {
          type: "text",
          text: "[Attachment is no longer available]"
        };
      }
      return block;
    }
  }
  _dispatchTurnEvent(event) {
    if (event.type !== "turn_complete" && event.type !== "turn_error") return;
    const promptId = event.data?.promptId;
    if (!promptId) return;
    const pending = this._pendingPrompts.get(promptId);
    if (!pending) return;
    this._pendingPrompts.delete(promptId);
    try {
      const result = matchTurnEvent(event, promptId);
      if (result !== void 0) pending.resolve(result);
    } catch (err) {
      pending.reject(err);
    }
  }
  _rejectAllPending(err) {
    for (const [, pending] of this._pendingPrompts) {
      pending.reject(err);
    }
    this._pendingPrompts.clear();
  }
};
function validateLastEventId(lastEventId) {
  if (lastEventId === void 0) return void 0;
  if (!Number.isInteger(lastEventId) || lastEventId < 0) {
    throw new TypeError("invalid lastEventId");
  }
  return lastEventId;
}
__name(validateLastEventId, "validateLastEventId");
function isInvalidClientId(err) {
  return err instanceof DaemonHttpError && err.status === 400 && typeof err.body === "object" && err.body !== null && err.body.code === "invalid_client_id";
}
__name(isInvalidClientId, "isInvalidClientId");

// packages/sdk-typescript/src/daemon/events.ts
init_esbuild_shims();

// packages/acp-bridge/dist/daemonEventTypes.js
init_esbuild_shims();
var MID_TURN_MESSAGE_INJECTED_EVENT = "mid_turn_message_injected";
var PENDING_PROMPT_ADDED_EVENT = "pending_prompt_added";
var PENDING_PROMPT_STARTED_EVENT = "pending_prompt_started";
var PENDING_PROMPT_COMPLETED_EVENT = "pending_prompt_completed";

// packages/sdk-typescript/src/daemon/events.ts
var DAEMON_KNOWN_EVENT_TYPE_VALUES = [
  "session_update",
  "permission_request",
  "permission_resolved",
  "permission_already_resolved",
  "model_switched",
  "model_switch_failed",
  "session_died",
  "session_closed",
  "session_metadata_updated",
  "session_recording_degraded",
  "artifact_changed",
  "source_changed",
  MID_TURN_MESSAGE_INJECTED_EVENT,
  PENDING_PROMPT_ADDED_EVENT,
  PENDING_PROMPT_STARTED_EVENT,
  PENDING_PROMPT_COMPLETED_EVENT,
  "client_evicted",
  "slow_client_warning",
  "stream_error",
  // Emitted when an SSE consumer reconnects with a `Last-Event-ID`
  // past the ring's earliest available id (events were evicted
  // before reconnect). The reducer treats this as "your accumulated
  // state is stale; call `loadSession` and reseed view state before
  // applying any further deltas". Does NOT close the stream — the
  // daemon continues replaying surviving ring frames and live
  // frames, but the reducer auto-skips them until the consumer
  // reseeds state. Synthetic (no `id`) so it doesn't burn a slot
  // in the per-session monotonic sequence.
  "state_resync_required",
  // Synthetic marker prepended to a bounded `/session/:id/load` replay
  // snapshot when older replay history was dropped from the daemon's
  // in-memory window. This is NOT a resync request: consumers should render
  // it as transcript status and continue applying the retained snapshot.
  "history_truncated",
  // MCP guardrail push events. See `mcp_guardrail_events` capability
  // tag. Both fire on the per-session SSE bus; consumers should
  // pre-flight `caps.features.includes('mcp_guardrail_events')`
  // before relying on these for non-snapshot UX (the
  // `GET /workspace/mcp` snapshot still encodes the same state).
  "mcp_budget_warning",
  "mcp_child_refused_batch",
  // Workspace-level mutation signals fanned out through every active
  // session's bus. Non-terminal — informational for adapters that want
  // to render "memory just changed" / "agent X updated" toasts.
  // Read-after-write remains the correctness contract.
  "memory_changed",
  "agent_changed",
  // Workspace-scoped auth device-flow events. These are NOT
  // session-keyed; the session reducer no-ops on them and
  // `reduceDaemonAuthEvent` projects them into a workspace-level
  // state shape (one entry per provider).
  "auth_device_flow_started",
  "auth_device_flow_throttled",
  "auth_device_flow_authorized",
  "auth_device_flow_failed",
  "auth_device_flow_cancelled",
  // Mutation control events.
  "approval_mode_changed",
  "tool_toggled",
  "settings_changed",
  "trust_change_requested",
  "workspace_initialized",
  "github_setup_completed",
  "mcp_server_restarted",
  "mcp_server_restart_refused",
  "mcp_server_changed",
  "settings_reloaded",
  // Runtime MCP server add/remove events. Fired by
  // `POST /workspace/mcp/servers` on success (including replace and
  // same-fingerprint no-op).
  "mcp_server_added",
  // Counterpart of `mcp_server_added`. Fired by
  // `DELETE /workspace/mcp/servers/:name` when an entry was actually
  // removed. Idempotent skip ('not_present') does NOT emit.
  "mcp_server_removed",
  // Extensions lifecycle events. Fired by background extension install/refresh
  // work. Carries refreshed/failed session counts, and may include install
  // success/failure details.
  "extensions_changed",
  // Multi-client permission coordination events.
  // `permission_partial_vote` only fires under `consensus` policy;
  // `permission_forbidden` fires under `designated` (originator
  // mismatch), `consensus` (anonymous voter or not-in-snapshot), and
  // `local-only` (remote voter). Pre-flight on the
  // `permission_mediation` capability tag before relying on either —
  // older daemons omit both event types.
  "permission_partial_vote",
  "permission_forbidden",
  // Cross-client real-time sync (acp-bridge audit, 2026-05-24).
  // `prompt_cancelled`: broadcast when a prompt is cancelled (explicit
  //   `cancelSession` route OR originator SSE disconnect) so peer
  //   subscribers observe the cancel as a first-class event instead of
  //   inferring it from the absence of further `agent_message_chunk`
  //   frames. Carries envelope-level `originatorClientId` (cancelling
  //   client). Semantic is "cancel requested", not "confirmed".
  // `replay_complete`: id-less sentinel emitted at the end of the
  //   `Last-Event-ID` replay loop so consumers can deterministically
  //   drop a catch-up indicator. Fires on both the clean-replay and the
  //   ring-evicted (`state_resync_required`) paths, and even when there
  //   was nothing to replay (`data.replayedCount === 0`).
  "prompt_cancelled",
  "replay_complete",
  // Daemon assist push events. `followup_suggestion`: server-side
  // ghost-text "what you might want to ask next" suggestion, generated
  // after each end_turn by the ACP child and forwarded through the per-
  // session SSE bus so Web Shell (and other future daemon adapters)
  // can render the suggestion in their input placeholder. The wire
  // carries only post-filter suggestions (`getFilterReason()===null`);
  // generator-side suppression telemetry stays on the daemon. Old SDK
  // consumers silently drop this event via `asKnownDaemonEvent`
  // returning undefined (no protocol bump required).
  "followup_suggestion",
  "channel_delivery_result",
  "user_shell_command",
  "user_shell_result",
  "turn_complete",
  "turn_error",
  "session_rewound",
  "session_branched",
  // A5 (#4511): synthetic side-channel snapshot yielded after
  // `replay_complete` when `?snapshot=1` is set on the SSE endpoint.
  // Carries `currentModelId` and `currentApprovalMode` so reconnecting
  // clients can seed their reducer without an extra round-trip.
  "session_snapshot",
  "git_branch_changed",
  // Enriched working-tree summary push: the daemon recomputes `git status`
  // in the background (stale-while-revalidate on `GET …/git`) and publishes
  // this only when the summary changed. `data` is a DaemonWorkspaceGitStatus.
  // Old SDK consumers silently drop it via `asKnownDaemonEvent`.
  "git_status_changed"
];
var DAEMON_KNOWN_EVENT_TYPES = new Set(
  DAEMON_KNOWN_EVENT_TYPE_VALUES
);
var MAX_PENDING_PER_SESSION = 64;
var MAX_FORBIDDEN_VOTES_PER_SESSION = 32;
var RESYNC_PASSTHROUGH_TYPES = /* @__PURE__ */ new Set([
  "state_resync_required",
  "history_truncated",
  "session_died",
  "session_closed",
  "client_evicted",
  "stream_error",
  "session_recording_degraded",
  // A5 (#4511): the snapshot is a full-state authoritative frame, not a
  // delta, so it is safe to apply during resync — and it is exactly what
  // lets a client that reconnected past the ring recover currentModelId /
  // approvalMode without waiting for the next loadSession.
  "session_snapshot"
]);
function createDaemonSessionViewState(seed = {}) {
  return {
    alive: seed.alive ?? true,
    pendingPermissions: { ...seed.pendingPermissions },
    lastEventId: seed.lastEventId,
    sessionId: seed.sessionId,
    currentModelId: seed.currentModelId,
    displayName: seed.displayName,
    recordingDegraded: seed.recordingDegraded ?? false,
    lastSessionUpdate: seed.lastSessionUpdate,
    lastModelSwitchFailure: seed.lastModelSwitchFailure,
    terminalEvent: seed.terminalEvent,
    streamError: seed.streamError,
    unrecognizedKnownEventCount: seed.unrecognizedKnownEventCount ?? 0,
    lastUnrecognizedKnownEvent: seed.lastUnrecognizedKnownEvent,
    droppedPermissionRequestCount: seed.droppedPermissionRequestCount ?? 0,
    lastDroppedPermissionRequestId: seed.lastDroppedPermissionRequestId,
    unmatchedPermissionResolutionCount: seed.unmatchedPermissionResolutionCount ?? 0,
    lastUnmatchedPermissionResolutionId: seed.lastUnmatchedPermissionResolutionId,
    slowClientWarningCount: seed.slowClientWarningCount ?? 0,
    lastSlowClientWarning: seed.lastSlowClientWarning,
    mcpBudgetWarningCount: seed.mcpBudgetWarningCount ?? 0,
    lastMcpBudgetWarning: seed.lastMcpBudgetWarning,
    mcpChildRefusedBatchCount: seed.mcpChildRefusedBatchCount ?? 0,
    lastMcpChildRefusedBatch: seed.lastMcpChildRefusedBatch,
    lastWorkspaceMutation: seed.lastWorkspaceMutation,
    lastWorkspaceMutationType: seed.lastWorkspaceMutationType,
    approvalMode: seed.approvalMode,
    planExecutionMode: seed.planExecutionMode,
    approvalModeChangedCount: seed.approvalModeChangedCount ?? 0,
    lastApprovalModeChange: seed.lastApprovalModeChange,
    toolToggleCount: seed.toolToggleCount ?? 0,
    lastToolToggle: seed.lastToolToggle,
    workspaceInitCount: seed.workspaceInitCount ?? 0,
    lastWorkspaceInit: seed.lastWorkspaceInit,
    mcpRestartCount: seed.mcpRestartCount ?? 0,
    lastMcpRestart: seed.lastMcpRestart,
    mcpRestartRefusedCount: seed.mcpRestartRefusedCount ?? 0,
    lastMcpRestartRefused: seed.lastMcpRestartRefused,
    permissionVoteProgress: { ...seed.permissionVoteProgress },
    forbiddenVotes: seed.forbiddenVotes ? [...seed.forbiddenVotes] : [],
    forbiddenVoteCount: seed.forbiddenVoteCount ?? 0,
    // Fresh view state always starts without a resync requirement.
    // A consumer calling `createDaemonSessionViewState` after
    // `loadSession` to recover from an earlier resync implicitly
    // clears the flag through this default.
    awaitingResync: seed.awaitingResync ?? false,
    resyncRequiredCount: seed.resyncRequiredCount ?? 0,
    lastResyncRequired: seed.lastResyncRequired,
    historyTruncatedCount: seed.historyTruncatedCount ?? 0,
    lastHistoryTruncated: seed.lastHistoryTruncated,
    lastFollowupSuggestion: seed.lastFollowupSuggestion,
    rewindCount: seed.rewindCount ?? 0,
    lastRewind: seed.lastRewind,
    lastBranch: seed.lastBranch
  };
}
__name(createDaemonSessionViewState, "createDaemonSessionViewState");
function isKnownDaemonEvent(event) {
  return asKnownDaemonEvent(event) !== void 0;
}
__name(isKnownDaemonEvent, "isKnownDaemonEvent");
function isDaemonEventType(event, type) {
  const known = asKnownDaemonEvent(event);
  return known?.type === type;
}
__name(isDaemonEventType, "isDaemonEventType");
function isWorkspaceScopedBudgetEvent(data) {
  return data.scope === "workspace";
}
__name(isWorkspaceScopedBudgetEvent, "isWorkspaceScopedBudgetEvent");
function asKnownDaemonEvent(event) {
  switch (event.type) {
    case "session_update":
      return isRecord(event.data) ? event : void 0;
    case "permission_request":
      return isPermissionRequestData(event.data) ? event : void 0;
    case "permission_resolved":
      return isPermissionResolvedData(event.data) ? event : void 0;
    case "permission_already_resolved":
      return isPermissionAlreadyResolvedData(event.data) ? event : void 0;
    case "permission_partial_vote":
      return isPermissionPartialVoteData(event.data) ? event : void 0;
    case "permission_forbidden":
      return isPermissionForbiddenData(event.data) ? event : void 0;
    case "model_switched":
      return isModelSwitchedData(event.data) ? event : void 0;
    case "model_switch_failed":
      return isModelSwitchFailedData(event.data) ? event : void 0;
    case "session_died":
      return isSessionDiedData(event.data) ? event : void 0;
    case "session_closed":
      return isSessionClosedData(event.data) ? event : void 0;
    case "session_metadata_updated":
      return isSessionMetadataUpdatedData(event.data) ? event : void 0;
    case "session_recording_degraded":
      return isSessionRecordingDegradedData(event.data) ? event : void 0;
    case "source_changed":
      return isRecord(event.data) && typeof event.data["sessionId"] === "string" && Number.isInteger(event.data["revision"]) && Number(event.data["revision"]) >= 0 ? event : void 0;
    case "artifact_changed":
      return isArtifactChangedData(event.data) ? event : void 0;
    case MID_TURN_MESSAGE_INJECTED_EVENT: {
      const data = asMidTurnMessageInjectedData(event.data);
      return data ? { ...event, data } : void 0;
    }
    case PENDING_PROMPT_ADDED_EVENT:
      return isPendingPromptAddedData(event.data) ? event : void 0;
    case PENDING_PROMPT_STARTED_EVENT:
      return isPendingPromptStartedData(event.data) ? event : void 0;
    case PENDING_PROMPT_COMPLETED_EVENT:
      return isPendingPromptCompletedData(event.data) ? event : void 0;
    case "client_evicted":
      return isClientEvictedData(event.data) ? event : void 0;
    case "slow_client_warning":
      return isSlowClientWarningData(event.data) ? event : void 0;
    case "stream_error":
      return isStreamErrorData(event.data) ? event : void 0;
    case "state_resync_required":
      return isStateResyncRequiredData(event.data) ? event : void 0;
    case "history_truncated":
      return isHistoryTruncatedData(event.data) ? event : void 0;
    case "mcp_budget_warning":
      return isMcpBudgetWarningData(event.data) ? event : void 0;
    case "mcp_child_refused_batch":
      return isMcpChildRefusedBatchData(event.data) ? event : void 0;
    case "memory_changed":
      return isMemoryChangedData(event.data) ? event : void 0;
    case "agent_changed":
      return isAgentChangedData(event.data) ? event : void 0;
    case "auth_device_flow_started":
      return isAuthDeviceFlowStartedData(event.data) ? event : void 0;
    case "auth_device_flow_throttled":
      return isAuthDeviceFlowThrottledData(event.data) ? event : void 0;
    case "auth_device_flow_authorized":
      return isAuthDeviceFlowAuthorizedData(event.data) ? event : void 0;
    case "auth_device_flow_failed":
      return isAuthDeviceFlowFailedData(event.data) ? event : void 0;
    case "auth_device_flow_cancelled":
      return isAuthDeviceFlowCancelledData(event.data) ? event : void 0;
    case "approval_mode_changed":
      return isApprovalModeChangedData(event.data) ? event : void 0;
    case "tool_toggled":
      return isToolToggledData(event.data) ? event : void 0;
    case "settings_changed":
      return isSettingsChangedData(event.data) ? event : void 0;
    case "trust_change_requested":
      return isTrustChangeRequestedData(event.data) ? event : void 0;
    case "workspace_initialized":
      return isWorkspaceInitializedData(event.data) ? event : void 0;
    case "github_setup_completed":
      return isGithubSetupCompletedData(event.data) ? event : void 0;
    case "mcp_server_restarted":
      return isMcpServerRestartedData(event.data) ? event : void 0;
    case "mcp_server_restart_refused":
      return isMcpServerRestartRefusedData(event.data) ? event : void 0;
    case "mcp_server_changed":
      return isMcpServerChangedData(event.data) ? event : void 0;
    case "settings_reloaded":
      return event.data != null && typeof event.data === "object" ? event : void 0;
    case "followup_suggestion":
      return isFollowupSuggestionData(event.data) ? event : void 0;
    case "channel_delivery_result":
      return isChannelDeliveryResultData(event.data) ? event : void 0;
    case "mcp_server_added":
      return isMcpServerAddedData(event.data) ? event : void 0;
    case "mcp_server_removed":
      return isMcpServerRemovedData(event.data) ? event : void 0;
    case "extensions_changed":
      return isExtensionsChangedData(event.data) ? event : void 0;
    case "turn_complete":
      return isTurnCompleteData(event.data) ? event : void 0;
    case "turn_error":
      return isTurnErrorData(event.data) ? event : void 0;
    case "session_rewound":
      return isSessionRewoundData(event.data) ? event : void 0;
    case "session_snapshot":
      return isSessionSnapshotData(event.data) ? event : void 0;
    case "session_branched":
      return isSessionBranchedData(event.data) ? event : void 0;
    default:
      return void 0;
  }
}
__name(asKnownDaemonEvent, "asKnownDaemonEvent");
function isSessionRewoundData(value) {
  return isRecord(value) && isNonEmptyString(value["sessionId"]) && isNonEmptyString(value["promptId"]) && isFiniteNumber(value["targetTurnIndex"]) && Array.isArray(value["filesChanged"]) && Array.isArray(value["filesFailed"]);
}
__name(isSessionRewoundData, "isSessionRewoundData");
function reduceDaemonSessionEvent(state, rawEvent) {
  const base = advanceLastEventId(state, rawEvent.id);
  const event = asKnownDaemonEvent(rawEvent);
  if (!event) {
    if (!isKnownDaemonEventTypeName(rawEvent.type)) return base;
    return {
      ...base,
      unrecognizedKnownEventCount: base.unrecognizedKnownEventCount + 1,
      lastUnrecognizedKnownEvent: rawEvent
    };
  }
  if (base.awaitingResync && !RESYNC_PASSTHROUGH_TYPES.has(event.type)) {
    return base;
  }
  switch (event.type) {
    case "session_update":
      return {
        ...base,
        // ACP SessionNotification carries sessionId at the top level today;
        // keep this aligned with httpAcpBridge's emission shape.
        sessionId: getString(event.data, "sessionId") ?? base.sessionId,
        lastSessionUpdate: event.data
      };
    case "permission_request": {
      const isExistingRequest = event.data.requestId in base.pendingPermissions;
      if (!isExistingRequest && Object.keys(base.pendingPermissions).length >= MAX_PENDING_PER_SESSION) {
        return {
          ...base,
          droppedPermissionRequestCount: base.droppedPermissionRequestCount + 1,
          lastDroppedPermissionRequestId: event.data.requestId
        };
      }
      return {
        ...base,
        sessionId: event.data.sessionId,
        pendingPermissions: {
          ...base.pendingPermissions,
          [event.data.requestId]: clonePermissionRequestData(event.data)
        }
      };
    }
    case "permission_resolved": {
      const permissionVoteProgress = { ...base.permissionVoteProgress };
      delete permissionVoteProgress[event.data.requestId];
      if (!(event.data.requestId in base.pendingPermissions)) {
        return {
          ...base,
          permissionVoteProgress,
          unmatchedPermissionResolutionCount: base.unmatchedPermissionResolutionCount + 1,
          lastUnmatchedPermissionResolutionId: event.data.requestId
        };
      }
      const pendingPermissions = { ...base.pendingPermissions };
      delete pendingPermissions[event.data.requestId];
      return { ...base, pendingPermissions, permissionVoteProgress };
    }
    case "permission_already_resolved": {
      const permissionVoteProgress = { ...base.permissionVoteProgress };
      delete permissionVoteProgress[event.data.requestId];
      if (!(event.data.requestId in base.pendingPermissions)) {
        return {
          ...base,
          permissionVoteProgress,
          unmatchedPermissionResolutionCount: base.unmatchedPermissionResolutionCount + 1,
          lastUnmatchedPermissionResolutionId: event.data.requestId
        };
      }
      const pendingPermissions = { ...base.pendingPermissions };
      delete pendingPermissions[event.data.requestId];
      return { ...base, pendingPermissions, permissionVoteProgress };
    }
    case "permission_partial_vote": {
      return {
        ...base,
        permissionVoteProgress: {
          ...base.permissionVoteProgress,
          [event.data.requestId]: mergeOriginator(event.data, event)
        }
      };
    }
    case "permission_forbidden": {
      const next = base.forbiddenVotes.slice();
      next.push(mergeOriginator(event.data, event));
      while (next.length > MAX_FORBIDDEN_VOTES_PER_SESSION) {
        next.shift();
      }
      return {
        ...base,
        forbiddenVotes: next,
        forbiddenVoteCount: base.forbiddenVoteCount + 1
      };
    }
    case "model_switched":
      return {
        ...base,
        sessionId: event.data.sessionId,
        currentModelId: event.data.modelId,
        lastModelSwitchFailure: void 0
      };
    case "model_switch_failed":
      return {
        ...base,
        sessionId: event.data.sessionId,
        lastModelSwitchFailure: event.data
      };
    case "session_died":
      return {
        ...base,
        sessionId: event.data.sessionId,
        alive: false,
        terminalEvent: chooseTerminalEvent(base.terminalEvent, event),
        pendingPermissions: {},
        permissionVoteProgress: {},
        // Terminal events must also drop `forbiddenVotes` history so
        // adapters reading view state for a dead session don't render
        // stale rejection data.
        forbiddenVotes: [],
        forbiddenVoteCount: 0
      };
    case "session_closed":
      return {
        ...base,
        sessionId: event.data.sessionId,
        alive: false,
        terminalEvent: chooseTerminalEvent(base.terminalEvent, event),
        pendingPermissions: {},
        permissionVoteProgress: {},
        // See session_died: clear forbiddenVotes on terminal events.
        forbiddenVotes: [],
        forbiddenVoteCount: 0
      };
    case "session_metadata_updated":
      return {
        ...base,
        sessionId: event.data.sessionId,
        displayName: event.data.displayName
      };
    case "client_evicted":
      return {
        ...base,
        alive: false,
        terminalEvent: chooseTerminalEvent(base.terminalEvent, event),
        pendingPermissions: {},
        permissionVoteProgress: {},
        // See session_died: clear forbiddenVotes on terminal events.
        forbiddenVotes: [],
        forbiddenVoteCount: 0
      };
    case "slow_client_warning":
      return {
        ...base,
        slowClientWarningCount: base.slowClientWarningCount + 1,
        lastSlowClientWarning: event.data
      };
    case "stream_error":
      return {
        ...base,
        alive: false,
        terminalEvent: chooseTerminalEvent(base.terminalEvent, event),
        streamError: event.data,
        pendingPermissions: {},
        permissionVoteProgress: {},
        // See session_died: clear forbiddenVotes on terminal events.
        forbiddenVotes: [],
        forbiddenVoteCount: 0
      };
    case "state_resync_required":
      return {
        ...base,
        awaitingResync: true,
        resyncRequiredCount: base.resyncRequiredCount + 1,
        lastResyncRequired: event.data
      };
    case "history_truncated":
      return {
        ...base,
        historyTruncatedCount: base.historyTruncatedCount + 1,
        lastHistoryTruncated: event.data
      };
    case "mcp_budget_warning":
      return {
        ...base,
        mcpBudgetWarningCount: base.mcpBudgetWarningCount + 1,
        lastMcpBudgetWarning: event.data
      };
    case "mcp_child_refused_batch":
      return {
        ...base,
        mcpChildRefusedBatchCount: base.mcpChildRefusedBatchCount + 1,
        lastMcpChildRefusedBatch: event.data
      };
    case "memory_changed":
      return {
        ...base,
        lastWorkspaceMutation: event.data,
        lastWorkspaceMutationType: "memory_changed"
      };
    case "agent_changed":
      return {
        ...base,
        lastWorkspaceMutation: event.data,
        lastWorkspaceMutationType: "agent_changed"
      };
    // Auth device-flow events are workspace-scoped; the session reducer
    // is a no-op (consume `lastEventId` via `base` and otherwise pass
    // state through). Workspace-level state lives in `DaemonAuthState`
    // and is projected by `reduceDaemonAuthEvent`.
    case "auth_device_flow_started":
    case "auth_device_flow_throttled":
    case "auth_device_flow_authorized":
    case "auth_device_flow_failed":
    case "auth_device_flow_cancelled":
      return base;
    // For the 5 mutation events, copy `event.originatorClientId`
    // (envelope-level) into the stored snapshot. Without this,
    // consumers reading `lastApprovalModeChange` / `lastToolToggle` /
    // `lastWorkspaceInit` / `lastMcpRestart{,Refused}` cannot tell
    // whether the mutation originated from themselves -- even though
    // the raw event carried that information at the envelope level.
    // `mergeOriginator` preserves any pre-existing
    // `data.originatorClientId` (which the daemon does NOT currently
    // populate, but the field exists on the Data interfaces) and falls
    // back to the envelope.
    case "approval_mode_changed":
      return {
        ...base,
        approvalMode: event.data.next,
        planExecutionMode: event.data.next === "plan" ? event.data.planExecutionMode : void 0,
        approvalModeChangedCount: base.approvalModeChangedCount + 1,
        lastApprovalModeChange: mergeOriginator(event.data, event)
      };
    case "tool_toggled":
      return {
        ...base,
        toolToggleCount: base.toolToggleCount + 1,
        lastToolToggle: mergeOriginator(event.data, event)
      };
    case "settings_changed":
      return base;
    case "trust_change_requested":
      return base;
    case "workspace_initialized":
      return {
        ...base,
        workspaceInitCount: base.workspaceInitCount + 1,
        lastWorkspaceInit: mergeOriginator(event.data, event)
      };
    case "github_setup_completed":
      return base;
    case "mcp_server_restarted":
      return {
        ...base,
        mcpRestartCount: base.mcpRestartCount + 1,
        lastMcpRestart: mergeOriginator(event.data, event)
      };
    case "mcp_server_restart_refused":
      return {
        ...base,
        mcpRestartRefusedCount: base.mcpRestartRefusedCount + 1,
        lastMcpRestartRefused: mergeOriginator(event.data, event)
      };
    case "followup_suggestion":
      return {
        ...base,
        lastFollowupSuggestion: event.data
      };
    case "turn_complete":
      return {
        ...base,
        lastTurnComplete: event.data
      };
    case "turn_error":
      return {
        ...base,
        lastTurnError: event.data
      };
    // `mid_turn_message_injected` is a transient UX signal (the browser dedupes
    // its own pending queue); like these mcp/settings notices it carries no
    // reduced session-view state.
    case "mcp_server_added":
    case "mcp_server_removed":
    case "mcp_server_changed":
    case "settings_reloaded":
    case "extensions_changed":
    case "artifact_changed":
    case "source_changed":
    case MID_TURN_MESSAGE_INJECTED_EVENT:
    case PENDING_PROMPT_ADDED_EVENT:
    case PENDING_PROMPT_STARTED_EVENT:
    case PENDING_PROMPT_COMPLETED_EVENT:
    case "channel_delivery_result":
      return base;
    case "session_rewound":
      return {
        ...base,
        rewindCount: base.rewindCount + 1,
        lastRewind: mergeOriginator(event.data, event)
      };
    case "session_snapshot":
      return {
        ...base,
        sessionId: event.data.sessionId,
        ...event.data.currentModelId != null ? { currentModelId: event.data.currentModelId } : {},
        ...event.data.currentApprovalMode != null ? {
          approvalMode: event.data.currentApprovalMode,
          planExecutionMode: event.data.currentApprovalMode === "plan" ? event.data.planExecutionMode : void 0
        } : {},
        ...event.data.recordingDegraded !== void 0 ? { recordingDegraded: event.data.recordingDegraded } : {}
      };
    case "session_recording_degraded":
      return {
        ...base,
        sessionId: event.data.sessionId,
        recordingDegraded: true
      };
    case "session_branched":
      return {
        ...base,
        lastBranch: mergeOriginator(event.data, event)
      };
    default: {
      const _exhaustive = event;
      return _exhaustive;
    }
  }
}
__name(reduceDaemonSessionEvent, "reduceDaemonSessionEvent");
function reduceDaemonSessionEvents(events, initialState = createDaemonSessionViewState()) {
  let state = initialState;
  for (const event of events) state = reduceDaemonSessionEvent(state, event);
  return state;
}
__name(reduceDaemonSessionEvents, "reduceDaemonSessionEvents");
function createDaemonAuthState(seed = {}) {
  return { flows: { ...seed.flows ?? {} } };
}
__name(createDaemonAuthState, "createDaemonAuthState");
function reduceDaemonAuthEvent(state, rawEvent) {
  const event = asKnownDaemonEvent(rawEvent);
  if (!event) return state;
  switch (event.type) {
    case "auth_device_flow_started": {
      const providerId = event.data.providerId;
      const existing = state.flows[providerId];
      if (existing !== void 0 && rawEvent.id !== void 0 && existing.lastSeenEventId !== void 0 && rawEvent.id <= existing.lastSeenEventId) {
        return state;
      }
      return {
        flows: {
          ...state.flows,
          [providerId]: {
            deviceFlowId: event.data.deviceFlowId,
            status: "pending",
            lastSeenEventId: rawEvent.id ?? existing?.lastSeenEventId
          }
        }
      };
    }
    case "auth_device_flow_throttled": {
      const updated = updateMatchingFlow(
        state,
        event.data.deviceFlowId,
        rawEvent.id,
        (flow) => ({
          ...flow,
          intervalMs: event.data.intervalMs,
          lastSeenEventId: rawEvent.id ?? flow.lastSeenEventId
        })
      );
      return updated ?? state;
    }
    case "auth_device_flow_authorized": {
      const providerId = event.data.providerId;
      const existing = state.flows[providerId];
      if (!existing || existing.deviceFlowId !== event.data.deviceFlowId) {
        return state;
      }
      if (rawEvent.id !== void 0 && existing.lastSeenEventId !== void 0 && rawEvent.id <= existing.lastSeenEventId) {
        return state;
      }
      const next = {
        ...existing,
        status: "authorized",
        authorizedExpiresAt: event.data.expiresAt,
        accountAlias: event.data.accountAlias,
        errorKind: void 0,
        lastSeenEventId: rawEvent.id ?? existing.lastSeenEventId
      };
      return { flows: { ...state.flows, [providerId]: next } };
    }
    case "auth_device_flow_failed": {
      const updated = updateMatchingFlow(
        state,
        event.data.deviceFlowId,
        rawEvent.id,
        (flow) => ({
          ...flow,
          status: "error",
          errorKind: event.data.errorKind,
          hint: event.data.hint,
          lastSeenEventId: rawEvent.id ?? flow.lastSeenEventId
        })
      );
      return updated ?? state;
    }
    case "auth_device_flow_cancelled": {
      const updated = updateMatchingFlow(
        state,
        event.data.deviceFlowId,
        rawEvent.id,
        (flow) => ({
          ...flow,
          status: "cancelled",
          lastSeenEventId: rawEvent.id ?? flow.lastSeenEventId
        })
      );
      return updated ?? state;
    }
    default:
      return state;
  }
}
__name(reduceDaemonAuthEvent, "reduceDaemonAuthEvent");
function reduceDaemonAuthEvents(events, initialState = createDaemonAuthState()) {
  let state = initialState;
  for (const event of events) state = reduceDaemonAuthEvent(state, event);
  return state;
}
__name(reduceDaemonAuthEvents, "reduceDaemonAuthEvents");
function updateMatchingFlow(state, deviceFlowId, rawEventId, patch) {
  const entries = Object.entries(state.flows);
  for (const [providerId, flow] of entries) {
    if (flow && flow.deviceFlowId === deviceFlowId) {
      if (rawEventId !== void 0 && flow.lastSeenEventId !== void 0 && rawEventId <= flow.lastSeenEventId) {
        return state;
      }
      return {
        flows: { ...state.flows, [providerId]: patch(flow) }
      };
    }
  }
  return void 0;
}
__name(updateMatchingFlow, "updateMatchingFlow");
function isKnownDaemonEventTypeName(type) {
  return DAEMON_KNOWN_EVENT_TYPES.has(type);
}
__name(isKnownDaemonEventTypeName, "isKnownDaemonEventTypeName");
function isSessionLifecycleTerminal(type) {
  return type === "session_died" || type === "session_closed";
}
__name(isSessionLifecycleTerminal, "isSessionLifecycleTerminal");
function chooseTerminalEvent(current, next) {
  if (!current) return next;
  if (!isSessionLifecycleTerminal(current.type) && isSessionLifecycleTerminal(next.type)) {
    return next;
  }
  return current;
}
__name(chooseTerminalEvent, "chooseTerminalEvent");
function isPermissionRequestData(value) {
  return isRecord(value) && isNonEmptyString(value["requestId"]) && isNonEmptyString(value["sessionId"]) && isRecord(value["toolCall"]) && Array.isArray(value["options"]) && value["options"].every(isPermissionOption);
}
__name(isPermissionRequestData, "isPermissionRequestData");
function isPermissionResolvedData(value) {
  return isRecord(value) && isNonEmptyString(value["requestId"]) && isPermissionOutcome(value["outcome"]);
}
__name(isPermissionResolvedData, "isPermissionResolvedData");
function isPermissionAlreadyResolvedData(value) {
  return isRecord(value) && isNonEmptyString(value["requestId"]) && isNonEmptyString(value["sessionId"]) && isPermissionOutcome(value["outcome"]);
}
__name(isPermissionAlreadyResolvedData, "isPermissionAlreadyResolvedData");
function isPermissionPartialVoteData(value) {
  if (!isRecord(value) || !isNonEmptyString(value["requestId"]) || !isNonEmptyString(value["sessionId"]) || !isFiniteNumber(value["votesReceived"]) || !isFiniteNumber(value["votesNeeded"]) || !isFiniteNumber(value["quorum"]) || !Number.isInteger(value["votesReceived"]) || !Number.isInteger(value["votesNeeded"]) || !Number.isInteger(value["quorum"]) || value["votesReceived"] < 0 || value["votesNeeded"] < 0 || value["quorum"] < 1 || !isRecord(value["optionTallies"])) {
    return false;
  }
  for (const tally of Object.values(
    value["optionTallies"]
  )) {
    if (typeof tally !== "number" || !Number.isInteger(tally) || tally < 0) {
      return false;
    }
  }
  return true;
}
__name(isPermissionPartialVoteData, "isPermissionPartialVoteData");
function isPermissionForbiddenData(value) {
  if (!isRecord(value) || !isNonEmptyString(value["requestId"]) || !isNonEmptyString(value["sessionId"])) {
    return false;
  }
  const reason = value["reason"];
  if (reason !== "designated_mismatch" && reason !== "remote_not_allowed") {
    return false;
  }
  const clientId = value["clientId"];
  if (clientId !== void 0 && (typeof clientId !== "string" || clientId.length === 0)) {
    return false;
  }
  return true;
}
__name(isPermissionForbiddenData, "isPermissionForbiddenData");
function isModelSwitchedData(value) {
  return isRecord(value) && isNonEmptyString(value["sessionId"]) && isNonEmptyString(value["modelId"]);
}
__name(isModelSwitchedData, "isModelSwitchedData");
function isModelSwitchFailedData(value) {
  return isRecord(value) && isNonEmptyString(value["sessionId"]) && isNonEmptyString(value["requestedModelId"]) && isNonEmptyString(value["error"]);
}
__name(isModelSwitchFailedData, "isModelSwitchFailedData");
function isSessionDiedData(value) {
  return isRecord(value) && isNonEmptyString(value["sessionId"]) && isNonEmptyString(value["reason"]) && isOptionalNumberOrNull(value["exitCode"]) && isOptionalStringOrNull(value["signalCode"]);
}
__name(isSessionDiedData, "isSessionDiedData");
function isSessionClosedData(value) {
  return isRecord(value) && isNonEmptyString(value["sessionId"]) && isNonEmptyString(value["reason"]) && isOptionalStringOrNull(value["closedBy"]);
}
__name(isSessionClosedData, "isSessionClosedData");
function isSessionMetadataUpdatedData(value) {
  if (!isRecord(value) || !isNonEmptyString(value["sessionId"]) || !isOptionalStringOrNull(value["displayName"]) || value["titleSource"] !== void 0 && value["titleSource"] !== "manual" && value["titleSource"] !== "auto") {
    return false;
  }
  const prs = value["prs"];
  return prs === void 0 || Array.isArray(prs) && prs.every(isDaemonSessionPrInfo);
}
__name(isSessionMetadataUpdatedData, "isSessionMetadataUpdatedData");
function isArtifactChangedData(value) {
  if (!isRecord(value) || !isNonEmptyString(value["sessionId"])) {
    return false;
  }
  const change = value["change"];
  if (!isRecord(change) || !isNonEmptyString(change["artifactId"])) {
    return false;
  }
  return isNonEmptyString(change["action"]) && (change["reason"] === void 0 || isNonEmptyString(change["reason"]));
}
__name(isArtifactChangedData, "isArtifactChangedData");
function asMidTurnMessageInjectedData(value) {
  if (!isRecord(value) || !isNonEmptyString(value["sessionId"]) || !Array.isArray(value["messages"]) || !value["messages"].every((message) => typeof message === "string")) {
    return void 0;
  }
  const messageIds = value["messageIds"];
  const alignedMessageIds = Array.isArray(messageIds) && messageIds.length === value["messages"].length && messageIds.every(isNonEmptyString) ? messageIds : void 0;
  const { messageIds: _rawMessageIds, ...rest } = value;
  return {
    ...rest,
    messages: value["messages"],
    ...alignedMessageIds ? { messageIds: alignedMessageIds } : {}
  };
}
__name(asMidTurnMessageInjectedData, "asMidTurnMessageInjectedData");
function isPendingPromptAddedData(value) {
  return isRecord(value) && isNonEmptyString(value["sessionId"]) && isNonEmptyString(value["promptId"]) && typeof value["text"] === "string" && typeof value["queuedAt"] === "number";
}
__name(isPendingPromptAddedData, "isPendingPromptAddedData");
function isPendingPromptStartedData(value) {
  return isRecord(value) && isNonEmptyString(value["sessionId"]) && isNonEmptyString(value["promptId"]) && typeof value["text"] === "string";
}
__name(isPendingPromptStartedData, "isPendingPromptStartedData");
function isPendingPromptCompletedData(value) {
  return isRecord(value) && isNonEmptyString(value["sessionId"]) && isNonEmptyString(value["promptId"]) && (value["state"] === "completed" || value["state"] === "removed");
}
__name(isPendingPromptCompletedData, "isPendingPromptCompletedData");
function isClientEvictedData(value) {
  return isRecord(value) && isNonEmptyString(value["reason"]) && isOptionalNumber(value["droppedAfter"]) && isOptionalNumber(value["queueSize"]) && isOptionalNumber(value["maxQueued"]) && isOptionalNumber(value["queuedBytes"]) && isOptionalNumber(value["maxQueuedBytes"]) && isOptionalNumber(value["eventBytes"]);
}
__name(isClientEvictedData, "isClientEvictedData");
function isStateResyncRequiredData(value) {
  return isRecord(value) && isNonEmptyString(value["reason"]) && isFiniteNumber(value["lastDeliveredId"]) && isFiniteNumber(value["earliestAvailableId"]);
}
__name(isStateResyncRequiredData, "isStateResyncRequiredData");
function isHistoryTruncatedData(value) {
  if (!isRecord(value) || value["reason"] !== "replay_window_exceeded" || !isFiniteNumber(value["truncatedEvents"]) || !isFiniteNumber(value["retainedEvents"]) || !isFiniteNumber(value["maxBytes"]) || typeof value["fullTranscriptAvailable"] !== "boolean") {
    return false;
  }
  const truncatedTurns = value["truncatedTurns"];
  const scope = value["scope"];
  const maxEvents = value["maxEvents"];
  return isNonNegativeInteger(value["truncatedEvents"]) && isNonNegativeInteger(value["retainedEvents"]) && isNonNegativeInteger(value["maxBytes"]) && (scope === void 0 || isNonEmptyString(scope)) && (maxEvents === void 0 || isNonNegativeInteger(maxEvents)) && (truncatedTurns === void 0 || isNonNegativeInteger(truncatedTurns));
}
__name(isHistoryTruncatedData, "isHistoryTruncatedData");
function isSlowClientWarningData(value) {
  if (!isRecord(value)) return false;
  const threshold = value["threshold"];
  return isFiniteNumber(value["queueSize"]) && isFiniteNumber(value["maxQueued"]) && isFiniteNumber(value["lastEventId"]) && isOptionalNumber(value["queuedBytes"]) && isOptionalNumber(value["maxQueuedBytes"]) && (threshold === void 0 || threshold === "frames" || threshold === "bytes" || threshold === "frames_and_bytes");
}
__name(isSlowClientWarningData, "isSlowClientWarningData");
function isStreamErrorData(value) {
  return isRecord(value) && isNonEmptyString(value["error"]);
}
__name(isStreamErrorData, "isStreamErrorData");
function isMcpBudgetWarningData(value) {
  return isRecord(value) && isFiniteNumber(value["liveCount"]) && isFiniteNumber(value["reservedCount"]) && isFiniteNumber(value["budget"]) && isFiniteNumber(value["thresholdRatio"]) && (value["mode"] === "warn" || value["mode"] === "enforce");
}
__name(isMcpBudgetWarningData, "isMcpBudgetWarningData");
function isMcpRefusedServerEntry(value) {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value["name"])) return false;
  if (value["reason"] !== "budget_exhausted") return false;
  const transport = value["transport"];
  return transport === "stdio" || transport === "sse" || transport === "http" || transport === "websocket" || transport === "sdk" || transport === "unknown";
}
__name(isMcpRefusedServerEntry, "isMcpRefusedServerEntry");
function isMcpChildRefusedBatchData(value) {
  return isRecord(value) && Array.isArray(value["refusedServers"]) && value["refusedServers"].every(isMcpRefusedServerEntry) && isFiniteNumber(value["budget"]) && isFiniteNumber(value["liveCount"]) && isFiniteNumber(value["reservedCount"]) && // `mode` is a literal `'enforce'` — `warn` mode never refuses, so
  // `'warn'`-tagged refusal payloads are protocol garbage. Reject
  // them so the reducer sees the raw event under the
  // `unrecognizedKnownEventCount` branch instead of silently
  // accepting a malformed shape.
  value["mode"] === "enforce";
}
__name(isMcpChildRefusedBatchData, "isMcpChildRefusedBatchData");
function isMemoryChangedData(value) {
  if (!isRecord(value)) return false;
  const scope = value["scope"];
  if (scope === "managed") {
    const touchedScopes = value["touchedScopes"];
    return isNonEmptyString(value["source"]) && isNonEmptyString(value["taskId"]) && Array.isArray(touchedScopes) && touchedScopes.every((s) => s === "user" || s === "project");
  }
  const mode = value["mode"];
  return (scope === "workspace" || scope === "global") && isNonEmptyString(value["filePath"]) && (mode === "append" || mode === "replace") && isFiniteNumber(value["bytesWritten"]);
}
__name(isMemoryChangedData, "isMemoryChangedData");
function isAgentChangedData(value) {
  if (!isRecord(value)) return false;
  const change = value["change"];
  const level = value["level"];
  return (change === "created" || change === "updated" || change === "deleted") && isNonEmptyString(value["name"]) && (level === "project" || level === "user");
}
__name(isAgentChangedData, "isAgentChangedData");
function isAuthDeviceFlowStartedData(value) {
  return isRecord(value) && isNonEmptyString(value["deviceFlowId"]) && isNonEmptyString(value["providerId"]) && isFiniteNumber(value["expiresAt"]);
}
__name(isAuthDeviceFlowStartedData, "isAuthDeviceFlowStartedData");
function isAuthDeviceFlowThrottledData(value) {
  return isRecord(value) && isNonEmptyString(value["deviceFlowId"]) && isFiniteNumber(value["intervalMs"]);
}
__name(isAuthDeviceFlowThrottledData, "isAuthDeviceFlowThrottledData");
function isAuthDeviceFlowAuthorizedData(value) {
  return isRecord(value) && isNonEmptyString(value["deviceFlowId"]) && isNonEmptyString(value["providerId"]) && isOptionalNumber(value["expiresAt"]) && isOptionalStringOrNull(value["accountAlias"]);
}
__name(isAuthDeviceFlowAuthorizedData, "isAuthDeviceFlowAuthorizedData");
function isAuthDeviceFlowFailedData(value) {
  return isRecord(value) && isNonEmptyString(value["deviceFlowId"]) && isAuthDeviceFlowErrorKind(value["errorKind"]) && isOptionalStringOrNull(value["hint"]);
}
__name(isAuthDeviceFlowFailedData, "isAuthDeviceFlowFailedData");
function isAuthDeviceFlowCancelledData(value) {
  return isRecord(value) && isNonEmptyString(value["deviceFlowId"]);
}
__name(isAuthDeviceFlowCancelledData, "isAuthDeviceFlowCancelledData");
function isAuthDeviceFlowErrorKind(value) {
  return typeof value === "string" && value.length > 0;
}
__name(isAuthDeviceFlowErrorKind, "isAuthDeviceFlowErrorKind");
function mergeOriginator(data, event) {
  if (data.originatorClientId !== void 0) return data;
  if (event.originatorClientId === void 0) return data;
  return { ...data, originatorClientId: event.originatorClientId };
}
__name(mergeOriginator, "mergeOriginator");
function isApprovalModeChangedData(value) {
  return isRecord(value) && isNonEmptyString(value["sessionId"]) && isNonEmptyString(value["previous"]) && isNonEmptyString(value["next"]) && (value["planExecutionMode"] === void 0 || isNonEmptyString(value["planExecutionMode"])) && typeof value["persisted"] === "boolean";
}
__name(isApprovalModeChangedData, "isApprovalModeChangedData");
function isToolToggledData(value) {
  return isRecord(value) && isNonEmptyString(value["toolName"]) && typeof value["enabled"] === "boolean";
}
__name(isToolToggledData, "isToolToggledData");
function isDaemonSkillToggleMutation(value) {
  if (!isRecord(value)) return false;
  const activation = value["activation"];
  const skills = value["skills"];
  return isNonEmptyString(value["id"]) && value["kind"] === "skill_toggle" && Array.isArray(skills) && skills.length > 0 && skills.every(
    (skill) => isRecord(skill) && isNonEmptyString(skill["name"]) && typeof skill["enabled"] === "boolean"
  ) && (activation === "applied" || activation === "deferred" || activation === "reconciling" || activation === "partial") && isFiniteNumber(value["sessionsRefreshed"]) && isFiniteNumber(value["sessionsFailed"]);
}
__name(isDaemonSkillToggleMutation, "isDaemonSkillToggleMutation");
function isSettingsChangedData(value) {
  return isRecord(value) && isNonEmptyString(value["key"]) && (value["scope"] === void 0 || typeof value["scope"] === "string") && (value["mutation"] === void 0 || isDaemonSkillToggleMutation(value["mutation"]));
}
__name(isSettingsChangedData, "isSettingsChangedData");
function isTrustChangeRequestedData(value) {
  if (!isRecord(value)) return false;
  const desiredState = value["desiredState"];
  return isNonEmptyString(value["workspaceCwd"]) && (desiredState === "trusted" || desiredState === "untrusted") && (value["reason"] === void 0 || typeof value["reason"] === "string");
}
__name(isTrustChangeRequestedData, "isTrustChangeRequestedData");
function isWorkspaceInitializedData(value) {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value["path"])) return false;
  const action = value["action"];
  return action === "created" || action === "overwrote" || action === "noop";
}
__name(isWorkspaceInitializedData, "isWorkspaceInitializedData");
function isGithubSetupCompletedData(value) {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value["releaseTag"])) return false;
  if (!isNonEmptyString(value["readmeUrl"])) return false;
  if (!Array.isArray(value["workflows"])) return false;
  if (!value["workflows"].every(isGithubSetupWorkflowResult)) return false;
  if (!isGithubSetupGitignoreResult(value["gitignore"])) return false;
  return Array.isArray(value["warnings"]) && value["warnings"].every((warning) => typeof warning === "string");
}
__name(isGithubSetupCompletedData, "isGithubSetupCompletedData");
function isGithubSetupWorkflowResult(value) {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value["path"])) return false;
  const status = value["status"];
  if (status !== "written" && status !== "failed") return false;
  if (value["sizeBytes"] !== void 0 && !isFiniteNumber(value["sizeBytes"])) {
    return false;
  }
  return value["error"] === void 0 || typeof value["error"] === "string";
}
__name(isGithubSetupWorkflowResult, "isGithubSetupWorkflowResult");
function isGithubSetupGitignoreResult(value) {
  if (!isRecord(value)) return false;
  if (value["path"] !== ".gitignore") return false;
  const status = value["status"];
  return status === "created" || status === "updated" || status === "unchanged" || status === "failed" || status === "skipped";
}
__name(isGithubSetupGitignoreResult, "isGithubSetupGitignoreResult");
function isMcpServerRestartedData(value) {
  return isRecord(value) && isNonEmptyString(value["serverName"]) && isFiniteNumber(value["durationMs"]);
}
__name(isMcpServerRestartedData, "isMcpServerRestartedData");
var MCP_RESTART_REFUSED_REASONS = /* @__PURE__ */ new Set([
  "in_flight",
  "disabled",
  "budget_would_exceed",
  "authentication_required",
  // Pool-mode hard restart failure (entry's `client.connect()` or
  // rediscover threw). Carried alongside the soft-skip reasons so
  // SDK reducers maintain a single union for narrowing the event's
  // `reason` field.
  "restart_failed"
]);
function isMcpServerRestartRefusedData(value) {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value["serverName"])) return false;
  return typeof value["reason"] === "string" && MCP_RESTART_REFUSED_REASONS.has(value["reason"]);
}
__name(isMcpServerRestartRefusedData, "isMcpServerRestartRefusedData");
function isFollowupSuggestionData(value) {
  return isRecord(value) && isNonEmptyString(value["sessionId"]) && isNonEmptyString(value["suggestion"]) && isNonEmptyString(value["promptId"]);
}
__name(isFollowupSuggestionData, "isFollowupSuggestionData");
var CHANNEL_DELIVERY_ERROR_CODES = /* @__PURE__ */ new Set([
  "channel_worker_unavailable",
  "channel_delivery_timeout",
  "channel_delivery_invalid",
  "channel_delivery_rejected",
  "channel_delivery_queue_full",
  "channel_delivery_failed"
]);
function isChannelDeliveryResultData(value) {
  if (!isRecord(value) || !isNonEmptyString(value["sessionId"]) || !isNonEmptyString(value["deliveryId"]) || value["status"] !== "delivered" && value["status"] !== "failed" && value["status"] !== "skipped" || !Object.keys(value).every(
    (key) => [
      "sessionId",
      "deliveryId",
      "source",
      "status",
      "promptId",
      "taskId",
      "firedAt",
      "code",
      "error"
    ].includes(key)
  )) {
    return false;
  }
  const correlationValid = value["source"] === "prompt" && isNonEmptyString(value["promptId"]) && value["taskId"] === void 0 && value["firedAt"] === void 0 || value["source"] === "scheduled" && isNonEmptyString(value["taskId"]) && isFiniteNumber(value["firedAt"]) && value["promptId"] === void 0;
  if (!correlationValid) return false;
  if (value["status"] === "failed") {
    return typeof value["code"] === "string" && CHANNEL_DELIVERY_ERROR_CODES.has(value["code"]) && isNonEmptyString(value["error"]);
  }
  return value["code"] === void 0 && value["error"] === void 0;
}
__name(isChannelDeliveryResultData, "isChannelDeliveryResultData");
function isMcpServerAddedData(value) {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value["name"])) return false;
  if (typeof value["replaced"] !== "boolean") return false;
  if (typeof value["shadowedSettings"] !== "boolean") return false;
  if (!isFiniteNumber(value["toolCount"])) return false;
  if (!isNonEmptyString(value["originatorClientId"])) return false;
  const transport = value["transport"];
  return transport === "stdio" || transport === "sse" || transport === "http" || transport === "websocket" || transport === "sdk" || transport === "unknown";
}
__name(isMcpServerAddedData, "isMcpServerAddedData");
function isTurnCompleteData(value) {
  return isRecord(value) && isNonEmptyString(value["sessionId"]) && isNonEmptyString(value["stopReason"]);
}
__name(isTurnCompleteData, "isTurnCompleteData");
function isTurnErrorData(value) {
  return isRecord(value) && isNonEmptyString(value["sessionId"]) && isNonEmptyString(value["message"]);
}
__name(isTurnErrorData, "isTurnErrorData");
function isMcpServerRemovedData(value) {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value["name"])) return false;
  if (typeof value["wasShadowingSettings"] !== "boolean") return false;
  if (!isNonEmptyString(value["originatorClientId"])) return false;
  return true;
}
__name(isMcpServerRemovedData, "isMcpServerRemovedData");
function isMcpServerChangedData(value) {
  if (!isRecord(value) || !isNonEmptyString(value["serverName"])) {
    return false;
  }
  return value["action"] === "approve" || value["action"] === "enable" || value["action"] === "disable" || value["action"] === "authenticate" || value["action"] === "clear-auth";
}
__name(isMcpServerChangedData, "isMcpServerChangedData");
function isExtensionsChangedData(value) {
  if (!isRecord(value)) return false;
  if (typeof value["refreshed"] !== "number") return false;
  if (typeof value["failed"] !== "number") return false;
  if (value["status"] !== void 0 && value["status"] !== "installed" && value["status"] !== "enabled" && value["status"] !== "disabled" && value["status"] !== "updated" && value["status"] !== "uninstalled" && value["status"] !== "failed") {
    return false;
  }
  if (value["source"] !== void 0 && typeof value["source"] !== "string") {
    return false;
  }
  if (value["name"] !== void 0 && typeof value["name"] !== "string") {
    return false;
  }
  if (value["version"] !== void 0 && typeof value["version"] !== "string") {
    return false;
  }
  if (value["error"] !== void 0 && typeof value["error"] !== "string") {
    return false;
  }
  return true;
}
__name(isExtensionsChangedData, "isExtensionsChangedData");
function isSessionBranchedData(value) {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value["sourceSessionId"]) && isNonEmptyString(value["newSessionId"]) && isNonEmptyString(value["displayName"]);
}
__name(isSessionBranchedData, "isSessionBranchedData");
function isSessionSnapshotData(value) {
  if (!isRecord(value) || !isNonEmptyString(value["sessionId"])) return false;
  const model = value["currentModelId"];
  const mode = value["currentApprovalMode"];
  const recordingDegraded = value["recordingDegraded"];
  return (model === null || typeof model === "string") && (mode === null || typeof mode === "string") && (value["planExecutionMode"] === void 0 || isNonEmptyString(value["planExecutionMode"])) && (recordingDegraded === void 0 || typeof recordingDegraded === "boolean");
}
__name(isSessionSnapshotData, "isSessionSnapshotData");
function isSessionRecordingDegradedData(value) {
  return isRecord(value) && isNonEmptyString(value["sessionId"]) && value["reason"] === "write_failed";
}
__name(isSessionRecordingDegradedData, "isSessionRecordingDegradedData");
function isPermissionOption(value) {
  return isRecord(value) && isNonEmptyString(value["optionId"]);
}
__name(isPermissionOption, "isPermissionOption");
function isPermissionOutcome(value) {
  if (!isRecord(value)) return false;
  if (value["outcome"] === "cancelled") return true;
  return value["outcome"] === "selected" && isNonEmptyString(value["optionId"]);
}
__name(isPermissionOutcome, "isPermissionOutcome");
function getString(record, key) {
  const value = record[key];
  return typeof value === "string" ? value : void 0;
}
__name(getString, "getString");
function isOptionalNumber(value) {
  return value === void 0 || isFiniteNumber(value);
}
__name(isOptionalNumber, "isOptionalNumber");
function isOptionalNumberOrNull(value) {
  return value === void 0 || value === null || isFiniteNumber(value);
}
__name(isOptionalNumberOrNull, "isOptionalNumberOrNull");
function isNonNegativeInteger(value) {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}
__name(isNonNegativeInteger, "isNonNegativeInteger");
function isOptionalStringOrNull(value) {
  return value === void 0 || value === null || typeof value === "string";
}
__name(isOptionalStringOrNull, "isOptionalStringOrNull");
function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}
__name(isNonEmptyString, "isNonEmptyString");
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
__name(isFiniteNumber, "isFiniteNumber");
function isRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
__name(isRecord, "isRecord");
function advanceLastEventId(state, eventId) {
  if (eventId === void 0 || !Number.isFinite(eventId)) return state;
  const lastEventId = Math.max(state.lastEventId ?? 0, eventId);
  if (lastEventId === state.lastEventId) return state;
  return { ...state, lastEventId };
}
__name(advanceLastEventId, "advanceLastEventId");
function clonePermissionRequestData(data) {
  return {
    ...data,
    options: data.options.map((option) => ({ ...option }))
  };
}
__name(clonePermissionRequestData, "clonePermissionRequestData");

// packages/sdk-typescript/src/daemon/ui/index.ts
init_esbuild_shims();

// packages/sdk-typescript/src/daemon/ui/normalizer.ts
init_esbuild_shims();

// packages/sdk-typescript/src/daemon/ui/types.ts
init_esbuild_shims();
var DAEMON_PLAN_TOOL_CALL_ID = "daemon-plan";
var DAEMON_UI_DEBUG_REASONS = [
  "unrecognized_event",
  "unrecognized_session_update",
  "malformed_payload"
];
var DAEMON_UI_UNRECOGNIZED_DIAGNOSTIC_REASONS = [
  "unrecognized_event",
  "unrecognized_session_update"
];
function isUnrecognizedDiagnosticReason(reason) {
  return reason !== void 0 && DAEMON_UI_UNRECOGNIZED_DIAGNOSTIC_REASONS.includes(
    reason
  );
}
__name(isUnrecognizedDiagnosticReason, "isUnrecognizedDiagnosticReason");

// packages/sdk-typescript/src/daemon/ui/toolPreview.ts
init_esbuild_shims();

// packages/sdk-typescript/src/daemon/ui/utils.ts
init_esbuild_shims();
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
__name(isRecord2, "isRecord");
function getString2(value, key) {
  if (!isRecord2(value)) return void 0;
  const entry = value[key];
  return typeof entry === "string" ? entry : void 0;
}
__name(getString2, "getString");
function getFirstString(value, keys) {
  if (!isRecord2(value)) return void 0;
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim().length > 0) {
      return entry;
    }
  }
  return void 0;
}
__name(getFirstString, "getFirstString");
function stringifyJson(value) {
  if (value === void 0) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
__name(stringifyJson, "stringifyJson");
function stringifyRedactedJson(value) {
  return stringifyJson(redactSensitiveFields(value));
}
__name(stringifyRedactedJson, "stringifyRedactedJson");
var MAX_DETAILS_LENGTH = 4096;
function detachString(value) {
  return new TextDecoder("utf-8").decode(new TextEncoder().encode(value));
}
__name(detachString, "detachString");
function capDetails(details) {
  if (details.length <= MAX_DETAILS_LENGTH) return details;
  return `${detachString(details.slice(0, MAX_DETAILS_LENGTH))}... [truncated]`;
}
__name(capDetails, "capDetails");
function redactSensitiveFields(value, depth = 0) {
  if (depth > 16) return "[truncated]";
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveFields(entry, depth + 1));
  }
  if (!isRecord2(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveKey(key) ? "[redacted]" : redactSensitiveFields(entry, depth + 1)
    ])
  );
}
__name(redactSensitiveFields, "redactSensitiveFields");
function isSensitiveKey(key) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    // Exact matches — only keep names NOT already covered by the suffix
    // / substring rules below. wenshao R3 (qwen3.7-max): the following
    // were redundant and removed — `password` / `apikey` / `idtoken` /
    // `sessiontoken` / `clientsecret` / `xapikey` / `xauthtoken` —
    // already caught by `endsWith('password' | 'token' | 'secret' |
    // 'apikey')` respectively.
    normalized === "authorization" || normalized === "auth" || normalized === "cookie" || normalized === "setcookie" || normalized === "credential" || normalized === "credentials" || normalized === "passphrase" || normalized === "xauthkey" || // Suffix matches — each pattern listed once.
    normalized.endsWith("password") || normalized.endsWith("token") || normalized.endsWith("secret") || normalized.endsWith("secretkey") || normalized.endsWith("accesskey") || normalized.endsWith("apikey") || normalized.endsWith("privatekey") || // Token-shaped substrings.
    normalized.includes("accesstoken") || normalized.includes("refreshtoken") || normalized.includes("bearertoken") || normalized.includes("personalaccesstoken")
  );
}
__name(isSensitiveKey, "isSensitiveKey");
function getTextContent(value) {
  if (typeof value === "string") return value;
  if (!isRecord2(value)) return "";
  const text = value["text"];
  return typeof text === "string" ? text : "";
}
__name(getTextContent, "getTextContent");
function extractContentPart(value) {
  if (typeof value === "string") return { kind: "text", text: value };
  if (!isRecord2(value)) return void 0;
  const type = value["type"];
  if (type === "text" || type === void 0) {
    const text = value["text"];
    if (typeof text === "string") return { kind: "text", text };
    return void 0;
  }
  if (type === "image") {
    const source = isRecord2(value["source"]) ? value["source"] : void 0;
    let url;
    let data;
    if (source) {
      url = typeof source["url"] === "string" ? source["url"] : void 0;
      data = typeof source["data"] === "string" ? source["data"] : void 0;
    }
    if (!url && !data) {
      data = typeof value["data"] === "string" ? value["data"] : void 0;
      url = typeof value["url"] === "string" ? value["url"] : void 0;
    }
    if (!url && !data) return void 0;
    const mediaType = (typeof value["mediaType"] === "string" ? value["mediaType"] : void 0) ?? (typeof value["mimeType"] === "string" ? value["mimeType"] : void 0) ?? (typeof value["media_type"] === "string" ? value["media_type"] : void 0) ?? (source && typeof source["mediaType"] === "string" ? source["mediaType"] : void 0) ?? "image/*";
    return {
      kind: "image",
      mediaType,
      source: { ...url ? { url } : {}, ...data ? { data } : {} }
    };
  }
  if (type === "audio") {
    const source = isRecord2(value["source"]) ? value["source"] : void 0;
    if (!source) return void 0;
    const mediaType = (typeof value["mediaType"] === "string" ? value["mediaType"] : void 0) ?? "audio/*";
    const url = typeof source["url"] === "string" ? source["url"] : void 0;
    const data = typeof source["data"] === "string" ? source["data"] : void 0;
    if (!url && !data) return void 0;
    return {
      kind: "audio",
      mediaType,
      source: { ...url ? { url } : {}, ...data ? { data } : {} }
    };
  }
  if (type === "resource" || type === "resource_link") {
    const uri = typeof value["uri"] === "string" ? value["uri"] : void 0;
    if (!uri) return void 0;
    const mediaType = typeof value["mediaType"] === "string" ? value["mediaType"] : void 0;
    const description = typeof value["description"] === "string" ? value["description"] : void 0;
    return {
      kind: "resource",
      uri,
      ...mediaType ? { mediaType } : {},
      ...description ? { description } : {}
    };
  }
  return void 0;
}
__name(extractContentPart, "extractContentPart");
var MAX_OUTPUT_TEXT_DEPTH = 64;
function getOutputText(value, depth = 0) {
  if (depth > MAX_OUTPUT_TEXT_DEPTH) return "[output truncated]";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => getOutputText(entry, depth + 1)).filter(Boolean).join("\n");
  }
  if (!isRecord2(value)) return value === void 0 ? "" : stringifyJson(value);
  for (const key of ["text", "output", "stdout", "stderr", "rawOutput"]) {
    const entry = value[key];
    if (typeof entry === "string") return entry;
  }
  const content = value["content"];
  if (content !== void 0) {
    const nested = getOutputText(content, depth + 1);
    if (nested) return nested;
  }
  return stringifyJson(value);
}
__name(getOutputText, "getOutputText");
function sanitizeTerminalText(text) {
  return text.replace(bidiControlPattern, "").replace(oscSequencePattern, "").replace(dcsSequencePattern, "").replace(csiSequencePattern, "").replace(controlCharactersPattern, "");
}
__name(sanitizeTerminalText, "sanitizeTerminalText");
function stripOscSequences(text) {
  return text.replace(oscSequencePattern, "");
}
__name(stripOscSequences, "stripOscSequences");
var nul = String.fromCharCode(0);
var backspace = String.fromCharCode(8);
var verticalTab = String.fromCharCode(11);
var formFeed = String.fromCharCode(12);
var carriageReturn = String.fromCharCode(13);
var shiftOut = String.fromCharCode(14);
var unitSeparator = String.fromCharCode(31);
var deleteChar = String.fromCharCode(127);
var c1End = String.fromCharCode(159);
var escapeChar = String.fromCharCode(27);
var bell = String.fromCharCode(7);
var controlCharactersPattern = new RegExp(
  `[${nul}-${backspace}${verticalTab}${formFeed}${carriageReturn}${shiftOut}-${unitSeparator}${deleteChar}-${c1End}]`,
  "g"
);
var oscSequencePattern = new RegExp(
  `${escapeChar}\\][^${bell}${escapeChar}]*(?:${bell}|${escapeChar}\\\\)`,
  "g"
);
var dcsSequencePattern = new RegExp(
  `${escapeChar}P[^${escapeChar}]*${escapeChar}\\\\`,
  "g"
);
var csiSequencePattern = new RegExp(`${escapeChar}\\[[0-?]*[ -/]*[@-~]`, "g");
var bidiControlPattern = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

// packages/sdk-typescript/src/daemon/ui/toolPreview.ts
var MAX_TOOL_PREVIEW_DEPTH = 8;
var MAX_TOOL_PREVIEW_ENTRIES = 1e3;
var MAX_TOOL_RESULT_PREVIEW_LENGTH = 1e5;
var MAX_TODO_ID_LENGTH = 512;
function createDaemonToolPreview(input, opts = {}, depth = 0) {
  if (depth > MAX_TOOL_PREVIEW_DEPTH) {
    const summary2 = opts.title ?? opts.toolName ?? opts.toolKind;
    return { kind: "generic", ...summary2 ? { summary: summary2 } : {} };
  }
  if (isRecord2(input)) {
    const nestedInput = input["rawInput"] ?? input["input"] ?? input["args"];
    if (nestedInput !== void 0 && nestedInput !== input) {
      const meta = isRecord2(input["_meta"]) ? input["_meta"] : void 0;
      const nested = createDaemonToolPreview(
        nestedInput,
        {
          title: opts.title ?? getFirstString(input, ["title"]),
          toolName: opts.toolName ?? getFirstString(input, ["toolName", "name"]) ?? (meta ? getFirstString(meta, ["toolName"]) : void 0),
          toolKind: opts.toolKind ?? getFirstString(input, ["kind"])
        },
        depth + 1
      );
      if (nested.kind !== "generic" || !nested.summary) return nested;
    }
  }
  const askUserQuestions = extractAskUserQuestions(input);
  if (askUserQuestions.length > 0) {
    return { kind: "ask_user_question", questions: askUserQuestions };
  }
  const todoList = detectTodoList(input, opts, true);
  if (todoList) return todoList;
  const mcpPreview = detectMcpInvocation(input, opts);
  if (mcpPreview) return mcpPreview;
  const subagent = detectSubagentDelegation(input, opts);
  if (subagent) return subagent;
  const search = detectSearch(input, opts);
  if (search) return search;
  const imageGeneration = detectImageGeneration(input, opts);
  if (imageGeneration) return imageGeneration;
  const fileDiff = detectFileDiff(input, opts);
  if (fileDiff) return fileDiff;
  const fileRead = detectFileRead(input, opts);
  if (fileRead) return fileRead;
  const webFetch = detectWebFetch(input);
  if (webFetch) return webFetch;
  const codeBlock = detectCodeBlock(input, opts);
  if (codeBlock) return codeBlock;
  const tabular = detectTabular(input);
  if (tabular) return tabular;
  if (isRecord2(input)) {
    const command = getFirstString(input, ["command", "cmd"]);
    if (command) {
      const cwd = getFirstString(input, [
        "cwd",
        "directory",
        "workingDirectory"
      ]);
      return { kind: "command", command, ...cwd ? { cwd } : {} };
    }
    const rows = collectPreviewRows(input);
    if (rows.length > 0) {
      return { kind: "key_value", rows };
    }
  }
  const summary = opts.title ?? opts.toolName ?? opts.toolKind;
  return { kind: "generic", ...summary ? { summary } : {} };
}
__name(createDaemonToolPreview, "createDaemonToolPreview");
function createDaemonToolResultPreview(output, content, opts = {}) {
  if (isRecord2(output) && output["type"] === "ask_user_question_answers" && typeof output["text"] === "string") {
    const text = output["text"];
    const fallback = createDaemonToolResultTextPreview(text);
    const entries = output["answers"];
    if (!Array.isArray(entries) || entries.length > MAX_TOOL_PREVIEW_ENTRIES) {
      return fallback;
    }
    let remaining = MAX_TOOL_RESULT_PREVIEW_LENGTH - text.length;
    const answers = [];
    for (const entry of entries) {
      if (!isRecord2(entry) || typeof entry["question"] !== "string" || typeof entry["answer"] !== "string") {
        return fallback;
      }
      const question = entry["question"];
      const answer = entry["answer"];
      remaining -= question.length + answer.length;
      if (remaining < 0) return fallback;
      answers.push({ question, answer });
    }
    return remaining >= 0 ? { kind: "question_answers", text, answers } : fallback;
  }
  const todoList = detectTodoList(output, opts, false);
  if (todoList) return todoList;
  return createDaemonToolResultTextPreview(
    extractDisplayContentText(content) ?? ""
  );
}
__name(createDaemonToolResultPreview, "createDaemonToolResultPreview");
function createDaemonToolResultTextPreview(text) {
  return text.length > 0 && text.length <= MAX_TOOL_RESULT_PREVIEW_LENGTH ? { kind: "text", text } : void 0;
}
__name(createDaemonToolResultTextPreview, "createDaemonToolResultTextPreview");
function detectTodoList(input, opts, includeLegacySummary) {
  if (!isRecord2(input)) return void 0;
  const toolName = opts.toolName?.toLowerCase();
  const entries = Array.isArray(input["entries"]) ? input["entries"] : Array.isArray(input["todos"]) ? input["todos"] : void 0;
  if (!entries || toolName !== "todo_write" && toolName !== "todowrite") {
    return void 0;
  }
  const retainedEntries = entries.slice(0, MAX_TOOL_PREVIEW_ENTRIES);
  const authoredIds = /* @__PURE__ */ new Set();
  for (const entry of retainedEntries) {
    if (!isRecord2(entry)) continue;
    const meta2 = isRecord2(entry["_meta"]) ? entry["_meta"] : void 0;
    const qwenTodo = meta2 && isRecord2(meta2["qwenTodo"]) ? meta2["qwenTodo"] : void 0;
    const authoredId = getFirstString(qwenTodo, ["id"]) ?? getFirstString(entry, ["id"]);
    if (authoredId && authoredId.length <= MAX_TODO_ID_LENGTH) {
      authoredIds.add(authoredId);
    }
  }
  const normalized = [];
  const usedIds = /* @__PURE__ */ new Set();
  let truncated = entries.length > MAX_TOOL_PREVIEW_ENTRIES;
  let remainingText = MAX_TOOL_RESULT_PREVIEW_LENGTH;
  let remainingDependencyInputs = MAX_TOOL_PREVIEW_ENTRIES;
  retainedEntries.forEach((entry, index) => {
    if (!isRecord2(entry)) {
      truncated = true;
      return;
    }
    const rawContent = getFirstString(entry, ["content", "text", "title"]);
    if (!rawContent) {
      truncated = true;
      return;
    }
    if (remainingText === 0) {
      truncated = true;
      return;
    }
    const content = detachString(rawContent.slice(0, remainingText));
    if (content.length < rawContent.length) truncated = true;
    remainingText -= content.length;
    const meta2 = isRecord2(entry["_meta"]) ? entry["_meta"] : void 0;
    const qwenTodo = meta2 && isRecord2(meta2["qwenTodo"]) ? meta2["qwenTodo"] : void 0;
    const qwenTodoId = getFirstString(qwenTodo, ["id"]);
    const entryId = getFirstString(entry, ["id"]);
    const authoredId = qwenTodoId ?? entryId;
    const rawId = authoredId ?? `plan-${index}`;
    if (qwenTodo?.["id"] !== void 0 !== !!qwenTodoId || entry["id"] !== void 0 !== !!entryId) {
      truncated = true;
    }
    let id = rawId.length <= MAX_TODO_ID_LENGTH ? rawId : `plan-${index}`;
    if (id !== rawId) truncated = true;
    const idWasSynthesized = authoredId === void 0 || id !== rawId;
    if (usedIds.has(id) || idWasSynthesized && authoredIds.has(id)) {
      id = allocateUniqueTodoId(id, authoredIds, usedIds);
    }
    usedIds.add(id);
    const rawStatus = getFirstString(entry, ["status"]);
    if (entry["status"] !== void 0 && rawStatus === void 0) {
      truncated = true;
    }
    const status = rawStatus === "completed" || rawStatus === "in_progress" ? rawStatus : "pending";
    if (rawStatus !== void 0 && rawStatus !== "pending" && rawStatus !== "in_progress" && rawStatus !== "completed") {
      truncated = true;
    }
    const rawPriority = getFirstString(entry, ["priority"]);
    const priority = rawPriority === "high" || rawPriority === "medium" || rawPriority === "low" ? rawPriority : void 0;
    if (entry["priority"] !== void 0 !== !!priority) {
      truncated = true;
    }
    const blockedBySource = qwenTodo?.["blockedBy"] ?? entry["blockedBy"];
    const rawBlockedBy = Array.isArray(blockedBySource) ? blockedBySource : [];
    if (blockedBySource !== void 0 && !Array.isArray(blockedBySource)) {
      truncated = true;
    }
    const blockedBy = [];
    for (const dependency of rawBlockedBy) {
      if (remainingDependencyInputs === 0) {
        truncated = true;
        break;
      }
      remainingDependencyInputs -= 1;
      if (typeof dependency !== "string" || dependency.length === 0 || dependency.length > MAX_TODO_ID_LENGTH) {
        truncated = true;
        continue;
      }
      blockedBy.push(dependency);
    }
    normalized.push({
      id,
      content,
      status,
      ...priority ? { priority } : {},
      ...blockedBy.length > 0 ? { blockedBy } : {}
    });
  });
  const meta = isRecord2(input["_meta"]) ? input["_meta"] : void 0;
  const todoPlan = meta && isRecord2(meta["qwenTodoPlan"]) ? meta["qwenTodoPlan"] : void 0;
  const plan = isRecord2(input["plan"]) ? input["plan"] : void 0;
  const todoPlanId = getFirstString(todoPlan, ["id"]);
  const nestedPlanId = getFirstString(plan, ["id"]);
  const inputPlanId = getFirstString(input, ["planId"]);
  const rawPlanId = todoPlanId ?? nestedPlanId ?? inputPlanId;
  if (todoPlan?.["id"] !== void 0 !== !!todoPlanId || plan?.["id"] !== void 0 !== !!nestedPlanId || input["planId"] !== void 0 !== !!inputPlanId) {
    truncated = true;
  }
  const planId = rawPlanId && rawPlanId.length <= MAX_TODO_ID_LENGTH ? rawPlanId : void 0;
  if (rawPlanId && !planId) truncated = true;
  const rawRevision = todoPlan?.["revision"] ?? plan?.["revision"] ?? input["revision"];
  const revision = typeof rawRevision === "number" && Number.isSafeInteger(rawRevision) && rawRevision >= 0 ? rawRevision : void 0;
  if (rawRevision !== void 0 && revision === void 0) truncated = true;
  const summary = opts.title ?? opts.toolName ?? opts.toolKind;
  return {
    kind: "todo_list",
    entries: normalized,
    ...includeLegacySummary && summary ? { summary } : {},
    ...truncated ? { truncated: true } : {},
    ...planId ? { planId } : {},
    ...revision !== void 0 ? { revision } : {}
  };
}
__name(detectTodoList, "detectTodoList");
function allocateUniqueTodoId(base, authoredIds, usedIds) {
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? "-s" : `-s${attempt}`;
    const candidate = `${base.slice(0, MAX_TODO_ID_LENGTH - suffix.length)}${suffix}`;
    if (!authoredIds.has(candidate) && !usedIds.has(candidate)) {
      return candidate;
    }
  }
}
__name(allocateUniqueTodoId, "allocateUniqueTodoId");
function extractDisplayContentText(content) {
  if (!Array.isArray(content)) return void 0;
  let text = "";
  for (const entry of content) {
    if (!isRecord2(entry) || entry["type"] !== "content") continue;
    const body = isRecord2(entry["content"]) ? entry["content"] : void 0;
    const next = typeof body?.["text"] === "string" ? body["text"] : void 0;
    if (!next) continue;
    if (text.length + (text ? 1 : 0) + next.length > MAX_TOOL_RESULT_PREVIEW_LENGTH) {
      return void 0;
    }
    text += `${text ? "\n" : ""}${next}`;
  }
  return text || void 0;
}
__name(extractDisplayContentText, "extractDisplayContentText");
function detectFileDiff(input, opts = {}) {
  if (!isRecord2(input)) return void 0;
  const path = getFirstString(input, [
    "path",
    "filePath",
    "file_path",
    "absolutePath"
  ]);
  if (!path) return void 0;
  const oldText = getFirstString(input, [
    "oldText",
    "old_text",
    "old_string",
    "old_str",
    "old_string",
    "oldString"
  ]);
  const explicitNewText = getFirstString(input, [
    "newText",
    "new_text",
    "new_string",
    "new_str",
    "new_string",
    "newString"
  ]);
  const toolNameLower = (opts.toolName ?? "").toLowerCase();
  const writeIntent = /(?:^|[_-])(write|create|edit|replace|save|update|overwrite|modify|patch|generate)(?:$|[_-])/.test(
    toolNameLower
  ) || !!oldText;
  const contentField = explicitNewText === void 0 && writeIntent ? getFirstString(input, ["content"]) : void 0;
  const newText = explicitNewText ?? contentField;
  const patch = getFirstString(input, ["patch", "diff", "unified_diff"]);
  if (!oldText && !newText && !patch) return void 0;
  return {
    kind: "file_diff",
    path,
    ...oldText ? { oldText } : {},
    ...newText ? { newText } : {},
    ...patch ? { patch } : {}
  };
}
__name(detectFileDiff, "detectFileDiff");
function detectFileRead(input, opts) {
  if (!isRecord2(input)) return void 0;
  const path = getFirstString(input, [
    "path",
    "filePath",
    "file_path",
    "absolutePath"
  ]);
  if (!path) return void 0;
  const toolName = opts.toolName ?? getFirstString(input, ["toolName", "name"]);
  const looksLikeRead = toolName !== void 0 && /read|view|cat/i.test(toolName);
  const rangeArr = input["lineRange"] ?? input["line_range"] ?? input["range"];
  let range;
  if (Array.isArray(rangeArr) && rangeArr.length === 2 && typeof rangeArr[0] === "number" && typeof rangeArr[1] === "number") {
    range = [rangeArr[0], rangeArr[1]];
  } else {
    const offset = input["offset"];
    const limit = input["limit"];
    if (typeof offset === "number" && typeof limit === "number" && limit > 0) {
      range = [offset + 1, offset + limit];
    }
  }
  if (!looksLikeRead && !range) return void 0;
  return {
    kind: "file_read",
    path,
    ...range ? { range } : {}
  };
}
__name(detectFileRead, "detectFileRead");
function detectWebFetch(input) {
  if (!isRecord2(input)) return void 0;
  const url = getFirstString(input, ["url", "uri", "href"]);
  if (!url) return void 0;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return void 0;
  const method = getFirstString(input, ["method", "httpMethod"]);
  return {
    kind: "web_fetch",
    url,
    ...method ? { method } : {}
  };
}
__name(detectWebFetch, "detectWebFetch");
function detectMcpInvocation(input, opts) {
  const toolName = opts.toolName ?? (isRecord2(input) ? getFirstString(input, ["toolName", "name"]) : void 0);
  if (!toolName || !toolName.startsWith("mcp__")) return void 0;
  const rest = toolName.slice("mcp__".length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return void 0;
  const serverId = rest.slice(0, sep);
  const toolPart = rest.slice(sep + 2);
  let argsSummary;
  if (isRecord2(input)) {
    const args = input["arguments"] ?? input["args"] ?? input;
    if (isRecord2(args)) {
      const firstEntry = Object.entries(args).filter(([key]) => key !== "name" && key !== "toolName").slice(0, 1).map(([key, value]) => {
        const v = isSensitiveKey(key) ? "[redacted]" : typeof value === "string" ? value : stringifyCompactRedactedJson(value);
        const trimmed = v.length > 60 ? `${v.slice(0, 60)}\u2026` : v;
        return `${key}=${trimmed}`;
      })[0];
      if (firstEntry) argsSummary = firstEntry;
    }
  }
  return {
    kind: "mcp_invocation",
    serverId,
    toolName: toolPart,
    ...argsSummary ? { argsSummary } : {}
  };
}
__name(detectMcpInvocation, "detectMcpInvocation");
function stringifyCompactRedactedJson(value) {
  try {
    return JSON.stringify(redactSensitiveFields(value)) ?? String(value);
  } catch {
    return String(value);
  }
}
__name(stringifyCompactRedactedJson, "stringifyCompactRedactedJson");
function extractAskUserQuestions(input) {
  if (!isRecord2(input) || !Array.isArray(input["questions"])) return [];
  return input["questions"].filter(isRecord2).map((question) => {
    const header = getFirstString(question, ["header", "title", "label"]);
    const prompt = getFirstString(question, ["question", "prompt", "text"]) ?? "Question";
    const options = Array.isArray(question["options"]) ? question["options"].filter(isRecord2).map(normalizeQuestionOption) : [];
    return {
      ...header ? { header } : {},
      question: prompt,
      options,
      raw: question
    };
  });
}
__name(extractAskUserQuestions, "extractAskUserQuestions");
function normalizeQuestionOption(option) {
  const label = getFirstString(option, ["label", "title", "value"]) ?? "Option";
  const description = getFirstString(option, ["description", "detail", "text"]);
  return {
    label,
    ...description ? { description } : {},
    raw: option
  };
}
__name(normalizeQuestionOption, "normalizeQuestionOption");
function collectPreviewRows(input) {
  const rows = [];
  const candidates = [
    ["Path", ["path", "filePath", "file_path", "absolutePath"]],
    ["Cwd", ["cwd", "directory", "workingDirectory"]],
    ["Query", ["query", "pattern", "search"]],
    ["Note", ["description", "reason"]]
  ];
  for (const [label, keys] of candidates) {
    const value = getFirstString(input, keys);
    if (value) rows.push({ label, value });
  }
  if (rows.length > 0) return rows;
  for (const [key, value] of Object.entries(input).slice(0, 4)) {
    if (value === void 0 || value === null || Array.isArray(value)) continue;
    if (isRecord2(value)) continue;
    rows.push({
      label: key,
      value: isSensitiveKey(key) ? "[redacted]" : capDetails(stringifyRedactedJson(value))
    });
  }
  return rows;
}
__name(collectPreviewRows, "collectPreviewRows");
var MAX_TABULAR_ROWS = 50;
var MAX_SEARCH_TOP_RESULTS = 5;
function detectSubagentDelegation(input, opts) {
  const toolName = opts.toolName ?? "";
  const looksLikeDelegate = /^task$/i.test(toolName) || /(?:^|_)(?:delegate|subagent|spawn[_-]?task)$/i.test(toolName) || /agent/i.test(opts.toolKind ?? "");
  if (!looksLikeDelegate) return void 0;
  if (!isRecord2(input)) return void 0;
  const agentName = getFirstString(input, [
    "subagent_type",
    "agent",
    "agentName",
    "agent_name",
    "subagent"
  ]);
  const task = getFirstString(input, [
    "prompt",
    "task",
    "description",
    "instruction",
    "query"
  ]);
  if (!agentName && !task) return void 0;
  const parentDelegationId = getFirstString(input, [
    "parentDelegationId",
    "parent_delegation_id",
    "parent_id"
  ]);
  return {
    kind: "subagent_delegation",
    agentName: agentName ?? "subagent",
    task: task ?? "(no task description)",
    ...parentDelegationId ? { parentDelegationId } : {}
  };
}
__name(detectSubagentDelegation, "detectSubagentDelegation");
function detectSearch(input, opts) {
  if (!isRecord2(input)) return void 0;
  const query = getFirstString(input, ["query", "pattern", "search", "q"]);
  if (!query) return void 0;
  const toolName = opts.toolName ?? "";
  const looksLikeSearch = /(grep|search|find|ripgrep|rg|glob|lookup)/i.test(toolName) || typeof input["resultCount"] === "number" || Array.isArray(input["results"]) || Array.isArray(input["matches"]);
  if (!looksLikeSearch) return void 0;
  const resultCount = typeof input["resultCount"] === "number" ? input["resultCount"] : typeof input["total"] === "number" ? input["total"] : Array.isArray(input["results"]) ? input["results"].length : Array.isArray(input["matches"]) ? input["matches"].length : void 0;
  let top;
  const rawResults = input["results"] ?? input["matches"];
  if (Array.isArray(rawResults)) {
    top = rawResults.slice(0, MAX_SEARCH_TOP_RESULTS).map((item) => {
      if (typeof item === "string") return item;
      if (isRecord2(item)) {
        return getFirstString(item, ["path", "file", "name", "title", "text"]) ?? stringifyJson(item).slice(0, 120);
      }
      return String(item);
    }).filter(Boolean);
    if (top.length === 0) top = void 0;
  }
  return {
    kind: "search",
    query,
    ...resultCount !== void 0 ? { resultCount } : {},
    ...top ? { top } : {}
  };
}
__name(detectSearch, "detectSearch");
function detectImageGeneration(input, opts) {
  const toolName = opts.toolName ?? "";
  const looksLikeImageGen = /(image[_-]?gen|generate[_-]?image|diffusion|dalle|imagen|flux|stable[_-]?diffusion|midjourney|sora)/i.test(
    toolName
  );
  if (!looksLikeImageGen) return void 0;
  if (!isRecord2(input)) return void 0;
  const prompt = getFirstString(input, ["prompt", "description", "query"]);
  if (!prompt) return void 0;
  const thumbnailUrl = getFirstString(input, [
    "thumbnailUrl",
    "thumbnail",
    "url",
    "imageUrl",
    "preview"
  ]);
  const model = getFirstString(input, ["model", "modelId", "model_name"]);
  return {
    kind: "image_generation",
    prompt,
    ...thumbnailUrl ? { thumbnailUrl } : {},
    ...model ? { model } : {}
  };
}
__name(detectImageGeneration, "detectImageGeneration");
function detectCodeBlock(input, opts) {
  if (!isRecord2(input)) return void 0;
  const code = getFirstString(input, ["code", "snippet", "source"]);
  if (!code) return void 0;
  const language = getFirstString(input, [
    "language",
    "lang",
    "codeLanguage",
    "syntax"
  ]);
  const toolName = opts.toolName ?? "";
  const codeTool = /(repl|format|prettier|eslint|tsc|compile|exec[_-]?code)/i.test(toolName);
  if (!language && !codeTool) return void 0;
  const origin = getFirstString(input, ["origin", "source_location", "path"]);
  return {
    kind: "code_block",
    code,
    ...language ? { language } : {},
    ...origin ? { origin } : {}
  };
}
__name(detectCodeBlock, "detectCodeBlock");
function detectTabular(input) {
  if (!isRecord2(input)) return void 0;
  const explicitColumns = input["columns"];
  const explicitRows = input["rows"];
  if (Array.isArray(explicitColumns) && Array.isArray(explicitRows)) {
    const columns = explicitColumns.filter((c) => typeof c === "string").slice(0, 30);
    if (columns.length === 0) return void 0;
    const rows = explicitRows.slice(0, MAX_TABULAR_ROWS).map(
      (row) => Array.isArray(row) ? row.map(
        (cell) => typeof cell === "string" ? cell : stringifyJson(cell).slice(0, 80)
      ) : []
    );
    return {
      kind: "tabular",
      columns,
      rows,
      ...explicitRows.length > rows.length ? { totalRows: explicitRows.length } : {}
    };
  }
  const data = input["data"] ?? input["records"];
  if (Array.isArray(data) && data.length > 0 && isRecord2(data[0])) {
    const columns = Object.keys(data[0]).slice(
      0,
      30
    );
    if (columns.length === 0) return void 0;
    const rows = data.slice(0, MAX_TABULAR_ROWS).map((row) => {
      const r = row;
      return columns.map((col) => {
        const v = r[col];
        return typeof v === "string" ? v : stringifyJson(v).slice(0, 80);
      });
    });
    return {
      kind: "tabular",
      columns,
      rows,
      ...data.length > rows.length ? { totalRows: data.length } : {}
    };
  }
  return void 0;
}
__name(detectTabular, "detectTabular");

// packages/sdk-typescript/src/daemon/ui/normalizer.ts
var DAEMON_ERROR_KIND_SET = new Set(DAEMON_ERROR_KINDS);
var DEVICE_FLOW_PROVIDER_SET = /* @__PURE__ */ new Set(["qwen", "qwen-oauth"]);
var MCP_RESTART_REFUSED_REASONS2 = /* @__PURE__ */ new Set([
  "in_flight",
  "disabled",
  "budget_would_exceed",
  "authentication_required"
]);
var MALFORMED_MEMORY_CHANGED = "malformed memory_changed payload";
var SESSION_RECORDING_DEGRADED_MESSAGE = "Session recording stopped after a write failure. New messages for the affected session will not be saved. Check disk space and permissions, then start a new session to resume recording.";
var ATTACHMENT_UNAVAILABLE_TEXT = "[Attachment is no longer available]";
function normalizeDaemonEvent(event, opts = {}) {
  const base = createBase(event, opts);
  switch (event.type) {
    case "session_update":
      return normalizeSessionUpdate(event, base, opts);
    case "shell_output": {
      const text = getOutputText(event.data);
      const stream = getShellStream(event.data);
      const source = getSource(event.data);
      return text ? [
        {
          ...base,
          type: source === "user-shell" ? "user.shell.output" : "shell.output",
          text,
          ...stream ? { stream } : {}
        }
      ] : [];
    }
    case "permission_request":
      return normalizePermissionRequest(event, base);
    case "permission_resolved":
    case "permission_already_resolved":
      return normalizePermissionResolved(event, base);
    case "model_switched":
      return [
        {
          ...base,
          type: "model.changed",
          modelId: getString2(event.data, "modelId") ?? "unknown"
        }
      ];
    case "model_switch_failed":
      return [
        {
          ...base,
          type: "error",
          recoverable: true,
          text: getString2(event.data, "error") ?? "Model switch failed (no details available)"
        }
      ];
    case "session_died": {
      const errorKind = asDaemonErrorKind(getString2(event.data, "errorKind"));
      return [
        {
          ...base,
          type: "error",
          recoverable: false,
          ...errorKind ? { errorKind } : {},
          text: getString2(event.data, "reason") ?? "Session died (no details available)"
        }
      ];
    }
    case "session_closed":
      return [
        {
          ...base,
          type: "status",
          text: `Session closed: ${getString2(event.data, "reason") ?? "closed"}`
        }
      ];
    case "session_recording_degraded": {
      const sessionId = getString2(event.data, "sessionId");
      if (!sessionId || getString2(event.data, "reason") !== "write_failed") {
        return fallbackDebug(event, base, "malformed recording state");
      }
      return [
        {
          ...base,
          type: "error",
          recoverable: true,
          code: "session_recording_degraded",
          text: SESSION_RECORDING_DEGRADED_MESSAGE
        }
      ];
    }
    case "session_snapshot": {
      if (!isRecord2(event.data) || !getString2(event.data, "sessionId")) {
        return fallbackDebug(event, base, "malformed recording snapshot");
      }
      const recordingDegraded = event.data["recordingDegraded"];
      if (recordingDegraded !== void 0 && typeof recordingDegraded !== "boolean") {
        return fallbackDebug(event, base, "malformed recording snapshot");
      }
      if (recordingDegraded === true) {
        return [
          {
            ...base,
            type: "error",
            recoverable: true,
            code: "session_recording_degraded",
            text: SESSION_RECORDING_DEGRADED_MESSAGE
          }
        ];
      }
      return [];
    }
    case "client_evicted":
      return [
        {
          ...base,
          type: "error",
          recoverable: true,
          text: getString2(event.data, "reason") ?? "SSE client evicted (no details available)"
        }
      ];
    case "slow_client_warning":
      if (typeof console !== "undefined") {
        console.warn?.("[daemon-ui] SSE stream is lagging", event.data);
      }
      return [];
    case "stream_error": {
      const errorKind = asDaemonErrorKind(getString2(event.data, "errorKind"));
      return [
        {
          ...base,
          type: "error",
          recoverable: true,
          ...errorKind ? { errorKind } : {},
          text: getString2(event.data, "error") ?? "SSE stream error (no details available)"
        }
      ];
    }
    case "turn_error": {
      const code = getString2(event.data, "code");
      const errorKind = asDaemonErrorKind(getString2(event.data, "errorKind"));
      const promptId = getString2(event.data, "promptId");
      return [
        {
          ...base,
          type: "error",
          source: "turn_error",
          recoverable: true,
          ...code ? { code } : {},
          ...errorKind ? { errorKind } : {},
          ...promptId ? { promptId } : {},
          text: getString2(event.data, "message") ?? "Prompt failed (no details available)"
        }
      ];
    }
    case "state_resync_required":
      return normalizeStateResyncRequired(event, base);
    case "history_truncated":
      return normalizeHistoryTruncated(event, base);
    case "session_rewound":
      return normalizeSessionRewound(event, base);
    case "session_branched":
      return normalizeSessionBranched(event, base);
    case "prompt_cancelled": {
      const reason = stringField(event.data, "reason");
      return [
        { ...base, type: "prompt.cancelled", ...reason ? { reason } : {} }
      ];
    }
    case "turn_complete":
      return getString2(event.data, "stopReason") === "cancelled" ? normalizePromptCancellation(
        isRecord2(event.data) ? event.data["promptCancelled"] : void 0,
        base
      ) : [];
    case "followup_suggestion":
      return normalizeFollowupSuggestion(event, base);
    case "mid_turn_message_injected":
      return normalizeMidTurnMessageInjected(event, base);
    case "pending_prompt_added":
    case "pending_prompt_started":
    case "pending_prompt_completed":
      return [];
    case "user_shell_command": {
      const command = getString2(event.data, "command");
      const cwd = getString2(event.data, "cwd");
      return command ? [
        {
          ...base,
          type: "user.shell.command",
          command,
          ...cwd ? { cwd } : {}
        },
        { ...base, type: "user.text.delta", text: `$ ${command}` }
      ] : [];
    }
    case "user_shell_result": {
      const exitCode = numberField(event.data, "exitCode");
      const aborted = isRecord2(event.data) && event.data["aborted"] === true;
      const text = aborted ? "Shell command was aborted" : `Shell command exited with code ${exitCode ?? "unknown"}`;
      return [{ ...base, type: "status", text }];
    }
    case "replay_complete": {
      const replayedCount = numberField(event.data, "replayedCount") ?? 0;
      const lastReplayedEventId = numberField(event.data, "lastReplayedEventId") ?? numberField(event.data, "lastEventId");
      return [
        {
          ...base,
          type: "session.replay_complete",
          replayedCount,
          ...lastReplayedEventId !== void 0 ? { lastReplayedEventId } : {}
        }
      ];
    }
    // ── Session-meta events ──────────────────────────────────────────────
    case "session_metadata_updated":
      return normalizeSessionMetadataUpdated(event, base);
    case "approval_mode_changed":
      return normalizeApprovalModeChanged(event, base);
    // ── Workspace events ──────────────────────────────────────
    case "git_branch_changed":
      return [];
    case "git_status_changed":
      return [];
    case "memory_changed":
      return normalizeMemoryChanged(event, base);
    case "agent_changed":
      return normalizeAgentChanged(event, base);
    case "tool_toggled":
      return normalizeToolToggled(event, base);
    case "settings_changed":
      return normalizeSettingsChanged(event, base);
    case "settings_reloaded":
      return normalizeSettingsReloaded(event, base);
    case "trust_change_requested":
      return normalizeTrustChangeRequested(event, base);
    case "workspace_initialized":
      return normalizeWorkspaceInitialized(event, base);
    case "github_setup_completed":
      return normalizeGithubSetupCompleted(event, base);
    case "mcp_budget_warning":
      return normalizeMcpBudgetWarning(event, base);
    case "mcp_child_refused_batch":
      return normalizeMcpChildRefused(event, base);
    case "mcp_server_restarted":
      return normalizeMcpServerRestarted(event, base);
    case "mcp_server_restart_refused":
      return normalizeMcpServerRestartRefused(event, base);
    case "mcp_server_added":
      return normalizeMcpServerChanged(event, base, "added");
    case "mcp_server_removed":
      return normalizeMcpServerChanged(event, base, "removed");
    case "mcp_server_changed":
      return normalizeMcpServerChanged(event, base);
    case "extensions_changed":
      return normalizeExtensionsChanged(event, base);
    case "source_changed": {
      const sessionId = getString2(event.data, "sessionId");
      const revision = isRecord2(event.data) ? event.data["revision"] : void 0;
      return sessionId && typeof revision === "number" && Number.isInteger(revision) && revision >= 0 ? [{ ...base, type: "session.source.changed", sessionId, revision }] : [];
    }
    case "artifact_changed":
      return normalizeArtifactChanged(event, base);
    // ── Auth device-flow events (RFC 8628) ─────────────────
    case "auth_device_flow_started":
      return normalizeAuthDeviceFlowStarted(event, base);
    case "auth_device_flow_throttled":
      return normalizeAuthDeviceFlowThrottled(event, base);
    case "auth_device_flow_authorized":
      return normalizeAuthDeviceFlowAuthorized(event, base);
    case "auth_device_flow_failed":
      return normalizeAuthDeviceFlowFailed(event, base);
    case "auth_device_flow_cancelled":
      return normalizeAuthDeviceFlowCancelled(event, base);
    default:
      return normalizeUnrecognizedEvent(event, base);
  }
}
__name(normalizeDaemonEvent, "normalizeDaemonEvent");
function normalizeUnrecognizedEvent(event, base) {
  return [
    {
      ...base,
      type: "debug",
      debugReason: "unrecognized_event",
      text: debugBlockText(
        `${event.type} (unrecognized daemon event)`,
        event.data
      )
    }
  ];
}
__name(normalizeUnrecognizedEvent, "normalizeUnrecognizedEvent");
function normalizeStateResyncRequired(event, base) {
  const reason = getString2(event.data, "reason");
  const lastDeliveredId = numberField(event.data, "lastDeliveredId");
  const earliestAvailableId = numberField(event.data, "earliestAvailableId");
  if (!reason || lastDeliveredId === void 0 || earliestAvailableId === void 0) {
    return fallbackDebug(
      event,
      base,
      "malformed state_resync_required payload"
    );
  }
  return [
    {
      ...base,
      type: "session.state_resync_required",
      reason,
      lastDeliveredId,
      earliestAvailableId
    }
  ];
}
__name(normalizeStateResyncRequired, "normalizeStateResyncRequired");
function normalizeHistoryTruncated(event, base) {
  const reason = getString2(event.data, "reason");
  const truncatedEvents = numberField(event.data, "truncatedEvents");
  const retainedEvents = numberField(event.data, "retainedEvents");
  const maxBytes = numberField(event.data, "maxBytes");
  const maxEvents = numberField(event.data, "maxEvents");
  if (reason !== "replay_window_exceeded" || truncatedEvents === void 0 || retainedEvents === void 0 || maxBytes === void 0 || !isRecord2(event.data) || typeof event.data["fullTranscriptAvailable"] !== "boolean") {
    return fallbackDebug(event, base, "malformed history_truncated payload");
  }
  const scope = getString2(event.data, "scope");
  if (event.data["scope"] !== void 0 && !scope || event.data["maxEvents"] !== void 0 && (maxEvents === void 0 || !Number.isInteger(maxEvents) || maxEvents < 0)) {
    return fallbackDebug(event, base, "malformed history_truncated payload");
  }
  const fullTranscriptAvailable = event.data["fullTranscriptAvailable"];
  const limits = [
    maxEvents === void 0 ? void 0 : `${maxEvents} ${scope === "live_journal" ? "replay entries" : "events"}`,
    `${maxBytes} bytes`
  ].filter((limit) => limit !== void 0).join(" / ");
  const text = scope === "live_journal" ? `History truncated for live turn replay: kept the latest ${retainedEvents} source events and dropped ${truncatedEvents} older source events (limits: ${limits}). ${fullTranscriptAvailable ? "Complete content remains available after the turn finishes." : "Complete content is not available for automatic recovery."}` : scope === void 0 ? `History truncated in replay history: kept the latest ${retainedEvents} events and dropped ${truncatedEvents} older replay events (limits: ${limits}). ${fullTranscriptAvailable ? "Older content remains available from the full transcript." : "Older content is not available from a full transcript."}` : `History truncated: kept the latest ${retainedEvents} events and dropped ${truncatedEvents} older replay events (limits: ${limits}). ${fullTranscriptAvailable ? "Full transcript content remains available." : "Full transcript content is not available."}`;
  return [
    {
      ...base,
      type: "status",
      text,
      source: "history_truncated",
      data: event.data
    }
  ];
}
__name(normalizeHistoryTruncated, "normalizeHistoryTruncated");
function normalizeSessionRewound(event, base) {
  const promptId = getString2(event.data, "promptId");
  const targetTurnIndex = numberField(event.data, "targetTurnIndex");
  if (!promptId || targetTurnIndex === void 0) {
    return fallbackDebug(event, base, "malformed session_rewound payload");
  }
  const sessionId = getString2(event.data, "sessionId");
  return [
    {
      ...base,
      type: "session.rewound",
      promptId,
      targetTurnIndex,
      ...sessionId ? { sessionId } : {}
    }
  ];
}
__name(normalizeSessionRewound, "normalizeSessionRewound");
function normalizeSessionBranched(event, base) {
  const sourceSessionId = getString2(event.data, "sourceSessionId");
  const newSessionId = getString2(event.data, "newSessionId");
  const displayName = getString2(event.data, "displayName");
  if (!sourceSessionId || !newSessionId || !displayName) {
    return fallbackDebug(event, base, "malformed session_branched payload");
  }
  return [
    {
      ...base,
      type: "session.branched",
      sourceSessionId,
      newSessionId,
      displayName
    }
  ];
}
__name(normalizeSessionBranched, "normalizeSessionBranched");
function normalizeFollowupSuggestion(event, base) {
  const sessionId = getString2(event.data, "sessionId");
  const suggestion = getString2(event.data, "suggestion");
  const promptId = getString2(event.data, "promptId");
  if (!sessionId || !suggestion || !promptId) {
    return fallbackDebug(event, base, "malformed followup_suggestion payload");
  }
  return [
    {
      ...base,
      type: "followup.suggestion",
      sessionId,
      suggestion,
      promptId
    }
  ];
}
__name(normalizeFollowupSuggestion, "normalizeFollowupSuggestion");
function normalizeMidTurnMessageInjected(event, base) {
  if (!isRecord2(event.data)) {
    return fallbackDebug(event, base, "malformed mid_turn_message_injected");
  }
  const data = event.data;
  const rawMessages = data["messages"];
  const messages = Array.isArray(rawMessages) && rawMessages.every(
    (message) => typeof message === "string"
  ) ? rawMessages : [];
  const items = data["items"];
  const hasRenderableItemContent = Array.isArray(items) && items.some(
    (item) => isRecord2(item) && Array.isArray(item["content"]) && item["content"].some(
      (block) => isRecord2(block) && (block["type"] === "image" || block["type"] === "resource" || block["type"] === "text" && typeof block["text"] === "string" && block["text"].length > 0)
    )
  );
  if (messages.length === 0 || !messages.some(Boolean) && !hasRenderableItemContent) {
    return fallbackDebug(event, base, "malformed mid_turn_message_injected");
  }
  const messageIds = Array.isArray(data["messageIds"]) ? data["messageIds"] : [];
  return messages.map((text, index) => {
    const item = Array.isArray(items) ? items[index] : void 0;
    const messageId = messageIds[index];
    return {
      ...base,
      type: "status",
      text,
      source: "mid_turn_message_injected",
      data: {
        ...data,
        messages: [text],
        ...Array.isArray(items) ? { items: item !== void 0 ? [item] : [] } : {},
        ...typeof messageId === "string" ? { messageIds: [messageId] } : Array.isArray(data["messageIds"]) ? { messageIds: [] } : {}
      }
    };
  });
}
__name(normalizeMidTurnMessageInjected, "normalizeMidTurnMessageInjected");
function createBase(event, opts) {
  const serverTimestamp = extractServerTimestamp(event);
  const sourceRecordIds = extractSourceRecordIds(event);
  const segmentId = extractTranscriptSegmentId(event);
  const branchRecordId = extractBranchRecordId(event);
  const update = getSessionUpdatePayload(event.data);
  const backgroundTurn = parseDaemonBackgroundTurn(
    (update && isRecord2(update["_meta"]) ? update["_meta"]["backgroundTurn"] : void 0) ?? (isRecord2(event.data) ? event.data["backgroundTurn"] : void 0)
  );
  const promptId = event.promptId ?? getString2(update?.["_meta"], "promptId") ?? backgroundTurn?.turnId;
  return {
    ...event.id !== void 0 ? { eventId: event.id } : {},
    ...serverTimestamp !== void 0 ? { serverTimestamp } : {},
    ...sourceRecordIds ? { sourceRecordIds } : {},
    ...segmentId ? { segmentId } : {},
    ...promptId ? { promptId } : {},
    ...backgroundTurn ? { backgroundTurn } : {},
    ...branchRecordId ? { branchRecordId } : {},
    ...event.originatorClientId ? { originatorClientId: event.originatorClientId } : {},
    ...opts.includeRawEvent ? { rawEvent: { ...event, data: redactSensitiveFields(event.data) } } : {}
  };
}
__name(createBase, "createBase");
function extractTranscriptSegmentId(event) {
  if (!isRecord2(event.data)) return void 0;
  const update = getSessionUpdatePayload(event.data);
  const meta = update && isRecord2(update["_meta"]) ? update["_meta"] : void 0;
  const transcript = meta && isRecord2(meta["qwenTranscript"]) ? meta["qwenTranscript"] : void 0;
  const segmentId = getString2(transcript, "segmentId");
  return segmentId && segmentId.length <= 512 ? segmentId : void 0;
}
__name(extractTranscriptSegmentId, "extractTranscriptSegmentId");
function extractBranchRecordId(event) {
  if (!isRecord2(event.data)) return void 0;
  const update = getSessionUpdatePayload(event.data);
  const meta = update && isRecord2(update["_meta"]) ? update["_meta"] : void 0;
  const transcript = meta && isRecord2(meta["qwenTranscript"]) ? meta["qwenTranscript"] : void 0;
  return transcript ? getString2(transcript, "branchRecordId") : void 0;
}
__name(extractBranchRecordId, "extractBranchRecordId");
function extractServerTimestamp(event) {
  const direct = event.serverTimestamp;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  const envelopeMeta = event._meta;
  if (isRecord2(envelopeMeta)) {
    const ts = envelopeMeta["serverTimestamp"];
    if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  }
  if (isRecord2(event.data)) {
    const dataMeta = event.data["_meta"];
    const update = event.data["update"];
    const updateMeta = isRecord2(update) ? update["_meta"] : void 0;
    if (isRecord2(dataMeta)) {
      const ts = dataMeta["serverTimestamp"];
      if (typeof ts === "number" && Number.isFinite(ts)) return ts;
    }
    if (isRecord2(updateMeta)) {
      const serverTs = updateMeta["serverTimestamp"];
      if (typeof serverTs === "number" && Number.isFinite(serverTs)) {
        return serverTs;
      }
    }
    const timestampCandidates = [
      isRecord2(updateMeta) ? updateMeta["timestamp"] : void 0,
      isRecord2(update) ? update["timestamp"] : void 0,
      isRecord2(dataMeta) ? dataMeta["timestamp"] : void 0,
      event.data["timestamp"]
    ];
    for (const candidate of timestampCandidates) {
      const timestamp = parseTimestamp(candidate);
      if (timestamp !== void 0) return timestamp;
    }
  }
  return void 0;
}
__name(extractServerTimestamp, "extractServerTimestamp");
function parseTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return void 0;
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : void 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : void 0;
}
__name(parseTimestamp, "parseTimestamp");
function isAttachmentReferenceContent(value) {
  return isRecord2(value) && (value["type"] === "image" || value["type"] === "resource") && typeof value["attachmentId"] === "string" && value["attachmentId"].length > 0 && value["data"] === void 0 && value["url"] === void 0 && value["source"] === void 0;
}
__name(isAttachmentReferenceContent, "isAttachmentReferenceContent");
function normalizeSessionUpdate(event, base, opts) {
  const update = getSessionUpdatePayload(event.data);
  if (!update) {
    return [
      {
        ...base,
        type: "debug",
        debugReason: "malformed_payload",
        text: debugBlockText("session_update", event.data)
      }
    ];
  }
  const kind = getString2(update, "sessionUpdate");
  switch (kind) {
    case "user_message_chunk": {
      if (opts.suppressOwnUserEcho && opts.clientId && event.originatorClientId === opts.clientId) {
        return [];
      }
      const meta = extractUpdateMeta(update);
      const content = update["content"];
      if (isRecord2(content) && content["type"] === "resource_link" && typeof content["uri"] === "string" && content["uri"].length > 0 && typeof content["name"] === "string") {
        return [
          {
            ...base,
            type: "user.resource_link.delta",
            resourceLink: {
              ...content,
              type: "resource_link",
              uri: content["uri"],
              name: content["name"]
            },
            ...meta ? { meta } : {}
          }
        ];
      }
      const part = extractContentPart(content);
      if (part) {
        if (part.kind === "image") {
          const data = part.source.data;
          let mimeType = part.mediaType || "image/*";
          if (mimeType === "image/*" && data) {
            const rawData = data.startsWith("data:") ? data.split(",")[1] ?? "" : data;
            const prefix = rawData.slice(0, 10);
            if (prefix.startsWith("iVBORw0KGg")) mimeType = "image/png";
            else if (prefix.startsWith("/9j/")) mimeType = "image/jpeg";
            else if (prefix.startsWith("R0lGOD")) mimeType = "image/gif";
            else if (prefix.startsWith("UklGR")) mimeType = "image/webp";
          }
          if (data) {
            const contentRecord = isRecord2(content) ? content : void 0;
            const attachmentId = typeof contentRecord?.["attachmentId"] === "string" ? contentRecord["attachmentId"] : void 0;
            return [
              {
                ...base,
                type: "user.image.delta",
                data,
                mimeType,
                ...attachmentId ? { attachmentId } : {},
                ...meta ? { meta } : {}
              }
            ];
          }
          return [];
        }
        if (part.kind === "text") {
          return part.text ? [
            {
              ...base,
              type: "user.text.delta",
              text: part.text,
              ...meta ? { meta } : {}
            }
          ] : [];
        }
        return [];
      }
      if (isAttachmentReferenceContent(content)) {
        if (content["type"] === "resource") {
          const attachmentId = content["attachmentId"];
          const mimeType = content["mimeType"];
          return [
            {
              ...base,
              type: "user.file.delta",
              name: attachmentId,
              attachmentId,
              mimeType: typeof mimeType === "string" ? mimeType : "",
              ...meta ? { meta } : {}
            }
          ];
        }
        return [
          {
            ...base,
            type: "user.text.delta",
            text: ATTACHMENT_UNAVAILABLE_TEXT,
            ...meta ? { meta } : {}
          }
        ];
      }
      const text = getTextContent(content);
      return text ? [
        {
          ...base,
          type: "user.text.delta",
          text,
          ...meta ? { meta } : {}
        }
      ] : [];
    }
    case "agent_message_chunk": {
      const text = getTextContent(update["content"]);
      const parentToolCallId = extractParentToolCallId(update);
      const meta = extractUpdateMeta(update);
      if (meta?.["source"] === "background_task_completed" || meta?.["source"] === "background_notification_turn_started") {
        return [
          {
            ...base,
            type: "status",
            source: meta["source"],
            text: text ?? "",
            data: meta["source"] === "background_task_completed" ? meta["backgroundTask"] : meta["backgroundTurn"]
          }
        ];
      }
      const events = [];
      if (!parentToolCallId && meta?.["promptCancelled"] !== void 0) {
        return normalizePromptCancellation(meta["promptCancelled"], base);
      }
      if (text) {
        events.push({
          ...base,
          type: "assistant.text.delta",
          text,
          ...parentToolCallId ? { parentToolCallId } : {},
          ...meta ? { meta } : {}
        });
      }
      const usage = extractAssistantUsage(update);
      if (usage) {
        events.push({
          ...base,
          type: "assistant.usage",
          usage,
          ...parentToolCallId ? { parentToolCallId } : {}
        });
      }
      return events;
    }
    case "agent_thought_chunk": {
      const text = getTextContent(update["content"]);
      if (!text) return [];
      const parentToolCallId = extractParentToolCallId(update);
      const meta = extractUpdateMeta(update);
      return [
        {
          ...base,
          type: "thought.text.delta",
          text,
          ...parentToolCallId ? { parentToolCallId } : {},
          ...meta ? { meta } : {}
        }
      ];
    }
    case "tool_call":
    case "tool_call_update": {
      const meta = isRecord2(update["_meta"]) ? update["_meta"] : void 0;
      if (getString2(update, "status") === "in_progress" && getString2(update, "kind") === void 0 && (meta?.["shellProgress"] !== void 0 || meta?.subagentProgress === true)) {
        return [];
      }
      return [normalizeToolUpdate(update, base)];
    }
    case "shell_output":
    case "tool_output": {
      const text = getOutputText(update);
      const stream = getShellStream(update) ?? getShellStream(event.data);
      const source = getSource(update) ?? getSource(event.data);
      return text ? [
        {
          ...base,
          type: source === "user-shell" ? "user.shell.output" : "shell.output",
          text,
          ...stream ? { stream } : {}
        }
      ] : [];
    }
    case "available_commands_update": {
      const rawCommands = Array.isArray(update["availableCommands"]) ? update["availableCommands"] : [];
      const commands = rawCommands.filter(isRecord2);
      return [
        {
          ...base,
          type: "session.available_commands",
          count: commands.length,
          commands
        }
      ];
    }
    case "plan":
      return [normalizePlanUpdate(update, base)];
    case "current_mode_update":
    case "session_info_update":
    case "usage_update":
      return [];
    default:
      return [
        {
          ...base,
          type: "debug",
          // `getSessionUpdatePayload` accepts any record, so `kind` is
          // `undefined` for a payload whose discriminator is missing, empty or
          // not a string. That is a broken frame, not a kind from a newer
          // daemon — classifying it as unrecognized would hide the only
          // diagnostic a malformed `session_update` produces. A whitespace-only
          // discriminator is truthy but no more usable than an empty one, so
          // apply the same `trim()` convention `getFirstString` uses.
          debugReason: kind?.trim() ? "unrecognized_session_update" : "malformed_payload",
          text: debugBlockText(kind ?? "session_update", update)
        }
      ];
  }
}
__name(normalizeSessionUpdate, "normalizeSessionUpdate");
function extractParentToolCallId(update) {
  const meta = isRecord2(update["_meta"]) ? update["_meta"] : void 0;
  return meta ? getString2(meta, "parentToolCallId") : void 0;
}
__name(extractParentToolCallId, "extractParentToolCallId");
function extractUpdateMeta(update) {
  const meta = isRecord2(update["_meta"]) ? update["_meta"] : void 0;
  if (!meta) return void 0;
  const { qwenTranscript: _qwenTranscript, ...displayMeta } = meta;
  return Object.keys(displayMeta).length > 0 ? displayMeta : void 0;
}
__name(extractUpdateMeta, "extractUpdateMeta");
function extractSourceRecordIds(event) {
  if (!isRecord2(event.data)) return void 0;
  const update = getSessionUpdatePayload(event.data);
  const meta = update && isRecord2(update["_meta"]) ? update["_meta"] : void 0;
  const transcript = meta && isRecord2(meta["qwenTranscript"]) ? meta["qwenTranscript"] : void 0;
  const values = transcript?.["sourceRecordIds"];
  if (!Array.isArray(values)) return void 0;
  const ids = [
    ...new Set(
      values.filter((value) => typeof value === "string")
    )
  ];
  return ids.length > 0 ? ids : void 0;
}
__name(extractSourceRecordIds, "extractSourceRecordIds");
function extractAssistantUsage(update) {
  const meta = isRecord2(update["_meta"]) ? update["_meta"] : void 0;
  const usage = meta && isRecord2(meta["usage"]) ? meta["usage"] : void 0;
  if (!usage) return void 0;
  const inputTokens = numberField(usage, "inputTokens");
  const outputTokens = numberField(usage, "outputTokens");
  if (inputTokens === void 0 && outputTokens === void 0) return void 0;
  const cachedTokens = numberField(usage, "cachedReadTokens");
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...cachedTokens !== void 0 ? { cachedTokens } : {}
  };
}
__name(extractAssistantUsage, "extractAssistantUsage");
function normalizeToolUpdate(update, base) {
  const metadata = isRecord2(update["_meta"]) ? update["_meta"] : void 0;
  const transcript = metadata && isRecord2(metadata["qwenTranscript"]) ? metadata["qwenTranscript"] : void 0;
  const resultPreview = createDaemonToolResultTextPreview(
    getString2(transcript, "resultPreviewText") ?? ""
  );
  const toolName = getString2(update, "toolName") ?? getString2(update, "name") ?? (metadata ? getString2(metadata, "toolName") : void 0) ?? (metadata ? getString2(metadata, "name") : void 0);
  const toolKind = getString2(update, "kind");
  const explicitTitle = getString2(update, "title");
  const title = explicitTitle ?? (getString2(update, "sessionUpdate") === "tool_call" ? toolName ?? toolKind : void 0);
  const rawInputSource = update["rawInput"] ?? update["input"] ?? update["args"];
  const rawOutputSource = update["rawOutput"] ?? update["output"] ?? update["result"];
  const rawInput = rawInputSource !== void 0 ? redactSensitiveFields(rawInputSource) : void 0;
  const rawOutput = rawOutputSource !== void 0 ? redactSensitiveFields(rawOutputSource) : void 0;
  const content = update["content"] !== void 0 ? redactSensitiveFields(update["content"]) : void 0;
  const locations = update["locations"] !== void 0 ? redactSensitiveFields(update["locations"]) : void 0;
  const toolCallId = getString2(update, "toolCallId");
  const status = getString2(update, "status");
  if (!toolCallId) {
    return {
      ...base,
      type: "error",
      code: "daemon.protocol.tool_update_missing_tool_call_id",
      recoverable: true,
      text: `Tool update missing toolCallId${title ? ` (${title})` : ""}`
    };
  }
  const subagentSessionReady = isRecord2(rawOutput) && typeof rawOutput["subagentSessionReady"] === "boolean" ? rawOutput["subagentSessionReady"] : metadata?.["subagentSessionReady"];
  const { provenance, serverId } = extractToolProvenance(update, toolName);
  const rawParentToolCallId = getString2(update, "parentToolCallId") ?? (metadata ? getString2(metadata, "parentToolCallId") : void 0);
  const parentToolCallId = rawParentToolCallId && rawParentToolCallId !== toolCallId ? rawParentToolCallId : void 0;
  const subagentType = getString2(update, "subagentType") ?? (metadata ? getString2(metadata, "subagentType") : void 0);
  return {
    ...base,
    type: "tool.update",
    toolCallId,
    ...status ? { status } : {},
    ...title ? { title } : {},
    ...toolName ? { toolName } : {},
    ...toolKind ? { toolKind } : {},
    ...content !== void 0 ? { content } : {},
    ...locations !== void 0 ? { locations } : {},
    ...provenance ? { provenance } : {},
    ...serverId ? { serverId } : {},
    ...parentToolCallId ? { parentToolCallId } : {},
    ...subagentType ? { subagentType } : {},
    ...typeof subagentSessionReady === "boolean" ? { subagentSessionReady } : {},
    ...rawInput !== void 0 ? { rawInput } : {},
    ...rawOutput !== void 0 ? { rawOutput } : {},
    ...resultPreview ? { resultPreview } : {},
    ...rawInput !== void 0 ? { details: capDetails(stringifyRedactedJson(rawInput)) } : rawOutput !== void 0 ? { details: capDetails(stringifyRedactedJson(rawOutput)) } : {}
  };
}
__name(normalizeToolUpdate, "normalizeToolUpdate");
function normalizePlanUpdate(update, base) {
  const entries = Array.isArray(update["entries"]) ? update["entries"] : [];
  const contentText = capDetails(formatPlanEntries(entries));
  const meta = isRecord2(update["_meta"]) ? update["_meta"] : void 0;
  const transcript = meta && isRecord2(meta["qwenTranscript"]) ? meta["qwenTranscript"] : void 0;
  const planCallId = getString2(transcript, "planToolCallId") ?? (base.eventId !== void 0 ? `${DAEMON_PLAN_TOOL_CALL_ID}-${base.eventId}` : DAEMON_PLAN_TOOL_CALL_ID);
  const stats = meta && isRecord2(meta["stats"]) ? meta["stats"] : void 0;
  const todoPlan = meta && isRecord2(meta["qwenTodoPlan"]) ? meta["qwenTodoPlan"] : void 0;
  const planId = getString2(todoPlan, "id");
  const sessionWorkflow = meta?.["qwenSessionWorkflow"] === true;
  return {
    ...base,
    type: "tool.update",
    toolCallId: planCallId,
    title: "Updated Plan",
    status: "completed",
    toolName: "todo_write",
    toolKind: "updated_plan",
    content: [
      {
        type: "content",
        content: { type: "text", text: contentText }
      }
    ],
    rawOutput: {
      entries,
      ...stats ? { stats } : {},
      ...planId ? { plan: { id: planId, sourceCallId: planCallId } } : {},
      ...sessionWorkflow ? { sessionWorkflow: true } : {}
    }
  };
}
__name(normalizePlanUpdate, "normalizePlanUpdate");
function formatPlanEntries(entries) {
  return entries.flatMap((entry) => {
    if (!isRecord2(entry)) return [];
    const content = getString2(entry, "content");
    if (!content) return [];
    const marker = getPlanEntryMarker(getString2(entry, "status"));
    return [`- [${marker}] ${content}`];
  }).join("\n");
}
__name(formatPlanEntries, "formatPlanEntries");
function getPlanEntryMarker(status) {
  switch (status) {
    case "completed":
      return "x";
    case "in_progress":
      return "-";
    default:
      return " ";
  }
}
__name(getPlanEntryMarker, "getPlanEntryMarker");
function extractToolProvenance(update, toolName) {
  const explicit = getString2(update, "provenance");
  const explicitServerId = getString2(update, "serverId");
  if (explicit === "builtin" || explicit === "mcp" || explicit === "subagent") {
    return {
      provenance: explicit,
      ...explicit === "mcp" && explicitServerId ? { serverId: explicitServerId } : {}
    };
  }
  if (toolName && toolName.startsWith("mcp__")) {
    const rest = toolName.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep > 0) {
      return { provenance: "mcp", serverId: rest.slice(0, sep) };
    }
  }
  return {};
}
__name(extractToolProvenance, "extractToolProvenance");
function asDaemonErrorKind(value) {
  if (!value) return void 0;
  return DAEMON_ERROR_KIND_SET.has(value) ? value : void 0;
}
__name(asDaemonErrorKind, "asDaemonErrorKind");
function debugBlockText(prefix, data) {
  return capDetails(`${prefix}: ${stringifyRedactedJson(data)}`);
}
__name(debugBlockText, "debugBlockText");
function normalizePermissionRequest(event, base) {
  if (!isRecord2(event.data)) {
    return [
      {
        ...base,
        type: "debug",
        debugReason: "malformed_payload",
        text: debugBlockText("permission_request", event.data)
      }
    ];
  }
  const requestId = getString2(event.data, "requestId");
  if (!requestId) {
    return [
      {
        ...base,
        type: "debug",
        debugReason: "malformed_payload",
        text: debugBlockText("permission_request", event.data)
      }
    ];
  }
  const toolCall = event.data["toolCall"] !== void 0 ? redactSensitiveFields(event.data["toolCall"]) : void 0;
  return [
    {
      ...base,
      type: "permission.request",
      requestId,
      sessionId: getString2(event.data, "sessionId"),
      title: describeToolCall(toolCall),
      options: normalizePermissionOptions(event.data["options"]),
      toolCall
    }
  ];
}
__name(normalizePermissionRequest, "normalizePermissionRequest");
function normalizePermissionResolved(event, base) {
  const requestId = getString2(event.data, "requestId");
  if (!requestId) {
    return [
      {
        ...base,
        type: "debug",
        debugReason: "malformed_payload",
        text: debugBlockText(event.type, event.data)
      }
    ];
  }
  const voterClientId = getString2(event.data, "voterClientId") ?? base.originatorClientId;
  return [
    {
      ...base,
      type: "permission.resolved",
      requestId,
      outcome: describePermissionOutcome(event.data),
      ...voterClientId ? { voterClientId } : {}
    }
  ];
}
__name(normalizePermissionResolved, "normalizePermissionResolved");
function getSessionUpdatePayload(value) {
  if (!isRecord2(value)) return void 0;
  const update = value["update"];
  return isRecord2(update) ? update : value;
}
__name(getSessionUpdatePayload, "getSessionUpdatePayload");
function normalizePermissionOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option) => {
    if (!isRecord2(option)) return [];
    const optionId = getString2(option, "optionId");
    if (!optionId) return [];
    return [
      {
        optionId,
        label: getString2(option, "label") ?? getString2(option, "title") ?? getString2(option, "name") ?? optionId,
        ...getString2(option, "description") ? { description: getString2(option, "description") } : {},
        raw: option
      }
    ];
  });
}
__name(normalizePermissionOptions, "normalizePermissionOptions");
function describePermissionOutcome(value) {
  if (!isRecord2(value)) return stringifyJson(value);
  const outcome = value["outcome"];
  if (typeof outcome === "string") return outcome;
  if (isRecord2(outcome)) {
    const kind = getString2(outcome, "outcome") ?? "selected";
    const optionId = getString2(outcome, "optionId");
    return optionId ? `${kind}:${optionId}` : kind;
  }
  return getFirstString(value, ["status", "reason"]) ?? stringifyJson(value);
}
__name(describePermissionOutcome, "describePermissionOutcome");
function describeToolCall(value) {
  if (!isRecord2(value)) return "Tool permission";
  return getString2(value, "title") ?? getString2(value, "name") ?? getString2(value, "kind") ?? getString2(value, "toolName") ?? "Tool permission";
}
__name(describeToolCall, "describeToolCall");
function getShellStream(value) {
  const stream = getString2(value, "stream");
  return stream === "stdout" || stream === "stderr" ? stream : void 0;
}
__name(getShellStream, "getShellStream");
function getSource(value) {
  if (!isRecord2(value)) return void 0;
  const direct = getString2(value, "source");
  if (direct) return direct;
  const meta = value["_meta"];
  return isRecord2(meta) ? getString2(meta, "source") : void 0;
}
__name(getSource, "getSource");
function fallbackDebug(event, base, reason) {
  return [
    {
      ...base,
      type: "debug",
      debugReason: "malformed_payload",
      text: `${event.type}: ${reason}`
    }
  ];
}
__name(fallbackDebug, "fallbackDebug");
function normalizeSessionMetadataUpdated(event, base) {
  const sessionId = getString2(event.data, "sessionId");
  if (!sessionId) return fallbackDebug(event, base, "missing sessionId");
  const displayName = getString2(event.data, "displayName");
  return [
    {
      ...base,
      type: "session.metadata.changed",
      sessionId,
      ...displayName !== void 0 ? { displayName } : {}
    }
  ];
}
__name(normalizeSessionMetadataUpdated, "normalizeSessionMetadataUpdated");
function normalizeArtifactChanged(event, base) {
  const sessionId = getString2(event.data, "sessionId");
  const change = isRecord2(event.data) ? event.data["change"] : void 0;
  if (!sessionId || !isRecord2(change)) {
    return fallbackDebug(event, base, "malformed artifact_changed payload");
  }
  const action = getString2(change, "action");
  const artifactId = getString2(change, "artifactId");
  if (!action || !artifactId) {
    return fallbackDebug(event, base, "missing action or artifactId");
  }
  return [
    {
      ...base,
      type: "session.artifact.changed",
      sessionId,
      change
    }
  ];
}
__name(normalizeArtifactChanged, "normalizeArtifactChanged");
function normalizeApprovalModeChanged(event, base) {
  const sessionId = getString2(event.data, "sessionId");
  const previous = getString2(event.data, "previous");
  const next = getString2(event.data, "next");
  if (!sessionId || !previous || !next) {
    return fallbackDebug(event, base, "missing sessionId / previous / next");
  }
  const persisted = isRecord2(event.data) && typeof event.data["persisted"] === "boolean" ? event.data["persisted"] : false;
  return [
    {
      ...base,
      type: "session.approval_mode.changed",
      sessionId,
      previous,
      next,
      persisted
    }
  ];
}
__name(normalizeApprovalModeChanged, "normalizeApprovalModeChanged");
function normalizeMemoryChanged(event, base) {
  const scope = getString2(event.data, "scope");
  if (scope === "managed") {
    const source = getString2(event.data, "source");
    const taskId = getString2(event.data, "taskId");
    const touchedScopes = event.data?.["touchedScopes"];
    if (!(source && taskId && Array.isArray(touchedScopes)) || touchedScopes.some((s) => s !== "user" && s !== "project")) {
      return fallbackDebug(event, base, MALFORMED_MEMORY_CHANGED);
    }
    return [
      {
        ...base,
        type: "workspace.memory.changed",
        scope,
        source,
        taskId,
        touchedScopes
      }
    ];
  }
  const filePath = getString2(event.data, "filePath");
  const mode = getString2(event.data, "mode");
  const bytesWritten = numberField(
    isRecord2(event.data) ? event.data : void 0,
    "bytesWritten"
  );
  if (scope !== "workspace" && scope !== "global" || !filePath || mode !== "append" && mode !== "replace" || bytesWritten === void 0) {
    return fallbackDebug(event, base, MALFORMED_MEMORY_CHANGED);
  }
  return [
    {
      ...base,
      type: "workspace.memory.changed",
      scope,
      filePath,
      mode,
      bytesWritten
    }
  ];
}
__name(normalizeMemoryChanged, "normalizeMemoryChanged");
function normalizeAgentChanged(event, base) {
  const change = getString2(event.data, "change");
  const name = getString2(event.data, "name");
  const level = getString2(event.data, "level");
  if (change !== "created" && change !== "updated" && change !== "deleted" || !name || level !== "project" && level !== "user") {
    return fallbackDebug(event, base, "malformed agent_changed payload");
  }
  return [
    {
      ...base,
      type: "workspace.agent.changed",
      change,
      name,
      level
    }
  ];
}
__name(normalizeAgentChanged, "normalizeAgentChanged");
function normalizeToolToggled(event, base) {
  const toolName = getString2(event.data, "toolName");
  const enabled = isRecord2(event.data) && typeof event.data["enabled"] === "boolean" ? event.data["enabled"] : void 0;
  if (!toolName || enabled === void 0) {
    return fallbackDebug(event, base, "malformed tool_toggled payload");
  }
  return [
    {
      ...base,
      type: "workspace.tool.toggled",
      toolName,
      enabled
    }
  ];
}
__name(normalizeToolToggled, "normalizeToolToggled");
function normalizeSettingsChanged(event, base) {
  const key = getString2(event.data, "key");
  const scope = getString2(event.data, "scope");
  if (!key) {
    return fallbackDebug(event, base, "malformed settings_changed payload");
  }
  const mutation = isSettingsChangedData(event.data) && event.data.mutation;
  return [
    {
      ...base,
      type: "workspace.settings.changed",
      key,
      scope: scope ?? "workspace",
      value: isRecord2(event.data) ? event.data["value"] : void 0,
      ...mutation ? { mutation } : {}
    }
  ];
}
__name(normalizeSettingsChanged, "normalizeSettingsChanged");
function normalizeSettingsReloaded(event, base) {
  if (!isRecord2(event.data)) {
    return fallbackDebug(event, base, "malformed settings_reloaded payload");
  }
  return [
    {
      ...base,
      type: "workspace.settings.changed",
      key: "settings_reloaded",
      scope: "workspace",
      value: event.data
    }
  ];
}
__name(normalizeSettingsReloaded, "normalizeSettingsReloaded");
function normalizeWorkspaceInitialized(event, base) {
  const path = getString2(event.data, "path");
  const action = getString2(event.data, "action");
  if (!path || action !== "created" && action !== "overwrote" && action !== "noop") {
    return fallbackDebug(
      event,
      base,
      "malformed workspace_initialized payload"
    );
  }
  return [{ ...base, type: "workspace.initialized", path, action }];
}
__name(normalizeWorkspaceInitialized, "normalizeWorkspaceInitialized");
function normalizeTrustChangeRequested(event, base) {
  const workspaceCwd = getString2(event.data, "workspaceCwd");
  const desiredState = getString2(event.data, "desiredState");
  const reason = getString2(event.data, "reason");
  if (!workspaceCwd || desiredState !== "trusted" && desiredState !== "untrusted") {
    return fallbackDebug(event, base, "bad trust_change_requested payload");
  }
  return [
    {
      ...base,
      type: "workspace.trust.change.requested",
      workspaceCwd,
      desiredState,
      ...reason !== void 0 ? { reason } : {}
    }
  ];
}
__name(normalizeTrustChangeRequested, "normalizeTrustChangeRequested");
function normalizeGithubSetupCompleted(event, base) {
  const releaseTag = getString2(event.data, "releaseTag");
  const readmeUrl = getString2(event.data, "readmeUrl");
  if (!releaseTag || !readmeUrl || !isRecord2(event.data)) {
    return fallbackDebug(
      event,
      base,
      "malformed github_setup_completed payload"
    );
  }
  const workflows = event.data["workflows"];
  const warnings = event.data["warnings"];
  return [
    {
      ...base,
      type: "workspace.github.setup.completed",
      releaseTag,
      readmeUrl,
      ...typeof event.data["secretsUrl"] === "string" ? { secretsUrl: event.data["secretsUrl"] } : {},
      workflows: Array.isArray(workflows) ? workflows : [],
      gitignore: event.data["gitignore"],
      warnings: Array.isArray(warnings) ? warnings.filter(
        (warning) => typeof warning === "string"
      ) : []
    }
  ];
}
__name(normalizeGithubSetupCompleted, "normalizeGithubSetupCompleted");
function normalizeMcpBudgetWarning(event, base) {
  if (!isRecord2(event.data)) {
    return fallbackDebug(event, base, "non-object payload");
  }
  const liveCount = numberField(event.data, "liveCount");
  const reservedCount = numberField(event.data, "reservedCount");
  const budget = numberField(event.data, "budget");
  const thresholdRatio = numberField(event.data, "thresholdRatio");
  const mode = getString2(event.data, "mode");
  if (liveCount === void 0 || reservedCount === void 0 || budget === void 0 || thresholdRatio === void 0 || mode !== "warn" && mode !== "enforce") {
    return fallbackDebug(event, base, "malformed mcp_budget_warning payload");
  }
  return [
    {
      ...base,
      type: "workspace.mcp.budget_warning",
      liveCount,
      reservedCount,
      budget,
      thresholdRatio,
      mode
    }
  ];
}
__name(normalizeMcpBudgetWarning, "normalizeMcpBudgetWarning");
function normalizeMcpChildRefused(event, base) {
  if (!isRecord2(event.data)) {
    return fallbackDebug(event, base, "non-object payload");
  }
  const refusedServers = Array.isArray(event.data["refusedServers"]) ? event.data["refusedServers"].filter(isRecord2).map((s) => {
    const name = getString2(s, "name");
    const transport = getString2(s, "transport");
    const reason = getString2(s, "reason");
    if (!name || !transport || reason !== "budget_exhausted") return null;
    return {
      name,
      transport,
      reason: "budget_exhausted"
    };
  }).filter(
    (v) => v !== null
  ) : [];
  const budget = numberField(event.data, "budget");
  const liveCount = numberField(event.data, "liveCount");
  const reservedCount = numberField(event.data, "reservedCount");
  if (refusedServers.length === 0 || budget === void 0 || liveCount === void 0 || reservedCount === void 0) {
    return fallbackDebug(
      event,
      base,
      "malformed mcp_child_refused_batch payload"
    );
  }
  return [
    {
      ...base,
      type: "workspace.mcp.child_refused",
      refusedServers,
      budget,
      liveCount,
      reservedCount
    }
  ];
}
__name(normalizeMcpChildRefused, "normalizeMcpChildRefused");
function normalizeMcpServerRestarted(event, base) {
  const serverName = getString2(event.data, "serverName");
  const durationMs = numberField(event.data, "durationMs");
  if (!serverName || durationMs === void 0) {
    return fallbackDebug(event, base, "malformed mcp_server_restarted payload");
  }
  return [
    {
      ...base,
      type: "workspace.mcp.server_restarted",
      serverName,
      durationMs
    }
  ];
}
__name(normalizeMcpServerRestarted, "normalizeMcpServerRestarted");
function normalizeMcpServerRestartRefused(event, base) {
  const serverName = getString2(event.data, "serverName");
  const reason = getString2(event.data, "reason");
  if (!serverName || !reason || !MCP_RESTART_REFUSED_REASONS2.has(reason)) {
    return fallbackDebug(
      event,
      base,
      "malformed mcp_server_restart_refused payload"
    );
  }
  return [
    {
      ...base,
      type: "workspace.mcp.server_restart_refused",
      serverName,
      reason
    }
  ];
}
__name(normalizeMcpServerRestartRefused, "normalizeMcpServerRestartRefused");
function normalizeMcpServerChanged(event, base, fixedAction) {
  const serverName = getString2(event.data, fixedAction ? "name" : "serverName");
  const action = fixedAction ?? getString2(event.data, "action");
  if (!serverName || !action || ![
    "added",
    "removed",
    "approve",
    "enable",
    "disable",
    "authenticate",
    "clear-auth"
  ].includes(action)) {
    return fallbackDebug(event, base, `malformed ${event.type} payload`);
  }
  return [
    {
      ...base,
      type: "workspace.mcp.server_changed",
      serverName,
      action
    }
  ];
}
__name(normalizeMcpServerChanged, "normalizeMcpServerChanged");
function normalizeExtensionsChanged(event, base) {
  const refreshed = numberField(event.data, "refreshed");
  const failed = numberField(event.data, "failed");
  const status = getString2(event.data, "status");
  const source = getString2(event.data, "source");
  const name = getString2(event.data, "name");
  const version = getString2(event.data, "version");
  const error = getString2(event.data, "error");
  if (refreshed === void 0 || failed === void 0) {
    return fallbackDebug(event, base, "malformed extensions_changed payload");
  }
  if (status !== void 0 && status !== "installed" && status !== "enabled" && status !== "disabled" && status !== "updated" && status !== "uninstalled" && status !== "failed") {
    return fallbackDebug(event, base, "malformed extensions_changed payload");
  }
  return [
    {
      ...base,
      type: "workspace.extensions.changed",
      refreshed,
      failed,
      ...status ? { status } : {},
      ...source ? { source } : {},
      ...name ? { name } : {},
      ...version ? { version } : {},
      ...error ? { error } : {}
    }
  ];
}
__name(normalizeExtensionsChanged, "normalizeExtensionsChanged");
function normalizeAuthDeviceFlowStarted(event, base) {
  const deviceFlowId = getString2(event.data, "deviceFlowId");
  const providerId = getString2(event.data, "providerId");
  const expiresAt = numberField(event.data, "expiresAt");
  if (!deviceFlowId || !providerId || !DEVICE_FLOW_PROVIDER_SET.has(providerId) || expiresAt === void 0) {
    return fallbackDebug(
      event,
      base,
      "malformed auth_device_flow_started payload"
    );
  }
  return [
    {
      ...base,
      type: "auth.device_flow.started",
      deviceFlowId,
      providerId,
      expiresAt
    }
  ];
}
__name(normalizeAuthDeviceFlowStarted, "normalizeAuthDeviceFlowStarted");
function normalizeAuthDeviceFlowThrottled(event, base) {
  const deviceFlowId = getString2(event.data, "deviceFlowId");
  const intervalMs = numberField(event.data, "intervalMs");
  if (!deviceFlowId || intervalMs === void 0) {
    return fallbackDebug(
      event,
      base,
      "malformed auth_device_flow_throttled payload"
    );
  }
  return [
    {
      ...base,
      type: "auth.device_flow.throttled",
      deviceFlowId,
      intervalMs
    }
  ];
}
__name(normalizeAuthDeviceFlowThrottled, "normalizeAuthDeviceFlowThrottled");
function normalizeAuthDeviceFlowAuthorized(event, base) {
  const deviceFlowId = getString2(event.data, "deviceFlowId");
  const providerId = getString2(event.data, "providerId");
  if (!deviceFlowId || !providerId || !DEVICE_FLOW_PROVIDER_SET.has(providerId)) {
    return fallbackDebug(
      event,
      base,
      "malformed auth_device_flow_authorized payload"
    );
  }
  const expiresAt = numberField(event.data, "expiresAt");
  const accountAlias = getString2(event.data, "accountAlias");
  return [
    {
      ...base,
      type: "auth.device_flow.authorized",
      deviceFlowId,
      providerId,
      ...expiresAt !== void 0 ? { expiresAt } : {},
      ...accountAlias ? { accountAlias } : {}
    }
  ];
}
__name(normalizeAuthDeviceFlowAuthorized, "normalizeAuthDeviceFlowAuthorized");
function normalizeAuthDeviceFlowFailed(event, base) {
  const deviceFlowId = getString2(event.data, "deviceFlowId");
  const errorKind = getString2(event.data, "errorKind");
  if (!deviceFlowId || !isDeviceFlowErrorKind(errorKind)) {
    return fallbackDebug(
      event,
      base,
      "malformed auth_device_flow_failed payload"
    );
  }
  const hint = getString2(event.data, "hint");
  return [
    {
      ...base,
      type: "auth.device_flow.failed",
      deviceFlowId,
      errorKind,
      ...hint ? { hint } : {}
    }
  ];
}
__name(normalizeAuthDeviceFlowFailed, "normalizeAuthDeviceFlowFailed");
function isDeviceFlowErrorKind(value) {
  return typeof value === "string" && value.trim().length > 0;
}
__name(isDeviceFlowErrorKind, "isDeviceFlowErrorKind");
function normalizeAuthDeviceFlowCancelled(event, base) {
  const deviceFlowId = getString2(event.data, "deviceFlowId");
  if (!deviceFlowId) {
    return fallbackDebug(
      event,
      base,
      "malformed auth_device_flow_cancelled payload"
    );
  }
  return [{ ...base, type: "auth.device_flow.cancelled", deviceFlowId }];
}
__name(normalizeAuthDeviceFlowCancelled, "normalizeAuthDeviceFlowCancelled");
function normalizePromptCancellation(value, base) {
  const elapsedMs = numberField(value, "elapsedMs");
  const cancelledAt = numberField(value, "cancelledAt");
  const promptId = stringField(value, "promptId") ?? base.promptId;
  if (!promptId || elapsedMs === void 0 || elapsedMs < 0 || cancelledAt === void 0)
    return [];
  return [
    {
      ...base,
      type: "prompt.cancelled",
      promptId,
      elapsedMs,
      serverTimestamp: cancelledAt
    }
  ];
}
__name(normalizePromptCancellation, "normalizePromptCancellation");
function numberField(value, key) {
  if (!isRecord2(value)) return void 0;
  const v = value[key];
  return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
__name(numberField, "numberField");
function stringField(value, key) {
  if (!isRecord2(value)) return void 0;
  const v = value[key];
  return typeof v === "string" && v.length > 0 ? v : void 0;
}
__name(stringField, "stringField");

// packages/sdk-typescript/src/daemon/ui/transcript.ts
init_esbuild_shims();
var DEFAULT_MAX_BLOCKS = 1e3;
var DEFAULT_MAX_RETAINED_BYTES = 128 * 1024 * 1024;
var UNRECOGNIZED_DIAGNOSTICS_LIMIT = 50;
var TRIMMED_TOOL_BLOCK_ID = "__trimmed_tool_block__";
var TRIMMED_PERMISSION_BLOCK_ID = "__trimmed_permission_block__";
function isTrimmedToolBlockId(blockId) {
  return blockId === TRIMMED_TOOL_BLOCK_ID;
}
__name(isTrimmedToolBlockId, "isTrimmedToolBlockId");
function isTrimmedPermissionBlockId(blockId) {
  return blockId === TRIMMED_PERMISSION_BLOCK_ID;
}
__name(isTrimmedPermissionBlockId, "isTrimmedPermissionBlockId");
var MAX_TEXT_BLOCK_LENGTH = 1e5;
var TEXT_TRUNCATED_SUFFIX = "\n[truncated]\n";
var MAX_CLONE_DEPTH = 16;
var truncationCallbacks = /* @__PURE__ */ new WeakMap();
var timestampFormatterCache = /* @__PURE__ */ new Map();
function createDaemonTranscriptState(opts = {}) {
  const state = {
    blocks: [],
    blockIndexById: createIndex(),
    toolBlockByCallId: createIndex(),
    trimmedToolNotificationByCallId: createIndex(),
    permissionBlockByRequestId: createIndex(),
    activeAssistantBlockByParent: createIndex(),
    activeThoughtBlockByParent: createIndex(),
    // PR-E sidechannel: track current tool / approval mode / progress
    toolProgress: createIndex(),
    unrecognizedDiagnostics: [],
    awaitingResync: false,
    resyncRequiredCount: 0,
    nextOrdinal: 1,
    now: opts.now ?? Date.now(),
    maxBlocks: opts.maxBlocks ?? DEFAULT_MAX_BLOCKS,
    retainedBytes: 0,
    maxRetainedBytes: opts.maxRetainedBytes ?? DEFAULT_MAX_RETAINED_BYTES,
    retainSubagentBlocks: opts.retainSubagentBlocks ?? true
  };
  if (opts.onTruncation) truncationCallbacks.set(state, opts.onTruncation);
  return state;
}
__name(createDaemonTranscriptState, "createDaemonTranscriptState");
var IN_FLIGHT_TOOL_STATUSES = /* @__PURE__ */ new Set([
  "pending",
  "confirming",
  "running",
  "in_progress"
]);
var TERMINAL_TOOL_STATUSES = /* @__PURE__ */ new Set([
  "completed",
  "success",
  "failed",
  "error",
  "canceled",
  "cancelled"
]);
var RESYNC_PASSTHROUGH_TYPES2 = /* @__PURE__ */ new Set([
  "session.state_resync_required",
  "assistant.done",
  "status",
  "debug",
  "error"
]);
function appendLocalUserTranscriptMessage(state, text, opts = {}) {
  const next = cloneTranscriptState(state, opts);
  finishAssistant(next);
  const block = createTextBlock(
    next,
    "user",
    text,
    void 0,
    void 0,
    opts.meta
  );
  if (opts.images && opts.images.length > 0) {
    block.images = [...opts.images];
  }
  if (opts.files && opts.files.length > 0) {
    block.files = [...opts.files];
  }
  appendBlock(next, block);
  next.activeUserBlockId = block.id;
  return trimTranscriptState(next);
}
__name(appendLocalUserTranscriptMessage, "appendLocalUserTranscriptMessage");
var FREEZE_TRANSCRIPT_COLLECTIONS = typeof process !== "undefined" && false;
function reduceDaemonTranscriptEvents(state, events, opts = {}) {
  if (events.length === 0) return state;
  const maxBlocks = opts.maxBlocks ?? state.maxBlocks;
  const shareSideIndexes = state.blocks.length + events.length <= maxBlocks && events.every(
    (event) => (event.type === "assistant.text.delta" || event.type === "thought.text.delta") && event.parentToolCallId === void 0
  );
  const next = cloneTranscriptState(state, opts, shareSideIndexes);
  for (const event of events) applyDaemonTranscriptEvent(next, event);
  const result = trimTranscriptState(next, shareSideIndexes);
  if (FREEZE_TRANSCRIPT_COLLECTIONS) {
    Object.freeze(result.blocks);
    Object.freeze(result.blockIndexById);
    Object.freeze(result.toolBlockByCallId);
    Object.freeze(result.activeAssistantBlockByParent);
    Object.freeze(result.activeThoughtBlockByParent);
    Object.freeze(result.trimmedToolNotificationByCallId);
    Object.freeze(result.permissionBlockByRequestId);
    for (const progress of Object.values(result.toolProgress)) {
      Object.freeze(progress);
    }
    Object.freeze(result.toolProgress);
  }
  return result;
}
__name(reduceDaemonTranscriptEvents, "reduceDaemonTranscriptEvents");
function finalizeOfflineDaemonTranscriptState(state) {
  const next = cloneTranscriptState(state, { now: 0 });
  finishAssistant(next);
  next.activeUserBlockId = void 0;
  Object.freeze(next.blocks);
  Object.freeze(next.blockIndexById);
  return next;
}
__name(finalizeOfflineDaemonTranscriptState, "finalizeOfflineDaemonTranscriptState");
function rebuildDaemonTranscriptBlockIndex(blocks) {
  const blockIndexById = createIndex();
  blocks.forEach((block, index) => {
    blockIndexById[block.id] = index;
  });
  return blockIndexById;
}
__name(rebuildDaemonTranscriptBlockIndex, "rebuildDaemonTranscriptBlockIndex");
function userBlockForAttachment(next, event) {
  const activeUserIndex = next.activeUserBlockId ? next.blockIndexById[next.activeUserBlockId] : void 0;
  const activeUser = activeUserIndex !== void 0 ? next.blocks[activeUserIndex] : void 0;
  if (activeUser?.kind === "user" && stringArraysEqual(activeUser.sourceRecordIds, event.sourceRecordIds) && (activeUser.promptId === void 0 || event.promptId === void 0 || activeUser.promptId === event.promptId)) {
    const block2 = getWritableBlockById(next, activeUser.id);
    if (block2?.kind === "user") {
      if (block2.promptId === void 0 && event.promptId !== void 0) {
        const bytesBefore = estimateBlockBytes(block2);
        block2.promptId = event.promptId;
        next.retainedBytes += estimateBlockBytes(block2) - bytesBefore;
      }
      return block2;
    }
  }
  const block = createTextBlock(
    next,
    "user",
    "",
    event.eventId,
    event.serverTimestamp,
    event.meta,
    event.sourceRecordIds,
    event.promptId,
    event.segmentId
  );
  appendBlock(next, block);
  next.activeUserBlockId = block.id;
  return block;
}
__name(userBlockForAttachment, "userBlockForAttachment");
function applyDaemonTranscriptEvent(next, event) {
  if (event.eventId !== void 0) {
    next.lastEventId = Math.max(next.lastEventId ?? 0, event.eventId);
  }
  if (next.awaitingResync && !RESYNC_PASSTHROUGH_TYPES2.has(event.type)) {
    if (typeof console !== "undefined") {
      console.warn?.(
        `[daemon-ui] dropping event \`${event.type}\` while awaitingResync; state may be stale until session reconnect (lastResyncRequired: ${next.lastResyncRequired ? JSON.stringify(next.lastResyncRequired) : "unknown"})`
      );
    }
    return;
  }
  switch (event.type) {
    case "user.shell.command":
      next.pendingUserShellCommand = {
        command: event.command,
        ...event.cwd ? { cwd: event.cwd } : {}
      };
      break;
    case "user.text.delta":
      if (!next.activeUserBlockId) {
        next.lastFollowupSuggestion = void 0;
      }
      appendTextDelta(next, "user", "activeUserBlockId", event.text, event);
      break;
    case "user.image.delta": {
      const block = userBlockForAttachment(next, event);
      const bytesBefore = estimateBlockBytes(block);
      if (event.meta) block.meta = { ...block.meta, ...event.meta };
      block.images = [
        ...block.images ?? [],
        {
          data: event.data,
          mimeType: event.mimeType,
          ...event.attachmentId ? { attachmentId: event.attachmentId } : {}
        }
      ];
      next.retainedBytes += estimateBlockBytes(block) - bytesBefore;
      break;
    }
    case "user.file.delta": {
      const fileBlock = userBlockForAttachment(next, event);
      const fileBytesBefore = estimateBlockBytes(fileBlock);
      if (event.meta) fileBlock.meta = { ...fileBlock.meta, ...event.meta };
      fileBlock.files = [
        ...fileBlock.files ?? [],
        {
          name: event.name,
          mimeType: event.mimeType,
          attachmentId: event.attachmentId
        }
      ];
      next.retainedBytes += estimateBlockBytes(fileBlock) - fileBytesBefore;
      break;
    }
    case "user.resource_link.delta": {
      const block = userBlockForAttachment(next, event);
      const bytesBefore = estimateBlockBytes(block);
      if (event.meta) block.meta = { ...block.meta, ...event.meta };
      const links = block.resourceLinks ?? [];
      const index = links.findIndex(
        (link) => link.uri === event.resourceLink.uri
      );
      const resourceLink = mergeResourceLink(links[index], event.resourceLink);
      block.resourceLinks = index < 0 ? [...links, resourceLink] : links.map(
        (link, position) => position === index ? resourceLink : link
      );
      block.updatedAt = next.now;
      if (event.eventId !== void 0) block.eventId = event.eventId;
      next.retainedBytes += estimateBlockBytes(block) - bytesBefore;
      break;
    }
    case "assistant.text.delta":
      if (event.parentToolCallId && !next.retainSubagentBlocks) break;
      appendTextDelta(
        next,
        "assistant",
        "activeAssistantBlockId",
        event.text,
        event
      );
      break;
    case "assistant.done":
      if (event.branchRecordId && event.promptId && event.reason === "end_turn") {
        const assistant = getWritableBlockById(
          next,
          findFinalVisibleAssistantForPrompt(next, event.promptId)
        );
        if (assistant?.kind === "assistant") {
          assistant.branchRecordId = event.branchRecordId;
          assistant.sourceRecordIds = unionStrings(
            assistant.sourceRecordIds,
            event.sourceRecordIds
          );
        }
      }
      finishAssistant(next, event);
      if (event.reason === "cancelled" || event.reason === "error") {
        propagateCancellationToInFlightTools(next);
      }
      break;
    case "assistant.usage":
      if (isSubagentUsageDuplicate(next, event)) break;
      if (event.parentToolCallId && !next.retainSubagentBlocks) {
        applySubagentUsageToParentTool(next, event);
      } else {
        applyAssistantUsage(next, event);
      }
      break;
    case "thought.text.delta":
      if (event.parentToolCallId && !next.retainSubagentBlocks) break;
      appendTextDelta(
        next,
        "thought",
        "activeThoughtBlockId",
        event.text,
        event
      );
      break;
    case "tool.update":
      if (event.parentToolCallId && !next.retainSubagentBlocks) {
        discardToolBlock(next, event.toolCallId);
        break;
      }
      upsertToolBlock(next, event);
      break;
    case "shell.output":
      appendShellBlock(next, event);
      break;
    case "user.shell.output":
      appendUserShellBlock(next, event);
      break;
    case "permission.request":
      upsertPermissionBlock(next, event);
      break;
    case "permission.resolved":
      resolvePermissionBlock(next, event);
      break;
    case "model.changed":
      appendStatusBlock(
        next,
        "status",
        `Model switched: ${event.modelId}`,
        event
      );
      break;
    case "status":
    case "debug":
      if (isUnrecognizedDiagnostic(event)) {
        appendUnrecognizedDiagnostic(next, event);
        break;
      }
      appendStatusBlock(next, event.type, event.text, event, {
        clearActiveText: event.clearActiveText
      });
      break;
    case "error":
      appendStatusBlock(next, event.type, event.text, event);
      break;
    // Session-meta / workspace / auth events do NOT push transcript blocks.
    // Renderers subscribe to the store and select them via separate
    // selectors (e.g., `selectApprovalMode`, `selectAvailableCommands`,
    // `selectAuthFlow`) — see `selectors.ts`. They are still observed by
    // the reducer so `lastEventId` advances monotonically, but the
    // chat-stream transcript stays focused on user/assistant/tool/shell/
    // permission content. PRs in the C/D series may opt some of these
    // into transcript projection as structured non-chat blocks.
    case "session.approval_mode.changed":
      next.approvalMode = event.next;
      break;
    case "session.metadata.changed":
    case "session.artifact.changed":
    case "session.source.changed":
    case "session.available_commands":
      break;
    case "session.state_resync_required":
      handleStateResyncRequired(next, event);
      break;
    case "prompt.cancelled":
      propagateCancellationToInFlightTools(next);
      if (event.reason !== "forward_failed") {
        appendPromptCancelledBlock(next, event);
      }
      break;
    case "followup.suggestion":
      next.lastFollowupSuggestion = {
        suggestion: event.suggestion,
        promptId: event.promptId
      };
      break;
    case "session.replay_complete":
      break;
    case "session.rewound":
      rewindTranscriptToUserTurn(next, event.targetTurnIndex);
      break;
    case "session.branched":
      appendStatusBlock(
        next,
        "status",
        `Branched conversation "${event.displayName}". You are now in the branch.`,
        event
      );
      break;
    case "workspace.memory.changed":
    case "workspace.agent.changed":
    case "workspace.tool.toggled":
    case "workspace.settings.changed":
    case "workspace.initialized":
    case "workspace.mcp.budget_warning":
    case "workspace.mcp.child_refused":
    case "workspace.mcp.server_restarted":
    case "workspace.mcp.server_restart_refused":
    case "workspace.mcp.server_changed":
    case "auth.device_flow.started":
    case "auth.device_flow.throttled":
    case "auth.device_flow.authorized":
    case "auth.device_flow.failed":
    case "auth.device_flow.cancelled":
      break;
    default:
      void event;
  }
}
__name(applyDaemonTranscriptEvent, "applyDaemonTranscriptEvent");
function handleStateResyncRequired(state, event) {
  state.awaitingResync = true;
  state.resyncRequiredCount += 1;
  state.lastResyncRequired = {
    reason: event.reason,
    lastDeliveredId: event.lastDeliveredId,
    earliestAvailableId: event.earliestAvailableId
  };
  propagateCancellationToInFlightTools(state);
  appendStatusBlock(
    state,
    "error",
    `State resync required: ${formatMissedRange(event.lastDeliveredId, event.earliestAvailableId)}.`,
    event
  );
}
__name(handleStateResyncRequired, "handleStateResyncRequired");
function formatMissedRange(lastDeliveredId, earliestAvailableId) {
  const first = lastDeliveredId + 1;
  const last = earliestAvailableId - 1;
  if (last < first) return "no events lost (resync requested without gap)";
  if (last === first) return `missed 1 daemon event (id ${first})`;
  return `missed daemon events ${first}-${last}`;
}
__name(formatMissedRange, "formatMissedRange");
function selectTranscriptBlocks(state) {
  return state.blocks;
}
__name(selectTranscriptBlocks, "selectTranscriptBlocks");
function selectPendingPermissionBlocks(state) {
  return state.blocks.filter(
    (block) => block.kind === "permission" && block.resolved === void 0
  );
}
__name(selectPendingPermissionBlocks, "selectPendingPermissionBlocks");
function finalizeStreamingTextBlock(state, blockId, event) {
  const block = getWritableBlockById(state, blockId);
  if (block?.kind === "assistant" || block?.kind === "thought") {
    block.streaming = false;
    block.updatedAt = state.now;
    if (event?.eventId !== void 0) block.eventId = event.eventId;
    if (block.serverTimestamp === void 0 && event?.serverTimestamp !== void 0) {
      block.serverTimestamp = event.serverTimestamp;
    }
  }
}
__name(finalizeStreamingTextBlock, "finalizeStreamingTextBlock");
function clearActiveAssistant(state, event) {
  finalizeStreamingTextBlock(state, state.activeAssistantBlockId, event);
  state.activeAssistantBlockId = void 0;
}
__name(clearActiveAssistant, "clearActiveAssistant");
function applyAssistantUsage(state, event) {
  const activeBlockId = state.activeAssistantBlockId ?? (event.parentToolCallId ? void 0 : latestTopLevelAssistantBlockIdInCurrentTurn(state));
  const block = getWritableBlockById(state, activeBlockId);
  if (!block || block.kind !== "assistant") return;
  const prev = block.usage;
  block.usage = {
    inputTokens: (prev?.inputTokens ?? 0) + event.usage.inputTokens,
    outputTokens: (prev?.outputTokens ?? 0) + event.usage.outputTokens,
    cachedTokens: (prev?.cachedTokens ?? 0) + (event.usage.cachedTokens ?? 0)
  };
  block.updatedAt = state.now;
}
__name(applyAssistantUsage, "applyAssistantUsage");
function isSubagentUsageDuplicate(state, event) {
  if (!event.sourceRecordIds?.length) return false;
  const sourceRecordIds = new Set(event.sourceRecordIds);
  for (let i = state.blocks.length - 1; i >= 0; i -= 1) {
    const block = state.blocks[i];
    if (block.kind === "user" && !block.parentToolCallId) return false;
    if (block.kind !== "tool" || !block.sourceRecordIds?.some((id) => sourceRecordIds.has(id))) {
      continue;
    }
    const rawOutput = isRecord2(block.rawOutput) ? block.rawOutput : void 0;
    const summary = rawOutput && isRecord2(rawOutput["executionSummary"]) ? rawOutput["executionSummary"] : void 0;
    if (summary && event.parentToolCallId === block.toolCallId) return true;
    return summary?.["inputTokens"] === event.usage.inputTokens && summary["outputTokens"] === event.usage.outputTokens && (summary["cachedTokens"] ?? 0) === (event.usage.cachedTokens ?? 0);
  }
  return false;
}
__name(isSubagentUsageDuplicate, "isSubagentUsageDuplicate");
function latestTopLevelAssistantBlockIdInCurrentTurn(state) {
  for (let i = state.blocks.length - 1; i >= 0; i -= 1) {
    const block = state.blocks[i];
    if (block.kind === "user" && !block.parentToolCallId) return void 0;
    if (block.kind === "assistant" && !block.parentToolCallId) return block.id;
  }
  return void 0;
}
__name(latestTopLevelAssistantBlockIdInCurrentTurn, "latestTopLevelAssistantBlockIdInCurrentTurn");
function applySubagentUsageToParentTool(state, event) {
  if (!event.parentToolCallId) return;
  const block = getWritableBlockById(
    state,
    state.toolBlockByCallId[event.parentToolCallId]
  );
  if (block?.kind !== "tool") return;
  const current = isRecord2(block.rawOutput) ? block.rawOutput : void 0;
  const currentSummary = isRecord2(current?.["executionSummary"]) ? current["executionSummary"] : void 0;
  const inputTokens = finiteNumber(currentSummary?.["inputTokens"]) + event.usage.inputTokens;
  const outputTokens = finiteNumber(currentSummary?.["outputTokens"]) + event.usage.outputTokens;
  const cachedTokens = finiteNumber(currentSummary?.["cachedTokens"]) + (event.usage.cachedTokens ?? 0);
  block.rawOutput = {
    ...current ?? { type: "task_execution", status: "running" },
    executionSummary: {
      ...currentSummary ?? {},
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens: inputTokens + outputTokens
    }
  };
  block.updatedAt = state.now;
}
__name(applySubagentUsageToParentTool, "applySubagentUsageToParentTool");
function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
__name(finiteNumber, "finiteNumber");
function clearActiveThought(state, event) {
  finalizeStreamingTextBlock(state, state.activeThoughtBlockId, event);
  state.activeThoughtBlockId = void 0;
}
__name(clearActiveThought, "clearActiveThought");
function clearActiveAssistantForParent(state, parentToolCallId, event) {
  finalizeStreamingTextBlock(
    state,
    state.activeAssistantBlockByParent[parentToolCallId],
    event
  );
  delete state.activeAssistantBlockByParent[parentToolCallId];
}
__name(clearActiveAssistantForParent, "clearActiveAssistantForParent");
function clearActiveThoughtForParent(state, parentToolCallId, event) {
  finalizeStreamingTextBlock(
    state,
    state.activeThoughtBlockByParent[parentToolCallId],
    event
  );
  delete state.activeThoughtBlockByParent[parentToolCallId];
}
__name(clearActiveThoughtForParent, "clearActiveThoughtForParent");
function appendTextDelta(state, kind, activeKey, text, event) {
  const parentId = kind !== "user" && "parentToolCallId" in event ? event.parentToolCallId : void 0;
  const parentMap = parentId != null ? kind === "assistant" ? state.activeAssistantBlockByParent : kind === "thought" ? state.activeThoughtBlockByParent : void 0 : void 0;
  const effectiveId = parentMap && parentId != null ? parentMap[parentId] : state[activeKey];
  const existing = getWritableBlockById(state, effectiveId);
  if (existing && existing.kind === kind && canMergeTextDelta(existing, event)) {
    const separator = kind === "user" && existing.text.length > 0 && text.length > 0 && existing.segmentId !== event.segmentId && !existing.text.endsWith("\n") && !text.startsWith("\n") ? "\n" : "";
    existing.text = appendBoundedText(state, existing, separator + text);
    existing.updatedAt = state.now;
    if (event.eventId !== void 0) existing.eventId = event.eventId;
    if (event.serverTimestamp !== void 0) {
      existing.serverTimestamp = event.serverTimestamp;
    }
    if ("meta" in event && event.meta) {
      existing.meta = { ...existing.meta, ...event.meta };
    }
    if (existing.promptId === void 0 && event.promptId !== void 0) {
      existing.promptId = event.promptId;
    }
    if (event.segmentId !== void 0) {
      existing.segmentId = event.segmentId;
    }
    if (kind === "assistant" && event.branchRecordId) {
      existing.branchRecordId = event.branchRecordId;
    }
    if (kind !== "user") existing.streaming = true;
    return;
  }
  if (existing?.kind === kind && kind !== "user") {
    existing.streaming = false;
    existing.updatedAt = state.now;
  }
  const block = createTextBlock(
    state,
    kind,
    text,
    event.eventId,
    event.serverTimestamp,
    "meta" in event ? event.meta : void 0,
    event.sourceRecordIds,
    event.promptId,
    event.segmentId
  );
  if (kind === "assistant" && event.branchRecordId) {
    block.branchRecordId = event.branchRecordId;
  }
  if (kind !== "user") block.streaming = true;
  if (kind === "thought") block.collapsed = true;
  if (parentId != null) {
    block.parentToolCallId = parentId;
  }
  appendBlock(state, block);
  if (parentMap && parentId != null) {
    parentMap[parentId] = block.id;
  } else {
    state[activeKey] = block.id;
  }
  if (parentId != null) {
    if (kind === "assistant") {
      clearActiveThoughtForParent(state, parentId);
    }
    if (kind === "thought") {
      clearActiveAssistantForParent(state, parentId);
    }
  } else {
    if (kind !== "user") state.activeUserBlockId = void 0;
    if (kind !== "assistant") clearActiveAssistant(state);
    if (kind !== "thought") clearActiveThought(state);
  }
}
__name(appendTextDelta, "appendTextDelta");
function canMergeTextDelta(existing, event) {
  if (existing.kind !== "user" && existing.kind !== "assistant" && existing.kind !== "thought") {
    return false;
  }
  const sameRecordedUser = existing.kind === "user" && (existing.sourceRecordIds?.length ?? 0) > 0 && (event.sourceRecordIds?.length ?? 0) > 0;
  if (!sameRecordedUser && existing.meta?.qwenDiscreteMessage === true) {
    return false;
  }
  if (existing.promptId !== void 0 && event.promptId !== void 0 && existing.promptId !== event.promptId)
    return false;
  if (!sameRecordedUser && existing.segmentId !== event.segmentId) {
    return false;
  }
  if (!stringArraysEqual(existing.sourceRecordIds, event.sourceRecordIds)) {
    return false;
  }
  return sameRecordedUser || !("meta" in event) || event.meta?.qwenDiscreteMessage !== true;
}
__name(canMergeTextDelta, "canMergeTextDelta");
function findFinalVisibleAssistantForPrompt(state, promptId) {
  for (let index = state.blocks.length - 1; index >= 0; index--) {
    const block = state.blocks[index];
    if (block?.kind === "assistant" && block.parentToolCallId === void 0 && block.promptId === promptId && block.text.trim().length > 0) {
      return block.id;
    }
  }
  return void 0;
}
__name(findFinalVisibleAssistantForPrompt, "findFinalVisibleAssistantForPrompt");
function finishAssistant(state, event) {
  clearActiveAssistant(state, event);
  for (const parentId of Object.keys(state.activeAssistantBlockByParent)) {
    clearActiveAssistantForParent(state, parentId, event);
  }
  for (const parentId of Object.keys(state.activeThoughtBlockByParent)) {
    clearActiveThoughtForParent(state, parentId, event);
  }
  clearActiveThought(state, event);
}
__name(finishAssistant, "finishAssistant");
function upsertToolBlock(state, event) {
  const compactTaskOutput = !state.retainSubagentBlocks && isRecord2(event.rawOutput) && event.rawOutput["type"] === "task_execution";
  let rawOutput = compactTaskExecutionOutput(
    event.rawOutput,
    state.retainSubagentBlocks
  );
  const existingId = state.toolBlockByCallId[event.toolCallId];
  if (existingId === TRIMMED_TOOL_BLOCK_ID) {
    if (shouldRecreateTrimmedToolBlock(event)) {
      delete state.toolBlockByCallId[event.toolCallId];
      delete state.trimmedToolNotificationByCallId[event.toolCallId];
      return upsertToolBlock(state, event);
    }
    if (!state.trimmedToolNotificationByCallId[event.toolCallId]) {
      state.trimmedToolNotificationByCallId[event.toolCallId] = true;
      appendStatusBlock(
        state,
        "error",
        `Tool ${event.toolCallId} output trimmed (max blocks reached)`,
        event,
        { clearActiveText: false }
      );
    }
    return;
  }
  const retainedIndex = existingId !== void 0 ? state.blockIndexById[existingId] : void 0;
  const retainedBefore = retainedIndex !== void 0 ? state.blocks[retainedIndex] : void 0;
  const bytesBefore = retainedBefore ? estimateBlockBytes(retainedBefore) : 0;
  const existing = getWritableBlockById(state, existingId);
  if (existing?.kind === "tool") {
    if (event.subagentSessionReady !== void 0) {
      existing.subagentSessionReady = existing.subagentSessionReady === true || event.subagentSessionReady;
    }
    if (event.title !== void 0) existing.title = event.title;
    if (event.status !== void 0) existing.status = event.status;
    if (event.rawInput !== void 0) {
      existing.preview = createDaemonToolPreview(event.rawInput, {
        title: event.title,
        toolName: event.toolName,
        toolKind: event.toolKind
      });
    }
    existing.updatedAt = state.now;
    if (event.eventId !== void 0) existing.eventId = event.eventId;
    if (event.details) existing.details = event.details;
    if (compactTaskOutput) delete existing.content;
    else if (event.content !== void 0) existing.content = event.content;
    if (event.locations !== void 0) existing.locations = event.locations;
    if (event.rawInput !== void 0) existing.rawInput = event.rawInput;
    if (rawOutput !== void 0) {
      if (compactTaskOutput && isRecord2(rawOutput) && isRecord2(existing.rawOutput)) {
        const prevSummary = isRecord2(existing.rawOutput["executionSummary"]) ? existing.rawOutput["executionSummary"] : void 0;
        const nextSummary = isRecord2(rawOutput["executionSummary"]) ? rawOutput["executionSummary"] : void 0;
        if (prevSummary && nextSummary) {
          const inputTokens = Math.max(
            finiteNumber(prevSummary["inputTokens"]),
            finiteNumber(nextSummary["inputTokens"])
          );
          const outputTokens = Math.max(
            finiteNumber(prevSummary["outputTokens"]),
            finiteNumber(nextSummary["outputTokens"])
          );
          rawOutput = {
            ...rawOutput,
            executionSummary: {
              ...nextSummary,
              inputTokens,
              outputTokens,
              cachedTokens: Math.max(
                finiteNumber(prevSummary["cachedTokens"]),
                finiteNumber(nextSummary["cachedTokens"])
              ),
              totalTokens: Math.max(
                finiteNumber(prevSummary["totalTokens"]),
                finiteNumber(nextSummary["totalTokens"]),
                inputTokens + outputTokens
              )
            }
          };
        } else if (prevSummary) {
          rawOutput = {
            ...rawOutput,
            executionSummary: { ...prevSummary }
          };
        }
      }
      existing.rawOutput = rawOutput;
      if (isBackgroundToolOutput(rawOutput)) existing.background = true;
    }
    const resultPreview2 = event.resultPreview ?? createDaemonToolResultPreview(
      rawOutput ?? existing.rawOutput,
      event.content ?? existing.content,
      {
        toolName: event.toolName ?? existing.toolName,
        toolKind: event.toolKind ?? existing.toolKind
      }
    );
    if (resultPreview2) existing.resultPreview = resultPreview2;
    else if (event.resultPreview !== void 0 || rawOutput !== void 0 || event.content !== void 0) {
      delete existing.resultPreview;
    }
    existing.sourceRecordIds = unionStrings(
      existing.sourceRecordIds,
      event.sourceRecordIds
    );
    if (event.toolName) existing.toolName = event.toolName;
    if (event.toolKind) existing.toolKind = event.toolKind;
    if (event.parentToolCallId && !existing.parentToolCallId) {
      existing.parentToolCallId = event.parentToolCallId;
    }
    if (existing.parentToolCallId && !existing.parentBlockId) {
      const candidateId = state.toolBlockByCallId[existing.parentToolCallId];
      if (candidateId && candidateId !== TRIMMED_TOOL_BLOCK_ID) {
        existing.parentBlockId = candidateId;
      }
    }
    if (event.subagentType && !existing.subagentType) {
      existing.subagentType = event.subagentType;
    }
    state.retainedBytes += estimateBlockBytes(existing) - bytesBefore;
    updateCurrentToolPointer(state, event.toolCallId, event.status);
    return;
  }
  const parentBlockId = event.parentToolCallId && state.toolBlockByCallId[event.parentToolCallId] !== TRIMMED_TOOL_BLOCK_ID ? state.toolBlockByCallId[event.parentToolCallId] : void 0;
  const resultPreview = event.resultPreview ?? createDaemonToolResultPreview(rawOutput, event.content, {
    toolName: event.toolName,
    toolKind: event.toolKind
  });
  const block = {
    id: allocateBlockId(state, "tool"),
    kind: "tool",
    toolCallId: event.toolCallId,
    title: event.title ?? event.toolName ?? event.toolKind ?? "Tool",
    status: event.status ?? "pending",
    preview: createDaemonToolPreview(event.rawInput, {
      title: event.title,
      toolName: event.toolName,
      toolKind: event.toolKind
    }),
    ...resultPreview ? { resultPreview } : {},
    ...isBackgroundToolOutput(rawOutput) ? { background: true } : {},
    ...event.subagentSessionReady !== void 0 ? { subagentSessionReady: event.subagentSessionReady } : {},
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...event.eventId !== void 0 ? { eventId: event.eventId } : {},
    ...event.backgroundTurn ? {
      backgroundTurn: event.backgroundTurn,
      promptId: event.backgroundTurn.turnId
    } : {},
    ...event.serverTimestamp !== void 0 ? { serverTimestamp: event.serverTimestamp } : {},
    ...event.sourceRecordIds ? { sourceRecordIds: [...event.sourceRecordIds] } : {},
    ...event.segmentId ? { segmentId: event.segmentId } : {},
    ...event.details ? { details: event.details } : {},
    ...!compactTaskOutput && event.content !== void 0 ? { content: event.content } : {},
    ...event.locations !== void 0 ? { locations: event.locations } : {},
    ...event.rawInput !== void 0 ? { rawInput: event.rawInput } : {},
    ...rawOutput !== void 0 ? { rawOutput } : {},
    ...event.toolName ? { toolName: event.toolName } : {},
    ...event.toolKind ? { toolKind: event.toolKind } : {},
    ...event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {},
    ...event.subagentType ? { subagentType: event.subagentType } : {},
    ...parentBlockId ? { parentBlockId } : {}
  };
  appendBlock(state, block);
  state.toolBlockByCallId[event.toolCallId] = block.id;
  for (const candidate of state.blocks) {
    if (candidate.kind === "tool" && candidate.parentToolCallId === event.toolCallId && !candidate.parentBlockId) {
      const writable = getWritableBlockById(state, candidate.id);
      if (writable?.kind === "tool") {
        writable.parentBlockId = block.id;
      }
    }
  }
  updateCurrentToolPointer(state, event.toolCallId, event.status ?? "pending");
  clearActiveText(state, event.parentToolCallId);
}
__name(upsertToolBlock, "upsertToolBlock");
function isBackgroundToolOutput(value) {
  return isRecord2(value) && value["status"] === "background";
}
__name(isBackgroundToolOutput, "isBackgroundToolOutput");
function discardToolBlock(state, toolCallId) {
  const blockId = state.toolBlockByCallId[toolCallId];
  if (!blockId || blockId === TRIMMED_TOOL_BLOCK_ID) return;
  const droppedIndex = state.blockIndexById[blockId];
  const dropped = droppedIndex !== void 0 ? state.blocks[droppedIndex] : void 0;
  takeBlocksOwnership(state);
  state.blocks = state.blocks.filter((block) => block.id !== blockId);
  if (dropped) {
    state.retainedBytes = Math.max(
      0,
      state.retainedBytes - estimateBlockBytes(dropped)
    );
  }
  state.blockIndexById = rebuildDaemonTranscriptBlockIndex(state.blocks);
  ownedBlocks.set(state, state.blocks);
  ownedBlockIndexes.set(state, state.blockIndexById);
  delete state.toolBlockByCallId[toolCallId];
  delete state.toolProgress[toolCallId];
  if (state.currentToolCallId === toolCallId) {
    state.currentToolCallId = void 0;
  }
}
__name(discardToolBlock, "discardToolBlock");
function isTaskExecutionMode(value) {
  return value === "foreground" || value === "background";
}
__name(isTaskExecutionMode, "isTaskExecutionMode");
function compactTaskExecutionOutput(rawOutput, retainSubagentBlocks) {
  if (retainSubagentBlocks || !isRecord2(rawOutput) || rawOutput["type"] !== "task_execution") {
    return rawOutput;
  }
  const compact = { type: "task_execution" };
  for (const key of [
    "subagentName",
    "subagentColor",
    "taskDescription",
    "status",
    "executionMode",
    "subagentSessionReady",
    "terminateReason",
    "tokenCount",
    "executionSummary",
    "skills"
  ]) {
    if (rawOutput[key] !== void 0) compact[key] = rawOutput[key];
  }
  return compact;
}
__name(compactTaskExecutionOutput, "compactTaskExecutionOutput");
function updateCurrentToolPointer(state, toolCallId, status) {
  if (status === void 0) return;
  if (IN_FLIGHT_TOOL_STATUSES.has(status)) {
    state.currentToolCallId = toolCallId;
    return;
  }
  if (TERMINAL_TOOL_STATUSES.has(status)) {
    if (state.currentToolCallId === toolCallId) {
      state.currentToolCallId = findLatestInFlightToolCallId(state);
    }
    return;
  }
}
__name(updateCurrentToolPointer, "updateCurrentToolPointer");
function findLatestInFlightToolCallId(state) {
  for (let index = state.blocks.length - 1; index >= 0; index -= 1) {
    const block = state.blocks[index];
    if (block?.kind !== "tool") continue;
    if (IN_FLIGHT_TOOL_STATUSES.has(block.status)) return block.toolCallId;
  }
  return void 0;
}
__name(findLatestInFlightToolCallId, "findLatestInFlightToolCallId");
function propagateCancellationToInFlightTools(state) {
  for (const blockId of Object.values(state.toolBlockByCallId)) {
    if (blockId === TRIMMED_TOOL_BLOCK_ID) continue;
    const block = getWritableBlockById(state, blockId);
    if (!block || block.kind !== "tool") continue;
    if (!IN_FLIGHT_TOOL_STATUSES.has(block.status)) continue;
    block.status = "cancelled";
    block.updatedAt = state.now;
  }
  state.currentToolCallId = void 0;
}
__name(propagateCancellationToInFlightTools, "propagateCancellationToInFlightTools");
function appendShellBlock(state, event) {
  if (!event.text) return;
  const last = state.blocks[state.blocks.length - 1];
  if (last?.kind === "shell" && last.stream === event.stream && last.segmentId === event.segmentId) {
    const writable = getWritableBlockById(state, last.id);
    if (writable?.kind === "shell") {
      writable.text = appendBoundedText(state, writable, event.text);
      writable.updatedAt = state.now;
      if (event.eventId !== void 0) writable.eventId = event.eventId;
    }
    return;
  }
  const blockId = allocateBlockId(state, "shell");
  const block = {
    id: blockId,
    kind: "shell",
    text: truncateText(state, blockId, void 0, event.text),
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...event.eventId !== void 0 ? { eventId: event.eventId } : {},
    ...event.backgroundTurn ? {
      backgroundTurn: event.backgroundTurn,
      promptId: event.backgroundTurn.turnId
    } : {},
    ...event.serverTimestamp !== void 0 ? { serverTimestamp: event.serverTimestamp } : {},
    ...event.segmentId ? { segmentId: event.segmentId } : {},
    ...event.stream ? { stream: event.stream } : {}
  };
  appendBlock(state, block);
  clearActiveText(state);
}
__name(appendShellBlock, "appendShellBlock");
function appendUserShellBlock(state, event) {
  if (!event.text) return;
  const last = state.blocks[state.blocks.length - 1];
  if (last?.kind === "user_shell" && last.stream === event.stream && last.segmentId === event.segmentId && !state.pendingUserShellCommand) {
    const writable = getWritableBlockById(state, last.id);
    if (writable?.kind === "user_shell") {
      writable.text = appendBoundedText(state, writable, event.text);
      writable.updatedAt = state.now;
      if (event.eventId !== void 0) writable.eventId = event.eventId;
    }
    return;
  }
  const pending = state.pendingUserShellCommand;
  const previous = last?.kind === "user_shell" ? last : void 0;
  const blockId = allocateBlockId(state, "user-shell");
  const block = {
    id: blockId,
    kind: "user_shell",
    text: truncateText(state, blockId, void 0, event.text),
    command: pending?.command ?? previous?.command ?? "",
    ...pending?.cwd || previous?.cwd ? { cwd: pending?.cwd ?? previous?.cwd } : {},
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...event.eventId !== void 0 ? { eventId: event.eventId } : {},
    ...event.backgroundTurn ? {
      backgroundTurn: event.backgroundTurn,
      promptId: event.backgroundTurn.turnId
    } : {},
    ...event.serverTimestamp !== void 0 ? { serverTimestamp: event.serverTimestamp } : {},
    ...event.segmentId ? { segmentId: event.segmentId } : {},
    ...event.stream ? { stream: event.stream } : {}
  };
  state.pendingUserShellCommand = void 0;
  appendBlock(state, block);
  clearActiveText(state);
}
__name(appendUserShellBlock, "appendUserShellBlock");
function upsertPermissionBlock(state, event) {
  const existingId = state.permissionBlockByRequestId[event.requestId];
  if (existingId === TRIMMED_PERMISSION_BLOCK_ID) return;
  const existing = getWritableBlockById(state, existingId);
  const preview = createDaemonToolPreview(event.toolCall, {
    title: event.title
  });
  const toolIdentity = getPermissionToolIdentity(event.toolCall);
  if (existing?.kind === "permission") {
    existing.title = event.title;
    existing.options = event.options.map((option) => ({ ...option }));
    existing.toolCall = event.toolCall;
    existing.preview = preview;
    if (toolIdentity.toolCallId) existing.toolCallId = toolIdentity.toolCallId;
    if (toolIdentity.toolName) existing.toolName = toolIdentity.toolName;
    if (toolIdentity.toolKind) existing.toolKind = toolIdentity.toolKind;
    existing.updatedAt = state.now;
    if (event.eventId !== void 0) existing.eventId = event.eventId;
    return;
  }
  const block = {
    id: allocateBlockId(state, "permission"),
    kind: "permission",
    requestId: event.requestId,
    title: event.title,
    options: event.options.map((option) => ({ ...option })),
    preview,
    ...toolIdentity,
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...event.eventId !== void 0 ? { eventId: event.eventId } : {},
    ...event.backgroundTurn ? {
      backgroundTurn: event.backgroundTurn,
      promptId: event.backgroundTurn.turnId
    } : {},
    ...event.serverTimestamp !== void 0 ? { serverTimestamp: event.serverTimestamp } : {},
    ...event.segmentId ? { segmentId: event.segmentId } : {},
    ...event.sessionId ? { sessionId: event.sessionId } : {},
    ...event.toolCall !== void 0 ? { toolCall: event.toolCall } : {}
  };
  appendBlock(state, block);
  state.permissionBlockByRequestId[event.requestId] = block.id;
  clearActiveText(state);
}
__name(upsertPermissionBlock, "upsertPermissionBlock");
function resolvePermissionBlock(state, event) {
  const existingId = state.permissionBlockByRequestId[event.requestId];
  if (existingId === void 0 || existingId === TRIMMED_PERMISSION_BLOCK_ID) {
    return;
  }
  const existing = getWritableBlockById(state, existingId);
  if (existing?.kind === "permission") {
    existing.resolved = event.outcome;
    existing.updatedAt = state.now;
    if (event.eventId !== void 0) existing.eventId = event.eventId;
    return;
  }
  const block = {
    id: allocateBlockId(state, "permission"),
    kind: "permission",
    requestId: event.requestId,
    title: `Permission resolved: ${event.requestId}`,
    options: [],
    preview: { kind: "generic", summary: event.outcome },
    resolved: event.outcome,
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...event.eventId !== void 0 ? { eventId: event.eventId } : {},
    ...event.backgroundTurn ? {
      backgroundTurn: event.backgroundTurn,
      promptId: event.backgroundTurn.turnId
    } : {},
    ...event.serverTimestamp !== void 0 ? { serverTimestamp: event.serverTimestamp } : {},
    ...event.segmentId ? { segmentId: event.segmentId } : {}
  };
  appendBlock(state, block);
  state.permissionBlockByRequestId[event.requestId] = block.id;
  clearActiveText(state);
}
__name(resolvePermissionBlock, "resolvePermissionBlock");
function isUnrecognizedDiagnostic(event) {
  return event.type === "debug" && isUnrecognizedDiagnosticReason(event.debugReason);
}
__name(isUnrecognizedDiagnostic, "isUnrecognizedDiagnostic");
function appendUnrecognizedDiagnostic(state, event) {
  state.activeUserBlockId = void 0;
  const diagnostic = {
    debugReason: event.debugReason,
    text: truncateTextAtLimit(event.text),
    clientReceivedAt: state.now,
    ...event.promptId !== void 0 ? { promptId: event.promptId } : {},
    ...event.sourceRecordIds !== void 0 ? { sourceRecordIds: event.sourceRecordIds } : {},
    ...event.branchRecordId !== void 0 ? { branchRecordId: event.branchRecordId } : {},
    ...event.originatorClientId !== void 0 ? { originatorClientId: event.originatorClientId } : {},
    ...event.eventId !== void 0 ? { eventId: event.eventId } : {},
    ...event.backgroundTurn ? {
      backgroundTurn: event.backgroundTurn,
      promptId: event.backgroundTurn.turnId
    } : {},
    ...event.serverTimestamp !== void 0 ? { serverTimestamp: event.serverTimestamp } : {}
  };
  const diagnostics = [...state.unrecognizedDiagnostics, diagnostic];
  state.unrecognizedDiagnostics = diagnostics.length > UNRECOGNIZED_DIAGNOSTICS_LIMIT ? diagnostics.slice(-UNRECOGNIZED_DIAGNOSTICS_LIMIT) : diagnostics;
}
__name(appendUnrecognizedDiagnostic, "appendUnrecognizedDiagnostic");
function appendStatusBlock(state, kind, text, event, opts = {}) {
  const blockId = allocateBlockId(state, kind);
  const block = {
    id: blockId,
    kind,
    text: truncateText(state, blockId, void 0, text),
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...event?.eventId !== void 0 ? { eventId: event.eventId } : {},
    ...event?.backgroundTurn ? {
      backgroundTurn: event.backgroundTurn,
      promptId: event.backgroundTurn.turnId
    } : {},
    ...event?.serverTimestamp !== void 0 ? { serverTimestamp: event.serverTimestamp } : {},
    ...event?.segmentId ? { segmentId: event.segmentId } : {},
    ...event?.type === "error" && event.code ? { code: event.code } : {},
    ...event?.type === "error" && event.promptId ? { promptId: event.promptId } : {},
    ...event?.type === "error" && event.errorKind ? { errorKind: event.errorKind } : {},
    ...event?.type === "error" && event.source ? { source: event.source } : {},
    ...(event?.type === "status" || event?.type === "debug") && event.source ? { source: event.source } : {},
    ...(event?.type === "status" || event?.type === "debug") && event.data !== void 0 ? { data: event.data } : {},
    ...(event?.type === "status" || event?.type === "debug") && event.debugReason ? { debugReason: event.debugReason } : {},
    ...event?.type === "session.branched" ? {
      source: "session_branched",
      data: {
        sourceSessionId: event.sourceSessionId,
        newSessionId: event.newSessionId,
        displayName: event.displayName
      }
    } : {}
  };
  appendBlock(state, block);
  if (opts.clearActiveText !== false) clearActiveText(state);
  else state.activeUserBlockId = void 0;
}
__name(appendStatusBlock, "appendStatusBlock");
function appendPromptCancelledBlock(state, event) {
  const existing = event.promptId ? state.blocks.find(
    (block2) => block2.kind === "prompt_cancelled" && block2.promptId === event.promptId
  ) : void 0;
  if (existing) {
    if (event.elapsedMs === void 0) return;
    const block2 = getWritableBlockById(state, existing.id);
    if (block2?.kind !== "prompt_cancelled") return;
    const bytesBefore = estimateBlockBytes(block2);
    block2.elapsedMs = event.elapsedMs;
    if (event.serverTimestamp !== void 0) {
      block2.serverTimestamp = event.serverTimestamp;
    }
    if (event.sourceRecordIds) block2.sourceRecordIds = event.sourceRecordIds;
    block2.updatedAt = state.now;
    state.retainedBytes += estimateBlockBytes(block2) - bytesBefore;
    return;
  }
  const block = {
    id: allocateBlockId(state, "prompt_cancelled"),
    kind: "prompt_cancelled",
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...event.promptId ? { promptId: event.promptId } : {},
    ...event.elapsedMs !== void 0 ? { elapsedMs: event.elapsedMs } : {},
    ...event.sourceRecordIds ? { sourceRecordIds: event.sourceRecordIds } : {},
    ...event.reason ? { reason: event.reason } : {},
    ...event.eventId !== void 0 ? { eventId: event.eventId } : {},
    ...event.backgroundTurn ? {
      backgroundTurn: event.backgroundTurn,
      promptId: event.backgroundTurn.turnId
    } : {},
    ...event.serverTimestamp !== void 0 ? { serverTimestamp: event.serverTimestamp } : {},
    ...event.segmentId ? { segmentId: event.segmentId } : {}
  };
  appendBlock(state, block);
  clearActiveText(state);
}
__name(appendPromptCancelledBlock, "appendPromptCancelledBlock");
function createTextBlock(state, kind, text, eventId, serverTimestamp, meta, sourceRecordIds, promptId, segmentId) {
  const blockId = allocateBlockId(state, kind);
  return {
    id: blockId,
    kind,
    text: truncateText(state, blockId, sourceRecordIds, text),
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...eventId !== void 0 ? { eventId } : {},
    ...serverTimestamp !== void 0 ? { serverTimestamp } : {},
    ...sourceRecordIds ? { sourceRecordIds: [...sourceRecordIds] } : {},
    ...segmentId ? { segmentId } : {},
    ...promptId ? { promptId } : {},
    ...meta ? { meta: { ...meta } } : {}
  };
}
__name(createTextBlock, "createTextBlock");
function cloneTranscriptState(state, opts, shareSideIndexes = false) {
  const next = {
    ...state,
    now: opts.now ?? Date.now(),
    maxBlocks: opts.maxBlocks ?? state.maxBlocks,
    maxRetainedBytes: opts.maxRetainedBytes ?? state.maxRetainedBytes,
    retainSubagentBlocks: opts.retainSubagentBlocks ?? state.retainSubagentBlocks,
    // Lazy copy-on-write for
    // `blocks` + `blockIndexById`. Eager `[...state.blocks]` defeated the
    // `sortedBlocksCache` / `childrenIndexCache` WeakMaps — every dispatch
    // (even sidechannel-only events that don't touch blocks) produced a
    // fresh `blocks` reference, so the caches never hit. Now share the
    // reference; `takeBlocksOwnership` below copies just-in-time at the
    // first mutation. Identical behavior; the only observable diff is
    // that snapshots for non-block-mutating events keep the same
    // `state.blocks` identity, which is exactly what `useSyncExternalStore`
    // consumers + the WeakMap caches want.
    blocks: state.blocks,
    blockIndexById: state.blockIndexById,
    // Top-level streamed text cannot mutate these side indexes. Sharing them
    // avoids work proportional to historical tool count on every delta.
    toolBlockByCallId: shareSideIndexes ? state.toolBlockByCallId : createIndex(state.toolBlockByCallId),
    activeAssistantBlockByParent: shareSideIndexes ? state.activeAssistantBlockByParent : createIndex(state.activeAssistantBlockByParent),
    activeThoughtBlockByParent: shareSideIndexes ? state.activeThoughtBlockByParent : createIndex(state.activeThoughtBlockByParent),
    trimmedToolNotificationByCallId: shareSideIndexes ? state.trimmedToolNotificationByCallId : createIndex(state.trimmedToolNotificationByCallId),
    permissionBlockByRequestId: shareSideIndexes ? state.permissionBlockByRequestId : createIndex(state.permissionBlockByRequestId),
    // Other reducer events may mutate the inner progress records, so those
    // paths still deep-clone them before applying updates.
    toolProgress: shareSideIndexes ? state.toolProgress : createIndex(
      Object.fromEntries(
        Object.entries(state.toolProgress).map(([k, v]) => [k, { ...v }])
      )
    ),
    lastResyncRequired: state.lastResyncRequired !== void 0 ? { ...state.lastResyncRequired } : void 0,
    // Share the reference — the reducer assigns a new object when
    // updating (never mutates in-place), so reference stability across
    // unrelated dispatches lets `useSyncExternalStore` subscribers
    // (e.g. `useDaemonFollowupSuggestion`) skip re-renders for events
    // that don't touch the suggestion.
    lastFollowupSuggestion: state.lastFollowupSuggestion,
    // Same reference-stability contract: the reducer replaces the whole
    // array when appending, never mutates it in-place.
    unrecognizedDiagnostics: state.unrecognizedDiagnostics
  };
  const onTruncation = opts.onTruncation ?? truncationCallbacks.get(state);
  if (onTruncation) truncationCallbacks.set(next, onTruncation);
  return next;
}
__name(cloneTranscriptState, "cloneTranscriptState");
function sharesSourceRecordId(a, b) {
  const aIds = a.sourceRecordIds;
  const bIds = b.sourceRecordIds;
  if (!aIds?.length || !bIds?.length) return false;
  const set = new Set(aIds);
  return bIds.some((recordId) => set.has(recordId));
}
__name(sharesSourceRecordId, "sharesSourceRecordId");
function trimTranscriptState(state, sideIndexesShared = false) {
  const overByteBudget = state.retainedBytes > state.maxRetainedBytes;
  if (state.blocks.length <= state.maxBlocks && !overByteBudget) return state;
  const effectiveMaxBlocks = Math.max(
    1,
    Math.floor(Number.isFinite(state.maxBlocks) ? state.maxBlocks : 1)
  );
  let removeCount = Math.max(0, state.blocks.length - effectiveMaxBlocks);
  let bytes = state.retainedBytes;
  for (let i = 0; i < removeCount; i += 1) {
    bytes -= estimateBlockBytes(state.blocks[i]);
  }
  while (removeCount < state.blocks.length - 1 && bytes > state.maxRetainedBytes) {
    bytes -= estimateBlockBytes(state.blocks[removeCount]);
    removeCount += 1;
  }
  while (removeCount > 0 && removeCount < state.blocks.length - 1 && sharesSourceRecordId(
    state.blocks[removeCount - 1],
    state.blocks[removeCount]
  )) {
    bytes -= estimateBlockBytes(state.blocks[removeCount]);
    removeCount += 1;
  }
  while (removeCount > 0 && sharesSourceRecordId(
    state.blocks[removeCount - 1],
    state.blocks[removeCount]
  )) {
    removeCount -= 1;
    bytes += estimateBlockBytes(state.blocks[removeCount]);
  }
  if (removeCount === 0) return state;
  state.retainedBytes = Math.max(0, bytes);
  const blocks = state.blocks.slice(removeCount);
  const keptIds = new Set(blocks.map((block) => block.id));
  state.blocks = blocks;
  state.blockIndexById = rebuildDaemonTranscriptBlockIndex(blocks);
  ownedBlocks.set(state, state.blocks);
  ownedBlockIndexes.set(state, state.blockIndexById);
  if (sideIndexesShared) {
    state.toolBlockByCallId = createIndex(state.toolBlockByCallId);
    state.activeAssistantBlockByParent = createIndex(
      state.activeAssistantBlockByParent
    );
    state.activeThoughtBlockByParent = createIndex(
      state.activeThoughtBlockByParent
    );
    state.trimmedToolNotificationByCallId = createIndex(
      state.trimmedToolNotificationByCallId
    );
    state.permissionBlockByRequestId = createIndex(
      state.permissionBlockByRequestId
    );
  }
  for (const [toolCallId, blockId] of Object.entries(state.toolBlockByCallId)) {
    if (!keptIds.has(blockId)) {
      state.toolBlockByCallId[toolCallId] = TRIMMED_TOOL_BLOCK_ID;
    }
  }
  pruneTrimmedToolIndexes(state);
  for (const [toolCallId] of Object.entries(
    state.trimmedToolNotificationByCallId
  )) {
    if (state.toolBlockByCallId[toolCallId] !== TRIMMED_TOOL_BLOCK_ID) {
      delete state.trimmedToolNotificationByCallId[toolCallId];
    }
  }
  for (const [requestId, blockId] of Object.entries(
    state.permissionBlockByRequestId
  )) {
    if (!keptIds.has(blockId)) {
      state.permissionBlockByRequestId[requestId] = TRIMMED_PERMISSION_BLOCK_ID;
    }
  }
  pruneTrimmedPermissionIndexes(state);
  for (const block of state.blocks) {
    if (block.kind !== "tool") continue;
    if (block.parentBlockId && !keptIds.has(block.parentBlockId)) {
      const writable = getWritableBlockById(state, block.id);
      if (writable?.kind === "tool") {
        writable.parentBlockId = void 0;
      }
    }
  }
  if (!keptIds.has(state.activeUserBlockId ?? "")) {
    state.activeUserBlockId = void 0;
  }
  if (!keptIds.has(state.activeAssistantBlockId ?? "")) {
    state.activeAssistantBlockId = void 0;
  }
  if (!keptIds.has(state.activeThoughtBlockId ?? "")) {
    state.activeThoughtBlockId = void 0;
  }
  for (const [parentId, blockId] of Object.entries(
    state.activeAssistantBlockByParent
  )) {
    if (!keptIds.has(blockId)) {
      delete state.activeAssistantBlockByParent[parentId];
    }
  }
  for (const [parentId, blockId] of Object.entries(
    state.activeThoughtBlockByParent
  )) {
    if (!keptIds.has(blockId)) {
      delete state.activeThoughtBlockByParent[parentId];
    }
  }
  const oldestRetainedBlock = state.blocks.find(
    (block) => (block.sourceRecordIds?.length ?? 0) > 0
  );
  truncationCallbacks.get(state)?.({
    kind: "blocks",
    oldestRetainedRecordId: oldestRetainedBlock?.sourceRecordIds?.[0],
    evictedOldest: true,
    blockCount: state.blocks.length,
    retainedBytes: state.retainedBytes,
    maxBlocks: state.maxBlocks,
    maxRetainedBytes: state.maxRetainedBytes
  });
  return state;
}
__name(trimTranscriptState, "trimTranscriptState");
function shouldRecreateTrimmedToolBlock(event) {
  return event.toolCallId === DAEMON_PLAN_TOOL_CALL_ID || event.toolKind === "updated_plan";
}
__name(shouldRecreateTrimmedToolBlock, "shouldRecreateTrimmedToolBlock");
var ownedBlocks = /* @__PURE__ */ new WeakMap();
var ownedBlockIndexes = /* @__PURE__ */ new WeakMap();
function takeBlocksOwnership(state) {
  if (ownedBlocks.get(state) === state.blocks) return;
  state.blocks = [...state.blocks];
  ownedBlocks.set(state, state.blocks);
}
__name(takeBlocksOwnership, "takeBlocksOwnership");
function takeBlockIndexOwnership(state) {
  if (ownedBlockIndexes.get(state) === state.blockIndexById) return;
  state.blockIndexById = createIndex(state.blockIndexById);
  ownedBlockIndexes.set(state, state.blockIndexById);
}
__name(takeBlockIndexOwnership, "takeBlockIndexOwnership");
function rewindTranscriptToUserTurn(state, targetTurnIndex) {
  let userTurnIndex = 0;
  let lastUserIndex = -1;
  for (let index = 0; index < state.blocks.length; index += 1) {
    const block = state.blocks[index];
    if (block?.kind !== "user" || block.meta?.["source"] === "background_notification") {
      continue;
    }
    lastUserIndex = index;
    if (userTurnIndex === targetTurnIndex) {
      truncateTranscriptBeforeBlock(state, index);
      return;
    }
    userTurnIndex += 1;
  }
  if (lastUserIndex >= 0 && targetTurnIndex >= userTurnIndex) {
    truncateTranscriptBeforeBlock(state, lastUserIndex);
  }
}
__name(rewindTranscriptToUserTurn, "rewindTranscriptToUserTurn");
function truncateTranscriptBeforeBlock(state, blockIndex) {
  takeBlocksOwnership(state);
  const originalLength = state.blocks.length;
  let droppedBytes = 0;
  for (let index = blockIndex; index < state.blocks.length; index += 1) {
    const block = state.blocks[index];
    if (block) droppedBytes += estimateBlockBytes(block);
  }
  state.blocks = state.blocks.slice(0, blockIndex);
  state.retainedBytes = Math.max(0, state.retainedBytes - droppedBytes);
  ownedBlocks.set(state, state.blocks);
  rebuildTranscriptIndexes(state);
  ownedBlockIndexes.set(state, state.blockIndexById);
  if (state.blocks.length < originalLength) {
    const oldestRetainedBlock = state.blocks.find(
      (block) => (block.sourceRecordIds?.length ?? 0) > 0
    );
    truncationCallbacks.get(state)?.({
      kind: "blocks",
      oldestRetainedRecordId: oldestRetainedBlock?.sourceRecordIds?.[0],
      evictedOldest: false,
      blockCount: state.blocks.length,
      retainedBytes: state.retainedBytes,
      maxBlocks: state.maxBlocks,
      maxRetainedBytes: state.maxRetainedBytes
    });
  }
}
__name(truncateTranscriptBeforeBlock, "truncateTranscriptBeforeBlock");
function rebuildTranscriptIndexes(state) {
  state.blockIndexById = rebuildDaemonTranscriptBlockIndex(state.blocks);
  state.toolBlockByCallId = createIndex();
  state.permissionBlockByRequestId = createIndex();
  state.trimmedToolNotificationByCallId = createIndex();
  state.activeUserBlockId = void 0;
  state.activeAssistantBlockId = void 0;
  state.activeThoughtBlockId = void 0;
  state.activeAssistantBlockByParent = createIndex();
  state.activeThoughtBlockByParent = createIndex();
  state.currentToolCallId = void 0;
  state.pendingUserShellCommand = void 0;
  state.lastFollowupSuggestion = void 0;
  const liveToolCallIds = /* @__PURE__ */ new Set();
  for (const block of state.blocks) {
    if (block.kind === "tool") {
      state.toolBlockByCallId[block.toolCallId] = block.id;
      liveToolCallIds.add(block.toolCallId);
    } else if (block.kind === "permission") {
      state.permissionBlockByRequestId[block.requestId] = block.id;
    }
  }
  for (const toolCallId of Object.keys(state.toolProgress)) {
    if (!liveToolCallIds.has(toolCallId)) {
      delete state.toolProgress[toolCallId];
    }
  }
}
__name(rebuildTranscriptIndexes, "rebuildTranscriptIndexes");
function appendBlock(state, block) {
  takeBlocksOwnership(state);
  takeBlockIndexOwnership(state);
  state.blockIndexById[block.id] = state.blocks.length;
  state.blocks.push(block);
  state.retainedBytes += estimateBlockBytes(block);
}
__name(appendBlock, "appendBlock");
function getWritableBlockById(state, blockId) {
  if (!blockId) return void 0;
  const index = state.blockIndexById[blockId];
  if (index === void 0) return void 0;
  const block = state.blocks[index];
  if (!block || block.id !== blockId) return void 0;
  const cloned = cloneBlockForWrite(block);
  takeBlocksOwnership(state);
  state.blocks[index] = cloned;
  return cloned;
}
__name(getWritableBlockById, "getWritableBlockById");
function cloneBlockForWrite(block) {
  if (block.kind === "permission") {
    return {
      ...block,
      options: block.options.map((option) => cloneJsonLike(option)),
      toolCall: cloneJsonLike(block.toolCall),
      preview: cloneJsonLike(block.preview)
    };
  }
  if (block.kind === "tool") {
    return {
      ...block,
      preview: cloneJsonLike(block.preview),
      resultPreview: cloneJsonLike(block.resultPreview),
      content: cloneJsonLike(block.content),
      locations: cloneJsonLike(block.locations),
      rawInput: cloneJsonLike(block.rawInput),
      rawOutput: cloneJsonLike(block.rawOutput)
    };
  }
  if (block.kind === "user" && block.resourceLinks) {
    return { ...block, resourceLinks: cloneJsonLike(block.resourceLinks) };
  }
  return { ...block };
}
__name(cloneBlockForWrite, "cloneBlockForWrite");
function mergeResourceLink(existing, incoming) {
  if (!existing) return cloneJsonLike(incoming);
  const merged = { ...incoming, ...existing };
  for (const key of [
    "mimeType",
    "size",
    "description",
    "title",
    "annotations",
    "_meta"
  ]) {
    if (existing[key] == null && incoming[key] !== void 0) {
      Object.assign(merged, { [key]: incoming[key] });
    }
  }
  for (const key of ["annotations", "_meta"]) {
    const previous = existing[key];
    const next = incoming[key];
    if (previous && next) {
      Object.assign(merged, {
        [key]: {
          ...next,
          ...Object.fromEntries(
            Object.entries(previous).filter(
              ([field, value]) => value != null || !(field in next)
            )
          )
        }
      });
    }
  }
  return cloneJsonLike(merged);
}
__name(mergeResourceLink, "mergeResourceLink");
function allocateBlockId(state, prefix) {
  const id = `${prefix}-${state.nextOrdinal}`;
  state.nextOrdinal += 1;
  return id;
}
__name(allocateBlockId, "allocateBlockId");
function getPermissionToolIdentity(toolCall) {
  if (!isRecord2(toolCall)) return {};
  const meta = isRecord2(toolCall["_meta"]) ? toolCall["_meta"] : void 0;
  const toolCallId = getFirstString(toolCall, ["toolCallId", "id"]);
  const toolName = getFirstString(meta, ["toolName"]) ?? getFirstString(toolCall, ["toolName", "name"]);
  const toolKind = getFirstString(toolCall, ["kind"]);
  const identity = {};
  if (toolCallId) identity.toolCallId = toolCallId;
  if (toolName) identity.toolName = toolName;
  if (toolKind) identity.toolKind = toolKind;
  return identity;
}
__name(getPermissionToolIdentity, "getPermissionToolIdentity");
function clearActiveText(state, parentToolCallId) {
  if (parentToolCallId) {
    clearActiveAssistantForParent(state, parentToolCallId);
    clearActiveThoughtForParent(state, parentToolCallId);
  } else {
    finishAssistant(state);
    state.activeUserBlockId = void 0;
  }
}
__name(clearActiveText, "clearActiveText");
function appendBoundedText(state, block, text) {
  const existing = "text" in block ? block.text : "";
  let next;
  if (existing.length >= MAX_TEXT_BLOCK_LENGTH) {
    if (text) reportTextTruncation(state, block.id, block.sourceRecordIds);
    next = existing;
  } else {
    next = truncateText(
      state,
      block.id,
      block.sourceRecordIds,
      existing + text
    );
  }
  state.retainedBytes += (next.length - existing.length) * 2;
  return next;
}
__name(appendBoundedText, "appendBoundedText");
function truncateTextAtLimit(text) {
  if (text.length <= MAX_TEXT_BLOCK_LENGTH) return text;
  const keepLength = Math.max(
    0,
    MAX_TEXT_BLOCK_LENGTH - TEXT_TRUNCATED_SUFFIX.length
  );
  return `${detachString(text.slice(0, keepLength))}${TEXT_TRUNCATED_SUFFIX}`;
}
__name(truncateTextAtLimit, "truncateTextAtLimit");
function truncateText(state, blockId, sourceRecordIds, text) {
  if (text.length <= MAX_TEXT_BLOCK_LENGTH) return text;
  reportTextTruncation(state, blockId, sourceRecordIds);
  return truncateTextAtLimit(text);
}
__name(truncateText, "truncateText");
function reportTextTruncation(state, blockId, sourceRecordIds) {
  truncationCallbacks.get(state)?.({
    kind: "text",
    blockId,
    sourceRecordIds
  });
}
__name(reportTextTruncation, "reportTextTruncation");
function estimateRetainedBytes(value, depth = 0) {
  if (depth > MAX_CLONE_DEPTH) return 0;
  if (typeof value === "string") return value.length * 2;
  if (typeof value === "number" || typeof value === "boolean") return 16;
  if (typeof Blob !== "undefined" && value instanceof Blob) return value.size;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) {
    let total = 32;
    for (const entry of value) {
      total += estimateRetainedBytes(entry, depth + 1);
    }
    return total;
  }
  if (isRecord2(value)) {
    let total = 64;
    for (const [key, entry] of Object.entries(value)) {
      total += key.length * 2 + estimateRetainedBytes(entry, depth + 1);
    }
    return total;
  }
  return 0;
}
__name(estimateRetainedBytes, "estimateRetainedBytes");
function estimateDaemonTranscriptBlockBytes(block) {
  return estimateRetainedBytes(block);
}
__name(estimateDaemonTranscriptBlockBytes, "estimateDaemonTranscriptBlockBytes");
var estimateBlockBytes = estimateDaemonTranscriptBlockBytes;
function createIndex(source) {
  return Object.assign(/* @__PURE__ */ Object.create(null), source);
}
__name(createIndex, "createIndex");
function stringArraysEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
__name(stringArraysEqual, "stringArraysEqual");
function unionStrings(left, right) {
  if (!left && !right) return void 0;
  return [.../* @__PURE__ */ new Set([...left ?? [], ...right ?? []])];
}
__name(unionStrings, "unionStrings");
function pruneTrimmedToolIndexes(state) {
  const maxTrimmedEntries = Math.max(0, state.maxBlocks);
  const trimmedToolCallIds = Object.entries(state.toolBlockByCallId).filter(([, blockId]) => blockId === TRIMMED_TOOL_BLOCK_ID).map(([toolCallId]) => toolCallId);
  const overflow = trimmedToolCallIds.length - maxTrimmedEntries;
  if (overflow <= 0) return;
  for (const toolCallId of trimmedToolCallIds.slice(0, overflow)) {
    delete state.toolBlockByCallId[toolCallId];
    delete state.trimmedToolNotificationByCallId[toolCallId];
  }
}
__name(pruneTrimmedToolIndexes, "pruneTrimmedToolIndexes");
function pruneTrimmedPermissionIndexes(state) {
  const maxTrimmedEntries = Math.max(0, state.maxBlocks);
  const trimmedRequestIds = Object.entries(state.permissionBlockByRequestId).filter(([, blockId]) => blockId === TRIMMED_PERMISSION_BLOCK_ID).map(([requestId]) => requestId);
  const overflow = trimmedRequestIds.length - maxTrimmedEntries;
  if (overflow <= 0) return;
  for (const requestId of trimmedRequestIds.slice(0, overflow)) {
    delete state.permissionBlockByRequestId[requestId];
  }
}
__name(pruneTrimmedPermissionIndexes, "pruneTrimmedPermissionIndexes");
function cloneJsonLike(value, depth = 0) {
  if (depth > MAX_CLONE_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonLike(entry, depth + 1));
  }
  if (isRecord2(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        cloneJsonLike(entry, depth + 1)
      ])
    );
  }
  return value;
}
__name(cloneJsonLike, "cloneJsonLike");
var sortedBlocksCache = /* @__PURE__ */ new WeakMap();
function selectTranscriptBlocksOrderedByEventId(state) {
  const cached = sortedBlocksCache.get(state.blocks);
  if (cached) return cached;
  const orderKeyByBlockId = buildEventOrderKeys(state.blocks);
  const sorted = [...state.blocks].sort(
    (a, b) => compareBlocksByEventOrder(a, b, orderKeyByBlockId)
  );
  sortedBlocksCache.set(state.blocks, sorted);
  return sorted;
}
__name(selectTranscriptBlocksOrderedByEventId, "selectTranscriptBlocksOrderedByEventId");
function selectCurrentTool(state) {
  const id = state.currentToolCallId;
  if (!id) return void 0;
  const blockId = state.toolBlockByCallId[id];
  if (!blockId || blockId === TRIMMED_TOOL_BLOCK_ID) return void 0;
  const index = state.blockIndexById[blockId];
  if (index === void 0) return void 0;
  const block = state.blocks[index];
  return block?.kind === "tool" ? block : void 0;
}
__name(selectCurrentTool, "selectCurrentTool");
function selectApprovalMode(state) {
  return state.approvalMode;
}
__name(selectApprovalMode, "selectApprovalMode");
function selectLastFollowupSuggestion(state) {
  return state.lastFollowupSuggestion;
}
__name(selectLastFollowupSuggestion, "selectLastFollowupSuggestion");
function selectUnrecognizedDiagnostics(state) {
  return state.unrecognizedDiagnostics;
}
__name(selectUnrecognizedDiagnostics, "selectUnrecognizedDiagnostics");
function selectToolProgress(state, toolCallId) {
  return state.toolProgress[toolCallId];
}
__name(selectToolProgress, "selectToolProgress");
var childrenIndexCache = /* @__PURE__ */ new WeakMap();
var EMPTY_CHILD_LIST = Object.freeze(
  []
);
function getOrBuildChildrenIndex(blocks) {
  const cached = childrenIndexCache.get(blocks);
  if (cached) return cached;
  const mutable = /* @__PURE__ */ new Map();
  for (const block of blocks) {
    if (block.kind !== "tool" || !block.parentToolCallId) continue;
    const list = mutable.get(block.parentToolCallId);
    if (list) list.push(block);
    else mutable.set(block.parentToolCallId, [block]);
  }
  const frozen = /* @__PURE__ */ new Map();
  for (const [parentId, list] of mutable) {
    frozen.set(parentId, Object.freeze(list));
  }
  childrenIndexCache.set(blocks, frozen);
  return frozen;
}
__name(getOrBuildChildrenIndex, "getOrBuildChildrenIndex");
function selectSubagentChildBlocks(state, parentToolCallId) {
  return getOrBuildChildrenIndex(state.blocks).get(parentToolCallId) ?? EMPTY_CHILD_LIST;
}
__name(selectSubagentChildBlocks, "selectSubagentChildBlocks");
function isSubagentChildBlock(block) {
  return block.kind === "tool" && block.parentToolCallId !== void 0;
}
__name(isSubagentChildBlock, "isSubagentChildBlock");
function compareBlocksByEventOrder(a, b, orderKeyByBlockId) {
  const orderDelta = (orderKeyByBlockId.get(a.id) ?? 0) - (orderKeyByBlockId.get(b.id) ?? 0);
  if (orderDelta !== 0) return orderDelta;
  if (a.serverTimestamp !== void 0 && b.serverTimestamp !== void 0) {
    return a.serverTimestamp - b.serverTimestamp;
  }
  return a.clientReceivedAt - b.clientReceivedAt;
}
__name(compareBlocksByEventOrder, "compareBlocksByEventOrder");
function buildEventOrderKeys(blocks) {
  const orderKeyByBlockId = /* @__PURE__ */ new Map();
  let lastDaemonEventId;
  blocks.forEach((block, index) => {
    if (block.eventId !== void 0) {
      lastDaemonEventId = block.eventId;
      orderKeyByBlockId.set(block.id, block.eventId);
      return;
    }
    const syntheticBase = lastDaemonEventId === void 0 ? Number.MIN_SAFE_INTEGER : lastDaemonEventId + 0.5;
    orderKeyByBlockId.set(block.id, syntheticBase + index / 1e6);
  });
  return orderKeyByBlockId;
}
__name(buildEventOrderKeys, "buildEventOrderKeys");
function formatBlockTimestamp(block, opts = {}) {
  const ts = block.serverTimestamp ?? block.clientReceivedAt;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return "";
  return getTimestampFormatter(opts).format(new Date(ts));
}
__name(formatBlockTimestamp, "formatBlockTimestamp");
function getTimestampFormatter(opts) {
  const key = JSON.stringify([
    opts.locale ?? "",
    opts.timeZone ?? "",
    opts.dateStyle ?? "short",
    opts.timeStyle ?? "medium"
  ]);
  const cached = timestampFormatterCache.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(opts.locale, {
    ...opts.timeZone ? { timeZone: opts.timeZone } : {},
    dateStyle: opts.dateStyle ?? "short",
    timeStyle: opts.timeStyle ?? "medium"
  });
  timestampFormatterCache.set(key, formatter);
  return formatter;
}
__name(getTimestampFormatter, "getTimestampFormatter");

// packages/sdk-typescript/src/daemon/ui/store.ts
init_esbuild_shims();
function createDaemonTranscriptStore(seed = {}) {
  const { onTruncation, ...stateSeed } = seed;
  const reducerOptions = onTruncation ? { onTruncation } : {};
  let state = createState(stateSeed);
  const blockChangeSource = {};
  let blockChangeSummary = {
    source: blockChangeSource,
    revision: 0,
    tailAppendBarrierRevision: 0
  };
  const listeners = /* @__PURE__ */ new Set();
  let notifyScheduled = false;
  const notify = /* @__PURE__ */ __name(() => {
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        reportListenerError(error);
      }
    }
  }, "notify");
  const scheduleNotify = /* @__PURE__ */ __name(() => {
    if (notifyScheduled) return;
    notifyScheduled = true;
    queueMicrotask(() => {
      notifyScheduled = false;
      notify();
    });
  }, "scheduleNotify");
  return {
    getSnapshot() {
      return state;
    },
    getBlockChangeSummary() {
      return blockChangeSummary;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(event) {
      const events = Array.isArray(event) ? event : [event];
      if (events.length === 0) return;
      const previous = state;
      state = reduceDaemonTranscriptEvents(previous, events, reducerOptions);
      blockChangeSummary = nextBlockChangeSummary(
        blockChangeSummary,
        previous,
        state,
        events
      );
      scheduleNotify();
    },
    appendLocalUserMessage(text, images, meta, files) {
      state = appendLocalUserTranscriptMessage(state, text, {
        images,
        meta,
        files,
        ...reducerOptions
      });
      blockChangeSummary = invalidateTailAppend(blockChangeSummary);
      scheduleNotify();
    },
    reset(nextSeed = {}) {
      state = createState({
        maxBlocks: nextSeed.maxBlocks ?? state.maxBlocks,
        maxRetainedBytes: nextSeed.maxRetainedBytes ?? state.maxRetainedBytes,
        retainSubagentBlocks: nextSeed.retainSubagentBlocks ?? state.retainSubagentBlocks,
        ...nextSeed
      });
      blockChangeSummary = invalidateTailAppend(blockChangeSummary);
      scheduleNotify();
    },
    // wenshao R4-R6 (qwen3.7-max): explicit recovery from the
    // `awaitingResync` one-way latch.
    //
    // RECOVERY FLOW (correct order — wenshao R6 caught a flow bug):
    //   1. Daemon emits `session.state_resync_required`; reducer sets
    //      `state.awaitingResync = true` and starts dropping events.
    //   2. Consumer decides on recovery strategy and calls EITHER:
    //        a. `reset()` — clean slate, discard local blocks
    //        b. `clearAwaitingResync()` — keep local blocks, accept
    //           new events. Call BEFORE the new SSE stream starts
    //           delivering events (or BEFORE a `Last-Event-ID: 0`
    //           replay starts), otherwise the replay events get
    //           dropped by the latch guard.
    //   3. Re-subscribe to SSE; events flow normally.
    //
    // (The earlier JSDoc said "after replay drains" — that was wrong.
    // While the latch is set, every replay event is dropped, so the
    // window between latch-clear and stream-start is what receives
    // events. Clear early; if dispatch order misses something the
    // daemon will eventually emit a new `state_resync_required`.)
    clearAwaitingResync() {
      if (!state.awaitingResync) return;
      state = {
        ...state,
        awaitingResync: false
        // Keep lastResyncRequired for diagnostic visibility — consumers
        // who want a clean slate can also call reset().
      };
      scheduleNotify();
    },
    clearFollowupSuggestion() {
      if (state.lastFollowupSuggestion === void 0) return;
      state = { ...state, lastFollowupSuggestion: void 0 };
      scheduleNotify();
    }
  };
}
__name(createDaemonTranscriptStore, "createDaemonTranscriptStore");
function nextBlockChangeSummary(current, previous, next, events) {
  if (previous.blocks === next.blocks) return current;
  const revision = current.revision + 1;
  const tailBlockId = streamingTailAppendBlockId(previous, next, events);
  return tailBlockId ? {
    source: current.source,
    revision,
    tailAppendBarrierRevision: current.tailAppendBarrierRevision,
    tailBlockId
  } : {
    source: current.source,
    revision,
    tailAppendBarrierRevision: revision
  };
}
__name(nextBlockChangeSummary, "nextBlockChangeSummary");
function invalidateTailAppend(current) {
  const revision = current.revision + 1;
  return {
    source: current.source,
    revision,
    tailAppendBarrierRevision: revision
  };
}
__name(invalidateTailAppend, "invalidateTailAppend");
function streamingTailAppendBlockId(previous, next, events) {
  const first = events[0];
  if (!first || first.type !== "assistant.text.delta" && first.type !== "thought.text.delta" || first.parentToolCallId !== void 0 || events.some(
    (event) => event.type !== first.type || "parentToolCallId" in event && event.parentToolCallId !== void 0
  ) || previous.blocks.length === 0 || previous.blocks.length !== next.blocks.length || previous.blockIndexById !== next.blockIndexById) {
    return void 0;
  }
  const blockId = first.type === "assistant.text.delta" ? previous.activeAssistantBlockId : previous.activeThoughtBlockId;
  const nextBlockId = first.type === "assistant.text.delta" ? next.activeAssistantBlockId : next.activeThoughtBlockId;
  const before = previous.blocks[previous.blocks.length - 1];
  const after = next.blocks[next.blocks.length - 1];
  const appendedTextLength = events.reduce(
    (length, event) => length + (event.type === "assistant.text.delta" || event.type === "thought.text.delta" ? event.text.length : 0),
    0
  );
  if (!blockId || nextBlockId !== blockId || before?.id !== blockId || after?.id !== blockId || before.kind !== after.kind || !isTextBlock(before) || !isTextBlock(after) || after.streaming !== true || before.parentToolCallId !== after.parentToolCallId || before.meta !== after.meta || before.usage !== after.usage || before.branchRecordId !== after.branchRecordId || before.clientReceivedAt !== after.clientReceivedAt || before.promptId !== after.promptId || before.sourceRecordIds !== after.sourceRecordIds || after.text.length !== before.text.length + appendedTextLength) {
    return void 0;
  }
  return blockId;
}
__name(streamingTailAppendBlockId, "streamingTailAppendBlockId");
function isTextBlock(block) {
  return block.kind === "assistant" || block.kind === "thought" || block.kind === "user";
}
__name(isTextBlock, "isTextBlock");
function reportListenerError(error) {
  const reporter = globalThis.reportError;
  if (typeof reporter === "function") {
    reporter(error);
    return;
  }
  const logger = globalThis.console?.error;
  if (typeof logger === "function") {
    logger.call(globalThis.console, error);
  }
}
__name(reportListenerError, "reportListenerError");
function createState(seed) {
  const blocks = seed.blocks ? [...seed.blocks] : [];
  return {
    ...createDaemonTranscriptState({
      maxBlocks: seed.maxBlocks,
      maxRetainedBytes: seed.maxRetainedBytes,
      now: seed.now
    }),
    ...seed,
    blocks,
    // Seeded blocks (e.g. a replay snapshot handed to `reset`) must count
    // toward the retention byte budget from the start.
    retainedBytes: seed.retainedBytes ?? blocks.reduce(
      (total, block) => total + estimateDaemonTranscriptBlockBytes(block),
      0
    ),
    blockIndexById: rebuildDaemonTranscriptBlockIndex(blocks),
    toolBlockByCallId: createNullIndex(seed.toolBlockByCallId),
    trimmedToolNotificationByCallId: createNullIndex(
      seed.trimmedToolNotificationByCallId
    ),
    permissionBlockByRequestId: createNullIndex(
      seed.permissionBlockByRequestId
    ),
    toolProgress: createNullIndex(seed.toolProgress),
    activeAssistantBlockByParent: createNullIndex(
      seed.activeAssistantBlockByParent
    ),
    activeThoughtBlockByParent: createNullIndex(
      seed.activeThoughtBlockByParent
    ),
    lastResyncRequired: seed.lastResyncRequired !== void 0 ? { ...seed.lastResyncRequired } : void 0,
    lastFollowupSuggestion: seed.lastFollowupSuggestion !== void 0 ? { ...seed.lastFollowupSuggestion } : void 0
  };
}
__name(createState, "createState");
function createNullIndex(source) {
  return Object.assign(/* @__PURE__ */ Object.create(null), source);
}
__name(createNullIndex, "createNullIndex");

// packages/sdk-typescript/src/daemon/ui/sentinels.ts
init_esbuild_shims();
var DAEMON_GOAL_STATUS_SENTINEL_PREFIX = "web-shell:goal-status:v1:";

// packages/sdk-typescript/src/daemon/ui/terminal.ts
init_esbuild_shims();
function daemonUiEventToTerminalText(event) {
  switch (event.type) {
    case "user.text.delta":
      return terminalLine("qwen", event.text, "38;5;42");
    case "assistant.text.delta":
      return sanitizeTerminalText(event.text).replace(/\r?\n/g, "\r\n");
    case "assistant.done":
      return "";
    case "assistant.usage":
      return "";
    case "thought.text.delta":
      return terminalLine("thought", event.text, "2");
    case "tool.update":
      return terminalLine(
        `tool ${event.status}`,
        `${event.title ?? event.toolName ?? event.toolKind ?? "Tool"}${event.details ? ` ${event.details}` : ""}`,
        "38;5;75"
      );
    case "shell.output":
      return terminalBlock("shell", event.text, "38;5;244");
    case "user.shell.output":
      return terminalBlock("user-shell", event.text, "38;5;244");
    case "permission.request": {
      const options = event.options.map((option) => option.label).join(" / ");
      return terminalLine(
        "permission",
        `${event.title}${options ? ` [${options}]` : ""}`,
        "33"
      );
    }
    case "permission.resolved":
      return terminalLine("permission", event.outcome, "33");
    case "model.changed":
      return terminalLine("model", event.modelId, "36");
    case "status":
    case "debug":
      return terminalLine(event.type, event.text, "2");
    case "error":
      return terminalLine("error", event.text, "31");
    // Session-meta / workspace / auth events: emit a short structured line
    // in terminal mode so they show up in tail-style debug, but do not
    // flood the terminal with full payloads. UI clients with richer
    // surfaces (web / IDE) consume the typed events directly.
    case "session.metadata.changed":
      return terminalLine(
        "session",
        `metadata: ${event.displayName ?? "(no display name)"}`,
        "36"
      );
    case "session.source.changed":
      return "";
    case "session.artifact.changed":
      return terminalLine(
        "artifact",
        `${event.change.action} ${event.change.artifact?.title ?? event.change.artifactId}`,
        "36"
      );
    case "session.approval_mode.changed":
      return terminalLine(
        "approval-mode",
        `${event.previous} \u2192 ${event.next}${event.persisted ? " (persisted)" : ""}`,
        "36"
      );
    case "session.available_commands":
      return terminalLine("commands", `available ${event.count}`, "2");
    case "session.state_resync_required":
      return terminalLine(
        "resync-required",
        `${event.reason}: ${formatMissedRange(event.lastDeliveredId, event.earliestAvailableId)}`,
        "31"
      );
    case "session.replay_complete":
      return terminalLine(
        "replay-complete",
        `caught up (${event.replayedCount} replayed)`,
        "2"
      );
    case "session.rewound":
      return terminalLine(
        "rewound",
        `${event.promptId} \u2192 turn ${event.targetTurnIndex}`,
        "2"
      );
    case "session.branched":
      return terminalLine(
        "branched",
        `${event.sourceSessionId} \u2192 ${event.newSessionId} (${event.displayName})`,
        "2"
      );
    case "prompt.cancelled":
      return terminalLine("cancelled", "prompt cancelled", "33");
    case "followup.suggestion":
      return terminalLine("suggestion", event.suggestion, "2");
    case "workspace.memory.changed":
      return terminalLine(
        "memory",
        event.scope === "managed" ? event.source ?? "managed_memory" : `${event.mode} ${event.scope} ${event.filePath} +${event.bytesWritten}b`,
        "36"
      );
    case "workspace.agent.changed":
      return terminalLine(
        "agent",
        `${event.change} ${event.level}/${event.name}`,
        "36"
      );
    case "workspace.tool.toggled":
      return terminalLine(
        "tool",
        `${event.toolName} ${event.enabled ? "enabled" : "disabled"}`,
        "36"
      );
    case "workspace.settings.changed":
      return terminalLine(
        "settings",
        `${event.key} changed (scope: ${event.scope})`,
        "36"
      );
    case "workspace.trust.change.requested":
      return terminalLine(
        "trust",
        `${event.desiredState} ${event.workspaceCwd}`,
        "33"
      );
    case "workspace.initialized":
      return terminalLine(
        "workspace",
        `init ${event.action} ${event.path}`,
        "36"
      );
    case "workspace.github.setup.completed":
      return terminalLine(
        "github",
        `setup ${event.releaseTag} (${event.workflows.length} workflows)`,
        "36"
      );
    case "workspace.mcp.budget_warning":
      return terminalLine(
        "mcp",
        `${event.mode}: ${event.liveCount}/${event.budget} (${Math.round(
          event.thresholdRatio * 100
        )}% threshold)`,
        "33"
      );
    case "workspace.mcp.child_refused":
      return terminalLine(
        "mcp",
        `refused ${event.refusedServers.length} servers (budget ${event.budget})`,
        "31"
      );
    case "workspace.mcp.server_restarted":
      return terminalLine(
        "mcp",
        `${event.serverName} restarted in ${event.durationMs}ms`,
        "36"
      );
    case "workspace.mcp.server_restart_refused":
      return terminalLine(
        "mcp",
        `${event.serverName} restart refused: ${event.reason}`,
        "33"
      );
    case "workspace.mcp.server_changed":
      return terminalLine("mcp", `${event.serverName} ${event.action}`, "36");
    case "workspace.extensions.changed":
      if (event.status === "failed") {
        return terminalLine(
          "ext",
          `extension action failed${event.name ? ` ${event.name}` : event.source ? ` ${event.source}` : ""}: ${event.error ?? "unknown error"}`,
          "31"
        );
      }
      if (event.status === "installed") {
        return terminalLine(
          "ext",
          `installed ${event.name ?? event.source ?? "extension"}${event.version ? ` v${event.version}` : ""} (${event.refreshed} refreshed, ${event.failed} failed)`,
          "36"
        );
      }
      return terminalLine(
        "ext",
        `extensions refreshed (${event.refreshed} ok, ${event.failed} failed)`,
        "36"
      );
    case "auth.device_flow.started":
      return terminalLine(
        "auth",
        `${event.providerId} device-flow started (${event.deviceFlowId})`,
        "36"
      );
    case "auth.device_flow.throttled":
      return terminalLine(
        "auth",
        `device-flow throttled, retry after ${event.intervalMs}ms`,
        "33"
      );
    case "auth.device_flow.authorized":
      return terminalLine(
        "auth",
        `${event.providerId} authorized${event.accountAlias ? ` as ${event.accountAlias}` : ""}`,
        "32"
      );
    case "auth.device_flow.failed":
      return terminalLine(
        "auth",
        `device-flow failed: ${event.errorKind}${event.hint ? ` (${event.hint})` : ""}`,
        "31"
      );
    case "auth.device_flow.cancelled":
      return terminalLine(
        "auth",
        `device-flow cancelled (${event.deviceFlowId})`,
        "2"
      );
    case "user.shell.command":
      return "";
    case "user.image.delta":
      return `[image: ${sanitizeTerminalText(event.mimeType)}]`;
    case "user.file.delta":
      return `[file: ${sanitizeTerminalText(event.name)}]`;
    case "user.resource_link.delta":
      return `[file: ${sanitizeTerminalText(event.resourceLink.name)}]`;
    default:
      return assertNever(event);
  }
}
__name(daemonUiEventToTerminalText, "daemonUiEventToTerminalText");
function transcriptBlockToTerminalText(block) {
  switch (block.kind) {
    case "user":
      return terminalLine(
        "qwen",
        [
          block.text,
          ...(block.resourceLinks ?? []).map((link) => `[file: ${link.name}]`)
        ].filter(Boolean).join("\n"),
        "38;5;42"
      );
    case "assistant":
      return sanitizeTerminalText(block.text).replace(/\r?\n/g, "\r\n");
    case "thought":
      return terminalLine("thought", block.text, "2");
    case "tool":
      return terminalLine(
        `tool ${block.status}`,
        `${block.title}${block.details ? ` ${block.details}` : ""}`,
        "38;5;75"
      );
    case "shell":
      return terminalBlock("shell", block.text, "38;5;244");
    case "user_shell":
      return terminalBlock(
        `shell command ${block.command}`.trim(),
        block.text,
        "38;5;244"
      );
    case "permission": {
      const options = block.options.map((option) => option.label).join(" / ");
      const suffix = block.resolved ? ` resolved=${block.resolved}` : "";
      return terminalLine(
        "permission",
        `${block.title}${options ? ` [${options}]` : ""}${suffix}`,
        "33"
      );
    }
    case "status":
    case "debug":
      return terminalLine(block.kind, block.text, "2");
    case "error":
      return terminalLine("error", block.text, "31");
    case "prompt_cancelled":
      return terminalLine("cancelled", "prompt cancelled", "33");
    default:
      return assertNever(block);
  }
}
__name(transcriptBlockToTerminalText, "transcriptBlockToTerminalText");
function assertNever(value) {
  const variant = value;
  const name = typeof variant.type === "string" ? variant.type : typeof variant.kind === "string" ? variant.kind : "unknown";
  return terminalLine(
    "error",
    `Unhandled daemon terminal event: ${name}`,
    "31"
  );
}
__name(assertNever, "assertNever");
function terminalLine(label, text, sgr) {
  return `\r
${terminalLabel(label, sgr)}${sanitizeTerminalText(text).replace(/\r?\n/g, "\r\n")}\r
`;
}
__name(terminalLine, "terminalLine");
function terminalBlock(label, text, sgr) {
  if (!text) return "";
  return `\r
${terminalLabel(label, sgr)}${sanitizeTerminalText(text).replace(/\r?\n/g, "\r\n")}\r
`;
}
__name(terminalBlock, "terminalBlock");
function terminalLabel(label, sgr) {
  return `\x1B[${sgr}m${sanitizeTerminalText(label)}>\x1B[0m `;
}
__name(terminalLabel, "terminalLabel");

// packages/sdk-typescript/src/daemon/ui/render.ts
init_esbuild_shims();
var DEFAULT_MAX_FIELD_LENGTH = 8192;
function daemonBlockToMarkdown(block, opts = {}) {
  const cap = capLength(opts);
  const text = /* @__PURE__ */ __name((value) => cap(sanitizeTerminalText(value)), "text");
  switch (block.kind) {
    case "user":
      return `**You**

${text(block.text)}`;
    case "assistant":
      return text(block.text);
    case "thought":
      return blockquote(`*thought:* ${text(block.text)}`);
    case "tool": {
      const header = renderToolHeader(block, opts);
      const previewMd = daemonToolPreviewToMarkdown(block.preview, opts);
      const status = `_status: ${escapeMarkdownText(block.status, opts)}_`;
      const detailsText = block.details ? opts.sanitizeUrls ? sanitizeUrlsInText(block.details) : block.details : void 0;
      const details = detailsText ? `

${text(detailsText)}` : "";
      return `${header}

${previewMd}

${status}${details}`;
    }
    case "shell": {
      const lang = block.stream === "stderr" ? "shellsession-stderr" : "shell";
      return markdownFence(lang, text(block.text));
    }
    case "permission": {
      const optionList = block.options.map(
        (opt) => `- **${escapeMarkdownText(opt.label, opts)}**${opt.description ? ` - ${escapeMarkdownText(opt.description, opts)}` : ""}`
      ).join("\n");
      const resolved = block.resolved ? `

_resolved: ${escapeMarkdownText(block.resolved, opts)}_` : "\n\n_awaiting decision_";
      const previewMd = daemonToolPreviewToMarkdown(block.preview, opts);
      return `### Permission: ${escapeMarkdownText(
        block.title,
        opts
      )}

${previewMd}

${optionList}${resolved}`;
    }
    case "status":
      return `*${text(block.text)}*`;
    case "debug":
      return blockquote(`debug: ${text(block.text)}`);
    case "error":
      return `> [!CAUTION]
${blockquote(text(block.text))}`;
    case "prompt_cancelled":
      return "*Prompt cancelled*";
    default:
      return "";
  }
}
__name(daemonBlockToMarkdown, "daemonBlockToMarkdown");
function renderToolHeader(block, opts = {}) {
  const parts = [`### ${escapeMarkdownText(block.title, opts)}`];
  if (block.toolName) parts.push(inlineCode(block.toolName, opts));
  if (block.toolKind)
    parts.push(`(${escapeMarkdownText(block.toolKind, opts)})`);
  return parts.join(" ");
}
__name(renderToolHeader, "renderToolHeader");
function daemonToolPreviewToMarkdown(preview, opts = {}) {
  const cap = capLength(opts);
  const text = /* @__PURE__ */ __name((value) => cap(sanitizeTerminalText(value)), "text");
  switch (preview.kind) {
    case "ask_user_question":
      return preview.questions.map((q) => renderQuestion(q, opts)).join("\n\n");
    case "command":
      return markdownFence(
        "bash",
        [
          preview.cwd ? `# cwd: ${text(preview.cwd)}` : null,
          text(preview.command)
        ].filter(Boolean).join("\n")
      );
    case "file_diff":
      if (preview.patch) {
        return markdownFence("diff", text(preview.patch));
      }
      if (preview.oldText !== void 0 && preview.newText !== void 0) {
        return [
          `**Edit ${inlineCode(preview.path, opts)}**`,
          "",
          markdownFence(
            "diff",
            [
              ...text(preview.oldText).split("\n").map((line) => `- ${line}`),
              ...text(preview.newText).split("\n").map((line) => `+ ${line}`)
            ].join("\n")
          )
        ].join("\n");
      }
      if (preview.newText !== void 0) {
        return [
          `**Write ${inlineCode(preview.path, opts)}**`,
          "",
          markdownFence("", text(preview.newText))
        ].join("\n");
      }
      return `**Edit ${inlineCode(preview.path, opts)}**`;
    case "file_read":
      if (preview.range) {
        return `Read ${inlineCode(preview.path, opts)} (lines ${preview.range[0]}-${preview.range[1]})`;
      }
      return `Read ${inlineCode(preview.path, opts)}`;
    case "web_fetch": {
      const url = opts.sanitizeUrls ? sanitizeUrl(preview.url) : preview.url;
      return `${escapeMarkdownText(preview.method ?? "GET", opts)} ${inlineCode(
        url,
        opts
      )}`;
    }
    case "mcp_invocation":
      return [
        `**MCP** ${inlineCode(
          `${preview.serverId}::${preview.toolName}`,
          opts
        )}`,
        preview.argsSummary ? `_args:_ ${inlineCode(preview.argsSummary, opts)}` : null
      ].filter(Boolean).join("\n");
    case "code_block":
      return [
        preview.origin ? `_${escapeMarkdownText(preview.origin, opts)}_` : null,
        markdownFence(
          escapeFenceLanguage(preview.language ?? ""),
          text(preview.code)
        )
      ].filter(Boolean).join("\n");
    case "search": {
      const lines = [
        `**Search** ${inlineCode(preview.query, opts)}`,
        preview.resultCount !== void 0 ? `_${preview.resultCount} result${preview.resultCount === 1 ? "" : "s"}_` : null
      ];
      if (preview.top && preview.top.length > 0) {
        for (const result of preview.top) {
          lines.push(`- ${escapeMarkdownText(result, opts)}`);
        }
      }
      return lines.filter(Boolean).join("\n");
    }
    case "tabular": {
      if (preview.columns.length === 0) return "_(empty table)_";
      const headerRow = `| ${preview.columns.map((column) => escapeTableCell(column, opts)).join(" | ")} |`;
      const sepRow = `| ${preview.columns.map(() => "---").join(" | ")} |`;
      const bodyRows = preview.rows.map(
        (row) => `| ${preview.columns.map((_, idx) => escapeTableCell(String(row[idx] ?? ""), opts)).join(" | ")} |`
      );
      const lines = [headerRow, sepRow, ...bodyRows];
      if (preview.totalRows !== void 0 && preview.totalRows > preview.rows.length) {
        lines.push(
          `_\u2026 ${preview.totalRows - preview.rows.length} more row(s) not shown_`
        );
      }
      return lines.join("\n");
    }
    case "image_generation":
      return [
        `**Image generation**`,
        blockquote(text(preview.prompt)),
        preview.model ? `_model: ${escapeMarkdownText(preview.model, opts)}_` : null,
        preview.thumbnailUrl ? (
          // Always protocol-validate image
          // URLs regardless of `sanitizeUrls` opt-in. `javascript:` /
          // `vbscript:` in `<img src>` is never legitimate; the markdown
          // pipeline will convert `![image](javascript:...)` into an
          // attacker-controlled `<img src>` in most renderers.
          // `sanitizeUrls: true` additionally strips query-param
          // tokens + Basic Auth.
          `![image](${opts.sanitizeUrls ? sanitizeUrl(preview.thumbnailUrl) : ensureSafeImageUrl(preview.thumbnailUrl)})`
        ) : null
      ].filter(Boolean).join("\n");
    case "subagent_delegation":
      return [
        `**Delegate -> ${inlineCode(preview.agentName, opts)}**`,
        "",
        blockquote(text(preview.task)),
        preview.parentDelegationId ? `_(chained from ${escapeMarkdownText(
          preview.parentDelegationId,
          opts
        )})_` : null
      ].filter(Boolean).join("\n");
    case "key_value":
      return preview.rows.map(
        (row) => `- **${escapeMarkdownText(row.label, opts)}:** ${escapeMarkdownText(
          row.value,
          opts
        )}`
      ).join("\n");
    case "todo_list":
    case "generic":
      return preview.summary ? `_${escapeMarkdownText(preview.summary, opts)}_` : "";
    default:
      return "";
  }
}
__name(daemonToolPreviewToMarkdown, "daemonToolPreviewToMarkdown");
function blockquote(raw) {
  return raw.split("\n").map((line) => `> ${line}`).join("\n");
}
__name(blockquote, "blockquote");
function markdownFence(language, raw) {
  const maxRun = Math.max(
    2,
    ...Array.from(raw.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(maxRun + 1);
  return [`${fence}${language}`, raw, fence].join("\n");
}
__name(markdownFence, "markdownFence");
function renderQuestion(question, opts) {
  const heading = question.header ? `**${escapeMarkdownText(question.header, opts)}**

` : "";
  const options = question.options.map(
    (opt) => `- ${escapeMarkdownText(opt.label, opts)}${opt.description ? ` - ${escapeMarkdownText(opt.description, opts)}` : ""}`
  ).join("\n");
  return `${heading}${escapeMarkdownText(question.question, opts)}

${options}`;
}
__name(renderQuestion, "renderQuestion");
function daemonBlockToPlainText(block, opts = {}) {
  const cap = capLength(opts);
  const clean = /* @__PURE__ */ __name((raw) => cap(sanitizeTerminalText(raw)), "clean");
  switch (block.kind) {
    case "user":
      return `You: ${clean(block.text)}`;
    case "assistant":
      return clean(block.text);
    case "thought":
      return `(thought: ${clean(block.text)})`;
    case "tool": {
      const header = [
        clean(block.title),
        block.toolName ? `[${clean(block.toolName)}]` : null,
        block.toolKind ? `(${clean(block.toolKind)})` : null
      ].filter(Boolean).join(" ");
      const preview = daemonToolPreviewToPlainText(block.preview, opts);
      const status = `status: ${block.status}`;
      return [header, preview, status].filter(Boolean).join("\n");
    }
    case "shell":
      return `[shell ${block.stream ?? "stdout"}]
${clean(block.text)}`;
    case "permission": {
      const optionList = block.options.map(
        (opt) => `  - ${clean(opt.label)}${opt.description ? `: ${clean(opt.description)}` : ""}`
      ).join("\n");
      const resolved = block.resolved ? `(resolved: ${clean(block.resolved)})` : "(awaiting decision)";
      return `Permission: ${clean(block.title)}
${optionList}
${resolved}`;
    }
    case "status":
      return `[status] ${clean(block.text)}`;
    case "debug":
      return `[debug] ${clean(block.text)}`;
    case "error":
      return `[error] ${clean(block.text)}`;
    case "prompt_cancelled":
      return "[cancelled] prompt cancelled";
    default:
      return "";
  }
}
__name(daemonBlockToPlainText, "daemonBlockToPlainText");
function daemonToolPreviewToPlainText(preview, opts = {}) {
  const url = /* @__PURE__ */ __name((u) => opts.sanitizeUrls ? sanitizeUrl(u) : u, "url");
  const cap = capLength(opts);
  switch (preview.kind) {
    case "ask_user_question":
      return preview.questions.map((q) => `${q.header ? `${cap(q.header)}: ` : ""}${cap(q.question)}`).join("\n");
    case "command":
      return preview.cwd ? `$ ${cap(preview.command)} (cwd: ${cap(preview.cwd)})` : `$ ${cap(preview.command)}`;
    case "file_diff":
      if (preview.patch) return cap(preview.patch);
      if (preview.newText !== void 0)
        return `${cap(preview.path)}: ${cap(preview.newText)}`;
      return cap(preview.path);
    case "file_read":
      return preview.range ? `${cap(preview.path)} (lines ${preview.range[0]}-${preview.range[1]})` : cap(preview.path);
    case "web_fetch":
      return `${preview.method ?? "GET"} ${cap(url(preview.url))}`;
    case "mcp_invocation":
      return `${cap(preview.serverId)}::${cap(preview.toolName)}${preview.argsSummary ? ` (${cap(preview.argsSummary)})` : ""}`;
    case "code_block":
      return preview.origin ? `[${cap(preview.origin)}]
${cap(preview.code)}` : cap(preview.code);
    case "search":
      return [
        `search: ${cap(preview.query)}`,
        preview.resultCount !== void 0 ? `(${preview.resultCount} results)` : null,
        ...(preview.top ?? []).map((r) => `  ${cap(r)}`)
      ].filter(Boolean).join("\n");
    case "tabular": {
      if (preview.columns.length === 0) return "(empty table)";
      const lines = [preview.columns.map((c) => cap(c)).join("	")];
      for (const row of preview.rows) {
        lines.push(
          preview.columns.map((_, idx) => cap(String(row[idx] ?? ""))).join("	")
        );
      }
      if (preview.totalRows !== void 0 && preview.totalRows > preview.rows.length) {
        lines.push(
          `... ${preview.totalRows - preview.rows.length} more row(s)`
        );
      }
      return lines.join("\n");
    }
    case "image_generation": {
      const thumb = preview.thumbnailUrl ? (
        // Image URLs also get protocol validation even when sanitizeUrls
        // is false (XSS defense for img-src contexts).
        ` [${opts.sanitizeUrls ? sanitizeUrl(preview.thumbnailUrl) : ensureSafeImageUrl(preview.thumbnailUrl)}]`
      ) : "";
      return `image: "${cap(preview.prompt)}"${preview.model ? ` (${cap(preview.model)})` : ""}${thumb}`;
    }
    case "subagent_delegation":
      return `delegate to ${cap(preview.agentName)}: ${cap(preview.task)}`;
    case "key_value":
      return preview.rows.map((r) => `${cap(r.label)}: ${cap(r.value)}`).join("\n");
    case "todo_list":
    case "generic":
      return preview.summary ? cap(preview.summary) : "";
    default:
      return "";
  }
}
__name(daemonToolPreviewToPlainText, "daemonToolPreviewToPlainText");
function daemonBlockToHtml(block, opts = {}) {
  const sanitizer = opts.sanitizer ?? defaultEscapeHtml;
  const cap = capLength(opts);
  switch (block.kind) {
    case "user":
      return `<div class="daemon-block daemon-user"><strong>You</strong><p>${sanitizer(cap(block.text))}</p></div>`;
    case "assistant":
      return `<div class="daemon-block daemon-assistant"><p>${sanitizer(cap(block.text))}</p></div>`;
    case "thought":
      return `<div class="daemon-block daemon-thought"><em>${sanitizer(cap(block.text))}</em></div>`;
    case "tool": {
      const previewHtml = sanitizer(
        daemonToolPreviewToPlainText(block.preview, opts)
      );
      const safeTitle = sanitizer(cap(block.title));
      const safeStatus = sanitizer(block.status);
      return `<div class="daemon-block daemon-tool" data-status="${safeStatus}"><div class="title">${safeTitle}</div><pre>${previewHtml}</pre></div>`;
    }
    case "shell":
      return `<pre class="daemon-block daemon-shell" data-stream="${sanitizer(block.stream ?? "stdout")}">${sanitizer(cap(block.text))}</pre>`;
    case "permission": {
      const optionList = block.options.map(
        (opt) => `<li><strong>${sanitizer(cap(opt.label))}</strong>${opt.description ? ` \u2014 ${sanitizer(cap(opt.description))}` : ""}</li>`
      ).join("");
      const resolved = block.resolved ? `<p class="resolved">resolved: ${sanitizer(cap(block.resolved))}</p>` : '<p class="pending">awaiting decision</p>';
      return `<div class="daemon-block daemon-permission"><h4>${sanitizer(cap(block.title))}</h4><ul>${optionList}</ul>${resolved}</div>`;
    }
    case "status":
      return `<div class="daemon-block daemon-status">${sanitizer(cap(block.text))}</div>`;
    case "debug":
      return `<div class="daemon-block daemon-debug">${sanitizer(cap(block.text))}</div>`;
    case "error":
      return `<div class="daemon-block daemon-error" role="alert">${sanitizer(cap(block.text))}</div>`;
    case "prompt_cancelled":
      return '<div class="daemon-block daemon-cancelled">prompt cancelled</div>';
    default:
      return "";
  }
}
__name(daemonBlockToHtml, "daemonBlockToHtml");
function capLength(opts) {
  const max = opts.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH;
  if (!Number.isFinite(max) || max <= 0) return (s) => s;
  return (s) => s.length <= max ? s : `${s.slice(0, max)}\u2026 [truncated]`;
}
__name(capLength, "capLength");
function escapeMarkdownText(raw, opts = {}) {
  const capped = capLength(opts)(sanitizeTerminalText(raw));
  return capped.replace(/([\\`*_{}[\]()#+!><-])/g, "\\$1");
}
__name(escapeMarkdownText, "escapeMarkdownText");
function inlineCode(raw, opts = {}) {
  const value = capLength(opts)(sanitizeTerminalText(raw));
  const maxRun = Math.max(
    0,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length)
  );
  const delimiter = "`".repeat(maxRun + 1);
  const padded = value.startsWith("`") || value.endsWith("`") || value.startsWith(" ") || value.endsWith(" ") ? ` ${value} ` : value;
  return `${delimiter}${padded}${delimiter}`;
}
__name(inlineCode, "inlineCode");
function escapeTableCell(raw, opts = {}) {
  return escapeMarkdownText(raw, opts).replace(/\|/g, "\\|");
}
__name(escapeTableCell, "escapeTableCell");
function escapeFenceLanguage(raw) {
  return sanitizeTerminalText(raw).replace(/[^A-Za-z0-9_+.-]/g, "");
}
__name(escapeFenceLanguage, "escapeFenceLanguage");
function defaultEscapeHtml(raw) {
  const sanitized = sanitizeTerminalText(raw);
  return sanitized.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
__name(defaultEscapeHtml, "defaultEscapeHtml");
function sanitizeUrl(url) {
  try {
    const u = new URL(url);
    const protocol = u.protocol.toLowerCase();
    if (protocol !== "http:" && protocol !== "https:" && protocol !== "mailto:") {
      return "#";
    }
    u.username = "";
    u.password = "";
    const AZURE_SAS_KEYS = /* @__PURE__ */ new Set([
      "sv",
      "se",
      "sr",
      "sp",
      "st",
      "spr",
      "sip",
      "ss",
      "srt",
      "sig",
      "skoid",
      "sktid",
      "skt",
      "ske",
      "sks",
      "skv"
    ]);
    for (const key of Array.from(u.searchParams.keys())) {
      const k = key.toLowerCase();
      if (/^(token|key|auth|signature|sig|access|secret|bearer|credential|session|api[_-]?key|x-amz-|x-goog-|aws|google|expires)/i.test(
        key
      ) || AZURE_SAS_KEYS.has(k)) {
        u.searchParams.delete(key);
      }
    }
    u.hash = "";
    return u.toString();
  } catch {
    return "#";
  }
}
__name(sanitizeUrl, "sanitizeUrl");
function sanitizeUrlsInText(text) {
  return text.replace(/https?:\/\/[^\s"'<>\\]+/gi, (url) => sanitizeUrl(url));
}
__name(sanitizeUrlsInText, "sanitizeUrlsInText");
function ensureSafeImageUrl(url) {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol === "http:" || protocol === "https:") {
      return url;
    }
    if (protocol === "data:") {
      const mediaType = parsed.pathname.split(",")[0]?.split(";")[0]?.toLowerCase() ?? "";
      if (mediaType.startsWith("image/")) {
        return url;
      }
    }
    return "#";
  } catch {
    return "#";
  }
}
__name(ensureSafeImageUrl, "ensureSafeImageUrl");

// packages/sdk-typescript/src/daemon/ui/conformance.ts
init_esbuild_shims();
function runAdapterConformanceSuite(adapter, opts = {}) {
  const fixtures = filterFixtures(DAEMON_UI_CONFORMANCE_FIXTURES, opts);
  const failed = [];
  let passed = 0;
  for (const fx of fixtures) {
    let rendered;
    try {
      const events = fx.envelopes.flatMap(
        (env) => normalizeDaemonEvent(env, fx.normalizeOptions ?? {})
      );
      const state = adapter.reduce(events);
      rendered = adapter.renderToText(state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({
        fixture: fx.name,
        missingPhrases: fx.expectedContains,
        leakedPhrases: [],
        renderedExcerpt: `[adapter threw: ${msg.slice(0, 360)}]`
      });
      continue;
    }
    const missing = fx.expectedContains.filter(
      (phrase) => !rendered.includes(phrase)
    );
    const leaked = (fx.expectedAbsent ?? []).filter(
      (phrase) => rendered.includes(phrase)
    );
    if (missing.length === 0 && leaked.length === 0) {
      passed += 1;
    } else {
      failed.push({
        fixture: fx.name,
        missingPhrases: missing,
        leakedPhrases: leaked,
        renderedExcerpt: rendered.length > 400 ? `${rendered.slice(0, 400)}\u2026` : rendered
      });
    }
  }
  return { passed, failed, total: fixtures.length };
}
__name(runAdapterConformanceSuite, "runAdapterConformanceSuite");
function filterFixtures(fixtures, opts) {
  let out = fixtures;
  if (opts.only && opts.only.length > 0) {
    const set = new Set(opts.only);
    out = out.filter((fx) => set.has(fx.name));
  }
  if (opts.skip && opts.skip.length > 0) {
    const set = new Set(opts.skip);
    out = out.filter((fx) => !set.has(fx.name));
  }
  return out;
}
__name(filterFixtures, "filterFixtures");
var DAEMON_UI_CONFORMANCE_FIXTURES = [
  {
    name: "simple-chat",
    description: "User says hello, assistant streams a two-chunk response, marks done.",
    envelopes: [
      {
        id: 1,
        v: 1,
        type: "session_update",
        data: {
          update: {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "hello world" }
          }
        }
      },
      {
        id: 2,
        v: 1,
        type: "session_update",
        data: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hi " }
          }
        }
      },
      {
        id: 3,
        v: 1,
        type: "session_update",
        data: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "there" }
          }
        }
      }
    ],
    expectedContains: ["hello world", "hi there"]
  },
  {
    name: "tool-call-lifecycle",
    description: "Tool runs, completes; preview surfaces command, status shows completed.",
    envelopes: [
      {
        id: 1,
        v: 1,
        type: "session_update",
        data: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            title: "Run npm test",
            status: "running",
            rawInput: { command: "npm test", cwd: "/work" }
          }
        }
      },
      {
        id: 2,
        v: 1,
        type: "session_update",
        data: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            status: "completed",
            rawOutput: "all tests pass"
          }
        }
      }
    ],
    expectedContains: ["Run npm test", "npm test", "completed"]
  },
  {
    name: "file-edit-diff",
    description: "File edit tool produces file_diff preview surfaceable as unified diff.",
    envelopes: [
      {
        id: 1,
        v: 1,
        type: "session_update",
        data: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "edit-1",
            title: "Edit auth.ts",
            status: "completed",
            rawInput: {
              path: "/work/auth.ts",
              oldText: "function login() { /* TODO */ }",
              newText: "function login() { return token; }"
            }
          }
        }
      }
    ],
    expectedContains: ["/work/auth.ts", "return token"]
  },
  {
    name: "mcp-invocation",
    description: "MCP tool call surfaces serverId + toolName via heuristic naming.",
    envelopes: [
      {
        id: 1,
        v: 1,
        type: "session_update",
        data: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "mcp-1",
            title: "Create issue",
            status: "completed",
            name: "mcp__github__create_issue",
            rawInput: { repo: "qwen-code", title: "Bug" }
          }
        }
      }
    ],
    expectedContains: ["github", "create_issue"]
  },
  {
    name: "permission-lifecycle",
    description: "Permission requested, then resolved with `selected:allow` outcome.",
    envelopes: [
      {
        id: 1,
        v: 1,
        type: "permission_request",
        data: {
          requestId: "perm-1",
          sessionId: "sess-1",
          toolCall: { name: "Bash", command: "rm -rf /tmp/cache" },
          options: [
            { optionId: "allow", label: "Allow once" },
            { optionId: "deny", label: "Deny" }
          ]
        }
      },
      {
        id: 2,
        v: 1,
        type: "permission_resolved",
        data: {
          requestId: "perm-1",
          outcome: { outcome: "selected", optionId: "allow" }
        }
      }
    ],
    expectedContains: ["Allow once", "selected:allow"]
  },
  {
    name: "mcp-budget-warning",
    description: "MCP budget warning event surfaces threshold + counts (PR-A coverage).",
    envelopes: [
      {
        id: 1,
        v: 1,
        type: "mcp_budget_warning",
        data: {
          liveCount: 6,
          reservedCount: 2,
          budget: 8,
          thresholdRatio: 0.75,
          mode: "warn"
        }
      }
    ],
    // No expectedContains — depending on adapter, this event may surface
    // as a status banner or be hidden. The contract is: the adapter MUST
    // observe the event (lastEventId advances) but can choose its
    // rendering. Fixture exists to verify the adapter does not throw.
    expectedContains: []
  },
  {
    name: "cancellation-propagates",
    description: "Cancelled assistant turn marks in-flight tool blocks as cancelled.",
    envelopes: [
      {
        id: 1,
        v: 1,
        type: "session_update",
        data: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "long-task",
            title: "Long task",
            status: "running"
          }
        }
      }
    ],
    // Stream the assistant.done(cancelled) via a synthetic envelope:
    // since this is a derived UI event not a daemon event, the conformance
    // suite uses an out-of-band marker — adapters must propagate from
    // any 'assistant.done' event with reason=cancelled. (Fixture limited
    // by daemon envelope shape; see real integration tests for full
    // cancellation flow.)
    expectedContains: ["Long task"]
  },
  {
    name: "malformed-payload-redaction",
    description: "Known event type with malformed payload falls back to debug. Even with `includeRawEvent: true` a conforming adapter must not dump the raw payload into rendered text. Uses a non-sensitive field name so SDK normalizer redaction (which auto-cleans `token`/`secret`/`apiKey`/etc.) does NOT pre-empt the test \u2014 the conformance framework itself catches the leak.",
    envelopes: [
      {
        id: 1,
        v: 1,
        type: "mcp_budget_warning",
        data: { notes: "must-not-leak-malformed-payload", random: "junk" }
      }
    ],
    normalizeOptions: { includeRawEvent: true },
    expectedContains: [],
    expectedAbsent: ["must-not-leak-malformed-payload"]
  },
  {
    name: "auth-device-flow-success",
    description: "OAuth device-flow lifecycle (started \u2192 authorized) renders provider + status.",
    envelopes: [
      {
        id: 1,
        v: 1,
        type: "auth_device_flow_started",
        data: {
          deviceFlowId: "df-1",
          providerId: "qwen",
          expiresAt: 19e11
        }
      },
      {
        id: 2,
        v: 1,
        type: "auth_device_flow_authorized",
        data: {
          deviceFlowId: "df-1",
          providerId: "qwen",
          accountAlias: "alice"
        }
      }
    ],
    expectedContains: []
  },
  {
    name: "available-commands-typed-event",
    description: "available_commands_update upgraded from status text to typed event (PR-A); not a status block.",
    envelopes: [
      {
        id: 1,
        v: 1,
        type: "session_update",
        data: {
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "memory" },
              { name: "mcp" },
              { name: "agents" }
            ]
          }
        }
      }
    ],
    expectedContains: [],
    expectedAbsent: ["Available commands updated"]
  },
  {
    name: "subagent-nesting",
    description: "PR-K: tool calls invoked inside a sub-agent delegation carry parentToolCallId + subagentType via tool_call._meta. The parent Task tool call lands first, then a grep tool call from inside the sub-agent. Adapters must render both blocks without throwing; nested-aware adapters should be able to identify the sub-agent child via parentToolCallId. Order-resilient: the child arrives after the parent.",
    envelopes: [
      {
        id: 1,
        v: 1,
        type: "session_update",
        data: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "task-1",
            title: "Delegate to code-reviewer",
            status: "running",
            name: "Task",
            rawInput: {
              subagent_type: "code-reviewer",
              prompt: "review the diff"
            }
          }
        }
      },
      {
        id: 2,
        v: 1,
        type: "session_update",
        data: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "grep-1",
            title: "grep -r TODO src/",
            status: "completed",
            rawInput: { pattern: "TODO", path: "src/" },
            _meta: {
              parentToolCallId: "task-1",
              subagentType: "code-reviewer"
            }
          }
        }
      }
    ],
    // Phrases chosen to be markdown-safe: backslash escaping of `-` in
    // titles means we cannot rely on substrings containing hyphens.
    // Sub-agent type token appears in backticks (unescaped). `TODO` is
    // a clean substring from the child's rawInput.
    expectedContains: ["code-reviewer", "review the diff", "TODO"]
  }
];

export {
  DaemonHttpError,
  isSubagentSessionNotFound,
  isSessionLevelNotFound,
  DEVICE_FLOW_EXPIRY_GRACE_MS,
  DaemonAuthFlow,
  DaemonTransportClosedError,
  SseFramingError,
  parseSseStream,
  GOAL_PAUSE_REASON_COMMAND,
  GOAL_CHECKPOINT_STALL_LIMIT,
  DaemonCapabilityMissingError,
  requireWorkspaceCwd,
  parseDaemonBackgroundTurn,
  DAEMON_ERROR_KINDS,
  isDaemonContentHash,
  DAEMON_APPROVAL_MODES,
  STANDALONE_SESSIONS_CAPABILITY,
  STANDALONE_SESSION_OPTIONS_CAPABILITY,
  DaemonStandaloneProtocolError,
  DaemonStandaloneCreationOutcomeUnknownError,
  isStandaloneSessionNotFoundError,
  isStandaloneCreationOutcomeUnknown,
  DaemonPendingPromptLimitError,
  DaemonSessionIdProtocolError,
  EXTENSION_ARCHIVE_UPLOAD_TIMEOUT_MS,
  isDaemonTurnError,
  isStaleBranchPointError,
  DaemonClient,
  WorkspaceDaemonClient,
  matchTurnEvent,
  isNonBlockingAccepted,
  WEB_SHELL_PWA_ASSETS,
  WEB_SHELL_SERVICE_WORKER_ROUTE,
  DaemonSessionClient,
  MID_TURN_MESSAGE_INJECTED_EVENT,
  PENDING_PROMPT_ADDED_EVENT,
  PENDING_PROMPT_STARTED_EVENT,
  PENDING_PROMPT_COMPLETED_EVENT,
  DAEMON_KNOWN_EVENT_TYPE_VALUES,
  createDaemonSessionViewState,
  isKnownDaemonEvent,
  isDaemonEventType,
  isWorkspaceScopedBudgetEvent,
  asKnownDaemonEvent,
  reduceDaemonSessionEvent,
  reduceDaemonSessionEvents,
  createDaemonAuthState,
  reduceDaemonAuthEvent,
  reduceDaemonAuthEvents,
  DAEMON_PLAN_TOOL_CALL_ID,
  DAEMON_UI_DEBUG_REASONS,
  DAEMON_UI_UNRECOGNIZED_DIAGNOSTIC_REASONS,
  isUnrecognizedDiagnosticReason,
  stringifyJson,
  redactSensitiveFields,
  isSensitiveKey,
  extractContentPart,
  getOutputText,
  sanitizeTerminalText,
  stripOscSequences,
  createDaemonToolPreview,
  createDaemonToolResultPreview,
  normalizeDaemonEvent,
  extractServerTimestamp,
  getSessionUpdatePayload,
  UNRECOGNIZED_DIAGNOSTICS_LIMIT,
  isTrimmedToolBlockId,
  isTrimmedPermissionBlockId,
  createDaemonTranscriptState,
  appendLocalUserTranscriptMessage,
  reduceDaemonTranscriptEvents,
  finalizeOfflineDaemonTranscriptState,
  rebuildDaemonTranscriptBlockIndex,
  selectTranscriptBlocks,
  selectPendingPermissionBlocks,
  isTaskExecutionMode,
  estimateDaemonTranscriptBlockBytes,
  selectTranscriptBlocksOrderedByEventId,
  selectCurrentTool,
  selectApprovalMode,
  selectLastFollowupSuggestion,
  selectUnrecognizedDiagnostics,
  selectToolProgress,
  selectSubagentChildBlocks,
  isSubagentChildBlock,
  formatBlockTimestamp,
  createDaemonTranscriptStore,
  DAEMON_GOAL_STATUS_SENTINEL_PREFIX,
  daemonUiEventToTerminalText,
  transcriptBlockToTerminalText,
  daemonBlockToMarkdown,
  daemonToolPreviewToMarkdown,
  daemonBlockToPlainText,
  daemonBlockToHtml,
  runAdapterConformanceSuite,
  DAEMON_UI_CONFORMANCE_FIXTURES
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Alibaba Group Holding Limited. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0
 */
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
